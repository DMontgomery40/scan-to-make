import type {CounterpartEvent, CounterpartEventType, NotifyLevel, ObjectStatus} from '@scan-to-make/contracts/counterpart';

/**
 * Every sentence Counterpart shows about a project's progress comes from here
 * (PRD §8.7), so the Mac, the phone, the Lock Screen and the menu bar all say
 * the same thing. Kept free of I/O: callers pass what they know.
 */

export interface TitleSource {title?: string; instructions?: string; scan?: string; capture?: string[]; createdAtMs?: number; current?: {sizeMm?: readonly number[]}}

/** The generated title, else the first words of the request, else a plain name. */
export function projectTitle(object: TitleSource): string {
  if (object.title?.trim()) return object.title.trim().slice(0, 80);
  const request = object.instructions?.replace(/\s+/g, ' ').trim();
  if (request) {
    const words = request.split(' ');
    const short = words.slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '');
    return (words.length > 6 ? `${short}…` : short).slice(0, 80);
  }
  // A scan sent with no words gets a name of its own, never "Your scan" twice in one list: when it was scanned.
  // Not its size: every list already shows the size on the line under the title (seen on the iPad with real
  // projects, Nov 10: "Scan, 68.4 × 34.6 × 14…" over "68.4 × 34.6 × 149.9 mm").
  if (object.scan || object.capture?.length) {
    return object.createdAtMs ? `Scan, ${scanDate(object.createdAtMs)}` : 'Your scan';
  }
  return 'Your project';
}
const scanDate = (atMs: number) => new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(new Date(atMs));

/** "1 h 5 min", "25 min", "under a minute". */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * The words Bambu's stages use while the printer gets ready, before the first layer (stg_cur in Bambu Studio's
 * get_stage_string: levelling, heating, cleaning, calibrating, homing, checks). Pauses and filament changes aren't.
 */
const PREPARING_STAGE = /^(?:(?:high temperature )?auto bed level|heatbed preheating|heating |vibration compensation|calibrat|scanning bed|identifying build plate|homing|cleaning nozzle|checking extruder|motor noise|measur|enhancing motion|nozzle offset|auto check|confirming birdseye|laser calibration|live view camera calibration|waiting for (?:the )?(?:heatbed|chamber)|adjusting heatbed|printing calibration lines|cutting module offset|thermal preconditioning|preparing hotend|hotend pick and place|purifying the chamber|cooling chamber|the toolhead moves above the purge chute)/i;

/**
 * PRD §8.6: a print is still getting ready until its first layer. Bambu reports `printing` with layer 0 (and a
 * few percent) while it heats, cleans and levels; that isn't printing yet. Without a layer count, the stage says.
 */
export function printPreparing(state: string | undefined, job?: {layer?: number; stage?: string}): boolean {
  if (state === 'preparing') return true;
  if (state !== 'printing') return false;
  return job?.layer !== undefined ? job.layer < 1 : PREPARING_STAGE.test(job?.stage?.trim() ?? '');
}

export interface PrinterProblem {code: string; message?: string}
/** A message that says nothing beyond the code (Bambu has no text for it, or only the code came through). */
const noText = (problem: PrinterProblem) => {
  const message = problem.message?.trim() ?? '';
  return !message || message === problem.code || /no description|^the printer reported (?:problem|error) /i.test(message);
};
/**
 * The printer's own words: "The printer stopped: <its message>", or "The printer stopped (<code>)" when it has
 * none. Nothing more: no advice and no guessed cause (David, 2026-11-02: Counterpart sends the print; the printer
 * runs its own checks). The project offers Print Again.
 */
export function printerStopped(problem: PrinterProblem | undefined): string {
  if (!problem) return 'The printer stopped.';
  return noText(problem) ? `The printer stopped (${problem.code}).` : `The printer stopped: ${problem.message?.trim()}`;
}

/** The failure sentence for a print that ended without finishing (PRD §8.6). */
export function printEndFailure(end: 'failed' | 'not-started' | 'replaced', context: {title: string; printer: string; problem?: PrinterProblem}): string {
  switch (end) {
    case 'not-started': return `${context.printer} didn't start ${context.title}. Nothing was sent twice.`;
    case 'replaced': return `${context.printer} is printing something else.`;
    case 'failed': return printerStopped(context.problem).slice(0, 300);
  }
}

