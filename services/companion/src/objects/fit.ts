import {FitSchema, type Fit} from '@scan-to-make/contracts/counterpart';
import type {StmObject} from './store.js';
import {checkedSizesBrief} from './asks.js';

/**
 * A fit project's request is two things: what the person typed, and how the size is settled (`fit`). Until Nov 10
 * the phone and Android appended the second to the first as a "Fit brief:" block of text, and every client then
 * showed that block back as the person's own words. Now `instructions` is what they typed, `fit` is fields, and
 * this module composes the worker's brief from both.
 *
 * The brief's sentences are the ones the clients generated, moved here unchanged so the worker reads what it read
 * before. They are design guidance and are due to move to the printer MCPs as a prompt (PRD §8.0).
 */
const HEADING = 'Fit brief:';
const MATING = '- The scanned object is the thing the printed part must fit, hold, mount or adapt to. Do not print a copy of the scanned object itself.';
const LOOKUP = "- Dimensions: identify the exact product and variant from the scan and photos, look up the manufacturer's published dimensions, and ask me to confirm the product and size before designing anything that depends on them. If you cannot identify it exactly, ask for caliper measurements or a photo with calipers instead of silently using the scan's size.";
const MEASURED = ['- Dimensions I measured on the real object: ', '. Treat these as the exact overall size. If the scan differs by more than 2 mm or 2%, ask before designing anything fit-critical.'] as const;
const SCAN = "- Dimensions: use the scan's measured size, say the clearance you allowed, and mark every fit-critical size as estimated.";

const mm = (value: number) => String(Number(value.toPrecision(12)));

/** The brief the worker reads below the person's words. */
export function fitBrief(fit: Fit): string {
  const size = fit.sizeSource === 'measured' ? `${MEASURED[0]}${(fit.measured ?? []).map(item => `${item.label} ${mm(item.mm)} mm`).join(', ')}${MEASURED[1]}`
    : fit.sizeSource === 'scan' ? SCAN : LOOKUP;
  return [HEADING, MATING, size].join('\n');
}

/**
 * A request saved before `fit` was a field: the person's words, then the block a client appended. This reads our own
 * old format back, at the exact text the clients generated; anything else is left as the person's words.
 */
export function splitFitBrief(instructions: string | undefined): {typed?: string; fit?: Fit} {
  const text = instructions?.trim();
  if (!text) return {};
  const marker = `\n\n${HEADING}\n${MATING}\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return {typed: text};
  const typed = text.slice(0, at).trim(), line = text.slice(at + marker.length).trim();
  let fit: Fit | undefined;
  if (line === LOOKUP) fit = {sizeSource: 'lookup'};
  else if (line === SCAN) fit = {sizeSource: 'scan'};
  else if (line.startsWith(MEASURED[0]) && line.endsWith(MEASURED[1])) {
    const sizes = line.slice(MEASURED[0].length, line.length - MEASURED[1].length).split(', ').map(part => /^(.+) (\d+(?:\.\d+)?) mm$/.exec(part));
    if (sizes.length && sizes.every(Boolean)) {
      const parsed = FitSchema.safeParse({sizeSource: 'measured', measured: sizes.map(match => ({id: match![1], label: match![1], mm: Number(match![2])}))});
      if (parsed.success) fit = parsed.data;
    }
  }
  // A block that isn't one a client wrote stays part of the request: nothing is guessed.
  return fit && typed ? {typed, fit} : {typed: text};
}

type Request = Pick<StmObject, 'instructions' | 'fit' | 'checkedSizes'>;
/** What the person typed, and how the size is settled, whichever way the project stored them. */
export function fitRequest(object: Request): {typed?: string; fit?: Fit} {
  const saved = splitFitBrief(object.instructions);
  // The field wins. A request that still carries a client's old block beside it (a fit-only change to a draft saved
  // before the field) is read without the block, or the worker would get the brief twice.
  if (object.fit) return {...(saved.typed ? {typed: saved.typed} : {}), fit: object.fit};
  return saved;
}
/** The request as the worker reads it: the person's words, then the brief. */
export function workerRequest(object: Request): string | undefined {
  const {typed, fit} = fitRequest(object);
  // Sizes the person checked in answer to a question follow on any project, a fit or not.
  const parts = [typed, typed && fit ? fitBrief(fit) : undefined, checkedSizesBrief(object.checkedSizes)].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}
