import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {createServer} from 'node:http';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {tempDir} from './support/temp.mjs';

const STL = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 3)]);
const until = async check => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };

/** A scripted touch-up worker: each pass follows the next outcome. */
async function setup(t, outcomes) {
  const root = await tempDir('objects-passes-');
  // Stage timings are written in the background after a pass ends: retry the cleanup.
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [], inputs = [];
  let gate;
  const runTouchup = async input => {
    inputs.push(input);
    const outcome = outcomes[inputs.length - 1];
    input.onStage?.('preparing', outcome.engine === 'code' ? 'code' : 'blender');
    if (outcome.liveSession) input.onProgress?.({seconds: 0, toolCalls: 0, sessionId: outcome.liveSession, passDir: join(root, `pass-${inputs.length}`), resumable: true});
    if (outcome.wait) await new Promise(resolve => { gate = resolve; });
    input.onStage?.('working', outcome.engine ?? 'blender');
    const passDir = join(root, `pass-${inputs.length}`), out = join(passDir, 'out');
    await mkdir(join(passDir, 'photos'), {recursive: true}); await mkdir(out, {recursive: true});
    await writeFile(join(passDir, 'photos', 'photo-01.jpg'), JPEG);
    await writeFile(join(out, 'view.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    const model = join(out, 'touched.stl');
    await writeFile(model, STL);
    let parts;
    if (outcome.parts) { parts = join(out, 'touched.3mf'); await writeFile(parts, Buffer.from('PK\x03\x04 two parts')); }
    let design;
    if (outcome.engine === 'fusion') {
      await writeFile(join(out, 'touched.f3d'), 'f3d'); await writeFile(join(out, 'touched.parameters.json'), '{"width":40}');
      design = {f3d: join(out, 'touched.f3d'), parameters: join(out, 'touched.parameters.json')};
    }
    if (outcome.engine === 'code') {
      // One cad_run's folder, as the printer MCP leaves it (PRD §8.9).
      const run = join(passDir, 'cad', 'cad-touched-1');
      await mkdir(join(run, 'inputs'), {recursive: true});
      await writeFile(join(run, 'touched.py'), `# pass ${inputs.length}`); await writeFile(join(run, 'touched.parameters.json'), '{"cup_h":70}');
      await writeFile(join(run, 'touched.step'), 'STEP'); await writeFile(join(run, 'inputs', 'mesh.obj'), 'mesh');
      await writeFile(join(run, 'touched.inputs.json'), JSON.stringify({scan: join(run, 'inputs', 'mesh.obj')}));
      await writeFile(join(run, 'cad-result.json'), JSON.stringify({status: 'completed', final: true, valid: true, checks: {watertight: true}}));
      design = {script: join(run, 'touched.py'), parameters: join(run, 'touched.parameters.json'), inputs: join(run, 'touched.inputs.json'), step: join(run, 'touched.step'), result: join(run, 'cad-result.json')};
    }
    if (outcome.answered) input.onProgress?.({seconds: 1, toolCalls: 1, resumable: false});
    if (outcome.throw) throw new Error(outcome.throw);
    return {renders: [], checkpoints: [], stats: {seconds: 3, toolCalls: 2}, passDir, ...(outcome.status !== 'needs_closeup' && outcome.status !== 'failed' ? {model} : {}),
      ...(design ? {design} : {}), ...(parts ? {parts} : {}), ...outcome.result, status: outcome.status ?? 'done', ...(outcome.engine ? {engine: outcome.engine} : {}), ...(outcome.note ? {note: outcome.note} : {})};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.2, 45.1, 21.7], claudePath: '/unused', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    events: {emit: async draft => { events.push(draft); }}, passTimings: new PassTimings(join(root, 'timings.json')), titleFor: async request => request.includes('mic') ? 'Mic mount' : undefined});
  t.after(() => service.close());
  return {service, store, events, inputs, root, release: () => gate?.()};
}

