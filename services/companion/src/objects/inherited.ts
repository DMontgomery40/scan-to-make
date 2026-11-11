import type {InheritedHistory} from '@scan-to-make/contracts/counterpart';
import type {StmObject} from './store.js';

/** Only sent words and ended replies. A pending message is held for retry, not part of the source's conversation. */
export function inheritHistory(source: StmObject, title: string): InheritedHistory {
  const items: InheritedHistory['items'] = [];
  const add = (at: number, who: 'you' | 'app', text?: string) => { if (text?.trim()) items.push({at, who, text}); };
  add(source.createdAtMs, 'you', source.instructions);
  for (const message of source.messages ?? []) {
    if (message.id !== source.pendingMessageId) add(message.atMs, 'you', message.text);
  }
  for (const pass of source.passes) {
    if (pass.endedAtMs === undefined) continue;
    if (!pass.messageId) add(pass.startedAtMs, 'you', pass.note);
    add(pass.endedAtMs, 'app', pass.summary);
  }
  if (source.completion && !source.completion.messageId) add(source.completion.atMs, 'you', source.completion.note);
  items.sort((a, b) => a.at - b.at);
  return {from: {id: source.id, title}, items: [...(source.inherited?.items ?? []), ...items]};
}
