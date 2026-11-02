import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {HandoffBundleStore, InMemoryElicitationRelay, PrinterSession} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {PrinterDirectory} from '../dist/printing/directory.js';
import {CameraFrames} from '../dist/printing/camera.js';
import {CompanionSettingsStore} from '../dist/settings.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']};
const JOB = 'checked-1b2c-sliced';
const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async check => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };

/**
 * A P1S behind a fake MCP session, a fake print runner, and a monitor clock the
 * test steps by hand: every printer report and every wait is scripted.
 */
async function setup(t, {tools = ['get_printer_status', 'camera_snapshot', 'pause_print', 'resume_print', 'cancel_print', 'slice_stl'], sliceArgs = false, reports = [], judge = async () => ({clear: true}), camera = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-printing-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const calls = [], events = [], runs = [];
  const queue = [...reports];
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  const catalogTools = tools.map(name => name === 'slice_stl' && sliceArgs ? tool(name, {layer_height: {}, wall_loops: {}, sparse_infill_density: {}}) : tool(name));
  const factory = () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.46'}, tools: catalogTools}; return this.catalog; },
    hasTool(name) { return catalogTools.some(item => item.name === name); },
    getTool(name) { return catalogTools.find(item => item.name === name); },
    async callTool(name, args, options = {}) {
      calls.push({name, args, context: options.elicitationContext});
      if (name === 'get_printer_status') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw Object.assign(new Error('down'), {code: 'tool-failed'});
        return {content: [{type: 'text', text: JSON.stringify(next)}]};
      }
      if (name === 'camera_snapshot') return {content: [{type: 'text', text: JSON.stringify({format: 'jpeg', base64: JPEG.toString('base64')})}]};
      if (['pause_print', 'resume_print', 'cancel_print'].includes(name)) {
        const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: `Confirm ${name}`, requestedSchema: CONFIRM}}, options.elicitationContext);
        if (answer.action !== 'accept') return {isError: true, content: [{type: 'text', text: 'Not confirmed. Nothing was sent.'}]};
        return {content: [{type: 'text', text: '{"status":"success"}'}]};
      }
      return {content: [{type: 'text', text: '{}'}]};
    },
    async close() {},
  });
  const config = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}, selection: {model: 'p1s', material: 'PLA'}};
  let directory;
  const session = new PrinterSession('current', config, {clientFactory: factory, relay, onConnect: catalog => directory?.connected('current', catalog)});
  const catalog = {defaultDestinationId: 'current', destinations: [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff'}],
    resolve: id => id === 'current' ? structuredClone(config) : undefined, canonical: id => id === 'current' ? 'current' : undefined};
  directory = new PrinterDirectory(catalog, id => id === 'current' ? session : undefined);
  await session.connect();
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const runner = {
    backend: 'bambu-printer-mcp', session,
    filaments: async () => ({trays: [
      {slot: 0, loaded: true, tray_color: '000000FF', tray_type: 'PETG', tray_info_idx: 'GFG00', resolved_profile_path: '/p/petg.json'},
      {slot: 1, loaded: true, tray_color: 'FEC600FF', tray_type: 'PLA', tray_info_idx: 'GFA00', resolved_profile_path: '/p/pla.json'},
      {slot: 254, loaded: true, tray_color: 'FFFFFFFF', tray_type: 'PLA', tray_info_idx: 'GFA00', resolved_profile_path: '/p/ext.json'}]}),
    estimate: async input => { runs.push({estimate: input}); return {estimate: {seconds: 3420, grams: 19.2}, settings: {layers: 183, layerHeightMm: input.slicer?.layerHeightMm ?? 0.2, infillPercent: 15, wallLoops: 2}}; },
    runBundle: async (store, id, options = {}) => {
      runs.push({id, options, selection: (await store.read(id)).selection});
      for (const phase of ['slicing', 'checking-printer']) await options.onProgress?.({phase});
      const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'Printer: P1S. Plate clear?', requestedSchema: CONFIRM}},
        {bundleId: id, ...(camera && options.cameraSnapshot !== false ? {cameraSnapshot: {format: 'jpeg', base64: JPEG.toString('base64')}} : {})});
      if (answer.action !== 'accept') throw new Error('declined');
      await store.setStatus(id, 'printed');
      return {manifest: await store.read(id), result: {dispatch: {jobName: JOB}}};
    },
  };
  const services = {store: bundles, relay, runner, selection: config.selection};
  const store = new ObjectStore(join(root, 'objects'));
  const pending = [];
  const clock = {t: Date.now(), now() { return this.t; }, sleep(ms, signal) {
    return new Promise(resolve => { pending.push({ms, resolve}); signal.addEventListener('abort', resolve, {once: true}); });
  }};
  // Releases the monitor's next wait; when the monitor has ended there is none, and that's fine.
  const tick = async ms => { if (!await until(() => pending.length > 0).then(() => true, () => false)) return; const entry = pending.shift(); clock.t += ms ?? entry.ms; entry.resolve(); await flush(); };
  const settings = new CompanionSettingsStore(join(root, 'settings.json'));
  await settings.load();
  const deps = {store, handoff: config, printerCatalog: catalog, printers: directory, claudePath: '/unused', runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined,
    print: {services, destinations: new Map([['current', services]]), judgePlate: judge}, settings, camera: new CameraFrames(),
    events: {emit: async draft => { events.push(draft); }}, monitorClock: clock};
  const service = new ObjectService(deps);
  t.after(() => service.close());
  const object = await store.create('A mic mount for the stand');
  await mkdir(join(store.dir(object.id), 'current'));
  await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  const approve = async () => {
    const question = await until(async () => (await service.get(object.id)).printConfirmation);
    return service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}});
  };
  return {service, store, object, calls, events, runs, relay, session, directory, queue, tick, clock, approve, deps, settings, root};
}
const status = (state, progress, extra = {}) => ({connected: true, print: {filename: JOB, progress, timeRemaining: Math.max(0, 40 - progress), currentLayer: progress, totalLayers: 100},
  raw: {gcode_state: state, subtask_name: JOB, task_id: '0', ...extra}});