test('a design in several colours keeps its multi-part 3MF as the model, and is revised from its mesh', async t => {
  const partColours = [{name: 'body', colour: '#111111'}, {name: 'letters', colour: '#FFD200', material: 'PLA'}];
  const f = await setup(t, [{engine: 'fusion', parts: true, result: {summary: 'Black pick, yellow Vivi.', partColours}}, {engine: 'fusion', result: {summary: 'One colour now.'}}]);
  const object = await f.service.create('A guitar pick that says Vivi, black with yellow letters', 'fit');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.equal(ready.current.model, 'current/model.3mf', 'the parts and their filaments are what prints');
  assert.deepEqual(ready.current.filaments, partColours, 'the colours the parts belong in are kept with the model');
  const dir = f.store.dir(object.id);
  assert.equal((await readFile(join(dir, 'current', 'model.3mf'))).subarray(0, 2).toString(), 'PK');
  assert.ok((await readFile(join(dir, 'current', 'model.stl'), 'utf8')).startsWith('solid'), 'the merged mesh stays for sizing and revisions');
  await f.service.correct(object.id, 'Make it all black');
  const revised = await f.service.settled(object.id);
  assert.ok(f.inputs[1].scan[0].endsWith(join('current', 'model.stl')), 'the next pass edits the mesh, not the 3MF');
  assert.equal(revised.current.model, 'current/model.stl');
  assert.equal(revised.current.filaments, undefined, 'a one-colour revision leaves no stale colours');
  await assert.rejects(readFile(join(dir, 'current', 'model.3mf')), {code: 'ENOENT'}, 'a one-colour revision leaves no stale parts file');
});

test("a copy of a designer's 3MF works on that 3MF every pass, never its merged mesh (the Nov 4 caliper card)", async t => {
  // Pass 3 of the caliper card was given the merged STL, rebuilt a bare 3MF from it and lost the designer's
  // print settings and painted markings; the printed card no longer folded.
  const f = await setup(t, [{parts: true, result: {summary: 'Logo swapped.'}}, {parts: true, result: {summary: 'Logo moved.'}}]);
  const object = await f.service.create('use this caliper card exactly but add the counterpart logo to it', 'copy');
  const {zipSync, strToU8} = (await import('node:module')).createRequire(new URL('../../printer-handoff/package.json', import.meta.url))('fflate');
  const designer = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>')}));
  await f.service.addScan(object.id, 'scan.3mf', designer);
  await f.service.start(object.id);
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[0].scan.map(path => basename(path)), ['scan.3mf'], 'the first pass edits the designer\'s file');
  assert.equal(f.inputs[0].designerCopy, true);
  await f.service.correct(object.id, 'Move the logo up a little');
  await f.service.settled(object.id);
  const dir = f.store.dir(object.id);
  assert.deepEqual(f.inputs[1].scan, [join(dir, 'current', 'model.3mf'), join(dir, 'scan', 'scan.3mf')],
    'a later pass edits the last 3MF and compares with the designer\'s own file');
  assert.equal(f.inputs[1].designerCopy, true);
  assert.equal(f.inputs[1].currentModel, false, 'it is not told it has a millimetre STL to import');
});

test('a copy started with nothing scanned designs its request, and stays a design after the first pass', async t => {
  const f = await setup(t, [{}, {}]);
  const object = await f.service.create('A guitar pick that says Vivi', 'copy');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  assert.equal(f.inputs[0].kind, 'fit');
  assert.equal((await f.store.get(object.id)).kind, 'fit', 'the decision is saved');
  await f.service.correct(object.id, 'Thinner');
  await f.service.settled(object.id);
  assert.equal(f.inputs[1].kind, 'fit', 'the model it made is not a scan to copy');
});

test('an unscanned copy that already made a model from its request is a new design (the Nov 2 guitar pick)', async t => {
  const f = await setup(t, [{}]);
  const object = await f.service.create('A guitar pick that says Vivi', 'copy');
  // Made before the fix: Blender passes on the request alone left a model and the kind "copy".
  await mkdir(join(f.store.dir(object.id), 'current'), {recursive: true});
  await writeFile(join(f.store.dir(object.id), 'current', 'model.stl'), 'solid pick');
  await f.store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  await f.service.correct(object.id, 'Thinner');
  await f.service.settled(object.id);
  assert.equal(f.inputs[0].kind, 'fit');
  assert.equal((await f.store.get(object.id)).kind, 'fit');
});

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
  assert.equal(f.events.at(-1).detail.size, '60.2 × 45.1 × 21.7 mm');
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
  const object = await f.service.create('Copy this clip holder.', 'copy');   // asked for: a touch-up runs (PRD §5.3)
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
  const folder = await tempDir('objects-passes-photo-');
  t.after(() => rm(folder, {recursive: true, force: true}));
  await writeFile(join(folder, 'side.jpg'), JPEG);
  await dispatch('objects.correct', {id: object.id, note: 'Use this side view', photos: [join(folder, 'side.jpg')]});
  assert.equal((await f.service.settled(object.id)).passes[1].trigger, 'late-photos');
  const status = await createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: f.service})('status.get', {});
  assert.equal(status.capabilities.structuredPasses, true);
});

