import type {ObjectMessage, StmObject} from './store.js';

type Noted = Pick<StmObject, 'messages' | 'passes' | 'pendingMessageId' | 'completion'>;

const same = (a: ObjectMessage, b: ObjectMessage) => a.text.trim() === b.text.trim()
  && a.photos.length === b.photos.length && a.photos.every(name => b.photos.includes(name));

/**
 * A project as its conversation is shown: a note the person sent again before any result came back is one note.
 *
 * Before a note carried its sender's id, nothing recognised a repeat, and a note whose pass failed was simply sent
 * again: one real project holds the same note three times, eleven and fifteen minutes apart, each with its own pass
 * (failed, failed, done). The conversation showed all three. Stored data is never rewritten; this is how it is read.
 *
 * A later message repeats an earlier one when the words and photos are the same and no pass finished with a result
 * between the two being sent. The same words sent again after a result are a new request and stay, and so is an answer
 * to a question asked after the earlier one was sent ("Yes" to one question, then "Yes" to the next). The repeat that
 * is kept is the last (the one whose pass ran last), at the time the note was first sent; every reference to a
 * dropped copy (a pass's `messageId`, the held message, the Done note) points at the kept one, so no client finds a
 * pass whose message is missing and shows its note a second time.
 */
export function withNotesOnce<T extends Noted>(object: T): T {
  const messages = object.messages;
  if (!messages || messages.length < 2) return object;
  const results = object.passes.filter(pass => pass.endedAtMs !== undefined && (pass.status === undefined || pass.status === 'done' || pass.status === 'unchanged'))
    .map(pass => pass.endedAtMs!);
  const resultBetween = (from: number, to: number) => results.some(at => at > from && at < to);
  const questions = object.passes.filter(pass => pass.endedAtMs !== undefined && pass.status === 'needs_closeup').map(pass => pass.endedAtMs!);
  const answers = new Set(object.passes.filter(pass => pass.messageId && (pass.trigger === 'ask-answer' || pass.note?.includes('Answer to "'))).map(pass => pass.messageId!));
  const newAnswer = (earlier: ObjectMessage, later: ObjectMessage) => answers.has(later.id) && questions.some(at => at > earlier.atMs && at < later.atMs);
  const ordered = messages.map((message, index) => ({message, index})).sort((a, b) => a.message.atMs - b.message.atMs || a.index - b.index);
  // For each message, the id of the copy that stands for it.
  const kept = new Map<string, string>();
  const firstSent = new Map<string, number>();
  const groups: {last: ObjectMessage; firstAtMs: number}[] = [];
  for (const {message} of ordered) {
    const group = [...groups].reverse().find(item => same(item.last, message) && !resultBetween(item.last.atMs, message.atMs) && !newAnswer(item.last, message));
    if (group) { kept.set(group.last.id, message.id); group.last = message; }
    else groups.push({last: message, firstAtMs: message.atMs});
  }
  if (!kept.size) return object;
  const standsFor = (id: string): string => { let at = id; while (kept.has(at)) at = kept.get(at)!; return at; };
  for (const group of groups) firstSent.set(group.last.id, group.firstAtMs);
  const stand = <V extends string | undefined>(id: V): V => (id === undefined ? id : standsFor(id) as V);
  return {...object,
    messages: messages.filter(message => !kept.has(message.id)).map(message => ({...message, atMs: firstSent.get(message.id) ?? message.atMs})),
    passes: object.passes.map(pass => pass.messageId && kept.has(pass.messageId) ? {...pass, messageId: standsFor(pass.messageId)} : pass),
    ...(object.pendingMessageId ? {pendingMessageId: stand(object.pendingMessageId)} : {}),
    ...(object.completion?.messageId ? {completion: {...object.completion, messageId: stand(object.completion.messageId)}} : {})};
}
