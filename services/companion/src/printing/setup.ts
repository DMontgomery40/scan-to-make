import {appendFile, mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {dirname, isAbsolute, join, normalize, sep} from 'node:path';
import {parseEnv} from 'node:util';
import {z} from 'zod';
import {PrinterMcpClient, toolResultJson, type PrinterBackend, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {appInstall, appMcpId, installedVersion, mcpIdFor, resolveMcpInstall, type InstallEnvironment, type ResolvedMcpInstall} from './mcp-install.js';
import type {McpUpdate} from './mcp-updates.js';
import type {PrinterCatalog} from '../objects/printers.js';
import {discoverBambu, discoverBonjour, modelFromSerial, BAMBU_SERIAL_MODELS, BONJOUR_TYPES, type BambuAdvert, type BonjourService} from './discovery.js';
import type {PrintGate} from './print-gate.js';
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

/** A built copy of either MCP in a folder of its own (a clone or an unpacked package), found on this Mac. */
export interface FoundFolder {dir: string; package: PrinterBackend; version?: string; hasEnv: boolean}

// Folders macOS guards with a privacy prompt (and iCloud): a background agent reading them would raise one.
const SKIP = new Set(['Library', 'Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Applications', 'node_modules', 'Public']);
const MAX_ENTRIES = 400;

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
  uses: {destinationId: string; printerId: string; printer: string; mcpId: string; kind: string; path?: string; version?: string; canMove: boolean}[];
}

/**
 * The choices Add printer… offers, from the MCPs themselves: mcp-3D-printer-server's PRINTER_TYPE values (its
 * PrinterFactory) and each MCP's own model list (VALID_BAMBU_MODELS in each server's src/index.ts).
 */
export const PRINTER_TYPES = [
  {printerType: 'bambu', label: 'Bambu Lab', backends: ['bambu-printer-mcp', 'mcp-3d-printer-server'], serial: true,
    secret: {label: 'Access code', hint: 'On the printer: Settings → WLAN → Access Code', required: true}},
  {printerType: 'octoprint', label: 'OctoPrint', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'API key', hint: 'In OctoPrint: Settings → API', required: true}},
  {printerType: 'klipper', label: 'Klipper (Moonraker)', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'API key', hint: 'Only if Moonraker asks for one', required: false}},
  {printerType: 'prusa', label: 'Prusa (PrusaLink)', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'API key', hint: 'The key PrusaLink shows in its settings', required: true}},
  {printerType: 'creality', label: 'Creality', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'API key', hint: 'Only if your printer asks for one', required: false}},
  {printerType: 'duet', label: 'Duet', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'Password', hint: 'Only if your Duet has one set', required: false}},
  {printerType: 'repetier', label: 'Repetier', backends: ['mcp-3d-printer-server'], serial: false,
    secret: {label: 'API key', hint: 'The key Repetier-Server shows in its settings', required: true}},
] as const;
const MODEL_LABELS: Record<string, string> = {p1s: 'P1S', p1p: 'P1P', p2s: 'P2S', x1c: 'X1C', x1e: 'X1E', a1: 'A1', a1mini: 'A1 mini',
  h2d: 'H2D', h2dpro: 'H2D Pro', h2s: 'H2S', h2c: 'H2C', x2d: 'X2D'};
export const MODELS: Record<PrinterBackend, string[]> = {
  'bambu-printer-mcp': ['p1s', 'p1p', 'p2s', 'x1c', 'x1e', 'a1', 'a1mini', 'h2d', 'h2dpro', 'h2s', 'h2c', 'x2d'],
  'mcp-3d-printer-server': ['p1s', 'p1p', 'x1c', 'x1e', 'a1', 'a1mini', 'h2d'],
};
export function setupOptions() {
  return {types: PRINTER_TYPES.map(type => ({...type, backends: [...type.backends]})), serialModels: {...BAMBU_SERIAL_MODELS},
    models: Object.fromEntries(Object.entries(MODELS).map(([backend, models]) => [backend, models.map(value => ({value, label: MODEL_LABELS[value] ?? value.toUpperCase()}))]))};
}

