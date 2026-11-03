import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {printerHandoffConfigSchema, printerSelectionSchema, type PrinterBackend, type PrinterHandoffConfig, type PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import {parseToml} from './toml.js';
import {readProfiles, settingsGap} from '../printing/profiles.js';
import {modelFromSerial} from '../printing/discovery.js';

/** Configured destinations, not claims about live printer connectivity. */
export interface PrinterDestination {
  id: string;
  name: string;
  backend: PrinterBackend;
  model?: string;
  address?: string;
  source: 'current' | 'mcp-profile';
  /** The client config it came from. */
  origin?: PrinterOrigin;
  /** The same printer reached through both MCPs: the profile for each (the listed one first). Settings' Printer MCP picker. */
  mcps?: {backend: PrinterBackend; destinationId: string}[];
  /** A printer added in Counterpart: the folder its MCP runs in, whose `.env` holds its settings. */
  folder?: string;
  /** A printer added in Counterpart whose `.env` lacks settings its MCP needs (names only), and what Complete Settings would add. */
  incomplete?: {missing: string[]; fill: Record<string, string>};
}

export type PrinterOrigin = 'printer-handoff' | 'counterpart' | 'claude-code' | 'claude-desktop' | 'cursor' | 'codemode' | 'codex';

export interface PrinterCatalog {
  defaultDestinationId: string;
  destinations: PrinterDestination[];
  /** Only companion code receives process settings; callers get a defensive copy. Duplicates still resolve. */
  resolve(id: string): PrinterHandoffConfig | undefined;
  /**
   * The listed destination that an id now stands for: itself, or the
   * destination that won over it for the same printer. Undefined for an unknown id.
   */
  canonical(id: string): string | undefined;
  /** Every profile found, listed or merged into another for the same printer (installs, Settings). */
  entries(): {id: string; backend: PrinterBackend; config: PrinterHandoffConfig}[];
  /** The key a per-printer MCP choice is stored under (`serial:…`, else a host key). */
  choiceKey(id: string): string | undefined;
  /** Reads every source again, in place: everything holding this catalog sees the new list. */
  reload(): Promise<void>;
}

export interface PrinterCatalogOptions {
  homeDirectory?: string;
  /** Explicit JSON client/Codemode files; replaces defaults when supplied. */
  sourcePaths?: string[];
  /** Metadata source only. Does not add or override the MCP process environment. */
  currentEnvPath?: string;
  /** Counterpart's own list (`<appPrinters>/profiles.json`): printers added in the app, and per-printer MCP choices. */
  profilesPath?: string;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function expand(path: string, home: string, relativeTo: string): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : resolve(relativeTo, path);
}
async function readText(path: string): Promise<string | undefined> {
  try {
    const value = await readFile(path, 'utf8');
    return Buffer.byteLength(value) <= 4 * 1024 * 1024 ? value : undefined;
  } catch { return undefined; }
}
async function environment(path?: string): Promise<Record<string, string>> {
  if (!path) return {};
  const value = await readText(path);
  try {
    return value === undefined ? {} : Object.fromEntries(Object.entries(parseEnv(value)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  } catch { return {}; }
}

function defaultSources(home: string): string[] {
  return [
    '.claude.json', 'Library/Application Support/Claude/claude_desktop_config.json', '.cursor/mcp.json',
    '.codex/mcp/codemode-servers.json', '.claude-desktop/mcp/codemode-servers.json',
    // This installed Codemode wrapper reads configDirectories from this file.
    '.config/codemode-mcp/codemode-mcp-temp/codemode-config.json',
    // Codex: [mcp_servers.<name>] tables with command, args, env and cwd.
    '.codex/config.toml',
  ].map(path => join(home, path));
}

function originOf(path: string): PrinterOrigin {
  const name = basename(path);
  if (name === 'config.toml' || name.endsWith('.toml')) return 'codex';
  if (name === 'claude_desktop_config.json') return 'claude-desktop';
  if (name === '.claude.json' || name === 'claude.json') return 'claude-code';
  if (path.includes('/.cursor/')) return 'cursor';
  return 'codemode';
}

/** Identify the actual supported package entry point, never just a profile's name. */
function backendFor(command: string, args: string[]): PrinterBackend | undefined {
  const packageName = (value: string): PrinterBackend | undefined => {
    const match = /^(bambu-printer-mcp|mcp-3d-printer-server)(?:@[^\s/]+)?$/i.exec(value);
    return match?.[1]?.toLowerCase() as PrinterBackend | undefined;
  };
  const executable = basename(command);
  const direct = packageName(executable);
  if (direct) return direct;
  if (executable === 'node' || executable === 'nodejs') {
    // Codex runs npx through node: node …/npm/bin/npx-cli.js -y <package>.
    if (/(?:^|\/)npx-cli\.js$/.test(args[0] ?? '')) return backendFor('npx', args.slice(1));
    const match = /(?:^|\/)(bambu-printer-mcp|mcp-3d-printer-server)\/dist\/index\.js$/i.exec(args[0] ?? '');
    return match?.[1]?.toLowerCase() as PrinterBackend | undefined;
  }
  if (executable === 'npx') {
    const index = args.findIndex(arg => !['-y', '--yes', '--no-install'].includes(arg));
    if (index >= 0) return packageName(args[index]!);
  }
  return undefined;
}

async function absoluteCommand(command: string, env?: Record<string, string>): Promise<string | undefined> {
  if (isAbsolute(command)) return command;
  if (command === 'node' || command === 'nodejs') return process.execPath;
  if (command.includes('/') || !['npx', 'bambu-printer-mcp', 'mcp-3d-printer-server'].includes(command)) return undefined;
  for (const directory of (env?.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, command);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next configured PATH entry */ }
  }
  return undefined;
}

function publicAddress(value?: string): string | undefined {
  if (!value || /[\s\u0000-\u001f]/.test(value)) return undefined;
  if (value.includes('://')) {
    try { return new URL(value).host || undefined; } catch { return undefined; }
  }
  return /^[A-Za-z0-9._:[\]-]+$/.test(value) ? value : undefined;
}

async function metadata(config: PrinterHandoffConfig, envPath?: string) {
  const env = {...await environment(envPath ?? (config.process.cwd ? join(config.process.cwd, '.env') : undefined)), ...config.process.env};
  const bambu = config.backend === 'bambu-printer-mcp';
  const host = config.selection?.host ?? (bambu ? text(env.BAMBU_PRINTER_HOST) : undefined) ?? text(env.PRINTER_HOST);
  const serial = (bambu ? text(env.BAMBU_PRINTER_SERIAL) : undefined) ?? text(env.BAMBU_SERIAL);
  const model = config.selection?.model ?? (bambu ? text(env.BAMBU_PRINTER_MODEL) : undefined) ?? text(env.BAMBU_MODEL);
  const address = publicAddress(host);
  // The configured selection outranks the MCP's environment.
  const printerType = printerSelectionSchema.shape.printerType.safeParse(bambu ? 'bambu' : config.selection?.printerType ?? text(env.PRINTER_TYPE)?.toLowerCase());
  const bambuKind = bambu || serial !== undefined || (printerType.success && printerType.data === 'bambu');
  // One printer, one destination (PRD §8.2): the Bambu serial when known, else
  // the lowercased host:port. A Bambu printer's address is its host (its ports are fixed);
  // different generic API ports can represent distinct printers on one host.
  const port = config.selection?.port ?? text(env.PRINTER_PORT) ?? '';
  const hostKey = address?.toLowerCase();
  const keys = [
    ...(serial ? [`serial:${serial.toUpperCase()}`] : []),
    ...(hostKey ? [bambuKind ? `bambu-host:${hostKey.replace(/:\d+$/, '')}` : `host:${port && !/:\d+$/.test(hostKey) ? `${hostKey}:${port}` : hostKey}`] : []),
  ];
  return {address, model: model && /^[a-zA-Z0-9 _.-]{1,64}$/.test(model) ? model.toLowerCase() : undefined,
    printerType: printerType.success ? printerType.data : undefined, keys, bambuKind, ...(serial ? {serial: serial.toUpperCase()} : {})};
}

function defaultName(backend: PrinterBackend, model?: string): string {
  if (model) return `${backend === 'bambu-printer-mcp' ? 'Bambu Lab ' : ''}${model.toUpperCase()}`;
  return backend === 'bambu-printer-mcp' ? 'Bambu printer' : 'Configured printer';
}

function profileEntries(document: RecordValue, scope: string[] = []): {key: string; name: string; value: unknown}[] {
  const entries: {key: string; name: string; value: unknown}[] = [];
  for (const key of ['mcpServers', 'mcp_servers', 'servers']) {
    const map = record(document[key]);
    if (map) for (const [name, value] of Object.entries(map)) entries.push({key: JSON.stringify([...scope, key, name]), name, value});
    if (Array.isArray(document[key])) {
      for (const item of document[key]) {
        const value = record(item), name = text(value?.name);
        if (name) entries.push({key: JSON.stringify([...scope, key, name]), name, value});
      }
    }
  }
  const projects = record(document.projects);
  if (projects) for (const [name, project] of Object.entries(projects)) {
    const value = record(project);
    if (value) entries.push(...profileEntries({...value, projects: undefined}, [...scope, 'projects', name]));
  }
  return entries;
}

interface Candidate {
  id: string;
  name: string;
  backend: PrinterBackend;
  model?: string;
  address?: string;
  source: PrinterDestination['source'];
  origin?: PrinterOrigin;
  keys: string[];
  bambuKind: boolean;
  serial?: string;
  config: PrinterHandoffConfig;
  folder?: string;
  incomplete?: {missing: string[]; fill: Record<string, string>};
}

async function readDocument(path: string): Promise<RecordValue | undefined> {
  const contents = await readText(path);
  if (contents === undefined) return undefined;
  try { return record(path.endsWith('.toml') ? parseToml(contents) : JSON.parse(contents)); } catch { return undefined; }
}

/**
 * Picks the destination for each printer (PRD §8.2 routing rule): a Bambu
 * printer uses bambu-printer-mcp, and mcp-3D-printer-server only when no
 * bambu-printer-mcp profile reaches it; every other printer uses
 * mcp-3D-printer-server. Within one MCP, the Mac app's own config wins, then
 * the first source found.
 */
function winners(candidates: Candidate[], choices: Record<string, PrinterBackend> = {}): {chosen: Map<Candidate, Candidate>; groups: Candidate[][]} {
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  // A known serial identifies the printer: a shared address never merges two different serials
  // (an old profile can keep an IP that DHCP has since given to another printer).
  const serials = candidates.map(candidate => candidate.serial);
  const owner = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    for (const key of candidate.keys) {
      const other = owner.get(key);
      if (other === undefined) { owner.set(key, index); continue; }
      const a = find(index), b = find(other);
      if (a === b || (serials[a] && serials[b] && serials[a] !== serials[b])) continue;
      parent[a] = b;
      serials[b] ??= serials[a];
    }
  });
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, index) => { const root = find(index); groups.set(root, [...(groups.get(root) ?? []), candidate]); });
  const result = new Map<Candidate, Candidate>();
  for (const group of groups.values()) {
    const bambu = group.some(candidate => candidate.bambuKind) && group.some(candidate => candidate.backend === 'bambu-printer-mcp');
    // The person's own choice for this printer (Settings → Printers → Printer MCP) outranks the rule.
    const keys = new Set(group.flatMap(candidate => candidate.keys));
    const choice = [...keys].map(key => choices[key]).find(backend => backend && group.some(candidate => candidate.backend === backend));
    const eligible = group.filter(candidate => candidate.backend === (choice ?? (bambu ? 'bambu-printer-mcp' : 'mcp-3d-printer-server')));
    const pool = eligible.length ? eligible : group;
    const winner = pool.find(candidate => candidate.source === 'current') ?? pool[0]!;
    for (const candidate of group) result.set(candidate, winner);
  }
  return {chosen: result, groups: [...groups.values()]};
}

