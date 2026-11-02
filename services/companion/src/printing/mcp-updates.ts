import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, rm as fsRm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import type {PrinterHandoffConfig, PrinterSession} from '@scan-to-make/printer-handoff';
import {newerVersion} from './directory.js';
import type {PrintGate} from './print-gate.js';
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
  /** After load(): the override, without waiting. */
  peek(mcpId: string) { return this.#state?.[mcpId]; }
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
  /** Prints and updates on a printer exclude each other. */
  gate?: PrintGate;
  fs?: UpdateFs;
}

/** The file moves an npm update makes (a staged install swapped in). */
export interface UpdateFs {
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
const realFs: UpdateFs = {
  rename: (from, to) => rename(from, to),
  rm: path => fsRm(path, {recursive: true, force: true}),
  mkdir: async path => { await mkdir(path, {recursive: true}); },
};

/**
 * PRD §8.10: Update actually updates the installation the companion runs, between jobs,
 * then restarts that MCP's sessions so the new version (and its capabilities) are used.
 */
export class McpUpdater {
  readonly #deps: McpUpdaterDeps;
  readonly #run: CommandRunner;
  readonly #now: () => number;
  readonly #fs: UpdateFs;
  readonly #latest = new Map<string, {atMs: number; version?: string; pending?: Promise<string | undefined>}>();
  /** One operation per install: a second request gets the first one's answer and state. */
  readonly #active = new Map<string, McpUpdate>();
  readonly #starting = new Map<string, Promise<McpUpdate>>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(deps: McpUpdaterDeps) {
    this.#deps = deps; this.#run = deps.run ?? runCommand; this.#now = deps.now ?? Date.now; this.#fs = deps.fs ?? realFs;
  }

