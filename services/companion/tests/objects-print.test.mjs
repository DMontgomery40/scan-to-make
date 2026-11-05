import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DispatchedPrintError, HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {createServer} from 'node:http';
import {PrintEstimateSchema} from '@scan-to-make/contracts/counterpart';
import {showing, showingRunner} from './support/shown-print.mjs';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
// The advertised Bambu hardware-confirmation schema (including its unchecked default).
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean', title: 'I checked the printer and confirm this operation', default: false}}, required: ['confirmed']};

async function setup({runnerFails, afterDispatch, uncertain, objects = 1, slowMs = 0, schema = CONFIRM, mode = 'form', timeoutMs = 5000, inventory, progressUpdates, printerReport, relayExpiresEarlyMs} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-print-'));
  const store = new ObjectStore(join(root, 'objects'));
  const relay = new InMemoryElicitationRelay({timeoutMs});
  if (relayExpiresEarlyMs) {
    // The relay's own expiry firing before Date.now() reaches expiresAtMs, as a Node timer can.
    const request = relay.request.bind(relay);
    relay.request = (...args) => {
      const answer = request(...args);
      const asked = relay.pending().at(-1);
      setTimeout(() => relay.respond(asked.id, {action: 'cancel'}), Math.max(0, asked.expiresAtMs - Date.now() - relayExpiresEarlyMs));
      return answer;
    };
  }
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const answers = [];
  const runs = [];
  const runner = {
    backend: 'bambu-printer-mcp',
    filaments: async () => inventory,
    runBundle: async (bundleStore, id, options = {}) => {
      runs.push({id, options});
      for (const update of progressUpdates ?? []) await options.onProgress?.(update);
      await new Promise(r => setTimeout(r, slowMs));
      if (runnerFails) throw new Error(runnerFails);
      if (uncertain) { await bundleStore.setStatus(id, 'uncertain', 'dispatch-uncertain'); throw Object.assign(new Error('dispatch-uncertain'), {code: 'dispatch-uncertain'}); }
      const result = await relay.request({method: 'elicitation/create', params: {mode, message: 'Printer: P1S. Build plate is clear?', requestedSchema: schema}},
        {bundleId: id});
      answers.push({id, result});
      result.bundleId = id;
      if (result.action !== 'accept') throw new Error('declined');
      if (afterDispatch) throw afterDispatch;
      return {bundleId: id};
    },
  };
  showingRunner(runner);
  // One printer, 'default', whose MCP reports an AMS (counterpart_printer_info) and its last counterpart_print_progress.
  const services = {store: bundles, relay, runner};
  const printers = {capabilities: () => ({filaments: 'ams'}), lastReport: () => printerReport, session: () => undefined,
    record() {}, refresh: async () => {}, printing: async () => false, list: () => ({defaultDestinationId: 'default', destinations: []})};
  const service = showing(new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, printers,
    printerCatalog: {defaultDestinationId: 'default', canonical: id => id, destinations: [{id: 'default', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff'}],
      resolve: id => id === 'default' ? {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}} : undefined},
    print: {services, destinations: new Map([['default', services]])}}));
  const made = [];
  for (let i = 0; i < objects; i++) {
    const object = await store.create('A hook.');
    await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
    await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
    await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
    made.push(object);
  }
  return {service, store, object: made[0], objects: made, answers, relay, runs, bundles};
}
const approve = async (service, id) => {
  const question = await until(async () => (await service.get(id)).printConfirmation);
  return service.answerPrintConfirmation(id, question.id, {action: 'accept', content: {confirmed: true}});
};
const until = async check => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

test('printing with no model is refused', async () => {
  const {service, store} = await setup();
  const bare = await store.create();
  await assert.rejects(service.print(bare.id), InvalidStateError);
});