/** Reads configured profiles only. Does not start MCP processes or contact printers. */
export async function loadPrinterCatalog(current: PrinterHandoffConfig, options: PrinterCatalogOptions = {}): Promise<PrinterCatalog> {
  let state = await buildCatalog(current, options);
  const catalog: PrinterCatalog = {defaultDestinationId: state.defaultDestinationId, destinations: state.destinations,
    resolve(id) { const config = state.configs.get(id); return config ? structuredClone(config) : undefined; },
    canonical(id) { return state.canonical.get(id); },
    entries() { return state.candidates.map(candidate => ({id: candidate.id, backend: candidate.backend, config: structuredClone(candidate.config)})); },
    choiceKey(id) { return state.choiceKeys.get(id); },
    async reload() {
      state = await buildCatalog(current, options);
      catalog.defaultDestinationId = state.defaultDestinationId;
      catalog.destinations = state.destinations;
    }};
  return catalog;
}

async function buildCatalog(current: PrinterHandoffConfig, options: PrinterCatalogOptions) {
  const home = options.homeDirectory ?? homedir();
  const currentConfig = printerHandoffConfigSchema.parse(structuredClone(current));
  const currentMetadata = await metadata(currentConfig, options.currentEnvPath);
  const candidates: Candidate[] = [{id: 'current', name: defaultName(currentConfig.backend, currentMetadata.model), backend: currentConfig.backend,
    ...(currentMetadata.model ? {model: currentMetadata.model} : {}), ...(currentMetadata.address ? {address: currentMetadata.address} : {}),
    source: 'current', origin: 'printer-handoff', keys: currentMetadata.keys, bambuKind: currentMetadata.bambuKind,
    ...(currentMetadata.serial ? {serial: currentMetadata.serial} : {}), config: currentConfig}];
  const saved = options.profilesPath ? await readProfiles(options.profilesPath) : undefined;
  const seenProfiles = new Set<string>();
  // Printers added in Counterpart come right after the Mac app's own config: within one MCP they win over client configs.
  for (const profile of saved?.profiles ?? []) {
    const parsed = printerHandoffConfigSchema.safeParse({backend: profile.backend, process: profile.process});
    if (!parsed.success) continue;
    const config = parsed.data;
    const meta = await metadata(config);
    if (!meta.address) continue;
    // The model Counterpart recorded, else the MCP's own: tool calls need it (bambu_model) before the MCP's defaults apply.
    const model = profile.model ?? meta.model;
    if (model || meta.printerType) config.selection = {...(model ? {model} : {}), ...(meta.printerType ? {printerType: meta.printerType} : {})};
    const gap = settingsGap(profile.backend, await environment(join(profile.process.cwd, '.env')), {...(profile.model ? {model: profile.model} : {}), modelFromSerial});
    seenProfiles.add(JSON.stringify([profile.backend, profile.process]));
    candidates.push({id: profile.id, name: profile.name, backend: profile.backend, address: meta.address, ...(model ? {model} : {}),
      source: 'mcp-profile', origin: 'counterpart', keys: meta.keys, bambuKind: meta.bambuKind, ...(meta.serial ? {serial: meta.serial} : {}),
      config, folder: profile.process.cwd, ...(gap.missing.length ? {incomplete: gap} : {})});
  }
  const queue = (options.sourcePaths ?? defaultSources(home)).map(path => ({path: expand(path, home, home), origin: undefined as PrinterOrigin | undefined}));
  const visited = new Set<string>();
  while (queue.length && visited.size < 128) {
    const {path, origin: inherited} = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const document = await readDocument(path);
    if (!document) continue;
    const origin = inherited ?? originOf(path);
    if (Array.isArray(document.configDirectories)) for (const directory of document.configDirectories) {
      if (typeof directory === 'string') queue.push({path: join(expand(directory, home, dirname(path)), '.mcp.json'), origin: 'codemode'});
    }
    for (const {key, name, value: raw} of profileEntries(document)) {
      const profile = record(raw);
      if (!profile || profile.disabled === true || profile.enabled === false) continue;
      if (profile.type !== undefined && profile.type !== 'stdio') continue;
      const command = text(profile.command);
      if (!command) continue;
      const args = profile.args ?? [];
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) continue;
      const env = record(profile.env);
      if (profile.env !== undefined && (!env || !Object.values(env).every(value => typeof value === 'string'))) continue;
      // The client's existing Codemode source is a reference, not a copied config.
      const codemodePath = text(env?.CODEMODE_SERVERS);
      if (codemodePath && isAbsolute(codemodePath)) queue.push({path: codemodePath, origin: 'codemode'});
      const backend = backendFor(command, args);
      if (!backend) continue;
      if (profile.cwd !== undefined && (typeof profile.cwd !== 'string' || !isAbsolute(profile.cwd))) continue;
      const absolute = await absoluteCommand(command, env as Record<string, string> | undefined);
      if (!absolute) continue;
      const processConfig: PrinterMcpProcess = {command: absolute, ...(profile.args !== undefined ? {args} : {}),
        ...(typeof profile.cwd === 'string' ? {cwd: profile.cwd} : {}), ...(env ? {env: env as Record<string, string>} : {})};
      const parsed = printerHandoffConfigSchema.safeParse({backend, process: processConfig});
      if (!parsed.success) continue;
      const config = parsed.data;
      const meta = await metadata(config);
      // A package installation without a configured target is not another printer.
      if (!meta.address) continue;
      // The same profile reached through two sources (a copied file) is listed once.
      const sameProfile = JSON.stringify([backend, processConfig]);
      if (seenProfiles.has(sameProfile)) continue;
      seenProfiles.add(sameProfile);
      // Tool schemas require these explicit arguments before the MCP can apply its own env defaults.
      // Carry only the existing profile's model/type; retain its complete process configuration unchanged.
      if (meta.model || meta.printerType) config.selection = {
        ...(meta.model ? {model: meta.model} : {}), ...(meta.printerType ? {printerType: meta.printerType} : {}),
      };
      const id = `mcp-${createHash('sha256').update(`${path}\0${key}`).digest('hex').slice(0, 24)}`;
      const label = name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      candidates.push({id, name: label || defaultName(backend, meta.model), backend, address: meta.address,
        ...(meta.model ? {model: meta.model} : {}), source: 'mcp-profile', origin, keys: meta.keys, bambuKind: meta.bambuKind,
        ...(meta.serial ? {serial: meta.serial} : {}), config});
    }
  }
  const {chosen, groups} = winners(candidates, saved?.choices);
  const configs = new Map(candidates.map(candidate => [candidate.id, candidate.config] as const));
  const canonical = new Map(candidates.map(candidate => [candidate.id, chosen.get(candidate)!.id] as const));
  const choiceKeys = new Map<string, string>();
  const alternatives = new Map<string, {backend: PrinterBackend; destinationId: string}[]>();
  for (const group of groups) {
    const keys = group.flatMap(candidate => candidate.keys);
    const key = keys.find(item => item.startsWith('serial:')) ?? keys[0];
    if (key) for (const candidate of group) choiceKeys.set(candidate.id, key);
    const winner = chosen.get(group[0]!)!;
    const backends = [...new Set(group.map(candidate => candidate.backend))];
    if (backends.length < 2) continue;
    // Each MCP's own pick for this printer, as the rule would make it within that MCP; the listed one first.
    const pick = (backend: PrinterBackend) => { const pool = group.filter(candidate => candidate.backend === backend); return (pool.find(candidate => candidate.source === 'current') ?? pool[0]!).id; };
    alternatives.set(winner.id, [winner.backend, ...backends.filter(backend => backend !== winner.backend)]
      .map(backend => ({backend, destinationId: backend === winner.backend ? winner.id : pick(backend)})));
  }
  const listed = candidates.filter(candidate => chosen.get(candidate) === candidate);
  const defaultDestinationId = canonical.get('current')!;
  const destinations: PrinterDestination[] = [...listed.filter(item => item.id === defaultDestinationId), ...listed.filter(item => item.id !== defaultDestinationId)]
    .map(({id, name, backend, model, address, source, origin, folder, incomplete}) => ({id, name, backend, ...(model ? {model} : {}), ...(address ? {address} : {}), source, origin,
      ...(alternatives.has(id) ? {mcps: alternatives.get(id)!} : {}), ...(origin === 'counterpart' && folder ? {folder} : {}), ...(incomplete ? {incomplete} : {})}));
  return {defaultDestinationId, destinations, configs, canonical, candidates, choiceKeys};
}