test('without a kind, a scan is a copy even with a request; a request with photos alone is a new design', async () => {
  const {passKind} = await import('../dist/objects/service.js');
  const {publicObject} = await import('../dist/objects/http.js');
  const base = {id: 'p', createdAtMs: 1, updatedAtMs: 2, state: 'ready', photos: [], passes: []};
  assert.equal(publicObject({...base, kind: 'copy', instructions: 'A guitar pick that says Vivi'}).kind, 'fit', 'the apps receive the decided kind');
  assert.equal(publicObject({...base, scan: 'scan.usdz'}).kind, 'copy');
  assert.equal(passKind({instructions: 'Copy this. Close up the bottom.', scan: 'scan.usdz'}), 'copy', 'the phone sends only the request');
  assert.equal(passKind({instructions: 'Copy this.', capture: ['0001.heic']}), 'copy');
  assert.equal(passKind({instructions: 'A hook for a 25 mm rail'}), 'fit');
  assert.equal(passKind({}), 'copy');
  assert.equal(passKind({kind: 'fit', scan: 'scan.usdz', instructions: 'A mount that fits this'}), 'fit', 'a kind chosen at creation wins');
  // A project started as a copy that never received a scan or capture has nothing to copy:
  // its request is a new design (the Nov 2 guitar pick ran four Blender "scan fixes" on no scan).
  assert.equal(passKind({kind: 'copy', instructions: 'A guitar pick that says Vivi, black and yellow'}), 'fit');
  assert.equal(passKind({kind: 'copy', scan: 'scan.usdz', instructions: 'Close up the bottom.'}), 'copy');
  assert.equal(passKind({kind: 'copy', capture: ['0001.heic']}), 'copy');
  assert.equal(passKind({kind: 'copy'}), 'copy', 'no request and no scan: nothing to design');
  assert.equal(passKind({kind: 'copy', scan: 'scan.usdz', instructions: 'Clean it up', current: {model: 'current/model.stl', renders: []}}), 'copy', 'a duplicated copy keeps its scan and keeps cleaning its model');
  assert.equal(passKind({kind: 'copy', instructions: 'A pick that says Vivi', current: {model: 'current/model.stl', renders: []}}), 'fit', 'a model made from the request alone is a design');
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
  const root = await tempDir('objects-titles-');
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

test('a correction that changes nothing keeps a Done project Done', async t => {
  const f = await setup(t, [{result: {summary: 'Made it.'}}, {status: 'unchanged', result: {summary: 'It already fits.'}}]);
  const object = await f.service.create('A hook for the rail');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  await f.service.setStatus(object.id, 'works');
  await f.service.correct(object.id, 'Does it still fit the 25 mm rail?');
  const kept = await f.service.settled(object.id);
  assert.deepEqual([kept.state, kept.outcome, kept.passes.at(-1).status], ['confirmed', 'works', 'unchanged']);
  const {projectStatus} = await import('../dist/objects/service.js');
  assert.equal(projectStatus(kept), 'works');
});


test('a person renaming during a pass wins over the worker title', async t => {
  const f = await setup(t, [{wait: true, result: {title: 'Generated holder'}}]);
  const object = await f.service.create('A holder for the desk');
  await f.service.start(object.id);
  await until(() => f.inputs.length === 1);
  await f.service.rename(object.id, 'My desk holder');
  f.release();
  assert.equal((await f.service.settled(object.id)).title, 'My desk holder');
});

test('a person renaming while the title generator answers keeps their name', async t => {
  const root = await tempDir('title-race-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  const object = await store.update((await store.create('A holder')).id, o => ({...o, state: 'ready'}));
  let answer;
  const changes = [];
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, onChange: o => changes.push(o.title),
    titleFor: async () => new Promise(resolve => { answer = resolve; })});
  t.after(() => service.close());
  await service.list(); await until(() => answer);
  await service.rename(object.id, 'My own name');
  changes.length = 0;
  answer('Generated name');
  await until(() => changes.length);
  assert.deepEqual(changes, ['My own name']);
  assert.equal((await store.get(object.id)).title, 'My own name');
});


test('a pass uses its claimed photos and prior context, never a later queued message’s uploads', async t => {
  const f = await setup(t, [{}, {}, {}]);
  const object = await f.service.create('A mount');
  await f.service.addPhoto(object.id, 'initial.jpg', JPEG);
  await f.service.start(object.id); await f.service.settled(object.id);
  await f.service.addPhoto(object.id, 'a.jpg', JPEG);
  await f.service.addPhoto(object.id, 'b.jpg', JPEG);
  await f.service.correct(object.id, 'Change A', [], ['a.jpg']);
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[1].photos.map(path => basename(path)), ['initial.jpg', 'a.jpg']);
  assert.deepEqual((await f.store.get(object.id)).pendingPhotos, ['b.jpg']);
  await f.service.correct(object.id, 'Change B', [], ['b.jpg']);
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[2].photos.map(path => basename(path)), ['initial.jpg', 'a.jpg', 'b.jpg']);
  assert.deepEqual((await f.store.get(object.id)).pendingPhotos, []);
});


