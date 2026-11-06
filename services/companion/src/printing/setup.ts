import {appendFile, mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {readdirSync, statSync} from 'node:fs';
import {dirname, isAbsolute, join, normalize, sep} from 'node:path';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PrinterMcpClient, toolResultJson, type PrinterBackend, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {appInstall, appMcpId, installedVersion, mcpIdFor, resolveMcpInstall, type InstallEnvironment, type ResolvedMcpInstall} from './mcp-install.js';
import type {McpUpdate} from './mcp-updates.js';
import type {PrinterCatalog} from '../objects/printers.js';
import {envOf, field, kindFor, modelForSerial, names, readMcpSetup, readSetupCache, setupOptions, writeSetupCache, type McpSetup, type SetupKind, type SetupOptions} from './mcp-setup.js';
import type {PrintGate} from './print-gate.js';
import {newerVersion} from './directory.js';
import {changeProfiles, findBambuRoute, newProfileId, readProfiles, readsRouteSettings, settingsGap, type RouteSource, type SavedProfile} from './profiles.js';

/**
 * Settings → Printers: both printer MCPs, whether this Mac has each, and Download for one it hasn't. The MCPs are
 * the backend: Counterpart only finds and installs them (PRD §8.10's npm staging and swap, through McpUpdater).
 */
export const MCP_PACKAGES: readonly {package: PrinterBackend; label: string; description: string}[] = [
  {package: 'bambu-printer-mcp', label: 'bambu-printer-mcp', description: 'Bambu Lab printers'},
  {package: 'mcp-3d-printer-server', label: 'mcp-3D-printer-server', description: 'Prusa, Klipper, OctoPrint, Duet, Repetier, Creality — and Bambu'},
];
const PACKAGES = new Set<string>(MCP_PACKAGES.map(item => item.package));
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** Which copy a profile runs, in Settings' words. Counterpart's other copies (an earlier `bambu-1.1.46`) are named as such. */
function copyWords(install: ResolvedMcpInstall, path: string | undefined, managed: boolean, home: (path: string) => string): string {
  if (managed) return 'Counterpart’s copy';
  if (install.type === 'app') return `Counterpart’s older copy at ${home(path ?? '')}`;
  if (install.type === 'npx') return `npx ${install.spec}`;
  if (install.type === 'unresolved') return 'a copy Counterpart can’t place';
  return path ? `your copy at ${home(path)}` : 'your copy';
}

/** A built copy of either MCP in a folder of its own (a clone or an unpacked package), found on this Mac. */
export interface FoundFolder {dir: string; package: PrinterBackend; version?: string; hasEnv: boolean}

// Folders macOS guards with a privacy prompt (and iCloud): a background agent reading them would raise one.
const SKIP = new Set(['Library', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Applications', 'node_modules', 'Public']);
const MAX_ENTRIES = 400;
/** Reading an MCP's fields for Add, inside printers.add's 30 s request deadline with time left to save. */
const ADD_SETUP_BUDGET_MS = 20_000;

async function packageAt(dir: string): Promise<FoundFolder | undefined> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    if (raw.length > 256 * 1024) return undefined;
    const json = JSON.parse(raw) as {name?: unknown; version?: unknown};
    const name = typeof json.name === 'string' ? json.name.toLowerCase() : '';
    if (!PACKAGES.has(name)) return undefined;
    if (!(await stat(join(dir, 'dist', 'index.js'))).isFile()) return undefined;
    const hasEnv = await stat(join(dir, '.env')).then(info => info.isFile(), () => false);
    return {dir, package: name as PrinterBackend, ...(typeof json.version === 'string' ? {version: json.version} : {}), hasEnv};
  } catch { return undefined; }
}

/**
 * Copies of either MCP in the home folder and one level below it (~/mcp-3D-printer-server, ~/src/bambu-printer-mcp).
 * Hidden folders and the ones macOS protects are skipped; at most MAX_ENTRIES are looked at per level.
 */
export async function findMcpFolders(home: string): Promise<FoundFolder[]> {
  const found: FoundFolder[] = [];
  const children = async (dir: string) => {
    try { return (await readdir(dir, {withFileTypes: true})).filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)).slice(0, MAX_ENTRIES); }
    catch { return []; }
  };
  for (const first of await children(home)) {
    const dir = join(home, first.name);
    const here = await packageAt(dir);
    if (here) { found.push(here); continue; }
    for (const second of await children(dir)) {
      const nested = await packageAt(join(dir, second.name));
      if (nested) found.push(nested);
    }
  }
  return found;
}

export interface PackageInstall {kind: ResolvedMcpInstall['type'] | 'folder'; path?: string; version?: string}
export interface McpPackageView {
  package: PrinterBackend;
  label: string;
  description: string;
  /** Some copy of it is on this Mac (a printer runs it, the app's own copy, or a folder of its own): no Download. */
  installed: boolean;
  /** The on-disk version of the copy Check and Add use; not a newer discovered checkout or an npx pin. */
  version?: string;
  latestVersion?: string;
  /** The id Download's mcp.update.* events carry (the app's own copy). */
  appMcpId: string;
  /** The selected runnable copy first, so its displayed location and version describe the same install. */
  installs: PackageInstall[];
  appCopy?: PackageInstall;
  uses: McpUse[];
  /** One Move per install a printer could leave for Counterpart's copy, in the order the uses are listed, each named by its printers, MCP and copy. */
  moves: {mcpId: string; title: string}[];
}
/**
 * A printer profile on a package. `managed`: it runs Counterpart's own copy (`<appPrinters>/bambu` or `/generic`).
 * `words` says which copy and version in full, including when that copy is older than Counterpart's.
 */
export interface McpUse {destinationId: string; printerId: string; printer: string; mcpId: string; kind: string; path?: string; version?: string; canMove: boolean; managed: boolean; words: string}

// KAN-163's checks: a literal host (no scheme, path, port or credentials), a Bambu serial, a port.
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** A value written to the `.env` in single quotes: one line, printable, no quote. */
const envValue = z.string().max(512).regex(/^[\x20-\x26\x28-\x7e]*$/);
/**
 * A path on this computer, written to the `.env` in single quotes: any printable text (a folder may be named
 * "José"), on one line, with no single quote to end the value early.
 */
