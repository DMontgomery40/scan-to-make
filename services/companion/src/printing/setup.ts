import {readdir, readFile, stat} from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {PrinterBackend, PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {appMcpId, installedVersion, resolveMcpInstall, type InstallEnvironment, type ResolvedMcpInstall} from './mcp-install.js';
import type {McpUpdate} from './mcp-updates.js';

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
  /** The newest version among the copies found. */
  version?: string;
  latestVersion?: string;
  /** The id Download's mcp.update.* events carry (the app's own copy). */
  appMcpId: string;
  installs: PackageInstall[];
}

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
}

export class PrinterSetupError extends Error {
  constructor(readonly code: 'not-found' | 'unavailable' | 'invalid' | 'conflict', message: string) { super(message); this.name = 'PrinterSetupError'; }
}

const newest = (versions: string[]) => versions.sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))[0];

export class PrinterSetup {
  readonly deps: PrinterSetupDeps;
  constructor(deps: PrinterSetupDeps) { this.deps = deps; }

  #list(path: string): string[] {
    if (this.deps.list) return this.deps.list(path);
    try { return readdirSync(path); } catch { return []; }
  }

  /** `printers.mcps`: both packages, always, with every copy of each the companion can see. */
  async mcps(): Promise<{packages: McpPackageView[]}> {
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
      const version = newest(found.map(install => install.version).filter((value): value is string => !!value));
      const latestVersion = this.deps.latestVersion?.(item.package, {view: true});
      return {...item, installed: found.length > 0, ...(version ? {version} : {}), ...(latestVersion ? {latestVersion} : {}),
        appMcpId: appMcpId(item.package, env), installs: found};
    })};
  }

  /** `printers.installMcp`: Download installs only that package, only when no copy of it is on this Mac. */
  async installMcp(pkg: PrinterBackend): Promise<{installed: true; package: PrinterBackend} | {update: McpUpdate}> {
    const view = (await this.mcps()).packages.find(item => item.package === pkg);
    if (!view) throw new PrinterSetupError('not-found', 'Counterpart doesn’t know that MCP.');
    if (view.installed) return {installed: true, package: pkg};
    if (!this.deps.download) throw new PrinterSetupError('unavailable', 'Counterpart can’t install printer MCPs on this Mac yet.');
    return {update: await this.deps.download(pkg)};
  }
}