test('chosen live filament sets slicing profile and AMS slot; a changed spool is refused', async () => {
  const tray = {slot:1, loaded:true, tray_color:'FEC600FF', tray_type:'PLA', tray_info_idx:'GFA00',
    display_name:'Yellow PLA', resolved_profile_path:'/profiles/yellow-pla.json'};
  const {service, object, runs, bundles} = await setup({inventory:{trays:[tray]}});
  const [choice] = await service.filaments(object.id);
  assert.deepEqual(choice, {slot:1, colour:'#FEC600', material:'PLA', name:'Yellow PLA', filamentId:'GFA00', destinationId:'default', suggested:true});
  await assert.rejects(service.print(object.id, {filament:{...choice, destinationId:'other-printer'}}), /filament changed/);
  tray.tray_color = '000000FF';
  await assert.rejects(service.print(object.id, {filament:choice}), /filament changed/);
  assert.equal(runs.length, 0);
  tray.tray_color = 'FEC600FF';
  const started = await service.print(object.id, {filament:choice});
  const bundle = await bundles.read(started.print.bundleId);
  assert.deepEqual(bundle.selection, {material:'PLA', useAms:true, amsSlots:[1], autoMatchAms:false});
  assert.deepEqual(runs[0].options.slicer, {loadFilaments:'/profiles/yellow-pla.json', filamentColours:'#FEC600'});
  await approve(service, object.id);
  await service.settled(object.id);
});

test('Mac local control carries the selected filament through to print preparation', async () => {
  const inventory = {trays:[{slot:3, loaded:true, tray_color:'5B6579FF', tray_type:'PLA', tray_info_idx:'GFA00',
    display_name:'Blue PLA', resolved_profile_path:'/profiles/blue.json'}]};
  const {service, object, bundles, runs} = await setup({inventory});
  const dispatch = createControlDispatcher({auth:{}, companionVersion:'test', objects:service});
  const [choice] = (await dispatch('objects.filaments', {id:object.id})).filaments;
  const started = (await dispatch('objects.print', {id:object.id, checked:false, filament:choice})).object;
  assert.deepEqual((await bundles.read(started.print.bundleId)).selection.amsSlots, [3]);
  assert.equal(runs[0].options.slicer.filamentColours, '#5B6579');
  await approve(service, object.id);
  await service.settled(object.id);
});