const localPath = z.string().min(1).max(1024).regex(/^[^\u0000-\u001f\u007f\u2028\u2029']+$/u).refine(value => isAbsolute(value), 'Choose a full path.');
export const PrinterFormSchema = z.union([
  /** A found folder; `model` fills the model its MCP needs when Counterpart couldn't tell it. */
  z.strictObject({folder: z.string().min(2).max(4096), model: z.string().regex(/^[a-z0-9]{1,16}$/).optional()}),
  /** The form: which MCP drives it and the values of that MCP's own fields (`counterpart_setup_fields`), checked against them on Check and Add. */
  z.strictObject({
    backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']),
    printerType: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    host: z.string().trim().max(254).transform(value => value.replace(/\.$/, '')).pipe(z.string().min(1).max(253).regex(HOST)),
    port: z.string().regex(/^[1-9][0-9]{0,4}$/).refine(value => Number(value) <= 65535).optional(),
    serial: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/).optional(),
    model: z.string().regex(/^[a-z0-9]{1,16}$/).optional(),
    secret: envValue.optional(),
    name: z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
    /** The slicer settings the MCP declares (`slicer.fields`): which slicer, where it is, where its Bambu profiles are. */
    slicer: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
    slicerPath: localPath.optional(),
    profiles: localPath.optional(),
  }),
]);
export type PrinterForm = z.infer<typeof PrinterFormSchema>;
type FormFields = Exclude<PrinterForm, {folder: string}>;

/** The form's values as exactly the MCP's own variables, by the fields it declares for this kind and its slicer. */
export function envFor(form: FormFields, kind: SetupKind, slicer?: McpSetup['slicer']): Record<string, string> {
  return envOf({...kind, fields: [...kind.fields, ...(slicer?.fields ?? [])]}, {host: form.host, port: form.port, serial: form.serial, model: form.model,
    secret: form.secret, slicer: form.slicer, 'slicer-path': form.slicerPath, profiles: form.profiles});
}
export const envFile = (env: Record<string, string>) =>
  '# Written by Counterpart (Settings → Printers → Add printer…). The printer MCP reads it; edit it here for anything advanced.\n' +
  Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';

/**
 * `printers.obtain`: fetch a form field's value through the MCP instead of the person typing it, where the MCP's own
 * field declares how (`obtain`, e.g. OctoPrint's key approved in OctoPrint). Without `session` it starts; with it, it
 * waits up to about 20 s for the answer. The MCP keeps the request in its own process, so that copy stays running
 * between calls (ten minutes at most).
 */
export const ObtainRequestSchema = z.strictObject({
  backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']),
  printerType: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  host: z.string().trim().max(254).transform(value => value.replace(/\.$/, '')).pipe(z.string().min(1).max(253).regex(HOST)),
  port: z.string().regex(/^[1-9][0-9]{0,4}$/).refine(value => Number(value) <= 65535).optional(),
  /** The form field to fill: one whose MCP field declares `obtain` (only `secret` today). */
  field: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  session: z.string().uuid().optional(),
});
export type ObtainRequest = z.infer<typeof ObtainRequestSchema>;
/** What the person sees, and once approved the field's value for the form (only that field's own variable). */
export interface ObtainResult {
  session?: string;
  status: 'pending' | 'approved' | 'failed';
  message: string;
  /** The page where the person approves it (the MCP's `approve_url`), http or https only. */
  approveUrl?: string;
  value?: string;
}
const ObtainAnswerSchema = z.object({
  status: z.string().max(32),
  message: z.string().max(600),
  request_id: z.string().min(1).max(128).optional(),
  approve_url: z.string().max(2048).optional(),
  env: z.record(z.string().max(64), z.string().max(512)).optional(),
});
const OBTAIN_LIFETIME_MS = 10 * 60_000;
const OBTAIN_WAIT_MS = 20_000;
const MAX_OBTAIN_SESSIONS = 4;
const webUrl = (value: string | undefined) => {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined; } catch { return undefined; }
};

/** A printer Add printer… found, first in the sheet. Never carries a secret. */
export interface SetupCandidate {
  id: string;
  source: 'folder' | 'ssdp' | 'bonjour';
  name: string;
  backend: PrinterBackend;
  printerType: string;
  model?: string;
  host?: string;
  port?: string;
  serial?: string;
  /** A configured MCP folder: Add runs it where it is, with its own `.env`, in one click. */
  folder?: string;
  /** Already one of the printers (by serial). */
  added: boolean;
  /** A folder whose `.env` lacks settings its MCP needs (names only), and what Counterpart adds on Add (only the model). */
  missing?: string[];
  fill?: Record<string, string>;
}
export interface CheckResult {
  /** get_printer_status answered and said the printer is connected. */
  reached: boolean;
  camera: 'connected' | 'failed' | 'not-supported';
  image?: {mimeType: 'image/jpeg'; base64: string};
  model?: string;
}
type ProbeClient = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close'>;

export interface PrinterSetupDeps {
  env: InstallEnvironment;
  /** Every catalog profile, winners and duplicates, as configured and as the companion runs it. */
  configs(): {id: string; config: PrinterHandoffConfig}[];
  effective?(id: string, config: PrinterHandoffConfig): PrinterHandoffConfig;
  download?(pkg: PrinterBackend): Promise<McpUpdate>;
  /** The published version; Settings may wait briefly for a check it starts (McpUpdater.latestVersionSettled). */
  latestVersion?(pkg: PrinterBackend, options?: {view?: boolean}): string | undefined | Promise<string | undefined>;
  /** Copies in folders of their own (findMcpFolders). */
  folders?(): Promise<FoundFolder[]>;
  /** Directory listing, for the app's earlier copies (`<appPrinters>/bambu-1.1.46`). */
  list?(path: string): string[];
  /** The companion's node, which runs an added printer's MCP. */
  node?: string;
  /** `<appPrinters>/profiles.json`. */
  profilesPath?: string;
  catalog?(): PrinterCatalog | undefined;
  /** Reads the catalog again and starts or stops the printers' services. */
  reload?(): Promise<void>;
  /** Restarts a printer's MCP session, so its MCP reads its `.env` again. */
  restart?(destinationId: string): Promise<void>;
  busy?(destinationId: string): Promise<boolean>;
  gate?: PrintGate;
  /** `<appPrinters>/mcp-setup.json`: each MCP's last setup fields, for the printer list. */
  setupCachePath?: string;
  /** How long `printers.discover` may take in all (default 13 s, inside its 15 s request deadline). */
  discoverBudgetMs?: number;
  /** How soon an MCP that didn't start or answer in time is asked again (default 20 s). */
  retryAfterMs?: number;
  /** printers.check's whole budget (default 55 s, inside local-control's 60 s): setup fields, connect, status and camera. */
  checkBudgetMs?: number;
  /** Starts an MCP for Check (a fresh process, closed after; never a printer's shared session). */
  client?(config: PrinterHandoffConfig): ProbeClient;
}

/** `counterpart_discover_printers` (docs/protocols/mcp-contract.md): printers an MCP heard on the network itself. */
const DiscoverySchema = z.object({
  contract: z.literal('counterpart/1'),
  network: z.enum(['complete', 'unavailable']),
  printers: z.array(z.object({
    kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), source: z.enum(['ssdp', 'bonjour']), name: z.string().max(256),
    host: z.string().max(253).regex(HOST), port: z.number().int().min(1).max(65535).optional(),
    serial: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional(), model: z.string().regex(/^[a-z0-9]{1,16}$/).optional(), firmware: z.string().max(64).optional(),
  })).max(128),
});
type DiscoveredPrinter = z.infer<typeof DiscoverySchema>['printers'][number];

export class PrinterSetupError extends Error {
  constructor(readonly code: 'not-found' | 'unavailable' | 'invalid' | 'conflict', message: string) { super(message); this.name = 'PrinterSetupError'; }
}

/**
 * The entry point of a copy Counterpart can start itself. An npx profile has none (npx fetches it when that client
 * starts it), so a package known only through npx is not "installed" here: Download gets a copy Check and Add can run.
 */
function localEntry(pkg: PrinterBackend, install: {kind: string; path?: string}, env: InstallEnvironment): string | undefined {
  if (!install.path) return undefined;
  const entry = install.kind === 'global' || install.kind === 'app' ? join(install.path, 'lib', 'node_modules', pkg, 'dist', 'index.js')
    : install.kind === 'checkout' || install.kind === 'folder' ? join(install.path, 'dist', 'index.js') : undefined;
  return entry && env.exists(entry) ? entry : undefined;
}

export class PrinterSetup {
  readonly deps: PrinterSetupDeps;
  constructor(deps: PrinterSetupDeps) { this.deps = deps; }

