import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:http';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, passKind} from '../dist/objects/service.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {publishedLink, buildPublishedInvocation, runPublishedWorker, newestDownload, DESIGN_TOOLS} from '../dist/published/published.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';

const until = async check => { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };
const THREE_MF = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200, 1)]);
const LINK = 'https://makerworld.com/en/models/1142734-vernier-caliper-ruler-220mm#profileId-1149208';
const REQUEST = `${LINK} the 150 mm one, with the depth gauge, in black and yellow`;

test('a link to a published model makes it a published job; an explicit kind still wins', () => {
  assert.deepEqual(publishedLink(`print this ${LINK}.`), {url: LINK, site: 'MakerWorld'});
  assert.equal(publishedLink('https://www.printables.com/model/12345-hook').site, 'Printables');
  assert.equal(publishedLink('see https://www.thingiverse.com/thing:4242').site, 'Thingiverse');
  assert.equal(publishedLink('https://example.com/models/1'), undefined);
  assert.equal(publishedLink('https://makerworld.com/'), undefined, 'a site, not a model page');
  assert.equal(passKind({instructions: REQUEST}), 'published');
  assert.equal(passKind({instructions: REQUEST, scan: 'scan.usdz'}), 'published', 'a link beats a scan');
  assert.equal(passKind({instructions: REQUEST, kind: 'fit'}), 'fit', 'the phone\'s kind wins');
  assert.equal(passKind({instructions: 'A hook for a 25 mm rail'}), 'fit');
});

test('the published worker has the browser, files and web, and no tool that builds geometry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'published-inv-'));
  const pass = await prepareTouchupPass({root, objectId: 'p', scan: [], photos: [], requirePhotos: false});
  const inv = buildPublishedInvocation({pass, printer: {command: '/usr/bin/true'}, claudePath: '/c', request: REQUEST, link: {url: LINK, site: 'MakerWorld'},
    chrome: true, designTools: ['blender_mcp_future_tool']});
  const arg = name => inv.args[inv.args.indexOf(name) + 1];
  assert.ok(inv.args.includes('--chrome'));
  assert.ok(inv.args.includes('--strict-mcp-config'));
  assert.equal(arg('--tools'), 'Read,Glob,WebSearch,WebFetch');
  assert.equal(arg('--allowedTools'), 'Read,Glob,WebSearch,WebFetch,mcp__printer,mcp__claude-in-chrome');
  for (const tool of [...DESIGN_TOOLS, 'blender_mcp_future_tool']) assert.ok(arg('--disallowedTools').split(',').includes(`mcp__printer__${tool}`), tool);
  assert.match(arg('--append-system-prompt'), /Never model, redraw or rebuild/);
  assert.match(arg('--append-system-prompt'), /First look in ~\/Downloads/);
  // Every job's worker gets the browser when it's there (fit and copy too).
  const {buildTouchupInvocation} = await import('../dist/touchup/invocation.js');
  const fit = buildTouchupInvocation({pass, printer: {command: '/usr/bin/true'}, claudePath: '/c', instructions: 'A hook', chrome: true});
  assert.ok(fit.args.includes('--chrome'));
  assert.equal(fit.args[fit.args.indexOf('--allowedTools') + 1], 'Read,WebSearch,WebFetch,mcp__printer,mcp__claude-in-chrome');
  const plain = buildPublishedInvocation({pass, printer: {command: '/usr/bin/true'}, claudePath: '/c', request: REQUEST, link: {url: LINK, site: 'MakerWorld'}, chrome: false});
  assert.ok(!plain.args.includes('--chrome'));
  assert.ok(!plain.args.join(' ').includes('claude-in-chrome'));
});

