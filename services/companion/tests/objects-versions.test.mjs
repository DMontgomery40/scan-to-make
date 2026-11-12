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

// #616: the migration over anonymised structural copies of four real projects (packages/contracts/fixtures/
// versions-migration-real.json): real times, statuses, engines, identical-or-not outputs, code runs, frame folders and
// events. Expectations are written from DESIGN.md §5 and the stored folders, not from this code's output.
test('migration over the four real project structures restores their designs and attempts without guessing an answer', async () => {
  const {ProjectDesignsSchema} = await import('@scan-to-make/contracts/counterpart');
  const {utimes} = await import('node:fs/promises');
  const root = await tempDir('versions-real-');
  const {projects} = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/versions-migration-real.json', import.meta.url)));
  for (const row of projects) {
    const dir = join(root, row.name), expected = row.expected;
    for (const pass of row.passes) {
      if (!pass.dir) continue;
      const out = join(dir, pass.dir, 'out'); await mkdir(out, {recursive: true});
      for (const [name, n] of Object.entries(pass.out ?? {})) await writeFile(join(out, name), name.endsWith('.stl') ? STL(n) : `3mf ${n}`);
      for (let i = 0; i < pass.renders; i++) await writeFile(join(out, `${i}_view.png`), `render ${pass.startedAtMs} ${i}`);
      for (const part of pass.parts ?? []) await writeFile(join(out, part), `part ${part}`);
      for (const [j, run] of (pass.cad ?? []).entries()) {
        const folder = join(dir, pass.dir, 'cad', `cad-run-${j}`); await mkdir(folder, {recursive: true});
        await writeFile(join(folder, 'part.stl'), run.matches ? STL(pass.out['touched.stl']) : `solid other${j}\nendsolid other${j}\n`);
        if (run.script) await writeFile(join(folder, 'part.py'), `# run ${j}`);
        if (run.parameters) await writeFile(join(folder, 'part.parameters.json'), '{}');
        if (run.step) await writeFile(join(folder, 'part.step'), 'STEP');
      }
    }
    for (const print of row.prints) {
      const frames = join(dir, 'prints', print.id, 'frames'); await mkdir(frames, {recursive: true});
      for (const [i, at] of print.frames.entries()) { const file = join(frames, `${i}.jpg`); await writeFile(file, 'jpg'); await utimes(file, at / 1000, at / 1000); }
    }
    const latest = row.passes.filter(p => p.out?.['touched.stl']).at(-1);
    await mkdir(join(dir, 'current'), {recursive: true}); await writeFile(join(dir, 'current', 'model.stl'), STL(latest.out['touched.stl']));
    const object = {id: row.name, kind: row.kind, state: row.state, ...(row.outcome ? {outcome: row.outcome} : {}), photos: [], createdAtMs: 1, updatedAtMs: row.updatedAtMs,
      passes: row.passes.map(({out: _o, renders: _r, parts: _p, cad: _c, ...pass}) => pass), current: {model: 'current/model.stl', renders: []}, ...(row.print ? {print: row.print} : {})};
    const migrated = await migrateProjectVersions(object, dir, {events: row.events, stlInfo: async () => [10, 20, 30]});
    const label = row.name;
    assert.deepEqual(migrated.versions.map(v => v.passStartedAtMs), expected.versionPasses.map(i => row.passes[i].startedAtMs), label);
    assert.deepEqual(migrated.versions.map(v => v.outcome ?? null), expected.outcomes, label);
    assert.deepEqual(migrated.prints.map(p => ({id: p.id.slice(0, 8), version: migrated.versions.findIndex(v => v.id === p.versionId) + 1, end: p.monitor?.endState ?? null,
      ...(expected.attempts.find(a => a.id === p.id.slice(0, 8))?.startedAt ? {startedAt: new Date(p.startedAtMs).toISOString()} : {})})), expected.attempts, label);
    if (expected.lastDesign) assert.deepEqual(Object.keys(migrated.versions.at(-1).result.design ?? {}).sort(), expected.lastDesign, label);
    if (expected.lastModel) assert.ok(migrated.versions.at(-1).result.model.endsWith(expected.lastModel), label);
    assert.equal(!!migrated.historyRestored, expected.restored, label);
    assert.ok(objectStatus(migrated).text.startsWith(expected.status), `${label}: ${objectStatus(migrated).text}`);
    // What every client decodes, and nothing the person had is gone or changed.
    ProjectDesignsSchema.parse(migrated);
    for (const pass of row.passes) for (const [name, n] of Object.entries(pass.out ?? {}))
      assert.equal(await readFile(join(dir, pass.dir, 'out', name), 'utf8'), name.endsWith('.stl') ? STL(n) : `3mf ${n}`);
    for (const version of migrated.versions) assert.ok((await readFile(join(dir, version.result.model))).length > 0, `${label}: ${version.result.model}`);
    // A second start changes nothing.
    assert.deepEqual(await migrateProjectVersions(migrated, dir, {events: row.events}), migrated);
  }
});