test('phone inventory and print route preserve filament selection and printer scope', async t => {
  const inventory = {trays:[{slot:1, loaded:true, tray_color:'FEC600FF', tray_type:'PLA', tray_info_idx:'GFA00',
    display_name:'Yellow PLA', resolved_profile_path:'/profiles/pla.json'}]};
  const {service, object, bundles, runs} = await setup({inventory});
  const scopes = [], routes = createObjectRoutes(service);
  const server = createServer((request, response) => void routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/objects/${object.id}`;
  const inventoryResponse = await fetch(endpoint + '/filaments');
  assert.equal(inventoryResponse.status, 200);
  const [filament] = (await inventoryResponse.json()).filaments;
  assert.equal(filament.colour, '#FEC600');
  assert.equal('profile' in filament, false);
  const send = body => fetch(endpoint + '/print', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
  assert.equal((await send({filament:{...filament, slot:999}})).status, 400);
  const result = await send({checked:false, filament});
  assert.equal(result.status, 200);
  const started = (await result.json()).object;
  assert.deepEqual((await bundles.read(started.print.bundleId)).selection.amsSlots, [1]);
  assert.equal(runs[0].options.slicer.filamentColours, '#FEC600');
  assert.deepEqual(scopes, ['printer-handoff:use', 'printer-handoff:use', 'printer-handoff:use']);
  await approve(service, object.id);
  await service.settled(object.id);
});

test('only the person answers the printer question: explicit checked values are required, and there is no bed check', async () => {
  const {service, object, answers} = await setup();
  const printing = await service.print(object.id);
  assert.equal(printing.state, 'printing');
  assert.ok(printing.print.bundleId);
  const waiting = await until(async () => (await service.get(object.id)).printConfirmation);
  assert.equal(waiting.message, 'Printer: P1S. Build plate is clear?');
  assert.equal(waiting.supported, true);
  assert.deepEqual(waiting.fields, [{name: 'confirmed', title: 'I checked the printer and confirm this operation', required: true, default: false}]);
  assert.equal(answers.length, 0);
  assert.equal((await service.get(object.id)).state, 'printing');
  assert.equal('plate' in (await service.get(object.id)), false);
  await service.answerPrintConfirmation(object.id, waiting.id, {action: 'accept', content: {confirmed: true}});
  const done = await service.settled(object.id);
  assert.equal(done.state, 'sent'); // A fake printer reports nothing: dispatched, not proven printed.
  assert.equal(done.printConfirmation, undefined);
  assert.deepEqual(answers[0].result, {action: 'accept', content: {confirmed: true}, bundleId: answers[0].id});
});

test('a print that fails says why', async () => {
  const {service, object} = await setup({runnerFails: 'The printer is busy'});
  await service.print(object.id);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'failed');
  assert.match(done.failure, /printer is busy/);
});

test('a print the printer took is printed, even if saving its files failed afterwards', async () => {
  const {service, object} = await setup({afterDispatch: new DispatchedPrintError('could not save the sliced file', new Error('disk full'))});
  await service.print(object.id);
  await approve(service, object.id);
  assert.equal((await service.settled(object.id)).state, 'sent'); // A fake printer reports nothing: dispatched, not proven printed.
});

test('two quick Print taps start one print', async () => {
  const {service, object, runs} = await setup({slowMs: 30});
  const [first, second] = await Promise.allSettled([service.print(object.id), service.print(object.id)]);
  assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
  assert.ok([first, second].find(r => r.status === 'rejected').reason instanceof InvalidStateError);
  await approve(service, object.id);
  await service.settled(object.id);
  assert.equal(runs.length, 1);
});

test('with two prints waiting, each explicit answer reaches its own print', async () => {
  const {service, objects: [a, b], answers, runs} = await setup({objects: 2});
  await service.print(a.id);
  await service.print(b.id);
  await until(async () => (await service.get(a.id)).printConfirmation && (await service.get(b.id)).printConfirmation);
  await approve(service, a.id);
  assert.equal((await service.settled(a.id)).state, 'sent'); // A fake printer reports nothing: dispatched, not proven printed.
  assert.deepEqual(answers.map(x => x.id), [runs.find(r => r.id === answers[0].id).id]);
  assert.equal(answers[0].id, (await service.get(a.id)).print.bundleId);
  assert.equal((await service.get(b.id)).state, 'printing');
  await approve(service, b.id);
  assert.equal((await service.settled(b.id)).state, 'sent'); // A fake printer reports nothing: dispatched, not proven printed.
});

test('a print that may have reached the printer is never sent again until the user checks', async () => {
  const {service, object, runs} = await setup({uncertain: true});
  await service.print(object.id);
  const failed = await service.settled(object.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.print.uncertain, true);
  assert.match(failed.failure, /may have started/);
  await assert.rejects(service.print(object.id), InvalidStateError);
  assert.equal(runs.length, 1);
  await service.print(object.id, {checked: true});
  await service.settled(object.id);
  assert.equal(runs.length, 2);
});

test('closing the service stops a print in progress and waits for it', async () => {
  const {service, object, runs} = await setup();
  await service.print(object.id);
  await until(async () => (await service.get(object.id)).printConfirmation);
  await service.close();
  assert.equal(runs[0].options.signal.aborted, true);
  assert.equal((await service.get(object.id)).printConfirmation, undefined);
});

test('answers are bound to the current question and preserve explicit false values', async () => {
  const {service, object, answers} = await setup();
  await service.print(object.id);
  const question = await until(async () => (await service.get(object.id)).printConfirmation);
  for (const answer of [{action: 'accept', content: {}}, {action: 'accept', content: {confirmed: 'true'}},
    {action: 'accept', content: {confirmed: true, extra: true}}, {action: 'cancel', content: {confirmed: true}}]) {
    await assert.rejects(service.answerPrintConfirmation(object.id, question.id, answer), InvalidStateError);
  }
  await assert.rejects(service.answerPrintConfirmation(object.id, '00000000-0000-4000-8000-000000000001', {action: 'accept', content: {confirmed: true}}), InvalidStateError);
  assert.equal(answers.length, 0);
  await service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: false}});
  await service.settled(object.id);
  assert.deepEqual(answers[0].result.content, {confirmed: false});
  // The fixture accepted it (a false checkbox is the MCP's to judge) and reports nothing back: printing again needs the check.
  await service.print(object.id, {checked: true});
  const next = await until(async () => (await service.get(object.id)).printConfirmation);
  assert.notEqual(next.id, question.id);
  await assert.rejects(service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}}), InvalidStateError);
  await service.answerPrintConfirmation(object.id, next.id, {action: 'cancel'});
  const cancelled = await service.settled(object.id);
  assert.equal(cancelled.printConfirmation, undefined);
  assert.equal(cancelled.state, 'ready');
  assert.equal(cancelled.failure, undefined);
});

test('unknown schemas and modes preserve the original question but only permit cancellation', async () => {
  for (const options of [{schema: {type: 'object', properties: {name: {type: 'array'}}}}, {mode: 'url'},
    {schema: undefined, mode: 'url'}, {schema: {...CONFIRM, anyOf: [{required: ['confirmed']}]}}]) {
    const {service, object, answers} = await setup(options);
    await service.print(object.id);
    const question = await until(async () => (await service.get(object.id)).printConfirmation);
    assert.equal(question.supported, false);
    assert.equal(question.message, 'Printer: P1S. Build plate is clear?');
    assert.deepEqual(question.fields, []);
    await assert.rejects(service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}}), InvalidStateError);
    await service.answerPrintConfirmation(object.id, question.id, {action: 'cancel'});
    assert.equal((await service.settled(object.id)).printConfirmation, undefined);
    assert.equal(answers[0].result.action, 'cancel');
  }
});

test('a timed-out question cannot be answered or restored', async () => {
  const {service, store, object, answers} = await setup({timeoutMs: 80});
  await service.print(object.id);
  const question = await until(async () => (await service.get(object.id)).printConfirmation);
  const timedOut = await service.settled(object.id);
  assert.equal(answers[0].result.action, 'cancel');
  assert.equal(timedOut.state, 'failed');
  assert.match(timedOut.failure, /confirmation timed out; no print was sent/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.get(object.id)).printConfirmation, undefined);
  await assert.rejects(service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}}), InvalidStateError);
});

test('a question the relay expires just before its deadline still reads as timed out', async () => {
  // Gate failure on Node 24, Nov 4: the relay's timer won the race and the reason became the runner's "declined".
  const {service, object, answers} = await setup({timeoutMs: 600, relayExpiresEarlyMs: 200});
  await service.print(object.id);
  await until(async () => (await service.get(object.id)).printConfirmation);
  const timedOut = await service.settled(object.id);
  assert.equal(answers[0].result.action, 'cancel');
  assert.equal(timedOut.state, 'failed');
  assert.match(timedOut.failure, /confirmation timed out; no print was sent/i);
});

test('print phases and estimates are visible before confirmation and survive a failure', async () => {
  const {service, object} = await setup({progressUpdates:[{phase:'slicing'},{phase:'slice-ready',estimate:{seconds:2575,grams:16.74}}], uncertain:true});
  await service.print(object.id);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.progress, undefined);
  assert.equal(done.print.sliced, true);
  assert.deepEqual(done.print.estimate, {seconds:2575,grams:16.74});
  assert.deepEqual(done.print.events.map(x=>x.message), ['Slicing the model…','Sliced file saved.']);
});


test('an existing failed attempt shows the estimate saved with its print, and the app never reads its sliced file for one', async () => {
  const {service,store,object,bundles}=await setup();
  const bundle=await bundles.create({stl:STL,prompt:'',backend:'bambu-printer-mcp'});
  await bundles.recordArtifact(bundle.id,'sliced','sliced.3mf',Buffer.from('PK\x03\x04 a sliced file the MCP read when it was printed'));
  await bundles.setStatus(bundle.id,'uncertain','dispatch-uncertain');
  // From before the MCP read it (PRD §8.0 item 9): no estimate rather than Counterpart parsing slice_info.config.
  await store.update(object.id,o=>({...o,state:'failed',failure:'old saved warning',print:{bundleId:bundle.id,uncertain:true}}));
  let loaded=await service.get(object.id);
  assert.equal(loaded.print.estimate,undefined);
  assert.equal(loaded.failure,'old saved warning');
  await store.update(object.id,o=>({...o,print:{...o.print,sliced:true,estimate:{seconds:2575,grams:16.74}}}));
  loaded=await service.get(object.id);
  assert.deepEqual(loaded.print.estimate,{seconds:2575,grams:16.74});
  assert.equal(loaded.print.sliced,true);
});


test('live printer status identifies its own job and omits stale progress for a failed job', async () => {
  const report={observedAt:new Date().toISOString(),state:'failed',job:{name:'Previous caliper',progress:23,remainingSec:66*60},problems:[],source:'counterpart'};
  const {service,store,object}=await setup({printerReport:report});
  await store.update(object.id,o=>({...o,print:{bundleId:'00000000-0000-4000-8000-000000000001',destination:{id:'default',name:'P1S'}}}));
  const loaded=await service.get(object.id);
  assert.equal(loaded.print.printerStatus.state,'FAILED');
  assert.equal(loaded.print.printerStatus.job,'Previous caliper');
  assert.equal(loaded.print.printerStatus.percent,undefined);
  assert.equal(loaded.print.printerStatus.remainingMinutes,undefined);
});


test('the printer\'s time left is shown for its running job', async () => {
 const report={observedAt:new Date().toISOString(),state:'printing',job:{name:'Checked mount',progress:3,remainingSec:42*60},problems:[],source:'counterpart'};
 const {service,store,object}=await setup({printerReport:report});
 await store.update(object.id,o=>({...o,print:{bundleId:'00000000-0000-4000-8000-000000000001',destination:{id:'default',name:'P1S'}}}));
 const loaded=await service.get(object.id);
 assert.equal(loaded.print.printerStatus.percent,3);
 assert.equal(loaded.print.printerStatus.remainingMinutes,42);
});

test('the Mac answers any flat MCP question; a wrong answer comes back as invalid-request with its reason', async () => {
  const schema = {type: 'object', required: ['confirmed', 'bambu_model'], properties: {
    confirmed: {type: 'boolean', title: 'I checked the printer'}, bambu_model: {type: 'string', title: 'Printer Model', oneOf: [{const: 'p1s', title: 'P1S'}]}}};
  const {service, object, answers} = await setup({schema});
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  const {capabilities} = await createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: service})('status.get', {});
  assert.deepEqual([capabilities.genericConfirmations, capabilities.materialChoice], [true, true]);
  await service.print(object.id);
  const question = await until(async () => (await service.get(object.id)).printConfirmation);
  assert.equal(question.supported, true);
  assert.deepEqual(question.fields[1], {name: 'bambu_model', title: 'Printer Model', required: true, type: 'string', enum: ['p1s'], enumNames: ['P1S']});
  await assert.rejects(dispatch('objects.answerPrintConfirmation', {id: object.id, confirmationId: question.id, answer: {action: 'accept', content: {confirmed: true, bambu_model: 'x1c'}}}),
    error => error.code === 'invalid-request' && /"Printer Model" must be one of the choices/.test(error.message));
  assert.equal(answers.length, 0);
  await dispatch('objects.answerPrintConfirmation', {id: object.id, confirmationId: question.id, answer: {action: 'accept', content: {confirmed: true, bambu_model: 'p1s'}}});
  await service.settled(object.id);
  assert.deepEqual(answers[0].result.content, {confirmed: true, bambu_model: 'p1s'});
});

// Bambu Studio's own result.json (KAN-221), through the real runner and the fixture printer MCP.
test("Bambu Studio's words reach the project: its error is the failure, its warning is a question that needs a yes", async t => {
  const {createPrintHandoffServices} = await import('../dist/print-handoff-http.js');
  const fixtures = new URL('../../printer-handoff/tests/fixtures/', import.meta.url);
  const studio = async name => JSON.parse(await readFile(new URL(`slicer-results/${name}.json`, fixtures), 'utf8'));
  const run = async result => {
    const root = await mkdtemp(join(tmpdir(), 'objects-print-studio-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const log = join(root, 'calls.jsonl');
    await writeFile(log, '');
    const services = createPrintHandoffServices({backend: 'bambu-printer-mcp',
      process: {command: process.execPath, args: [new URL('fixture-printer-server.mjs', fixtures).pathname, 'bambu', log], cwd: root,
        env: {HANDOFF_FIXTURE_SLICER_RESULT: new URL(`slicer-results/${result}.json`, fixtures).pathname}},
      selection: {model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel', bedType: 'textured_plate', material: 'PLA', plateIndex: 0},
      timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 10000}}, join(root, 'bundles'));
    const store = new ObjectStore(join(root, 'objects'));
    const service = showing(new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
      handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, print: {services}}));
    const object = await store.create('A stove gap filler.');
    await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
    await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
    await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
    // Print as the sheet does: its estimate slices and previews, then Print sends that file.
    const printing = await service.print(object.id).then(() => undefined, error => error);
    const tools = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(entry => entry.tool).map(entry => entry.tool);
    return {service, id: object.id, tools, printing};
  };
  // The empty-layer error: the sheet shows Studio's words, and nothing is asked or sent.
  const failing = await studio('orient-empty-layers');
  const refused = await run('orient-empty-layers');
  assert.equal(refused.printing?.message, `${failing.error_string}\n${failing.sliced_plates[0].warning_message}`);
  assert.equal((await refused.service.get(refused.id)).printConfirmation, undefined);
  assert.deepEqual(await refused.tools(), ['slice_stl']);
  // The floating cantilever: Studio's words as a native question with one "Print anyway" switch, then the printer's own.
  const words = (await studio('lay-flat-floating-cantilever')).sliced_plates[0].warning_message;
  const warned = await run('lay-flat-floating-cantilever');
  const question = await until(async () => (await warned.service.get(warned.id)).printConfirmation);
  assert.equal(question.message, words);
  assert.equal(question.supported, true);
  assert.deepEqual(question.fields.map(field => [field.name, field.title, field.required]), [['confirmed', 'Print anyway', true]]);
  assert.equal((await warned.tools()).includes('print_3mf'), false, 'nothing sent before the yes');
  await warned.service.answerPrintConfirmation(warned.id, question.id, {action: 'accept', content: {confirmed: true}});
  const printer = await until(async () => { const asked = (await warned.service.get(warned.id)).printConfirmation; return asked && asked.id !== question.id ? asked : undefined; });
  assert.match(printer.message, /^Fixture bed-clearance confirmation/);
  await warned.service.answerPrintConfirmation(warned.id, printer.id, {action: 'accept', content: {confirmed: true}});
  await warned.service.settled(warned.id);
  // Sliced once, for the sheet: its preview, then the same file checked again just before it is sent.
  assert.deepEqual(await warned.tools(), ['slice_stl', 'inspect_print_file', 'inspect_print_file', 'print_3mf']);
});

// KAN-224: the print sheet's estimate says what Print would, in Bambu Studio's words, through the same real runner.
test("an estimate carries Bambu Studio's words: its warning as slicerWarning, its error as the refusal; nothing is asked or sent", async t => {
  const {createPrintHandoffServices} = await import('../dist/print-handoff-http.js');
  const fixtures = new URL('../../printer-handoff/tests/fixtures/', import.meta.url);
  const studio = async name => JSON.parse(await readFile(new URL(`slicer-results/${name}.json`, fixtures), 'utf8'));
  const estimate = async (result, request = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'objects-estimate-studio-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const log = join(root, 'calls.jsonl');
    await writeFile(log, '');
    const services = createPrintHandoffServices({backend: 'bambu-printer-mcp',
      process: {command: process.execPath, args: [new URL('fixture-printer-server.mjs', fixtures).pathname, 'bambu', log], cwd: root,
        env: {HANDOFF_FIXTURE_SLICE_SETTINGS: '1', HANDOFF_FIXTURE_SLICER_RESULT: new URL(`slicer-results/${result}.json`, fixtures).pathname}},
      selection: {model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel', bedType: 'textured_plate', material: 'PLA', plateIndex: 0},
      timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 10000}}, join(root, 'bundles'));
    const store = new ObjectStore(join(root, 'objects'));
    const service = new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
      handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, print: {services}});
    const object = await store.create('A stove gap filler.');
    await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
    await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
    await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
    const tools = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(entry => entry.tool).map(entry => entry.tool);
    const outcome = await service.estimate(object.id, request).then(value => ({value}), error => ({error}));
    const after = await store.get(object.id);
    assert.equal(after.state, 'ready', 'an estimate never changes the project');
    assert.equal(after.printConfirmation, undefined, 'an estimate asks nothing');
    assert.equal((await tools()).includes('print_3mf'), false, 'an estimate sends nothing');
    return {...outcome, service, id: object.id};
  };
  // A floating cantilever on the slice: the estimate comes back, with Studio's warning word for word.
  const words = (await studio('lay-flat-floating-cantilever')).sliced_plates[0].warning_message;
  const warned = await estimate('lay-flat-floating-cantilever');
  assert.equal(warned.error, undefined);
  assert.equal(warned.value.slicerWarning, words);
  PrintEstimateSchema.parse(warned.value);
  // A clean slice has no warning.
  const clean = await estimate('cap-down-clean');
  assert.equal(clean.error, undefined);
  assert.equal('slicerWarning' in clean.value, false);
  // The empty-layer error: refused with exactly the failure a Print of the same model gets, not a generic one.
  const failing = await studio('orient-empty-layers');
  const refused = await estimate('orient-empty-layers');
  assert.ok(refused.error instanceof InvalidStateError, 'still a 409 invalid-state on HTTP: the phone is unchanged');
  assert.equal(refused.error.message, `${failing.error_string}\n${failing.sliced_plates[0].warning_message}`);
  // The Mac's control socket names it, so the Mac's print sheet holds Print for this file and for nothing else.
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: refused.service});
  await assert.rejects(dispatch('objects.estimate', {id: refused.id}),
    error => error.code === 'slicer-error' && error.message === refused.error.message);
  const copies = await estimate('copies-two-plates', {copies: 2});
  const copiesWords = 'The slicer placed 2 copies on 2 plates, requiring 2 separate prints. Choose fewer copies for this print.';
  assert.equal(copies.error.message, copiesWords);
  const copiesControl = createControlDispatcher({auth: {}, companionVersion: 'test', objects: copies.service});
  await assert.rejects(copiesControl('objects.estimate', {id: copies.id, copies: 2}),
    error => error.code === 'slicer-error' && error.message === copiesWords,
    'the Mac receives an actionable refusal that holds Print, not a transient estimate failure');
  const fine = createControlDispatcher({auth: {}, companionVersion: 'test', objects: warned.service});
  assert.equal((await fine('objects.estimate', {id: warned.id})).slicerWarning, words, 'a warning is an estimate, not a refusal');
});


test('a retained checkpoint in a failed capped project remains available for explicit manual printing', async t => {
  const {service, store, object, runs} = await setup();
  t.after(() => service.close());
  await store.update(object.id, value => ({...value, state: 'failed',
    failure: 'Stopped at the step limit. Try again or review the saved checkpoint.',
    passes: [{startedAtMs: 1, endedAtMs: 2, status: 'capped'}]}));
  await service.print(object.id);
  assert.equal(runs.length, 1);
  await approve(service, object.id);
  const sent = await service.settled(object.id);
  assert.equal(sent.state, 'sent');
  assert.equal(await readFile(join(store.dir(object.id), sent.current.model), 'utf8'), STL.toString());
});

// Counterpart is a bridge: the designer's supports choice goes to the slicer as it is, and the slicer orients the model.
test("the designer's supports choice reaches the slicer as it is, and an MCP that can't take it is refused before slicing", async t => {
  const {createPrintHandoffServices} = await import('../dist/print-handoff-http.js');
  const fixtures = new URL('../../printer-handoff/tests/fixtures/', import.meta.url);
  const estimate = async ({supports, mcpSupports, kind}) => {
    const root = await mkdtemp(join(tmpdir(), 'objects-supports-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const log = join(root, 'calls.jsonl');
    await writeFile(log, '');
    const services = createPrintHandoffServices({backend: 'bambu-printer-mcp',
      process: {command: process.execPath, args: [new URL('fixture-printer-server.mjs', fixtures).pathname, 'bambu', log], cwd: root,
        env: {HANDOFF_FIXTURE_SLICE_SETTINGS: '1', ...(mcpSupports ? {HANDOFF_FIXTURE_SUPPORTS: '1'} : {}), HANDOFF_FIXTURE_SLICER_RESULT: new URL('slicer-results/cap-down-clean.json', fixtures).pathname}},
      selection: {model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel', bedType: 'textured_plate', material: 'PLA', plateIndex: 0},
      timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 10000}}, join(root, 'bundles'));
    const store = new ObjectStore(join(root, 'objects'));
    const service = new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
      handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, print: {services}});
    const object = await store.create('An AirPods Max desk hanger.', kind);
    await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
    await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
    await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: [], ...(supports ? {supports} : {})}}));
    const outcome = await service.estimate(object.id, {}).then(value => ({value}), error => ({error}));
    const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(entry => entry.tool);
    return {...outcome, slice: calls.find(entry => entry.tool === 'slice_stl'), tools: calls.map(entry => entry.tool)};
  };
  for (const supports of [{enabled: true, type: 'tree(auto)'}, {enabled: false}]) {
    const sent = await estimate({supports, mcpSupports: true});
    assert.equal(sent.error, undefined);
    assert.equal(sent.slice.arguments.enable_support, supports.enabled, 'supports off is sent too');
    assert.equal(sent.slice.arguments.support_type, supports.type);
    assert.equal(sent.slice.arguments.orient, true, 'the slicer orients the model');
    assert.equal(sent.tools.includes('lay_flat'), false);
  }
  // No choice from the designer: the slicer profile decides, as before.
  const none = await estimate({mcpSupports: true});
  assert.equal('enable_support' in none.slice.arguments, false);
  // An installed MCP without the support arguments: refused in plain words, before anything is sliced.
  const old = await estimate({supports: {enabled: true, type: 'tree(auto)'}});
  assert.match(old.error?.message ?? '', /^Update bambu-printer-mcp in Settings → Printers so Counterpart can send this design’s supports to the slicer\./);
  assert.deepEqual(old.tools, []);
});