  #list(path: string): string[] {
    if (this.deps.list) return this.deps.list(path);
    try { return readdirSync(path); } catch { return []; }
  }

  /** `printers.mcps`: both packages, always, with every copy of each the companion can see, and Add printer…'s choices from them. */
  async mcps(): Promise<{packages: McpPackageView[]; options: SetupOptions}> {
    // Settings answers within its deadline from the fields already read; reading them again never holds it up.
    const options = setupOptions(await this.#setups({cachedOnly: true}));
    void this.#setups().catch(() => undefined);
    return {packages: await this.#packages(), options};
  }

  async #packages(): Promise<McpPackageView[]> {
    const {env} = this.deps;
    const installs = new Map<PrinterBackend, Map<string, PackageInstall>>(MCP_PACKAGES.map(item => [item.package, new Map()]));
    const add = (pkg: PrinterBackend, key: string, install: PackageInstall) => { if (!installs.get(pkg)!.has(key)) installs.get(pkg)!.set(key, install); };
    // What the printers run (each profile as configured, and after an Update's override).
    for (const {id, config} of this.deps.configs()) {
      for (const profile of [config, this.deps.effective?.(id, config) ?? config]) {
        const install = resolveMcpInstall(profile, env);
        if (install.type === 'unresolved') continue;
        const path = install.type === 'npx' ? install.spec : install.type === 'checkout' ? install.dir : install.prefix;
        const version = installedVersion(install, env);
        add(profile.backend, `${install.type}:${path}`, {kind: install.type, path, ...(version ? {version} : {})});
      }
    }
    // The app's own copies: <appPrinters>/bambu, /generic, and earlier ones (bambu-1.1.46) in any folder there.
    for (const name of this.#list(env.appPrinters)) {
      for (const pkg of PACKAGES) {
        const prefix = join(env.appPrinters, name);
        const file = join(prefix, 'lib', 'node_modules', pkg, 'package.json');
        if (!env.exists(file)) continue;
        const version = installedVersion({type: 'app', pkg, prefix}, env);
        add(pkg as PrinterBackend, `app:${prefix}`, {kind: 'app', path: prefix, ...(version ? {version} : {})});
      }
    }
    for (const folder of await (this.deps.folders?.() ?? Promise.resolve([]))) {
      add(folder.package, `checkout:${folder.dir}`, {kind: 'folder', path: folder.dir, ...(folder.version ? {version: folder.version} : {})});
    }
    const latest = new Map(await Promise.all(MCP_PACKAGES.map(async item =>
      [item.package, await Promise.resolve(this.deps.latestVersion?.(item.package, {view: true})).catch(() => undefined)] as const)));
    const home = (path: string) => under(path, env.home) ? `~${path.slice(env.home.length)}` : path;
    return MCP_PACKAGES.map(item => {
      const found = [...installs.get(item.package)!.values()];
      // Match #entry: the managed copy wins, then the first other runnable copy. A development
      // checkout's future version must not label the installed package that Download/Update manages.
      const own = appInstall(item.package, env);
      if (env.exists(own.entry!) && !found.some(install => install.kind === 'app' && install.path === own.prefix)) {
        // #entry can start this copy even when its manifest is missing or its parent can't be listed.
        // Keep an unknown version unknown instead of borrowing another copy's version.
        const version = installedVersion(own, env);
        found.unshift({kind: 'app', path: own.prefix, ...(version ? {version} : {})});
      }
      const selected = found.find(install => install.kind === 'app' && install.path === own.prefix && localEntry(item.package, install, env))
        ?? found.find(install => localEntry(item.package, install, env));
      const version = selected?.version;
      const appVersion = installedVersion(own, env);
      const appCopy: PackageInstall | undefined = env.exists(own.entry!) ? {kind: 'app', path: own.prefix, ...(appVersion ? {version: appVersion} : {})} : undefined;
      const catalog = this.deps.catalog?.();
      const uses = this.deps.configs().filter(entry => entry.config.backend === item.package).map(({id, config}): McpUse => {
        const effective = this.deps.effective?.(id, config) ?? config;
        const install = resolveMcpInstall(effective, env);
        const path = install.type === 'checkout' ? install.dir : install.type === 'app' || install.type === 'global' ? install.prefix
          : install.type === 'npx' ? install.spec : undefined;
        const version = install.type === 'npx' ? undefined : installedVersion(install, env);
        const printer = catalog?.destinations.find(destination => destination.id === catalog.canonical(id))?.name ?? id;
        const managed = install.type === 'app' && install.prefix === own.prefix;
        return {destinationId: id, printerId: catalog?.canonical(id) ?? id, printer, mcpId: mcpIdFor(resolveMcpInstall(config, env), config), kind: install.type,
          ...(path ? {path} : {}), ...(version ? {version} : {}), canMove: !managed, managed,
          words: `${printer} uses ${copyWords(install, path, managed, home)} (${version ?? 'version unknown'})`
            + (!managed && version && appVersion && newerVersion(appVersion, version) ? `, older than Counterpart’s copy (${appVersion}).` : '.')};
      });
      // In the order the uses are listed: two Moves for one printer (one per MCP profile) read differently and in screen order.
      const moves = [...new Set(uses.filter(use => use.canMove).map(use => use.mcpId))].map(mcpId => {
        const on = uses.filter(use => use.mcpId === mcpId), first = on[0]!;
        const printers = [...new Set(on.map(use => use.printer))].join(', ');
        const from = first.kind === 'app' ? `Counterpart’s older copy at ${home(first.path ?? '')}` : first.kind === 'npx' ? `npx ${first.path ?? item.label}`
          : first.path ? `your copy at ${home(first.path)}` : 'your copy';
        return {mcpId, title: `Move ${printers} (${item.label}, ${from}) to Counterpart’s updated copy`};
      });
      const latestVersion = latest.get(item.package);
      return {...item, installed: !!selected, ...(version ? {version} : {}), ...(latestVersion ? {latestVersion} : {}),
        appMcpId: appMcpId(item.package, env), uses, moves, ...(appCopy ? {appCopy} : {}), installs: selected ? [selected, ...found.filter(install => install !== selected)] : found};
    });
  }

  /** Starts a copy of an MCP with no printer settings (a folder with no `.env`), as Add printer… runs it, for its setup tools. */
  /** The work's answer (`{value}`), or undefined when the MCP didn't start or answer in time: a failure worth retrying, not an answer. */
  async #probe<T>(pkg: PrinterBackend, entry: string, work: (client: ProbeClient, tools: Set<string>, remainingMs: () => number) => Promise<T>,
      budgetMs = 25_000): Promise<{value: T} | undefined> {
    // Whole milliseconds: AbortSignal.timeout and setTimeout refuse a fraction (a shared budget splits unevenly).
    const until = Date.now() + Math.floor(budgetMs), remainingMs = () => Math.max(0, Math.floor(until - Date.now()));
    const cwd = join(this.deps.env.appPrinters, 'profiles');
    const config: PrinterHandoffConfig = {backend: pkg, process: {command: this.#node, args: [entry], cwd}};
    const client = this.deps.client?.(config) ?? new PrinterMcpClient(config);
    try {
      await mkdir(cwd, {recursive: true, mode: 0o700});
      // The budget holds even for an MCP that ignores the abort: whatever is still pending when it runs out is dropped.
      const within = <V>(work: Promise<V>) => new Promise<V>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), remainingMs());
        work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
      const catalog = await within(client.connect(AbortSignal.timeout(remainingMs())));
      if (remainingMs() < 500) return undefined;
      return {value: await within(work(client, new Set(catalog.tools.map(tool => tool.name)), remainingMs))};
    } catch { return undefined; }
    finally { await client.close().catch(() => undefined); }
  }

  readonly #setupCache = new Map<string, {at: number; setup?: McpSetup; failed?: boolean}>();
  #setupKey(entry: string): string { return `${entry}|${statSync(entry, {throwIfNoEntry: false})?.mtimeMs ?? 0}`; }
  /**
   * One copy's own setup fields (`counterpart_setup_fields`), kept ten minutes per copy and version: an Update
   * replaces the files in place, so the entry's modification time is part of the key. None from a copy without the tool.
   */
  async #setupFor(pkg: PrinterBackend, entry: string, options: {cachedOnly?: boolean; budgetMs?: number} = {}): Promise<McpSetup | undefined> {
    const key = this.#setupKey(entry);
    const cached = this.#setupCache.get(key);
    // A confirmed answer (its fields, or no such tool) keeps ten minutes; an MCP that didn't start or answer in time, 20 s.
    if (options.cachedOnly || (cached && Date.now() - cached.at < (cached.failed ? this.deps.retryAfterMs ?? 20_000 : 10 * 60_000))) return cached?.setup;
    const answer = await this.#probe(pkg, entry, async (client, tools, remainingMs) => tools.has('counterpart_setup_fields')
      ? readMcpSetup(toolResultJson(await client.callTool('counterpart_setup_fields', {}, {timeoutMs: Math.min(10_000, remainingMs())}))) : undefined,
      options.budgetMs);
    // A transient failure never hides fields an earlier answer gave.
    const setup = answer ? answer.value : cached?.setup;
    this.#setupCache.set(key, {at: Date.now(), ...(setup ? {setup} : {}), ...(answer ? {} : {failed: true})});
    return setup;
  }
  /**
   * Each MCP's own setup fields (`counterpart_setup_fields`), from the copy an added printer would run, kept ten
   * minutes per copy. An MCP that isn't on this Mac, or doesn't have the tool, has none.
   */
  async #setups(options: {cachedOnly?: boolean; budgetMs?: number} = {}): Promise<{package: PrinterBackend; label: string; entry?: string; setup?: McpSetup; installed: boolean}[]> {
    // Both MCPs at once: a slow one never delays the other's fields.
    type Setup = {package: PrinterBackend; label: string; entry?: string; setup?: McpSetup; installed: boolean; unanswered?: boolean};
    const out = await Promise.all(MCP_PACKAGES.map(async (item): Promise<Setup> => {
      const entry = await this.#entry(item.package).catch(() => undefined);
      if (!entry) return {package: item.package, label: item.label, installed: false};
      const setup = await this.#setupFor(item.package, entry, options);
      const unanswered = !setup && !!this.#setupCache.get(this.#setupKey(entry))?.failed;
      return {package: item.package, label: item.label, entry, ...(setup ? {setup} : {}), installed: true, ...(unanswered ? {unanswered} : {})};
    }));
    if (!options.cachedOnly) await this.#saveSetups(new Map(out.flatMap(item => item.setup ? [[item.package, item.setup] as const] : [])));
    return out;
  }
  /** The printer list judges each .env by these fields: when they change, it reads them again now, not at a restart. */
  async #saveSetups(known: Map<PrinterBackend, McpSetup>, merge = false): Promise<void> {
    if (!this.deps.setupCachePath) return;
    const saved = await readSetupCache(this.deps.setupCachePath);
    const next = merge ? new Map([...saved, ...known]) : known;
    if (JSON.stringify(Object.fromEntries(next)) === JSON.stringify(Object.fromEntries(saved))) return;
    await writeSetupCache(this.deps.setupCachePath, next).catch(() => undefined);
    await this.deps.reload?.();
  }
  /** One MCP's fields, from the copy an added printer would run: never waits on the other MCP. */
  async #setupOf(pkg: PrinterBackend, options: {cachedOnly?: boolean; budgetMs?: number} = {}): Promise<McpSetup | undefined> {
    const entry = await this.#entry(pkg).catch(() => undefined);
    if (!entry) return undefined;
    const setup = await this.#setupFor(pkg, entry, options);
    if (setup && !options.cachedOnly) await this.#saveSetups(new Map([[pkg, setup]]), true);
    return setup;
  }
  /** The fields already read (the chosen MCP's among them): naming a printer never starts another MCP. */
  async #cachedOptions(): Promise<SetupOptions> { return setupOptions(await this.#setups({cachedOnly: true})); }

  /** `printers.installMcp`: Download installs only that package, only when no copy of it is on this Mac. */
  async installMcp(pkg: PrinterBackend): Promise<{installed: true; package: PrinterBackend} | {update: McpUpdate}> {
    const view = (await this.#packages()).find(item => item.package === pkg);
    if (!view) throw new PrinterSetupError('not-found', 'Counterpart doesn’t know that MCP.');
    if (view.installed) return {installed: true, package: pkg};
    if (!this.deps.download) throw new PrinterSetupError('unavailable', 'Counterpart can’t install printer MCPs on this Mac yet.');
    return {update: await this.deps.download(pkg)};
  }

  get #profilesPath(): string { return this.deps.profilesPath ?? join(this.deps.env.appPrinters, 'profiles.json'); }
  get #node(): string { return this.deps.node ?? process.execPath; }
  #label(pkg: PrinterBackend): string { return MCP_PACKAGES.find(item => item.package === pkg)!.label; }

  /**
   * Folders whose printer settings the catalog already uses: a profile's working directory (where its MCP reads
   * `.env`), or its ssh command's. Running a found checkout's code with settings of its own (another folder, or
   * inline) isn't that checkout's printer, so it stays offered. Only a profile with neither falls back to its
   * installation's folders.
   */
  #runs(): string[] {
    const paths: string[] = [];
    for (const {id, config} of this.deps.configs()) for (const profile of [config, this.deps.effective?.(id, config) ?? config]) {
      const install = resolveMcpInstall(profile, this.deps.env);
      const settings = install.via?.cwd ?? profile.process.cwd;
      if (settings) { paths.push(settings); continue; }
      if (profile.process.env?.PRINTER_HOST || install.via?.env?.PRINTER_HOST) continue;
      if (install.type === 'checkout') paths.push(install.dir);
      if (install.type === 'global' || install.type === 'app') paths.push(install.prefix);
      const entry = profile.process.args?.find(arg => arg.endsWith('.js') && isAbsolute(arg));
      if (entry) paths.push(dirname(dirname(entry)));
    }
    return paths;
  }

  /** A built copy of an MCP with its own `.env`, as found (never a path the caller made up). */
  async #folder(dir: string, options: {cachedOnly?: boolean; budgetMs?: number} = {}) {
    if (!isAbsolute(dir) || normalize(dir) !== dir) throw new PrinterSetupError('invalid', 'That folder isn’t a printer MCP Counterpart found.');
    const found = (await (this.deps.folders?.() ?? Promise.resolve([]))).find(folder => folder.dir === dir);
    if (!found?.hasEnv) throw new PrinterSetupError('invalid', 'That folder isn’t a printer MCP with its settings.');
    const env = await readFile(join(dir, '.env'), 'utf8').then(text => text.length <= 256 * 1024 ? parseEnv(text) : {}, () => ({} as Record<string, string | undefined>));
    // What it is and where its printer is, by the fields its own MCP declares for that kind.
    const setup = await this.#setupFor(found.package, join(dir, 'dist', 'index.js'), options), kind = kindFor(setup, env);
    const read = (name: string) => { const item = field(kind, name); return item ? names(item).map(key => env[key]?.trim()).find(value => !!value) : undefined; };
    const host = read('host')?.replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
    const serial = read('serial'), model = read('model')?.toLowerCase();
    return {found, env, setup, kind, host: host && HOST.test(host) ? host : undefined, printerType: kind?.kind ?? 'unknown',
      ...(serial && /^[A-Za-z0-9]{1,64}$/.test(serial) ? {serial: serial.toUpperCase()} : {}),
      ...(model && /^[a-z0-9]{1,16}$/.test(model) ? {model} : {})};
  }

  /** "Bambu Lab P1S", "OctoPrint at octopi.local": the kind and model in the MCP's own words; "via <MCP>" when another MCP is the usual one. */
  #nameFor(options: SetupOptions, printerType: string, model?: string, host?: string, backend?: PrinterBackend): string {
    const type = options.types.find(item => item.printerType === printerType);
    const modelLabel = model ? (backend ? options.models[backend] : undefined)?.find(choice => choice.value === model)?.label ?? model.toUpperCase() : undefined;
    const base = `${type?.label ?? 'Printer'}${modelLabel ? ` ${modelLabel}` : host ? ` at ${host}` : ''}`;
    const via = backend && type && type.backends.length > 1 && type.backends[0] !== backend ? ` via ${this.#label(backend)}` : '';
    return (base + via).slice(0, 120);
  }

  /**
   * `printers.discover`: configured MCP folders on this Mac, and the printers each MCP finds on the network itself
   * (`counterpart_discover_printers`), asked one MCP at a time so two never listen on the same port. A printer both
   * MCPs find is listed once, with the MCP listed first for its kind (PRD §8.2). About 4 s per MCP.
   */
  async discover(): Promise<{found: SetupCandidate[]; network: 'complete' | 'unavailable'; options: SetupOptions}> {
    // All of it inside the request's 15 s: what doesn't fit is left out, never the whole answer.
    const until = Date.now() + (this.deps.discoverBudgetMs ?? 13_000), remainingMs = () => Math.max(0, until - Date.now());
    const [folders, saved, setups] = await Promise.all([
      (this.deps.folders?.() ?? Promise.resolve([])).catch(() => []),
      readProfiles(this.#profilesPath),
      this.#setups({budgetMs: Math.round((this.deps.discoverBudgetMs ?? 13_000) * 6 / 13)}),
    ]);
    const options = setupOptions(setups);
    const runs = [...this.#runs(), ...saved.profiles.map(profile => profile.process.cwd)];
    // A configured folder's own fields are read while the MCPs listen, not after: a slow network never hides it.
    const configured = folders.filter(folder => folder.hasEnv && !runs.some(path => path === folder.dir || path.startsWith(folder.dir + sep)));
    const reading = Promise.all(configured.map(folder => this.#folder(folder.dir, {budgetMs: remainingMs()}).catch(() => undefined)));
    const announced: {package: PrinterBackend; printer: DiscoveredPrinter}[] = [];
    let network: 'complete' | 'unavailable' = 'unavailable';
    // Each MCP gets an equal share of the time left, so a stalled first one can't take the second's.
    const listening = setups.filter(item => item.entry && item.setup);
    for (const [i, item] of listening.entries()) {
      const share = Math.floor(remainingMs() / (listening.length - i));
      if (share < 2_500) continue;
      const answer = await this.#probe(item.package, item.entry!, async (client, tools, left) => tools.has('counterpart_discover_printers')
        ? DiscoverySchema.safeParse(toolResultJson(await client.callTool('counterpart_discover_printers',
          {duration_ms: Math.max(500, Math.min(3_000, left() - 1_500))}, {timeoutMs: left()}))) : undefined, share);
      const result = answer?.value;
      if (!result?.success) continue;
      if (result.data.network === 'complete') network = 'complete';
      for (const printer of result.data.printers) announced.push({package: item.package, printer});
    }
    const catalog = this.deps.catalog?.();
    const known = new Set((catalog?.entries() ?? []).map(entry => catalog!.choiceKey(entry.id)).filter((key): key is string => !!key));
    const found: SetupCandidate[] = [];
    const reads = await reading;
    for (const [i, folder] of configured.entries()) {
      const read = reads[i];
      if (!read?.host || !read.kind) continue;
      // A model its .env lacks: the printer's own announcement first, else the model its MCP says the serial names.
      const heard = announced.find(item => read.serial && item.printer.serial?.toUpperCase() === read.serial)?.printer.model;
      const route = await this.#route(folder.package, read.env, join(folder.dir, 'dist', 'index.js'), folder.dir);
      const gap = settingsGap(folder.package, read.env, read.kind, {...(heard ? {model: heard} : {}), ...(route ? {route} : {})});
      const modelEnv = field(read.kind, 'model')?.env;
      const model = read.model ?? (modelEnv ? gap.fill[modelEnv] : undefined);
      found.push({id: `folder:${folder.dir}`, source: 'folder', name: this.#nameFor(options, read.printerType, model, read.host, folder.package),
        backend: folder.package, printerType: read.printerType, host: read.host, ...(read.serial ? {serial: read.serial} : {}),
        ...(model ? {model} : {}), folder: folder.dir, added: false,
        ...(gap.missing.length || Object.keys(gap.fill).length ? {missing: gap.missing, fill: gap.fill} : {})});
    }
    const listed = new Set<string>();
    for (const {package: pkg, printer} of announced) {
      const key = printer.serial ? `serial:${printer.serial.toUpperCase()}` : `host:${printer.host.toLowerCase()}:${printer.port ?? ''}`;
      // The MCP listed first for this kind takes a printer both find.
      const preferred = options.types.find(type => type.printerType === printer.kind)?.backends
        .find(backend => announced.some(item => item.package === backend && item.printer.host === printer.host && item.printer.serial === printer.serial));
      if (listed.has(key) || (preferred && preferred !== pkg)) continue;
      listed.add(key);
      const kind = setups.find(item => item.package === pkg)?.setup?.kinds.find(item => item.kind === printer.kind);
      const model = printer.model ?? modelForSerial(kind, printer.serial);
      const port = printer.port === undefined ? undefined : String(printer.port);
      found.push({id: printer.serial ? `${printer.source}:${printer.serial}` : `${printer.source}:${printer.host}:${port ?? ''}`, source: printer.source,
        name: (printer.name || this.#nameFor(options, printer.kind, model, printer.host, pkg)).slice(0, 120), backend: pkg, printerType: printer.kind,
        host: printer.host, ...(port ? {port} : {}), ...(printer.serial ? {serial: printer.serial} : {}), ...(model ? {model} : {}),
        added: known.has(printer.serial ? `serial:${printer.serial.toUpperCase()}` : `host:${printer.host.toLowerCase()}:${port}`)});
    }
    return {found, network, options};
  }

  /** The MCP an added printer runs: the app's own copy, else another copy of that package on this Mac. */
  async #entry(pkg: PrinterBackend): Promise<string> {
    const own = appInstall(pkg, this.deps.env).entry!;
    if (this.deps.env.exists(own)) return own;
    const view = (await this.#packages()).find(item => item.package === pkg)!;
    for (const install of view.installs) {
      const entry = localEntry(pkg, install, this.deps.env);
      if (entry) return entry;
    }
    throw new PrinterSetupError('unavailable', `Download ${this.#label(pkg)} first, then add the printer.`);
  }

  async #config(input: PrinterForm, options: {budgetMs?: number} = {}): Promise<PrinterHandoffConfig> {
    if ('folder' in input) {
      const {found} = await this.#folder(input.folder, options);
      return {backend: found.package, process: {command: this.#node, args: [join(found.dir, 'dist', 'index.js')], cwd: found.dir}};
    }
    // Check runs the MCP with these settings and no .env (its working directory has none); nothing is written.
    const cwd = join(this.deps.env.appPrinters, 'profiles');
    await mkdir(cwd, {recursive: true, mode: 0o700});
    const entry = await this.#entry(input.backend);
    const {kind, setup} = await this.#kindForForm(input, options);
    return {backend: input.backend, process: {command: this.#node, args: [entry], cwd, env: envFor(input, kind, setup.slicer)}};
  }

  /**
   * The form checked against the MCP's own fields: a kind it drives, every required printer field filled, a model
   * from its choices. Nothing about any printer is known here beyond what that MCP declares.
   */
  async #kindForForm(input: FormFields, options: {budgetMs?: number} = {}): Promise<{kind: SetupKind; setup: McpSetup}> {
    const setup = await this.#setupOf(input.backend, options);
    if (!setup) throw new PrinterSetupError('unavailable', `Update ${this.#label(input.backend)} in Settings → Printers so Counterpart can set up printers with it.`);
    const kind = setup.kinds.find(item => item.kind === input.printerType);
    if (!kind) throw new PrinterSetupError('invalid', `${this.#label(input.backend)} doesn’t drive that kind of printer.`);
    const values: Record<string, string | undefined> = {host: input.host, port: input.port, serial: input.serial, model: input.model};
    for (const item of kind.fields) if (item.required && item.name !== 'secret' && item.name in values && !values[item.name])
      throw new PrinterSetupError('invalid', `Enter the printer’s ${item.label.toLowerCase()}.`);
    const model = field(kind, 'model');
    if (input.model !== undefined && (!model || (model.choices && !model.choices.some(choice => choice.value === input.model))))
      throw new PrinterSetupError('invalid', `${this.#label(input.backend)} doesn’t know that model.`);
    const slicer = field(setup.slicer ? {...kind, fields: setup.slicer.fields} : undefined, 'slicer');
    if (input.slicer !== undefined && (!slicer?.choices || !slicer.choices.some(choice => choice.value === input.slicer)))
      throw new PrinterSetupError('invalid', `${this.#label(input.backend)} doesn’t use that slicer.`);
    return {kind, setup};
  }

  /**
   * `printers.check`: starts the chosen MCP with these settings and asks get_printer_status, then (a Bambu printer,
   * when the MCP has it) camera_snapshot. Never a print, heating, motion or settings tool. Only this projection is
   * returned: no telemetry, MCP error text or credentials (KAN-163's check).
   */
  async check(input: PrinterForm): Promise<CheckResult> {
    // One budget for the whole check, inside local-control's 60 s: reading the MCP's fields comes out of it too.
    const total = this.deps.checkBudgetMs ?? 55_000;
    const until = Date.now() + total, remainingMs = () => Math.max(0, Math.floor(until - Date.now()));
    const config = await this.#config(input, {budgetMs: Math.floor(total * 10 / 55)});
    const bambuKind = config.backend === 'bambu-printer-mcp' || ('printerType' in input && input.printerType === 'bambu')
      || ('folder' in input && (await this.#folder(input.folder, {cachedOnly: true})).printerType === 'bambu');
    const result: CheckResult = {reached: false, camera: 'not-supported'};
    const client = this.deps.client?.(config) ?? new PrinterMcpClient(config);
    // The budget holds even for an MCP that ignores its timeouts: whatever is still pending when it runs out is dropped.
    const within = <V>(work: Promise<V>) => new Promise<V>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), remainingMs());
      work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    try {
      const catalog = await within(client.connect(AbortSignal.timeout(Math.min(25_000, remainingMs()))));
      const status = toolResultJson(await within(client.callTool('get_printer_status', {}, {timeoutMs: Math.min(20_000, remainingMs())})));
      if (config.backend === 'bambu-printer-mcp') {
        result.reached = status.connected === true && status.status !== 'error';
        const model = String(status.model ?? '').toLowerCase().replace(/^bambu lab\s+|\s+/g, '');
        const kind = 'printerType' in input ? (await this.#setupOf(config.backend, {cachedOnly: true}))?.kinds.find(item => item.kind === input.printerType) : undefined;
        if (field(kind, 'model')?.choices?.some(choice => choice.value === model)) result.model = model;
      } else result.reached = status.error === undefined && status.status !== 'error' && status.connected !== false && Object.keys(status).length > 0;
      if (result.reached && bambuKind && catalog.tools.some(tool => tool.name === 'camera_snapshot') && remainingMs() >= 2_000) {
        result.camera = 'failed';
        try {
          const frame = toolResultJson(await within(client.callTool('camera_snapshot', {timeout_ms: Math.min(8000, remainingMs() - 1000)}, {timeoutMs: Math.min(12_000, remainingMs())})));
          if (['image/jpeg', 'jpeg'].includes(frame.format as string) && typeof frame.base64 === 'string' && frame.base64.length <= 700_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64)) {
            const bytes = Buffer.from(frame.base64, 'base64');
            if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
              result.camera = 'connected'; result.image = {mimeType: 'image/jpeg', base64: frame.base64};
            }
          }
        } catch { /* A working status can't hide a failed camera. */ }
      }
    } catch { /* A failed check, never the MCP's own words. */ }
    finally { await client.close().catch(() => undefined); }
    return result;
  }

  readonly #obtaining = new Map<string, {client: ProbeClient; tool: string; requestId: string; key: string; field: string; env: string; timer: NodeJS.Timeout}>();

  /** `printers.obtain` (ObtainRequestSchema). */
  async obtain(input: ObtainRequest): Promise<ObtainResult> {
    const key = JSON.stringify([input.backend, input.printerType, input.host, input.port ?? '', input.field]);
    if (input.session) {
      const open = this.#obtaining.get(input.session);
      if (!open || open.key !== key) return {status: 'failed', message: 'That approval request is no longer open. Start it again.'};
      return this.#obtainAnswer(input.session, open, () => open.client.callTool(open.tool, {host: input.host, ...(input.port ? {port: input.port} : {}), request_id: open.requestId, wait_ms: OBTAIN_WAIT_MS},
        {timeoutMs: OBTAIN_WAIT_MS + 10_000}));
    }
    const {kind} = await this.#kindForForm({backend: input.backend, printerType: input.printerType, host: input.host, ...(input.port ? {port: input.port} : {})});
    const item = field(kind, input.field);
    if (!item?.obtain) throw new PrinterSetupError('invalid', `${this.#label(input.backend)} can’t fetch that for you. Enter it in the form.`);
    if (this.#obtaining.size >= MAX_OBTAIN_SESSIONS) throw new PrinterSetupError('conflict', 'Finish or close the other approvals first.');
    const entry = await this.#entry(input.backend);
    const cwd = join(this.deps.env.appPrinters, 'profiles');
    await mkdir(cwd, {recursive: true, mode: 0o700});
    // No printer settings: the MCP asks the printer named in the call, never one of its own.
    const config: PrinterHandoffConfig = {backend: input.backend, process: {command: this.#node, args: [entry], cwd}};
    const client = this.deps.client?.(config) ?? new PrinterMcpClient(config);
    const id = randomUUID();
    let open: {client: ProbeClient; tool: string; requestId: string; key: string; field: string; env: string; timer: NodeJS.Timeout} | undefined;
    try {
      const catalog = await client.connect(AbortSignal.timeout(25_000));
      if (!catalog.tools.some(tool => tool.name === item.obtain!.tool)) {
        await client.close().catch(() => undefined);
        throw new PrinterSetupError('unavailable', `Update ${this.#label(input.backend)} in Settings → Printers to use ${item.obtain.label}.`);
      }
      open = {client, tool: item.obtain.tool, requestId: '', key, field: input.field, env: item.env,
        timer: setTimeout(() => this.#closeObtain(id), OBTAIN_LIFETIME_MS)};
      open.timer.unref?.();
      this.#obtaining.set(id, open);
      const started = open;
      return await this.#obtainAnswer(id, started, () => client.callTool(started.tool, {host: input.host, ...(input.port ? {port: input.port} : {}), app: 'Counterpart'}, {timeoutMs: 30_000}));
    } catch (error) {
      if (!open) await client.close().catch(() => undefined);
      if (error instanceof PrinterSetupError) throw error;
      this.#closeObtain(id);
      throw new PrinterSetupError('unavailable', `${this.#label(input.backend)} couldn’t start the approval. Try again.`);
    }
  }

  async #obtainAnswer(id: string, open: {client: ProbeClient; requestId: string; field: string; env: string}, call: () => Promise<unknown>): Promise<ObtainResult> {
    let answer: z.infer<typeof ObtainAnswerSchema>;
    try {
      const parsed = ObtainAnswerSchema.safeParse(toolResultJson(await call() as never));
      if (!parsed.success) { this.#closeObtain(id); return {status: 'failed', message: 'The printer MCP answered in a way Counterpart can’t read. Update it in Settings → Printers.'}; }
      answer = parsed.data;
    } catch {
      this.#closeObtain(id);
      return {status: 'failed', message: 'The printer MCP stopped answering. Start the approval again.'};
    }
    if (answer.status === 'pending' && answer.request_id) {
      open.requestId = answer.request_id;
      return {session: id, status: 'pending', message: answer.message, ...(webUrl(answer.approve_url) ? {approveUrl: webUrl(answer.approve_url)} : {})};
    }
    this.#closeObtain(id);
    // Only the field's own variable reaches the form; anything else the MCP returns is dropped.
    const value = answer.status === 'approved' ? answer.env?.[open.env] : undefined;
    if (value !== undefined && /^[\x20-\x26\x28-\x7e]{1,512}$/.test(value)) return {status: 'approved', message: answer.message, value};
    return {status: 'failed', message: answer.status === 'approved' ? 'The printer MCP approved it but sent no usable value. Enter it in the form.' : answer.message};
  }

  #closeObtain(id: string): void {
    const open = this.#obtaining.get(id);
    if (!open) return;
    this.#obtaining.delete(id);
    clearTimeout(open.timer);
    void open.client.close().catch(() => undefined);
  }

  /** Every approval's MCP copy stops (the companion is shutting down). */
  closeObtaining(): void { for (const id of [...this.#obtaining.keys()]) this.#closeObtain(id); }

  /**
   * `printers.add`: a found folder runs where it is (its own `.env`); a printer from the form gets
   * `<appPrinters>/profiles/<id>/.env` (0600) with exactly the MCP's variables. Either way it joins Counterpart's list
   * and the catalog reads it as a destination.
   */
  async add(input: PrinterForm): Promise<{id: string; destinationId?: string; sameAs?: string}> {
    const id = newProfileId();
    let profile: SavedProfile;
    let created: string | undefined;
    if ('folder' in input) {
      const read = await this.#folder(input.folder, {budgetMs: ADD_SETUP_BUDGET_MS});
      if (this.#runs().some(path => path === read.found.dir || path.startsWith(read.found.dir + sep))
        || (await readProfiles(this.#profilesPath)).profiles.some(item => item.process.cwd === read.found.dir))
        throw new PrinterSetupError('conflict', 'That printer MCP is one of your printers already.');
      // Its .env gains only what its MCP needs and lacks, and only the model; nothing there is changed.
      const model = await this.#completeEnv(read.found.dir, read.found.package, input.model, join(read.found.dir, 'dist', 'index.js'));
      profile = {id, name: this.#nameFor(await this.#cachedOptions(), read.printerType, model ?? read.model, read.host, read.found.package), backend: read.found.package,
        process: {command: this.#node, args: [join(read.found.dir, 'dist', 'index.js')], cwd: read.found.dir}, owned: false,
        ...((model ?? read.model) && /^[a-z0-9]{1,16}$/.test(model ?? read.model!) ? {model: model ?? read.model!} : {})};
    } else {
      const entry = await this.#entry(input.backend);
      created = join(this.deps.env.appPrinters, 'profiles', id);
      await mkdir(created, {recursive: true, mode: 0o700});
      const {kind, setup} = await this.#kindForForm(input, {budgetMs: ADD_SETUP_BUDGET_MS});
      const env = envFor(input, kind, setup.slicer);
      await writeFile(join(created, '.env'), envFile(env), {mode: 0o600, flag: 'wx'});
      profile = {id, name: input.name ?? this.#nameFor(await this.#cachedOptions(), input.printerType, input.model, input.host, input.backend), backend: input.backend,
        process: {command: this.#node, args: [entry], cwd: created}, owned: true, ...(input.model ? {model: input.model} : {})};
    }
    try { await changeProfiles(this.#profilesPath, state => { state.profiles.push(profile); }); }
    catch (error) { if (created) await rm(created, {recursive: true, force: true}); throw error; }
    await this.deps.reload?.();
    const catalog = this.deps.catalog?.();
    if (!catalog) return {id};
    const destinationId = catalog.canonical(id);
    if (!destinationId) {
      // The catalog lists only printers with an address: this one would never show.
      await this.#forget(id);
      throw new PrinterSetupError('invalid', 'Counterpart couldn’t find the printer’s address in that MCP’s settings.');
    }
    return {id, destinationId, ...(destinationId !== id ? {sameAs: destinationId} : {})};
  }

  /** Every `.env` another MCP config on this Mac runs with: the catalog's profiles (their working directory, or the one
   * an ssh-wrapped command `cd`s into), folders found on the Mac, and Counterpart's own profiles. */
  async #envPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const {id, config} of this.deps.configs()) for (const profile of [config, this.deps.effective?.(id, config) ?? config]) {
      if (profile.process.cwd) paths.push(join(profile.process.cwd, '.env'));
      const via = resolveMcpInstall(profile, this.deps.env).via?.cwd;
      if (via && isAbsolute(via)) paths.push(join(via, '.env'));
    }
    for (const folder of await (this.deps.folders?.() ?? Promise.resolve([])).catch(() => [])) if (folder.hasEnv) paths.push(join(folder.dir, '.env'));
    for (const profile of (await readProfiles(this.#profilesPath)).profiles) paths.push(join(profile.process.cwd, '.env'));
    return [...new Set(paths)];
  }

  /**
   * The authenticated route to offer an mcp-3D-printer-server Bambu printer whose `.env` sets none: the one another
   * MCP config uses for the same serial (`bambu_network` with a bridge command), and only when this copy reads it.
   */
  async #route(backend: PrinterBackend, env: Record<string, string | undefined>, entry: string | undefined, dir: string): Promise<RouteSource | undefined> {
    if (backend !== 'mcp-3d-printer-server' || env.PRINTER_TYPE?.trim().toLowerCase() !== 'bambu'
      || (env.BAMBU_DEFAULT_CONNECTION_MODE?.trim() && (env.BAMBU_DEFAULT_CONNECTION_MODE.trim() !== 'bambu_network' || env.BAMBU_NETWORK_CONFIG_DIR?.trim()))) return undefined;
    if (!(await readsRouteSettings(entry))) return undefined;
    const own = join(dir, '.env');
    const route = await findBambuRoute(env.BAMBU_SERIAL ?? env.BAMBU_PRINTER_SERIAL, (await this.#envPaths()).filter(path => path !== own));
    if (!route || (env.BAMBU_DEFAULT_CONNECTION_MODE?.trim() && env.BAMBU_NETWORK_BRIDGE_COMMAND?.trim() !== route.values.BAMBU_NETWORK_BRIDGE_COMMAND)) return undefined;
    if (route.values.BAMBU_NETWORK_CONFIG_DIR || env.BAMBU_NETWORK_CONFIG_DIR?.trim()) return route;
    // Ask the source MCP for its own resolved default; do not guess which auth folder a launcher mounts.
    const sourceDir = dirname(route.from);
    let source: PrinterHandoffConfig | undefined;
    for (const {id, config} of this.deps.configs()) {
      const effective = this.deps.effective?.(id, config) ?? config;
      if ([config, effective].some(profile => profile.process.cwd === sourceDir || resolveMcpInstall(profile, this.deps.env).via?.cwd === sourceDir)) {
        source = effective; break;
      }
    }
    if (!source) {
      const found = await packageAt(sourceDir);
      if (found) source = {backend: found.package, process: {command: this.#node, args: [join(sourceDir, 'dist', 'index.js')], cwd: sourceDir}};
    }
    if (!source) return route;
    const client = this.deps.client?.(source) ?? new PrinterMcpClient(source);
    try {
      const catalog = await client.connect(AbortSignal.timeout(10_000));
      if (!catalog.tools.some(tool => tool.name === 'bambu_network_bridge_status')) return route;
      const result = toolResultJson(await client.callTool('bambu_network_bridge_status', {}, {timeoutMs: 10_000}));
      const configDir = result?.configDir;
      if (typeof configDir !== 'string' || !isAbsolute(configDir) || configDir.length > 4096 || /[\u0000-\u001f]/.test(configDir)) return route;
      const line = `BAMBU_NETWORK_CONFIG_DIR=${JSON.stringify(configDir)}`;
      if (parseEnv(line).BAMBU_NETWORK_CONFIG_DIR !== configDir) return route;
      return {from: route.from, values: {...route.values, BAMBU_NETWORK_CONFIG_DIR: configDir}, lines: {...route.lines, BAMBU_NETWORK_CONFIG_DIR: line}};
    } catch { return route; }
    finally { await client.close().catch(() => undefined); }
  }

  /**
   * Appends what an MCP's `.env` needs and lacks: the model (`model`, the person's choice, else the serial number's)
   * and, for an mcp-3D-printer-server Bambu printer, the authenticated route another MCP uses for it (its lines
   * verbatim). Other lines, values, order and the file's mode stay as they are; nothing already there is rewritten.
   * Returns the model the printer has now (written or already there). A model nobody can tell is refused.
   */
  async #completeEnv(dir: string, backend: PrinterBackend, model: string | undefined, entry: string | undefined): Promise<string | undefined> {
    const path = join(dir, '.env');
    const text = await readFile(path, 'utf8');
    const env = parseEnv(text);
    // The fields of the copy that reads this .env: the printer's own MCP.
    const kind = kindFor(entry ? await this.#setupFor(backend, entry) : await this.#setupOf(backend), env);
    if (!kind) throw new PrinterSetupError('unavailable', `Update ${this.#label(backend)} in Settings → Printers so Counterpart can complete this printer’s settings.`);
    const route = await this.#route(backend, env, entry, dir);
    const gap = settingsGap(backend, env, kind, {...(model ? {model} : {}), ...(route ? {route} : {})});
    if (gap.missing.includes('BAMBU_NETWORK_CONFIG_DIR')) {
      throw new PrinterSetupError('unavailable', 'Counterpart couldn’t read the FULU session folder from the source MCP. Set BAMBU_NETWORK_CONFIG_DIR in that MCP’s .env, then try again.');
    }
    const modelField = field(kind, 'model');
    const existing = modelField ? names(modelField).map(key => env[key]?.trim()).find(value => !!value)?.toLowerCase() : undefined;
    if (modelField && gap.missing.includes(modelField.env) && !gap.fill[modelField.env]) {
      if (model !== undefined) throw new PrinterSetupError('invalid', `${this.#label(backend)} doesn’t know that model.`);
      throw new PrinterSetupError('invalid', 'Choose the printer’s model: its MCP needs it, and Counterpart couldn’t tell it from the printer.');
    }
    const lines = Object.values(gap.lines);
    if (lines.length) await appendFile(path, `${text.length && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    return (modelField ? gap.fill[modelField.env] : undefined) ?? existing;
  }

  /**
   * `printers.completeSettings`: a printer added in Counterpart whose `.env` lacks the model its MCP needs gets it
   * (as on Add), the profile records it, and its MCP restarts so it reads the file again.
   */
  async completeSettings(destinationId: string, model?: string): Promise<{destinationId: string; model?: string}> {
    const saved = await readProfiles(this.#profilesPath);
    const profile = saved.profiles.find(item => item.id === destinationId)
      ?? saved.profiles.find(item => this.deps.catalog?.()?.canonical(item.id) === destinationId);
    if (!profile) throw new PrinterSetupError('not-found', 'Only printers added in Counterpart can be completed here.');
    const listed = this.deps.catalog?.()?.canonical(profile.id) ?? profile.id;
    if (await this.deps.busy?.(listed)) throw new PrinterSetupError('conflict', 'This printer is printing. Complete its settings when the print finishes.');
    const now = await this.#completeEnv(profile.process.cwd, profile.backend, model, profile.process.args.find(arg => isAbsolute(arg) && arg.endsWith('.js')));
    if (now && /^[a-z0-9]{1,16}$/.test(now) && profile.model !== now)
      await changeProfiles(this.#profilesPath, state => { const item = state.profiles.find(entry => entry.id === profile.id); if (item) item.model = now; });
    await this.deps.reload?.();
    await this.deps.restart?.(profile.id).catch(() => undefined);
    return {destinationId: this.deps.catalog?.()?.canonical(profile.id) ?? profile.id, ...(now ? {model: now} : {})};
  }

  async #forget(id: string): Promise<SavedProfile | undefined> {
    const removed = await changeProfiles(this.#profilesPath, state => {
      const index = state.profiles.findIndex(item => item.id === id);
      return index < 0 ? undefined : state.profiles.splice(index, 1)[0];
    });
    const root = join(this.deps.env.appPrinters, 'profiles') + sep;
    // Only a folder Counterpart made, and only inside its own profiles folder.
    if (removed?.owned && normalize(removed.process.cwd).startsWith(root)) await rm(removed.process.cwd, {recursive: true, force: true});
    await this.deps.reload?.();
    return removed;
  }

  /** `printers.remove`: a printer added in Counterpart, between prints. Its folder goes only if Counterpart made it. */
  async remove(destinationId: string): Promise<{removed: true}> {
    const saved = await readProfiles(this.#profilesPath);
    if (!saved.profiles.some(item => item.id === destinationId)) throw new PrinterSetupError('not-found', 'Only printers added in Counterpart can be removed here.');
    const listed = this.deps.catalog?.()?.canonical(destinationId) ?? destinationId;
    if (await this.deps.busy?.(listed)) throw new PrinterSetupError('conflict', 'This printer is printing. Remove it when the print finishes.');
    await this.#forget(destinationId);
    return {removed: true};
  }

  /** `printers.chooseMcp`: which MCP a printer reachable through both uses. Counterpart's own preference, kept with its list. */
  async chooseMcp(destinationId: string, backend: PrinterBackend): Promise<{destinationId: string}> {
    const catalog = this.deps.catalog?.();
    const listed = catalog?.canonical(destinationId);
    const destination = catalog?.destinations.find(item => item.id === listed);
    const key = listed ? catalog!.choiceKey(listed) : undefined;
    if (!catalog || !destination || !key) throw new PrinterSetupError('not-found', 'That printer is no longer there.');
    if (!destination.mcps?.some(item => item.backend === backend)) throw new PrinterSetupError('invalid', 'That MCP doesn’t reach this printer.');
    if (destination.backend === backend) return {destinationId: destination.id};
    const ids = [...new Set([destinationId, destination.id, ...(destination.mcps?.map(item => item.destinationId) ?? [])])];
    const busy = () => new PrinterSetupError('conflict', 'This printer is printing. Change its MCP when the print finishes.');
    if (this.deps.gate && !this.deps.gate.beginUpdate(ids)) throw busy();
    try {
      if (await this.deps.busy?.(destination.id)) throw busy();
      await changeProfiles(this.#profilesPath, state => { state.choices[key] = backend; });
      await this.deps.reload?.();
      return {destinationId: catalog.canonical(destinationId) ?? destination.id};
    } finally { this.deps.gate?.endUpdate(ids); }
  }
}