for (const [limit, reason] of [['step', 'stopped at the 120 tool-call limit'], ['time', 'stopped at the 900 s time limit']]) {
  for (const checkpoint of [true, false]) {
    test(`a ${limit}-capped pass ${checkpoint ? 'with' : 'without'} a checkpoint fails without announcing Ready`, async t => {
      const f = await setup(t, [
        {status: 'capped', result: {reason, ...(checkpoint ? {} : {model: undefined})}},
        {status: 'done', result: {summary: 'Finished on retry.'}},
      ]);
      const object = await f.service.create('Repair this scan.', 'copy');
      await f.service.addScan(object.id, 'scan.usdz', Buffer.from('original capture'));
      await f.service.start(object.id);
      const stopped = await f.service.settled(object.id);
      // The reason stands alone: this worker gave no session to carry on, so Try Again starts over and there is
      // nothing true to add that the button does not say (until Nov 10: "Try again or review the saved checkpoint.").
      const expected = `Stopped at the ${limit} limit.`;
      assert.equal(stopped.state, 'failed');
      assert.equal(publicObject(stopped).status.phase, 'failed');
      assert.equal(stopped.failure, expected);
      assert.equal(stopped.passes.at(-1).status, 'capped');
      assert.equal(stopped.passes.at(-1).activity.at(-1).text, expected);
      assert.equal(f.events.at(-1).type, 'pass.failed');
      assert.equal(f.events.at(-1).detail.reason, expected);
      assert.equal(f.events.some(event => event.type === 'pass.ready'), false);
      if (checkpoint) {
        assert.equal(await readFile(join(f.service.dir(object.id), stopped.current.model), 'utf8'), STL);
        assert.equal(await readFile(join(stopped.passes.at(-1).dir, 'out', 'touched.stl'), 'utf8'), STL);
        assert.match(stopped.current.summary, new RegExp(limit === 'step' ? '120 tool-call limit' : '900 s time limit'));
      } else assert.equal(stopped.current, undefined);
      await f.service.start(object.id);
      const retried = await f.service.settled(object.id);
      assert.equal(retried.state, 'ready');
      assert.equal(retried.failure, undefined);
      assert.equal(f.events.at(-1).type, 'pass.ready');
      assert.deepEqual(f.inputs[1].scan, f.inputs[0].scan, 'A legacy pass without a session still has its original inputs');
    });
  }
}


test('the shared Swift capped-retry fixture is the exact public projection without activity', async () => {
  const rows = JSON.parse(await readFile(new URL('../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/capped-projects.json', import.meta.url), 'utf8'));
  for (const row of rows) {
    const actual = JSON.parse(JSON.stringify(publicObject(row.input)));
    assert.deepEqual(actual, row.expected, row.name);
    assert.equal(actual.canRetryCleanup, row.retry, row.name);
    assert.ok(actual.passes.every(pass => !('activity' in pass)), row.name);
  }
});

for (const status of ['capped', 'failed']) test(`the next project request resumes a ${status} worker without a final answer`, async t => {
  const f = await setup(t, [{status, result: {reason: 'Stopped at a limit.', limit: {kind:'inactivity',value:600000}, sessionId:'recover-me', resumable:true}}, {status:'done'}]);
  const object = await f.service.create('An articulated unicorn', 'fit');
  await f.service.start(object.id);
  const stopped = await f.service.settled(object.id), pass = stopped.passes.at(-1);
  assert.equal(pass.sessionId, 'recover-me');
  assert.equal(publicObject(stopped).canRetryCleanup, true);
  // Whether the work is lost is the one thing worth saying under the reason: this stop can be carried on.
  if (status === 'capped') {
    assert.equal(stopped.failure, 'Stopped after 10 minutes without worker activity. Trying again carries on from where it stopped.');
    assert.equal(publicObject(stopped).status.detail, 'Stopped after 10 minutes without worker activity', 'the row is still the reason alone');
    assert.doesNotMatch(stopped.failure, /checkpoint|session|Try again/);
  } else assert.equal(stopped.failure, 'Stopped at a limit.', 'a worker\'s own failure sentence is left as it is');
  assert.deepEqual(pass.limit, {kind:'inactivity',value:600000});
  assert.equal(pass.toolCalls, 2);
  assert.deepEqual(pass.checkpoints, []);
  await f.service.correct(object.id, 'Please continue and add a mane');
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[1].resume, {sessionId:'recover-me', passDir:pass.dir});
  const wire = publicObject(stopped).passes.at(-1);
  assert.equal(wire.sessionId, undefined);
  assert.equal(wire.checkpoints, undefined);
  assert.deepEqual(wire.limit, pass.limit);
});

