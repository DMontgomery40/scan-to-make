import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';

const STL = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 3)]);
const until = async check => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };

/** A scripted touch-up worker: each pass follows the next outcome. */
async function setup(t, outcomes) {
  const root = await mkdtemp(join(tmpdir(), 'objects-passes-'));
  // Stage timings are written in the background after a pass ends: retry the cleanup.
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [], inputs = [];
  let gate;
  const runTouchup = async input => {
    inputs.push(input);
    const outcome = outcomes[inputs.length - 1];
    input.onStage?.('preparing', 'blender');
    if (outcome.wait) await new Promise(resolve => { gate = resolve; });
    input.onStage?.('working', outcome.engine ?? 'blender');
    const passDir = join(root, `pass-${inputs.length}`), out = join(passDir, 'out');
    await mkdir(join(passDir, 'photos'), {recursive: true}); await mkdir(out, {recursive: true});
    await writeFile(join(passDir, 'photos', 'photo-01.jpg'), JPEG);
    await writeFile(join(out, 'view.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const model = join(out, 'touched.stl');
    await writeFile(model, STL);
    let design;
    if (outcome.engine === 'fusion') {
      await writeFile(join(out, 'touched.f3d'), 'f3d'); await writeFile(join(out, 'touched.parameters.json'), '{"width":40}');
      design = {f3d: join(out, 'touched.f3d'), parameters: join(out, 'touched.parameters.json')};
    }
    return {renders: [], checkpoints: [], stats: {seconds: 3, toolCalls: 2}, passDir, ...(outcome.status !== 'needs_closeup' && outcome.status !== 'failed' ? {model} : {}),
      ...(design ? {design} : {}), ...outcome.result, status: outcome.status ?? 'done', ...(outcome.engine ? {engine: outcome.engine} : {}), ...(outcome.note ? {note: outcome.note} : {})};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.2, 45.1, 21.7], claudePath: '/unused', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    events: {emit: async draft => { events.push(draft); }}, passTimings: new PassTimings(join(root, 'timings.json')), titleFor: async request => request.includes('mic') ? 'Mic mount' : undefined});
  t.after(() => service.close());
  return {service, store, events, inputs, root, release: () => gate?.()};
}

test('a design pass reports stages with an estimate, its title, what changed, and its Fusion design for next time', async t => {
  const f = await setup(t, [
    {wait: true, engine: 'fusion', result: {summary: 'A clamp-on mount.', title: 'Clamp mount', changes: [{tag: 'added', text: 'A 25 mm clamp'}, {tag: 'estimated', text: 'Stand pole 25 mm', toleranceMm: 1}]}},
    {engine: 'fusion', result: {summary: 'Wider.'}},
  ]);
  const object = await f.service.create('A mic mount for the stand', 'fit');
  const started = await f.service.start(object.id);
  assert.equal(started.passes[0].trigger, 'new');
  assert.equal(started.passes[0].stages[0].id, 'preparing');
  assert.equal(started.passes[0].estimate.remainingSec, 450);
  assert.equal(publicObject(started).status.phase, 'working');
  await until(async () => (await f.service.get(object.id)).title === 'Mic mount');
  // Reads count the estimate down, from the stored stages.
  const stored = await f.store.get(object.id);
  await f.store.update(object.id, o => ({...o, passes: o.passes.map(p => ({...p, stages: p.stages.map(stage => ({...stage, startedAtMs: stage.startedAtMs - 15_000}))}))}));
  const later = await f.service.get(object.id);
  assert.ok(later.passes[0].estimate.remainingSec < stored.passes[0].estimate.remainingSec);
  assert.ok(later.passes[0].estimate.endsAtMs >= Date.now());
  f.release();
  const ready = await f.service.settled(object.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.title, 'Mic mount', 'the quick title stays; the worker\'s title only fills a gap');
  assert.equal(ready.kind, 'fit');
  assert.deepEqual(ready.current.changes, [{tag: 'added', text: 'A 25 mm clamp'}, {tag: 'estimated', text: 'Stand pole 25 mm', toleranceMm: 1}]);
  assert.equal(ready.current.engine, 'fusion');
  assert.deepEqual(ready.current.design, {f3d: 'current/design.f3d', parameters: 'current/parameters.json'});
  assert.equal(await readFile(join(f.service.dir(object.id), 'current', 'parameters.json'), 'utf8'), '{"width":40}');
  const pass = ready.passes[0];
  assert.deepEqual(pass.stages.map(stage => [stage.id, stage.words, stage.endedAtMs !== undefined]), [
    ['preparing', 'Getting Blender ready', true], ['working', 'Designing it', true], ['saving', 'Saving the result', true]]);
  assert.equal(pass.engine, 'fusion');
  assert.equal(pass.estimate, undefined);
  assert.deepEqual(f.events.map(e => e.type), ['pass.started', 'pass.stage', 'pass.stage', 'pass.ready']);
  assert.equal(f.events.at(-1).detail.size, '60 × 45 × 22 mm');
  // A change starts from the parametric design.
  await f.service.correct(object.id, 'Make it 1 mm wider');
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[1].design, {f3d: join(f.service.dir(object.id), 'current', 'design.f3d'), parameters: join(f.service.dir(object.id), 'current', 'parameters.json')});
  assert.equal((await f.service.get(object.id)).passes[1].trigger, 'changes');
});

