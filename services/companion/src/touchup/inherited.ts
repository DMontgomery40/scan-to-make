import type {InheritedHistory} from '@scan-to-make/contracts/counterpart';

/** Previous conversation is evidence, not a replacement for the new request. */
export function inheritedBrief(history?: InheritedHistory): string | undefined {
  if (!history?.items.length) return undefined;
  return [`What was asked and answered for the project this came from: “${history.from.title}”.`,
    'Use these answers as context. Do not ask again for information already answered here. The new request below says what to make now.',
    ...history.items.map(item => `${new Date(item.at).toISOString()} · ${item.who === 'you' ? 'Person' : 'Counterpart'}: ${item.text}`)].join('\n');
}
