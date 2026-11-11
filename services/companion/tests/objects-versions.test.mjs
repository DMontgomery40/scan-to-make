import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {objectStatus} from '../dist/events/words.js';
import {migrateProjectVersions} from '../dist/objects/versions.js';
import {tempDir} from './support/temp.mjs';

const STL = n => `solid design${n}\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex ${n} 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid design${n}\n`;
async function setup(t) {
  const root = await tempDir('objects-versions-'); const store = new ObjectStore(join(root, 'objects'));
  let round = 0; let question = false;
  const service = new ObjectService({store, claudePath: '/unused', handoff: {backend: 'bambu-printer-mcp', process: {command: '/unused'}},
    stlInfo: async () => [10, 20, 30], drawPicture: async (_dir, _spec, output) => { await writeFile(output, 'picture'); return true; },
    runTouchup: async () => {
      const out = join(root, `pass-${++round}`, 'out'); await mkdir(out, {recursive: true});
      if (question) { question = false; return {status: 'needs_closeup', summary: 'Which side?', ask: {question: 'Which side?'}, renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(out, '..')}; }
      await writeFile(join(out, 'touched.stl'), STL(round)); await writeFile(join(out, 'front.png'), `render${round}`);
      return {status: 'done', model: join(out, 'touched.stl'), renders: [join(out, 'front.png')], summary: `Design ${round}`, checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(out, '..')};
    }});
  t.after(() => service.close());
  const object = await service.create('A holder.', 'fit'); await service.start(object.id); await service.settled(object.id); await service.picturesDrawn();
  return {store, service, id: object.id, question: () => { question = true; }};
}

for (const asks of [false, true]) test(`a printed design that works survives changes${asks ? ' and a question (X68)' : ''}`, async t => {
  const f = await setup(t); let object = await f.store.get(f.id);
  const first = object.versions[0]; const bytes = await readFile(join(f.store.dir(f.id), first.result.model));
  assert.ok(first.picture, 'each sealed design owns its own picture');
  // The same store updates the real monitor makes: start, save final report, end.
  await f.store.update(f.id, o => ({...o, state: 'printing', print: {printId: 'first-print', bundleId: 'bundle', dispatchedAt: new Date().toISOString()}}));
  await f.store.update(f.id, o => ({...o, state: 'printed', print: {...o.print, monitor: {phase: 'ended', endState: 'done', endedAt: new Date().toISOString()}}}));
  await f.service.setStatus(f.id, 'works');
  if (asks) f.question();
  await f.service.correct(f.id, 'Widen it.'); await f.service.settled(f.id);
  if (asks) {
    object = await f.store.get(f.id); assert.equal(object.versions.length, 1); assert.equal(objectStatus(object).phase, 'needs-you');
    assert.equal(object.versions[0].outcome, 'works');
    await f.service.answerCloseup(f.id, {text: 'The left side.'}); await f.service.settled(f.id);
  }
  await f.service.picturesDrawn(); object = await f.store.get(f.id);
  assert.equal(object.versions.length, 2);
  assert.equal(object.versions[0].outcome, 'works');
  assert.equal(object.versions[0].picture, first.picture);
  assert.deepEqual(await readFile(join(f.store.dir(f.id), first.result.model)), bytes);
  assert.equal(object.prints[0].versionId, first.id);
  assert.equal(object.prints[0].monitor.endState, 'done');
  assert.equal(objectStatus(object).phase, 'ready');
  assert.match(objectStatus(object).text, /New one ready · printed/);
  // Attempt N+1 does not remove N, including across a restart.
  await f.store.update(f.id, o => ({...o, state: 'printing', print: {printId: 'second-print', bundleId: 'bundle2'}}));
  const restarted = await new ObjectStore(f.store.root).get(f.id);
  assert.deepEqual(restarted.prints.map(p => p.printId), ['first-print', 'second-print']);
  assert.equal(restarted.prints[0].monitor.endState, 'done');
});

test('migration restores finished designs and the pink box print absent from object.json, exactly once', async () => {
  const root = await tempDir('versions-migration-');
  const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/versions-migration.json', import.meta.url)));
  for (const row of fixture) {
    const dir = join(root, row.name); await mkdir(dir, {recursive: true});
    const passes = [];
    for (let i = 0; i < row.designs; i++) {
      const path = join(dir, 'passes', `pass-${i}`, 'out'); await mkdir(path, {recursive: true});
      await writeFile(join(path, 'touched.stl'), STL(i + 1)); await writeFile(join(path, 'front.png'), `render${i}`);
      passes.push({startedAtMs: 1000 + i * 1000, endedAtMs: 1100 + i * 1000, status: 'done', dir: join(path, '..'), summary: `Design ${i + 1}`});
    }
    const currentDir = join(dir, 'current'); await mkdir(currentDir); await writeFile(join(currentDir, 'model.stl'), STL(row.designs));
    const object = {id: row.name, state: 'ready', photos: [], passes, createdAtMs: 1, updatedAtMs: 9000, current: {model: 'current/model.stl', renders: []}, ...(row.outcome ? {outcome: row.outcome} : {})};
    const migrated = await migrateProjectVersions(object, dir, {events: row.events, stlInfo: async () => [10, 20, 30]});
    assert.equal(migrated.versionsV1, true);
    assert.deepEqual(migrated.versions.map(v => ({summary: v.result.summary, outcome: v.outcome ?? null})), row.expected);
    assert.deepEqual(migrated.prints.map(p => ({id: p.printId, version: migrated.versions.findIndex(v => v.id === p.versionId) + 1, end: p.monitor?.endState ?? null})), row.attempts);
    assert.deepEqual(await migrateProjectVersions(migrated, dir, {events: row.events}), migrated);
    assert.equal(await readFile(join(currentDir, 'model.stl'), 'utf8'), STL(row.designs));
    for (let i = 0; i < passes.length; i++) assert.equal(await readFile(join(passes[i].dir, 'out/touched.stl'), 'utf8'), STL(i+1));
  }
});
