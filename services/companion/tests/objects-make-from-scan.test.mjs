import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {fitBrief} from '../dist/objects/fit.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {tempDir} from './support/temp.mjs';

// "Make something else from this scan" (things-and-versions design §3.3, slice 3): David scanned a Leatherman, the app
// made a copy project, and what he wants is a case for it. A new project is seeded with a copy of the scan; no rescan.

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

/** `replies`: what each pass's worker answers, in order (a question, say); a model ("Made.") once they run out. */
async function fixture(t, {denied = [], replies = []} = {}) {
  const root = await tempDir('objects-make-from-scan-');
  const store = new ObjectStore(join(root, 'objects'));
  const inputs = [];
  const runTouchup = async input => {
    inputs.push(input);
    const out = join(root, 'pass', String(inputs.length)); await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL); await writeFile(join(out, 'front.png'), 'png');
    // Each step of a real conversation happens at its own time.
    await new Promise(r => setTimeout(r, 3));
    const reply = replies.shift() ?? {status: 'done', summary: 'Made.'};
    return {...(reply.status === 'done' ? {model: join(out, 'touched.stl')} : {}), renders: [join(out, 'front.png')], checkpoints: [],
      stats: {seconds: 1, toolCalls: 1}, passDir: join(root, 'pass', String(inputs.length)), ...reply};
  };
  const events = [];
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60, 40, 20], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, events: {emit: async draft => { events.push(draft); }}});
  const routes = createObjectRoutes(service);
  const scopes = [];
  const server = createServer(async (request, response) => {
    const authorize = async scope => { scopes.push(scope); if (denied.includes(scope)) { const e = new Error('forbidden'); e.name = 'RemoteAuthFailure'; throw e; } };
    try { await routes.handle(request, response, authorize, name => request.headers[name]); }
    catch (error) { response.statusCode = error.name === 'RemoteAuthFailure' ? 403 : 500; response.end(JSON.stringify({error: {code: String(error.message)}})); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {method, headers: {'content-type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch {}
    return {status: response.status, json};
  };
  return {call, scopes, service, store, events, inputs};
}

/** A finished copy project with a Mac-rebuilt scan, its phone preview, photos, capture frames and checked sizes: the Leatherman. */
async function leatherman(service, store) {
  const project = await service.create('Copy this. Level the bottom.', 'copy');
  const dir = store.dir(project.id);
  await mkdir(join(dir, 'scan'), {recursive: true}); await mkdir(join(dir, 'photos'), {recursive: true}); await mkdir(join(dir, 'capture'), {recursive: true});
  await writeFile(join(dir, 'scan', 'scan.usdz'), 'the leatherman, rebuilt on the Mac');
  await writeFile(join(dir, 'scan', 'phone-preview.usdz'), 'the phone preview');
  await writeFile(join(dir, 'photos', 'side.jpg'), 'a side photo');
  await writeFile(join(dir, 'capture', '0001.heic'), 'frame 1'); await writeFile(join(dir, 'capture', '0002.heic'), 'frame 2');
  await store.update(project.id, o => ({...o, scan: 'scan.usdz', scanSource: 'mac', photos: ['side.jpg'], capture: ['0001.heic', '0002.heic'],
    checkedSizes: [{label: 'Closed length', mm: 115, certainty: 'confirmed'}]}));
  await service.start(project.id); await service.settled(project.id);
  return service.setProjectSettings(project.id, {title: 'Leatherman Wave+ replica'});
}

async function until(read, done, what) {
  for (let tries = 0; tries < 200; tries++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a copy project\'s scan makes a new fit project with its own copy of the scan, photos, capture and checked sizes', async t => {
  const {call, scopes, service, store, events, inputs} = await fixture(t);
  const source = await leatherman(service, store);
  const sourceBefore = await store.get(source.id);
  scopes.length = 0;
  const made = await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'fit', instructions: 'A belt case for it', fit: {sizeSource: 'scan'}});
  assert.equal(made.status, 201);
  assert.deepEqual(scopes, ['captures:import'], 'the scope New already uses to create projects');
  const created = made.json.object;
  assert.notEqual(created.id, source.id);
  assert.equal(created.kind, 'fit');
  assert.equal(created.instructions, 'A belt case for it');
  assert.deepEqual(created.fit, {sizeSource: 'scan'});
  assert.deepEqual(created.scanFrom, {id: source.id, title: 'Leatherman Wave+ replica'}, 'the new page can say where its scan came from');
  // It appears at once and says what it is waiting for, never as an empty draft.
  assert.equal(created.state, 'touching-up');
  assert.equal(created.progress, 'Bringing over the scan from “Leatherman Wave+ replica”.');
  assert.match(created.status.text, /Bringing over the scan from “Leatherman Wave\+ replica”/);
  assert.ok(events.some(e => e.type === 'project.updated' && e.projectId === created.id && e.data.keys.includes('created')));

  const ready = await until(() => store.get(created.id), o => o.state === 'ready', 'the new project\'s pass');
  assert.equal(ready.scan, 'scan.usdz');
  assert.equal(ready.scanSource, 'mac', 'the Mac\'s rebuild is reused, never rebuilt again');
  assert.deepEqual(ready.photos, ['side.jpg']);
  assert.deepEqual(ready.capture, ['0001.heic', '0002.heic']);
  assert.deepEqual(ready.checkedSizes, [{label: 'Closed length', mm: 115, certainty: 'confirmed'}]);
  assert.equal(ready.progress, undefined);
  const dir = store.dir(created.id);
  assert.equal(await readFile(join(dir, 'scan', 'scan.usdz'), 'utf8'), 'the leatherman, rebuilt on the Mac');
  assert.equal(await readFile(join(dir, 'scan', 'phone-preview.usdz'), 'utf8'), 'the phone preview');
  assert.deepEqual((await readdir(join(dir, 'capture'))).sort(), ['0001.heic', '0002.heic']);
  // The fit pass designs from the scan as the thing to fit, with the person's words.
  const pass = inputs.at(-1);
  assert.equal(pass.kind ?? 'fit', 'fit');
  assert.match(JSON.stringify(pass), /A belt case for it/);

  // The source is unchanged and still there.
  assert.deepEqual(await store.get(source.id), sourceBefore);

  // Nothing is shared: deleting the source leaves the new project whole, and it still runs a full pass.
  await service.delete(source.id);
  assert.equal(await readFile(join(dir, 'scan', 'scan.usdz'), 'utf8'), 'the leatherman, rebuilt on the Mac');
  const changed = await service.correct(created.id, 'Make the belt loop wider.');
  assert.ok(changed);
  const again = await until(() => store.get(created.id), o => o.state === 'ready' && o.passes.length === 2, 'a second pass after the source is gone');
  assert.equal(again.scan, 'scan.usdz');
});

test('deleting the new project leaves the source and its scan whole', async t => {
  const {call, service, store} = await fixture(t);
  const source = await leatherman(service, store);
  const created = (await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'copy', instructions: 'Copy it again, thinner.'})).json.object;
  await until(() => store.get(created.id), o => o.state === 'ready', 'the copy');
  await service.delete(created.id);
  assert.equal(await readFile(join(store.dir(source.id), 'scan', 'scan.usdz'), 'utf8'), 'the leatherman, rebuilt on the Mac');
  assert.equal((await store.get(source.id)).scan, 'scan.usdz');
});