test('a completed answer or person cancellation never resumes an old worker', async t => {
  for (const result of [{sessionId:'finished',resumable:false}, {sessionId:'cancelled',resumable:false,reason:'cancelled'}]) {
    const f=await setup(t,[{status:'failed',result},{status:'done'}]);
    const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);await f.service.settled(o.id);
    await f.service.start(o.id);await f.service.settled(o.id);
    assert.equal(f.inputs[1].resume,undefined);
  }
});

test('session init and pass folder survive a companion restart before a final answer', async t => {
 const f=await setup(t,[{wait:true},{status:'done'}]);
 const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);
 await until(()=>f.inputs.length);
 f.inputs[0].onProgress({seconds:1,toolCalls:0,sessionId:'live-session',resumable:true,passDir:'/saved/pass'});
 await until(async()=> (await f.store.get(o.id)).passes.at(-1).sessionId==='live-session');
 const restarted=new ObjectStore(join(f.root,'objects'));await restarted.recoverInterrupted();
 const recovered=await restarted.get(o.id);
 assert.equal(recovered.passes.at(-1).sessionId,'live-session');assert.equal(recovered.passes.at(-1).dir,'/saved/pass');
 f.release();await f.service.settled(o.id);
});

test('closing the companion interrupts a worker without attributing it to the person', async t => {
 const f=await setup(t,[{wait:true,liveSession:'shutdown-session',status:'failed',result:{reason:'cancelled',sessionId:'shutdown-session',resumable:false}}]);
 const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);await until(()=>f.inputs.length);
 const closing=f.service.close();f.release();await closing;
 const stopped=await f.store.get(o.id);
 assert.equal(stopped.passes.at(-1).status,'interrupted');assert.equal(stopped.passes.at(-1).resumable,true);
 assert.match(stopped.failure,/Interrupted/);assert.doesNotMatch(stopped.failure,/cancelled/i);
});

test('a request after restart resumes the interrupted session from the saved cwd', async t => {
 const f=await setup(t,[{status:'done'}]),o=await f.service.create('A unicorn','fit');
 await f.store.update(o.id,old=>({...old,state:'touching-up',passes:[{startedAtMs:1,resumable:true,sessionId:'interrupted-session',sessionCwd:'/first/pass',dir:'/latest/pass'}]}));
 await f.store.recoverInterrupted();
 await f.service.start(o.id);await f.service.settled(o.id);
 assert.deepEqual(f.inputs[0].resume,{sessionId:'interrupted-session',passDir:'/latest/pass',sessionCwd:'/first/pass'});
});

for (const answered of [true, false]) test(`a ${answered ? 'post-worker throw after the final answer' : 'non-limit throw mid-pass'} never opts into resume`, async t => {
 const f=await setup(t,[{liveSession:'throw-session',answered,throw:'post-worker file step failed'},{status:'done'}]);
 const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);
 const failed=await f.service.settled(o.id);
 assert.equal(failed.passes.at(-1).sessionId,'throw-session');
 assert.equal(failed.passes.at(-1).resumable,false);
 await f.service.start(o.id);await f.service.settled(o.id);
 assert.equal(f.inputs[1].resume,undefined);
});

for (const answered of [false,true]) test(`a shutdown throw ${answered ? 'after the final answer cannot resume' : 'during a live session can resume'}`, async t => {
 const f=await setup(t,[{liveSession:'shutdown-throw',wait:true,answered,throw:'worker interrupted'}]);
 const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);await until(()=>f.inputs.length);
 const closing=f.service.close();f.release();await closing;
 const stopped=await f.store.get(o.id);
 assert.equal(stopped.passes.at(-1).resumable,!answered);
});

test('a file-copy throw after the worker answered becomes a non-resumable failed pass', async t => {
 const f=await setup(t,[{liveSession:'answered-file-copy',answered:true,result:{model:'/missing/answered-model.stl',sessionId:'answered-file-copy',resumable:false}},{status:'done'}]);
 const o=await f.service.create('A unicorn','fit');await f.service.start(o.id);
 const failed=await f.service.settled(o.id);
 assert.equal(failed.state,'failed');assert.equal(failed.passes.at(-1).resumable,false);
 await f.service.start(o.id);await f.service.settled(o.id);
 assert.equal(f.inputs[1].resume,undefined);
});

