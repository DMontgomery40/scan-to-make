import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {HandoffBundleStore, InMemoryElicitationRelay, PrinterMcpError, PrinterSession} from '@scan-to-make/printer-handoff';
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
async function setup(t, {tools = ['get_printer_status', 'camera_snapshot', 'pause_print', 'resume_print', 'cancel_print', 'slice_stl'], sliceArgs = false, copies = false, controlsRoute = false, reports = [], route, backend = 'bambu-printer-mcp', info, slots, controlEnds = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-printing-'));
  let service;
  t.after(async () => { await service?.close(); await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}); });
  const calls = [], events = [], runs = [];
  let endControl;
  const queue = [...reports];
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  const catalogTools = [...tools, ...(route ? ['counterpart_print_route'] : [])].map(name => name === 'slice_stl' && (sliceArgs || copies)
    ? tool(name, {...(sliceArgs ? {layer_height: {}, wall_loops: {}, sparse_infill_density: {}} : {}), ...(copies ? {repetitions: {}} : {})}) : tool(name, controlsRoute && ['cancel_print', 'pause_print', 'resume_print'].includes(name) ? {connection_mode: {}, connection_type: {}} : {}));
  const factory = () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.46'}, tools: catalogTools}; return this.catalog; },
    hasTool(name) { return catalogTools.some(item => item.name === name); },
    getTool(name) { return catalogTools.find(item => item.name === name); },
    async callTool(name, args, options = {}) {
      calls.push({name, args, context: options.elicitationContext, timeoutMs: options.timeoutMs});
      if (name === 'get_printer_status') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw Object.assign(new Error('down'), {code: 'tool-failed'});
        return {content: [{type: 'text', text: JSON.stringify(next)}]};
      }
      if (name === 'camera_snapshot') return {content: [{type: 'text', text: JSON.stringify({format: 'jpeg', base64: JPEG.toString('base64')})}]};
      if (name === 'counterpart_printer_info' && info) return {content: [{type: 'text', text: JSON.stringify(info)}], structuredContent: info};
      if (name === 'get_printer_filaments' && slots) return {content: [{type: 'text', text: JSON.stringify({slots})}]};
      if (name === 'counterpart_print_route') {
        // As both MCPs answer since Nov 3: lan and cloud through FULU, developer straight to a Developer Mode printer.
        if (args?.route) route = args.route === 'cloud' ? {mode: 'bambu_network', type: 'cloud'} : args.route === 'developer' ? {mode: 'lan_mqtt_ftps', type: 'lan'} : {mode: 'bambu_network', type: 'lan'};
        const id = route.mode === 'lan_mqtt_ftps' ? 'developer' : route.mode === 'bambu_network' && route.type === 'cloud' ? 'cloud' : 'lan';
        const options = route.legacy ? undefined : [
          {id: 'lan', label: 'Local network', available: true, controls: 'Printers with authorization control refuse Pause, Resume and Stop sent this way.'},
          {id: 'cloud', label: 'Bambu Cloud', available: true, controls: 'Printers with authorization control refuse Pause, Resume and Stop sent this way.'},
          {id: 'developer', label: 'Local network, Developer Mode', available: true, controls: 'Pause, Resume and Stop go straight to the printer.'}];
        return {content: [{type: 'text', text: JSON.stringify({route: id, mode: route.mode, type: route.type,
          choices: route.legacy ? ['lan', 'cloud'] : ['lan', 'cloud', 'developer'], ...(options ? {options} : {}), savedTo: '/Users/x/bambu-printer-mcp/.env'})}]};
      }
      if (['pause_print', 'resume_print', 'cancel_print'].includes(name)) {
        if (controlEnds) {
          // The call ends (a client timeout) while its question is still open.
          relay.request({method: 'elicitation/create', params: {mode: 'form', message: `Confirm ${name}`, requestedSchema: CONFIRM}}, options.elicitationContext).catch(() => undefined);
          await new Promise(resolve => { endControl = resolve; });
          throw Object.assign(new Error('MCP error -32001: Request timed out'), {code: 'tool-failed'});
        }
        const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: `Confirm ${name}`, requestedSchema: CONFIRM}}, options.elicitationContext);
        if (answer.action !== 'accept') return {isError: true, content: [{type: 'text', text: 'Not confirmed. Nothing was sent.'}]};
        return {content: [{type: 'text', text: '{"status":"success"}'}]};
      }
      return {content: [{type: 'text', text: '{}'}]};
    },
    async close() {},
  });
  const config = {backend, process: {command: '/usr/bin/true'}, selection: {model: 'p1s', material: 'PLA'}};
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
        {bundleId: id});
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
    print: {services, destinations: new Map([['current', services]])}, settings, camera: new CameraFrames(),
    events: {emit: async draft => { events.push(draft); }}, monitorClock: clock};
  service = new ObjectService(deps);
  const object = await store.create('A mic mount for the stand');
  await mkdir(join(store.dir(object.id), 'current'));
  await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  const approve = async () => {
    const question = await until(async () => (await service.get(object.id)).printConfirmation);
    return service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}});
  };
  return {service, store, object, calls, events, runs, relay, session, directory, queue, tick, clock, approve, deps, settings, root, slots, endControl: () => endControl?.()};
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
  // A second control while the first one's question is open is refused, never queued behind it.
  await assert.rejects(f.service.control(f.object.id, 'cancel'), /still answering the last Pause, Resume or Stop/);
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