test('a project with no scan is refused plainly, and so is a fit with no words', async t => {
  const {call, service, store} = await fixture(t);
  const words = await service.create('A hook for a 25 mm handle.', 'fit');
  const refused = await call('POST', `/v1/objects/${words.id}/make-from-scan`, {kind: 'fit', instructions: 'A case'});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.message, 'This project has no scan to make something from.');
  const source = await leatherman(service, store);
  const wordless = await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'fit'});
  assert.equal(wordless.status, 409);
  assert.equal(wordless.json.error.message, 'Say what it should hold, mount or adapt to.');
  assert.equal((await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'published'})).status, 400);
  assert.equal((await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'copy', id: source.id})).status, 400);
  assert.equal((await service.list()).length, 2, 'no project is made by a refusal');
});

test('without the create scope nothing is made', async t => {
  const {call, service, store} = await fixture(t, {denied: ['captures:import']});
  const source = await leatherman(service, store);
  assert.equal((await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'copy'})).status, 403);
  assert.equal((await service.list()).length, 1);
});

test('the Mac app makes one through the control socket, and a source deleted before its files came says so and Try Again explains', async t => {
  const {service, store} = await fixture(t);
  const source = await leatherman(service, store);
  const dispatch = createControlDispatcher({objects: service});
  const made = await dispatch('objects.makeFromScan', {id: source.id, kind: 'fit', instructions: 'A belt case for it'});
  assert.equal(made.object.scanFrom.id, source.id);
  assert.ok(made.object.directory, 'the Mac app gets the folder, as for every project');
  await until(() => store.get(made.object.id), o => o.state === 'ready', 'the fit');

  // A project whose files never came (a restart halfway): Try Again brings them, or says plainly why it can't.
  const orphan = await store.create('Another case', 'fit');
  await store.update(orphan.id, o => ({...o, state: 'failed', failure: 'interrupted when your Mac restarted the app', scanFrom: {id: source.id, title: 'Leatherman Wave+ replica'}}));
  const retried = await service.start(orphan.id);
  assert.equal(retried.progress, 'Bringing over the scan from “Leatherman Wave+ replica”.');
  await until(() => store.get(orphan.id), o => o.state === 'ready', 'the retried copy');
  assert.equal((await store.get(orphan.id)).scan, 'scan.usdz');

  const gone = await store.create('A third case', 'fit');
  await store.update(gone.id, o => ({...o, state: 'failed', failure: 'interrupted when your Mac restarted the app', scanFrom: {id: '00000000-0000-4000-8000-000000000000', title: 'Old Leatherman'}}));
  await service.start(gone.id);
  const failed = await until(() => store.get(gone.id), o => o.state === 'failed' && !o.progress, 'the refusal');
  assert.equal(failed.failure, '“Old Leatherman” has been deleted, so its scan can’t be brought over. Scan the object again.');
});

