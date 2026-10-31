import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';

const store = async () => new ObjectStore(await mkdtemp(join(tmpdir(), 'objects-')));

test('create, get and list round-trip, newest first', async () => {
  const s = await store();
  const first = await s.create('A hook for a 25 mm handle.');
  await new Promise(r => setTimeout(r, 5));
  const second = await s.create();
  assert.equal(first.state, 'new');
  assert.equal(first.instructions, 'A hook for a 25 mm handle.');
  assert.deepEqual(first.photos, []);
  assert.deepEqual((await s.get(first.id)), first);
  assert.deepEqual((await s.list()).map(o => o.id), [second.id, first.id]);
});

test('update changes the object and its timestamp, atomically', async () => {
  const s = await store();
  const object = await s.create();
  const updated = await s.update(object.id, o => ({...o, state: 'touching-up'}));
  assert.equal(updated.state, 'touching-up');
  assert.ok(updated.updatedAtMs >= object.updatedAtMs);
  assert.deepEqual((await readdir(s.dir(object.id))).filter(name => name.includes('.tmp')), []);
});

test('files are stored under the object and names cannot escape it', async () => {
  const s = await store();
  const object = await s.create();
  const path = await s.addFile(object.id, 'photos', 'IMG_0001.HEIC', Buffer.from('x'));
  assert.equal(path, join(s.dir(object.id), 'photos', 'IMG_0001.HEIC'));
  await assert.rejects(s.addFile(object.id, 'photos', '../object.json', Buffer.from('x')), /name/);
  await assert.rejects(s.addFile(object.id, 'photos', '.hidden', Buffer.from('x')), /name/);
});

test('an unknown id is not found', async () => {
  const s = await store();
  await assert.rejects(s.get('00000000-0000-4000-8000-000000000000'), /not found/);
  await assert.rejects(s.get('../etc'), /not found/);
});

test('work interrupted by a restart is marked failed, never left running', async () => {
  const s = await store();
  const touching = await s.create(), printing = await s.create(), ready = await s.create();
  await s.update(touching.id, o => ({...o, state: 'touching-up'}));
  await s.update(printing.id, o => ({...o, state: 'printing'}));
  await s.update(ready.id, o => ({...o, state: 'ready'}));
  await s.recoverInterrupted();
  assert.equal((await s.get(touching.id)).state, 'failed');
  assert.match((await s.get(touching.id)).failure, /interrupted/);
  assert.equal((await s.get(printing.id)).state, 'failed');
  assert.equal((await s.get(ready.id)).state, 'ready');
});

test('simultaneous updates to one object all land, none lost', async () => {
  const s = await store();
  const object = await s.create();
  await Promise.all(Array.from({length: 20}, (_, i) => s.update(object.id, o => ({...o, photos: [...o.photos, `p${i}.jpg`]}))));
  assert.equal((await s.get(object.id)).photos.length, 20);
});