/** The `sent` state's words (PRD §2.6: never success without evidence). */
export function sentWords(printer: string, bambuConnect: boolean): string {
  return bambuConnect ? 'Finish on your Mac: press Print in Bambu Connect' : `Sent to ${printer} · Counterpart can't follow this print`;
}

/** Short history lines for `print.events`, which older apps show as the print's log. */
export const PRINT_LOG: Record<string, string> = {
  'print.started': 'The printer started it.',
  'print.first-layer': "First layer's down.",
  'print.milestone': 'Halfway there.',
  'print.paused': 'The printer paused it.',
  'print.resumed': 'Printing again.',
  'print.done': 'Done. Take it off the plate.',
  'print.failed': 'The printer stopped it.',
  'print.cancelled': 'Cancelled.',
  'print.not-started': "The printer didn't start it.",
  'print.unreachable': 'Lost contact with the printer. Still trying.',
  'print.sent': "Sent. Counterpart can't follow this print.",
};

// ---------------------------------------------------------------------------
// Event words (PRD §9.1; docs/protocols/events.md "Types, words and levels")


export interface WordsContext {
  title: string;
  /** mcp.update.*: the MCP's name as people know it ("mcp-3D-printer-server"). */
  package?: string;
  printer?: string;
  /** "60 × 45 × 22 mm" */
  size?: string;
  item?: string;
  question?: string;
  reason?: string;
  /** pass.ready: an earlier design of this project was printed, and it is unchanged (#616). */
  printedBefore?: boolean;
}

export const NOTIFY: Record<CounterpartEventType, NotifyLevel> = {
  'pass.started': 'none', 'pass.stage': 'none', 'pass.ready': 'active', 'pass.ask': 'active', 'pass.failed': 'active',
  'print.preparing': 'none', 'print.confirm': 'timeSensitive', 'print.started': 'passive',
  'print.status': 'none', 'print.first-layer': 'passive', 'print.milestone': 'active', 'print.paused': 'timeSensitive',
  'print.resumed': 'none', 'print.done': 'active', 'print.failed': 'timeSensitive', 'print.cancelled': 'passive',
  'print.not-started': 'timeSensitive', 'print.unreachable': 'passive', 'print.sent': 'passive',
  'project.updated': 'none', 'project.deleted': 'none', 'settings.changed': 'none',
  'mcp.update.started': 'none', 'mcp.update.waiting': 'none', 'mcp.update.done': 'passive', 'mcp.update.failed': 'active',
};

export function sizeText(sizeMm: readonly number[] | undefined): string | undefined {
  if (!sizeMm || sizeMm.length !== 3 || !sizeMm.every(value => Number.isFinite(value) && value > 0)) return undefined;
  return `${sizeMm.map(value => value < 0.05 ? '<0.1' : Number(value.toFixed(1))).join(' × ')} mm`;
}

function milestoneTitle(title: string, progress: number | undefined): string {
  if (progress === 50) return `${title} is halfway`;
  if (progress === 25) return `${title} is a quarter done`;
  if (progress === 75) return `${title} is three-quarters done`;
  return `${title} is ${Math.round(progress ?? 0)}% done`;
}
const joined = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ');