test('the Mac and Linux make a fit through the control socket with how its size is settled, as the iPhone does', async t => {
  const {service, store, inputs} = await fixture(t);
  const source = await leatherman(service, store);
  const dispatch = createControlDispatcher({objects: service});
  // The Mac's and Linux's seeded New Project send "Use scan" unless the person chooses otherwise.
  const byScan = await dispatch('objects.makeFromScan', {id: source.id, kind: 'fit', instructions: 'A belt case for it', fit: {sizeSource: 'scan'}});
  assert.deepEqual(byScan.object.fit, {sizeSource: 'scan'});
  await until(() => store.get(byScan.object.id), o => o.state === 'ready', 'the fit by the scan');
  assert.deepEqual((await store.get(byScan.object.id)).fit, {sizeSource: 'scan'});
  const measured = {sizeSource: 'measured', measured: [{id: 'longest', label: 'longest side', mm: 115.5}]};
  const byHand = await dispatch('objects.makeFromScan', {id: source.id, kind: 'fit', instructions: 'A sheath', fit: measured});
  assert.deepEqual(byHand.object.fit, measured);
  await until(() => store.get(byHand.object.id), o => o.state === 'ready', 'the measured fit');
  assert.match(JSON.stringify(inputs.at(-1)), /115\.5/, 'the pass is told the measured size');
  await assert.rejects(dispatch('objects.makeFromScan', {id: source.id, kind: 'fit', instructions: 'A sheath', fit: {sizeSource: 'measured'}}));
});

