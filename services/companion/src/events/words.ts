import type {CounterpartEvent, CounterpartEventType, NotifyLevel, ObjectStatus} from '@scan-to-make/contracts/counterpart';

/**
 * Every sentence Counterpart shows about a project's progress comes from here
 * (PRD §8.7), so the Mac, the phone, the Lock Screen and the menu bar all say
 * the same thing. Kept free of I/O: callers pass what they know.
 */

export interface TitleSource {title?: string; instructions?: string; scan?: string; capture?: string[]}

/** The generated title, else the first words of the request, else a plain name. */
export function projectTitle(object: TitleSource): string {
  if (object.title?.trim()) return object.title.trim().slice(0, 80);
  const request = object.instructions?.replace(/\s+/g, ' ').trim();
  if (request) {
    const words = request.split(' ');
    const short = words.slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '');
    return (words.length > 6 ? `${short}…` : short).slice(0, 80);
  }
  return object.scan || object.capture?.length ? 'Your scan' : 'Your project';
}

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

export interface PrinterProblem {code: string; message?: string; url?: string}
/** Bambu's page for an HMS code (the link Bambu Studio opens): AAAA_BBBB_CCCC_DDDD. */
export function problemUrl(problem: PrinterProblem): string | undefined {
  if (problem.url) return problem.url;
  return /^[0-9A-F]{4}(?:_[0-9A-F]{4}){3}$/i.test(problem.code)
    ? `https://e.bambulab.com/index.php?e=${problem.code.replaceAll('_', '').toUpperCase()}&s=device_hms&lang=en` : undefined;
}
/** A message that says nothing beyond the code (Bambu has no text for it, or only the code came through). */
const noText = (problem: PrinterProblem) => {
  const message = problem.message?.trim() ?? '';
  return !message || message === problem.code || /no description|^the printer reported (?:problem|error) /i.test(message);
};
/** "The printer stopped: <its message>", or, when Bambu has no words for the code, where to look. */
export function printerStopped(problem: PrinterProblem | undefined): string {
  if (!problem) return "The printer stopped. Check the printer's screen.";
  return noText(problem) ? `The printer stopped (${problem.code}). Check the printer's screen.` : `The printer stopped: ${problem.message?.trim()}`;
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
  printer?: string;
  /** "60 × 45 × 22 mm" */
  size?: string;
  item?: string;
  question?: string;
  reason?: string;
}

export const NOTIFY: Record<CounterpartEventType, NotifyLevel> = {
  'pass.started': 'none', 'pass.stage': 'none', 'pass.ready': 'active', 'pass.ask': 'active', 'pass.failed': 'active',
  'print.preparing': 'none', 'print.confirm': 'timeSensitive', 'print.started': 'passive',
  'print.status': 'none', 'print.first-layer': 'passive', 'print.milestone': 'active', 'print.paused': 'timeSensitive',
  'print.resumed': 'none', 'print.done': 'active', 'print.failed': 'timeSensitive', 'print.cancelled': 'passive',
  'print.not-started': 'timeSensitive', 'print.unreachable': 'passive', 'print.sent': 'passive',
  'project.updated': 'none',
};

export function sizeText(sizeMm: readonly number[] | undefined): string | undefined {
  if (!sizeMm || sizeMm.length !== 3 || !sizeMm.every(value => Number.isFinite(value) && value > 0)) return undefined;
  return `${sizeMm.map(value => Math.round(value)).join(' × ')} mm`;
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
  let title: string, body: string;
  switch (type) {
    case 'pass.started': title = `Your Mac is working on ${t}`; body = minutes ? `About ${minutes} min. You can put your phone down.` : "You can put your phone down. We'll let you know when it's ready."; break;
    case 'pass.stage': title = t; body = joined(data?.stage, minutes ? `about ${minutes} min` : undefined) || 'Working on it'; break;
    case 'pass.ready': title = `${t} is ready to print`; body = context.size ?? 'Ready to print'; break;
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
    case 'print.not-started': title = `${printer} didn't start ${t}`; body = 'Nothing was sent twice. Check the printer, then press Print again.'; break;
    case 'print.unreachable': title = `Lost contact with ${printer}`; body = 'Still trying.'; break;
    case 'project.updated': title = t; body = 'Project updated'; break;
    case 'print.sent': title = `Sent ${t} to ${printer}`; body = context.reason === 'bambu-connect' ? 'Finish on your Mac: press Print in Bambu Connect.' : "Counterpart can't follow this print."; break;
  }
  return {title: title.slice(0, 200), body: body.slice(0, 500), notify: NOTIFY[type]};
}

// ---------------------------------------------------------------------------
// The project's status line (PRD §4 state table)

export interface StatusSource extends TitleSource {
  state: string;
  progress?: string;
  question?: {closeup?: string};
  ask?: {question: string; status: string};
  current?: {sizeMm?: readonly number[]};
  failure?: string;
  passes?: {stages?: {words: string; endedAtMs?: number}[]; estimate?: {remainingSec: number}; endedAtMs?: number}[];
  print?: {destination?: {name: string}; dispatchedAt?: string; sentVia?: string;
    live?: {state: string; job?: {progress?: number; remainingSec?: number; layer?: number; stage?: string}; problems?: PrinterProblem[]};
    monitor?: {phase: string; endedAt?: string; endState?: string}};
}

const formatDate = (iso: string) => new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(new Date(iso));

/** The §4 line for a project, with its symbol and colour. */
export function objectStatus(object: StatusSource, updatedAtMs?: number): ObjectStatus {
  const printer = object.print?.destination?.name ?? 'your printer';
  switch (object.state) {
    case 'new': return {phase: 'sending', text: 'Sending to your Mac', symbol: 'arrow.up.circle', tint: 'blue'};
    case 'touching-up': {
      const pass = object.passes?.at(-1);
      const stage = pass?.stages?.filter(item => item.endedAtMs === undefined).at(-1)?.words ?? object.progress;
      const minutes = pass?.estimate ? Math.max(1, Math.round(pass.estimate.remainingSec / 60)) : undefined;
      return {phase: 'working', text: joined('Your Mac is working', stage, minutes ? `about ${minutes} min` : undefined).slice(0, 300), symbol: 'wand.and.sparkles', tint: 'blue'};
    }
    case 'needs-closeup': {
      const question = object.ask?.question ?? (object.question?.closeup ? `Can you take a close-up of ${object.question.closeup}?` : undefined);
      return {phase: 'needs-you', text: joined('Needs you', question).slice(0, 300), symbol: 'hand.raised', tint: 'orange'};
    }
    case 'ready': return {phase: 'ready', text: joined('Ready to print', sizeText(object.current?.sizeMm)), symbol: 'checkmark.seal', tint: 'accent'};
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
    default: {
      // A print the printer stopped links to Bambu's page for its code.
      const problem = object.print?.monitor?.endState === 'failed' ? object.print.live?.problems?.[0] : undefined;
      const url = problem ? problemUrl(problem) : undefined;
      return {phase: 'failed', text: (object.failure ?? 'Something went wrong. Try again.').slice(0, 300), symbol: 'exclamationmark.triangle', tint: 'red', ...(url ? {url} : {})};
    }
  }
}