// KAN-163's checks: a literal host (no scheme, path, port or credentials), a Bambu serial, a port.
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/** A value written to the `.env` in single quotes: one line, printable, no quote. */
const envValue = z.string().max(512).regex(/^[\x20-\x26\x28-\x7e]*$/);
const printerTypes = PRINTER_TYPES.map(type => type.printerType) as [string, ...string[]];
export const PrinterFormSchema = z.union([
  /** A found folder; `model` fills a missing BAMBU_MODEL when Counterpart couldn't tell it. */
  z.strictObject({folder: z.string().min(2).max(4096), model: z.string().regex(/^[a-z0-9]{1,16}$/).optional()}),
  z.strictObject({
    backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']),
    printerType: z.enum(printerTypes),
    host: z.string().trim().max(254).transform(value => value.replace(/\.$/, '')).pipe(z.string().min(1).max(253).regex(HOST)),
    port: z.string().regex(/^[1-9][0-9]{0,4}$/).refine(value => Number(value) <= 65535).optional(),
    serial: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/).optional(),
    model: z.string().max(16).optional(),
    secret: envValue.optional(),
    name: z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  }).superRefine((form, context) => {
    if (form.backend === 'bambu-printer-mcp' && form.printerType !== 'bambu') context.addIssue({code: 'custom', message: 'bambu-printer-mcp is for Bambu Lab printers.'});
    if (form.printerType === 'bambu' && (!form.serial || !form.model)) context.addIssue({code: 'custom', message: 'A Bambu printer needs its serial number and model.'});
    if (form.model !== undefined && !MODELS[form.backend].includes(form.model)) context.addIssue({code: 'custom', message: 'That MCP doesn’t know that model.'});
  }),
]);
export type PrinterForm = z.infer<typeof PrinterFormSchema>;
type FormFields = Exclude<PrinterForm, {folder: string}>;

