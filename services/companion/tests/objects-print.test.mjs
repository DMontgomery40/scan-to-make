import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DispatchedPrintError, HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {createServer} from 'node:http';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
// The advertised Bambu hardware-confirmation schema (including its unchecked default).
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean', title: 'I checked the printer and confirm this operation', default: false}}, required: ['confirmed']};

async function setup({judge = async () => ({clear: true}), camera = true, runnerFails, afterDispatch, uncertain, objects = 1, slowMs = 0, schema = CONFIRM, mode = 'form', timeoutMs = 5000, inventory, progressUpdates, printerReport} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-print-'));
  const store = new ObjectStore(join(root, 'objects'));
  const relay = new InMemoryElicitationRelay({timeoutMs});
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const answers = [];
  const runs = [];
  const runner = {
    backend: 'bambu-printer-mcp',
    filaments: async () => inventory,
    ...(printerReport ? {status:async()=>printerReport} : {}),
    runBundle: async (bundleStore, id, options = {}) => {
      runs.push({id, options});
      for (const update of progressUpdates ?? []) await options.onProgress?.(update);
      await new Promise(r => setTimeout(r, slowMs));
      if (runnerFails) throw new Error(runnerFails);
      if (uncertain) { await bundleStore.setStatus(id, 'uncertain', 'dispatch-uncertain'); throw Object.assign(new Error('dispatch-uncertain'), {code: 'dispatch-uncertain'}); }
      const result = await relay.request({method: 'elicitation/create', params: {mode, message: 'Printer: P1S. Build plate is clear?', requestedSchema: schema}},
        {bundleId: id, ...(camera ? {cameraSnapshot: {format: 'jpeg', base64: Buffer.from('jpeg-' + id).toString('base64')}} : {})});
      answers.push({id, result});
      result.bundleId = id;
      if (result.action !== 'accept') throw new Error('declined');
      if (afterDispatch) throw afterDispatch;
      return {bundleId: id};
    },
  };
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    print: {services: {store: bundles, relay, runner}, judgePlate: judge}});
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
  assert.deepEqual(choice, {slot:1, colour:'#FEC600', material:'PLA', name:'Yellow PLA', filamentId:'GFA00', destinationId:'default'});
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

test('a clear camera never answers the printer question; explicit checked values are required', async () => {
  const {service, object, answers} = await setup();
  const printing = await service.print(object.id);
  assert.equal(printing.state, 'printing');
  assert.ok(printing.print.bundleId);
  const waiting = await until(async () => (await service.get(object.id)).printConfirmation);
  assert.equal(waiting.message, 'Printer: P1S. Build plate is clear?');
  assert.equal(waiting.supported, true);
  assert.deepEqual(waiting.fields, [{name: 'confirmed', title: 'I checked the printer and confirm this operation', required: true}]);
  assert.equal(answers.length, 0);
  assert.equal((await service.get(object.id)).state, 'printing');
  await assert.rejects(service.answerPlate(object.id, {clear: true}), InvalidStateError);
  await service.answerPrintConfirmation(object.id, waiting.id, {action: 'accept', content: {confirmed: true}});
  const done = await service.settled(object.id);
  assert.equal(done.state, 'printed');
  assert.equal(done.printConfirmation, undefined);
  assert.deepEqual(answers[0].result, {action: 'accept', content: {confirmed: true}, bundleId: answers[0].id});
});

test('something on the plate waits for the user, who can say it is actually clear', async () => {
  const {service, object, answers} = await setup({judge: async () => ({clear: false, item: 'a printed part'})});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate?.photo ? o : undefined; });
  await until(async () => (await service.get(object.id)).plate?.item === 'a printed part');
  assert.equal(waiting.plate.photo, true);
  assert.equal(answers.length, 0);
  await approve(service, object.id);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'printed');
  assert.equal(done.plate, undefined);
});

test('a bed check that fails never confirms by itself', async () => {
  const {service, object, answers} = await setup({judge: async () => { throw new Error('Not logged in'); }});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate?.photo ? o : undefined; });
  assert.equal(waiting.printConfirmation.supported, true);
  assert.equal(answers.length, 0);
  await approve(service, object.id);
  assert.equal((await service.settled(object.id)).state, 'printed');
});

test('a printer with no camera asks the user to check the plate', async () => {
  const {service, object} = await setup({camera: false});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate?.noCamera ? o : undefined; });
  assert.deepEqual(waiting.plate, {noCamera: true});
  await approve(service, object.id);
  assert.equal((await service.settled(object.id)).state, 'printed');
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
  assert.equal((await service.settled(object.id)).state, 'printed');
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
  const {service, objects: [a, b], answers, runs} = await setup({objects: 2, judge: async () => ({clear: false, item: 'a spool'})});
  await service.print(a.id);
  await service.print(b.id);
  await until(async () => (await service.get(a.id)).plate && (await service.get(b.id)).plate);
  await approve(service, a.id);
  assert.equal((await service.settled(a.id)).state, 'printed');
  assert.deepEqual(answers.map(x => x.id), [runs.find(r => r.id === answers[0].id).id]);
  assert.equal(answers[0].id, (await service.get(a.id)).print.bundleId);
  assert.equal((await service.get(b.id)).state, 'printing');
  await approve(service, b.id);
  assert.equal((await service.settled(b.id)).state, 'printed');
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