test('a structured Ask: one question, its picture with the region, and the answers allowed; text answers start the next pass', async t => {
  const f = await setup(t, [
    {status: 'needs_closeup', result: {closeup: 'the clip', ask: {question: 'Can you take a close-up of the clip on the left?', photo: 'photo-01.jpg', region: {x: 0.1, y: 0.2, width: 0.3, height: 0.3}}}},
    {result: {summary: 'Done.', title: 'Clip holder'}},
  ]);
  const object = await f.service.create(undefined, 'copy');
  await f.store.addFile(object.id, 'scan', 'scan.usdz', Buffer.from('usdz'));
  await f.store.update(object.id, o => ({...o, scan: 'scan.usdz', photos: ['front.jpg']}));
  await f.store.addFile(object.id, 'photos', 'front.jpg', JPEG);
  await f.service.start(object.id);
  const asked = await f.service.settled(object.id);
  assert.equal(asked.state, 'needs-closeup');
  assert.equal(asked.ask.question, 'Can you take a close-up of the clip on the left?');
  assert.deepEqual(asked.ask.answers, ['camera', 'photos', 'best-guess', 'text']);
  assert.deepEqual(asked.ask.region, {x: 0.1, y: 0.2, width: 0.3, height: 0.3});
  assert.equal(asked.ask.status, 'open');
  assert.equal(asked.question.closeup, 'the clip', 'older apps still get their question');
  assert.deepEqual(f.events.at(-1), {...f.events.at(-1), type: 'pass.ask', data: {askId: asked.ask.id}, detail: {question: 'Can you take a close-up of the clip on the left?'}});
  // The picture is served for this Ask only.
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/${object.id}`;
  const picture = await fetch(`${base}/${asked.ask.photo}`);
  assert.equal(picture.status, 200);
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), JPEG);
  assert.equal((await fetch(`${base}/asks/00000000-0000-4000-8000-000000000000.jpg`)).status, 404);
  const answered = await (await fetch(`${base}/closeup`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text: 'It has a 3 mm lip'})})).json();
  assert.equal(answered.object.passes[1].trigger, 'ask-answer');
  assert.equal(answered.object.ask.status, 'answered');
  assert.match(f.inputs[1].note, /It has a 3 mm lip/);
  const done = await f.service.settled(object.id);
  assert.equal(done.title, 'Clip holder', 'a copy gets its title from the worker');
  assert.equal(done.kind, 'copy');
});

test('a failed pass says why as an event; correction photos make it a late-photos pass; the Mac creates a project of a kind', async t => {
  const f = await setup(t, [{status: 'failed', result: {reason: 'Blender stopped responding.'}}, {result: {summary: 'ok'}}]);
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: f.service});
  const {object} = await dispatch('objects.create', {instructions: 'A hook', kind: 'fit'});
  assert.equal(object.kind, 'fit');
  await f.service.start(object.id);
  const failed = await f.service.settled(object.id);
  assert.equal(failed.state, 'failed');
  assert.equal(f.events.at(-1).type, 'pass.failed');
  assert.equal(f.events.at(-1).detail.reason, 'Blender stopped responding.');
  const folder = await mkdtemp(join(tmpdir(), 'objects-passes-photo-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  await writeFile(join(folder, 'side.jpg'), JPEG);
  await dispatch('objects.correct', {id: object.id, note: 'Use this side view', photos: [join(folder, 'side.jpg')]});
  assert.equal((await f.service.settled(object.id)).passes[1].trigger, 'late-photos');
  const status = await createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: f.service})('status.get', {});
  assert.equal(status.capabilities.structuredPasses, true);
});

test('without a kind, a scan is a copy even with a request; a request with photos alone is a new design', async () => {
  const {passKind} = await import('../dist/objects/service.js');
  assert.equal(passKind({instructions: 'Copy this. Close up the bottom.', scan: 'scan.usdz'}), 'copy', 'the phone sends only the request');
  assert.equal(passKind({instructions: 'Copy this.', capture: ['0001.heic']}), 'copy');
  assert.equal(passKind({instructions: 'A hook for a 25 mm rail'}), 'fit');
  assert.equal(passKind({}), 'copy');
  assert.equal(passKind({kind: 'fit', scan: 'scan.usdz', instructions: 'A mount that fits this'}), 'fit', 'a kind chosen at creation wins');
});

test('an Ask pointing at a PNG render is still served at asks/<id>.jpg, as the protocol says', async t => {
  const f = await setup(t, [{status: 'needs_closeup', result: {ask: {question: 'Is the lip on this side?', photo: 'view.png', region: {x: 0, y: 0, width: 1, height: 1}}}}]);
  const object = await f.service.create('A clip', 'fit');
  await f.service.start(object.id);
  const asked = await f.service.settled(object.id);
  assert.match(asked.ask.photo, /^asks\/[0-9a-f-]{36}\.jpg$/);
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const picture = await fetch(`http://127.0.0.1:${server.address().port}/v1/objects/${object.id}/${asked.ask.photo}`);
  assert.equal(picture.status, 200);
  assert.match(picture.headers.get('content-type'), /^image\/(jpeg|png)$/);
});

