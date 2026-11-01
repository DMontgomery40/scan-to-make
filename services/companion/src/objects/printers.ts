import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {printerHandoffConfigSchema, printerSelectionSchema, type PrinterBackend, type PrinterHandoffConfig, type PrinterMcpProcess} from '@scan-to-make/printer-handoff';

/** Configured destinations, not claims about live printer connectivity. */
export interface PrinterDestination {
  id: string;
  name: string;
  backend: PrinterBackend;
  model?: string;
  address?: string;
  source: 'current' | 'mcp-profile';
}

export interface PrinterCatalog {
  defaultDestinationId: string;
  destinations: PrinterDestination[];
  /** Only companion code receives process settings; callers get a defensive copy. */
  resolve(id: string): PrinterHandoffConfig | undefined;
}

export interface PrinterCatalogOptions {
  homeDirectory?: string;
  /** Explicit JSON client/Codemode files; replaces defaults when supplied. */
  sourcePaths?: string[];
  /** Metadata source only. Does not add or override the MCP process environment. */
  currentEnvPath?: string;
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
  ].map(path => join(home, path));
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
  // Different generic API ports can represent distinct printers on one host.
  const port = config.selection?.port ?? text(env.PRINTER_PORT) ?? '';
  const identity = address ? JSON.stringify([config.backend, address.toLowerCase(), port, serial ?? '']) : undefined;
  const printerType = printerSelectionSchema.shape.printerType.safeParse(bambu ? 'bambu' : text(env.PRINTER_TYPE)?.toLowerCase());
  return {address, model: model && /^[a-zA-Z0-9 _.-]{1,64}$/.test(model) ? model.toLowerCase() : undefined,
    printerType: printerType.success ? printerType.data : undefined, identity};
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

/** Reads configured profiles only. Does not start MCP processes or contact printers. */
export async function loadPrinterCatalog(current: PrinterHandoffConfig, options: PrinterCatalogOptions = {}): Promise<PrinterCatalog> {
  const home = options.homeDirectory ?? homedir();
  const currentConfig = printerHandoffConfigSchema.parse(structuredClone(current));
  const currentMetadata = await metadata(currentConfig, options.currentEnvPath);
  const configs = new Map<string, PrinterHandoffConfig>([['current', currentConfig]]);
  const identities = new Set(currentMetadata.identity ? [currentMetadata.identity] : []);
  const destinations: PrinterDestination[] = [{id: 'current', name: defaultName(currentConfig.backend, currentMetadata.model), backend: currentConfig.backend,
    ...(currentMetadata.model ? {model: currentMetadata.model} : {}), ...(currentMetadata.address ? {address: currentMetadata.address} : {}), source: 'current'}];
  const queue = (options.sourcePaths ?? defaultSources(home)).map(path => expand(path, home, home));
  const visited = new Set<string>();
  while (queue.length && visited.size < 128) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const contents = await readText(path);
    let document: RecordValue | undefined;
    try { document = contents === undefined ? undefined : record(JSON.parse(contents)); } catch { continue; }
    if (!document) continue;
    if (Array.isArray(document.configDirectories)) for (const directory of document.configDirectories) {
      if (typeof directory === 'string') queue.push(join(expand(directory, home, dirname(path)), '.mcp.json'));
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
      if (codemodePath && isAbsolute(codemodePath)) queue.push(codemodePath);
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
      if (!meta.address || (meta.identity && identities.has(meta.identity))) continue;
      // Tool schemas require these explicit arguments before the MCP can apply its own env defaults.
      // Carry only the existing profile's model/type; retain its complete process configuration unchanged.
      if (meta.model || meta.printerType) config.selection = {
        ...(meta.model ? {model: meta.model} : {}), ...(meta.printerType ? {printerType: meta.printerType} : {}),
      };
      if (meta.identity) identities.add(meta.identity);
      const id = `mcp-${createHash('sha256').update(`${path}\0${key}`).digest('hex').slice(0, 24)}`;
      const label = name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      destinations.push({id, name: label || defaultName(backend, meta.model), backend, address: meta.address,
        ...(meta.model ? {model: meta.model} : {}), source: 'mcp-profile'});
      configs.set(id, config);
    }
  }
  return {defaultDestinationId: 'current', destinations, resolve(id) {
    const config = configs.get(id);
    return config ? structuredClone(config) : undefined;
  }};
}
