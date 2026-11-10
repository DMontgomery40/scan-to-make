import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {PrinterMcpClient, toolResultJson, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {newerVersion} from './directory.js';
import {readMcpSetup} from './mcp-setup.js';
import type {AutoUpdateOutcome, AutoUpdateTarget} from './mcp-updates.js';

/**
 * Q9, "Keep printer software up to date" (David, Nov 10: "there should be an 'auto update' toggle and ours should
 * default to on"). The printer MCPs are the back end and publish as often as every six hours; the app can't ship that
 * often, so the companion installs a newer MCP by itself, between jobs, and says what it did afterwards.
 *
 * This is only the schedule and the record of what failed. The install, its journal, the proof that the new copy
 * answers `counterpart/1`, putting the previous copy back, and the event are McpUpdater's (`autoUpdate`), the same
 * code Update runs. Which copies it may change is McpUpdater's too (`autoTargets`: Counterpart's own copies).
 */

/** The MCPs' own cadence: npm is asked this often, each MCP's packages once. */
export const AUTO_EVERY_MS = 6 * 60 * 60_000;
/** Up to this much later, so a fleet of companions doesn't ask npm at the same minute. */
export const AUTO_JITTER_MS = 30 * 60_000;
/** The first check after the companion starts: after its printers have connected, with a little jitter. */
export const AUTO_FIRST_MS = 2 * 60_000;
export const AUTO_FIRST_JITTER_MS = 60_000;
/** While Counterpart is working (or a printer prints), it looks again this soon, so it runs soon after the work ends. */
export const AUTO_BUSY_RETRY_MS = 60_000;
/** While the setting is off, how often it is read again: turning it on takes effect within this long. */
export const AUTO_OFF_POLL_MS = 5 * 60_000;
/** An install that fails before anything changed (npm) is tried at this many intervals, then said once and left. */
export const AUTO_QUIET_TRIES = 3;
/** npm's answer for a package is used again for this long (review F3: not asked every minute through a long print). */
export const AUTO_LATEST_TTL_MS = 30 * 60_000;

/** What a failed version left: never tried again by itself once put back, or after AUTO_QUIET_TRIES quiet failures. */
interface FailedVersion {toVersion: string; tries: number; reverted?: boolean; why?: string; at: number}
interface AutoState {version: 1; failed: Record<string, FailedVersion>}

export interface McpAutoUpdaterDeps {
  /** The person's choice (`general.autoUpdateMcps`), read before every run. Off: nothing runs. */
  enabled(): boolean | Promise<boolean>;
  targets(): AutoUpdateTarget[];
  /** npm's newest version of a package; undefined or a throw when npm can't be reached (quiet, tried at the next run). */
  latest(pkg: string): Promise<string | undefined>;
  /** Why Counterpart isn't idle now, or undefined when it is. */
  busy(): Promise<string | undefined>;
  update(mcpId: string, latest: string, options: {report: boolean}): Promise<AutoUpdateOutcome>;
  /** `<data root>/printers/auto-update.json`: the versions that failed, so a restart doesn't try them again. */
  statePath?: string;
  /**
   * Automatic updates a restart cut short after they had changed something (McpUpdater.recoveredAutoUpdates): each
   * version is recorded as failed and not tried again by itself (review F4).
   */
  recovered?(): {mcpId: string; toVersion: string}[];
  now?: () => number;
  random?: () => number;
  log?: (line: string) => void;
  /** Runs `run` after `ms` and returns how to cancel it (setTimeout, unref'd). */
  later?: (run: () => void, ms: number) => () => void;
}
const later = (run: () => void, ms: number) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); };

export type AutoRun =
  | {state: 'off'}
  | {state: 'current'}
  | {state: 'deferred'; why: string}
  | {state: 'ran'; results: {mcpId: string; toVersion: string; outcome: AutoUpdateOutcome}[]};

