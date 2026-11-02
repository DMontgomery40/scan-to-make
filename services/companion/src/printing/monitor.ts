import {randomUUID} from 'node:crypto';
import type {PrintReport} from '@scan-to-make/printer-handoff';
import type {CounterpartEventType, PrintLive, PrintMonitor} from '@scan-to-make/contracts/counterpart';
import {printPreparing} from '../events/words.js';

/** PRD §8.6 cadence. */
export const MONITOR = {
  startWindowMs: 180_000,
  startPollMs: 3_000,
  watchPollMs: 10_000,
  /** bambu-printer-mcp's get_printer_status makes the printer send its whole report each time. */
  fallbackStartPollMs: 10_000,
  fallbackWatchPollMs: 30_000,
  unreachablePollMs: 30_000,
  unreachableAfterFailures: 3,
  offlineUnreachableMs: 60_000,
  statusEveryMs: 60_000,
  /** A gap longer than this between two reports means the Mac slept or the companion was down: no back-fill. */
  backfillGapMs: 60_000,
  frameCapMs: 10_000,
  /** With no report at all for this long, the monitor stops and says contact was lost. */
  giveUpAfterMs: 12 * 60 * 60_000,
} as const;

/** One event as the monitor raises it; the event log adds `seq`, the time and the words. */
export interface EventDraft {
  id: string;
  type: CounterpartEventType;
  /** Absent for an event about the Mac, not a project (mcp.update.*). */
  projectId?: string;
  printId?: string;
  destinationId?: string;
  printerName?: string;
  data?: NonNullable<import('@scan-to-make/contracts/counterpart').CounterpartEvent['data']>;
  /** Relative to the project directory. */
  frame?: string;
  /** Facts only the words need (they end up in title and body, not in `data`). */
  detail?: {item?: string; question?: string; size?: string; reason?: string; message?: string; title?: string; package?: string};
}

export interface MonitorClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
export const systemMonitorClock: MonitorClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); }
    signal.addEventListener('abort', done, {once: true});
  }),
};

export type MonitorEnd = NonNullable<PrintMonitor['endState']>;
export interface MonitorTarget {
  projectId: string;
  printId: string;
  destinationId: string;
  printerName: string;
  /** The printer's task id from the print call, when it returned one. */
  taskId?: string;
  /** The job name the printer reports for this print. */
  jobName?: string;
  /**
   * Without a task id or job name: the sliced file's base name. A job whose name
   * matches it within the start window is adopted; otherwise the print ends `sent`.
   */
  fileBase?: string;
  dispatchedAtMs: number;
  estimate?: {seconds?: number; grams?: number};
}

export interface MonitorDeps {
  clock?: MonitorClock;
  /** One report through the destination's held session. */
  read(signal: AbortSignal): Promise<PrintReport>;
  /** A camera frame for event `eventId`, saved under the project; resolves to its relative path. */
  frame?(eventId: string, signal: AbortSignal): Promise<string | undefined>;
  /** Persists the monitor's state and the latest report of our job. */
  save(monitor: PrintMonitor, live: PrintLive | undefined): Promise<void>;
  /** Our job ended (or never started, or was replaced). Called once. */
  end(state: MonitorEnd, report: PrintReport | undefined, monitor: PrintMonitor): Promise<void>;
  emit(draft: EventDraft): Promise<void>;
  /** The milestone percentages currently chosen (companion setting). */
  milestones(): readonly number[];
  /** Reads come from get_printer_status (older MCP): poll more slowly. */
  fallback?: boolean;
  /** Tests only: the frame wait cap (PRD: 10 s). */
  frameCapMs?: number;
  /** A print dispatched without an identity was recognised by its file name: persist the job name. */
  adopted?(jobName: string): Promise<void>;
}

export function milestonesFor(setting: 'off' | '50' | '25-50-75' | 'every-10'): number[] {
  switch (setting) {
    case 'off': return [];
    case '50': return [50];
    case '25-50-75': return [25, 50, 75];
    case 'every-10': return [10, 20, 30, 40, 50, 60, 70, 80, 90];
  }
}

