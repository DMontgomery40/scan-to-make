import type {Ask, Size} from '@scan-to-make/contracts/counterpart';
import type {StmObject} from './store.js';

/** What a project is waiting on the person for: the one enumeration of waits (contracts `AskSchema.kind`). */
export type AskKind = NonNullable<Ask['kind']>;

/**
 * The kind of the open question. An ask saved before kinds were written says it the old way: by its `type`, and a
 * `choice` beside a reconstruction review by the review's own kind.
 */
export function askKind(object: Pick<StmObject, 'ask' | 'reconstructionReview'>): AskKind | undefined {
  const ask = object.ask;
  if (!ask) return undefined;
  if (ask.kind) return ask.kind;
  if (object.reconstructionReview) return object.reconstructionReview.kind === 'region' ? 'region' : 'scale';
  return ask.type ?? 'closeup';
}

export class InvalidSizesError extends Error {}

/**
 * The sizes a person sent back for a `sizes` ask: each must be one the ask listed, once, with a usable number.
 * Returns them with the ask's own labels, in the ask's order.
 */
export function answeredSizes(ask: Ask | undefined, sent: {id: string; mm: number}[]): (Size & {asked: number})[] {
  if (!ask?.sizes?.length) throw new InvalidSizesError('This question did not ask for sizes.');
  if (!sent.length) throw new InvalidSizesError('Enter at least one size.');
  const byId = new Map(sent.map(item => [item.id, item.mm]));
  if (byId.size !== sent.length || sent.some(item => !ask.sizes!.some(size => size.id === item.id)))
    throw new InvalidSizesError('Those sizes are not the ones this question asked for. Update Counterpart and try again.');
  if (sent.some(item => !Number.isFinite(item.mm) || item.mm <= 0 || item.mm > 10_000)) throw new InvalidSizesError('Enter each size in millimetres.');
  // Every client shows the asked number rounded to two decimals, so a field nobody touched comes back as that
  // rounded echo. It is the asked number, confirmed: it is kept exactly as asked, never stored or reported as a
  // measurement the person made (asked 68.412, shown 68.41, Confirm pressed).
  return ask.sizes.filter(size => byId.has(size.id)).map(size => {
    const sent = byId.get(size.id)!;
    return {id: size.id, label: size.label, mm: shown(sent) === shown(size.mm) ? size.mm : sent, asked: size.mm};
  });
}
/** A size at the precision every client shows it (`AskSizesForm.text`, its Kotlin and Linux twins). */
const shown = (value: number) => Math.round(value * 100) / 100;

const mm = (value: number) => String(Number(value.toPrecision(12)));

/** What the worker is told: numbers the person confirmed or measured, never a sentence to interpret. */
export function sizesNote(sizes: (Size & {asked: number})[]): string {
  const lines = sizes.map(size => `- ${size.label}: ${mm(size.mm)} mm${size.mm === size.asked ? ' (confirmed)' : ` (corrected; you had ${mm(size.asked)} mm)`}`);
  return ['The person checked the sizes you asked about on the real object. Treat these as measured:', ...lines].join('\n');
}
