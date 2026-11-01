import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createControlDispatcher} from '../dist/local-control-services.js';

async function dispatcher() {
  const store = new ObjectStore(join(await mkdtemp(join(tmpdir(), 'objects-ctl-')), 'objects'));
  const objects = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}});
  return {dispatch: createControlDispatcher({auth: {}, companionVersion: 'test', objects}), objects};
}

test('the Mac app lists and opens the same objects the phone sees', async () => {
  const {dispatch, objects} = await dispatcher();
  const object = await objects.create('A hook.');
  assert.deepEqual((await dispatch('objects.list', {})).objects.map(o => o.id), [object.id]);
  assert.equal((await dispatch('objects.get', {id: object.id})).object.instructions, 'A hook.');
});

test('the Mac app gets the folder of each object, so it can show the renders and model from disk', async () => {
  const {dispatch, objects} = await dispatcher();
  const object = await objects.create();
  assert.equal((await dispatch('objects.list', {})).objects[0].directory, objects.dir(object.id));
  assert.equal((await dispatch('objects.get', {id: object.id})).object.directory, objects.dir(object.id));
});

test('an unknown object and a wrong state come back as plain control errors', async () => {
  const {dispatch, objects} = await dispatcher();
  await assert.rejects(dispatch('objects.get', {id: '00000000-0000-4000-8000-000000000000'}), error => error.code === 'not-found');
  const object = await objects.create();
  await assert.rejects(dispatch('objects.print', {id: object.id}), error => error.code === 'conflict');
});