export class McpAutoUpdater {
  readonly #deps: McpAutoUpdaterDeps;
  readonly #now: () => number;
  #state?: AutoState;
  #cancel?: () => void;
  #running?: Promise<AutoRun>;
  #lastChecked = 0;
  #wasOff = false;
  /** The last run found an update to install and Counterpart was busy: the next run asks "busy?" before npm. */
  #deferred = false;
  readonly #latest = new Map<string, {version: string; at: number}>();
  #closed = false;
  constructor(deps: McpAutoUpdaterDeps) { this.#deps = deps; this.#now = deps.now ?? Date.now; }

  async #load(): Promise<AutoState> {
    if (this.#state) return this.#state;
    let state: AutoState = {version: 1, failed: {}};
    if (this.#deps.statePath) {
      try {
        const raw = JSON.parse(await readFile(this.#deps.statePath, 'utf8')) as Partial<AutoState>;
        if (raw?.version === 1 && raw.failed && typeof raw.failed === 'object') {
          for (const [id, item] of Object.entries(raw.failed)) {
            if (item && typeof item.toVersion === 'string' && Number.isInteger(item.tries)) state.failed[id] = {toVersion: item.toVersion, tries: item.tries,
              ...(item.reverted ? {reverted: true} : {}), ...(typeof item.why === 'string' ? {why: item.why} : {}), at: Number(item.at) || 0};
          }
        }
      } catch { /* none yet, or unreadable: nothing has failed */ }
    }
    this.#state = state;
    return state;
  }
  async #save(): Promise<void> {
    if (!this.#deps.statePath || !this.#state) return;
    const path = this.#deps.statePath, temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await writeFile(temporary, JSON.stringify(this.#state, null, 1) + '\n', {mode: 0o600});
    await rename(temporary, path);
  }

  /** The versions that failed, by install (for Settings and tests). */
  async failed(): Promise<Record<string, FailedVersion>> { return structuredClone((await this.#load()).failed); }

  /**
   * One run: asks npm for each package in use, then installs each newer version, one install at a time, while
   * Counterpart is idle. A busy Counterpart defers the rest (nothing is touched); npm that can't be reached is quiet.
   */
  runOnce(): Promise<AutoRun> {
    this.#running ??= this.#run().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  /** npm's newest version, reused for AUTO_LATEST_TTL_MS; an answer npm couldn't give isn't kept. */
  async #latestOf(pkg: string): Promise<string | undefined> {
    const known = this.#latest.get(pkg);
    if (known && this.#now() - known.at < AUTO_LATEST_TTL_MS) return known.version;
    const version = await this.#deps.latest(pkg).catch(() => undefined);
    if (version) this.#latest.set(pkg, {version, at: this.#now()});
    return version;
  }

  async #run(): Promise<AutoRun> {
    if (!await this.#deps.enabled()) return {state: 'off'};
    const state = await this.#load();
    const recovered = this.#deps.recovered?.() ?? [];
    for (const {mcpId, toVersion} of recovered)
      state.failed[mcpId] = {toVersion, tries: AUTO_QUIET_TRIES, reverted: true, why: 'Counterpart stopped in the middle of installing it.', at: this.#now()};
    if (recovered.length) await this.#save().catch(error => this.#deps.log?.(`mcp auto-update state couldn't be saved: ${String((error as Error)?.message ?? error)}`));
    // An update already known to be waiting for Counterpart to finish: ask whether it has before asking npm again.
    if (this.#deferred) {
      const why = await this.#deps.busy();
      if (why) return {state: 'deferred', why};
    }
    const run = await this.#runTargets(state);
    this.#deferred = run.state === 'deferred';
    return run;
  }

  async #runTargets(state: AutoState): Promise<AutoRun> {
    const targets = this.#deps.targets();
    const latest = new Map<string, string | undefined>();
    for (const pkg of new Set(targets.map(target => target.pkg))) latest.set(pkg, await this.#latestOf(pkg));
    this.#lastChecked = this.#now();
    const pending = targets.flatMap(target => {
      const version = latest.get(target.pkg);
      if (!version || !target.fromVersion || !newerVersion(version, target.fromVersion)) return [];
      const failed = state.failed[target.mcpId];
      if (failed?.toVersion === version && (failed.reverted || failed.tries >= AUTO_QUIET_TRIES)) return [];
      return [{...target, toVersion: version}];
    });
    // A failure record for a version that is no longer the newest (or an install that is current) is done with.
    let cleaned = false;
    for (const target of targets) {
      const failed = state.failed[target.mcpId], version = latest.get(target.pkg);
      if (failed && version && failed.toVersion !== version) { delete state.failed[target.mcpId]; cleaned = true; }
    }
    if (cleaned) await this.#save().catch(() => undefined);
    if (!pending.length) return {state: 'current'};
    const results: {mcpId: string; toVersion: string; outcome: AutoUpdateOutcome}[] = [];
    for (const target of pending) {
      // Read again before each install: the setting may have been turned off, or work started, during the last one.
      if (!await this.#deps.enabled()) return results.length ? {state: 'ran', results} : {state: 'off'};
      const why = await this.#deps.busy();
      if (why) return {state: 'deferred', why};
      const failed = state.failed[target.mcpId];
      const tries = failed?.toVersion === target.toVersion ? failed.tries : 0;
      const outcome = await this.#deps.update(target.mcpId, target.toVersion, {report: tries + 1 >= AUTO_QUIET_TRIES});
      results.push({mcpId: target.mcpId, toVersion: target.toVersion, outcome});
      if (outcome.state === 'busy') return {state: 'deferred', why: 'Counterpart started working on it'};
      if (outcome.state === 'done') delete state.failed[target.mcpId];
      else if (outcome.state === 'reverted' || outcome.state === 'stuck') state.failed[target.mcpId] = {toVersion: target.toVersion, tries: tries + 1, reverted: true, why: outcome.why, at: this.#now()};
      else if (outcome.state === 'failed') state.failed[target.mcpId] = {toVersion: target.toVersion, tries: tries + 1, why: outcome.why, at: this.#now()};
      else continue;
      await this.#save().catch(error => this.#deps.log?.(`mcp auto-update state couldn't be saved: ${String((error as Error)?.message ?? error)}`));
    }
    return {state: 'ran', results};
  }

  /** At start: the first run after AUTO_FIRST_MS, then every AUTO_EVERY_MS, sooner while deferred. */
  start(): void {
    this.#closed = false;
    this.#schedule(AUTO_FIRST_MS + Math.floor((this.#deps.random ?? Math.random)() * AUTO_FIRST_JITTER_MS));
  }
  close(): void { this.#closed = true; this.#cancel?.(); this.#cancel = undefined; }

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#cancel?.();
    this.#cancel = (this.#deps.later ?? later)(() => void this.#tick(), ms);
  }

  async #tick(): Promise<void> {
    let next = AUTO_EVERY_MS + Math.floor((this.#deps.random ?? Math.random)() * AUTO_JITTER_MS);
    try {
      // Off: read the setting again soon; turned back on, the check runs then if the last one is older than the cadence.
      if (!await this.#deps.enabled()) { this.#wasOff = true; next = AUTO_OFF_POLL_MS; return; }
      const due = this.#lastChecked + AUTO_EVERY_MS - this.#now();
      if (this.#wasOff && due > 0) { this.#wasOff = false; next = due; return; }
      this.#wasOff = false;
      const run = await this.runOnce();
      if (run.state === 'deferred') next = AUTO_BUSY_RETRY_MS;
      if (run.state === 'ran') for (const {mcpId, toVersion, outcome} of run.results)
        this.#deps.log?.(`mcp auto-update ${mcpId} to ${toVersion}: ${outcome.state}${'why' in outcome ? ` (${outcome.why})` : ''}`);
    } catch (error) {
      this.#deps.log?.(`mcp auto-update run failed: ${String((error as Error)?.message ?? error)}`);
    } finally { this.#schedule(next); }
  }
}

/**
 * The companion's own answers to "is anything working?", each from the object that owns that state (none is a flag
 * of this feature's). Undefined when all of them say no; otherwise why not, in the first one that says yes.
 */
export interface IdleSources {
  /** Sends, slices, design and cleanup passes, answers, Moves and the Blender add-on's repair hold it (PrintGate.busy). */
  gate: {busy(): boolean};
  /** Update, Download, or another automatic update (McpUpdater.busy). */
  updates: {busy(): boolean};
  /** Add printer…'s steps and open approvals (PrinterSetup.working). */
  setup?: {working(): boolean};
  /** The code design engine's Set Up (CadSettings: `setting-up`). */
  cad?: {current(): {state: string}};
  /** Fusion's Set Up (RuntimeSettings.fusionSettingUp). */
  fusion?: {fusionSettingUp(): boolean};
  /** Every printer, by id and name. */
  printers(): {id: string; name: string}[];
  /** A project printing there, or the printer's own report says it prints (the check Complete Settings and Remove use). */
  printing?(destinationId: string): Promise<boolean>;
}
export async function companionBusy(sources: IdleSources): Promise<string | undefined> {
  if (sources.gate.busy()) return 'Counterpart is sending, slicing or designing';
  if (sources.updates.busy()) return 'an MCP update is running';
  const setting = settingUp(sources);
  if (setting) return setting;
  // The cheap checks first: a printer's report is read only when nothing else is working.
  for (const printer of sources.printers()) {
    // A check that fails can't say the printer is idle.
    if (sources.printing && await sources.printing(printer.id).catch(() => true)) return `${printer.name} is printing`;
  }
  return undefined;
}

/** Add printer…'s steps, the code engine's or Fusion's Set Up: work that starts or talks to an MCP outside PrintGate. */
export function settingUp(sources: Pick<IdleSources, 'setup' | 'cad' | 'fusion'>): string | undefined {
  if (sources.setup?.working()) return 'a printer is being set up';
  if (sources.cad?.current().state === 'setting-up') return 'the code design engine is being set up';
  if (sources.fusion?.fusionSettingUp()) return 'Fusion is being set up';
  return undefined;
}

type ContractClient = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close'>;
/**
 * The proof an automatic update keeps a new copy by: started on its own, with no printer settings (as Add printer…
 * starts one to read its fields, so nothing reaches a printer), it lists and answers `counterpart_setup_fields` with a
 * `counterpart/1` answer. The words are Counterpart's; nothing the MCP says is matched.
 */
export function contractCheck(options: {cwd: string; client?: (config: PrinterHandoffConfig) => ContractClient; timeoutMs?: number}) {
  return async (config: PrinterHandoffConfig, _version: string): Promise<string | undefined> => {
    const limit = options.timeoutMs ?? 25_000;
    await mkdir(options.cwd, {recursive: true, mode: 0o700});
    const probe: PrinterHandoffConfig = {backend: config.backend, process: {command: config.process.command, args: config.process.args ?? [], cwd: options.cwd}};
    const client = options.client?.(probe) ?? new PrinterMcpClient(probe);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('late')), limit); });
    try {
      let catalog;
      try { catalog = await Promise.race([client.connect(AbortSignal.timeout(limit)), late]); }
      catch { return `didn't start within ${Math.round(limit / 1000)} seconds.`; }
      if (!catalog.tools.some(tool => tool.name === 'counterpart_setup_fields')) return "doesn't offer Counterpart's contract (counterpart/1).";
      let answer;
      try {
        const result = await Promise.race([client.callTool('counterpart_setup_fields', {}, {timeoutMs: Math.min(10_000, limit)}), late]);
        answer = result.isError ? undefined : readMcpSetup(toolResultJson(result));
      } catch { answer = undefined; }
      return answer ? undefined : "didn't answer Counterpart's contract (counterpart/1).";
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  };
}
