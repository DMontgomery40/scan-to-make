import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, rm as fsRm, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
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
/** How long Update waits for npm before answering (the Mac app's control requests give up after 10 s). */
export const LOOKUP_TIMEOUT_MS = 7000;
/** Leave room inside the Mac's 10 s RPC deadline after the bounded npm lookup. */
export const ADMISSION_CHECK_MS = 250;

export type McpUpdateStateName = 'started' | 'waiting' | 'current' | 'unresolved';
export interface McpUpdate {mcpId: string; state: McpUpdateStateName; fromVersion?: string; toVersion?: string; found?: string}
export type McpUpdateEventType = 'mcp.update.started' | 'mcp.update.waiting' | 'mcp.update.done' | 'mcp.update.failed';
export interface McpUpdateEvent {type: McpUpdateEventType; data: {mcpId: string; fromVersion?: string; toVersion?: string; log?: string}; package: string;
  /** mcp.update.failed when the previous version couldn't be put back: what to do, in place of "still in use". */
  reason?: string}
export type CommandRunner = (command: string, args: string[], options: {cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number}) => Promise<{code: number; output: string}>;

export class McpUpdateError extends Error {
  constructor(readonly code: 'not-found' | 'unavailable', message: string) { super(message); this.name = 'McpUpdateError'; }
}