function fakeWorker(answer) {
  return () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => { child.stdout.end(JSON.stringify({type: 'result', structured_output: answer}) + '\n'); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
}

test('the files the person already downloaded are picked up by name; a claimed download that isn\'t there never counts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'published-dl-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const downloads = join(root, 'Downloads');
  await mkdir(downloads);
  const caliper = join(downloads, 'Vernier_Caliper_Ruler_220mm_COLOR-02.3mf'), gauge = join(downloads, 'DEPTH_GAUGE_for_Vernier_Caliper_Ruler_220mm_COLOR-02.3mf');
  await writeFile(caliper, THREE_MF); await writeFile(gauge, THREE_MF); await writeFile(join(downloads, 'other.3mf'), THREE_MF);
  const yesterday = new Date(Date.now() - 86_400_000);
  for (const file of [caliper, gauge]) await utimes(file, yesterday, yesterday);
  const pass = await prepareTouchupPass({root: join(root, 'passes'), objectId: 'p', scan: [], photos: [], requirePhotos: false});
  const inv = {command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {printer: {command: '/x', args: [], env: {}}}}};
  const link = {url: LINK, site: 'MakerWorld'};
  const got = await runPublishedWorker(inv, pass, link, {downloads, spawn: fakeWorker({status: 'downloaded', summary: 'Found both files.',
    model: {title: 'Vernier Caliper Ruler 220mm', designer: 'Kass', site: 'elsewhere', url: 'https://evil.example'},
    download: {files: ['Vernier_Caliper_Ruler_220mm_COLOR-02.3mf', 'DEPTH_GAUGE_for_Vernier_Caliper_Ruler_220mm_COLOR-02.3mf'], profile: '150 mm with depth gauge'}})});
  assert.equal(got.status, 'downloaded');
  assert.deepEqual(got.files, [caliper, gauge]);
  assert.deepEqual(got.model, {title: 'Vernier Caliper Ruler 220mm', designer: 'Kass', site: 'MakerWorld', url: LINK}, 'the credit links the page the person gave');
  const lie = await runPublishedWorker(inv, pass, link, {downloads: join(root, 'empty'), spawn: fakeWorker({status: 'downloaded', summary: 'Done.', download: {files: ['nowhere.3mf']}})});
  assert.equal(lie.status, 'needs_file');
  // One of two named files missing: not a success, and what was found is only offered.
  const half = await runPublishedWorker(inv, pass, link, {downloads, spawn: fakeWorker({status: 'downloaded', summary: 'Done.',
    download: {files: ['Vernier_Caliper_Ruler_220mm_COLOR-02.3mf', 'DEPTH_GAUGE_missing.3mf']}})});
  assert.deepEqual([half.status, half.candidate], ['needs_file', caliper]);
  assert.equal(await newestDownload([downloads], Date.now() + 1000), undefined, 'nothing recent: no candidate');
});

