import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean', title: 'I checked the printer and confirm this operation'}}, required: ['confirmed']};

async function setup({judge = async () => ({clear: true}), camera = true, runnerFails} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-print-'));
  const store = new ObjectStore(join(root, 'objects'));
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const answers = [];
  const runner = {
    backend: 'bambu-printer-mcp',
    runBundle: async (_store, id) => {
      if (runnerFails) throw new Error(runnerFails);
      const result = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'Printer: P1S. Build plate is clear?', requestedSchema: CONFIRM}},
        camera ? {cameraSnapshot: {format: 'jpeg', base64: Buffer.from('jpeg').toString('base64')}} : undefined);
      answers.push(result);
      if (result.action !== 'accept') throw new Error('declined');
      return {bundleId: id};
    },
  };
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('not used'); }, stlInfo: async () => undefined, claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    print: {services: {store: bundles, relay, runner}, judgePlate: judge}});
  const object = await store.create('A hook.');
  await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
  await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  return {service, store, object, answers, relay};
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
  assert.deepEqual(answers[0], {action: 'accept', content: {confirmed: true}});
});

test('something on the plate waits for the user, who can say it is actually clear', async () => {
  const {service, object, answers} = await setup({judge: async () => ({clear: false, item: 'a printed part'})});
  await service.print(object.id);
  const waiting = await until(async () => { const o = await service.get(object.id); return o.plate ? o : undefined; });
  assert.deepEqual(waiting.plate, {item: 'a printed part'});
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
