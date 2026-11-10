import test from 'node:test';
import assert from 'node:assert/strict';
import {AskSchema} from '@scan-to-make/contracts/counterpart';
import {askKind, answeredSizes, sizesNote, mergeCheckedSizes, withCheckedSizes, checkedSizesBrief} from '../dist/objects/asks.js';
import {workerRequest, fitBrief} from '../dist/objects/fit.js';
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
  // A number nobody touched comes back as the two-decimal echo every client shows. It is confirmed, and what is
  // kept is the asked number, never the echo.
  const fine = ask({kind: 'sizes', sizes: [{id: 'a', label: 'width', mm: 68.412, from: 'scan'}, {id: 'b', label: 'waist', mm: 53.4567, from: 'scan'}, {id: 'c', label: 'height', mm: 149.2049, from: 'scan'}]});
  const echoed = answeredSizes(fine, [{id: 'a', mm: 68.41}, {id: 'b', mm: 53.46}, {id: 'c', mm: 149.3}]);
  assert.deepEqual(echoed, [{id: 'a', label: 'width', mm: 68.412, asked: 68.412}, {id: 'b', label: 'waist', mm: 53.4567, asked: 53.4567}, {id: 'c', label: 'height', mm: 149.3, asked: 149.2049}]);
  assert.equal(sizesNote(echoed), 'The person checked the sizes you asked about on the real object. Treat these as measured:\n- width: 68.412 mm (confirmed)\n- waist: 53.4567 mm (confirmed)\n- height: 149.3 mm (corrected; you had 149.2049 mm)');
  // One hundredth away is a correction.
  assert.equal(answeredSizes(fine, [{id: 'a', mm: 68.42}])[0].mm, 68.42);
});

// Train #499 review, F4: answered sizes replaced the whole fit, were dropped on a project that isn't a fit, and were
// later called "the exact overall size".
test('checked sizes merge by label, stay on any project, and are worded by label with how sure each is', () => {
  const answered = (label, mm, asked = mm) => ({id: 'x', label, mm, asked});
  const first = mergeCheckedSizes(undefined, [answered('width at the waist', 53.5), answered('height to the cap tip', 107.3, 107)]);
  assert.deepEqual(first, [{label: 'width at the waist', mm: 53.5, certainty: 'confirmed'}, {label: 'height to the cap tip', mm: 107.3, certainty: 'measured'}]);
  // A later question lists the waist again and a new size; the height it left blank or never listed stays.
  const second = mergeCheckedSizes(first, [answered('Width at the waist ', 53, 53.5), answered('cap diameter', 28)]);
  assert.deepEqual(second, [{label: 'Width at the waist ', mm: 53, certainty: 'measured'}, {label: 'height to the cap tip', mm: 107.3, certainty: 'measured'}, {label: 'cap diameter', mm: 28, certainty: 'confirmed'}]);
  assert.equal(checkedSizesBrief(undefined), undefined);
  assert.equal(checkedSizesBrief([]), undefined);
  const brief = checkedSizesBrief(first);
  assert.match(brief, /^Sizes the person checked on the real object[^\n]*do not ask for them again\.\n- width at the waist: 53\.5 mm, confirmed\n- height to the cap tip: 107\.3 mm, measured by the person$/);
  assert.doesNotMatch(brief, /exact overall size/);
  // New measured "width" 64; the question then had "width at the widest point" corrected to 63. Not the same label,
  // so both numbers reach the worker, and the brief says which one wins rather than leaving two to choose between.
  const near = {instructions: 'A wall holder', fit: {sizeSource: 'measured', measured: [{id: 'a', label: 'width', mm: 64}]},
    checkedSizes: mergeCheckedSizes(undefined, [answered('width at the widest point', 63, 64)])};
  const request = workerRequest(near);
  assert.ok(request.indexOf('width 64 mm') < request.indexOf('width at the widest point: 63 mm, measured by the person'), 'New\'s size first, the checked one after it');
  assert.match(request, /They are newer than any size earlier in this request: where one is about the same feature as an earlier size[^\n]*use this one\./);

  // A fit: New's choice and its overall sizes are kept; the brief is the fit brief, then the checked sizes.
  const measured = {sizeSource: 'measured', measured: [{id: 'a', label: 'longest', mm: 107}, {id: 'b', label: 'width', mm: 64}]};
  const fit = {instructions: 'A wall holder', fit: measured, checkedSizes: first};
  assert.equal(workerRequest(fit), `A wall holder\n\n${fitBrief(measured)}\n\n${brief}`);
  // A size New measured under the same label takes the newer number; the others are untouched.
  assert.deepEqual(withCheckedSizes({fit: measured}, [answered('Longest', 108, 107), answered('width at the waist', 53)]),
    {sizeSource: 'measured', measured: [{id: 'a', label: 'longest', mm: 108}, {id: 'b', label: 'width', mm: 64}]});
  assert.deepEqual(withCheckedSizes({fit: {sizeSource: 'lookup'}}, [answered('width', 60)]), {sizeSource: 'lookup'});
  assert.equal(withCheckedSizes({}, [answered('width', 60)]), undefined);
  // Not a fit: no fit brief (it would say "do not print a copy"), and the checked sizes still reach the worker.
  assert.equal(workerRequest({instructions: 'Copy this', checkedSizes: first}), `Copy this\n\n${brief}`);
  assert.equal(workerRequest({checkedSizes: first}), brief, 'a scan with no words');
  assert.equal(workerRequest({instructions: 'Copy this'}), 'Copy this');
  assert.equal(workerRequest({}), undefined);
});