/** Title and body for one event, from its type, its data and what the project says. */
export function eventWords(type: CounterpartEventType, data: CounterpartEvent['data'], context: WordsContext): {title: string; body: string; notify: NotifyLevel} {
  const t = context.title, printer = context.printer ?? 'Your printer';
  const remaining = data?.remainingSec !== undefined ? duration(data.remainingSec) : undefined;
  const layers = data?.layer !== undefined && data.totalLayers ? `layer ${data.layer} of ${data.totalLayers}` : undefined;
  const problem = data?.problems?.[0]?.message;
  const preparing = data?.state === 'preparing';
  const ready = joined('Getting ready', data?.stage);
  const minutes = data?.estimateSec !== undefined ? Math.max(1, Math.round(data.estimateSec / 60)) : undefined;
  const pkg = context.package ?? 'the printer MCP';
  const versions = data?.fromVersion && data.toVersion ? `${data.fromVersion} to ${data.toVersion}` : data?.toVersion;
  let title: string, body: string;
  switch (type) {
    case 'pass.started': title = `Your Mac is working on ${t}`; body = minutes ? `About ${minutes} min. You can put your phone down.` : "You can put your phone down. We'll let you know when it's ready."; break;
    case 'pass.stage': title = t; body = joined(data?.stage, minutes ? `about ${minutes} min` : undefined) || 'Working on it'; break;
    // A new design of something already printed names the new one and never implies the printed one went away (#616).
    case 'pass.ready': title = context.printedBefore ? `Your new ${t} design is ready` : `${t} is ready to print`;
      body = context.printedBefore ? joined('The printed one is unchanged', context.size) : context.size ?? 'Ready to print'; break;
    case 'pass.ask': title = `${t}: ${context.question ?? 'can you take a close-up?'}`; body = 'Take a photo, choose one, or let your Mac make its best guess.'; break;
    case 'pass.failed': title = `${t} didn't finish`; body = context.reason ?? 'Something went wrong on your Mac. Try again.'; break;
    case 'print.preparing': title = `Getting ${t} ready`; body = data?.stage ?? 'Preparing the print'; break;
    case 'print.confirm': title = `${printer} needs a yes before printing ${t}`; body = 'Open Counterpart to answer.'; break;
    // Until the first layer the printer is getting ready (heating, cleaning, levelling): no percent, no time left.
    case 'print.started': title = preparing ? `${printer} started ${t}` : `Printing ${t} on ${printer}`; body = preparing ? ready : data?.stage ?? 'Started'; break;
    case 'print.status': title = t; body = preparing ? ready
      : joined(data?.progress !== undefined ? `${Math.round(data.progress)}%` : undefined, remaining ? `${remaining} left` : undefined, layers) || (data?.state ?? 'Printing'); break;
    case 'print.first-layer': title = `${t}: first layer's down`; body = remaining ? `${remaining} left on ${printer}` : printer; break;
    case 'print.milestone': title = milestoneTitle(t, data?.progress); body = joined(remaining ? `${remaining} left` : undefined, layers, printer); break;
    case 'print.paused': title = `${printer} paused ${t}`; body = problem ?? 'Open Counterpart to resume.'; break;
    case 'print.resumed': title = t; body = `Printing again on ${printer}`; break;
    case 'print.done': title = `${t} is done`; body = 'Take it off the plate.'; break;
    case 'print.failed': title = `${printer} stopped ${t}`; body = printerStopped(data?.problems?.[0]); break;
    case 'print.cancelled': title = `${t} was cancelled`; body = 'Nothing more will print.'; break;
    // `reason`: the printer service refused it before anything reached the printer, in its own words.
    case 'print.not-started': title = `${printer} didn't start ${t}`; body = context.reason ?? 'Nothing was sent twice. Check the printer, then press Print again.'; break;
    case 'print.unreachable': title = `Lost contact with ${printer}`; body = 'Still trying.'; break;
    case 'settings.changed': title = 'Counterpart settings'; body = 'Settings updated'; break;
    case 'project.updated': title = t; body = 'Project updated'; break;
    case 'project.deleted': title = t; body = 'Project deleted'; break;
    case 'print.sent': title = `Sent ${t} to ${printer}`; body = context.reason === 'bambu-connect' ? 'Finish on your Mac: press Print in Bambu Connect.' : "Counterpart can't follow this print."; break;
    case 'mcp.update.started': title = `Updating ${pkg}`; body = joined(versions, context.printer) || 'Updating'; break;
    case 'mcp.update.waiting': title = `${pkg} updates as soon as Counterpart finishes with this printer`; body = joined(versions, context.printer) || 'Waiting for Counterpart to finish sending, slicing or designing'; break;
    // `reason`: an automatic update says it happened by itself, and from which version (Q9).
    case 'mcp.update.done': title = data?.toVersion ? `Updated ${pkg} to ${data.toVersion}` : `Updated ${pkg}`; body = context.reason ?? (context.printer ? `${context.printer} uses it now.` : 'Your printers use it now.'); break;
    case 'mcp.update.failed': title = `Couldn't update ${pkg}`;
      // `reason`: the previous version couldn't be put back, so it isn't "still in use".
      body = context.reason ?? `${data?.fromVersion ?? 'The version you had'} is still in use. Try again, or install a fresh copy.`; break;
  }
  return {title: title.slice(0, 200), body: body.slice(0, 500), notify: NOTIFY[type]};
}