test('a message\'s unsent photos stay with the source: the new project gets only its evidence', async t => {
  const {call, service, store} = await fixture(t);
  const source = await leatherman(service, store);
  // Uploaded for a change not yet asked: the source's next pass would not use it, and neither may the new project.
  await service.addPhoto(source.id, 'for-a-message.jpg', Buffer.from('unrelated'), true);
  assert.deepEqual((await store.get(source.id)).pendingPhotos, ['for-a-message.jpg']);
  const created = (await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'fit', instructions: 'A belt case for it', fit: {sizeSource: 'scan'}})).json.object;
  const ready = await until(() => store.get(created.id), o => o.state === 'ready', 'the new project');
  assert.deepEqual(ready.photos, ['side.jpg']);
  assert.deepEqual(await readdir(join(store.dir(created.id), 'photos')), ['side.jpg']);
  assert.deepEqual((await store.get(source.id)).pendingPhotos, ['for-a-message.jpg'], 'the source keeps it for its message');
});

test('a scan whose phone sent its preview but not yet every photo is refused until it has all arrived', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create();
  const dir = store.dir(project.id);
  await mkdir(join(dir, 'scan'), {recursive: true}); await mkdir(join(dir, 'capture'), {recursive: true});
  await writeFile(join(dir, 'scan', 'scan.usdz'), 'the phone preview');
  await writeFile(join(dir, 'capture', '0001.heic'), 'frame 1');
  // The phone declared its walk-around and uploaded its preview, then went away before /start.
  await store.update(project.id, o => ({...o, scan: 'scan.usdz', scanSource: 'phone-preview', capture: ['0001.heic'],
    captureDeclared: {source: 'object-capture', images: ['0001.heic', '0002.heic']}}));
  const refused = await call('POST', `/v1/objects/${project.id}/make-from-scan`, {kind: 'copy'});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.message, 'This scan is still arriving from the phone that recorded it. Finish sending it from that phone, then make something from it.');
  assert.equal((await service.list()).length, 1, 'no project is made by a refusal');

  // Try Again on a project already made from it (before this check) refuses the same way rather than designing from the preview.
  const orphan = await store.create(undefined, 'copy');
  await store.update(orphan.id, o => ({...o, state: 'failed', scanFrom: {id: project.id, title: 'Scan'}}));
  await service.start(orphan.id);
  const failed = await until(() => store.get(orphan.id), o => o.state === 'failed' && !o.progress, 'the refusal on Try Again');
  assert.match(failed.failure, /still arriving from the phone/);
  assert.equal(failed.scan, undefined);
});

test('Copy this object with no words keeps an imported scan with no photos as the model', async t => {
  const {call, service, store, inputs} = await fixture(t);
  // A project made from an imported STL and a description: no photos and no capture frames.
  const source = await service.create('Print this bracket as it is.', 'copy');
  await mkdir(join(store.dir(source.id), 'scan'), {recursive: true});
  await writeFile(join(store.dir(source.id), 'scan', 'scan.stl'), STL);
  await store.update(source.id, o => ({...o, scan: 'scan.stl'}));
  await service.start(source.id); await service.settled(source.id);
  const passesBefore = inputs.length;
  const made = await call('POST', `/v1/objects/${source.id}/make-from-scan`, {kind: 'copy'});
  assert.equal(made.status, 201);
  const ready = await until(() => store.get(made.json.object.id), o => o.state !== 'touching-up', 'the copy');
  assert.equal(ready.state, 'ready', ready.failure);
  assert.equal(ready.instructions, undefined, 'the source\'s words are not carried over');
  assert.ok(ready.current?.model, 'the scan is the model');
  assert.equal(inputs.length, passesBefore, 'kept as it is, never touched up');
});