/** Exactly the MCP's own variables (bambu-printer-mcp's manifest env; mcp-3D-printer-server's .env.example). */
export function envFor(form: FormFields): Record<string, string> {
  const env: Record<string, string> = {MCP_TRANSPORT: 'stdio', PRINTER_HOST: form.host};
  const bambu = () => ({BAMBU_SERIAL: (form.serial ?? '').toUpperCase(), BAMBU_MODEL: form.model ?? '', ...(form.secret ? {BAMBU_TOKEN: form.secret} : {})});
  if (form.backend === 'bambu-printer-mcp') return {...env, ...bambu()};
  return {...env, PRINTER_TYPE: form.printerType, ...(form.port ? {PRINTER_PORT: form.port} : {}),
    ...(form.printerType === 'bambu' ? bambu() : form.secret ? {API_KEY: form.secret} : {})};
}
export const envFile = (env: Record<string, string>) =>
  '# Written by Counterpart (Settings → Printers → Add printer…). The printer MCP reads it; edit it here for anything advanced.\n' +
  Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';

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
  latestVersion?(pkg: PrinterBackend, options?: {view?: boolean}): string | undefined;
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
  ssdp?(): Promise<{state: 'complete' | 'unavailable'; printers: BambuAdvert[]}>;
  bonjour?(): Promise<BonjourService[]>;
  /** Starts an MCP for Check (a fresh process, closed after; never a printer's shared session). */
  client?(config: PrinterHandoffConfig): ProbeClient;
}

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

  /** `printers.mcps`: both packages, always, with every copy of each the companion can see. */
  async mcps(): Promise<{packages: McpPackageView[]; options: ReturnType<typeof setupOptions>}> {
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
    return {packages: MCP_PACKAGES.map(item => {
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
      const uses = this.deps.configs().filter(entry => entry.config.backend === item.package).map(({id, config}) => {
        const effective = this.deps.effective?.(id, config) ?? config;
        const install = resolveMcpInstall(effective, env);
        const path = install.type === 'checkout' ? install.dir : install.type === 'app' || install.type === 'global' ? install.prefix
          : install.type === 'npx' ? install.spec : undefined;
        const version = install.type === 'npx' ? undefined : installedVersion(install, env);
        const printer = catalog?.destinations.find(destination => destination.id === catalog.canonical(id))?.name ?? id;
        return {destinationId: id, printerId: catalog?.canonical(id) ?? id, printer, mcpId: mcpIdFor(resolveMcpInstall(config, env), config), kind: install.type,
          ...(path ? {path} : {}), ...(version ? {version} : {}), canMove: install.type !== 'app' || install.prefix !== own.prefix};
      });
      const latestVersion = this.deps.latestVersion?.(item.package, {view: true});
      return {...item, installed: !!selected, ...(version ? {version} : {}), ...(latestVersion ? {latestVersion} : {}),
        appMcpId: appMcpId(item.package, env), uses, ...(appCopy ? {appCopy} : {}), installs: selected ? [selected, ...found.filter(install => install !== selected)] : found};
    }), options: setupOptions()};
  }

  /** `printers.installMcp`: Download installs only that package, only when no copy of it is on this Mac. */
  async installMcp(pkg: PrinterBackend): Promise<{installed: true; package: PrinterBackend} | {update: McpUpdate}> {
    const view = (await this.mcps()).packages.find(item => item.package === pkg);
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
  async #folder(dir: string) {
    if (!isAbsolute(dir) || normalize(dir) !== dir) throw new PrinterSetupError('invalid', 'That folder isn’t a printer MCP Counterpart found.');
    const found = (await (this.deps.folders?.() ?? Promise.resolve([]))).find(folder => folder.dir === dir);
    if (!found?.hasEnv) throw new PrinterSetupError('invalid', 'That folder isn’t a printer MCP with its settings.');
    const env = await readFile(join(dir, '.env'), 'utf8').then(text => text.length <= 256 * 1024 ? parseEnv(text) : {}, () => ({} as Record<string, string | undefined>));
    const bambu = found.package === 'bambu-printer-mcp';
    const pick = (...keys: string[]) => keys.map(key => env[key]?.trim()).find(value => !!value);
    const host = pick(...(bambu ? ['BAMBU_PRINTER_HOST'] : []), 'PRINTER_HOST');
    const printerType = bambu ? 'bambu' : (pick('PRINTER_TYPE')?.toLowerCase() ?? 'octoprint');
    const serial = pick(...(bambu ? ['BAMBU_PRINTER_SERIAL'] : []), 'BAMBU_SERIAL');
    const model = pick(...(bambu ? ['BAMBU_PRINTER_MODEL'] : []), 'BAMBU_MODEL')?.toLowerCase();
    return {found, env, host: host && HOST.test(host.replace(/^https?:\/\//, '').replace(/[:/].*$/, '')) ? host.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') : undefined,
      printerType, ...(serial && /^[A-Za-z0-9]{1,64}$/.test(serial) ? {serial: serial.toUpperCase()} : {}),
      ...(model && /^[a-z0-9]{1,16}$/.test(model) ? {model} : {})};
  }

  #nameFor(printerType: string, model?: string, host?: string, backend?: PrinterBackend): string {
    const type = PRINTER_TYPES.find(item => item.printerType === printerType);
    const base = printerType === 'bambu' ? `Bambu Lab ${model ? MODEL_LABELS[model] ?? model.toUpperCase() : 'printer'}` : `${type?.label ?? 'Printer'}${host ? ` at ${host}` : ''}`;
    return (backend === 'mcp-3d-printer-server' && printerType === 'bambu' ? `${base} via mcp-3D-printer-server` : base).slice(0, 120);
  }

  /** `printers.discover`: configured MCP folders on this Mac, Bambu printers (SSDP) and other printers (Bonjour). About 4 s. */
  async discover(): Promise<{found: SetupCandidate[]; network: 'complete' | 'unavailable'; options: ReturnType<typeof setupOptions>}> {
    const [folders, bambu, bonjour, saved] = await Promise.all([
      (this.deps.folders?.() ?? Promise.resolve([])).catch(() => []),
      (this.deps.ssdp ?? (() => discoverBambu()))().catch(() => ({state: 'unavailable' as const, printers: []})),
      (this.deps.bonjour ?? (() => discoverBonjour()))().catch(() => []),
      readProfiles(this.#profilesPath),
    ]);
    const catalog = this.deps.catalog?.();
    const known = new Set((catalog?.entries() ?? []).map(entry => catalog!.choiceKey(entry.id)).filter((key): key is string => !!key));
    const runs = [...this.#runs(), ...saved.profiles.map(profile => profile.process.cwd)];
    const found: SetupCandidate[] = [];
    for (const folder of folders) {
      if (!folder.hasEnv || runs.some(path => path === folder.dir || path.startsWith(folder.dir + sep))) continue;
      const read = await this.#folder(folder.dir).catch(() => undefined);
      if (!read?.host) continue;
      // A model its .env lacks: the printer's own announcement (DevModel) first, else its serial number.
      const announced = bambu.printers.find(printer => read.serial && printer.serial.toUpperCase() === read.serial)?.model;
      const route = await this.#route(folder.package, read.env, join(folder.dir, 'dist', 'index.js'), folder.dir);
      const gap = settingsGap(folder.package, read.env, {...(announced ? {model: announced} : {}), modelFromSerial, ...(route ? {route} : {})});
      const model = read.model ?? gap.fill.BAMBU_MODEL;
      found.push({id: `folder:${folder.dir}`, source: 'folder', name: this.#nameFor(read.printerType, model, read.host, folder.package),
        backend: folder.package, printerType: read.printerType, host: read.host, ...(read.serial ? {serial: read.serial} : {}),
        ...(model ? {model} : {}), folder: folder.dir, added: false,
        ...(gap.missing.length || Object.keys(gap.fill).length ? {missing: gap.missing, fill: gap.fill} : {})});
    }
    for (const printer of bambu.printers) {
      const model = printer.model ?? modelFromSerial(printer.serial);
      found.push({id: `ssdp:${printer.serial}`, source: 'ssdp', name: printer.name.slice(0, 120), backend: 'bambu-printer-mcp', printerType: 'bambu', host: printer.host,
        serial: printer.serial, ...(model ? {model} : {}), added: known.has(`serial:${printer.serial.toUpperCase()}`)});
    }
    for (const service of bonjour) {
      const printerType = BONJOUR_TYPES[service.type] ?? 'octoprint';
      found.push({id: `bonjour:${service.host}:${service.port}`, source: 'bonjour', name: (service.name || this.#nameFor(printerType, undefined, service.host)).slice(0, 120),
        backend: 'mcp-3d-printer-server', printerType, host: service.host, port: service.port, added: known.has(`host:${service.host.toLowerCase()}:${service.port}`)});
    }
    return {found, network: bambu.state, options: setupOptions()};
  }

  /** The MCP an added printer runs: the app's own copy, else another copy of that package on this Mac. */
  async #entry(pkg: PrinterBackend): Promise<string> {
    const own = appInstall(pkg, this.deps.env).entry!;
    if (this.deps.env.exists(own)) return own;
    const view = (await this.mcps()).packages.find(item => item.package === pkg)!;
    for (const install of view.installs) {
      const entry = localEntry(pkg, install, this.deps.env);
      if (entry) return entry;
    }
    throw new PrinterSetupError('unavailable', `Download ${this.#label(pkg)} first, then add the printer.`);
  }

  async #config(input: PrinterForm): Promise<PrinterHandoffConfig> {
    if ('folder' in input) {
      const {found} = await this.#folder(input.folder);
      return {backend: found.package, process: {command: this.#node, args: [join(found.dir, 'dist', 'index.js')], cwd: found.dir}};
    }
    // Check runs the MCP with these settings and no .env (its working directory has none); nothing is written.
    const cwd = join(this.deps.env.appPrinters, 'profiles');
    await mkdir(cwd, {recursive: true, mode: 0o700});
    return {backend: input.backend, process: {command: this.#node, args: [await this.#entry(input.backend)], cwd, env: envFor(input)}};
  }

  /**
   * `printers.check`: starts the chosen MCP with these settings and asks get_printer_status, then (a Bambu printer,
   * when the MCP has it) camera_snapshot. Never a print, heating, motion or settings tool. Only this projection is
   * returned: no telemetry, MCP error text or credentials (KAN-163's check).
   */
  async check(input: PrinterForm): Promise<CheckResult> {
    const config = await this.#config(input);
    const bambuKind = config.backend === 'bambu-printer-mcp' || ('printerType' in input && input.printerType === 'bambu')
      || ('folder' in input && (await this.#folder(input.folder)).printerType === 'bambu');
    const result: CheckResult = {reached: false, camera: 'not-supported'};
    const client = this.deps.client?.(config) ?? new PrinterMcpClient(config);
    try {
      const catalog = await client.connect(AbortSignal.timeout(25_000));
      const status = toolResultJson(await client.callTool('get_printer_status', {}, {timeoutMs: 20_000}));
      if (config.backend === 'bambu-printer-mcp') {
        result.reached = status.connected === true && status.status !== 'error';
        const model = String(status.model ?? '').toLowerCase().replace(/^bambu lab\s+|\s+/g, '');
        if (MODELS['bambu-printer-mcp'].includes(model)) result.model = model;
      } else result.reached = status.error === undefined && status.status !== 'error' && status.connected !== false && Object.keys(status).length > 0;
      if (result.reached && bambuKind && catalog.tools.some(tool => tool.name === 'camera_snapshot')) {
        result.camera = 'failed';
        try {
          const frame = toolResultJson(await client.callTool('camera_snapshot', {timeout_ms: 8000}, {timeoutMs: 12_000}));
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
      const read = await this.#folder(input.folder);
      if (this.#runs().some(path => path === read.found.dir || path.startsWith(read.found.dir + sep))
        || (await readProfiles(this.#profilesPath)).profiles.some(item => item.process.cwd === read.found.dir))
        throw new PrinterSetupError('conflict', 'That printer MCP is one of your printers already.');
      // Its .env gains only what its MCP needs and lacks, and only the model; nothing there is changed.
      const model = await this.#completeEnv(read.found.dir, read.found.package, input.model, join(read.found.dir, 'dist', 'index.js'));
      profile = {id, name: this.#nameFor(read.printerType, model ?? read.model, read.host, read.found.package), backend: read.found.package,
        process: {command: this.#node, args: [join(read.found.dir, 'dist', 'index.js')], cwd: read.found.dir}, owned: false,
        ...((model ?? read.model) && /^[a-z0-9]{1,16}$/.test(model ?? read.model!) ? {model: model ?? read.model!} : {})};
    } else {
      const entry = await this.#entry(input.backend);
      created = join(this.deps.env.appPrinters, 'profiles', id);
      await mkdir(created, {recursive: true, mode: 0o700});
      await writeFile(join(created, '.env'), envFile(envFor(input)), {mode: 0o600, flag: 'wx'});
      profile = {id, name: input.name ?? this.#nameFor(input.printerType, input.model, input.host, input.backend), backend: input.backend,
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
    const route = await this.#route(backend, env, entry, dir);
    const gap = settingsGap(backend, env, {...(model ? {model} : {}), modelFromSerial, ...(route ? {route} : {})});
    if (gap.missing.includes('BAMBU_NETWORK_CONFIG_DIR')) {
      throw new PrinterSetupError('unavailable', 'Counterpart couldn’t read the FULU session folder from the source MCP. Set BAMBU_NETWORK_CONFIG_DIR in that MCP’s .env, then try again.');
    }
    const existing = (env.BAMBU_MODEL ?? env.BAMBU_PRINTER_MODEL)?.trim().toLowerCase();
    if (gap.missing.includes('BAMBU_MODEL')) {
      const value = gap.fill.BAMBU_MODEL;
      if (!value) throw new PrinterSetupError('invalid', 'Choose the printer’s model: its MCP needs it, and Counterpart couldn’t tell it from the printer.');
      if (!MODELS[backend].includes(value)) throw new PrinterSetupError('invalid', `${this.#label(backend)} doesn’t know that model.`);
    }
    const lines = Object.values(gap.lines);
    if (lines.length) await appendFile(path, `${text.length && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    return gap.fill.BAMBU_MODEL ?? existing;
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
