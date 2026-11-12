import type {Ask, Size, SizeFrom} from '@scan-to-make/contracts/counterpart';
import type {CheckedSize, StmObject} from './store.js';

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

/** A size the person sent back: the ask's own size (its label, source and number as `asked`), their number, and how
 *  they checked it (#622). */
export type AnsweredSize = Size & {asked: number; certainty: 'measured' | 'accepted'; from?: SizeFrom; product?: string; reference?: string};

/**
 * The sizes a person sent back for a `sizes` ask: each must be one the ask listed, once, with a usable number.
 * Returns them with the ask's own labels and sources, in the ask's order. `measured` is the ids the person typed or
 * edited (`SizesAnswerSchema`); a client from before it sends none, and then only a changed number is measured.
 */
export function answeredSizes(ask: Ask | undefined, sent: {id: string; mm: number}[], measured?: string[]): AnsweredSize[] {
  if (!ask?.sizes?.length) throw new InvalidSizesError('This question did not ask for sizes.');
  if (!sent.length) throw new InvalidSizesError('Enter at least one size.');
  const byId = new Map(sent.map(item => [item.id, item.mm]));
  if (byId.size !== sent.length || sent.some(item => !ask.sizes!.some(size => size.id === item.id)))
    throw new InvalidSizesError('Those sizes are not the ones this question asked for. Update Counterpart and try again.');
  if (sent.some(item => !Number.isFinite(item.mm) || item.mm <= 0 || item.mm > 10_000)) throw new InvalidSizesError('Enter each size in millimetres.');
  const typed = new Set(measured ?? []);
  // Every client shows the asked number rounded to two decimals, so a field nobody touched comes back as that
  // rounded echo. It is the asked number, accepted: it is kept exactly as asked, never stored or reported as a
  // measurement the person made (asked 68.412, shown 68.41, Confirm pressed). A changed number is always measured;
  // the same number is measured only when the client says the person typed it.
  return ask.sizes.filter(size => byId.has(size.id)).map(size => {
    const sent = byId.get(size.id)!, same = shown(sent) === shown(size.mm), certainty = !same || typed.has(size.id) ? 'measured' as const : 'accepted' as const;
    return {id: size.id, label: size.label, mm: same && certainty === 'accepted' ? size.mm : sent, asked: size.mm, certainty,
      from: size.from, ...(size.product ? {product: size.product} : {}), ...(size.reference ? {reference: size.reference} : {})};
  });
}
/** A size at the precision every client shows it (`AskSizesForm.text`, its Kotlin and Linux twins). */
const shown = (value: number) => Math.round(value * 100) / 100;

const mm = (value: number) => String(Number(value.toPrecision(12)));
const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A stored size's check, with the word stored before Nov 12 read as what it was: an untouched number, accepted. */
const checkOf = (size: Pick<CheckedSize, 'certainty'>): 'measured' | 'accepted' => size.certainty === 'measured' ? 'measured' : 'accepted';

/**
 * The project's checked sizes after an answer: each answered size replaces the one with its label, or is added. A
 * size the person left blank isn't in the answer, so its earlier value stays; so does one this question never listed.
 * An accepted number never replaces a size the person measured under the same label: a measurement outranks a number
 * let stand (a later question prefilled with their own measurement and confirmed untouched stays measured).
 */
export function mergeCheckedSizes(earlier: CheckedSize[] | undefined, answered: AnsweredSize[]): CheckedSize[] {
  const merged = [...(earlier ?? [])];
  for (const size of answered) {
    const checked: CheckedSize = {label: size.label, mm: size.mm, certainty: size.certainty, ...(size.from ? {from: size.from} : {}),
      ...(size.product ? {product: size.product} : {}), ...(size.reference ? {reference: size.reference} : {}), asked: size.asked};
    const at = merged.findIndex(item => sameLabel(item.label, size.label));
    if (at < 0) merged.push(checked);
    else if (!(size.certainty === 'accepted' && checkOf(merged[at]!) === 'measured')) merged[at] = checked;
  }
  return merged.slice(-24);
}