// David, Nov 11: "when you do a revision or addition to an existing thing all that projects history and context need
// to go with it ... you're basically 'forking' the project". Every source below is made through the routes the person
// uses (New, the Mac's questions answered in words, Ask for changes), so its object.json has the shape production writes:
// a question lives on the pass that asked it and the project's `ask`, its answer is the person's bare message, and
// the two meet only in the answering pass's note (`Answer to "…": …`).

const tick = () => new Promise(r => setTimeout(r, 3));
const MEASURED = {sizeSource: 'measured', measured: [{id: 'width', label: 'Width', mm: 75.1}, {id: 'height', label: 'Height', mm: 158}]};

/** A project with a scan, made from the person's words (and a fit's sizes), and its first pass run. */
async function scanned(service, store, words, kind = 'fit', fit) {
  const project = await service.create(words, kind, undefined, fit);
  const dir = store.dir(project.id);
  await mkdir(join(dir, 'scan'), {recursive: true});
  await writeFile(join(dir, 'scan', 'scan.usdz'), 'the phone, scanned');
  await store.update(project.id, o => ({...o, scan: 'scan.usdz'}));
  await tick();
  await service.start(project.id); await service.settled(project.id);
  return service.setProjectSettings(project.id, {title: 'Phone mount'});
}

/** Two questions answered in words (the second asked by the pass that read the first answer), then a change. */
const QUESTIONS = [
  {status: 'needs_closeup', summary: 'I need one detail before I can finish.', ask: {question: 'Is there a case on the phone?'}},
  {status: 'needs_closeup', summary: 'One more thing.', ask: {question: 'Should the cable pass under the mount?'}},
  {status: 'done', summary: 'Made the mount.'},
];
async function talkedThrough(service, store, fit = MEASURED) {
  const source = await scanned(service, store, 'A mount for my phone.', 'fit', fit);
  await tick(); await service.answerCloseup(source.id, {text: 'Yes'}); await service.settled(source.id);
  await tick(); await service.answerCloseup(source.id, {text: 'Yes'}); await service.settled(source.id);
  await tick(); await service.correct(source.id, 'Make it thinner.'); await service.settled(source.id);
  return store.get(source.id);
}
const CONVERSATION = [
  ['you', 'A mount for my phone.'],
  ['app', 'I need one detail before I can finish.'],
  ['app', 'Is there a case on the phone?'],
  ['you', 'Yes'],
  ['app', 'One more thing.'],
  ['app', 'Should the cable pass under the mount?'],
  ['you', 'Yes'],
  ['app', 'Made the mount.'],
  ['you', 'Make it thinner.'],
  ['app', 'Made it thinner.'],
];
const said = history => history.items.map(item => [item.who, item.text]);
/** The conversation lines of a worker's brief, as [who, text]. */
const briefLines = brief => brief.split('\n').map(line => /^\S+ · (Person|Counterpart): (.*)$/.exec(line)).filter(Boolean)
  .map(match => [match[1] === 'Person' ? 'you' : 'app', match[2]]);

test('a new project carries each question the source asked with its answer, the request as typed and its sizes as measured', async t => {
  const {service, store, inputs} = await fixture(t, {replies: [...QUESTIONS, {status: 'done', summary: 'Made it thinner.'}]});
  const source = await talkedThrough(service, store);
  assert.deepEqual(source.passes.slice(0, 2).map(pass => pass.question), ['Is there a case on the phone?', 'Should the cable pass under the mount?'],
    'the passes that asked keep their questions');
  const before = await store.get(source.id);
  const made = await service.makeFromScan(source.id, {kind: 'copy', instructions: 'Add a swivel.'});
  const ready = await until(() => store.get(made.id), o => o.state === 'ready', 'the inherited project');
  assert.deepEqual(said(ready.inherited), CONVERSATION);
  assert.deepEqual(ready.inherited.from, {id: source.id, title: 'Phone mount'});
  const times = ready.inherited.items.map(item => item.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'in the order it was said');
  assert.deepEqual(ready.inherited.fit, MEASURED, 'the sizes the person measured travel, as measured');
  // The worker reads the same conversation, then the new request.
  const brief = inputs.at(-1).instructions;
  assert.deepEqual(briefLines(brief), CONVERSATION);
  assert.match(brief, /Sizes the person measured on the real object for “Phone mount”: Width 75\.1 mm, Height 158 mm\. Treat these as measured\./);
  assert.ok(brief.indexOf('Treat these as measured.') < brief.indexOf('Add a swivel.'), brief);
  assert.doesNotMatch(brief, /Fit brief:|Do not print a copy/, 'the source\'s directions are not the new request\'s');
  // A snapshot: the source is untouched, and deleting it changes nothing here. Every client reads it as stored.
  assert.deepEqual(await store.get(source.id), before);
  await service.delete(source.id);
  assert.deepEqual((await store.get(made.id)).inherited, ready.inherited);
  assert.deepEqual(publicObject(await store.get(made.id)).inherited, ready.inherited);
});

