import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {PrintGate} from '../dist/printing/print-gate.js';
import {projectTitle} from '../dist/events/words.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function setup(outcome = {status: 'done', summary: 'Fixed the card.'}, {throws, delayMs = 0, outcomes, waitForAbort, printGate} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-svc-'));
  const store = new ObjectStore(join(root, 'objects'));
  const calls = [];
  const runTouchup = async input => {
    calls.push(input);
    if (waitForAbort) await new Promise(r => input.signal.addEventListener('abort', r, {once: true}));
    await new Promise(r => setTimeout(r, delayMs));
    if (outcomes) outcome = outcomes[calls.length - 1] ?? outcome;
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
  const service = new ObjectService({store, runTouchup, printGate, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c',
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

test('a photo added while a pass runs is kept for the next pass and leaves the running one alone', async () => {
  const {service, object, calls} = await setup(undefined, {delayMs: 50});
  await service.start(object.id);
  const late = await service.addPhoto(object.id, 'late.jpg', Buffer.from('x'));
  assert.ok(late.photos.includes('late.jpg'));
  assert.equal(calls[0].photos.some(path => path.endsWith('late.jpg')), false);
  await service.settled(object.id);
  await service.correct(object.id, 'Use the new photo.');
  await service.settled(object.id);
  assert.ok(calls.at(-1).photos.some(path => path.endsWith('late.jpg')));
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
  assert.equal(calls[1].currentModel, true);
  assert.equal(settled.passes.length, 2);
});

test('a failed photo-only project accepts a new request without losing retained inputs or history', async () => {
  const {service, calls, store} = await setup(undefined, {delayMs: 50});
  const history = [{startedAtMs: 10, endedAtMs: 20, status: 'failed', activity: [{atMs: 19, kind: 'message', text: 'The earlier attempt stopped.'}]}];
  for (const instructions of [undefined, 'Make the object in these photos.']) {
    const object = await service.create(instructions);
    await service.addPhoto(object.id, 'reference.jpg', Buffer.from('retained-photo'));
    await store.update(object.id, o => ({...o, state: 'failed', failure: 'Missing description.', passes: history}));
    await service.correct(object.id, '  Make a hook for a 25 mm handle.  ');
    await assert.rejects(service.correct(object.id, 'Another request while busy.'), InvalidStateError);
    const result = await service.settled(object.id), input = calls.at(-1);
    assert.equal(result.state, 'ready');
    assert.equal(result.instructions, instructions);
    assert.equal(input.instructions, instructions);
    assert.equal(input.note, 'Make a hook for a 25 mm handle.');
    assert.deepEqual(input.scan, []);
    assert.equal(input.currentModel, false);
    assert.deepEqual(input.photos, [join(store.dir(object.id), 'photos', 'reference.jpg')]);
    assert.equal(await readFile(input.photos[0], 'utf8'), 'retained-photo');
    assert.deepEqual(result.passes[0], history[0]);
    assert.equal(result.passes[1].note, input.note);
    assert.equal(result.passes.length, 2);
  }
  const unsent = await service.create('A draft.');
  await assert.rejects(service.correct(unsent.id, 'Start early.'), InvalidStateError);
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

test('a close-up answer after a correction carries on from the corrected model and the correction', async () => {
  const {service, object, calls, store} = await setup(undefined, {outcomes: [
    {status: 'done', summary: 'Fixed the card.'},
    {status: 'needs_closeup', closeup: 'the underside', summary: 'Need the underside.'},
    {status: 'done', summary: 'Made it 70 mm long.'},
    {status: 'needs_closeup', closeup: 'the underside', summary: 'Still need it.'},
    {status: 'done', summary: 'Guessed the underside.'},
  ]});
  await service.start(object.id);
  await service.settled(object.id);
  await service.correct(object.id, 'it is 70 mm long');
  assert.equal((await service.settled(object.id)).state, 'needs-closeup');
  await service.addPhoto(object.id, 'under.jpg', Buffer.from('img'));
  await service.answerCloseup(object.id, {bestGuess: false, photoNames: ['under.jpg']});
  await service.settled(object.id);
  const current = join(store.dir(object.id), 'current', 'model.stl');
  assert.deepEqual(calls[2].scan, [current]);
  assert.match(calls[2].note, /70 mm long/);
  assert.ok(calls[2].photos.some(path => path.endsWith('/under.jpg')));
  await service.correct(object.id, 'it is 70 mm long');
  await service.settled(object.id);
  await service.answerCloseup(object.id, {bestGuess: true});
  await service.settled(object.id);
  assert.deepEqual(calls[4].scan, [current]);
  assert.match(calls[4].note, /70 mm long/);
  assert.match(calls[4].note, /best guess/);
});

test('closing the service stops a running touch-up and waits for it', async () => {
  const {service, object, calls} = await setup(undefined, {waitForAbort: true});
  await service.start(object.id);
  await service.close();
  assert.equal(calls[0].signal.aborted, true);
});

test('two quick starts run one touch-up', async () => {
  const {service, object, calls} = await setup(undefined, {delayMs: 20});
  await Promise.all([service.start(object.id), service.start(object.id)]);
  await service.settled(object.id);
  assert.equal(calls.length, 1);
});

test('closing the companion stops object work before it shuts down', async () => {
  const {startCompanionServer} = await import('../dist/server.js');
  const {service, object, calls} = await setup(undefined, {waitForAbort: true});
  const server = await startCompanionServer({objects: service, port: 0});
  await service.start(object.id);
  await server.close();
  assert.equal(calls[0].signal.aborted, true);
});

test('photos alone, with no description and no scan, are refused before anything runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'objects-svc-'));
  const store = new ObjectStore(join(root, 'objects'));
  let ran = 0;
  const service = new ObjectService({store, runTouchup: async () => { ran++; throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}});
  const object = await service.create();
  await service.addPhoto(object.id, 'a.jpg', Buffer.from('img'));
  await assert.rejects(service.start(object.id), error => error instanceof InvalidStateError && /Describe what to make/.test(error.message));
  assert.equal(ran, 0);
  assert.equal((await service.get(object.id)).state, 'new');
});

test('a deleted project leaves a project.deleted event that says who deleted it; a refused delete leaves none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'objects-svc-'));
  const store = new ObjectStore(join(root, 'objects'));
  const events = [];
  const service = new ObjectService({store, runTouchup: async input => { await new Promise(r => input.signal.addEventListener('abort', r, {once: true})); throw new Error('stopped'); },
    stlInfo: async () => undefined, claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    events: {emit: async draft => { events.push(draft); }}});
  const busy = await service.create('A clip.');
  const phone = await service.create('A hook for a 25 mm handle.');
  const mac = await service.create('A bracket.');
  const unsaid = await service.create('A spacer.');
  await service.start(busy.id);
  await assert.rejects(service.delete(busy.id, 'mac'), InvalidStateError);
  await service.delete(phone.id, 'device-123');
  await service.delete(mac.id, 'mac');
  await service.delete(unsaid.id);
  const deleted = events.filter(event => event.type === 'project.deleted');
  assert.deepEqual(deleted.map(event => event.projectId), [phone.id, mac.id, unsaid.id], 'one per delete, none for the refused one');
  assert.deepEqual(deleted.map(event => event.data), [{by: 'device-123'}, {by: 'mac'}, undefined]);
  // The project is gone by the time the log adds words, so the event carries its title.
  assert.equal(deleted[0].detail.title, projectTitle(phone));
  assert.equal(deleted[0].detail.title, 'A hook for a 25 mm…');
  await service.close();
});

test('an object can be deleted, but not while it is being worked on', async () => {
  const {service, object, store} = await setup(undefined, {waitForAbort: true});
  const other = await service.create('A hook.');
  await service.start(object.id);
  await assert.rejects(service.delete(object.id), InvalidStateError);
  await service.delete(other.id);
  assert.equal(existsSync(store.dir(other.id)), false);
  assert.deepEqual((await service.list()).map(o => o.id).includes(other.id), false);
  await service.close();
});

test('a pass runs the printer MCP as the companion runs it now (after an MCP update), not the profile it started with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'objects-svc-'));
  const store = new ObjectStore(join(root, 'objects'));
  const seen = [];
  const updated = {backend: 'bambu-printer-mcp', process: {command: '/opt/homebrew/bin/npx', args: ['-y', 'bambu-printer-mcp@1.1.50']}};
  const service = new ObjectService({store, runTouchup: async input => { seen.push(input.handoff); throw new Error('stop here'); },
    stlInfo: async () => undefined, claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, runningHandoff: () => updated});
  const object = await service.create('A hook for a 25 mm handle.');
  await service.addScan(object.id, 'scan.usdz', Buffer.from('usdz'));
  await service.start(object.id);
  await service.settled(object.id);
  assert.deepEqual(seen, [updated]);
});


test('a pass rejected before setup releases the MCP install reservation', async () => {
  const printGate = new PrintGate();
  const {service, object, store} = await setup(undefined, {printGate});
  await store.update(object.id, o => ({...o, captureDepth: ['0001.depth.plist']}));
  await assert.rejects(service.start(object.id), /upload|capture|scan/i);
  assert.equal(printGate.held('current'), false);
  assert.equal(printGate.beginUpdate(['current']), true);
});

test('a failed worker releases the MCP install reservation after recording the failure', async () => {
  const printGate = new PrintGate();
  const {service, object} = await setup(undefined, {printGate, throws: 'worker stopped'});
  await service.start(object.id);
  assert.equal((await service.settled(object.id)).state, 'failed');
  assert.equal(printGate.held('current'), false);
  assert.equal(printGate.beginUpdate(['current']), true);
});

test('answering an Ask during an MCP update preserves the open Ask and its pending photos for retry', async () => {
  const printGate = new PrintGate();
  const {service, object, store, calls} = await setup(undefined, {printGate});
  await store.update(object.id, o => ({...o, state: 'needs-closeup', question: {closeup: 'the underside'},
    ask: {id: 'ask-1', question: 'What is underneath?', answers: ['text'], status: 'open', askedAtMs: Date.now()}}));
  await service.addPhoto(object.id, 'underside.jpg', Buffer.from('photo'));
  const before = await store.get(object.id);
  assert.equal(before.current, undefined, 'the first pass has no model yet');
  assert.equal(printGate.beginUpdate(['current']), true);
  await assert.rejects(service.answerCloseup(object.id, {text: 'The underside is flat.', photoNames: ['underside.jpg']}), /software is updating/);
  assert.deepEqual(await store.get(object.id), before, 'rejection must not consume the Ask, photos, or create a saved correction');
  assert.equal(calls.length, 0);
  assert.equal(printGate.held('current'), false);
  printGate.endUpdate(['current']);
  await service.answerCloseup(object.id, {text: 'The underside is flat.', photoNames: ['underside.jpg']});
  assert.equal(printGate.held('current'), true, 'the admitted pass retains its own reservation');
  const after = await service.settled(object.id);
  assert.equal(after.state, 'ready');
  assert.equal(after.messages.length, 1);
  assert.deepEqual(after.messages[0].photos, ['underside.jpg']);
  assert.equal(calls.length, 1);
  assert.equal(printGate.held('current'), false);
});

test('an invalid Ask answer releases its admission reservation', async () => {
  const printGate = new PrintGate();
  const {service, object} = await setup(undefined, {printGate});
  await assert.rejects(service.answerCloseup(object.id, {bestGuess: true}), /No close-up was asked/);
  assert.equal(printGate.held('current'), false);
  assert.equal(printGate.beginUpdate(['current']), true);
});


test('Ask answers claim only their attachments and leave queued correction evidence pending', async () => {
  for (const answer of [{bestGuess: true}, {text: 'It is flat.'}, {photoNames: ['closeup.jpg']}]) {
    const {service, object, store, calls} = await setup(undefined, {outcomes: [
      {status: 'needs_closeup', closeup: 'the underside', summary: 'Need a closer look.'},
      {status: 'done', summary: 'Answered.'}, {status: 'done', summary: 'Changed.'},
    ]});
    await service.addPhoto(object.id, 'initial.jpg', Buffer.from('initial'));
    await service.start(object.id); await service.settled(object.id);
    await service.addPhoto(object.id, 'queued.jpg', Buffer.from('future change'));
    await service.addPhoto(object.id, 'closeup.jpg', Buffer.from('answer'));
    await service.answerCloseup(object.id, answer); await service.settled(object.id);
    const after = await store.get(object.id);
    assert.deepEqual(after.messages.at(-1).photos, answer.photoNames ?? []);
    assert.ok(after.pendingPhotos.includes('queued.jpg'));
    assert.deepEqual(calls[1].photos.map(path => path.split('/').at(-1)), ['initial.jpg', ...(answer.photoNames ?? [])]);
    await service.correct(object.id, 'Make the queued change.', [], ['queued.jpg']);
    const final = await service.settled(object.id);
    assert.deepEqual(final.messages.at(-1).photos, ['queued.jpg']);
    assert.ok(calls[2].photos.some(path => path.endsWith('/queued.jpg')));
  }
});

test('invalid Ask attachments leave the open question unchanged', async () => {
  const {service, object, store} = await setup({status: 'needs_closeup', closeup: 'underside', summary: 'Question'});
  await service.start(object.id); await service.settled(object.id);
  const before = await store.get(object.id);
  await assert.rejects(service.answerCloseup(object.id, {}), /Choose photos for this answer/);
  assert.deepEqual(await store.get(object.id), before);
  await assert.rejects(service.answerCloseup(object.id, {photoNames: ['missing.jpg']}), /not in this project/);
  assert.deepEqual(await store.get(object.id), before);
});


test('an Ask answer does not reuse an unrelated held message with identical text', async () => {
  const {service, object, store} = await setup({status: 'needs_closeup', closeup: 'underside', summary: 'Question'});
  await service.start(object.id); await service.settled(object.id);
  await service.addPhoto(object.id, 'held.jpg', Buffer.from('held'));
  await store.update(object.id, o => ({...o, pendingMessageId: 'held-message', pendingFollowup: 'It is flat.',
    messages: [{id: 'held-message', text: 'It is flat.', atMs: 1, photos: ['held.jpg']}]}));
  await service.answerCloseup(object.id, {text: 'It is flat.', photoNames: []});
  const after = await service.settled(object.id);
  assert.equal(after.messages[0].id, 'held-message');
  assert.notEqual(after.messages[1].id, 'held-message');
  assert.deepEqual(after.messages[1].photos, []);
});