test('a code design is kept as the project\'s design source, a change starts from it, and a later Blender pass drops it', async t => {
  const f = await setup(t, [
    {engine: 'code', result: {summary: 'A bottle holder.'}},
    {engine: 'code', result: {summary: 'Taller.'}},
    {engine: 'blender', result: {summary: 'Smoothed.'}},
  ]);
  const object = await f.service.create('A holder for this bottle, 65 x 28 x 145 mm', 'fit');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.equal(ready.current.engine, 'code');
  assert.deepEqual(ready.passes[0].stages.map(stage => stage.words), ['Getting the design engine ready', 'Designing it', 'Saving the result'],
    'the pass says which engine it is getting ready once it has chosen');
  assert.deepEqual(ready.current.design, {script: 'current/design/touched.py', parameters: 'current/design/touched.parameters.json',
    inputs: 'current/design/touched.inputs.json', step: 'current/design/touched.step', result: 'current/design/touched.result.json'});
  assert.deepEqual(JSON.parse(await readFile(join(f.service.dir(object.id), 'current', 'design', 'touched.result.json'), 'utf8')).checks, {watertight: true},
    'the selected run\'s validation is kept with the design');
  const dir = f.service.dir(object.id);
  assert.equal(await readFile(join(dir, 'current', 'design', 'touched.py'), 'utf8'), '# pass 1');
  assert.equal(await readFile(join(dir, 'current', 'design', 'inputs', 'mesh.obj'), 'utf8'), 'mesh');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'current', 'design', 'touched.inputs.json'), 'utf8')), {scan: join(dir, 'current', 'design', 'inputs', 'mesh.obj')},
    'the saved inputs list points at the project\'s own copies, not the pass folder');
  // "Ask for changes" starts from the saved script and parameters.
  await f.service.correct(object.id, 'Make it 1 mm taller');
  await f.service.settled(object.id);
  assert.deepEqual(f.inputs[1].design, {script: join(dir, 'current', 'design', 'touched.py'), parameters: join(dir, 'current', 'design', 'touched.parameters.json'),
    inputs: join(dir, 'current', 'design', 'touched.inputs.json'), step: join(dir, 'current', 'design', 'touched.step'), result: join(dir, 'current', 'design', 'touched.result.json')});
  assert.equal(await readFile(join(dir, 'current', 'design', 'touched.py'), 'utf8'), '# pass 2');
  // A duplicate keeps the design source too.
  const copy = await f.service.duplicate(object.id);
  assert.equal(await readFile(join(f.service.dir(copy.id), 'current', 'design', 'touched.py'), 'utf8'), '# pass 2');
  assert.equal(await readFile(join(f.service.dir(copy.id), 'current', 'design', 'inputs', 'mesh.obj'), 'utf8'), 'mesh');
  assert.deepEqual(JSON.parse(await readFile(join(f.service.dir(copy.id), 'current', 'design', 'touched.inputs.json'), 'utf8')),
    {scan: join(f.service.dir(copy.id), 'current', 'design', 'inputs', 'mesh.obj')}, 'a duplicate\'s inputs are its own');
  // A pass on another engine replaces the model, so the old script no longer describes it.
  await f.service.correct(object.id, 'Smooth it');
  const later = await f.service.settled(object.id);
  assert.equal(later.current.engine, 'blender');
  assert.equal(later.current.design, undefined);
  await assert.rejects(readFile(join(dir, 'current', 'design', 'touched.py')), {code: 'ENOENT'});
});