test('a question saved before passes kept it is recovered from its answer\'s note, and the open one from the project\'s ask', async t => {
  const {service, store} = await fixture(t, {replies: [...QUESTIONS,
    {status: 'needs_closeup', summary: 'Before I make it thinner:', ask: {question: 'How thin can the back be?'}}]});
  const asked = await talkedThrough(service, store);
  assert.equal(asked.state, 'needs-closeup');
  // As every project saved before Nov 11 is: no pass names its question.
  await store.update(asked.id, o => ({...o, passes: o.passes.map(({question: _question, ...pass}) => pass)}));
  const source = await store.get(asked.id);
  assert.ok(source.passes.every(pass => pass.question === undefined));
  // The second answer's note repeats the first answer's line, and both answers are "Yes".
  assert.match(source.passes[2].note, /^Answer to "Is there a case on the phone\?": Yes\nAnswer to "Should the cable pass under the mount\?": Yes$/);
  const made = await service.makeFromScan(source.id, {kind: 'copy', instructions: 'Add a swivel.'});
  const ready = await until(() => store.get(made.id), o => o.state === 'ready', 'the inherited project');
  assert.deepEqual(said(ready.inherited), [...CONVERSATION.slice(0, 9), ['app', 'Before I make it thinner:'], ['app', 'How thin can the back be?']]);
});

test('a request saved with the brief a client once appended is carried as the person\'s words, and its sizes as measured', async t => {
  const {service, store, inputs} = await fixture(t);
  const made0 = await scanned(service, store, 'A mount for my phone.', 'fit');
  // The phone and Android appended this block to the request until Nov 10; older projects still hold it.
  await store.update(made0.id, o => ({...o, instructions: `A mount for my phone.\n\n${fitBrief(MEASURED)}`, fit: undefined}));
  const source = await store.get(made0.id);
  assert.equal(source.fit, undefined);
  const made = await service.makeFromScan(source.id, {kind: 'copy', instructions: 'Copy it, thinner.'});
  const ready = await until(() => store.get(made.id), o => o.state === 'ready', 'the inherited project');
  assert.deepEqual(ready.inherited.items[0], {at: source.createdAtMs, who: 'you', text: 'A mount for my phone.'});
  assert.ok(ready.inherited.items.every(item => !item.text.includes('Fit brief')), 'the machine\'s block is not the person\'s words');
  assert.deepEqual(ready.inherited.fit, {sizeSource: 'measured', measured: [{id: 'Width', label: 'Width', mm: 75.1}, {id: 'Height', label: 'Height', mm: 158}]});
  const brief = inputs.at(-1).instructions;
  assert.doesNotMatch(brief, /Fit brief:/);
  assert.match(brief, /Width 75\.1 mm, Height 158 mm\. Treat these as measured\./);
});

