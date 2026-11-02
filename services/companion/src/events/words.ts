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

/** The failure sentence for a print that ended without finishing (PRD §8.6). */
export function printEndFailure(end: 'failed' | 'not-started' | 'replaced', context: {title: string; printer: string; problem?: string}): string {
  switch (end) {
    case 'not-started': return `${context.printer} didn't start ${context.title}. Nothing was sent twice.`;
    case 'replaced': return `${context.printer} is printing something else.`;
    case 'failed': return context.problem ? `${context.printer} stopped ${context.title}: ${context.problem}` : `${context.printer} stopped ${context.title}. Check the printer, then try again.`;
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
