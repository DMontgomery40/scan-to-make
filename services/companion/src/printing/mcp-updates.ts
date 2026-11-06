import {execFile, type ExecFileOptionsWithStringEncoding} from 'node:child_process';
import {mkdir, readFile, rename, rm as fsRm, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {printerBackendSchema, type PrinterHandoffConfig, type PrinterSession} from '@scan-to-make/printer-handoff';
import {newerVersion} from './directory.js';
import type {PrintGate} from './print-gate.js';
import type {PrinterCatalog} from '../objects/printers.js';
import {appInstall, appMcpId, findNpm, installedVersion, mcpIdFor, resolveMcpInstall, type InstallEnvironment, type McpInstall, type ResolvedMcpInstall} from './mcp-install.js';

export const MCP_UPDATE_TIMEOUT_MS = 10 * 60_000;
/** PRD §8.10: the latest version is checked once a day, and when Settings opens (a list read after an hour). */
export const LATEST_EVERY_MS = 24 * 60 * 60_000;
/** Settings opening asks npm again after this long: a release from minutes ago shows up the next time it opens. */
export const LATEST_ON_VIEW_MS = 5 * 60_000;
/** When npm is slow to answer Update, a check this recent stands in for it. */
const RECENT_ANSWER_MS = 60 * 60_000;
export const WAIT_POLL_MS = 15_000;
export const LOG_TAIL_BYTES = 4096;
/** How long Update waits for npm before answering (the Mac app's control requests give up after 10 s). */
export const LOOKUP_TIMEOUT_MS = 7000;
/** Leave room inside the Mac's 10 s RPC deadline after the bounded npm lookup. */
export const ADMISSION_CHECK_MS = 250;
/** How long Settings → Printers waits for npm's answer when it opens (printers.mcps answers within the Mac's 15 s). */
export const SETTINGS_WAIT_MS = 3000;
/** How long an updated MCP may take to restart and connect: what Add printer allows it to start (setup.ts). */
export const MCP_START_MS = 25_000;
/** How long the check that no print is running may take: a printer's report is read within 20 s (PrinterDirectory). */
export const BUSY_CHECK_MS = 30_000;
/** After a command's deadline, how long its process group gets to exit before the answer stops waiting for it. */
export const KILL_GRACE_MS = 5000;

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
  /** After load(): the saved override, whichever profile it was made from. */
  saved(id: string): Override | undefined { return this.#state?.[id]; }
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

/**
 * Runs a command to completion, or until its deadline. The command runs in its own process group, and at the deadline
 * the whole group is stopped: npm's install scripts are grandchildren that can hold its output open, and execFile only
 * answers when that output closes. The answer never waits past the deadline (or the command's own exit) plus
 * KILL_GRACE_MS, whatever the group does.
 */
export const runCommand: CommandRunner = (command, args, options) => new Promise(resolve => {
  let settled = false, partial = '';
  const finish = (value: {code: number; output: string}) => {
    if (settled) return;
    settled = true; clearTimeout(stop); clearTimeout(abandon); resolve(value);
  };
  // `detached` (passed through to spawn, which execFile's types leave out) makes the command its own process group.
  const spawnOptions = {cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', detached: true} as ExecFileOptionsWithStringEncoding;
  const child = execFile(command, args, spawnOptions, (error, stdout, stderr) => {
    const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
    finish({code, output: `${stdout ?? ''}${stderr ?? ''}${error && code !== 0 && !stderr ? String(error.message) : ''}`});
  });
  child.stdout?.on('data', chunk => { partial += chunk; });
  child.stderr?.on('data', chunk => { partial += chunk; });
  // Exited, but something it started still holds its output: answer with its own exit code once the grace is over.
  child.once('exit', code => {
    setTimeout(() => { if (settled) return; group('SIGKILL'); finish({code: code ?? 1, output: partial}); }, KILL_GRACE_MS).unref?.();
  });
  // Never after the answer: a finished group's id may belong to another process group by then.
  const group = (signal: NodeJS.Signals) => { try { if (child.pid && !settled) process.kill(-child.pid, signal); } catch { /* already gone */ } };
  const late = () => `${partial}${partial && !partial.endsWith('\n') ? '\n' : ''}${command.split('/').at(-1)} didn't finish within ${Math.round(options.timeoutMs / 1000)} seconds, so Counterpart stopped it.`;
  const stop = setTimeout(() => { group('SIGTERM'); setTimeout(() => group('SIGKILL'), KILL_GRACE_MS / 2).unref?.(); }, options.timeoutMs);
  const abandon = setTimeout(() => { group('SIGKILL'); finish({code: 124, output: late()}); }, options.timeoutMs + KILL_GRACE_MS);
});

/** `work`'s answer, or `late()`'s when it hasn't settled within `ms`. Work that settles afterwards is ignored. */
function within<T>(work: Promise<T>, ms: number, late: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  return Promise.race([work, new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => { Promise.resolve().then(late).then(resolve, reject); }, ms);
  })]).finally(() => clearTimeout(timer));
}

