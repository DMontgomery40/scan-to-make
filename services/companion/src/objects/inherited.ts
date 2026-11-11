import type {InheritedHistory} from '@scan-to-make/contracts/counterpart';
import type {ObjectPass, StmObject} from './store.js';
import {fitRequest} from './fit.js';
import {withNotesOnce} from './notes.js';

type Item = InheritedHistory['items'][number];

const ANSWER = 'Answer to "';
/** What `#reservedAnswerCloseup` writes when the project held no question: not a question to carry. */
const NO_QUESTION = 'your question';

/**
 * The question an answering pass's note names. An answer in words is stored bare as the person's message, and the
 * question meets it only in the pass's note, `Answer to "<question>": <answer>`. That note begins with the asking
 * pass's own note, which repeats any earlier answers of the same correction, so the last such line is this answer's.
 */
export function answeredQuestion(note: string | undefined, answer: string | undefined): string | undefined {
  const words = answer?.trim();
  if (!note || !words) return undefined;
  const end = note.lastIndexOf(`": ${words}`);
  const start = end < 0 ? -1 : note.lastIndexOf(ANSWER, end);
  if (start < 0) return undefined;
  const question = note.slice(start + ANSWER.length, end).trim();
  return question && question !== NO_QUESTION ? question : undefined;
}

/**
 * The conversation of the project a new one is made from, as it was shown and as its worker read it, snapshotted now.
 *
 * Read as every client reads it: a note sent again before a result came back is one note (`withNotesOnce`), and the
 * request is what the person typed, never the "Fit brief:" block an older client appended (`fitRequest`); how the
 * size was settled, measured sizes included, travels as `fit`. Each question the Mac asked sits with its answer: from
 * the pass that asked it (`question`, since Nov 11), else from the answering pass's note, else, for the question still
 * on the project, from its `ask`. Only sent words and ended replies: a pending message is held for retry, not part of
 * the conversation. A source that was itself made from another brings that history first, each item naming the
 * project it was said in.
 */
export function inheritHistory(stored: StmObject, title: string): InheritedHistory {
  const source = withNotesOnce(stored);
  const {typed, fit} = fitRequest(source);
  const items: Item[] = [];
  const add = (at: number, who: 'you' | 'app', text?: string) => { if (text?.trim()) items.push({at, who, text}); };
  add(source.createdAtMs, 'you', typed);
  const messages = new Map((source.messages ?? []).map(message => [message.id, message]));
  for (const message of messages.values()) {
    if (message.id !== source.pendingMessageId) add(message.atMs, 'you', message.text);
  }
  const ask = source.ask;
  let askPlaced = false;
  const designPasses = source.passes.filter(pass => pass.trigger !== 'locate');
  for (const pass of source.passes) {
    if (pass.endedAtMs === undefined) continue;
    if (!pass.messageId) add(pass.startedAtMs, 'you', pass.note);
    add(pass.endedAtMs, 'app', pass.summary);
    if (pass.status !== 'needs_closeup') continue;
    const asksNow = !!ask && ask.askedAtMs >= pass.startedAtMs && ask.askedAtMs <= pass.endedAtMs;
    if (asksNow) askPlaced = true;
    const question = pass.question ?? answerOf(pass, designPasses, messages) ?? (asksNow ? ask!.question : undefined);
    if (question && !pass.summary?.includes(question)) add(pass.endedAtMs, 'app', question);
  }
  // A question asked without a pass (which published file to print, say).
  if (ask && !askPlaced) add(ask.askedAtMs, 'app', ask.question);
  if (source.completion && !source.completion.messageId) add(source.completion.atMs, 'you', source.completion.note);
  items.sort((a, b) => a.at - b.at);
  const earlier = source.inherited ? source.inherited.items.map(item => item.from ? item : {...item, from: source.inherited!.from}) : [];
  return {from: {id: source.id, title}, items: [...earlier, ...items], ...(fit ? {fit} : {})};
}

/** The question an older asking pass ended on, from the note of the next design pass when that pass answered it. */
function answerOf(pass: ObjectPass, designPasses: ObjectPass[], messages: Map<string, {text: string}>): string | undefined {
  const next = designPasses[designPasses.indexOf(pass) + 1];
  if (!next?.messageId) return undefined;
  return answeredQuestion(next.note, messages.get(next.messageId)?.text);
}