const strip = (name: string) => name.trim().toLowerCase().replace(/\.(gcode\.3mf|3mf|gcode|bgcode)$/i, '');
const activeStates = new Set(['preparing', 'printing', 'paused']);
const realId = (id: string | undefined) => id !== undefined && id !== '' && id !== '0' ? id : undefined;

/** Does this report describe our print, someone else's, or nothing identifiable? */
export function matchJob(target: Pick<MonitorTarget, 'taskId' | 'jobName' | 'fileBase'>, report: PrintReport): 'ours' | 'other' | 'none' {
  const job = report.job;
  if (!job?.name && !realId(job?.id)) return 'none';
  // No identity from the dispatch: only a job named after our file counts, and nothing else is "other".
  if (!target.taskId && !target.jobName) {
    const base = target.fileBase ? strip(target.fileBase) : undefined, name = job?.name ? strip(job.name) : undefined;
    return base && name && (name === base || name.endsWith(`-${base}`) || name.endsWith(`_${base}`)) ? 'ours' : 'none';
  }
  const taskId = realId(target.taskId), reportedId = realId(job?.id);
  if (taskId && reportedId) return taskId === reportedId ? 'ours' : 'other';
  if (target.jobName && job?.name) return strip(job.name) === strip(target.jobName) ? 'ours' : 'other';
  return 'none';
}

/**
 * The report as Counterpart shows it. Until the first layer the printer is getting ready (PRD §8.6): the state is
 * `preparing` and there is no percent or time left (Bambu reports a few percent and the whole print's time then).
 */
function liveFrom(report: PrintReport): PrintLive {
  const preparing = printPreparing(report.state, report.job);
  const job = report.job && preparing ? (({progress: _progress, remainingSec: _remaining, ...rest}) => rest)(report.job) : report.job;
  const remaining = preparing ? undefined : report.job?.remainingSec;
  const observed = Date.parse(report.observedAt);
  return {
    source: report.source, observedAt: report.observedAt, state: preparing ? 'preparing' : report.state,
    ...(job ? {job: structuredClone(job)} : {}),
    ...(remaining !== undefined && Number.isFinite(observed) ? {endsAt: new Date(observed + remaining * 1000).toISOString()} : {}),
    ...(report.temps ? {temps: structuredClone(report.temps)} : {}),
    ...(report.activeFilament ? {activeFilament: structuredClone(report.activeFilament)} : {}),
    problems: report.problems.map(problem => ({...problem})),
  };
}

function eventData(report: PrintReport): EventDraft['data'] {
  const live = liveFrom(report), job = live.job;
  // Getting ready: the stage only (a layer count then is 0, or the previous job's).
  const preparing = live.state === 'preparing';
  return {
    state: live.state,
    ...(job?.progress !== undefined ? {progress: job.progress} : {}),
    ...(job?.remainingSec !== undefined ? {remainingSec: Math.round(job.remainingSec)} : {}),
    ...(live.endsAt ? {endsAt: live.endsAt} : {}),
    ...(job?.layer !== undefined && !preparing ? {layer: job.layer} : {}),
    ...(job?.totalLayers !== undefined && !preparing ? {totalLayers: job.totalLayers} : {}),
    ...(job?.stage ? {stage: job.stage} : {}),
    ...(report.problems.length ? {problems: report.problems.slice(0, 16).map(({code, message}) => ({code, message}))} : {}),
  };
}

/** A real task id, or a job name only this dispatch can have (bambu-printer-mcp's checked-<uuid>-<file>). */
export function uniqueIdentity(target: Pick<MonitorTarget, 'taskId' | 'jobName'>): boolean {
  return !!realId(target.taskId) || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(target.jobName ?? '');
}

const problemsKey = (report: PrintReport) => report.problems.map(problem => problem.code).sort().join(',');

/**
 * Watches one dispatched print until it ends (PRD §8.6). It confirms the start
 * from the printer's own reports, raises the print events, and saves its state
 * after every change so a restarted companion carries on without repeating a
 * milestone. It never sends anything to the printer.
 */
