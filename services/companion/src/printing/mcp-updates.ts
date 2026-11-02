import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import type {PrinterHandoffConfig, PrinterSession} from '@scan-to-make/printer-handoff';
import {newerVersion} from './directory.js';
import {findNpm, installedVersion, mcpIdFor, resolveMcpInstall, type InstallEnvironment, type McpInstall, type ResolvedMcpInstall} from './mcp-install.js';

export const MCP_UPDATE_TIMEOUT_MS = 10 * 60_000;
/** PRD §8.10: the latest version is checked once a day, and when Settings opens (a list read after an hour). */
export const LATEST_EVERY_MS = 24 * 60 * 60_000;
export const LATEST_ON_VIEW_MS = 60 * 60_000;
export const WAIT_POLL_MS = 15_000;
export const LOG_TAIL_BYTES = 4096;

export type McpUpdateStateName = 'started' | 'waiting' | 'current' | 'unresolved';
export interface McpUpdate {mcpId: string; state: McpUpdateStateName; fromVersion?: string; toVersion?: string; found?: string}
export type McpUpdateEventType = 'mcp.update.started' | 'mcp.update.waiting' | 'mcp.update.done' | 'mcp.update.failed';
export interface McpUpdateEvent {type: McpUpdateEventType; data: {mcpId: string; fromVersion?: string; toVersion?: string; log?: string}; package: string}
export type CommandRunner = (command: string, args: string[], options: {cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number}) => Promise<{code: number; output: string}>;

export class McpUpdateError extends Error {
  constructor(readonly code: 'not-found' | 'unavailable', message: string) { super(message); this.name = 'McpUpdateError'; }
}