test('a note sent again before any result came back is carried once', async t => {
  const {service, store, inputs} = await fixture(t);
  const made0 = await scanned(service, store, 'A mount for my phone.', 'fit');
  // The stored shape of a real project on Nov 10 (notes-once.test.mjs, board X67): one note sent three times before a
  // note carried its sender's id, because its pass failed twice; each copy has its own pass.
  const at = Date.now() + 1000;
  const note = (id, atMs) => ({id, atMs, text: 'Make it wider.', photos: []});
  const pass = (startedAtMs, status, messageId) => ({startedAtMs, endedAtMs: startedAtMs + 100, status, trigger: 'changes', messageId, note: 'Make it wider.',
    ...(status === 'done' ? {summary: 'Made it wider.'} : {})});
  await store.update(made0.id, o => ({...o, messages: [note('m2', at), note('m3', at + 660_000), note('m4', at + 900_000)],
    passes: [...o.passes, pass(at + 10, 'failed', 'm2'), pass(at + 660_010, 'failed', 'm3'), pass(at + 900_010, 'done', 'm4')]}));
  const source = await store.get(made0.id);
  assert.equal(source.messages.length, 3, 'the record keeps every send');
  const made = await service.makeFromScan(source.id, {kind: 'copy', instructions: 'Add a swivel.'});
  const ready = await until(() => store.get(made.id), o => o.state === 'ready', 'the inherited project');
  assert.deepEqual(said(ready.inherited), [['you', 'A mount for my phone.'], ['app', 'Made.'], ['you', 'Make it wider.'], ['app', 'Made it wider.']]);
  assert.equal(ready.inherited.items[2].at, at, 'when it was first sent');
  assert.equal(inputs.at(-1).instructions.split('Make it wider.').length - 1, 1, 'the worker is told once');
});

test('Duplicate carries the source conversation, and a change asked of the copy reads it', async t => {
  const {service, store, inputs} = await fixture(t, {replies: [...QUESTIONS, {status: 'done', summary: 'Made it thinner.'}]});
  const source = await talkedThrough(service, store);
  const copy = await service.duplicate(source.id);
  assert.deepEqual(copy.inherited.from, {id: source.id, title: 'Phone mount'});
  assert.deepEqual(said(copy.inherited), CONVERSATION);
  assert.deepEqual(copy.inherited.fit, MEASURED);
  await service.correct(copy.id, 'Make it wider.'); await service.settled(copy.id);
  const brief = inputs.at(-1).instructions;
  assert.deepEqual(briefLines(brief), CONVERSATION);
  assert.match(brief, /project this came from: “Phone mount”/);
});

test('a project made from one that was itself made from another says which project each part was said in', async t => {
  const {service, store, inputs} = await fixture(t, {replies: [...QUESTIONS, {status: 'done', summary: 'Made it thinner.'}]});
  const first = await talkedThrough(service, store);
  const second = await service.makeFromScan(first.id, {kind: 'fit', instructions: 'Add a swivel.'});
  await until(() => store.get(second.id), o => o.state === 'ready', 'the second generation');
  await service.setProjectSettings(second.id, {title: 'Swivel mount'});
  const third = await service.makeFromScan(second.id, {kind: 'copy', instructions: 'Copy it in black.'});
  const ready = await until(() => store.get(third.id), o => o.state === 'ready', 'the third generation');
  const parent = {id: first.id, title: 'Phone mount'};
  assert.deepEqual(ready.inherited.from, {id: second.id, title: 'Swivel mount'});
  assert.deepEqual(ready.inherited.items.map(item => [item.who, item.text, item.from]),
    [...CONVERSATION.map(([who, text]) => [who, text, parent]), ['you', 'Add a swivel.', undefined], ['app', 'Made.', undefined]]);
  const brief = inputs.at(-1).instructions;
  assert.ok(brief.indexOf('Earlier, in “Phone mount”:') < brief.indexOf('A mount for my phone.'), brief);
  assert.ok(brief.indexOf('Made it thinner.') < brief.indexOf('Then, in “Swivel mount”:'), brief);
  assert.ok(brief.indexOf('Then, in “Swivel mount”:') < brief.indexOf('Add a swivel.'), brief);
});
