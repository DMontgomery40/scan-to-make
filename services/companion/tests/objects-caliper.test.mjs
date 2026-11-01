import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {CALIPER_ASSETS, CALIPER_NAME, caliperInfo} from '../dist/objects/caliper.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {TOUCHUP_RESULT_SCHEMA, TOUCHUP_SYSTEM_RULES, cleanMeasurements} from '../dist/touchup/invocation.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';
const until = async check => { for (let i = 0; i < 300; i++) { const v = await check(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

async function setup({outcomes = [], printing = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-caliper-'));
  const store = new ObjectStore(join(root, 'objects'));
  let pass = 0;
  const runTouchup = async () => {
    const outcome = outcomes[pass++] ?? {status: 'done', summary: 'Done.'};
    const out = join(root, `pass-${pass}`, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    return {renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(root, `pass-${pass}`), model: join(out, 'touched.stl'), ...outcome};
  };
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const runs = [];
  const runner = {backend: 'bambu-printer-mcp', runBundle: async (_store, id) => { runs.push(id); return {bundleId: id}; }};
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [10, 20, 30], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    ...(printing ? {print: {services: {store: bundles, relay, runner}, judgePlate: async () => ({clear: true})}} : {})});
  return {service, store, runs, bundles, root};
}

test('the touch-up schema asks for measurements and says where each came from', () => {
  const items = TOUCHUP_RESULT_SCHEMA.properties.measurements.items;
  assert.deepEqual(items.required, ['what', 'mm', 'source']);
  assert.deepEqual(items.properties.source.enum, ['caliper', 'ruler', 'scan', 'description']);
  assert.ok(!TOUCHUP_RESULT_SCHEMA.required.includes('measurements'), 'optional: most passes read nothing');
  assert.match(TOUCHUP_SYSTEM_RULES, /caliper \(best\) or any ruler/);
  assert.match(TOUCHUP_SYSTEM_RULES, /A ruler reading is an estimate/);
});

test('measurements from the worker are checked before they are kept', () => {
  assert.deepEqual(cleanMeasurements([
    {what: ' across the top ', mm: 62.3456, source: 'caliper'},
    {what: 'length', mm: 40, source: 'ruler'},
    {what: '', mm: 1, source: 'caliper'},
    {what: 'depth', mm: -2, source: 'scan'},
    {what: 'depth', mm: Number.NaN, source: 'scan'},
    {what: 'height', mm: 5, source: 'guess'},
    'nonsense', null,
  ]), [{what: 'across the top', mm: 62.35, source: 'caliper'}, {what: 'length', mm: 40, source: 'ruler'}]);
  assert.deepEqual(cleanMeasurements(undefined), []);
  assert.equal(cleanMeasurements(Array.from({length: 50}, (_, i) => ({what: `w${i}`, mm: 1, source: 'scan'}))).length, 20);
});

test('the object keeps what the touch-up measured, and a correction that reads nothing keeps it', async () => {
  const {service, store} = await setup({outcomes: [
    {status: 'done', summary: 'Matched the photos.', measurements: [{what: 'across the top', mm: 62.3, source: 'caliper'}, {what: 'bad', mm: 'x', source: 'caliper'}]},
    {status: 'done', summary: 'Made it taller.'},
  ]});
  const object = await service.create('A cap for this jar.');
  await service.start(object.id);
  let done = await service.settled(object.id);
  assert.deepEqual(done.current.measurements, [{what: 'across the top', mm: 62.3, source: 'caliper'}]);
  await service.correct(object.id, 'Make it 5 mm taller.');
  done = await service.settled(object.id);
  assert.equal(done.current.summary, 'Made it taller.');
  assert.deepEqual(done.current.measurements, [{what: 'across the top', mm: 62.3, source: 'caliper'}]);
  assert.deepEqual((await store.get(object.id)).current.measurements, done.current.measurements);
});

test('the shipped caliper files are there, with size, colours and pause heights', async () => {
  for (const name of ['caliper.json', 'caliper.stl', 'caliper-2colour.3mf', 'caliper-1colour.3mf', 'caliper-body.stl', 'caliper-marking.stl'])
    assert.ok(existsSync(join(CALIPER_ASSETS, name)), name);
  const info = await caliperInfo();
  assert.deepEqual(info.sizeMm, [160, 105, 4.6]);
  assert.deepEqual(info.filamentSlots, {body: 1, marking: 2});
  assert.deepEqual(info.pauseAtZ, [0.4, 3.6]);
});

test('print the caliper: a ready object with the shipped model, renders and size goes through the normal print path', async () => {
  const {service, store, runs, bundles} = await setup();
  const printing = await service.printCaliper();
  assert.equal(printing.instructions, CALIPER_NAME);
  assert.equal(printing.kind, 'caliper');
  assert.equal(printing.state, 'printing');
  assert.deepEqual(printing.current.sizeMm, [160, 105, 4.6]);
  assert.deepEqual(printing.current.renders.map(r => r.split('/').pop()), ['1_front.png', '2_back.png', '3_reading_closeup.png']);
  const dir = store.dir(printing.id);
  assert.deepEqual(await readFile(join(dir, 'current', 'model.stl')), await readFile(join(CALIPER_ASSETS, 'caliper.stl')));
  const printed = await until(async () => { const o = await store.get(printing.id); return o.state === 'printed' && o; });
  assert.equal(runs.length, 1);
  assert.equal((await bundles.read(printed.print.bundleId)).status, 'ready');
  // A second tap prints the same object again rather than adding another.
  await service.printCaliper();
  await until(async () => runs.length === 2);
  assert.equal((await store.list()).filter(o => o.kind === 'caliper').length, 1);
});

test('without printing set up, the caliper object is still made and the refusal says why', async () => {
  const {service, store} = await setup({printing: false});
  await assert.rejects(service.printCaliper(), /Printing is not set up on this Mac/);
  const [object] = await store.list();
  assert.equal(object.kind, 'caliper');
  assert.equal(object.state, 'ready');
});

test('the phone prints the caliper with POST /v1/objects/caliper (print scope)', async t => {
  const {service} = await setup();
  const scopes = [];
  const routes = createObjectRoutes(service);
  const server = createServer(async (request, response) => {
    try { await routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined); }
    catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const made = await fetch(`${base}/v1/objects/caliper`, {method: 'POST'});
  assert.equal(made.status, 201);
  const {object} = await made.json();
  assert.equal(object.kind, 'caliper');
  assert.equal(object.state, 'printing');
  assert.deepEqual(scopes, ['printer-handoff:use']);
  assert.equal((await fetch(`${base}/v1/objects/caliper`)).status, 405);
});

test('the Mac app prints the caliper with objects.printCaliper and gets the object with its folder', async () => {
  const {service} = await setup();
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  const {object} = await dispatch('objects.printCaliper', {});
  assert.equal(object.kind, 'caliper');
  assert.equal(object.directory, service.dir(object.id));
  await assert.rejects(dispatch('objects.printCaliper', {extra: true}), error => error.code === 'invalid-request');
});
