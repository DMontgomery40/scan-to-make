import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FitSchema} from '@scan-to-make/contracts/counterpart';
import {fitBrief, splitFitBrief, fitRequest, workerRequest} from '../dist/objects/fit.js';
import {publicObject} from '../dist/objects/http.js';

const fixture = JSON.parse(await readFile(new URL('../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/fit-fields.json', import.meta.url), 'utf8'));
const project = extra => ({id: 'p', createdAtMs: 1, updatedAtMs: 2, state: 'new', kind: 'fit', photos: [], requestPhotos: [], pendingPhotos: [], messages: [], passes: [], ...extra});

test('the fit choice is fields, and the request every client shows is what the person typed', () => {
  for (const row of fixture.cases) {
    assert.equal(FitSchema.safeParse(row.create.fit).success, true, row.name);
    const stored = project({instructions: row.create.instructions, fit: row.create.fit});
    const shown = publicObject(stored);
    assert.equal(shown.instructions, fixture.typed, row.name);
    assert.deepEqual(shown.fit, row.create.fit, row.name);
    assert.doesNotMatch(JSON.stringify({instructions: shown.instructions, title: shown.title}), /Fit brief/, row.name);
    // The worker reads the person's words, then the brief the clients used to append: the same text as before.
    assert.equal(workerRequest(stored), row.worker, row.name);
    assert.equal(`${fixture.typed}\n\n${fitBrief(row.create.fit)}`, row.worker, row.name);
  }
});

test('a project saved with the block in its request shows only the person\'s words, and its file is not rewritten', () => {
  for (const row of fixture.cases) {
    const stored = project({instructions: row.legacy});
    assert.deepEqual(splitFitBrief(row.legacy), {typed: fixture.typed, fit: row.legacyFit}, row.name);
    const shown = publicObject(stored);
    assert.equal(shown.instructions, fixture.typed, row.name);
    assert.deepEqual(shown.fit, row.legacyFit, row.name);
    assert.equal(shown.title.includes('Fit brief'), false, row.name);
    assert.equal(stored.instructions, row.legacy, 'the stored record keeps the original');
    assert.equal(workerRequest(stored), row.legacy, 'and the worker reads exactly what it read before');
  }
});

test('only the exact block a client wrote is split off; anything else stays the person\'s words', () => {
  const mating = '- The scanned object is the thing the printed part must fit, hold, mount or adapt to. Do not print a copy of the scanned object itself.';
  for (const text of [
    'Make a clip.\n\nFit brief:\n- something I typed myself',
    `Make a clip.\n\nFit brief:\n${mating}\n- Dimensions: whatever you think`,
    `Make a clip.\n\nFit brief:\n${mating}\n- Dimensions I measured on the real object: about a hand wide. Treat these as the exact overall size. If the scan differs by more than 2 mm or 2%, ask before designing anything fit-critical.`,
    'Fit brief: I want a tight fit',
  ]) {
    assert.deepEqual(splitFitBrief(text), {typed: text});
    assert.equal(publicObject(project({instructions: text})).instructions, text);
    assert.equal(workerRequest(project({instructions: text})), text);
  }
  assert.deepEqual(splitFitBrief(undefined), {});
  assert.deepEqual(fitRequest(project({})), {});
  // A person who typed "Fit brief:" themselves, in a project with the field: their words are kept whole.
  const own = project({instructions: 'Fit brief: snug', fit: {sizeSource: 'scan'}});
  assert.equal(publicObject(own).instructions, 'Fit brief: snug');
});

test('a fit choice set on a draft that still carries the old block: the block is read once, and the field wins', () => {
  for (const row of fixture.cases) {
    const fit = {sizeSource: 'measured', measured: [{id: 'a', label: 'width at the waist', mm: 53}]};
    const both = project({instructions: row.legacy, fit});
    assert.deepEqual(fitRequest(both), {typed: fixture.typed, fit}, row.name);
    assert.equal(publicObject(both).instructions, fixture.typed, row.name);
    assert.equal(workerRequest(both), `${fixture.typed}\n\n${fitBrief(fit)}`, row.name);
    assert.equal(workerRequest(both).match(/Fit brief:/g).length, 1, row.name);
  }
});

test('sizes are opaque ids with labels a person can act on; a measured fit needs at least one', () => {
  const waisted = {sizeSource: 'measured', measured: [{id: 'a', label: 'width at the pink stripe', mm: 63}, {id: 'b', label: 'width at the waist', mm: 53}, {id: 'c', label: 'height to the cap tip', mm: 107}]};
  assert.equal(FitSchema.safeParse(waisted).success, true);
  assert.match(fitBrief(waisted), /width at the pink stripe 63 mm, width at the waist 53 mm, height to the cap tip 107 mm\./);
  for (const bad of [{sizeSource: 'measured'}, {sizeSource: 'measured', measured: []}, {sizeSource: 'lookup', measured: waisted.measured}, {sizeSource: 'guess'},
    {sizeSource: 'measured', measured: [{id: 'a', label: 'x', mm: 0}]}, {sizeSource: 'measured', measured: [{id: 'a', label: 'x', mm: 10001}]},
    {sizeSource: 'measured', measured: Array.from({length: 7}, (_, i) => ({id: String(i), label: 'x', mm: 1}))}])
    assert.equal(FitSchema.safeParse(bad).success, false, JSON.stringify(bad));
});
