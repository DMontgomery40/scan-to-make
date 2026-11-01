import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DispatchedPrintError, HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean', title: 'I checked the printer and confirm this operation'}}, required: ['confirmed']};

async function setup({judge = async () => ({clear: true}), camera = true, runnerFails, afterDispatch, uncertain, objects = 1, slowMs = 0} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-print-'));
  const store = new ObjectStore(join(root, 'objects'));
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const answers = [];
  const runs = [];
  const runner = {
    backend: 'bambu-printer-mcp',
    runBundle: async (bundleStore, id, options = {}) => {
      runs.push({id, options});
      await new Promise(r => setTimeout(r, slowMs));
      if (runnerFails) throw new Error(runnerFails);
      if (uncertain) { await bundleStore.setStatus(id, 'uncertain', 'dispatch-uncertain'); throw Object.assign(new Error('dispatch-uncertain'), {code: 'dispatch-uncertain'}); }
      const result = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'Printer: P1S. Build plate is clear?', requestedSchema: CONFIRM}},
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
const until = async check => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

test('printing with no model is refused', async () => {
  const {service, store} = await setup();
  const bare = await store.create();
  await assert.rejects(service.print(bare.id), InvalidStateError);
});

test('a clear plate confirms by itself and the object is printed', async () => {
  const {service, object, answers} = await setup();
  const printing = await service.print(object.id);
  assert.equal(printing.state, 'printing');
  assert.ok(printing.print.bundleId);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'printed');
  assert.deepEqual(answers[0].result, {action: 'accept', content: {confirmed: true}, bundleId: answers[0].id});
});

test('something on the plate waits for the user, who can say it is actually clear', async () => {
  const {service, object, answers} = await setup({judge: async () => ({clear: false, item: 'a printed part'})});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate ? o : undefined; });
  assert.deepEqual(waiting.plate, {item: 'a printed part', photo: true});
  assert.equal(answers.length, 0);
  await service.answerPlate(object.id, {clear: true});
  const done = await service.settled(object.id);
  assert.equal(done.state, 'printed');
  assert.equal(done.plate, undefined);
});

test('a bed check that fails never confirms by itself', async () => {
  const {service, object, answers} = await setup({judge: async () => { throw new Error('Not logged in'); }});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate ? o : undefined; });
  assert.equal(waiting.plate.item, 'something');
  assert.equal(answers.length, 0);
  await service.answerPlate(object.id, {clear: true});
  assert.equal((await service.settled(object.id)).state, 'printed');
});

test('a printer with no camera asks the user to check the plate', async () => {
  const {service, object} = await setup({camera: false});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate ? o : undefined; });
  assert.deepEqual(waiting.plate, {noCamera: true});
  await service.answerPlate(object.id, {clear: true});
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
  assert.equal((await service.settled(object.id)).state, 'printed');
});

test('two quick Print taps start one print', async () => {
  const {service, object, runs} = await setup({slowMs: 30});
  const [first, second] = await Promise.allSettled([service.print(object.id), service.print(object.id)]);
  assert.equal([first, second].filter(r => r.status === 'fulfilled').length, 1);
  assert.ok([first, second].find(r => r.status === 'rejected').reason instanceof InvalidStateError);
  await service.settled(object.id);
  assert.equal(runs.length, 1);
});

test('with two prints waiting, each plate answer reaches its own print', async () => {
  const {service, objects: [a, b], answers, runs} = await setup({objects: 2, judge: async () => ({clear: false, item: 'a spool'})});
  await service.print(a.id);
  await service.print(b.id);
  await until(async () => (await service.get(a.id)).plate && (await service.get(b.id)).plate);
  await service.answerPlate(a.id, {clear: true});
  assert.equal((await service.settled(a.id)).state, 'printed');
  assert.deepEqual(answers.map(x => x.id), [runs.find(r => r.id === answers[0].id).id]);
  assert.equal(answers[0].id, (await service.get(a.id)).print.bundleId);
  assert.equal((await service.get(b.id)).state, 'printing');
  await service.answerPlate(b.id, {clear: true});
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
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate ? o : undefined; });
  assert.equal(waiting.plate.photo, true);
  assert.equal((await readFile(join(store.dir(object.id), 'plate.jpg'))).toString(), 'jpeg-' + waiting.print.bundleId);
  await service.answerPlate(object.id, {clear: true});
  await service.settled(object.id);
});

test('closing the service stops a print in progress and waits for it', async () => {
  const {service, object, runs} = await setup({judge: async () => ({clear: false, item: 'a spool'})});
  await service.print(object.id);
  await until(async () => (await service.get(object.id)).plate);
  await service.close();
  assert.equal(runs[0].options.signal.aborted, true);
});
