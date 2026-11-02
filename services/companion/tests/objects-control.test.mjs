import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createControlDispatcher} from '../dist/local-control-services.js';

const until = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };

async function dispatcher(events) {
  const store = new ObjectStore(join(await mkdtemp(join(tmpdir(), 'objects-ctl-')), 'objects'));
  const objects = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, ...(events ? {events} : {})});
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

test('the Mac app can start a touch-up again, and a refusal says why in plain words', async () => {
  const {dispatch, objects} = await dispatcher();
  const object = await objects.create('A hook.');
  await assert.rejects(dispatch('objects.print', {id: object.id}), error => error.code === 'conflict' && error.message === 'There is no model to print yet.');
  assert.equal((await dispatch('objects.start', {id: object.id})).object.state, 'touching-up');
  await objects.settled(object.id);
});

test('a new project says when its first files are arriving from the phone; with none arriving and none sent it is a draft', async () => {
  const events = [];
  const {dispatch, objects} = await dispatcher({emit: async draft => { events.push(draft); }});
  const object = await objects.create();
  const progress = async () => (await dispatch('objects.list', {})).objects.find(o => o.id === object.id).progress;
  assert.equal(await progress(), undefined, 'nothing sent and nothing arriving: a draft');
  // One upload in flight: the Mac reads it as sending, and an event makes it read again at once.
  let arrive;
  const upload = objects.receive(object.id, () => new Promise(resolve => { arrive = resolve; }));
  await until(() => arrive);
  assert.equal(await progress(), 'Receiving files from your iPhone');
  assert.equal((await dispatch('objects.get', {id: object.id})).object.progress, 'Receiving files from your iPhone');
  const receiving = () => events.filter(event => event.type === 'project.updated' && event.data?.keys?.includes('receiving'));
  assert.equal(receiving().length, 1);
  // The upload is cut short: nothing reached the Mac, so it is a draft again, and the apps hear about it.
  arrive();
  await upload;
  assert.equal(await progress(), undefined);
  assert.equal(receiving().length, 2);
  // An upload that lands: the project has a file, so it reads as sending from then on; no second event is needed.
  await objects.receive(object.id, () => objects.addPhoto(object.id, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])));
  assert.equal(receiving().length, 3, 'the start of that upload, while the project had nothing');
  assert.equal(objects.receiving(object.id), false);
  // Two at once count as one send until both finish.
  let first, second;
  const a = objects.receive(object.id, () => new Promise(resolve => { first = resolve; }));
  const b = objects.receive(object.id, () => new Promise(resolve => { second = resolve; }));
  await until(() => first && second);
  first(); await a;
  assert.equal(objects.receiving(object.id), true);
  second(); await b;
  assert.equal(objects.receiving(object.id), false);
});

test('the Mac app can delete an object, and the event says the Mac did', async () => {
  const events = [];
  const {dispatch, objects} = await dispatcher({emit: async draft => { events.push(draft); }});
  const object = await objects.create('A hook.');
  assert.deepEqual(await dispatch('objects.delete', {id: object.id}), {deleted: true});
  await assert.rejects(dispatch('objects.get', {id: object.id}), error => error.code === 'not-found');
  assert.deepEqual(events.filter(event => event.type === 'project.deleted').map(event => [event.projectId, event.data]), [[object.id, {by: 'mac'}]]);
});