const reset = f => f.store.update(f.object.id, o => ({...o, state: 'ready', print: undefined}));

test('"printed" means printed: Print leaves the project printing until the printer reports this job done', async t => {
  const f = await setup(t, {reports: [status('FINISH', 100, {subtask_name: 'old job'}), status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  const started = await f.service.print(f.object.id);
  assert.match(started.print.printId, /^[0-9a-f-]{36}$/);
  await f.approve();
  const dispatched = await f.service.settled(f.object.id);
  assert.equal(dispatched.state, 'printing');
  assert.equal(dispatched.print.jobName, JOB);
  assert.ok(dispatched.print.dispatchedAt);
  assert.equal(dispatched.print.monitor.phase, 'starting');
  assert.equal(dispatched.print.destinationId, 'current');
  assert.ok(f.events.some(e => e.type === 'print.preparing'));
  assert.equal(f.events.find(e => e.type === 'print.confirm').data.confirmationId.length, 36);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.monitor.endState, 'done');
  assert.equal(done.print.live.state, 'finished');
  assert.equal(done.print.printerStatus.state, 'FINISH');
  await until(() => f.events.some(e => e.type === 'print.done'));
  const types = f.events.map(e => e.type).filter(type => !['print.preparing', 'print.confirm', 'print.status'].includes(type));
  assert.deepEqual(types, ['print.started', 'print.first-layer', 'print.milestone', 'print.done']);
  const frame = f.events.find(e => e.type === 'print.done').frame;
  assert.deepEqual(await readFile(join(f.service.dir(f.object.id), frame)), JPEG);
  await until(async () => (await f.service.get(f.object.id)).print.events.some(e => e.message === 'Done. Take it off the plate.'));
  await until(() => f.session.health().holders === 0);
});

test('a companion restart resumes the monitor of a dispatched print instead of failing it', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 60), status('FINISH', 100)]});
  const printId = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
  await f.store.update(f.object.id, o => ({...o, state: 'printing', print: {bundleId: '00000000-0000-4000-8000-000000000001', printId, destinationId: 'current',
    destination: {id: 'current', name: 'Bambu Lab P1S'}, dispatchedAt: new Date(f.clock.t - 600_000).toISOString(), jobName: JOB,
    monitor: {phase: 'watching', startedAt: new Date(f.clock.t - 600_000).toISOString(), lastReportAt: new Date(f.clock.t - 5000).toISOString(), milestonesSent: [50], firstLayerSent: true}}}));
  await f.store.recoverInterrupted();
  assert.equal((await f.store.get(f.object.id)).state, 'printing');
  await f.service.resume();
  await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.printId, printId);
  await until(() => f.events.some(e => e.type === 'print.done'));
  assert.equal(f.events.filter(e => e.type === 'print.milestone').length, 0, 'no milestone sent twice');
});