test('a project from before titles gets one the first time it is listed, once, and never shows a null title meanwhile', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-titles-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  const old = await store.update((await store.create('A mount for my mic stand that clamps on a 25 mm pole')).id, o => ({...o, state: 'ready'}));
  const scan = await store.update((await store.create()).id, o => ({...o, state: 'ready'}));
  const fresh = await store.create('A mic clip, not started yet');
  const asked = [];
  let answer;
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('no passes here'); }, stlInfo: async () => [1, 1, 1], claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    titleFor: request => { asked.push(request); return new Promise(resolve => { answer = resolve; }); }});
  t.after(() => service.close());
  const titles = async () => Object.fromEntries((await service.list()).map(o => [o.id, publicObject(o).title]));
  const first = await titles();
  assert.equal(first[old.id], 'A mount for my mic stand…', 'until it is generated: the request\'s first words');
  assert.equal(first[scan.id], 'Your project');
  assert.equal(first[fresh.id], 'A mic clip, not started yet');
  await titles(); await titles();
  await until(() => asked.length === 1);
  assert.deepEqual(asked, ['A mount for my mic stand that clamps on a 25 mm pole'], 'asked once, and not for a new project (its first pass names it)');
  answer('Mic mount.');
  await until(async () => (await store.get(old.id)).title === 'Mic mount');
  assert.equal((await titles())[old.id], 'Mic mount');
  assert.equal(asked.length, 1);
});

test('a changed model is not Done yet: a correction on a Works project clears it, so its next print asks again', async t => {
  const f = await setup(t, [{result: {summary: 'Made it.'}}, {result: {summary: 'Made it 5 mm longer.'}}]);
  const object = await f.service.create('A hook for the rail');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  const done = await f.service.setStatus(object.id, 'works');
  assert.deepEqual([done.state, done.outcome], ['confirmed', 'works']);
  await f.service.correct(object.id, 'Make it 5 mm longer');
  const changed = await f.service.settled(object.id);
  assert.deepEqual([changed.state, changed.outcome], ['ready', undefined]);
  const {projectStatus} = await import('../dist/objects/service.js');
  assert.equal(projectStatus(changed), 'not-printed');
});