// Nov 3: a Resume's question outlived its 2-minute call; the dead question then hid Resume until the print ended.
test('a control waits as long as its question can, and a question whose call ended never stays on the project', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)], controlEnds: true});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const resuming = f.service.control(f.object.id, 'resume').then(() => assert.fail('resumed'), error => error);
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  assert.ok(f.calls.find(c => c.name === 'resume_print').timeoutMs > 600000, 'the call outlasts the 10-minute question');
  f.endControl();
  assert.match((await resuming).message, /didn't resume/);
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);
  // A question an older companion left behind: answering it takes it off the project.
  await f.store.update(f.object.id, o => ({...o, printConfirmation: question}));
  await assert.rejects(f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}}), /no longer waiting/);
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);  // An expired one can't be answered at all; a restart takes it away.
  await f.store.update(f.object.id, o => ({...o, printConfirmation: {...question, expiresAtMs: Date.now() - 1}}));
  await f.service.resume();
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);
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
  assert.deepEqual(await settings.json(), {settings: {milestones: '25-50-75', notifications: {mac: {}, devices: {}}, general: {}}});
  assert.deepEqual(await (await fetch(`${base}/settings`)).json(), {settings: {milestones: '25-50-75', notifications: {mac: {}, devices: {}}, general: {}}});
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
  const f = await setup(t, {reports: [status('RUNNING', 1)], route: {mode: 'bambu_connect', type: 'cloud'}});
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {jobName: 'x', fileBase: 'x'}}}; };
  await f.service.print(f.object.id);
  const sent = await f.service.settled(f.object.id);
  assert.equal(sent.state, 'sent');
  assert.equal(sent.print.sentVia, 'bambu-connect');
});

test('Stop, Pause and Resume carry no route: the printer service controls over the connection it printed with', async t => {
  const f = await setup(t, {controlsRoute: true, reports: [status('RUNNING', 10)], route: {mode: 'bambu_network', type: 'lan'}});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const stopping = f.service.control(f.object.id, 'cancel');
  await f.approve();
  await stopping;
  const args = f.calls.find(c => c.name === 'cancel_print').args;
  assert.equal(args.connection_mode, undefined);
  assert.equal(args.connection_type, undefined);
});

test('a Bambu Connect choice copied into printer-handoff.json no longer decides anything: the MCP\'s route does', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)], route: {mode: 'bambu_network', type: 'lan'}});
  f.deps.print.services.selection = {...f.deps.print.services.selection, connectionMode: 'bambu_connect'};
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {jobName: 'x', fileBase: 'x'}}}; };
  await f.service.print(f.object.id);
  const settled = await f.service.settled(f.object.id);
  assert.notEqual(settled.print.sentVia, 'bambu-connect');
});