/**
 * A size the person measured that New also measured under the same label takes the person's newer number there too.
 * An accepted number never does: New's "I measured" sizes are the person's own, and an untouched Confirm of the Mac's
 * number is not one (#622).
 */
export function withCheckedSizes<T extends Pick<StmObject, 'fit'>>(object: T, answered: AnsweredSize[]): T['fit'] {
  const fit = object.fit;
  if (!fit?.measured) return fit;
  return {...fit, measured: fit.measured.map(item => {
    const newer = answered.find(size => size.certainty === 'measured' && sameLabel(size.label, item.label));
    return newer ? {...item, mm: newer.mm} : item;
  })};
}

/** Where the Mac's number came from, in the worker's terms. Never "measured": that is only ever the person's. */
function sourceWords(size: {from?: SizeFrom; product?: string; reference?: string}): string {
  switch (size.from) {
    case 'published': return `published for ${size.product ?? 'a product that was not named'}${size.reference ? ` (source: ${size.reference})` : ''}`;
    case 'scan': return 'read from the scan, not a measurement';
    case 'estimate': return 'your estimate, not a measurement';
    default: return 'its source was not recorded, so it is not a measurement';
  }
}

/** One size as the worker reads it: the number, how the person checked it, and for an accepted one where it came from. */
function sizeLine(size: {label: string; mm: number; certainty: 'measured' | 'accepted'; asked?: number; from?: SizeFrom; product?: string; reference?: string}): string {
  if (size.certainty === 'measured')
    return `- ${size.label}: ${mm(size.mm)} mm, measured by the person${size.asked !== undefined && shown(size.asked) !== shown(size.mm) ? ` (you had ${mm(size.asked)} mm)` : ''}`;
  return `- ${size.label}: ${mm(size.mm)} mm, accepted; ${sourceWords(size)}`;
}

const ACCEPTED = 'An accepted size is a number you offered that the person let stand without changing it: it is exactly as certain as where it came from, so an accepted published size is the published size of the product it names, and an accepted estimate or scan reading is not a measurement.';

/**
 * What every later pass is told about them: each size by its own label, how the person checked it and, for one they
 * accepted, where the number came from. These are sizes of the features the question named ("width at the waist"),
 * so never "the overall size". Only a measured size is the most certain kind there is; how a fit uses an accepted
 * one is the fit rules' (the printer MCPs'), not this brief's. A size stored as `confirmed` before Nov 12 is accepted.
 */
export function checkedSizesBrief(sizes: CheckedSize[] | undefined): string | undefined {
  if (!sizes?.length) return undefined;
  // New's overall sizes come earlier in the request under looser names ("width"); a checked size can be about the
  // same feature under its own ("width at the widest point"). The worker is told which wins, not left to choose.
  return ['Sizes from the person\'s answers to your earlier questions, each for the feature it names. Only the ones marked "measured by the person" were measured on the real object: they are newer than any size earlier in this request, so where one is about the same feature as an earlier size (an overall width and the width at the widest point), use it. They are the most certain sizes you have: use them for those features, and do not ask for them again. ' + ACCEPTED + ' An accepted size never outranks a size the person measured.',
    ...sizes.map(size => sizeLine({...size, certainty: checkOf(size)}))].join('\n');
}

/** What the worker is told right after the answer: each number, which the person measured and which they accepted. */
export function sizesNote(sizes: AnsweredSize[]): string {
  return ['The person answered the sizes you asked about. Only the ones marked "measured by the person" were measured on the real object. ' + ACCEPTED,
    ...sizes.map(sizeLine)].join('\n');
}

/** The person's own message for a sizes answer, as the project's conversation shows it: each number and how it was checked. */
export function sizesMessage(sizes: AnsweredSize[]): string {
  return sizes.map(size => `${size.label}: ${mm(size.mm)} mm (${size.certainty === 'measured' ? 'measured' : 'accepted as asked'})`).join('\n');
}