// ---------------------------------------------------------------------------
// The project's status line (PRD §4 state table)

export interface StatusSource extends TitleSource {
  versions?: {id: string; outcome?: string; printedAtMs?: number; sealedAtMs: number}[];
  prints?: {versionId?: string; startedAtMs: number; monitor?: {endState?: string; endedAt?: string}}[];
  photos?: string[];
  state: string;
  progress?: string;
  question?: {closeup?: string};
  ask?: {question: string; status: string};
  current?: {sizeMm?: readonly number[]};
  failure?: string;
  passes?: {stages?: {words: string; endedAtMs?: number}[]; estimate?: {remainingSec: number}; endedAtMs?: number}[];
  print?: {destination?: {name: string}; dispatchedAt?: string; sentVia?: string;
    live?: {state: string; job?: {progress?: number; remainingSec?: number; layer?: number; stage?: string}};
    monitor?: {phase: string; endedAt?: string}};
}

const formatDate = (iso: string) => new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(new Date(iso));

/**
 * The most a row's `detail` may be: what fits the two lines a list row gives it on the narrowest sidebar (the
 * iPad's), so no client ever cuts it mid-word where the meaning is.
 */
export const DETAIL_MAX = 80;
/**
 * The row's own line: all of it when it fits; else its first sentence; else cut at a word with an ellipsis.
 * `reason` takes the first sentence whatever the length: a stopped pass's row is why it stopped, and "Try again or
 * review the saved checkpoint" is the project page's job.
 */