const RESTORE_FAILED = "The previous version couldn't be put back, so these printers may not start their MCP. Install a fresh copy from Update.";
const NO_PRINTERS = (pkg: string) => `No printer uses this MCP any more (it was removed), so Counterpart stopped updating ${pkg}.`;
const BUSY_UNKNOWN = (pkg: string) => `Counterpart couldn't check whether a print is running, so it didn't update ${pkg}. Try Update again.`;
const NOT_STARTED = (pkg: string, seconds: number) =>
  `The updated ${pkg} didn't start within ${seconds} seconds, so Counterpart put the previous version back. Try Update again.`;
const tail = (text: string) => { const bytes = Buffer.from(text); return bytes.length <= LOG_TAIL_BYTES ? text : bytes.subarray(bytes.length - LOG_TAIL_BYTES).toString('utf8').replace(/^�+/, ''); };
const newer = newerVersion;

export interface McpUpdaterDeps {
  /** Production catalog: includes profiles hidden behind the selected MCP, and the printer they share. */
  catalog?: () => Pick<PrinterCatalog, 'entries' | 'canonical'> | undefined;
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
  /** How long an updated MCP may take to restart and connect (MCP_START_MS). */
  startTimeoutMs?: number;
  /** How long the check that no print is running may take (BUSY_CHECK_MS). */
  busyTimeoutMs?: number;
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
  /** The package each update in #active installs (a request while it waits asks npm again for it). */
  readonly #packages = new Map<string, string>();
  /** Installs (by what they run) an update is changing now: a second update of the same files waits. */
  readonly #changing = new Map<string, string>();
  /** The printers #claim marked as updating, released by #perform even if they were removed meanwhile. */
  readonly #held = new Map<string, string[]>();
  #timer?: ReturnType<typeof setInterval>;
  constructor(deps: McpUpdaterDeps) {
    this.#deps = deps; this.#run = deps.run ?? runCommand; this.#now = deps.now ?? Date.now; this.#fs = deps.fs ?? realFs;
  }

