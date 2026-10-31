import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function setup(outcome = {status: 'done', summary: 'Fixed the card.'}, {throws, delayMs = 0} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-svc-'));
  const store = new ObjectStore(join(root, 'objects'));
  const calls = [];
  const runTouchup = async input => {
    calls.push(input);
    await new Promise(r => setTimeout(r, delayMs));
    if (throws) throw new Error(throws);
    const passDir = join(root, 'pass-' + calls.length), out = join(passDir, 'out');
    await mkdir(out, {recursive: true});
    const model = join(out, 'touched.stl');
    await writeFile(model, STL);
    await writeFile(join(out, 'front.png'), 'png');
    const hasModel = !['failed'].includes(outcome.status) || outcome.withModel;
    return {renders: [join(out, 'front.png')], checkpoints: [], stats: {seconds: 7, toolCalls: 3, costUsd: 0.5}, passDir,
      ...outcome, ...(hasModel ? {model} : {})};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}});
  const object = await service.create('A hook for a 25 mm handle.');
  await service.addScan(object.id, 'scan.usdz', Buffer.from('usdz'));
  return {service, store, calls, object, root};
}

test('start runs the touch-up and the object becomes ready with its model and size', async () => {
  const {service, object, calls, store} = await setup();
  await service.addPhoto(object.id, 'IMG_1.HEIC', Buffer.from('img'));
  const started = await service.start(object.id);
  assert.equal(started.state, 'touching-up');
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.current.summary, 'Fixed the card.');
  assert.deepEqual(done.current.sizeMm, [60.6, 45.2, 21.7]);
  assert.equal(await readFile(join(store.dir(object.id), done.current.model), 'utf8'), STL);
  assert.ok(existsSync(join(store.dir(object.id), done.current.renders[0])));
  assert.equal(done.passes.length, 1);
  assert.equal(done.passes[0].status, 'done');
  assert.equal(calls[0].instructions, 'A hook for a 25 mm handle.');
  assert.deepEqual(calls[0].scan, [join(store.dir(object.id), 'scan', 'scan.usdz')]);
});

test('a question about a close-up becomes needs-closeup', async () => {
  const {service, object} = await setup({status: 'needs_closeup', closeup: 'the underside', summary: 'Fixed the card.'});
  await service.start(object.id);
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'needs-closeup');
  assert.deepEqual(settled.question, {closeup: 'the underside'});
});

test('a failed pass becomes failed with its reason', async () => {
  const {service, object} = await setup({status: 'failed', reason: 'Not logged in'});
  await service.start(object.id);
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.failure, 'Not logged in');
});

test('an engine error becomes failed with its message', async () => {
  const {service, object} = await setup(undefined, {throws: "Blender isn't set up in your printer MCP."});
  await service.start(object.id);
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'failed');
  assert.match(settled.failure, /Blender isn't set up/);
});

test('nothing to change is still ready to print', async () => {
  const {service, object} = await setup({status: 'unchanged'});
  await service.start(object.id);
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'ready');
  assert.equal(settled.current.summary, 'Nothing needed changing.');
});

test('a second start while touching up does nothing', async () => {
  const {service, object, calls} = await setup(undefined, {delayMs: 100});
  await service.start(object.id);
  const again = await service.start(object.id);
  assert.equal(again.state, 'touching-up');
  await service.settled(object.id);
  assert.equal(calls.length, 1);
});

test('photos can only be added before starting or when asked for a close-up', async () => {
  const {service, object} = await setup(undefined, {delayMs: 50});
  await service.start(object.id);
  await assert.rejects(service.addPhoto(object.id, 'late.jpg', Buffer.from('x')), InvalidStateError);
  await service.settled(object.id);
});

test('a correction runs from the current model with the note, the last summary and the original instructions', async () => {
  const {service, object, calls, store} = await setup();
  await service.start(object.id);
  await service.settled(object.id);
  await service.correct(object.id, 'make it 2 mm thicker');
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'ready');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].scan, [join(store.dir(object.id), 'current', 'model.stl')]);
  assert.equal(calls[1].note, 'make it 2 mm thicker');
  assert.equal(calls[1].summary, 'Fixed the card.');
  assert.equal(calls[1].instructions, 'A hook for a 25 mm handle.');
  assert.equal(settled.passes.length, 2);
});

test('make your best guess runs a pass that fills in what it could not see', async () => {
  const {service, object, calls} = await setup({status: 'needs_closeup', closeup: 'the underside', summary: 's'});
  await service.start(object.id);
  await service.settled(object.id);
  await service.answerCloseup(object.id, {bestGuess: true});
  await service.settled(object.id);
  assert.match(calls[1].note, /best guess/);
});

test('more than 24 photos sends 24, evenly spread from first to last', async () => {
  const {service, object, calls, store} = await setup();
  for (let i = 1; i <= 30; i++) await service.addPhoto(object.id, `p${String(i).padStart(2, '0')}.jpg`, Buffer.from('x'));
  await service.start(object.id);
  await service.settled(object.id);
  const sent = calls[0].photos;
  assert.equal(sent.length, 24);
  assert.equal(sent[0], join(store.dir(object.id), 'photos', 'p01.jpg'));
  assert.equal(sent.at(-1), join(store.dir(object.id), 'photos', 'p30.jpg'));
});

test('a model the engine stopped early is kept and shown as ready with a note', async () => {
  const {service, object} = await setup({status: 'capped', reason: 'stopped at the 900 s time limit', summary: undefined});
  await service.start(object.id);
  const settled = await service.settled(object.id);
  assert.equal(settled.state, 'ready');
  assert.match(settled.current.summary, /time limit/);
});