test('Settings -> Printers reads and changes the MCP\'s own route, and has none to show for an MCP without one', async t => {
  const f = await setup(t, {route: {mode: 'bambu_network', type: 'lan'}});
  const read = await f.service.printRoute('current');
  assert.equal(read.route, 'lan');
  assert.deepEqual(read.options.map(option => option.label), ['Local network', 'Bambu Cloud', 'Local network, Developer Mode'], 'the MCP words each connection');
  const cloud = await f.service.printRoute('current', 'cloud');
  assert.deepEqual([cloud.route, cloud.mode, cloud.type], ['cloud', 'bambu_network', 'cloud']);
  // Developer Mode is a route Counterpart never had to know about: the MCP names and words it.
  const developer = await f.service.printRoute('current', 'developer');
  assert.deepEqual([developer.route, developer.mode], ['developer', 'lan_mqtt_ftps']);
  assert.match(developer.options.find(option => option.id === 'developer').controls, /straight to the printer/);
  assert.deepEqual(f.calls.filter(c => c.name === 'counterpart_print_route').map(c => c.args?.route), [undefined, 'cloud', 'developer']);
  await assert.rejects(f.service.printRoute('elsewhere'));
  const none = await setup(t, {});
  assert.equal(await none.service.printRoute('current'), undefined);
  // An MCP from before options still shows its two choices.
  const older = await setup(t, {route: {mode: 'bambu_network', type: 'lan', legacy: true}});
  const legacy = await older.service.printRoute('current');
  assert.deepEqual([legacy.route, legacy.choices, legacy.options], ['lan', ['lan', 'cloud'], undefined]);
});

