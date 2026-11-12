import type {Fit, InheritedHistory} from '@scan-to-make/contracts/counterpart';

const mm = (value: number) => String(Number(value.toPrecision(12)));

/** How the source's size was settled, said as that project's, so its directions never read as the new request's. */
function settled(title: string, fit: Fit): string {
  if (fit.sizeSource === 'measured' && fit.measured?.length)
    return `Sizes the person measured on the real object for “${title}”: ${fit.measured.map(size => `${size.label} ${mm(size.mm)} mm`).join(', ')}. Treat these as measured.`;
  if (fit.sizeSource === 'scan') return `“${title}” was sized from the scan's own measurements.`;
  return `“${title}” was to be sized from the product's published dimensions.`;
}

/** Previous conversation is evidence, not a replacement for the new request. */
export function inheritedBrief(history?: InheritedHistory): string | undefined {
  if (!history?.items.length && !history?.fit) return undefined;
  const line = (item: InheritedHistory['items'][number]) => `${new Date(item.at).toISOString()} · ${item.who === 'you' ? 'Person' : 'Counterpart'}: ${item.text}`;
  const generations = history.items.some(item => item.from);
  const lines: string[] = [];
  let said: string | undefined;
  for (const item of history.items) {
    // A source made from another brings that conversation too, each part under the project it was said in.
    const from = item.from ?? history.from;
    if (generations && from.id !== said) { lines.push(item.from ? `Earlier, in “${from.title}”:` : `Then, in “${from.title}”:`); said = from.id; }
    lines.push(line(item));
  }
  return [`What was asked and answered for the project this came from: “${history.from.title}”.`,
    'Use these answers as context. Do not ask again for information already answered here. The new request below says what to make now.',
    ...lines, ...(history.fit ? [settled(history.from.title, history.fit)] : [])].join('\n');
}