test('New Project on the Mac: create, copy a scan and photos in from paths, then ask for changes with more photos', async t => {
  const {dispatch, objects} = await dispatcher();
  const folder = await mkdtemp(join(tmpdir(), 'objects-files-'));
  const {writeFile, readFile, symlink} = await import('node:fs/promises');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
  const stl = Buffer.concat([Buffer.alloc(80), Buffer.from([1, 0, 0, 0]), Buffer.alloc(50)]);
  await writeFile(join(folder, 'Front view (1).JPG'), jpeg);
  await writeFile(join(folder, 'mount.stl'), stl);
  await writeFile(join(folder, 'fake.png'), jpeg);
  await writeFile(join(folder, 'notes.txt'), 'x');
  await symlink(join(folder, 'Front view (1).JPG'), join(folder, 'alias.jpg'));
  const created = (await dispatch('objects.create', {instructions: 'A bracket for this mount'})).object;
  assert.equal(created.instructions, 'A bracket for this mount');
  const withScan = (await dispatch('objects.addFile', {id: created.id, kind: 'scan', path: join(folder, 'mount.stl')})).object;
  assert.equal(withScan.scan, 'scan.stl');
  assert.deepEqual(await readFile(join(objects.dir(created.id), 'scan', 'scan.stl')), stl);
  const one = (await dispatch('objects.addFile', {id: created.id, kind: 'photos', path: join(folder, 'Front view (1).JPG')})).object;
  const two = (await dispatch('objects.addFile', {id: created.id, kind: 'photos', path: join(folder, 'alias.jpg')})).object;
  assert.deepEqual(one.photos, ['Front view -1-.jpg']);
  assert.deepEqual(two.photos, ['Front view -1-.jpg', 'alias.jpg']);
  for (const [path, kind] of [[join(folder, 'fake.png'), 'photos'], [join(folder, 'notes.txt'), 'photos'], [join(folder, 'mount.stl'), 'photos'], ['relative.jpg', 'photos']])
    await assert.rejects(dispatch('objects.addFile', {id: created.id, kind, path}), error => error.code === 'conflict');
  await assert.rejects(dispatch('objects.addFile', {id: created.id, kind: 'photos', path: join(folder, 'missing.jpg')}), error => error.code === 'not-found');
  await objects.start(created.id).catch(() => undefined);
  await objects.settled(created.id);
  // Once work has started a scan can't change, but photos still can.
  await assert.rejects(dispatch('objects.addFile', {id: created.id, kind: 'scan', path: join(folder, 'mount.stl')}), error => error.code === 'conflict');
  await assert.rejects(dispatch('objects.correct', {id: created.id, note: 'Thicker', photos: [join(folder, 'notes.txt')]}), error => error.code === 'conflict');
  t.after(() => import('node:fs/promises').then(fs => fs.rm(folder, {recursive: true, force: true})));
});

test('status.get says the Mac can create projects only when objects are set up', async () => {
  const {objects} = await dispatcher();
  const auth = {transport: 'lan', listDevices: async () => []};
  assert.equal((await createControlDispatcher({auth, companionVersion: 'test', objects})('status.get', {})).capabilities.objectsCreate, true);
  assert.equal((await createControlDispatcher({auth, companionVersion: 'test'})('status.get', {})).capabilities.objectsCreate, false);
});

test('two photos with the same name added at once are both kept', async t => {
  const {dispatch, objects} = await dispatcher();
  const {writeFile, mkdir, rm} = await import('node:fs/promises');
  const folder = await mkdtemp(join(tmpdir(), 'objects-race-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, n)]);
  for (const sub of ['a', 'b', 'c']) { await mkdir(join(folder, sub)); await writeFile(join(folder, sub, sub === 'b' ? 'Photo.JPG' : 'photo.jpg'), jpeg(sub.charCodeAt(0))); }
  const object = await objects.create('x');
  await Promise.all(['a', 'b', 'c'].map(sub => dispatch('objects.addFile', {id: object.id, kind: 'photos', path: join(folder, sub, sub === 'b' ? 'Photo.JPG' : 'photo.jpg')})));
  const photos = (await objects.get(object.id)).photos;
  // Unique even on a case-insensitive volume (Photo.jpg and photo.jpg are one file there).
  assert.equal(new Set(photos.map(name => name.toLowerCase())).size, 3);
  const {readFile: read} = await import('node:fs/promises');
  const contents = await Promise.all(photos.map(name => read(join(objects.dir(object.id), 'photos', name))));
  assert.equal(new Set(contents.map(bytes => bytes[10])).size, 3, 'no photo overwrote another');
});

test('a model dropped on its own needs photos or a request before it can start', async t => {
  const {dispatch} = await dispatcher();
  const {writeFile, rm} = await import('node:fs/promises');
  const folder = await mkdtemp(join(tmpdir(), 'objects-model-only-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  await writeFile(join(folder, 'part.stl'), Buffer.concat([Buffer.alloc(80), Buffer.from([1, 0, 0, 0]), Buffer.alloc(50)]));
  const {object} = await dispatch('objects.create', {});
  await dispatch('objects.addFile', {id: object.id, kind: 'scan', path: join(folder, 'part.stl')});
  await assert.rejects(dispatch('objects.start', {id: object.id}), error => error.code === 'conflict' && /Add photos of it, or describe/.test(error.message));
});