test('a print still being prepared at a restart is interrupted, and flagged when it may have reached the printer', async t => {
  const f = await setup(t);
  const bundle = await f.deps.print.services.store.create({stl: STL, prompt: '', backend: 'bambu-printer-mcp'});
  await f.deps.print.services.store.setStatus(bundle.id, 'uncertain', 'dispatch-uncertain');
  await f.store.update(f.object.id, o => ({...o, state: 'printing', print: {bundleId: bundle.id, destinationId: 'current'}}));
  await f.store.recoverInterrupted({keepPrinting: true});
  await f.service.resume();
  const object = await f.service.get(f.object.id);
  assert.equal(object.state, 'failed');
  assert.equal(object.print.uncertain, true);
  await assert.rejects(f.service.print(f.object.id), InvalidStateError);
});

test('print settings reach the slicer and printer; an MCP without them is refused before anything is sliced', async t => {
  const f = await setup(t, {sliceArgs: true, reports: [status('IDLE', 0)]});
  await f.service.print(f.object.id, {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}});
  const run = await until(() => f.runs.at(-1));
  assert.deepEqual(run.options.slicer, {loadFilaments: '/p/pla.json', filamentColours: '#FEC600', layerHeightMm: 0.12, wallLoops: 4, sparseInfillDensity: '25%'});
  assert.deepEqual(run.selection, {model: 'p1s', material: 'PLA', useAms: true, amsSlots: [1], autoMatchAms: false});
  assert.deepEqual((await f.service.get(f.object.id)).print.settings, {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}});
  await f.approve(); await f.service.settled(f.object.id); await f.service.close();
  const g = await setup(t, {reports: [status('IDLE', 0)]});
  await g.service.print(g.object.id, {colour: {auto: true}});
  assert.deepEqual((await until(() => g.runs.at(-1))).selection, {model: 'p1s', material: 'PLA', useAms: true, autoMatchAms: true});
  await g.approve(); await g.service.settled(g.object.id); await g.service.close(); await reset(g);
  const h = await setup(t, {reports: [status('IDLE', 0)]});
  await h.service.print(h.object.id, {colour: {external: true}});
  assert.equal((await until(() => h.runs.at(-1))).selection.useAms, false);
  assert.equal(h.runs.at(-1).options.slicer.loadFilaments, '/p/ext.json');
  await h.approve(); await h.service.settled(h.object.id); await h.service.close();
  const empty = await setup(t);
  await assert.rejects(empty.service.print(empty.object.id, {colour: {amsSlot: 3}}), /empty now/);
  const old = await setup(t);
  await assert.rejects(old.service.print(old.object.id, {quality: 'draft'}), /Update bambu-printer-mcp to choose quality/);
  await assert.rejects(old.service.estimate(old.object.id, {strength: 'max'}), /Update bambu-printer-mcp to choose strength/);
  assert.equal(old.runs.length, 0);
  // Standard is always offered: the preset's own values, nothing sent.
  await old.service.print(old.object.id, {quality: 'standard', strength: 'standard'});
  assert.equal((await until(() => old.runs.at(-1))).options.slicer, undefined);
  await old.approve();
});