export class PrintMonitorRunner {
  readonly target: MonitorTarget;
  readonly #deps: MonitorDeps;
  readonly #clock: MonitorClock;
  #state: PrintMonitor;
  #failures = 0;
  #offlineSince?: number;
  #lastGoodAt?: number;
  #lastStatus?: {at: number; progress?: number; state: string; layer?: number; stage?: string; problems: string};
  #lastState?: string;
  #live?: PrintLive;

  constructor(target: MonitorTarget, deps: MonitorDeps, state?: PrintMonitor) {
    this.target = target;
    this.#deps = deps;
    this.#clock = deps.clock ?? systemMonitorClock;
    this.#state = state ? structuredClone(state) : {phase: 'starting', startedAt: new Date(target.dispatchedAtMs).toISOString(), milestonesSent: [], firstLayerSent: false};
    // Resuming after a restart: the last report this print saw is the reference for "no back-fill".
    if (this.#state.lastReportAt) this.#lastGoodAt = Date.parse(this.#state.lastReportAt);
    if (this.#state.phase === 'watching') this.#lastState = 'printing';
  }

  get state(): PrintMonitor { return structuredClone(this.#state); }

  #draft(type: CounterpartEventType, report?: PrintReport, extra: Partial<EventDraft> = {}): EventDraft {
    return {id: randomUUID(), type, projectId: this.target.projectId, printId: this.target.printId,
      destinationId: this.target.destinationId, printerName: this.target.printerName,
      ...(report ? {data: eventData(report)} : {}), ...extra};
  }

  async #emit(type: CounterpartEventType, report: PrintReport | undefined, options: {frame?: boolean; signal: AbortSignal; data?: EventDraft['data']}) {
    const draft = this.#draft(type, report);
    if (options.data) draft.data = {...draft.data, ...options.data};
    if (options.frame && this.#deps.frame) {
      // A frame never holds an event back more than 10 s: a slow camera means no frame.
      const controller = new AbortController();
      const abort = () => controller.abort();
      options.signal.addEventListener('abort', abort, {once: true});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<undefined>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(undefined); }, this.#deps.frameCapMs ?? MONITOR.frameCapMs); });
      try {
        const frame = await Promise.race([this.#deps.frame(draft.id, controller.signal).catch(() => undefined), capped]);
        if (frame) draft.frame = frame;
      } finally { clearTimeout(timer); options.signal.removeEventListener('abort', abort); }
    }
    await this.#deps.emit(draft);
  }

  async #save() { await this.#deps.save(this.state, this.#live); }

  async #finish(end: MonitorEnd, report: PrintReport | undefined, signal: AbortSignal) {
    const now = this.#clock.now();
    // A failure's own report is the record: its problems are what stopped the print (an idle report after the
    // job is gone carries the code that stopped it), not the last report while it ran.
    if (report && end === 'failed') this.#observe(report);
    this.#state = {...this.#state, phase: 'ended', endState: end, endedAt: new Date(now).toISOString()};
    delete this.#state.unreachableSince;
    const events: Partial<Record<MonitorEnd, [CounterpartEventType, boolean]>> = {
      done: ['print.done', true], failed: ['print.failed', true], cancelled: ['print.cancelled', false], 'not-started': ['print.not-started', false],
      sent: ['print.sent', false],
    };
    await this.#save();
    await this.#deps.end(end, report, this.state);
    const event = events[end];
    if (event) await this.#emit(event[0], report, {frame: event[1], signal});
  }

  #interval(): number {
    if (this.#state.unreachableSince) return MONITOR.unreachablePollMs;
    if (this.#state.phase === 'starting') return this.#deps.fallback ? MONITOR.fallbackStartPollMs : MONITOR.startPollMs;
    return this.#deps.fallback ? MONITOR.fallbackWatchPollMs : MONITOR.watchPollMs;
  }

  /** Runs until the print ends or `signal` aborts (shutdown); resolves with the end state, if any. */
  async run(signal: AbortSignal): Promise<MonitorEnd | undefined> {
    while (!signal.aborted && this.#state.phase !== 'ended') {
      await this.step(signal);
      if (signal.aborted || (this.#state.phase as PrintMonitor['phase']) === 'ended') break;
      await this.#clock.sleep(this.#interval(), signal);
    }
    return this.#state.endState;
  }

  /** One read and everything it implies. Exposed for tests. */
  async step(signal: AbortSignal): Promise<void> {
    const now = this.#clock.now();
    let report: PrintReport;
    try { report = await this.#deps.read(signal); }
    catch {
      if (signal.aborted) return;
      this.#failures++;
      if (this.#failures >= MONITOR.unreachableAfterFailures) await this.#unreachable(now, signal);
      await this.#giveUp(now, signal);
      return;
    }
    this.#failures = 0;
    if (report.state === 'offline') {
      this.#offlineSince ??= now;
      if (now - this.#offlineSince >= MONITOR.offlineUnreachableMs) await this.#unreachable(now, signal);
      await this.#giveUp(now, signal);
      return;
    }
    this.#offlineSince = undefined;
    const recovered = this.#state.unreachableSince !== undefined;
    if (recovered) delete this.#state.unreachableSince;
    const gap = this.#lastGoodAt === undefined ? 0 : now - this.#lastGoodAt;
    const quiet = gap > MONITOR.backfillGapMs;
    this.#lastGoodAt = now;
    const match = matchJob(this.target, report);
    const active = activeStates.has(report.state);

    if (this.#state.phase === 'starting') {
      if (match === 'other' && active) return this.#finish('replaced', report, signal);
      if (match !== 'ours') { await this.#checkStartWindow(now, report, signal); if (recovered) await this.#save(); return; }
      if (report.state === 'idle') { await this.#checkStartWindow(now, report, signal); return; }
      // A finished or failed report under a reused name can be an earlier print's: until this print has been seen
      // running, only a dispatch-unique identity (a real task id, or Bambu's checked-<uuid>- name) proves an ending is ours.
      if (!active && !uniqueIdentity(this.target)) { await this.#checkStartWindow(now, report, signal); return; }
      if (!this.target.taskId && !this.target.jobName && report.job?.name) {
        (this.target as {jobName?: string}).jobName = report.job.name;
        await this.#deps.adopted?.(report.job.name);
      }
      this.#state = {...this.#state, phase: 'watching'};
      this.#observe(report);
      await this.#save();
      await this.#emit('print.started', report, {signal, data: {
        ...(this.target.estimate?.seconds !== undefined ? {estimateSec: Math.round(this.target.estimate.seconds)} : {}),
        ...(this.target.estimate?.grams !== undefined ? {grams: this.target.estimate.grams} : {}),
      }});
      this.#lastState = report.state;
      this.#lastStatus = {at: now, ...(report.job?.progress !== undefined ? {progress: report.job.progress} : {}), state: report.state,
        ...(report.job?.layer !== undefined ? {layer: report.job.layer} : {}), ...(report.job?.stage !== undefined ? {stage: report.job.stage} : {}), problems: problemsKey(report)};
      // A print that was already well under way when first seen (a restart) records its milestones silently.
      await this.#progressEvents(report, true, signal);
      await this.#terminal(report, signal);
      return;
    }

    // Watching.
    if (match === 'other' && active) return this.#finish('replaced', report, signal);
    if (match !== 'ours') {
      // Our job is gone without an ending we could see (the printer was reset): say so honestly.
      if (report.state === 'idle') return this.#finish('failed', report, signal);
      if (recovered) await this.#save();
      return;
    }
    this.#observe(report);
    const previous = this.#lastState;
    this.#lastState = report.state;
    if (report.state === 'paused' && previous !== 'paused') await this.#emit('print.paused', report, {frame: true, signal});
    if (previous === 'paused' && (report.state === 'printing' || report.state === 'preparing')) await this.#emit('print.resumed', report, {signal});
    await this.#progressEvents(report, quiet, signal);
    if (await this.#terminal(report, signal)) return;
    const status = {progress: report.job?.progress, state: report.state, layer: report.job?.layer, stage: report.job?.stage, problems: problemsKey(report)};
    const last = this.#lastStatus;
    // A new stage is news too: while it gets ready, "Heating" → "Cleaning" → "Auto bed leveling" is all there is to say.
    const changed = recovered || !last || last.state !== status.state || last.layer !== status.layer || last.stage !== status.stage || last.problems !== status.problems
      || (status.progress !== undefined && (last.progress === undefined || Math.abs(status.progress - last.progress) >= 1))
      || now - last.at >= MONITOR.statusEveryMs;
    await this.#save();
    if (changed) {
      this.#lastStatus = {at: now, ...(status.progress !== undefined ? {progress: status.progress} : {}), state: status.state,
        ...(status.layer !== undefined ? {layer: status.layer} : {}), ...(status.stage !== undefined ? {stage: status.stage} : {}), problems: status.problems};
      await this.#emit('print.status', report, {signal});
    }
  }

  #observe(report: PrintReport) {
    this.#live = liveFrom(report);
    this.#state = {...this.#state, lastReportAt: report.observedAt};
  }

  async #terminal(report: PrintReport, signal: AbortSignal): Promise<boolean> {
    if (report.state === 'finished') { await this.#finish('done', report, signal); return true; }
    if (report.state === 'failed') { await this.#finish('failed', report, signal); return true; }
    if (report.state === 'cancelled') { await this.#finish('cancelled', report, signal); return true; }
    return false;
  }

  /** First layer and milestones. `quiet` records them as sent without an event (no back-fill). */
  async #progressEvents(report: PrintReport, quiet: boolean, signal: AbortSignal) {
    // Getting ready isn't printing: no first layer or milestone from it (nor from the previous job's numbers a
    // printer still shows while it prepares the next one).
    if (printPreparing(report.state, report.job)) return;
    if (report.state === 'finished' || report.state === 'failed' || report.state === 'cancelled') quiet = true;
    const job = report.job;
    if (!this.#state.firstLayerSent) {
      const reached = job?.layer !== undefined && job.totalLayers !== undefined && job.totalLayers > 0 ? job.layer >= 2 : (job?.progress ?? 0) >= 5;
      if (reached) {
        this.#state = {...this.#state, firstLayerSent: true};
        await this.#save();
        if (!quiet) await this.#emit('print.first-layer', report, {frame: true, signal});
      }
    }
    const progress = job?.progress;
    if (progress === undefined) return;
    const crossed = this.#deps.milestones().filter(milestone => progress >= milestone && !this.#state.milestonesSent.includes(milestone)).sort((a, b) => a - b);
    if (!crossed.length) return;
    this.#state = {...this.#state, milestonesSent: [...this.#state.milestonesSent, ...crossed].sort((a, b) => a - b)};
    await this.#save();
    // Several at once (a fast jump): only the highest is news.
    if (!quiet) await this.#emit('print.milestone', report, {frame: true, signal, data: {progress: crossed.at(-1)!}});
  }

  async #unreachable(now: number, signal: AbortSignal) {
    if (this.#state.unreachableSince) return;
    this.#state = {...this.#state, unreachableSince: new Date(now).toISOString()};
    await this.#save();
    await this.#emit('print.unreachable', undefined, {signal});
  }

  /**
   * "Didn't start" is said only from a report: while the printer can't be read
   * the monitor keeps trying, and gives up only after a long silence.
   */
  async #giveUp(now: number, signal: AbortSignal) {
    const since = this.#lastGoodAt ?? this.target.dispatchedAtMs;
    if (now - since < MONITOR.giveUpAfterMs) return;
    // Silence proves nothing either way: the printer has it, and Counterpart can't follow it.
    await this.#finish('sent', undefined, signal);
  }

  async #checkStartWindow(now: number, report: PrintReport | undefined, signal: AbortSignal) {
    if (this.#state.phase !== 'starting') return;
    // Without an identity, not seeing our job proves nothing: it was sent, and that is all Counterpart can say.
    if (now - this.target.dispatchedAtMs >= MONITOR.startWindowMs) await this.#finish(this.target.taskId || this.target.jobName ? 'not-started' : 'sent', report, signal);
  }
}