// The phone's Settings -> Printers: the same printers.route and printers.chooseMcp the Mac uses, over HTTPS.
test('the phone reads and changes a printer\'s connection and MCP, never while it prints, and only with settings scope', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)], route: {mode: 'bambu_network', type: 'lan'}});
  const chosen = [];
  let setupBusy = false;
  const {PrinterSetupError} = await import('../dist/printing/setup.js');
  const printerSetup = {async chooseMcp(destinationId, backend) {
    if (destinationId !== 'current') throw new PrinterSetupError('not-found', 'That printer is no longer there.');
    if (setupBusy) throw new PrinterSetupError('conflict', 'This printer is printing. Change its MCP when the print finishes.');
    chosen.push(backend); return {destinationId: 'clone-1'};
  }};
  const routes = createObjectRoutes(f.service, {printerSetup});
  const scopes = [];
  let denied = [];
  const server = createServer((request, response) => void routes.handle(request, response, async scope => {
    scopes.push(scope);
    if (denied.includes(scope)) throw Object.assign(new Error('forbidden'), {name: 'RemoteAuthFailure'});
  }, () => undefined).catch(error => { response.statusCode = error.name === 'RemoteAuthFailure' ? 403 : 500; response.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/printers`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {method, headers: {'content-type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    const text = await response.text();
    return {status: response.status, json: text ? JSON.parse(text) : undefined};
  };

  const read = await call('GET', '/current/route');
  assert.equal(read.status, 200);
  assert.equal(read.json.route.route, 'lan');
  assert.deepEqual(read.json.route.options.map(option => option.id), ['lan', 'cloud', 'developer'], 'the MCP\'s own options, as on the Mac');
  assert.deepEqual(scopes, ['printer-handoff:use']);
  scopes.length = 0;
  const cloud = await call('PUT', '/current/route', {route: 'cloud'});
  assert.equal(cloud.status, 200);
  assert.deepEqual([cloud.json.route.route, cloud.json.route.type], ['cloud', 'cloud']);
  assert.deepEqual(scopes, ['printer-handoff:use', 'projects:write'], 'a change needs settings as well as printing');
  // Bad bodies, extra keys, and a token that can print but not change settings.
  for (const body of [{}, {route: 'Cloud!'}, {route: 'cloud', destinationId: 'current'}, {route: 'cloud', extra: 1}, []])
    assert.equal((await call('PUT', '/current/route', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('POST', '/current/route', {route: 'lan'})).status, 405);
  denied = ['projects:write'];
  assert.equal((await call('PUT', '/current/route', {route: 'lan'})).status, 403);
  assert.equal((await call('PUT', '/current/mcp', {backend: 'mcp-3d-printer-server'})).status, 403);
  denied = [];
  assert.equal((await call('GET', '/elsewhere/route')).status, 404);

  // A project printing there: the connection stays as it is (409), and the MCP call is never made.
  await f.store.update(f.object.id, o => ({...o, state: 'printing'}));
  const before = f.calls.filter(c => c.name === 'counterpart_print_route').length;
  const refused = await call('PUT', '/current/route', {route: 'lan'});
  assert.equal(refused.status, 409);
  assert.match(refused.json.error.message, /printing/);
  assert.equal(f.calls.filter(c => c.name === 'counterpart_print_route').length, before);
  await f.store.update(f.object.id, o => ({...o, state: 'ready'}));
  // A print started outside Counterpart since the last read (the cache still says ready): the change reads the
  // printer live and is refused too, without calling the MCP's route tool.
  assert.equal(await f.directory.printing('current'), false);
  f.queue.splice(0, f.queue.length, status('RUNNING', 4));
  const outside = f.calls.filter(c => c.name === 'counterpart_print_route').length;
  assert.equal((await call('PUT', '/current/route', {route: 'lan'})).status, 409);
  assert.equal(f.calls.filter(c => c.name === 'counterpart_print_route').length, outside);
  f.queue.splice(0, f.queue.length, status('IDLE', 0));
  assert.equal((await call('PUT', '/current/route', {route: 'cloud'})).status, 200, 'and allowed once it is idle again');

  // Printer MCP: the companion's own chooseMcp, its refusals as HTTP statuses.
  const mcp = await call('PUT', '/current/mcp', {backend: 'mcp-3d-printer-server'});
  assert.deepEqual([mcp.status, mcp.json, chosen], [200, {destinationId: 'clone-1'}, ['mcp-3d-printer-server']]);
  setupBusy = true;
  assert.equal((await call('PUT', '/current/mcp', {backend: 'bambu-printer-mcp'})).status, 409);
  setupBusy = false;
  assert.equal((await call('PUT', '/elsewhere/mcp', {backend: 'bambu-printer-mcp'})).status, 404);
  assert.equal((await call('PUT', '/current/mcp', {backend: 'octoprint'})).status, 400);
  assert.equal((await call('GET', '/current/mcp')).status, 405);

  // An MCP without the choice: null to read, and nothing to change.
  const none = await setup(t, {});
  const plain = createObjectRoutes(none.service);
  const other = createServer((request, response) => void plain.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const otherBase = `http://127.0.0.1:${other.address().port}/v1/objects/printers/current`;
  assert.deepEqual(await (await fetch(`${otherBase}/route`)).json(), {route: null});
  assert.equal((await fetch(`${otherBase}/route`, {method: 'PUT', body: JSON.stringify({route: 'cloud'})})).status, 409);
  assert.equal((await fetch(`${otherBase}/mcp`, {method: 'PUT', body: JSON.stringify({backend: 'bambu-printer-mcp'})})).status, 503, 'a companion without printer setup says so');

  // The Mac's own path refuses mid-print the same way.
  await f.store.update(f.object.id, o => ({...o, state: 'printing'}));
  await assert.rejects(f.service.printRoute('current', 'lan'), InvalidStateError);
  assert.equal((await f.service.printRoute('current')).route, 'cloud', 'reading is fine while it prints');
});

test('status.get says whether this companion has the phone\'s printer choices', async t => {
  const f = await setup(t, {});
  const auth = {transport: 'lan', listDevices: async () => []};
  const without = createControlDispatcher({auth, companionVersion: 'test', objects: f.service});
  assert.equal((await without('status.get', {})).capabilities.printerChoices, false);
  const withSetup = createControlDispatcher({auth, companionVersion: 'test', objects: f.service, printerSetup: {chooseMcp: async () => ({destinationId: 'current'})}});
  assert.equal((await withSetup('status.get', {})).capabilities.printerChoices, true);
});

// Nov 3: Bambu Handy resumed a pick after Counterpart's Resume was refused, and the activity said "Printing again."
test('a resume Counterpart did not send is logged as outside Counterpart; its own Resume keeps "Printing again."', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const lines = async () => (await f.service.get(f.object.id)).print.events.map(e => e.message);
  const step = async (report, line) => {
    f.queue.length = 0; f.queue.push(report);
    await until(async () => { await f.tick(); return (await lines()).includes(line) ? true : undefined; });
  };
  await step(status('PAUSE', 20), 'The printer paused it.');
  await step(status('RUNNING', 30), 'Resumed outside Counterpart (on the printer or another app).');
  assert.equal((await lines()).includes('Printing again.'), false);

  await step(status('PAUSE', 40), 'The printer paused it.');
  const resuming = f.service.control(f.object.id, 'resume');
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  await f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}});
  await resuming;
  await step(status('RUNNING', 50), 'Printing again.');
});