test('an estimate slices exactly as Print would, is shared by identical requests, and is cached per model', async t => {
  const f = await setup(t, {sliceArgs: true});
  const [a, b] = await Promise.all([f.service.estimate(f.object.id, {quality: 'fine'}), f.service.estimate(f.object.id, {quality: 'fine'})]);
  assert.deepEqual(a, b);
  assert.equal(f.runs.filter(run => run.estimate).length, 1);
  assert.equal(a.seconds, 3420);
  assert.equal(a.layerHeightMm, 0.12);
  assert.equal(a.quality, 'fine');
  assert.equal(a.strength, 'standard');
  assert.deepEqual(f.runs.find(run => run.estimate).estimate.slicer, {layerHeightMm: 0.12});
  await f.service.estimate(f.object.id, {quality: 'fine'});
  assert.equal(f.runs.filter(run => run.estimate).length, 1);
  await writeFile(join(f.service.dir(f.object.id), 'current', 'model.stl'), Buffer.concat([STL, Buffer.from(' ')]));
  await f.service.estimate(f.object.id, {quality: 'fine'});
  assert.equal(f.runs.filter(run => run.estimate).length, 2, 'a new model is sliced again');
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: f.service});
  assert.equal((await dispatch('objects.estimate', {id: f.object.id, quality: 'fine'})).grams, 19.2);
});

test('pause, resume and stop go through the printer\'s mutex and relay its own confirmation to the project', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const pausing = f.service.control(f.object.id, 'pause');
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  assert.equal(question.message, 'Confirm pause_print');
  await f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}});
  const paused = await pausing;
  assert.equal(paused.printConfirmation, undefined);
  assert.deepEqual(f.calls.find(c => c.name === 'pause_print').context, {bundleId: paused.print.bundleId});
  assert.ok(paused.print.events.some(e => e.message === 'Pause sent.'));
  // A declined confirmation is reported in words; nothing pretends it resumed.
  const resuming = f.service.control(f.object.id, 'resume').then(() => assert.fail('resumed'), error => error);
  const second = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  await f.service.answerPrintConfirmation(f.object.id, second.id, {action: 'decline'});
  assert.match((await resuming).message, /didn't resume: Not confirmed/);
  await assert.rejects(f.service.control((await f.store.create()).id, 'cancel'), /Nothing of this project is printing/);
});

test('the camera route serves one frame per 3 s to every viewer, and 404s a printer without a camera', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)]});
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const [one, two] = await Promise.all([fetch(`${base}/objects/${f.object.id}/camera.jpg`), fetch(`${base}/objects/printers/current/camera.jpg`)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(one.headers.get('content-type'), 'image/jpeg');
  assert.ok(Date.parse(one.headers.get('x-captured-at')));
  assert.deepEqual(Buffer.from(await one.arrayBuffer()), JPEG);
  assert.equal(f.calls.filter(c => c.name === 'camera_snapshot').length, 1);
  assert.equal((await fetch(`${base}/objects/printers/nope/camera.jpg`)).status, 404);
  const settings = await fetch(`${base}/settings`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({milestones: '25-50-75'})});
  assert.deepEqual(await settings.json(), {settings: {milestones: '25-50-75'}});
  assert.deepEqual(await (await fetch(`${base}/settings`)).json(), {settings: {milestones: '25-50-75'}});
  assert.equal((await fetch(`${base}/settings`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({milestones: '33'})})).status, 400);
  const blind = await setup(t, {tools: ['get_printer_status']});
  await assert.rejects(blind.service.camera(blind.object.id), error => error.reason === 'no-camera');
});

test('a print whose job the printer can\'t identify is "sent", never "printed"; one named after our file is adopted', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)]});
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {}}}; };
  await f.service.print(f.object.id);
  const sent = await f.service.settled(f.object.id);
  assert.equal(sent.state, 'sent');
  assert.ok(sent.print.dispatchedAt);
  assert.equal(sent.print.uncertain, true, 'printing it again needs a check');
  assert.equal(sent.print.monitor, undefined);
  assert.equal(f.events.at(-1).type, 'print.sent');
  await assert.rejects(f.service.print(f.object.id), InvalidStateError);

  const named = await setup(t, {reports: [status('IDLE', 0, {subtask_name: 'old'}), {...status('RUNNING', 2), print: {filename: 'checked-77-sliced', progress: 2}, raw: {gcode_state: 'RUNNING', subtask_name: 'checked-77-sliced'}},
    {connected: true, print: {filename: 'checked-77-sliced', progress: 100}, raw: {gcode_state: 'FINISH', subtask_name: 'checked-77-sliced'}}]});
  named.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {fileBase: 'sliced'}}}; };
  await named.service.print(named.object.id);
  const watching = await named.service.settled(named.object.id);
  assert.equal(watching.state, 'printing');
  assert.equal(watching.print.fileBase, 'sliced');
  for (let i = 0; i < 2; i++) await named.tick();
  const done = await until(async () => { const o = await named.service.get(named.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.jobName, 'checked-77-sliced');

  const never = await setup(t, {reports: [status('IDLE', 0, {subtask_name: 'old'})]});
  never.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {fileBase: 'sliced'}}}; };
  await never.service.print(never.object.id);
  await never.service.settled(never.object.id);
  for (let i = 0; i < 70 && (await never.service.get(never.object.id)).print.monitor.phase !== 'ended'; i++) await never.tick();
  const ended = await until(async () => { const o = await never.service.get(never.object.id); return o.state === 'sent' ? o : undefined; });
  assert.equal(ended.print.monitor.endState, 'sent');
  assert.ok(never.events.some(e => e.type === 'print.sent'));
  assert.equal(never.events.some(e => e.type === 'print.not-started'), false, 'no identity: not seeing it proves nothing');
});

