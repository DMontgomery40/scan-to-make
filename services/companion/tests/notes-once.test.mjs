import test from 'node:test';
import assert from 'node:assert/strict';
import {withNotesOnce} from '../dist/objects/notes.js';
import {publicObject} from '../dist/objects/http.js';

const base = extra => ({id: 'p', createdAtMs: 1, updatedAtMs: 2, state: 'ready', photos: [], requestPhotos: [], pendingPhotos: [], messages: [], passes: [], ...extra});
const note = (id, atMs, text, photos = []) => ({id, atMs, text, photos});
const pass = (startedAtMs, endedAtMs, status, messageId, noteText) => ({startedAtMs, ...(endedAtMs ? {endedAtMs} : {}), status, trigger: messageId ? 'changes' : 'new', ...(messageId ? {messageId, note: noteText} : {})});

// The shape of a real project on Nov 10 (board X67): one note sent three times, eleven and fifteen minutes apart,
// because its pass failed twice; each copy has its own pass. Stored before a note carried its sender's id.
const stove = base({
  messages: [note('m1', 1000, 'After printing: it needs rotating.'), note('m2', 5000, 'redo this with the new prompts'), note('m3', 6000, 'redo this with the new prompts'), note('m4', 7000, ' redo this with the new prompts ')],
  passes: [pass(100, 200, 'done'), pass(300, 400, 'done'), pass(1010, 1500, 'done', 'm1', 'After printing: it needs rotating.'),
    pass(5010, 5500, 'failed', 'm2', 'redo this with the new prompts'), pass(6010, 6500, 'failed', 'm3', 'redo this with the new prompts'), pass(7010, 7900, 'done', 'm4', 'redo this with the new prompts')],
});

test('a note sent again before any result came back is shown once, and nothing stored changes', () => {
  const before = structuredClone(stove);
  const shown = withNotesOnce(stove);
  assert.deepEqual(stove, before, 'the stored record is not rewritten');
  assert.deepEqual(shown.messages.map(m => [m.id, m.atMs]), [['m1', 1000], ['m4', 5000]], 'the copy whose pass ran last, at the time the note was first sent');
  // Every pass that a dropped copy started points at the kept note, so no client shows the pass's own note again.
  assert.deepEqual(shown.passes.map(p => p.messageId), [undefined, undefined, 'm1', 'm4', 'm4', 'm4']);
  assert.equal(shown.passes.length, 6, 'the three passes are still there, each saying how it ended');
  // Every client reads the public projection.
  const wire = publicObject(stove);
  assert.equal(wire.messages.filter(m => m.text.trim() === 'redo this with the new prompts').length, 1);
  for (const p of wire.passes.filter(item => item.messageId)) assert.ok(wire.messages.some(m => m.id === p.messageId), 'no pass names a message that is not there');
});

test('two copies 98 seconds apart, the first pass failed (the Guitar pick)', () => {
  const pick = base({state: 'confirmed', messages: [note('a', 1000, 'too thick'), note('b', 2000, 'bad quality'), note('c', 2098, 'bad quality'), note('d', 9000, 'Design again')],
    passes: [pass(10, 20, 'done'), pass(1005, 1500, 'done', 'a', 'too thick'), pass(2005, 2090, 'failed', 'b', 'bad quality'), pass(2100, 2900, 'done', 'c', 'bad quality'), pass(9005, 9900, 'done', 'd', 'Design again')]});
  assert.deepEqual(withNotesOnce(pick).messages.map(m => m.id), ['a', 'c', 'd']);
});

test('the same words again after a result are a new request and stay; different photos are a different note', () => {
  const again = base({messages: [note('a', 1000, 'thicker'), note('b', 5000, 'thicker')], passes: [pass(1005, 2000, 'done', 'a', 'thicker'), pass(5005, 6000, 'done', 'b', 'thicker')]});
  assert.equal(withNotesOnce(again), again, 'untouched');
  const unchanged = base({messages: [note('a', 1000, 'thicker'), note('b', 5000, 'thicker')], passes: [pass(1005, 2000, 'unchanged', 'a', 'thicker'), pass(5005, 6000, 'done', 'b', 'thicker')]});
  assert.equal(withNotesOnce(unchanged).messages.length, 2, '"nothing needed changing" is a result too');
  const photos = base({messages: [note('a', 1000, 'see the photo', ['one.jpg']), note('b', 1100, 'see the photo', ['two.jpg'])], passes: [pass(1005, 1090, 'failed', 'a', 'see the photo')]});
  assert.equal(withNotesOnce(photos).messages.length, 2);
  // Sent twice while the first pass was still running (the second was queued): no result between the two sends.
  const queued = base({messages: [note('a', 1000, 'thicker'), note('b', 1098, 'thicker')], passes: [pass(1005, 3000, 'done', 'a', 'thicker'), pass(3005, 4000, 'done', 'b', 'thicker')]});
  assert.deepEqual(withNotesOnce(queued).messages.map(m => m.id), ['b']);
  // A stopped pass (capped, interrupted, asked a question) is not a result either.
  for (const status of ['capped', 'interrupted', 'needs_closeup']) {
    const stopped = base({messages: [note('a', 1000, 'thicker'), note('b', 5000, 'thicker')], passes: [pass(1005, 2000, status, 'a', 'thicker')]});
    assert.equal(withNotesOnce(stopped).messages.length, 1, status);
  }
});

test('the held message and the Done note follow the copy that is kept', () => {
  const held = base({pendingMessageId: 'a', completion: {messageId: 'a', note: 'DONE', atMs: 1, previousStatus: 'printed'},
    messages: [note('a', 1000, 'DONE'), note('b', 1100, 'DONE')], passes: []});
  const shown = withNotesOnce(held);
  assert.deepEqual(shown.messages.map(m => m.id), ['b']);
  assert.equal(shown.pendingMessageId, 'b');
  assert.equal(shown.completion.messageId, 'b');
  for (const few of [base({}), base({messages: [note('a', 1, 'x')]}), base({messages: undefined})]) assert.equal(withNotesOnce(few), few);
});