test('a blocked plate keeps its camera photo for the phone to show', async () => {
  const {service, object, store} = await setup({judge: async () => ({clear: false, item: 'a printed part'})});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate?.photo ? o : undefined; });
  assert.equal(waiting.plate.photo, true);
  assert.equal((await readFile(join(store.dir(object.id), 'plate.jpg'))).toString(), 'jpeg-' + waiting.print.bundleId);
  await approve(service, object.id);
  await service.settled(object.id);
});

test('closing the service stops a print in progress and waits for it', async () => {
  const {service, object, runs} = await setup({judge: async () => ({clear: false, item: 'a spool'})});
  await service.print(object.id);
  await until(async () => (await service.get(object.id)).plate);
  await service.close();
  assert.equal(runs[0].options.signal.aborted, true);
  assert.equal((await service.get(object.id)).printConfirmation, undefined);
});

test('answers are bound to the current question and preserve explicit false values', async () => {
  const {service, object, answers} = await setup({camera: false});
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
  await service.print(object.id);
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
  for (const options of [{schema: {type: 'object', properties: {name: {type: 'string'}}}}, {mode: 'url'},
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

test('timeout and delayed camera judging cannot restore a completed question', async () => {
  let finishJudge;
  const judging = new Promise(resolve => { finishJudge = resolve; });
  const {service, store, object, answers} = await setup({timeoutMs: 80, judge: async () => judging});
  await service.print(object.id);
  const question = await until(async () => (await service.get(object.id)).printConfirmation);
  const timedOut = await service.settled(object.id);
  assert.equal(answers[0].result.action, 'cancel');
  assert.equal(timedOut.state, 'failed');
  assert.match(timedOut.failure, /confirmation timed out; no print was sent/i);
  finishJudge({clear: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await store.get(object.id)).printConfirmation, undefined);
  assert.equal((await service.get(object.id)).plate, undefined);
  await assert.rejects(service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}}), InvalidStateError);
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


test('an existing failed attempt exposes its retained slice estimate without rewriting its history', async () => {
  const {service,store,object,bundles}=await setup();
  const bundle=await bundles.create({stl:STL,prompt:'',backend:'bambu-printer-mcp'});
  await bundles.recordArtifact(bundle.id,'sliced','sliced.3mf',Buffer.from('UEsDBBQAAAAIAGdlYV0FODnfWQAAAJAAAAAaAAAATWV0YWRhdGEvc2xpY2VfaW5mby5jb25maWezSc7PS8tMt7MpyEksSbWzyU0tSUxJLElUyE6ttFXKzEtJrVBSKEvMKU21VTJU0kdXUFCUmpKZXJKZnwdXZWRqboqpsDw1Mz2jBGGUmZ65CUiVPtRefag7AFBLAQIUAxQAAAAIAGdlYV0FODnfWQAAAJAAAAAaAAAAAAAAAAAAAACAAQAAAABNZXRhZGF0YS9zbGljZV9pbmZvLmNvbmZpZ1BLBQYAAAAAAQABAEgAAACRAAAAAAA=','base64'));
  await bundles.setStatus(bundle.id,'uncertain','dispatch-uncertain');
  await store.update(object.id,o=>({...o,state:'failed',failure:'old saved warning',print:{bundleId:bundle.id,uncertain:true}}));
  const loaded=await service.get(object.id);
  assert.deepEqual(loaded.print.estimate,{seconds:2575,grams:16.74});
  assert.equal(loaded.print.sliced,true);
  assert.equal(loaded.failure,'old saved warning');
  assert.equal((await store.get(object.id)).print.estimate,undefined);
  assert.deepEqual((await service.list())[0].print.estimate,loaded.print.estimate);
});


test('live printer status identifies its own job and omits stale progress for a failed job', async () => {
  const report={connected:true,status:'FAILED',raw:{gcode_state:'FAILED'},print:{filename:'Previous caliper',progress:23,remaining:66}};
  const {service,store,object}=await setup({printerReport:report});
  await store.update(object.id,o=>({...o,print:{bundleId:'00000000-0000-4000-8000-000000000001'}}));
  const loaded=await service.get(object.id);
  assert.equal(loaded.print.printerStatus.state,'FAILED');
  assert.equal(loaded.print.printerStatus.job,'Previous caliper');
  assert.equal(loaded.print.printerStatus.percent,undefined);
  assert.equal(loaded.print.printerStatus.remainingMinutes,undefined);
});