  /**
   * The install behind a destination. `mcpId` comes from the profile as configured, so it never changes;
   * the install is the one actually run, after an npx or fresh-copy override.
   */
  install(destinationId: string): {mcpId: string; install: ResolvedMcpInstall; config: PrinterHandoffConfig; effective: PrinterHandoffConfig} | undefined {
    const entry = this.#deps.destinations().find(item => item.id === destinationId);
    if (!entry) return undefined;
    const mcpId = mcpIdFor(resolveMcpInstall(entry.config, this.#deps.env), entry.config);
    const effective = this.#deps.overrides.apply(entry.config, this.#deps.overrides.peek(mcpId));
    return {mcpId, install: resolveMcpInstall(effective, this.#deps.env), config: entry.config, effective};
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

  /** Loads saved overrides (npx version, fresh copy) and gives the sessions them, before they first connect. */
  async applyOverrides(): Promise<void> {
    await this.#deps.overrides.load();
    for (const entry of this.#deps.destinations()) {
      const found = this.install(entry.id);
      if (found && this.#deps.overrides.peek(found.mcpId)) await this.#deps.session(entry.id)?.restart(found.effective).catch(() => undefined);
    }
  }

  /** `printers.updateMcp` / `POST /v1/printers/mcp/<mcpId>/update`. */
  update(mcpId: string, options: {fresh?: boolean} = {}): Promise<McpUpdate> {
    const running = this.#active.get(mcpId);
    if (running) return Promise.resolve({...running});
    // Reserved before the first await: two requests at once share one update.
    const starting = this.#starting.get(mcpId);
    if (starting) return starting.then(update => ({...update}));
    const work = this.#admit(mcpId, options).finally(() => this.#starting.delete(mcpId));
    this.#starting.set(mcpId, work);
    return work.then(update => ({...update}));
  }

  async #admit(mcpId: string, options: {fresh?: boolean}): Promise<McpUpdate> {
    const members = this.#members(mcpId);
    if (!members.length) throw new McpUpdateError('not-found', 'No printer uses that MCP.');
    const first = members[0]!, pkg = first.config.backend;
    const fromVersion = installedVersion(first.install, this.#deps.env) ?? members.map(member => this.#deps.runningVersion(member.id)).find(Boolean);
    const found = first.install.type === 'unresolved' ? first.install.found
      // npx inside a wrapper: the version is in a command Counterpart doesn't own.
      : first.install.type === 'npx' && first.install.via ? `${first.install.spec} run through ssh, whose command Counterpart can't change` : undefined;
    if (found && !options.fresh) return {mcpId, state: 'unresolved', found, ...(fromVersion ? {fromVersion} : {})};
    const latest = await this.checkLatest(pkg).catch(() => undefined);
    if (!latest) throw new McpUpdateError('unavailable', `Counterpart couldn't ask npm for the latest ${pkg}. Check this Mac's internet connection, or install Node.js so npm is there.`);
    if (!options.fresh && fromVersion && !newer(latest, fromVersion)) return {mcpId, state: 'current', fromVersion, toVersion: latest};
    const update: McpUpdate = {mcpId, state: 'started', ...(fromVersion ? {fromVersion} : {}), toVersion: latest};
    this.#active.set(mcpId, update);
    if (await this.#claim(mcpId)) { void this.#perform(mcpId, options, latest); return update; }
    update.state = 'waiting';
    await this.#emit('mcp.update.waiting', pkg, update);
    void this.#waitThenRun(mcpId, options, latest);
    return update;
  }

  /** Marks the install's printers as updating (no print can start), then makes sure none is printing. */
  async #claim(mcpId: string): Promise<boolean> {
    const ids = this.#members(mcpId).map(member => member.id), gate = this.#deps.gate;
    if (gate && !gate.beginUpdate(ids)) return false;
    const busy = (await Promise.all(ids.map(id => this.#deps.busy(id)))).some(Boolean);
    if (busy) { gate?.endUpdate(ids); return false; }
    return true;
  }

  async #waitThenRun(mcpId: string, options: {fresh?: boolean}, latest: string): Promise<void> {
    do await new Promise(resolve => { const timer = setTimeout(resolve, this.#deps.waitPollMs ?? WAIT_POLL_MS); timer.unref?.(); });
    while (!await this.#claim(mcpId));
    const update = this.#active.get(mcpId);
    if (update) update.state = 'started';
    await this.#perform(mcpId, options, latest);
  }

  async #perform(mcpId: string, options: {fresh?: boolean}, latest: string): Promise<void> {
    const update = this.#active.get(mcpId)!;
    const members = this.#members(mcpId), first = members[0]!, pkg = first.config.backend;
    const previous = this.#deps.overrides.peek(mcpId);
    let log = '';
    const run = async (label: string, command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv) => {
      const result = await this.#run(command, args, {cwd, env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
      log += `$ ${[command, ...args].join(' ')}\n${result.output}\n`;
      if (result.code !== 0) throw Object.assign(new Error(`${label} failed`), result.code === 3 && /local changes/.test(result.output) ? {sentence: 'This copy has local changes, so Counterpart left it as it is.'} : {});
      return result.output;
    };
    let undo: (() => Promise<void>) | undefined, finish: (() => Promise<void>) | undefined;
    try {
      await this.#emit('mcp.update.started', pkg, update);
      const install: McpInstall = options.fresh ? this.#freshInstall(first.config) : first.install;
      const plan = this.#plan(install, latest);
      if ('fail' in plan) throw Object.assign(new Error(plan.fail), {sentence: plan.fail});
      if (plan.kind === 'npm') {
        // Installed beside the live copy first, then swapped in, so a failed install never touches it.
        const staging = join(plan.prefix, `.counterpart-update-${randomUUID()}`);
        const live = join(plan.prefix, 'lib', 'node_modules', install.pkg), staged = join(staging, 'lib', 'node_modules', install.pkg), kept = join(staging, 'previous');
        finish = () => this.#fs.rm(staging);
        undo = finish;
        await run('npm install', plan.command, [...plan.args, 'install', '--global', '--prefix', staging, `${install.pkg}@${latest}`], undefined, plan.env);
        if (!this.#deps.env.exists(join(staged, 'package.json'))) throw new Error('npm install left no package');
        await this.#fs.mkdir(dirname(live));
        const hadLive = this.#deps.env.exists(live);
        if (hadLive) await this.#fs.rename(live, kept);
        await this.#fs.rename(staged, live);
        undo = async () => { await this.#fs.rm(live); if (hadLive) await this.#fs.rename(kept, live); await this.#fs.rm(staging); };
      } else if (plan.kind === 'checkout') {
        await run('git status', '/bin/sh', ['-c', `test -z "$(${plan.git} -C "$1" status --porcelain)" || { echo "This copy has local changes"; exit 3; }`, 'sh', plan.dir], undefined, process.env);
        const head = (await run('git rev-parse', plan.git, ['-C', plan.dir, 'rev-parse', 'HEAD'], undefined, process.env)).trim().split('\n').at(-1)!;
        undo = async () => {
          // Back to the commit that was running, rebuilt; the checkout had no local changes to lose.
          await this.#run(plan.git, ['-C', plan.dir, 'reset', '--hard', head], {env: process.env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
          await this.#run(plan.npm, ['ci'], {cwd: plan.dir, env: plan.env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
          await this.#run(plan.npm, ['run', 'build'], {cwd: plan.dir, env: plan.env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
        };
        await run('git pull', plan.git, ['-C', plan.dir, 'pull', '--ff-only'], undefined, process.env);
        await run('npm ci', plan.npm, ['ci'], plan.dir, plan.env);
        await run('npm run build', plan.npm, ['run', 'build'], plan.dir, plan.env);
      }
      // npx: run the new version; fresh: run the app's own copy, started the way the profile started its MCP.
      if (install.type === 'npx') await this.#deps.overrides.set(mcpId, {command: first.effective.process.command,
        args: (first.effective.process.args ?? []).map(arg => arg === install.spec ? `${pkg}@${latest}` : arg)});
      if (options.fresh && install.type === 'app') {
        const via = resolveMcpInstall(first.config, this.#deps.env).via;
        await this.#deps.overrides.set(mcpId, {command: this.#deps.node, args: [install.entry!],
          ...(via?.env ? {env: via.env} : {}), ...(via?.cwd ? {cwd: via.cwd} : {})});
      }
      const override = this.#deps.overrides.peek(mcpId);
      for (const member of members) await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, override));
      const catalog = await this.#deps.session(first.id)?.connect();
      await finish?.().catch(() => undefined);
      this.#active.delete(mcpId);
      await this.#emit('mcp.update.done', pkg, {...update, toVersion: catalog?.server.version ?? latest});
    } catch (error) {
      // The previous version stays in use: the swap or checkout is undone, and an override is put back.
      await undo?.().catch(() => undefined);
      await this.#deps.overrides.set(mcpId, previous).catch(() => undefined);
      for (const member of members) await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, previous)).catch(() => undefined);
      this.#active.delete(mcpId);
      const sentence = (error as {sentence?: string}).sentence;
      await this.#emit('mcp.update.failed', pkg, update, tail(sentence ? `${log}${sentence}\n` : log || String((error as Error).message)));
    } finally {
      this.#deps.gate?.endUpdate(members.map(member => member.id));
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
  #plan(install: McpInstall, _latest: string):
    | {kind: 'none'} | {fail: string}
    | {kind: 'npm'; prefix: string; command: string; args: string[]; env: NodeJS.ProcessEnv}
    | {kind: 'checkout'; dir: string; git: string; npm: string; env: NodeJS.ProcessEnv} {
    const env = this.#deps.env;
    if (install.type === 'unresolved') return {fail: `Counterpart can't tell how this copy is installed: ${install.found}.`};
    if (install.type === 'npx') return {kind: 'none'};
    if (install.type === 'global' || install.type === 'app') {
      const own = join(install.prefix, 'bin');
      const node = install.type === 'global' && env.exists(join(own, 'node')) ? join(own, 'node') : install.node;
      const npm = (install.type === 'global' && env.exists(join(own, 'npm')) ? join(own, 'npm') : undefined) ?? findNpm(node, env, this.#deps.path);
      if (!npm) return {fail: 'Counterpart needs npm to update this copy, and there is none on this Mac. Install Node.js, then try again.'};
      const cli = join(dirname(env.realpath(npm)), 'npm-cli.js');
      // The installation's own node runs npm, so native parts are built for the node that runs the MCP.
      const [command, args] = node && env.exists(cli) ? [node, [cli]] : [npm, []];
      return {kind: 'npm', prefix: install.prefix, command, args, env: this.#env(npm, node)};
    }
    const npm = findNpm(install.node, env, this.#deps.path);
    if (!npm) return {fail: 'Counterpart needs npm to build this copy, and there is none on this Mac. Install Node.js, then try again.'};
    return {kind: 'checkout', dir: install.dir, git: env.exists('/usr/bin/git') ? '/usr/bin/git' : 'git', npm, env: this.#env(npm, install.node)};
  }

  async #emit(type: McpUpdateEventType, pkg: string, update: McpUpdate, log?: string): Promise<void> {
    await this.#deps.emit?.({type, package: pkg, data: {mcpId: update.mcpId, ...(update.fromVersion ? {fromVersion: update.fromVersion} : {}),
      ...(update.toVersion ? {toVersion: update.toVersion} : {}), ...(log ? {log} : {})}}).catch(() => undefined);
  }
}
