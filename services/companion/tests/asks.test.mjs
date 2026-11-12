import test from 'node:test';
import assert from 'node:assert/strict';
import {AskSchema, SizesAnswerSchema} from '@scan-to-make/contracts/counterpart';
import {askKind, answeredSizes, sizesNote, sizesMessage, mergeCheckedSizes, withCheckedSizes, checkedSizesBrief} from '../dist/objects/asks.js';
import {structured} from '../dist/touchup/runner.js';
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
  // #622: the Mac's own guess is its own source, and a published size names its product and where it was published.
  for (const good of [{...size, from: 'estimate'}, {...size, from: 'published', product: 'JETech clear case for iPhone 16 Pro', reference: 'the maker\'s listing'},
    {...size, from: 'published'}]) // a question saved before Nov 12 still reads
    assert.equal(AskSchema.safeParse(ask({kind: 'sizes', sizes: [good]})).success, true, JSON.stringify(good));
  for (const bad of [{kind: 'colour'}, {reason: 'because'}, {sizes: []}, {sizes: Array(7).fill(size)}, {sizes: [{...size, from: 'guess'}]}, {sizes: [{...size, mm: 0}]}, {sizes: [{id: 'a', label: 'x', mm: 1}]},
    {sizes: [{...size, product: ''}]}, {sizes: [{...size, reference: 'x'.repeat(301)}]}, {sizes: [{...size, measured: true}]}])
    assert.equal(AskSchema.safeParse(ask(bad)).success, false, JSON.stringify(bad));
  // An answer: the numbers, and the ids the person typed. A client from before Nov 12 sends no `measured`.
  assert.equal(SizesAnswerSchema.safeParse({sizes: [{id: 'a', mm: 1}]}).success, true);
  assert.equal(SizesAnswerSchema.safeParse({sizes: [{id: 'a', mm: 1}], measured: []}).success, true);
  assert.equal(SizesAnswerSchema.safeParse({sizes: [{id: 'a', mm: 1}], measured: ['a']}).success, true);
  for (const bad of [{sizes: [{id: 'a', mm: 1, certainty: 'measured'}]}, {sizes: [{id: 'a', mm: 1}], measured: 'a'}, {sizes: [{id: 'a', mm: 1}], measured: ['']}, {sizes: []}])
    assert.equal(SizesAnswerSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('answered sizes keep the question\'s labels, order and sources, and say which were measured and which accepted', () => {
  const question = ask({kind: 'sizes', sizes: [{id: 'a', label: 'width', mm: 64, from: 'scan'}, {id: 'b', label: 'height', mm: 107, from: 'published', product: 'MiO 1.62 oz bottle', reference: 'the maker\'s page'}]});
  // A client from before Nov 12: no `measured`, so a changed number is measured and an unchanged one accepted.
  const sizes = answeredSizes(question, [{id: 'b', mm: 107}, {id: 'a', mm: 63}]);
  assert.deepEqual(sizes, [{id: 'a', label: 'width', mm: 63, asked: 64, certainty: 'measured', from: 'scan'},
    {id: 'b', label: 'height', mm: 107, asked: 107, certainty: 'accepted', from: 'published', product: 'MiO 1.62 oz bottle', reference: 'the maker\'s page'}]);
  assert.equal(sizesNote(sizes), 'The person answered the sizes you asked about. Only the ones marked "measured by the person" were measured on the real object. An accepted size is a number you offered that the person let stand without changing it: it is exactly as certain as where it came from, so an accepted published size is the published size of the product it names, and an accepted estimate or scan reading is not a measurement.\n- width: 63 mm, measured by the person (you had 64 mm)\n- height: 107 mm, accepted; published for MiO 1.62 oz bottle (source: the maker\'s page)');
  assert.doesNotMatch(sizesNote(sizes), /Treat these as measured|checked the sizes you asked about on the real object/);
  // The person typed the same number they measured: measured, because the client says they typed it.
  assert.equal(answeredSizes(question, [{id: 'b', mm: 107}], ['b'])[0].certainty, 'measured');
  assert.equal(answeredSizes(question, [{id: 'b', mm: 107}], [])[0].certainty, 'accepted');
  // A changed number is measured whatever the client says.
  assert.equal(answeredSizes(question, [{id: 'a', mm: 60}], [])[0].certainty, 'measured');
  // One of several is an answer too: the rest are left out, not sent as accepted or measured.
  assert.deepEqual(answeredSizes(question, [{id: 'b', mm: 108}]).map(size => size.id), ['b']);
  for (const bad of [[], [{id: 'c', mm: 1}], [{id: 'a', mm: 1}, {id: 'a', mm: 2}], [{id: 'a', mm: Number.NaN}], [{id: 'a', mm: 10_001}]])
    assert.throws(() => answeredSizes(question, bad));
  assert.throws(() => answeredSizes(ask({}), [{id: 'a', mm: 1}]), /did not ask for sizes/);
  // A number nobody touched comes back as the two-decimal echo every client shows. It is accepted, and what is
  // kept is the asked number, never the echo.
  const fine = ask({kind: 'sizes', sizes: [{id: 'a', label: 'width', mm: 68.412, from: 'scan'}, {id: 'b', label: 'waist', mm: 53.4567, from: 'estimate'}, {id: 'c', label: 'height', mm: 149.2049, from: 'scan'}]});
  const echoed = answeredSizes(fine, [{id: 'a', mm: 68.41}, {id: 'b', mm: 53.46}, {id: 'c', mm: 149.3}], ['c']);
  assert.deepEqual(echoed.map(({mm, asked, certainty}) => [mm, asked, certainty]), [[68.412, 68.412, 'accepted'], [53.4567, 53.4567, 'accepted'], [149.3, 149.2049, 'measured']]);
  assert.match(sizesNote(echoed), /\n- width: 68\.412 mm, accepted; read from the scan, not a measurement\n- waist: 53\.4567 mm, accepted; your estimate, not a measurement\n- height: 149\.3 mm, measured by the person \(you had 149\.2049 mm\)$/);
  assert.equal(sizesMessage(echoed), 'width: 68.412 mm (accepted as asked)\nwaist: 53.4567 mm (accepted as asked)\nheight: 149.3 mm (measured)');
  // One hundredth away is a correction.
  assert.equal(answeredSizes(fine, [{id: 'a', mm: 68.42}])[0].mm, 68.42);
});

// #622, the repro: the Forester phone mount's question (real project 53a48b5e, Nov 10) offered Apple's bare iPhone 16
// Pro sizes for a phone in a JETech clear case, and two guesses as "scan". Confirm stored them all as checked on the
// real object, and the mount was built for a 71.5 mm bare phone. The case's published size is 153.9 x 75.4 x 12.4 mm.
test('the phone mount: an accepted bare-phone size is said to be the bare phone\'s, guesses stay guesses, and none is a measurement', () => {
  const question = ask({kind: 'sizes', sizes: [
    {id: 'size-1', label: 'Phone width in its case', mm: 75.4, from: 'published', product: 'JETech clear case for iPhone 16 Pro', reference: 'JETech product listing (placeholder for the maker\'s page)'},
    {id: 'size-2', label: 'Phone width across the long sides', mm: 71.5, from: 'published', product: 'iPhone 16 Pro, bare (no case)', reference: 'Apple iPhone 16 Pro technical specifications'},
    {id: 'size-3', label: 'Total thickness through the wallet', mm: 18, from: 'estimate'},
    {id: 'size-4', label: 'Wallet width', mm: 65, from: 'scan'}]});
  // Confirm pressed with nothing touched.
  const sizes = answeredSizes(question, question.sizes.map(({id, mm}) => ({id, mm})), []);
  assert.deepEqual(sizes.map(size => size.certainty), ['accepted', 'accepted', 'accepted', 'accepted']);
  const note = sizesNote(sizes);
  assert.match(note, /\n- Phone width in its case: 75\.4 mm, accepted; published for JETech clear case for iPhone 16 Pro \(source: JETech product listing/);
  assert.match(note, /\n- Phone width across the long sides: 71\.5 mm, accepted; published for iPhone 16 Pro, bare \(no case\) \(source: Apple iPhone 16 Pro technical specifications\)/);
  assert.match(note, /\n- Total thickness through the wallet: 18 mm, accepted; your estimate, not a measurement/);
  assert.match(note, /\n- Wallet width: 65 mm, accepted; read from the scan, not a measurement$/);
  assert.doesNotMatch(note.split('\n').slice(1).join('\n'), /measured by the person|confirmed/, 'no number in it was measured');
  const checked = mergeCheckedSizes(undefined, sizes);
  assert.deepEqual(checked.map(size => size.certainty), ['accepted', 'accepted', 'accepted', 'accepted']);
  assert.deepEqual(checked[1], {label: 'Phone width across the long sides', mm: 71.5, certainty: 'accepted', from: 'published', product: 'iPhone 16 Pro, bare (no case)', reference: 'Apple iPhone 16 Pro technical specifications', asked: 71.5});
  const brief = checkedSizesBrief(checked);
  assert.match(brief, /\n- Phone width across the long sides: 71\.5 mm, accepted; published for iPhone 16 Pro, bare \(no case\)/);
  assert.doesNotMatch(brief.split('\n').slice(1).join('\n'), /measured by the person/);
});

// #622, migration: sizes stored before Nov 12 say `confirmed` for an untouched Confirm and carry no source. They stay
// as stored, and every brief from now on reads them as accepted, not measured.
test('a size stored as confirmed before Nov 12 stays as stored and is read as accepted, with its source unknown', () => {
  // As the Forester mount's project holds them (53a48b5e, Nov 10).
  const stored = [{label: 'Phone width across the long sides, with case if any (Apple: 71.5 bare)', mm: 71.5, certainty: 'confirmed'},
    {label: 'Total thickness measured through the wallet (my guess)', mm: 18, certainty: 'confirmed'},
    {label: 'Wallet width', mm: 64, certainty: 'measured'}];
  const before = structuredClone(stored);
  const brief = checkedSizesBrief(stored);
  assert.deepEqual(stored, before, 'nothing stored is rewritten');
  assert.match(brief, /\n- Phone width across the long sides, with case if any \(Apple: 71\.5 bare\): 71\.5 mm, accepted; its source was not recorded, so it is not a measurement\n/);
  assert.match(brief, /\n- Total thickness measured through the wallet \(my guess\): 18 mm, accepted; its source was not recorded, so it is not a measurement\n/);
  assert.match(brief, /\n- Wallet width: 64 mm, measured by the person$/);
  assert.doesNotMatch(brief, /, confirmed$/m);
  // A merge keeps an earlier `confirmed` size it doesn't replace exactly as stored.
  const merged = mergeCheckedSizes(stored, [{id: 'x', label: 'Wallet height', mm: 90, asked: 90, certainty: 'accepted', from: 'estimate'}]);
  assert.deepEqual(merged.slice(0, 3), before);
  // And an accepted answer replaces a stored `confirmed` one (both are numbers let stand), never a measured one.
  const again = mergeCheckedSizes(stored, [{id: 'x', label: 'wallet width', mm: 65, asked: 65, certainty: 'accepted', from: 'scan'},
    {id: 'y', label: 'Total thickness measured through the wallet (my guess)', mm: 17, asked: 17, certainty: 'accepted', from: 'estimate'}]);
  assert.deepEqual(again[2], before[2], 'the measured wallet width stays');
  assert.equal(again[1].certainty, 'accepted');
  assert.equal(again[1].from, 'estimate');
});

// Train #499 review, F4: answered sizes replaced the whole fit, were dropped on a project that isn't a fit, and were
// later called "the exact overall size".
test('checked sizes merge by label, stay on any project, and are worded by label with how sure each is', () => {
  const answered = (label, mm, asked = mm, from = 'scan') => ({id: 'x', label, mm, asked, certainty: mm === asked ? 'accepted' : 'measured', from});
  const first = mergeCheckedSizes(undefined, [answered('width at the waist', 53.5), answered('height to the cap tip', 107.3, 107)]);
  assert.deepEqual(first, [{label: 'width at the waist', mm: 53.5, certainty: 'accepted', from: 'scan', asked: 53.5}, {label: 'height to the cap tip', mm: 107.3, certainty: 'measured', from: 'scan', asked: 107}]);
  // A later question lists the waist again and a new size; the height it left blank or never listed stays.
  const second = mergeCheckedSizes(first, [answered('Width at the waist ', 53, 53.5), answered('cap diameter', 28, 28, 'estimate')]);
  assert.deepEqual(second, [{label: 'Width at the waist ', mm: 53, certainty: 'measured', from: 'scan', asked: 53.5}, first[1], {label: 'cap diameter', mm: 28, certainty: 'accepted', from: 'estimate', asked: 28}]);
  // #622: a later question prefilled with the person's own measurement and confirmed untouched stays measured.
  assert.deepEqual(mergeCheckedSizes(second, [answered('height to the cap tip', 107.3)])[1], first[1]);
  assert.equal(checkedSizesBrief(undefined), undefined);
  assert.equal(checkedSizesBrief([]), undefined);
  const brief = checkedSizesBrief(first);
  assert.match(brief, /^Sizes from the person's answers to your earlier questions[^\n]*Only the ones marked "measured by the person" were measured on the real object[^\n]*do not ask for them again\.[^\n]*an accepted estimate or scan reading is not a measurement\. An accepted size never outranks a size the person measured\.\n- width at the waist: 53\.5 mm, accepted; read from the scan, not a measurement\n- height to the cap tip: 107\.3 mm, measured by the person \(you had 107 mm\)$/);
  assert.doesNotMatch(brief, /exact overall size/);
  // New measured "width" 64; the question then had "width at the widest point" corrected to 63. Not the same label,
  // so both numbers reach the worker, and the brief says which one wins rather than leaving two to choose between.
  const near = {instructions: 'A wall holder', fit: {sizeSource: 'measured', measured: [{id: 'a', label: 'width', mm: 64}]},
    checkedSizes: mergeCheckedSizes(undefined, [answered('width at the widest point', 63, 64)])};
  const request = workerRequest(near);
  assert.ok(request.indexOf('width 64 mm') < request.indexOf('width at the widest point: 63 mm, measured by the person'), 'New\'s size first, the checked one after it');
  assert.match(request, /they are newer than any size earlier in this request, so where one is about the same feature as an earlier size[^\n]*use it\./);

  // A fit: New's choice and its overall sizes are kept; the brief is the fit brief, then the checked sizes.
  const measured = {sizeSource: 'measured', measured: [{id: 'a', label: 'longest', mm: 107}, {id: 'b', label: 'width', mm: 64}]};
  const fit = {instructions: 'A wall holder', fit: measured, checkedSizes: first};
  assert.equal(workerRequest(fit), `A wall holder\n\n${fitBrief(measured)}\n\n${brief}`);
  // A size New measured under the same label takes the person's newer measured number; the others are untouched.
  assert.deepEqual(withCheckedSizes({fit: measured}, [answered('Longest', 108, 107), answered('width at the waist', 53)]),
    {sizeSource: 'measured', measured: [{id: 'a', label: 'longest', mm: 108}, {id: 'b', label: 'width', mm: 64}]});
  // #622: an accepted number never replaces a size the person measured in New (it would then be "Dimensions I measured").
  assert.deepEqual(withCheckedSizes({fit: measured}, [{id: 'x', label: 'width', mm: 71.5, asked: 71.5, certainty: 'accepted', from: 'published', product: 'iPhone 16 Pro, bare (no case)'}]), measured);
  assert.deepEqual(withCheckedSizes({fit: {sizeSource: 'lookup'}}, [answered('width', 60)]), {sizeSource: 'lookup'});
  assert.equal(withCheckedSizes({}, [answered('width', 60)]), undefined);
  // Not a fit: no fit brief (it would say "do not print a copy"), and the checked sizes still reach the worker.
  assert.equal(workerRequest({instructions: 'Copy this', checkedSizes: first}), `Copy this\n\n${brief}`);
  assert.equal(workerRequest({checkedSizes: first}), brief, 'a scan with no words');
  assert.equal(workerRequest({instructions: 'Copy this'}), 'Copy this');
  assert.equal(workerRequest({}), undefined);
});

// #622: the worker's question keeps a size only when its source is whole. A published number must name the product it
// is for and where the maker published it; the Mac's guess is an estimate, never "scan".
test('the worker\'s sizes: published ones carry their product and source, estimates are their own kind, and an incomplete one makes the question words', () => {
  const read = sizes => structured({status: 'needs_closeup', ask: {question: 'Is this right?', sizes}}, text => text).ask;
  const published = {label: 'Phone width in its case', mm: 75.4, from: 'published', product: 'JETech clear case for iPhone 16 Pro', reference: 'https://example.invalid/placeholder'};
  assert.deepEqual(read([published, {label: 'Wallet thickness', mm: 6, from: 'estimate'}, {label: 'Wallet width', mm: 65, from: 'scan', product: 'ignored'}]).sizes,
    [published, {label: 'Wallet thickness', mm: 6, from: 'estimate'}, {label: 'Wallet width', mm: 65, from: 'scan'}]);
  for (const bad of [{...published, product: undefined}, {...published, reference: ' '}, {...published, from: 'guess'}, {...published, from: 'measured'}])
    assert.equal(read([bad, {label: 'Wallet width', mm: 65, from: 'scan'}]).sizes, undefined, JSON.stringify(bad));
});

// #622: the shared size-sources fixture (CounterpartKit, Android and Linux read it too): the question parses, and what
// each client sends for its edits is accepted or measured here exactly as the fixture says.
test('the size-sources fixture: every client\'s answer is accepted or measured as the fixture says', async () => {
  const {readFile} = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/size-sources.json', import.meta.url), 'utf8'));
  assert.equal(AskSchema.safeParse(fixture.ask).success, true);
  for (const answer of fixture.answers) {
    assert.equal(SizesAnswerSchema.safeParse({sizes: answer.sizes, measured: answer.measured}).success, true, answer.name);
    assert.deepEqual(answeredSizes(fixture.ask, answer.sizes, answer.measured).map(size => size.certainty), answer.certainty, answer.name);
  }
});