test('an attempt starts when it was sent, not when its project last changed (#616)', async t => {
  const f = await setup(t);
  const sent = '2026-11-08T00:23:42.929Z';
  await f.store.update(f.id, o => ({...o, state: 'printing', print: {printId: 'p1', bundleId: 'b', dispatchedAt: sent}}));
  await new Promise(resolve => setTimeout(resolve, 5));
  await f.store.update(f.id, o => ({...o, state: 'failed', print: {...o.print, monitor: {phase: 'ended', endState: 'failed', endedAt: '2026-11-08T01:24:08.204Z'}}}));
  const attempt = (await f.store.get(f.id)).prints.find(p => p.printId === 'p1');
  assert.equal(new Date(attempt.startedAtMs).toISOString(), sent);
  assert.ok(attempt.startedAtMs <= Date.parse(attempt.monitor.endedAt));
});

test('a new design of a printed thing is announced as new, and the printed one as unchanged (#616)', async () => {
  const {eventWords} = await import('../dist/events/words.js');
  const words = eventWords('pass.ready', undefined, {title: 'AirPods Max desk hanger', size: '89 × 105 × 80 mm', printedBefore: true});
  assert.equal(words.title, 'Your new AirPods Max desk hanger design is ready');
  assert.equal(words.body, 'The printed one is unchanged · 89 × 105 × 80 mm');
  assert.equal(eventWords('pass.ready', undefined, {title: 'Hook'}).title, 'Hook is ready to print');
});

// ---- #602 review (Muse, 2026-11-12): first-start migration on real data ----

/** A designed project on disk as an older build left it: `designs` finished passes, each with its own model and render. */
async function legacyProject(store, id, designs, extra = {}) {
  const dir = store.dir(id); await mkdir(dir, {recursive: true});
  const passes = [];
  for (let i = 0; i < designs; i++) {
    const out = join(dir, 'passes', `pass-${i}`, 'out'); await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL(i + 1)); await writeFile(join(out, 'front.png'), `render ${id} ${i}`);
    passes.push({startedAtMs: 1000 + i * 1000, endedAtMs: 1100 + i * 1000, status: 'done', dir: `passes/pass-${i}`, summary: `Design ${i + 1}`});
  }
  await mkdir(join(dir, 'current'), {recursive: true}); await writeFile(join(dir, 'current', 'model.stl'), STL(designs));
  const object = {id, state: 'ready', kind: 'fit', photos: [], passes, messages: [], createdAtMs: 1, updatedAtMs: 9000, current: {model: 'current/model.stl', renders: []}, ...extra};
  await writeFile(join(dir, 'object.json'), JSON.stringify(object));
  return object;
}
const listVersions = async dir => (await import('node:fs/promises')).readdir(join(dir, 'versions')).catch(() => []);