test('a size question is its own kind: numbers on the wire, numbers back, and the worker is told which were measured and which accepted', async t => {
  const asked = [{label: 'width at the pink stripe', mm: 64, from: 'scan'}, {label: 'width at the waist', mm: 53, from: 'estimate'},
    {label: 'height to the cap tip', mm: 107, from: 'published', product: 'MiO 1.62 oz bottle', reference: 'the maker\'s product page'},
    {label: 'cap diameter', mm: 28, from: 'scan'}];
  const f = await setup(t, [
    {status: 'needs_closeup', result: {ask: {question: 'Can you confirm or correct these?', sizes: asked}}},
    {status: 'done'}]);
  const object = await f.service.create('A wall holder for three of these', 'fit', undefined, {sizeSource: 'lookup'});
  await f.service.start(object.id);
  const waiting = await f.service.settled(object.id);
  assert.equal(waiting.state, 'needs-closeup');
  const ask = publicObject(waiting).ask;
  assert.equal(ask.kind, 'sizes');
  assert.equal(ask.type, undefined, 'a client from before kinds shows the question and its text box');
  assert.deepEqual(ask.answers, ['sizes', 'text', 'camera']);
  assert.deepEqual(ask.sizes, asked.map((size, index) => ({id: `size-${index + 1}`, ...size})), 'each size keeps its source, product and reference');
  // Sizes it didn't ask about, a size twice, or a number that isn't one are refused, and nothing is consumed.
  for (const bad of [[{id: 'longest', mm: 60}], [{id: 'size-1', mm: 63}, {id: 'size-1', mm: 64}], [{id: 'size-1', mm: 0}], []])
    await assert.rejects(f.service.answerCloseup(object.id, {sizes: bad}), /sizes|size/i);
  assert.equal((await f.service.get(object.id)).ask.status, 'open');
  // One corrected, one typed again at the same number, two left as asked, with words beside them.
  await f.service.answerCloseup(object.id, {sizes: [{id: 'size-1', mm: 63}, {id: 'size-2', mm: 53}, {id: 'size-3', mm: 107}, {id: 'size-4', mm: 28}], measured: ['size-1', 'size-4'],
    text: 'The waist is where it narrows under the label.'});
  const done = await f.service.settled(object.id);
  assert.equal(done.state, 'ready');
  // New's fit choice is kept as it was; the checked sizes are their own list, by the question's labels, with their sources.
  assert.deepEqual(done.fit, {sizeSource: 'lookup'});
  assert.deepEqual(done.checkedSizes, [
    {label: 'width at the pink stripe', mm: 63, certainty: 'measured', from: 'scan', asked: 64},
    {label: 'width at the waist', mm: 53, certainty: 'accepted', from: 'estimate', asked: 53},
    {label: 'height to the cap tip', mm: 107, certainty: 'accepted', from: 'published', product: 'MiO 1.62 oz bottle', reference: 'the maker\'s product page', asked: 107},
    {label: 'cap diameter', mm: 28, certainty: 'measured', from: 'scan', asked: 28}]);
  assert.equal(publicObject(done).checkedSizes, undefined, 'the companion\'s own record');
  // The person's own message says which numbers they measured and which they let stand.
  assert.ok(done.messages.some(message => message.text === 'The waist is where it narrows under the label.'));
  const note = f.inputs[1].note;
  assert.match(note, /Only the ones marked "measured by the person" were measured on the real object[^\n]*\n- width at the pink stripe: 63 mm, measured by the person \(you had 64 mm\)\n- width at the waist: 53 mm, accepted; your estimate, not a measurement\n- height to the cap tip: 107 mm, accepted; published for MiO 1\.62 oz bottle \(source: the maker's product page\)\n- cap diameter: 28 mm, measured by the person\n/);
  assert.doesNotMatch(note, /Treat these as measured/);
  assert.match(note, /The waist is where it narrows under the label\./);
  // This pass and every later one are told each size by its label and how sure it is, never as "the overall size";
  // the request is still only the person's words.
  assert.match(f.inputs[1].instructions, /Sizes from the person's answers to your earlier questions[^\n]*\n- width at the pink stripe: 63 mm, measured by the person \(you had 64 mm\)\n- width at the waist: 53 mm, accepted; your estimate, not a measurement\n- height to the cap tip: 107 mm, accepted; published for MiO 1\.62 oz bottle \(source: the maker's product page\)\n- cap diameter: 28 mm, measured by the person$/);
  assert.doesNotMatch(f.inputs[1].instructions, /exact overall size/);
  assert.equal(publicObject(done).instructions, 'A wall holder for three of these');
});

test('a sizes answer with no words shows the person\'s numbers as measured or accepted as asked', async t => {
  const f = await setup(t, [
    {status: 'needs_closeup', result: {ask: {question: 'Is this right?', sizes: [{label: 'width', mm: 64, from: 'scan'}, {label: 'depth', mm: 30, from: 'estimate'}]}}},
    {status: 'done'}]);
  const object = await f.service.create('A clip', 'fit', undefined, {sizeSource: 'lookup'});
  await f.service.start(object.id);
  await f.service.settled(object.id);
  // As a phone from before Nov 12 sends it: no `measured`.
  await f.service.answerCloseup(object.id, {sizes: [{id: 'size-1', mm: 64}, {id: 'size-2', mm: 31}]});
  const done = await f.service.settled(object.id);
  assert.equal(done.messages.at(-1).text, 'width: 64 mm (accepted as asked)\ndepth: 31 mm (measured)');
  assert.deepEqual(done.checkedSizes.map(size => size.certainty), ['accepted', 'measured']);
});

test('a published size with no product or source named is not kept: the question stands as words', async t => {
  for (const size of [{label: 'width', mm: 71.5, from: 'published'}, {label: 'width', mm: 71.5, from: 'published', product: 'iPhone 16 Pro'}]) {
    const f = await setup(t, [{status: 'needs_closeup', result: {closeup: 'the phone', ask: {question: 'Is this the width?', sizes: [size]}}}]);
    const object = await f.service.create('A phone mount', 'fit');
    await f.service.start(object.id);
    const ask = publicObject(await f.service.settled(object.id)).ask;
    assert.equal(ask.kind, 'closeup', JSON.stringify(size));
    assert.equal(ask.sizes, undefined);
  }
});

test('a question with no sizes, or with a size that is not whole, stays a close-up question', async t => {
  for (const sizes of [undefined, [{label: 'width', mm: 64, from: 'guess'}], [{label: '', mm: 64, from: 'scan'}], [{label: 'width', mm: -1, from: 'scan'}]]) {
    const f = await setup(t, [{status: 'needs_closeup', result: {closeup: 'the clip', ask: {question: 'Can you take a close-up of the clip?', ...(sizes ? {sizes} : {})}}}]);
    const object = await f.service.create('A hook', 'fit');
    await f.service.start(object.id);
    const ask = publicObject(await f.service.settled(object.id)).ask;
    assert.equal(ask.kind, 'closeup');
    assert.equal(ask.sizes, undefined);
    assert.deepEqual(ask.answers, ['camera', 'photos', 'best-guess', 'text']);
    await assert.rejects(f.service.answerCloseup(object.id, {sizes: [{id: 'size-1', mm: 5}]}), /did not ask for sizes/);
  }
});

// Board X68: a question is open until it is answered or a pass takes its place. A pass started over an unanswered
// question used to leave it "open" behind a project that had moved on: ready, with a question nobody could answer
// and, on Linux, Print disabled for good. Which starts take a question's place, by the pass's trigger:
//   new (the first pass and Try Again) ........ closes it     (below)
//   changes (a change instead of an answer) ... closes it     (below)
//   late-photos (the same, with photos) ....... closes it     (below)
//   ask-answer (the answer itself) ............ already closed by the answer ('a size question is its own kind…')
//   locate ("See it together") ................ leaves it     (objects-seats: 'locate leaves an open question exactly as it was')
test('a question left unanswered is no longer open once a pass takes its place', async t => {
  const asking = {status: 'needs_closeup', result: {closeup: 'the clip', ask: {question: 'Can you take a close-up of the clip?'}}};
  // Try Again over the question, with no result yet.
  const first = await setup(t, [asking, {status: 'done'}]);
  const a = await first.service.create('A hook', 'fit');
  await first.service.start(a.id);
  assert.equal((await first.service.settled(a.id)).ask.status, 'open');
  await first.service.start(a.id);
  const retried = await first.service.settled(a.id);
  assert.equal(retried.state, 'ready');
  assert.equal(retried.ask.status, 'answered', 'the pass that asked is over');
  assert.deepEqual(retried.passes.map(pass => pass.trigger), ['new', 'new']);
  assert.equal(publicObject(retried).status.phase, 'ready');
  // A change sent instead of an answer, on a project that already has a result.
  const second = await setup(t, [{status: 'done'}, asking, {status: 'done'}]);
  const b = await second.service.create('A hook', 'fit');
  await second.service.start(b.id);
  await second.service.settled(b.id);
  await second.service.correct(b.id, 'Make it thicker');
  assert.equal((await second.service.settled(b.id)).ask.status, 'open');
  await second.service.correct(b.id, 'Never mind the clip, just make it thicker');
  const changed = await second.service.settled(b.id);
  assert.equal(changed.state, 'ready');
  assert.equal(changed.ask.status, 'answered');
  assert.deepEqual(changed.passes.map(pass => pass.trigger), ['new', 'changes', 'changes']);
  // The same with a photo attached.
  const withPhoto = await setup(t, [{status: 'done'}, asking, {status: 'done'}]);
  const d = await withPhoto.service.create('A hook', 'fit');
  await withPhoto.service.start(d.id);
  await withPhoto.service.settled(d.id);
  await withPhoto.service.correct(d.id, 'Make it thicker');
  assert.equal((await withPhoto.service.settled(d.id)).ask.status, 'open');
  const folder = await tempDir('objects-passes-superseded-');
  t.after(() => rm(folder, {recursive: true, force: true}));
  await writeFile(join(folder, 'side.jpg'), JPEG);
  await withPhoto.service.correct(d.id, 'Use this side view instead', [join(folder, 'side.jpg')]);
  const photographed = await withPhoto.service.settled(d.id);
  assert.equal(photographed.passes.at(-1).trigger, 'late-photos');
  assert.equal(photographed.ask.status, 'answered');
  // A pass that asks again opens its own question.
  const third = await setup(t, [asking, {status: 'needs_closeup', result: {closeup: 'the hinge', ask: {question: 'Can you take a close-up of the hinge?'}}}]);
  const c = await third.service.create('A hook', 'fit');
  await third.service.start(c.id);
  const before = (await third.service.settled(c.id)).ask.id;
  await third.service.start(c.id);
  const again = await third.service.settled(c.id);
  assert.equal(again.ask.status, 'open');
  assert.notEqual(again.ask.id, before);
  assert.match(again.ask.question, /hinge/);
});