/** Process overrides the companion applies to a profile after an npx or fresh-copy update. Keyed by destination. */
type Override = {command: string; args: string[]; env?: Record<string, string>; cwd?: string; source?: string};
/** The profile an override was made from: a changed profile drops its override. */
export function profileFingerprint(config: PrinterHandoffConfig): string {
  return createHash('sha256').update(JSON.stringify([config.backend, config.process.command, config.process.args ?? [], config.process.env ?? {}, config.process.cwd ?? ''])).digest('hex').slice(0, 24);
}
export class McpOverrides {
  readonly #path: string;
  #state?: Record<string, Override>;
  #writes: Promise<void> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  async load() {
    if (this.#state) return this.#state;
    try { this.#state = JSON.parse(await readFile(this.#path, 'utf8')); } catch { this.#state = {}; }
    if (!this.#state || typeof this.#state !== 'object') this.#state = {};
    return this.#state;
  }
  async get(id: string) { return (await this.load())[id]; }
  /** After load(): the override for this destination, only while its profile is the one it was made from. */
  peek(id: string, config?: PrinterHandoffConfig): Override | undefined {
    const value = this.#state?.[id];
    return value && config && value.source && value.source !== profileFingerprint(config) ? undefined : value;
  }
  /** One change at a time, each written in full before the next: updates of different installs never undo each other on disk. */
  set(id: string, value: Override | undefined, config?: PrinterHandoffConfig): Promise<void> {
    const change = this.#writes.then(async () => {
      const state = await this.load();
      if (value) state[id] = {...value, ...(config ? {source: profileFingerprint(config)} : {})}; else delete state[id];
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 1) + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
    });
    this.#writes = change.catch(() => undefined);
    return change;
  }
  /** The profile as the companion runs it. */
  apply(config: PrinterHandoffConfig, override: Override | undefined): PrinterHandoffConfig {
    if (!override || (override.source && override.source !== profileFingerprint(config))) return config;
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

const RESTORE_FAILED = "The previous version couldn't be put back, so these printers may not start their MCP. Install a fresh copy from Update.";
const BUSY_UNKNOWN = (pkg: string) => `Counterpart couldn't check whether a print is running, so it didn't update ${pkg}. Try Update again.`;
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
  lookupTimeoutMs?: number;
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
  /** Installs (by what they run) an update is changing now: a second update of the same files waits. */
  readonly #changing = new Map<string, string>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(deps: McpUpdaterDeps) {
    this.#deps = deps; this.#run = deps.run ?? runCommand; this.#now = deps.now ?? Date.now; this.#fs = deps.fs ?? realFs;
  }

  /**
   * The install behind a destination. `mcpId` comes from the profile as configured, so it never changes;
   * the install is the one actually run, after an npx or fresh-copy override.
   */
  install(destinationId: string): {mcpId: string; install: ResolvedMcpInstall; config: PrinterHandoffConfig; effective: PrinterHandoffConfig; runs: string} | undefined {
    const entry = this.#deps.destinations().find(item => item.id === destinationId);
    if (!entry) return undefined;
    const mcpId = mcpIdFor(resolveMcpInstall(entry.config, this.#deps.env), entry.config);
    const effective = this.#deps.overrides.apply(entry.config, this.#deps.overrides.peek(destinationId, entry.config));
    const install = resolveMcpInstall(effective, this.#deps.env);
    // What actually runs: two profiles moved to the same fresh copy share it, whatever their ids.
    return {mcpId, install, config: entry.config, effective, runs: mcpIdFor(install, effective)};
  }
  mcpId(destinationId: string): string | undefined { return this.install(destinationId)?.mcpId; }
  /** Every printer on this install: by its id, and by the files it actually runs (so shared files are locked and restarted together). */
  #members(mcpId: string, options: {fresh?: boolean} = {}) {
    const all = this.#deps.destinations().map(entry => ({...entry, ...this.install(entry.id)!}));
    const runs = new Set(all.filter(entry => entry.mcpId === mcpId).map(entry => entry.runs));
    // A fresh copy replaces the app's own copy: every printer already running it is part of the update.
    const target = all.find(entry => entry.mcpId === mcpId);
    if (options.fresh && target) { const fresh = this.#freshInstall(target.config); runs.add(mcpIdFor(fresh, target.config)); }
    return all.filter(entry => entry.mcpId === mcpId || runs.has(entry.runs)).sort((a, b) => Number(b.mcpId === mcpId) - Number(a.mcpId === mcpId));
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
      // npm may add notices on stderr after the version: take the line that is a version.
      const version = output.split('\n').map(line => line.trim()).find(line => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(line));
      return code === 0 ? version : undefined;
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
  /** A destination's profile as the companion runs it: with the override an update left, while that profile is unchanged. */
  effective(destinationId: string, config: PrinterHandoffConfig): PrinterHandoffConfig {
    return this.#deps.overrides.apply(config, this.#deps.overrides.peek(destinationId, config));
  }
  async applyOverrides(): Promise<void> {
    await this.#deps.overrides.load();
    for (const entry of this.#deps.destinations()) {
      const found = this.install(entry.id);
      if (found && this.#deps.overrides.peek(entry.id, entry.config)) await this.#deps.session(entry.id)?.restart(found.effective).catch(() => undefined);
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
    // The oldest version any of its printers runs (npx profiles may pin different ones). One whose version
    // isn't known yet (an npx range that hasn't connected) can't be called current.
    const known = members.filter(member => member.mcpId === mcpId)
      .map(member => installedVersion(member.install, this.#deps.env) ?? this.#deps.runningVersion(member.id));
    const versions = known.filter((version): version is string => !!version);
    const everyKnown = versions.length === known.length;
    const fromVersion = everyKnown ? versions.sort((a, b) => newer(a, b) ? 1 : newer(b, a) ? -1 : 0)[0] : undefined;
    const found = first.install.type === 'unresolved' ? first.install.found
      // npx inside a wrapper: the version is in a command Counterpart doesn't own.
      : first.install.type === 'npx' && first.install.via ? `${first.install.spec} run through ssh, whose command Counterpart can't change` : undefined;
    if (found && !options.fresh) return {mcpId, state: 'unresolved', found, ...(fromVersion ? {fromVersion} : {})};
    // Answer within the Mac app's 10 s: a recent check is used; a slow npm is asked again on the next tap (it keeps running).
    const cached = this.#latest.get(pkg);
    const looking = cached?.version && this.#now() - cached.atMs < LATEST_ON_VIEW_MS ? Promise.resolve(cached.version) : this.checkLatest(pkg).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const latest = await Promise.race([looking, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), this.#deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS); })])
      .finally(() => clearTimeout(timer));
    if (latest === 'slow') throw new McpUpdateError('unavailable', `npm is slow to answer for ${pkg}. Try Update again in a moment.`);
    if (!latest) throw new McpUpdateError('unavailable', `Counterpart couldn't ask npm for the latest ${pkg}. Check this Mac's internet connection, or install Node.js so npm is there.`);
    if (!options.fresh && fromVersion && !newer(latest, fromVersion)) return {mcpId, state: 'current', fromVersion, toVersion: latest};
    const update: McpUpdate = {mcpId, state: 'started', ...(fromVersion ? {fromVersion} : {}), toVersion: latest};
    this.#active.set(mcpId, update);
    const claiming = this.#claim(mcpId, options);
    const pending = Symbol('checking printers');
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const claimed = await Promise.race([claiming, new Promise<typeof pending>(resolve => {
        admissionTimer = setTimeout(() => resolve(pending), ADMISSION_CHECK_MS);
      })]);
      if (claimed === pending) {
        // The update is admitted, and #claim retains PrintGate while its printer reads finish.
        // Report later failures through the existing event channel, not a timed-out request that
        // falsely suggests the user should tap Update again while work is still running.
        void claiming.then(value => this.#finishAdmission(mcpId, options, latest, pkg, update, value)).catch(async () => {
          this.#active.delete(mcpId);
          await this.#emit('mcp.update.failed', pkg, update, BUSY_UNKNOWN(pkg));
        });
      } else await this.#finishAdmission(mcpId, options, latest, pkg, update, claimed);
      return update;
    } catch {
      this.#active.delete(mcpId);
      throw new McpUpdateError('unavailable', BUSY_UNKNOWN(pkg));
    } finally { clearTimeout(admissionTimer); }
  }

  async #finishAdmission(mcpId: string, options: {fresh?: boolean}, latest: string, pkg: string, update: McpUpdate, claimed: boolean): Promise<void> {
    if (claimed) { void this.#perform(mcpId, options, latest); return; }
    update.state = 'waiting';
    await this.#emit('mcp.update.waiting', pkg, update);
    void this.#waitThenRun(mcpId, options, latest, pkg);
  }

  /** Marks the install's printers as updating (no print can start), then makes sure none is printing. */
  async #claim(mcpId: string, options: {fresh?: boolean} = {}): Promise<boolean> {
    const members = this.#members(mcpId, options), ids = members.map(member => member.id), gate = this.#deps.gate;
    // The files this update writes, reserved for it alone: a fresh copy reserves the app's own copy.
    const target = members.find(member => member.mcpId === mcpId);
    const keys = [...new Set([...members.filter(member => member.mcpId === mcpId).map(member => member.runs),
      ...(options.fresh && target ? [mcpIdFor(this.#freshInstall(target.config), target.config)] : [])])];
    if (keys.some(key => this.#changing.has(key) && this.#changing.get(key) !== mcpId)) return false;
    if (gate && !gate.beginUpdate(ids)) return false;
    let busy: boolean;
    // A check that fails can't say no print is running: the printers are released and the caller says so.
    try { busy = (await Promise.all(ids.map(id => this.#deps.busy(id)))).some(Boolean); }
    catch (error) { gate?.endUpdate(ids); throw error; }
    if (busy || keys.some(key => this.#changing.has(key) && this.#changing.get(key) !== mcpId)) { gate?.endUpdate(ids); return false; }
    for (const key of keys) this.#changing.set(key, mcpId);
    return true;
  }

  async #waitThenRun(mcpId: string, options: {fresh?: boolean}, latest: string, pkg: string): Promise<void> {
    try {
      do await new Promise(resolve => { const timer = setTimeout(resolve, this.#deps.waitPollMs ?? WAIT_POLL_MS); timer.unref?.(); });
      while (!await this.#claim(mcpId, options));
    } catch {
      // Nothing ran and nothing is held: the update ends, saying why.
      const update = this.#active.get(mcpId);
      this.#active.delete(mcpId);
      if (update) await this.#emit('mcp.update.failed', pkg, update, BUSY_UNKNOWN(pkg));
      return;
    }
    const update = this.#active.get(mcpId);
    if (update) update.state = 'started';
    await this.#perform(mcpId, options, latest);
  }

  async #perform(mcpId: string, options: {fresh?: boolean}, latest: string): Promise<void> {
    const update = this.#active.get(mcpId)!;
    const members = this.#members(mcpId, options), first = members[0]!, pkg = first.config.backend;
    const previous = new Map(members.map(member => [member.id, this.#deps.overrides.peek(member.id, member.config)]));
    const own = members.filter(member => member.mcpId === mcpId);
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
        // A step of putting the previous copy back that fails says so; `staging` (which holds `kept`) then stays.
        const restore = async (step: () => Promise<void>, sentence = `Counterpart couldn't put the previous version back. It is kept in ${kept}: move it to ${live}, or install a fresh copy.`) => {
          try { await step(); } catch { throw Object.assign(new Error('restore failed'), {restoreFailed: true, sentence}); }
          await this.#fs.rm(staging).catch(() => undefined);
        };
        if (hadLive) {
          await this.#fs.rename(live, kept);
          // From here the only copy of the previous version is `kept`: put it back before anything else can fail.
          undo = () => restore(() => this.#fs.rename(kept, live));
        }
        await this.#fs.rename(staged, live);
        undo = hadLive ? () => restore(async () => { await this.#fs.rm(live); await this.#fs.rename(kept, live); })
          : () => restore(() => this.#fs.rm(live), `Counterpart couldn't remove the new copy at ${live}. Remove it, or install a fresh copy.`);
      } else if (plan.kind === 'checkout') {
        await run('git status', '/bin/sh', ['-c', `test -z "$(${plan.git} -C "$1" status --porcelain)" || { echo "This copy has local changes"; exit 3; }`, 'sh', plan.dir], undefined, process.env);
        const head = (await run('git rev-parse', plan.git, ['-C', plan.dir, 'rev-parse', 'HEAD'], undefined, process.env)).trim().split('\n').at(-1)!;
        undo = async () => {
          // Back to the commit that was running, rebuilt; the checkout had no local changes to lose. Each step is
          // checked: if one fails, the failure says the previous version couldn't be put back, rather than claiming it.
          for (const [label, command, args, cwd, env] of [
            ['git reset', plan.git, ['-C', plan.dir, 'reset', '--hard', head], undefined, process.env],
            ['npm ci', plan.npm, ['ci'], plan.dir, plan.env],
            ['npm run build', plan.npm, ['run', 'build'], plan.dir, plan.env],
          ] as const) {
            const result = await this.#run(command, [...args], {...(cwd ? {cwd} : {}), env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
            log += `$ ${[command, ...args].join(' ')}\n${result.output}\n`;
            if (result.code !== 0) throw Object.assign(new Error(`${label} failed`), {restoreFailed: true,
              sentence: `Counterpart couldn't put the previous version back (${label} failed). Rebuild it in ${plan.dir} with npm ci && npm run build.`});
          }
        };
        await run('git pull', plan.git, ['-C', plan.dir, 'pull', '--ff-only'], undefined, process.env);
        await run('npm ci', plan.npm, ['ci'], plan.dir, plan.env);
        await run('npm run build', plan.npm, ['run', 'build'], plan.dir, plan.env);
      }
      // npx: each profile runs the new version; fresh: each runs the app's own copy, started the way its own profile
      // started its MCP (its own variables and directory: printers differ by them).
      for (const member of own) {
        if (member.install.type === 'npx') await this.#deps.overrides.set(member.id, {command: member.effective.process.command,
          args: (member.effective.process.args ?? []).map(arg => arg === (member.install as {spec?: string}).spec ? `${pkg}@${latest}` : arg)}, member.config);
        if (options.fresh && install.type === 'app') {
          const via = resolveMcpInstall(member.config, this.#deps.env).via;
          await this.#deps.overrides.set(member.id, {command: this.#deps.node, args: [install.entry!],
            ...(via?.env ? {env: via.env} : {}), ...(via?.cwd ? {cwd: via.cwd} : {})}, member.config);
        }
      }
      for (const member of members) await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, this.#deps.overrides.peek(member.id, member.config)));
      // Every printer on these files starts the new version before the previous one is removed: one that can't
      // start it puts everything back.
      let catalog: Awaited<ReturnType<PrinterSession['connect']>> | undefined;
      for (const member of members) {
        const connected = await this.#deps.session(member.id)?.connect();
        if (member.id === first.id) catalog = connected;
      }
      await finish?.().catch(() => undefined);
      this.#active.delete(mcpId);
      await this.#emit('mcp.update.done', pkg, {...update, toVersion: catalog?.server.version ?? latest});
    } catch (error) {
      // The previous version stays in use: the swap or checkout is undone, and an override is put back.
      let sentence = (error as {sentence?: string}).sentence, restoreFailed = false;
      await undo?.().catch((failure: {sentence?: string}) => {
        restoreFailed = true;
        sentence = [sentence, failure?.sentence ?? "Counterpart couldn't put the previous version back."].filter(Boolean).join(' ');
      });
      for (const member of members) {
        await this.#deps.overrides.set(member.id, previous.get(member.id), member.config).catch(() => undefined);
        await this.#deps.session(member.id)?.restart(this.#deps.overrides.apply(member.config, previous.get(member.id))).catch(() => undefined);
      }
      this.#active.delete(mcpId);
      await this.#emit('mcp.update.failed', pkg, update, tail(sentence ? `${log}${sentence}\n` : log || String((error as Error).message)),
        restoreFailed ? RESTORE_FAILED : undefined);
    } finally {
      this.#deps.gate?.endUpdate(members.map(member => member.id));
      for (const [key, owner] of [...this.#changing]) if (owner === mcpId) this.#changing.delete(key);
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

  async #emit(type: McpUpdateEventType, pkg: string, update: McpUpdate, log?: string, reason?: string): Promise<void> {
    if (!this.#deps.emit) return;
    await this.#deps.emit({type, package: pkg, data: {mcpId: update.mcpId, ...(update.fromVersion ? {fromVersion: update.fromVersion} : {}),
      ...(update.toVersion ? {toVersion: update.toVersion} : {}), ...(log ? {log} : {})}, ...(reason ? {reason} : {})}).catch(() => undefined);
  }
}