test('review 1: a project that fails part-way is left exactly as it was, and the others still migrate', async () => {
  const root = await tempDir('versions-isolated-'); const store = new ObjectStore(join(root, 'objects'));
  const broken = '00000000-0000-4000-8000-0000000000b1', fine = '00000000-0000-4000-8000-0000000000b2';
  await legacyProject(store, broken, 2); await legacyProject(store, fine, 2);
  // Its second design can't be read (fails as a full disk would: after the first design was already copied).
  const {chmod} = await import('node:fs/promises');
  const unreadable = join(store.dir(broken), 'passes', 'pass-1', 'out', 'touched.stl');
  await chmod(unreadable, 0o000);
  const before = await readFile(join(store.dir(broken), 'object.json'), 'utf8');
  const report = await store.migrateVersions({stlInfo: async () => [1, 2, 3], freeBytes: async () => 1e12});
  assert.deepEqual(report.failed.map(f => f.id), [broken]);
  assert.deepEqual(report.migrated, [fine]);
  assert.equal(await readFile(join(store.dir(broken), 'object.json'), 'utf8'), before, 'the record is untouched');
  assert.deepEqual(await listVersions(store.dir(broken)), [], 'no copy of its first design is left behind');
  const other = await store.get(fine);
  assert.equal(other.versionsV1, true); assert.equal(other.versions.length, 2);
  // Readable again, the next start migrates it.
  await chmod(unreadable, 0o644);
  assert.deepEqual((await store.migrateVersions({freeBytes: async () => 1e12})).migrated, [broken]);
});

test('review 1: a project is skipped, not migrated, when its copies would leave the disk short', async () => {
  const root = await tempDir('versions-space-'); const store = new ObjectStore(join(root, 'objects'));
  const id = '00000000-0000-4000-8000-0000000000c1'; await legacyProject(store, id, 3);
  const before = await readFile(join(store.dir(id), 'object.json'), 'utf8');
  const report = await store.migrateVersions({freeBytes: async () => 2 * 1024 ** 3 + 10, reserveBytes: 2 * 1024 ** 3});
  assert.deepEqual(report.skipped.map(s => s.id), [id]);
  assert.match(report.skipped[0].reason, /MB free/);
  assert.equal(await readFile(join(store.dir(id), 'object.json'), 'utf8'), before);
  assert.deepEqual(await listVersions(store.dir(id)), []);
  // With room, the next start migrates it.
  const later = await store.migrateVersions({freeBytes: async () => 1e12});
  assert.deepEqual(later.migrated, [id]);
});

test('review 2: a migration killed twice before its record was written leaves one set of copies and the right result', async () => {
  const root = await tempDir('versions-killed-'); const store = new ObjectStore(join(root, 'objects'));
  const id = '00000000-0000-4000-8000-0000000000d1'; const object = await legacyProject(store, id, 2);
  // Two starts that copied and died before object.json: their copies are on disk, the record never named them.
  const first = await migrateProjectVersions(object, store.dir(id), {stlInfo: async () => [1, 2, 3]});
  const second = await migrateProjectVersions(object, store.dir(id), {stlInfo: async () => [1, 2, 3]});
  // And a third died mid-copy, leaving a temp folder.
  await mkdir(join(store.dir(id), 'versions', `${first.versions[0].id.slice(0, -1)}0.sealing`), {recursive: true});
  assert.deepEqual(second.versions.map(v => v.id), first.versions.map(v => v.id), 'the same design gets the same id every time');
  const report = await store.migrateVersions({freeBytes: async () => 1e12});
  assert.deepEqual(report.migrated, [id]);
  const migrated = await store.get(id);
  assert.deepEqual(migrated.versions.map(v => v.id), first.versions.map(v => v.id));
  assert.deepEqual((await listVersions(store.dir(id))).sort(), migrated.versions.map(v => v.id).sort(), 'one folder per design, nothing else');
  for (const version of migrated.versions) assert.ok((await readFile(join(store.dir(id), version.result.model))).length > 0);
});