export function rowDetail(text: string | undefined, reason = false): string | undefined {
  const whole = text?.replace(/\s+/g, ' ').trim();
  if (!whole) return undefined;
  const first = whole.split(/(?<=[.?!])\s+/)[0]!;
  const line = whole.length <= DETAIL_MAX && !reason || first.length === whole.length ? whole : first.replace(/\.$/, '');
  if (line.length <= DETAIL_MAX) return line;
  const cut = line.slice(0, DETAIL_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length).replace(/[\s,;:·-]+$/, '')}…`;
}

/** The §4 line for a project, with its symbol and colour. */
export function objectStatus(object: StatusSource, updatedAtMs?: number): ObjectStatus {
  // #616: the newest design is unprinted and unanswered while an earlier one was printed. Both are true, so the line says
  // both. Every other case keeps today's words (a one-design project reads exactly as before; Done stays Done).
  const latest = object.versions?.at(-1);
  if (latest && object.versions!.length > 1 && !latest.outcome && !['new', 'touching-up', 'needs-closeup', 'printing', 'failed', 'sent', 'confirmed', 'printed'].includes(object.state)) {
    const printed = (version: typeof latest) => version.printedAtMs ?? object.prints?.filter(p => p.versionId === version.id && p.monitor?.endState === 'done').map(p => p.monitor?.endedAt ? Date.parse(p.monitor.endedAt) : p.startedAtMs).filter(Number.isFinite).sort((a,b) => b-a)[0];
    const earlier = printed(latest) === undefined ? object.versions!.slice(0,-1).map(printed).filter((n): n is number => n !== undefined).sort((a,b) => b-a)[0] : undefined;
    if (earlier !== undefined) {
      const when = formatDate(new Date(earlier).toISOString());
      return {phase: 'ready', text: `New one ready · printed ${when}`, detail: `Printed ${when} · that design is unchanged`, symbol: 'checkmark.seal', tint: 'accent'};
    }
  }
  const printer = object.print?.destination?.name ?? 'your printer';
  switch (object.state) {
    case 'new': return {phase: 'draft', text: object.scan || object.capture?.length || object.photos?.length
      ? 'Draft saved · finish sending to begin' : 'Add photos or a scan', symbol: 'square.and.pencil', tint: 'secondary'};
    case 'touching-up': {
      const pass = object.passes?.at(-1);
      const stage = pass?.stages?.filter(item => item.endedAtMs === undefined).at(-1)?.words ?? object.progress;
      const minutes = pass?.estimate ? Math.max(1, Math.round(pass.estimate.remainingSec / 60)) : undefined;
      const doing = joined(stage, minutes ? `about ${minutes} min` : undefined);
      const previousPrinted = object.versions?.some(v => v.printedAtMs !== undefined || object.prints?.some(p => p.versionId === v.id && p.monitor?.endState === 'done'));
      if (previousPrinted) return {phase: 'working', text: 'Making your changes · the one on your desk is unchanged', detail: rowDetail(doing) ?? 'The printed design is unchanged', symbol: 'wand.and.sparkles', tint: 'blue'};
      return {phase: 'working', text: joined('Your Mac is working', stage, minutes ? `about ${minutes} min` : undefined).slice(0, 300), ...(rowDetail(doing) ? {detail: rowDetail(doing)} : {}), symbol: 'wand.and.sparkles', tint: 'blue'};
    }
    case 'needs-closeup': {
      const question = object.ask?.question ?? (object.question?.closeup ? `Can you take a close-up of ${object.question.closeup}?` : undefined);
      return {phase: 'needs-you', text: joined('Needs you', question).slice(0, 300), ...(rowDetail(question) ? {detail: rowDetail(question)} : {}), symbol: 'hand.raised', tint: 'orange'};
    }
    case 'ready': { const size = sizeText(object.current?.sizeMm); return {phase: 'ready', text: joined('Ready to print', size), ...(size ? {detail: size} : {}), symbol: 'checkmark.seal', tint: 'accent'}; }
    case 'printing': {
      const live = object.print?.live, watching = object.print?.monitor?.phase === 'watching';
      if (!object.print?.dispatchedAt || !watching || !live) return {phase: 'preparing', text: 'Getting the print ready', symbol: 'gearshape', tint: 'accent'};
      // The printer has the job but is still heating, cleaning or levelling: "Printing · 3%" would be a lie.
      if (printPreparing(live.state, live.job)) return {phase: 'preparing', text: joined('Getting ready', live.job?.stage).slice(0, 300), symbol: 'gearshape', tint: 'accent'};
      const progress = live.job?.progress !== undefined ? `${Math.round(live.job.progress)}%` : undefined;
      const left = live.job?.remainingSec !== undefined ? `${duration(live.job.remainingSec)} left` : undefined;
      const paused = live.state === 'paused';
      return {phase: 'printing', text: joined(`${paused ? 'Paused' : 'Printing'} on ${printer}`, progress, paused ? undefined : left).slice(0, 300), symbol: 'printer.fill', tint: 'green'};
    }
    case 'printed': {
      const at = object.print?.monitor?.endedAt ?? object.print?.dispatchedAt ?? (updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined);
      return {phase: 'printed', text: at ? `Printed ${formatDate(at)}` : 'Printed', symbol: 'shippingbox', tint: 'secondary'};
    }
    // PRD §5.4: marked Works (Done on Home and in the Mac sidebar).
    case 'confirmed': return {phase: 'confirmed', text: 'Done · it works', symbol: 'checkmark.circle.fill', tint: 'green'};
    case 'sent': return {phase: 'sent', text: sentWords(object.print?.destination?.name ?? 'your printer', object.print?.sentVia === 'bambu-connect'), symbol: 'paperplane', tint: 'secondary'};
    // The row says why it stopped; what to do about it is the project page's.
    default: return {phase: 'failed', text: (object.failure ?? 'Something went wrong. Try again.').slice(0, 300), ...(rowDetail(object.failure, true) && rowDetail(object.failure, true) !== object.failure!.trim() ? {detail: rowDetail(object.failure, true)} : {}), symbol: 'exclamationmark.triangle', tint: 'red'};
  }
}
