import test from 'node:test';
import assert from 'node:assert/strict';
import {AskSchema} from '@scan-to-make/contracts/counterpart';
import {askKind, answeredSizes, sizesNote} from '../dist/objects/asks.js';
import {publicObject} from '../dist/objects/http.js';

const ask = extra => ({id: '6f1c1b6e-2d1e-4c3a-9a51-0e7a0b9e1a01', question: 'Q?', answers: ['text'], status: 'open', askedAtMs: 1, ...extra});
const project = extra => ({id: 'p', createdAtMs: 1, updatedAtMs: 2, state: 'needs-closeup', photos: [], requestPhotos: [], pendingPhotos: [], messages: [], passes: [], ...extra});

test('six waits, one enumeration: every open question says its kind, also one saved before kinds were written', () => {
  const review = kind => ({kind, preview: 'x', jobs: []});
  const cases = [
    [project({ask: ask({})}), 'closeup'],
    [project({ask: ask({type: 'closeup'})}), 'closeup'],
    [project({ask: ask({type: 'file'})}), 'file'],
    [project({ask: ask({type: 'choice'})}), 'choice'],
    [project({ask: ask({type: 'choice'}), reconstructionReview: review('region')}), 'region'],
    [project({ask: ask({type: 'choice'}), reconstructionReview: review('scale')}), 'scale'],
    [project({ask: ask({kind: 'sizes', sizes: [{id: 'a', label: 'width', mm: 1, from: 'scan'}]})}), 'sizes'],
    // What is written wins over what would be inferred.
    [project({ask: ask({type: 'choice', kind: 'scale'})}), 'scale'],
  ];
  for (const [object, kind] of cases) {
    assert.equal(askKind(object), kind);
    assert.equal(publicObject(object).ask.kind, kind);
  }
  assert.equal(askKind(project({})), undefined);
  assert.equal(publicObject(project({state: 'ready'})).ask, undefined);
});

test('the contract takes each kind, a reason for a file, and one to six sizes with where each came from', () => {
  const size = {id: 'a', label: 'width at the waist', mm: 53, from: 'scan'};
  for (const kind of ['closeup', 'file', 'choice', 'region', 'scale', 'sizes']) assert.equal(AskSchema.safeParse(ask({kind})).success, true, kind);
  assert.equal(AskSchema.safeParse(ask({kind: 'sizes', sizes: [size], answers: ['sizes', 'text', 'camera']})).success, true);
  assert.equal(AskSchema.safeParse(ask({kind: 'file', reason: 'downloads-access'})).success, true);
  for (const bad of [{kind: 'colour'}, {reason: 'because'}, {sizes: []}, {sizes: Array(7).fill(size)}, {sizes: [{...size, from: 'guess'}]}, {sizes: [{...size, mm: 0}]}, {sizes: [{id: 'a', label: 'x', mm: 1}]}])
    assert.equal(AskSchema.safeParse(ask(bad)).success, false, JSON.stringify(bad));
});

test('answered sizes keep the question\'s labels and order, and say which were confirmed', () => {
  const question = ask({kind: 'sizes', sizes: [{id: 'a', label: 'width', mm: 64, from: 'scan'}, {id: 'b', label: 'height', mm: 107, from: 'published'}]});
  const sizes = answeredSizes(question, [{id: 'b', mm: 107}, {id: 'a', mm: 63}]);
  assert.deepEqual(sizes, [{id: 'a', label: 'width', mm: 63, asked: 64}, {id: 'b', label: 'height', mm: 107, asked: 107}]);
  assert.equal(sizesNote(sizes), 'The person checked the sizes you asked about on the real object. Treat these as measured:\n- width: 63 mm (corrected; you had 64 mm)\n- height: 107 mm (confirmed)');
  // One of several is an answer too: the rest stay unconfirmed and are not sent as measured.
  assert.deepEqual(answeredSizes(question, [{id: 'b', mm: 108}]).map(size => size.id), ['b']);
  for (const bad of [[], [{id: 'c', mm: 1}], [{id: 'a', mm: 1}, {id: 'a', mm: 2}], [{id: 'a', mm: Number.NaN}], [{id: 'a', mm: 10_001}]])
    assert.throws(() => answeredSizes(question, bad));
  assert.throws(() => answeredSizes(ask({}), [{id: 'a', mm: 1}]), /did not ask for sizes/);
});