test('a print handed to Bambu Connect is "sent" at once: the person finishes it on the Mac', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)]});
  f.deps.print.services.selection = {...f.deps.print.services.selection, connectionMode: 'bambu_connect'};
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {jobName: 'x', fileBase: 'x'}}}; };
  await f.service.print(f.object.id);
  const sent = await f.service.settled(f.object.id);
  assert.equal(sent.state, 'sent');
  assert.equal(sent.print.sentVia, 'bambu-connect');
});

test('a control is sent only while the printer is still printing this project\'s job', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  f.queue.length = 0;
  f.queue.push({connected: true, print: {filename: 'someone else', progress: 3}, raw: {gcode_state: 'RUNNING', subtask_name: 'someone else'}});
  await assert.rejects(f.service.control(f.object.id, 'cancel'), /isn't printing A mic mount for the stand any more, so nothing was sent/);
  assert.equal(f.calls.filter(c => c.name === 'cancel_print').length, 0);
});

test('"What\'s loaded?" on Bambu prints from a spool of that material with its profile, and never slices it with another material\'s', async t => {
  const f = await setup(t);
  // A loaded PETG spool: print from it with its own profile.
  await f.service.print(f.object.id, {colour: {material: 'petg'}});
  const run = await until(() => f.runs.at(-1));
  assert.deepEqual(run.selection, {model: 'p1s', material: 'PETG', useAms: true, amsSlots: [0], autoMatchAms: false});
  assert.equal(run.options.slicer.loadFilaments, '/p/petg.json');
  await f.approve();
  await f.service.settled(f.object.id);
  // No spool reports ASA: refused with what to do, nothing sliced or sent (the preset would slice it as PLA).
  const g = await setup(t);
  await assert.rejects(g.service.print(g.object.id, {colour: {material: 'ASA'}}), /doesn't report a ASA spool\. Set the external spool to ASA on the printer/);
  assert.equal(g.runs.length, 0);
  assert.equal((await g.service.get(g.object.id)).state, 'ready');
  assert.equal(g.directory.capabilities('current').materialChoice, true);
});

test('an event\'s frame is served from the project folder, and every object carries its status line', async t => {
  const f = await setup(t);
  const eventId = '00000000-0000-4000-8000-000000000011', printId = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
  await mkdir(join(f.service.dir(f.object.id), 'prints', printId, 'frames'), {recursive: true});
  await writeFile(join(f.service.dir(f.object.id), 'prints', printId, 'frames', `${eventId}.jpg`), JPEG);
  const routes = createObjectRoutes(f.service);
  const scopes = [];
  const server = createServer((request, response) => void routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/${f.object.id}`;
  const frame = await fetch(`${base}/prints/${printId}/frames/${eventId}.jpg`);
  assert.equal(frame.status, 200);
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), JPEG);
  assert.equal((await fetch(`${base}/prints/${printId}/frames/00000000-0000-4000-8000-000000000012.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/prints/../frames/x.jpg`)).status, 404);
  assert.deepEqual(scopes, ['projects:read', 'projects:read']);
  const {object} = await (await fetch(base)).json();
  assert.deepEqual(object.status, {phase: 'ready', text: 'Ready to print', symbol: 'checkmark.seal', tint: 'accent'});
});