async function setup(t, runPublished) {
  const root = await mkdtemp(join(tmpdir(), 'published-svc-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [], designPasses = [];
  const service = new ObjectService({store, stlInfo: async () => [1, 2, 3], claudePath: '/unused', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    runTouchup: async input => { designPasses.push(input); throw new Error('a published job reached the design pass'); },
    runPublished, events: {emit: async draft => { events.push(draft); }}, titleFor: async () => 'Generated title'});
  t.after(() => service.close());
  return {root, store, service, events, designPasses};
}

test('a published job never reaches the design pass: it keeps the designer\'s files as published, credited', async t => {
  let file;
  const f = await setup(t, async input => {
    assert.equal(input.link.url, LINK);
    input.onStage?.('working');
    return {status: 'downloaded', files: [file, file.replace('caliper', 'gauge')], profile: '150 mm with depth gauge', summary: 'Got the 150 mm profile and its depth gauge.',
      model: {title: 'Vernier Caliper Ruler 220mm', designer: 'Kass', site: 'MakerWorld', url: LINK}};
  });
  file = join(f.root, 'caliper.3mf');
  await writeFile(file, THREE_MF); await writeFile(join(f.root, 'gauge.3mf'), Buffer.concat([THREE_MF, Buffer.from('gauge')]));
  const object = await f.service.create(REQUEST);
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.equal(f.designPasses.length, 0);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.kind, 'published');
  assert.equal(ready.title, 'Vernier Caliper Ruler 220mm', 'the model\'s own name, not a generated one');
  assert.deepEqual(ready.credit, {url: LINK, site: 'MakerWorld', title: 'Vernier Caliper Ruler 220mm', designer: 'Kass'});
  assert.deepEqual(ready.files, {original: ['original/caliper.3mf', 'original/gauge.3mf'], current: 'current/model.3mf'});
  assert.equal(ready.current.model, 'current/model.3mf');
  assert.match(ready.current.summary, /Profile: 150 mm with depth gauge\./);
  assert.deepEqual(await readFile(join(f.service.dir(object.id), 'current', 'model.3mf')), THREE_MF, 'byte for byte as published');
  // Never printed or sliced as an STL.
  await assert.rejects(f.service.print(object.id), /designer's 3MF/);
  await assert.rejects(f.service.estimate(object.id), /designer's 3MF/);
  assert.deepEqual(ready.passes[0].stages.map(stage => stage.words), ['Reading the model page', 'Getting the designer\'s file', 'Saving the result']);
  assert.ok(f.events.some(event => event.type === 'pass.ready'));
  // Even a correction stays on the published path.
  await f.service.correct(object.id, 'Use the 150 mm profile');
  await f.service.settled(object.id);
  assert.equal(f.designPasses.length, 0);
});

test('without the file the project asks for it, and the shared file finishes the job', async t => {
  const f = await setup(t, async () => ({status: 'needs_file', model: {title: 'Vernier Caliper Ruler 220mm', site: 'MakerWorld', url: LINK}}));
  const object = await f.service.create(REQUEST);
  await f.service.start(object.id);
  const asking = await f.service.settled(object.id);
  assert.equal(asking.state, 'needs-closeup');
  assert.equal(publicObject(asking).status.phase, 'needs-you');
  assert.deepEqual({...asking.ask, id: undefined, askedAtMs: undefined},
    {id: undefined, askedAtMs: undefined, type: 'file', question: 'Download Vernier Caliper Ruler 220mm from MakerWorld and share it here.', url: LINK,
      modelName: 'Vernier Caliper Ruler 220mm', site: 'MakerWorld', accepts: ['3mf', 'stl'], answers: ['file'], status: 'open'});
  assert.equal(f.designPasses.length, 0, 'never a look-alike');
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/${object.id}`;
  assert.equal((await fetch(`${base}/model?name=notes.txt`, {method: 'POST', body: THREE_MF})).status, 400);
  assert.equal((await fetch(`${base}/model?name=caliper.3mf`, {method: 'POST', body: Buffer.from('not a zip')})).status, 409);
  const shared = await fetch(`${base}/model?name=Vernier_Caliper.3mf`, {method: 'POST', body: THREE_MF});
  assert.equal(shared.status, 200);
  const done = (await shared.json()).object;
  assert.deepEqual([done.state, done.ask.status, done.files.current, done.credit.url], ['ready', 'answered', 'current/model.3mf', LINK]);
  // The Mac shares a file the same way, by path.
  const g = await setup(t, async () => ({status: 'needs_file'}));
  const other = await g.service.create(REQUEST);
  await g.service.start(other.id);
  await g.service.settled(other.id);
  const path = join(g.root, 'from-finder.3mf');
  await writeFile(path, THREE_MF);
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: g.service});
  assert.equal((await dispatch('objects.addFile', {id: other.id, kind: 'model', path})).object.state, 'ready');
  assert.equal((await dispatch('objects.create', {instructions: 'x', kind: 'published'})).object.kind, 'published');
});

test('a link alone creates a published project; a choice Ask is answered by option id; the flag says so', async t => {
  const f = await setup(t, async input => ({status: 'needs_file', model: {title: 'Caliper', site: 'MakerWorld', url: input.link.url}}));
  const byLink = await f.service.create(undefined, undefined, LINK);
  assert.equal(byLink.kind, 'published');
  assert.deepEqual(byLink.credit, {url: LINK, site: 'MakerWorld'});
  assert.equal(passKind(byLink), 'published');
  await assert.rejects(f.service.create(undefined, undefined, 'not a link'), /isn't a web page/);
  // A link alone is enough to start.
  await f.service.start(byLink.id);
  assert.equal((await f.service.settled(byLink.id)).ask.type, 'file');
  const other = await f.service.create('A hook', undefined, 'https://example.com/specs');
  assert.equal(other.kind, undefined, 'an unknown site is only a link');
  // A choice Ask (the plate step sets these; set one here by hand).
  const object = await f.service.create(REQUEST);
  const askId = '00000000-0000-4000-8000-0000000000aa';
  await f.store.update(object.id, o => ({...o, state: 'needs-closeup', kind: 'published', ask: {id: askId, type: 'choice', question: 'Which plate?',
    options: [{id: 'p1', label: '150 mm'}, {id: 'p2', label: '220 mm'}], answers: ['choice'], status: 'open', askedAtMs: 1}}));
  const dispatch = createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: f.service});
  await assert.rejects(dispatch('objects.answerAsk', {id: object.id, askId, choices: ['p9']}), /Pick one of the choices/);
  await assert.rejects(dispatch('objects.answerAsk', {id: object.id, askId, choices: ['p1', 'p2']}), /Pick one of the choices/);
  const answered = (await dispatch('objects.answerAsk', {id: object.id, askId, choices: ['p1']})).object;
  assert.deepEqual([answered.ask.status, answered.ask.choices], ['answered', ['p1']]);
  await f.service.settled(object.id);
  assert.match((await f.service.get(object.id)).passes.at(-1).note, /Which plate\? The person chose: 150 mm\./);
  assert.equal(f.designPasses.length, 0);
  assert.equal((await dispatch('status.get', {})).capabilities.publishedModels, true);
});