/** Process overrides the companion applies to a profile after an npx or fresh-copy update. Keyed by mcpId. */
export class McpOverrides {
  readonly #path: string;
  #state?: Record<string, {command: string; args: string[]; env?: Record<string, string>; cwd?: string}>;
  constructor(path: string) { this.#path = path; }
  async load() {
    if (this.#state) return this.#state;
    try { this.#state = JSON.parse(await readFile(this.#path, 'utf8')); } catch { this.#state = {}; }
    if (!this.#state || typeof this.#state !== 'object') this.#state = {};
    return this.#state;
  }
  async get(mcpId: string) { return (await this.load())[mcpId]; }
  async set(mcpId: string, value: {command: string; args: string[]; env?: Record<string, string>; cwd?: string} | undefined) {
    const state = await this.load();
    if (value) state[mcpId] = value; else delete state[mcpId];
    await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1) + '\n', {mode: 0o600});
    await rename(temporary, this.#path);
  }
  /** The profile as the companion runs it. */
  apply(config: PrinterHandoffConfig, override: {command: string; args: string[]; env?: Record<string, string>; cwd?: string} | undefined): PrinterHandoffConfig {
    if (!override) return config;
    const {cwd: _cwd, ...process} = config.process;
    return {...config, process: {...process, command: override.command, args: override.args,
      env: {...config.process.env, ...override.env}, ...(override.cwd ?? config.process.cwd ? {cwd: override.cwd ?? config.process.cwd} : {})}};
  }
}

export const runCommand: CommandRunner = (command, args, options) => new Promise(resolve => {
  execFile(command, args, {cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
    const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
    resolve({code, output: `${stdout ?? ''}${stderr ?? ''}${error && code !== 0 && !stderr ? String(error.message) : ''}`});
  });
});

const tail = (text: string) => { const bytes = Buffer.from(text); return bytes.length <= LOG_TAIL_BYTES ? text : bytes.subarray(bytes.length - LOG_TAIL_BYTES).toString('utf8').replace(/^�+/, ''); };
const newer = newerVersion;

export interface McpUpdaterDeps {
  /** Every destination with the profile as configured (before overrides). */
  destinations(): {id: string; config: PrinterHandoffConfig}[];
  env: InstallEnvironment;
  overrides: McpOverrides;
  session(destinationId: string): PrinterSession | undefined;
  /** A print being prepared or monitored on this printer. */
  busy(destinationId: string): Promise<boolean>;
  /** The version the running MCP reports (capabilities.server.version), when it has connected. */
  runningVersion(destinationId: string): string | undefined;
  emit?(event: McpUpdateEvent): Promise<void>;
  run?: CommandRunner;
  /** The companion's own node, which runs a fresh copy. */
  node: string;
  now?: () => number;
  path?: string;
  /** How often a waiting update looks again (WAIT_POLL_MS). */
  waitPollMs?: number;
}

/**
 * PRD §8.10: Update actually updates the installation the companion runs, between jobs,
 * then restarts that MCP's sessions so the new version (and its capabilities) are used.
 */
export class McpUpdater {
  readonly #deps: McpUpdaterDeps;
  readonly #run: CommandRunner;
  readonly #now: () => number;
  readonly #latest = new Map<string, {atMs: number; version?: string; pending?: Promise<string | undefined>}>();
  readonly #active = new Map<string, McpUpdate>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(deps: McpUpdaterDeps) { this.#deps = deps; this.#run = deps.run ?? runCommand; this.#now = deps.now ?? Date.now; }

  /** The install behind a destination, and its mcpId (shared by every printer on that install). */
  install(destinationId: string): {mcpId: string; install: ResolvedMcpInstall; config: PrinterHandoffConfig} | undefined {
    const entry = this.#deps.destinations().find(item => item.id === destinationId);
    if (!entry) return undefined;
    const install = resolveMcpInstall(entry.config, this.#deps.env);
    return {mcpId: mcpIdFor(install, entry.config), install, config: entry.config};
  }
  mcpId(destinationId: string): string | undefined { return this.install(destinationId)?.mcpId; }
  #members(mcpId: string) {
    return this.#deps.destinations().map(entry => ({...entry, ...this.install(entry.id)!})).filter(entry => entry.mcpId === mcpId);
  }

  /** The latest published version, as last checked; a view checks again after an hour, otherwise once a day. */
  latestVersion(pkg: string, options: {view?: boolean} = {}): string | undefined {
    const known = this.#latest.get(pkg);
    if (!known || this.#now() - known.atMs >= (options.view ? LATEST_ON_VIEW_MS : LATEST_EVERY_MS)) void this.checkLatest(pkg).catch(() => undefined);
    return known?.version;
  }
  /** `npm view <pkg> version`. */
  async checkLatest(pkg: string): Promise<string | undefined> {
    const known = this.#latest.get(pkg);
    if (known?.pending) return known.pending;
    const pending = (async () => {
      const npm = findNpm(undefined, this.#deps.env, this.#deps.path);
      if (!npm) return undefined;
      const {code, output} = await this.#run(npm, ['view', pkg, 'version'], {env: this.#env(npm), timeoutMs: 60_000});
      const version = output.trim().split('\n').at(-1)?.trim();
      return code === 0 && version && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
    })();
    this.#latest.set(pkg, {atMs: known?.atMs ?? 0, ...(known?.version ? {version: known.version} : {}), pending});
    try {
      const version = await pending;
      this.#latest.set(pkg, {atMs: this.#now(), ...(version ?? known?.version ? {version: version ?? known?.version} : {})});
      return version;
    } catch (error) { this.#latest.set(pkg, {atMs: this.#now(), ...(known?.version ? {version: known.version} : {})}); throw error; }
  }
  /** The daily check for every package in use. */
  start(): void {
    const all = () => { for (const pkg of new Set(this.#deps.destinations().map(entry => entry.config.backend))) void this.checkLatest(pkg).catch(() => undefined); };
    all();
    this.#timer = setInterval(all, LATEST_EVERY_MS);
    this.#timer.unref?.();
  }
  close(): void { if (this.#timer) clearInterval(this.#timer); }

  /** Applies saved overrides (npx version, fresh copy) to the sessions, before they first connect. */
  async applyOverrides(): Promise<void> {
    for (const entry of this.#deps.destinations()) {
      const mcpId = this.mcpId(entry.id), override = mcpId ? await this.#deps.overrides.get(mcpId) : undefined;
      if (override) await this.#deps.session(entry.id)?.restart(this.#deps.overrides.apply(entry.config, override)).catch(() => undefined);
    }
  }

  /** `printers.updateMcp` / `POST /v1/printers/mcp/<mcpId>/update`. */
  async update(mcpId: string, options: {fresh?: boolean} = {}): Promise<McpUpdate> {
    const running = this.#active.get(mcpId);
    if (running) return {...running};
    const members = this.#members(mcpId);
    if (!members.length) throw new McpUpdateError('not-found', 'No printer uses that MCP.');
    const first = members[0]!, pkg = first.config.backend;
    const fromVersion = installedVersion(first.install, this.#deps.env) ?? members.map(member => this.#deps.runningVersion(member.id)).find(Boolean);
    if (first.install.type === 'unresolved' && !options.fresh) return {mcpId, state: 'unresolved', found: first.install.found, ...(fromVersion ? {fromVersion} : {})};
    const latest = await this.checkLatest(pkg).catch(() => undefined);
    if (!latest) throw new McpUpdateError('unavailable', `Counterpart couldn't ask npm for the latest ${pkg}. Check this Mac's internet connection, or install Node.js so npm is there.`);
    if (!options.fresh && fromVersion && !newer(latest, fromVersion)) return {mcpId, state: 'current', fromVersion, toVersion: latest};
    const update: McpUpdate = {mcpId, state: 'started', ...(fromVersion ? {fromVersion} : {}), toVersion: latest};
    const busy = (await Promise.all(members.map(member => this.#deps.busy(member.id)))).some(Boolean);
    if (busy) {
      update.state = 'waiting';
      this.#active.set(mcpId, update);
      await this.#emit('mcp.update.waiting', pkg, update);
      void this.#waitThenRun(mcpId, options, latest);
      return {...update};
    }
    this.#active.set(mcpId, update);
    void this.#perform(mcpId, options, latest);
    return {...update};
  }

  async #waitThenRun(mcpId: string, options: {fresh?: boolean}, latest: string): Promise<void> {
    for (;;) {
      await new Promise(resolve => { const timer = setTimeout(resolve, this.#deps.waitPollMs ?? WAIT_POLL_MS); timer.unref?.(); });
      const members = this.#members(mcpId);
      if (!(await Promise.all(members.map(member => this.#deps.busy(member.id)))).some(Boolean)) break;
    }
    const update = this.#active.get(mcpId);
    if (update) update.state = 'started';
    await this.#perform(mcpId, options, latest);
  }

  async #perform(mcpId: string, options: {fresh?: boolean}, latest: string): Promise<void> {
    const update = this.#active.get(mcpId)!;
    const members = this.#members(mcpId), first = members[0]!, pkg = first.config.backend;
    const previous = await this.#deps.overrides.get(mcpId);
    let log = '';
    try {
      await this.#emit('mcp.update.started', pkg, update);
      const install: McpInstall = options.fresh ? this.#freshInstall(first.config) : first.install;
      const steps = this.#steps(install, latest);
      for (const step of steps) {
        if ('fail' in step) throw Object.assign(new Error(step.fail), {sentence: step.fail});
        const result = await this.#run(step.command, step.args, {cwd: step.cwd, env: step.env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
        log += `$ ${[step.command, ...step.args].join(' ')}\n${result.output}\n`;
        if (result.code !== 0) throw new Error(`${step.label} failed`);
      }
      // npx: run the new version; fresh: run the app's own copy, started the way the profile started its MCP.
      if (install.type === 'npx') await this.#deps.overrides.set(mcpId, {command: first.config.process.command,
        args: (first.config.process.args ?? []).map(arg => arg === install.spec ? `${pkg}@${latest}` : arg)});
      if (options.fresh && install.type === 'app') {
        const via = first.install.via;
        await this.#deps.overrides.set(mcpId, {command: this.#deps.node, args: [install.entry!],
          ...(via?.env ? {env: via.env} : {}), ...(via?.cwd ? {cwd: via.cwd} : {})});
      }
      const override = await this.#deps.overrides.get(mcpId);
      for (const member of members) await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, override));
      const session = this.#deps.session(first.id);
      const catalog = await session?.connect();
      const toVersion = catalog?.server.version ?? latest;
      this.#active.delete(mcpId);
      await this.#emit('mcp.update.done', pkg, {...update, toVersion});
    } catch (error) {
      // The previous version stays in use: npm and git leave it intact, and an override is put back.
      await this.#deps.overrides.set(mcpId, previous).catch(() => undefined);
      for (const member of members) await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, previous)).catch(() => undefined);
      this.#active.delete(mcpId);
      const sentence = (error as {sentence?: string}).sentence;
      await this.#emit('mcp.update.failed', pkg, update, tail(sentence ? `${log}${sentence}\n` : log || String((error as Error).message)));
    }
  }

  #freshInstall(config: PrinterHandoffConfig): McpInstall & {type: 'app'} {
    const pkg = config.backend, prefix = join(this.#deps.env.appPrinters, pkg === 'bambu-printer-mcp' ? 'bambu' : 'generic');
    return {type: 'app', pkg, prefix, node: this.#deps.node, entry: join(prefix, 'lib', 'node_modules', pkg, 'dist', 'index.js')};
  }

  #env(npm: string, node?: string): NodeJS.ProcessEnv {
    const dirs = [...(node ? [dirname(node)] : []), dirname(npm)];
    return {...process.env, PATH: [...dirs, this.#deps.path ?? process.env.PATH ?? '/usr/bin:/bin'].join(':')};
  }

  /** What Update runs for each install type (PRD §8.10's table). */
  #steps(install: McpInstall, latest: string): ({label: string; command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv} | {fail: string})[] {
    const env = this.#deps.env;
    if (install.type === 'unresolved') return [{fail: `Counterpart can't tell how this copy is installed: ${install.found}.`}];
    if (install.type === 'npx') return [];
    if (install.type === 'global' || install.type === 'app') {
      const own = join(install.prefix, 'bin');
      const node = install.type === 'global' && env.exists(join(own, 'node')) ? join(own, 'node') : install.node;
      const npm = (install.type === 'global' && env.exists(join(own, 'npm')) ? join(own, 'npm') : undefined) ?? findNpm(node, env, this.#deps.path);
      if (!npm) return [{fail: 'Counterpart needs npm to update this copy, and there is none on this Mac. Install Node.js, then try again.'}];
      const cli = join(dirname(env.realpath(npm)), 'npm-cli.js');
      // The installation's own node runs npm, so native parts are built for the node that runs the MCP.
      const [command, args] = node && env.exists(cli) ? [node, [cli]] : [npm, []];
      return [{label: 'npm install', command, args: [...args, 'install', '--global', '--prefix', install.prefix, `${install.pkg}@${latest}`], env: this.#env(npm, node)}];
    }
    const npm = findNpm(install.node, env, this.#deps.path);
    if (!npm) return [{fail: 'Counterpart needs npm to build this copy, and there is none on this Mac. Install Node.js, then try again.'}];
    const git = env.exists('/usr/bin/git') ? '/usr/bin/git' : 'git';
    return [
      {label: 'git status', command: '/bin/sh', args: ['-c', `test -z "$(${git} -C "$1" status --porcelain)" || { echo "This copy has local changes"; exit 3; }`, 'sh', install.dir], env: process.env},
      {label: 'git pull', command: git, args: ['-C', install.dir, 'pull', '--ff-only'], env: process.env},
      {label: 'npm ci', command: npm, args: ['ci'], cwd: install.dir, env: this.#env(npm, install.node)},
      {label: 'npm run build', command: npm, args: ['run', 'build'], cwd: install.dir, env: this.#env(npm, install.node)},
    ];
  }

  async #emit(type: McpUpdateEventType, pkg: string, update: McpUpdate, log?: string): Promise<void> {
    await this.#deps.emit?.({type, package: pkg, data: {mcpId: update.mcpId, ...(update.fromVersion ? {fromVersion: update.fromVersion} : {}),
      ...(update.toVersion ? {toVersion: update.toVersion} : {}), ...(log ? {log} : {})}}).catch(() => undefined);
  }
}