test('an MCP that reports AMS trays in the counterpart/1 slots shape (mcp-3D-printer-server) gets filament choices like bambu-printer-mcp', async t => {
  const info = {contract: 'counterpart/1', server: {name: 'mcp-3d-printer-server', version: '1.2.26'}, printer: {kind: 'bambu', host: '192.0.2.1', model: 'P1S'},
    capabilities: {progress: true, layers: true, camera: 'none', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true}};
  const profile = '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament/Bambu PLA Basic @BBL P1S 0.4 nozzle.json';
  const f = await setup(t, {backend: 'mcp-3d-printer-server', info, tools: ['get_printer_status', 'get_printer_filaments', 'counterpart_printer_info', 'slice_stl'], slots: [
    {id: '0', material: 'PLA', color: '#000000', name: 'PLA Basic PLA #000000', source: 'printer', profile},
    {id: '1', material: 'PLA', color: '#FEC600', name: 'PLA Basic PLA #fec600', source: 'printer', profile},
    {id: '9', material: 'PLA', color: 'yellow', source: 'printer', profile},
    {id: 'ext', material: 'PETG', color: '#FFFFFF', source: 'unknown', profile: 'relative.json'}]});
  // The runner reads get_printer_filaments through the MCP; here it answers in the contract's slots shape.
  const runner = f.deps.print.services.runner;
  runner.backend = 'mcp-3d-printer-server';
  runner.filaments = async () => ({slots: f.slots});
  const choices = await f.service.filaments(f.object.id);
  assert.deepEqual(choices.map(choice => [choice.slot, choice.colour, choice.material, !!choice.suggested]), [[0, '#000000', 'PLA', true], [1, '#FEC600', 'PLA', false]],
    'well-formed trays only: a colour name or a relative profile is dropped');
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

test('a Done project prints again without "checked", with copies, and comes back Done; hiding keeps Done', async t => {
  const f = await setup(t, {copies: true, reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  // It was printed elsewhere (or sent) and marked Works by hand: an old uncertain flag doesn't stop a reprint.
  await f.store.update(f.object.id, o => ({...o, state: 'sent', print: {bundleId: 'old', uncertain: true}}));
  const marked = await f.service.setStatus(f.object.id, 'works');
  assert.deepEqual([marked.state, marked.print.uncertain], ['confirmed', undefined]);
  const {objectStatus} = await import('../dist/events/words.js');
  assert.equal(objectStatus(marked).text, 'Done · it works');
  // Hide from Home keeps Done, and showing it again leaves it Done.
  const {projectStatus} = await import('../dist/objects/service.js');
  const hidden = await f.service.setArchived(f.object.id, true);
  assert.deepEqual([hidden.archived, hidden.state, projectStatus(hidden)], [true, 'confirmed', 'works']);
  const shown = await f.service.setArchived(f.object.id, false);
  assert.deepEqual([shown.archived, shown.state], [undefined, 'confirmed']);
  // Print two more.
  const printing = await f.service.print(f.object.id, {copies: 2});
  assert.equal(printing.state, 'printing');
  const run = await until(() => f.runs.find(entry => entry.id === printing.print.bundleId));
  assert.equal(run.options.slicer.repetitions, 2);
  assert.equal(printing.print.settings.copies, 2);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.equal(done.state, 'confirmed', 'a known-good part is still known-good');
  assert.equal(projectStatus(done), 'works');
});

test('after changes, the next finished print asks "Did it fit?" again: needs-changes ends with it', async t => {
  const f = await setup(t, {reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  await f.store.update(f.object.id, o => ({...o, state: 'printed'}));
  const marked = await f.service.setStatus(f.object.id, 'needs-changes');
  const {projectStatus} = await import('../dist/objects/service.js');
  assert.equal(projectStatus(marked), 'needs-changes');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.deepEqual([done.state, done.outcome, projectStatus(done)], ['printed', undefined, 'printed']);
});

test('copies reach the estimate and the print only where the MCP takes them, and the flag says so', async t => {
  const f = await setup(t, {sliceArgs: true});
  // This fixture's slice_stl has no repetitions: refused with the update, before anything is sliced.
  await assert.rejects(f.service.estimate(f.object.id, {copies: 2}), /copies/);
  await assert.rejects(f.service.print(f.object.id, {copies: 2}), /copies/);
  assert.equal(f.service.printCopiesAvailable, false);
  const estimate = await f.service.estimate(f.object.id, {});
  assert.equal('copies' in estimate, false);
  // An MCP that takes repetitions: the estimate covers every copy.
  const g = await setup(t, {copies: true});
  assert.equal(g.service.printCopiesAvailable, true);
  const two = await g.service.estimate(g.object.id, {copies: 2});
  assert.equal(two.copies, 2);
  assert.equal(g.runs.at(-1).estimate.slicer.repetitions, 2);
});

test('one copy named is sent as repetitions 1, so it overrides a printer profile set to 3, on Print and on Estimate', async t => {
  // The printer-handoff runner merges the profile's slicer under these overrides (printer-handoff.test.mjs checks that 1 wins).
  const f = await setup(t, {copies: true, reports: [status('PREPARE', 0), status('RUNNING', 3), status('FINISH', 100)]});
  await f.service.estimate(f.object.id, {copies: 1});
  assert.equal(f.runs.at(-1).estimate.slicer.repetitions, 1);
  // Not the cached answer for "nothing named": that one is the profile's own count.
  await f.service.estimate(f.object.id, {});
  assert.equal(f.runs.at(-1).estimate.slicer?.repetitions, undefined);
  const printing = await f.service.print(f.object.id, {copies: 1});
  const run = await until(() => f.runs.find(entry => entry.id === printing.print.bundleId));
  assert.equal(run.options.slicer.repetitions, 1);
  assert.equal(printing.print.settings?.copies, 1, 'an explicit one survives reprinting and saved defaults');
  await f.approve();
  await f.service.settled(f.object.id);
  // An MCP without repetitions: one copy is still fine (it slices one), never refused.
  const g = await setup(t, {sliceArgs: true});
  await g.service.estimate(g.object.id, {copies: 1});
  assert.equal(g.runs.at(-1).estimate.slicer.repetitions, 1);
  const plain = await g.service.print(g.object.id, {copies: 1});
  assert.equal(plain.state, 'printing');
  await g.approve();
  await g.service.settled(g.object.id);
});

test('the stove gap filler, end to end: "Getting ready" while it levels, then the printer stops it; failed in its own words, and prints again', async t => {
  // HMS 0300_0D00_0002_0001 at layer 0 of 52, 3 %, then the job is gone (the real abort of 2026-11-02, as get_printer_status reports it).
  const hms = {attr: 0x03000D00, code: 0x00020001};
  const levelling = {connected: true, print: {filename: JOB, progress: 3, timeRemaining: 175, currentLayer: 0, totalLayers: 52}, raw: {gcode_state: 'RUNNING', subtask_name: JOB, task_id: '0', hms: [hms]}};
  const f = await setup(t, {reports: [status('PREPARE', 0), levelling, levelling, {connected: true, print: {}, raw: {gcode_state: 'IDLE', hms: [hms]}}]});
  const {objectStatus, eventWords} = await import('../dist/events/words.js');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await f.tick(); await f.tick();
  const getting = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.live?.job?.layer === 0 ? o : undefined; });
  assert.deepEqual([objectStatus(getting).phase, objectStatus(getting).text], ['preparing', 'Getting ready']);
  assert.equal(getting.print.printerStatus.percent, undefined, 'no percent while it gets ready');
  for (let i = 0; i < 2; i++) await f.tick();
  const failed = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  // The state really flips to failed, in the printer's own words (this report has only the code).
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'The printer stopped (0300_0D00_0002_0001).');
  assert.deepEqual(objectStatus(failed), {phase: 'failed', text: failed.failure, symbol: 'exclamationmark.triangle', tint: 'red'});
  const event = f.events.find(item => item.type === 'print.failed');
  assert.ok(event?.frame, 'with the camera frame');
  assert.equal(eventWords(event.type, event.data, {title: 'Stove gap filler', printer: 'Bambu Lab P1S'}).notify, 'timeSensitive');
  assert.equal(eventWords(event.type, event.data, {title: 'Stove gap filler', printer: 'Bambu Lab P1S'}).body, 'The printer stopped (0300_0D00_0002_0001).');
  // Print Again: a failed project with its model prints again.
  const again = await f.service.print(f.object.id);
  assert.equal(again.state, 'printing');
});

test('the failure sentence and code come from the report that ended the print (Codex repro: preparing, then idle with the code)', async t => {
  const hms = {attr: 0x03000D00, code: 0x00020001};
  const f = await setup(t, {reports: [status('PREPARE', 0), {connected: true, print: {}, raw: {gcode_state: 'IDLE', hms: [hms]}}]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 2; i++) await f.tick();
  const failed = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.deepEqual([failed.state, failed.failure], ['failed', 'The printer stopped (0300_0D00_0002_0001).']);
  // The saved record is that ending report too, not the last one while it got ready.
  assert.deepEqual(failed.print.live.problems.map(problem => problem.code), ['0300_0D00_0002_0001']);
});


test('saved project defaults reach Print, and explicit Standard overrides a saved Fine default', async t => {
  const defaults = {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}, copies: 3};
  const f = await setup(t, {sliceArgs: true, copies: true, reports: [status('IDLE', 0)]});
  await f.service.setProjectSettings(f.object.id, {printDefaults: defaults});
  assert.equal(f.runs.length, 0, 'saving defaults never starts a print');
  await f.service.print(f.object.id);
  const run = await until(() => f.runs.at(-1));
  assert.equal(run.options.slicer.layerHeightMm, 0.12);
  assert.equal(run.options.slicer.wallLoops, 4);
  assert.equal(run.options.slicer.repetitions, 3);
  assert.deepEqual(run.selection.amsSlots, [1]);
  await f.approve(); await f.service.settled(f.object.id);
  const g = await setup(t, {sliceArgs: true, copies: true, reports: [status('IDLE', 0)]});
  await g.service.setProjectSettings(g.object.id, {printDefaults: defaults});
  await g.service.print(g.object.id, {quality: 'standard', strength: 'standard', copies: 1, colour: {auto: true}});
  const overridden = await until(() => g.runs.at(-1));
  assert.equal(overridden.options.slicer.layerHeightMm, undefined);
  assert.equal(overridden.options.slicer.wallLoops, undefined);
  assert.equal(overridden.options.slicer.repetitions, 1);
  assert.equal(overridden.selection.autoMatchAms, true);
  await g.approve(); await g.service.settled(g.object.id);
});

test('problems-only projects retain print events without routine notification alerts', async t => {
  const f = await setup(t, {reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  await f.service.setProjectSettings(f.object.id, {notifications: 'problems'});
  await f.service.print(f.object.id); await f.approve(); await f.service.settled(f.object.id);
  for (let i = 0; i < 3; i++) await f.tick();
  await until(() => f.events.some(event => event.type === 'print.done'));
  for (const type of ['print.started', 'print.milestone', 'print.done']) {
    const event = f.events.find(event => event.type === type);
    assert.ok(event, type + ' remains in history');
    assert.equal(event.notify, 'none');
  }
  assert.equal(f.events.find(event => event.type === 'print.confirm').notify, undefined, 'questions still need an answer');
});


test('a one-copy-only destination can override an old saved count for Print and Estimate', async t => {
  const f = await setup(t, {sliceArgs: true, reports: [status('IDLE', 0)]});
  await f.service.setProjectSettings(f.object.id, {printDefaults: {copies: 3}});
  await f.service.estimate(f.object.id, {copies: 1});
  assert.equal(f.runs.at(-1).estimate.slicer.repetitions, 1);
  await f.service.print(f.object.id, {copies: 1});
  const run = await until(() => f.runs.find(entry => entry.options));
  assert.equal(run.options.slicer.repetitions, 1);
  assert.equal((await f.service.get(f.object.id)).preferences.printDefaults.copies, 3, 'the default remains available for a capable printer');
  await f.approve(); await f.service.settled(f.object.id);
});

test('a print the printer service refuses reaches the phone as an event (review item 23): "didn\'t start" with the reason, or a project update when it may have reached the printer', async t => {
  const f = await setup(t);
  const refusal = 'Error: Printer nozzle 0 type is unknown or does not match the job. Suggestion: A safety check stopped this before anything reached the printer.';
  // Refused before the print call: nothing can have reached the printer.
  f.deps.print.services.runner.runBundle = async () => { throw new PrinterMcpError('tool-failed', undefined, refusal); };
  await f.service.print(f.object.id);
  const refused = await f.service.settled(f.object.id);
  assert.deepEqual([refused.state, refused.failure], ['failed', refusal]);
  const event = f.events.find(item => item.type === 'print.not-started');
  assert.deepEqual([event?.projectId, event?.printId, event?.destinationId, event?.detail?.reason], [f.object.id, refused.print.printId, 'current', refusal]);
  // The print call was made and its answer is unclear: the phone is told the project changed, never that it didn't start.
  await reset(f);
  f.events.length = 0;
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'uncertain', 'dispatch-uncertain'); throw new PrinterMcpError('tool-failed', undefined, refusal); };
  await f.service.print(f.object.id);
  const unclear = await f.service.settled(f.object.id);
  assert.equal(unclear.state, 'failed');
  assert.equal(unclear.print.uncertain, true);
  assert.equal(f.events.some(item => item.type === 'print.not-started'), false);
  assert.deepEqual(f.events.filter(item => item.type === 'project.updated').map(item => [item.projectId, item.data]), [[f.object.id, {keys: ['print']}]]);
});

test('Print and Estimate keep their slices in the project\'s own folder, so Print Again prints the one already made', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)]});
  const slices = join(f.store.dir(f.object.id), 'slices');
  await f.service.estimate(f.object.id).catch(() => undefined);
  assert.deepEqual(f.runs.find(run => run.estimate)?.estimate.sliceCache, {directory: slices});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.deepEqual(f.runs.find(run => run.options)?.options.sliceCache, {directory: slices});
});