  /**
   * The install behind a destination. `mcpId` comes from the profile as configured, so it never changes;
   * the install is the one actually run, after an npx or fresh-copy override.
   */
  install(destinationId: string): {mcpId: string; install: ResolvedMcpInstall; config: PrinterHandoffConfig; effective: PrinterHandoffConfig; runs: string} | undefined {
    const entry = this.#destinations().find(item => item.id === destinationId);
    if (!entry) return undefined;
    const mcpId = mcpIdFor(resolveMcpInstall(entry.config, this.#deps.env), entry.config);
    const effective = this.#deps.overrides.apply(entry.config, this.#override(destinationId, entry.config));
    const install = resolveMcpInstall(effective, this.#deps.env);
    // What actually runs: two profiles moved to the same fresh copy share it, whatever their ids.
    return {mcpId, install, config: entry.config, effective, runs: mcpIdFor(install, effective)};
  }
  #destinations() { return this.#deps.catalog?.()?.entries() ?? this.#deps.destinations(); }
  /**
   * The override a destination runs with. An npx pin made from an earlier profile is dropped with that profile, but a
   * Move to Counterpart's own copy never falls back: after the profile changes (its command, variables or directory),
   * it is made again from the new profile, so the printer keeps running Counterpart's copy and never the route the
   * profile wraps (an ssh forced command naming an older copy, Nov 6).
   */
  #override(destinationId: string, config: PrinterHandoffConfig): Override | undefined {
    const kept = this.#deps.overrides.peek(destinationId, config);
    if (kept) return kept;
    const saved = this.#deps.overrides.saved(destinationId);
    return saved && this.#movedToAppCopy(saved, config) ? this.#appCopyOverride(config) : undefined;
  }
  /** The override runs this package's own copy in Counterpart (what Move to Counterpart's updated copy saves). */
  #movedToAppCopy(override: Override, config: PrinterHandoffConfig): boolean {
    return override.args.includes(this.#freshInstall(config).entry!);
  }
  /** Counterpart's own copy, started the way this profile starts its MCP (its own variables and directory). */
  #appCopyOverride(config: PrinterHandoffConfig): Override {
    const via = resolveMcpInstall(config, this.#deps.env).via;
    return {command: this.#deps.node, args: [this.#freshInstall(config).entry!], ...(via?.env ? {env: via.env} : {}), ...(via?.cwd ? {cwd: via.cwd} : {})};
  }
  #gateIds(ids: string[]) {
    const catalog = this.#deps.catalog?.();
    return [...new Set(ids.flatMap(id => [id, catalog?.canonical(id) ?? id]))];
  }
  mcpId(destinationId: string): string | undefined { return this.install(destinationId)?.mcpId; }
  /** Every printer on this install: by its id, and by the files it actually runs (so shared files are locked and restarted together). */
  #members(mcpId: string, options: {fresh?: boolean} = {}) {
    const all = this.#destinations().map(entry => ({...entry, ...this.install(entry.id)!}));
    const runs = new Set(all.filter(entry => (entry.mcpId === mcpId || entry.runs === mcpId)).map(entry => entry.runs));
    // A fresh copy replaces the app's own copy: every printer already running it is part of the update.
    const target = all.find(entry => (entry.mcpId === mcpId || entry.runs === mcpId));
    if (options.fresh && target) { const fresh = this.#freshInstall(target.config); runs.add(mcpIdFor(fresh, target.config)); }
    return all.filter(entry => (entry.mcpId === mcpId || entry.runs === mcpId) || runs.has(entry.runs)).sort((a, b) => Number(b.mcpId === mcpId || b.runs === mcpId) - Number(a.mcpId === mcpId || a.runs === mcpId));
  }

  /** The latest published version, as last checked; a view checks again after an hour, otherwise once a day. */
  latestVersion(pkg: string, options: {view?: boolean} = {}): string | undefined {
    const known = this.#latest.get(pkg);
    if (!known || this.#now() - known.atMs >= (options.view ? LATEST_ON_VIEW_MS : LATEST_EVERY_MS)) void this.checkLatest(pkg).catch(() => undefined);
    return known?.version;
  }
  /**
   * As latestVersion, but Settings opening waits up to `waitMs` for the check it starts (or one already running), so a
   * version published since the last check shows on this visit, not the next one. A slow npm leaves the last answer.
   */
  async latestVersionSettled(pkg: string, options: {view?: boolean; waitMs?: number} = {}): Promise<string | undefined> {
    const known = this.latestVersion(pkg, options);
    const pending = this.#latest.get(pkg)?.pending;
    if (!pending) return known;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([pending.catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), options.waitMs ?? SETTINGS_WAIT_MS); })])
      .finally(() => clearTimeout(timer));
    return answer ?? this.#latest.get(pkg)?.version ?? known;
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
    const all = () => { for (const pkg of new Set(this.#destinations().map(entry => entry.config.backend))) void this.checkLatest(pkg).catch(() => undefined); };
    all();
    this.#timer = setInterval(all, LATEST_EVERY_MS);
    this.#timer.unref?.();
  }
  close(): void { if (this.#timer) clearInterval(this.#timer); }

  /** Loads saved overrides (npx version, fresh copy) and gives the sessions them, before they first connect. */
  /** A destination's profile as the companion runs it: with the override an update left, while that profile is unchanged. */
  effective(destinationId: string, config: PrinterHandoffConfig): PrinterHandoffConfig {
    return this.#deps.overrides.apply(config, this.#override(destinationId, config));
  }
  async applyOverrides(): Promise<void> {
    await this.#deps.overrides.load();
    for (const entry of this.#destinations()) await this.applyOverride(entry.id);
  }

  /** A destination listed after start (Add, a Printer MCP choice): its saved override, applied as at start. */
  async applyOverride(destinationId: string): Promise<void> {
    const entry = this.#destinations().find(item => item.id === destinationId);
    const override = entry ? this.#override(entry.id, entry.config) : undefined;
    if (!entry || !override) return;
    // A Move made again for a changed profile is saved for it, so the file says what runs.
    if (!this.#deps.overrides.peek(entry.id, entry.config)) await this.#deps.overrides.set(entry.id, override, entry.config).catch(() => undefined);
    await this.#deps.session(entry.id)?.restart(this.#deps.overrides.apply(entry.config, override)).catch(() => undefined);
  }

  /** `printers.updateMcp` / `POST /v1/printers/mcp/<mcpId>/update`. */
  update(mcpId: string, options: {fresh?: boolean} = {}): Promise<McpUpdate> {
    // The app's own copy before any printer uses it (Linux with no printer added, Nov 5): Settings shows it with
    // Update, so Update replaces it the way Download installed it, after asking npm now.
    const unused = printerBackendSchema.options.find(pkg => appMcpId(pkg, this.#deps.env) === mcpId);
    if (unused && !this.#members(mcpId).length) return this.download(unused, {update: true});
    const running = this.#active.get(mcpId);
    if (running) {
      // Waiting for a print: asking again asks npm again, so the update that runs after it is the latest one (Nov 6:
      // an update parked at 12:32 for 1.1.75 would have installed 1.1.75 after 1.1.76 was out). Never waits for npm.
      if (running.state === 'waiting') this.#raiseTarget(mcpId, running);
      return Promise.resolve({...running});
    }
    // Reserved before the first await: two requests at once share one update.
    const starting = this.#starting.get(mcpId);
    if (starting) return starting.then(update => ({...update}));
    const work = this.#admit(mcpId, options).finally(() => this.#starting.delete(mcpId));
    this.#starting.set(mcpId, work);
    return work.then(update => ({...update}));
  }

  /** A waiting update's version, raised to npm's newest answer when that is newer. In the background. */
  #raiseTarget(mcpId: string, update: McpUpdate): void {
    const pkg = this.#packages.get(mcpId);
    if (!pkg) return;
    const raise = (version: string | undefined) => {
      if (version && this.#active.get(mcpId) === update && (!update.toVersion || newer(version, update.toVersion))) update.toVersion = version;
    };
    raise(this.#latest.get(pkg)?.version);
    void this.checkLatest(pkg).then(raise, () => undefined);
  }

  /** The newest of `admitted` and what npm answers within the lookup bound: the version a waiting update installs. */
  async #latestNow(pkg: string, admitted: string): Promise<string> {
    const answer = await within(this.checkLatest(pkg).catch(() => undefined), this.#deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, () => undefined);
    const known = [answer, this.#latest.get(pkg)?.version].filter((version): version is string => !!version);
    return known.reduce((best, version) => newer(version, best) ? version : best, admitted);
  }

  async #admit(mcpId: string, options: {fresh?: boolean}): Promise<McpUpdate> {
    const members = this.#members(mcpId);
    if (!members.length) throw new McpUpdateError('not-found', 'No printer uses that MCP.');
    const first = members[0]!, pkg = first.config.backend;
    // The oldest version any of its printers runs (npx profiles may pin different ones). One whose version
    // isn't known yet (an npx range that hasn't connected) can't be called current.
    const known = members.filter(member => (member.mcpId === mcpId || member.runs === mcpId))
      .map(member => installedVersion(member.install, this.#deps.env) ?? this.#deps.runningVersion(member.id));
    const versions = known.filter((version): version is string => !!version);
    const everyKnown = versions.length === known.length;
    const fromVersion = everyKnown ? versions.sort((a, b) => newer(a, b) ? 1 : newer(b, a) ? -1 : 0)[0] : undefined;
    const found = first.install.type === 'unresolved' ? first.install.found
      // npx inside a wrapper: the version is in a command Counterpart doesn't own.
      : first.install.type === 'npx' && first.install.via ? `${first.install.spec} run through ssh, whose command Counterpart can't change` : undefined;
    if (found && !options.fresh) return {mcpId, state: 'unresolved', found, ...(fromVersion ? {fromVersion} : {})};
    // Update is the person asking now, so npm is asked now: a version published minutes ago is the one installed
    // (Nov 4: a cached answer installed 1.1.55 half an hour after 1.1.56 was out). Answer within the Mac app's 10 s:
    // when npm is slow, an answer from the last hour is used; with none, a slow npm is asked again on the next tap.
    const cached = this.#latest.get(pkg);
    const recent = cached?.version && this.#now() - cached.atMs < RECENT_ANSWER_MS ? cached.version : undefined;
    const asking = this.checkLatest(pkg).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([asking, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), this.#deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS); })])
      .finally(() => clearTimeout(timer));
    const latest = answer === 'slow' ? recent ?? 'slow' : answer ?? recent;
    if (latest === 'slow') throw new McpUpdateError('unavailable', `npm is slow to answer for ${pkg}. Try Update again in a moment.`);
    if (!latest) throw new McpUpdateError('unavailable', `Counterpart couldn't ask npm for the latest ${pkg}. Check this Mac's internet connection, or install Node.js so npm is there.`);
    if (!options.fresh && fromVersion && !newer(latest, fromVersion)) return {mcpId, state: 'current', fromVersion, toVersion: latest};
    const update: McpUpdate = {mcpId, state: 'started', ...(fromVersion ? {fromVersion} : {}), toVersion: latest};
    this.#active.set(mcpId, update);
    this.#packages.set(mcpId, pkg);
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
    if (claimed) { void this.#perform(mcpId, options, latest, pkg).catch(() => undefined); return; }
    update.state = 'waiting';
    await this.#emit('mcp.update.waiting', pkg, update);
    void this.#waitThenRun(mcpId, options, latest, pkg).catch(() => undefined);
  }

  /** Marks the install's printers as updating (no print can start), then makes sure none is printing. */
  async #claim(mcpId: string, options: {fresh?: boolean} = {}): Promise<boolean> {
    const members = this.#members(mcpId, options), ids = this.#gateIds(members.map(member => member.id)), gate = this.#deps.gate;
    // The files this update writes, reserved for it alone: a fresh copy reserves the app's own copy.
    const target = members.find(member => (member.mcpId === mcpId || member.runs === mcpId));
    const keys = [...new Set([...members.filter(member => (member.mcpId === mcpId || member.runs === mcpId)).map(member => member.runs),
      ...(options.fresh && target ? [mcpIdFor(this.#freshInstall(target.config), target.config)] : [])])];
    if (keys.some(key => this.#changing.has(key) && this.#changing.get(key) !== mcpId)) return false;
    if (gate && !gate.beginUpdate(ids)) return false;
    let busy: boolean;
    // A check that fails can't say no print is running: the printers are released and the caller says so.
    const limit = this.#deps.busyTimeoutMs ?? BUSY_CHECK_MS;
    try {
      busy = (await within(Promise.all(ids.map(id => this.#deps.busy(id))), limit, () => {
        throw new Error(`the print check took longer than ${Math.round(limit / 1000)} seconds`);
      })).some(Boolean);
    }
    catch (error) { gate?.endUpdate(ids); throw error; }
    if (busy || keys.some(key => this.#changing.has(key) && this.#changing.get(key) !== mcpId)) { gate?.endUpdate(ids); return false; }
    for (const key of keys) this.#changing.set(key, mcpId);
    this.#held.set(mcpId, ids);
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
    // npm is asked again now: the print may have taken hours, and a newer version may be out since Update was pressed.
    const now = await this.#latestNow(pkg, update?.toVersion && newer(update.toVersion, latest) ? update.toVersion : latest);
    if (update) { update.state = 'started'; update.toVersion = now; }
    await this.#perform(mcpId, options, now, pkg);
  }

  /** npm can succeed while skipping install scripts. Its foreground lifecycle banner plus
   * a successful exit proves the declared postinstall ran before the staged copy goes live.
   * The install passes --loglevel=notice: a user's loglevel=silent (.npmrc or environment) hides the banner.
   * The MCP owns its setup/patch implementation; Counterpart does not reproduce it. */
  #verifyPostinstall(staged: string, output: string): void {
    const manifest = JSON.parse(this.#deps.env.readFile(join(staged, 'package.json')) ?? 'null');
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
      throw new Error('npm install left an unreadable package');
    if (typeof manifest.scripts?.postinstall !== 'string' || !manifest.scripts.postinstall.trim()) return;
    const banner = `> ${manifest.name}@${manifest.version} postinstall`;
    if (!output.split(/\r?\n/).some(line => line.trim() === banner)) {
      const sentence = `npm did not run ${manifest.name}'s required setup. Counterpart left this copy unchanged. Check npm's install-script settings, then try again.`;
      throw Object.assign(new Error(sentence), {sentence});
    }
  }

  async #perform(mcpId: string, options: {fresh?: boolean}, latest: string, pkg: string): Promise<void> {
    const update = this.#active.get(mcpId)!;
    const members = this.#members(mcpId, options), first = members[0];
    const release = () => {
      this.#deps.gate?.endUpdate([...new Set([...members.map(member => member.id), ...(this.#held.get(mcpId) ?? [])])]);
      this.#held.delete(mcpId);
      for (const [key, owner] of [...this.#changing]) if (owner === mcpId) this.#changing.delete(key);
    };
    // Every printer on this install was removed while the update waited or was being admitted: nothing to update.
    if (!first) {
      this.#active.delete(mcpId);
      release();
      if (update) await this.#emit('mcp.update.failed', pkg, update, NO_PRINTERS(pkg)).catch(() => undefined);
      return;
    }
    const previous = new Map(members.map(member => [member.id, this.#override(member.id, member.config)]));
    const own = members.filter(member => (member.mcpId === mcpId || member.runs === mcpId));
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
        const output = await run('npm install', plan.command, [...plan.args, 'install', '--global', '--prefix', staging, `--allow-scripts=${install.pkg}`, '--ignore-scripts=false', '--foreground-scripts', '--loglevel=notice', `${install.pkg}@${latest}`], undefined, plan.env);
        if (!this.#deps.env.exists(join(staged, 'package.json'))) throw new Error('npm install left no package');
        this.#verifyPostinstall(staged, output);
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
        if (options.fresh && install.type === 'app') await this.#deps.overrides.set(member.id, this.#appCopyOverride(member.config), member.config);
      }
      // Each restart and connect is bounded: an MCP that never answers puts the previous version back with a sentence,
      // instead of an update that never ends (and a Settings row that spins).
      const startMs = this.#deps.startTimeoutMs ?? MCP_START_MS;
      const stuck = () => { throw Object.assign(new Error('MCP start timed out'), {sentence: NOT_STARTED(pkg, Math.round(startMs / 1000))}); };
      for (const member of members) {
        const session = this.#deps.session(member.id);
        if (session) await within(session.restart(this.#deps.overrides.apply(member.config, this.#override(member.id, member.config))), startMs, stuck);
      }
      // Every printer on these files starts the new version before the previous one is removed: one that can't
      // start it puts everything back.
      let catalog: Awaited<ReturnType<PrinterSession['connect']>> | undefined;
      for (const member of members) {
        const session = this.#deps.session(member.id);
        const connected = session ? await within(session.connect({signal: AbortSignal.timeout(startMs)}), startMs, stuck) : undefined;
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
        const session = this.#deps.session(member.id);
        if (session) await within(session.restart(this.#deps.overrides.apply(member.config, previous.get(member.id))), this.#deps.startTimeoutMs ?? MCP_START_MS, () => undefined).catch(() => undefined);
      }
      this.#active.delete(mcpId);
      await this.#emit('mcp.update.failed', pkg, update, tail(sentence ? `${log}${sentence}\n` : log || String((error as Error).message)),
        restoreFailed ? RESTORE_FAILED : undefined);
    } finally { release(); }
  }

  #freshInstall(config: PrinterHandoffConfig): McpInstall & {type: 'app'} {
    return appInstall(config.backend, this.#deps.env, this.#deps.node) as McpInstall & {type: 'app'};
  }

  /**
   * Download (`printers.installMcp`): installs the latest `pkg` into the app's own copy when no printer uses it yet,
   * with the same staged npm install and swap as Update, and the same mcp.update.* events (keyed by the app copy's id).
   * The caller checks the package isn't installed anywhere first; this never touches another install.
   */
  download(pkg: PrinterHandoffConfig['backend'], options: {update?: boolean} = {}): Promise<McpUpdate> {
    const install = this.#freshInstall({backend: pkg, process: {command: this.#deps.node}} as PrinterHandoffConfig);
    const mcpId = mcpIdFor(install, {backend: pkg, process: {command: this.#deps.node}} as PrinterHandoffConfig);
    const running = this.#active.get(mcpId);
    if (running) return Promise.resolve({...running});
    const starting = this.#starting.get(mcpId);
    if (starting) return starting.then(update => ({...update}));
    const work = (async (): Promise<McpUpdate> => {
      const cached = this.#latest.get(pkg);
      const looking = !options.update && cached?.version && this.#now() - cached.atMs < LATEST_ON_VIEW_MS ? Promise.resolve(cached.version) : this.checkLatest(pkg).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const latest = await Promise.race([looking, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), this.#deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS); })])
        .finally(() => clearTimeout(timer));
      if (latest === 'slow') throw new McpUpdateError('unavailable', `npm is slow to answer for ${pkg}. Try ${options.update ? 'Update' : 'Download'} again in a moment.`);
      if (!latest) throw new McpUpdateError('unavailable', `Counterpart couldn't ask npm for the latest ${pkg}. Check this Mac's internet connection.`);
      const fromVersion = options.update ? installedVersion(install, this.#deps.env) : undefined;
      if (fromVersion && !newer(latest, fromVersion)) return {mcpId, state: 'current', fromVersion, toVersion: latest};
      // A fresh copy or update of the same files is running: this waits for the next tap.
      if (this.#changing.has(mcpId)) throw new McpUpdateError('unavailable', `${pkg} is being installed already. Try again when it finishes.`);
      const update: McpUpdate = {mcpId, state: 'started', ...(fromVersion ? {fromVersion} : {}), toVersion: latest};
      this.#active.set(mcpId, update);
      this.#changing.set(mcpId, mcpId);
      void this.#performDownload(install, update, latest);
      return update;
    })().finally(() => this.#starting.delete(mcpId));
    this.#starting.set(mcpId, work);
    return work.then(update => ({...update}));
  }

  async #performDownload(install: McpInstall & {type: 'app'}, update: McpUpdate, latest: string): Promise<void> {
    const pkg = install.pkg as PrinterHandoffConfig['backend'];
    let log = '';
    const staging = join(install.prefix, `.counterpart-update-${randomUUID()}`);
    const live = join(install.prefix, 'lib', 'node_modules', pkg), staged = join(staging, 'lib', 'node_modules', pkg), kept = join(staging, 'previous');
    try {
      await this.#emit('mcp.update.started', pkg, update);
      const plan = this.#plan(install, latest);
      if ('fail' in plan) throw Object.assign(new Error(plan.fail), {sentence: plan.fail});
      if (plan.kind !== 'npm') throw new Error('not an npm install');
      await this.#fs.mkdir(install.prefix);
      const result = await this.#run(plan.command, [...plan.args, 'install', '--global', '--prefix', staging, `--allow-scripts=${pkg}`, '--ignore-scripts=false', '--foreground-scripts', '--loglevel=notice', `${pkg}@${latest}`], {env: plan.env, timeoutMs: MCP_UPDATE_TIMEOUT_MS});
      log += `$ ${[plan.command, ...plan.args, 'install', '--global', '--prefix', staging, `--allow-scripts=${pkg}`, '--ignore-scripts=false', '--foreground-scripts', '--loglevel=notice', `${pkg}@${latest}`].join(' ')}\n${result.output}\n`;
      if (result.code !== 0) throw new Error('npm install failed');
      if (!this.#deps.env.exists(join(staged, 'package.json'))) throw new Error('npm install left no package');
      this.#verifyPostinstall(staged, result.output);
      await this.#fs.mkdir(dirname(live));
      // A copy without its package.json (an interrupted install) isn't an install: it is set aside, then removed.
      if (this.#deps.env.exists(live)) await this.#fs.rename(live, kept);
      await this.#fs.rename(staged, live);
      await this.#fs.rm(staging).catch(() => undefined);
      this.#active.delete(update.mcpId);
      await this.#emit('mcp.update.done', pkg, {...update, toVersion: installedVersion(install, this.#deps.env) ?? latest});
    } catch (error) {
      await this.#fs.rm(staging).catch(() => undefined);
      this.#active.delete(update.mcpId);
      const sentence = (error as {sentence?: string}).sentence;
      await this.#emit('mcp.update.failed', pkg, update, tail(sentence ? `${log}${sentence}\n` : log || String((error as Error).message)));
    } finally {
      this.#changing.delete(update.mcpId);
    }
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
