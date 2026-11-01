import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {macReconstructRunner, progressWords, NEEDS_MACOS_27} from '../dist/objects/reconstruct.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function setup({reconstruct} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-handheld-'));
  const store = new ObjectStore(join(root, 'objects'));
  const touchups = [], builds = [], changes = [];
  const runTouchup = async input => {
    touchups.push(input);
    const passDir = join(root, 'pass-' + touchups.length), out = join(passDir, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    return {status: 'done', summary: 'Smoothed it.', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir, model: join(out, 'touched.stl')};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    onChange: object => changes.push(object),
    reconstruct: reconstruct ?? (async input => {
      builds.push(input);
      input.onProgress?.('Finding the object in your photos (1 of 2).');
      await writeFile(input.output, 'usdz');
    })});
  const object = await service.create();
  return {service, store, object, touchups, builds, changes, root};
}

test('a handheld scan is rebuilt on the Mac from its photos, then touched up like any scan', async () => {
  const {service, object, touchups, builds, changes} = await setup();
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  await service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b'));
  await service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b'));   // a resumed send
  assert.deepEqual((await service.get(object.id)).capture, ['0001.heic', '0002.heic']);

  const started = await service.start(object.id);   // no description needed: the scan says what it is
  assert.equal(started.state, 'touching-up');
  assert.equal(started.progress, 'Building the model from your photos.');
  const done = await service.settled(object.id);

  const dir = service.dir(object.id);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].photosDir, join(dir, 'capture'));
  assert.equal(builds[0].output, join(dir, 'scan', 'scan.usdz'));
  assert.deepEqual(touchups[0].scan, [join(dir, 'scan', 'scan.usdz')]);
  assert.deepEqual(touchups[0].photos, [join(dir, 'capture', '0001.heic'), join(dir, 'capture', '0002.heic')]);
  assert.equal(done.state, 'ready');
  assert.equal(done.scan, 'scan.usdz');
  assert.equal(done.progress, undefined);
  assert.ok(changes.some(o => o.progress === 'Finding the object in your photos (1 of 2).'), 'progress reaches the phone');
});

test('a Mac without macOS 27 says so plainly, and trying again rebuilds', async () => {
  let attempts = 0;
  const {service, object, touchups} = await setup({reconstruct: async input => {
    attempts += 1;
    if (attempts === 1) throw new Error(NEEDS_MACOS_27);
    await writeFile(input.output, 'usdz');
  }});
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  await service.start(object.id);
  const failed = await service.settled(object.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works.');
  assert.equal(failed.progress, undefined);
  assert.equal(touchups.length, 0);

  await service.start(object.id);
  assert.equal((await service.settled(object.id)).state, 'ready');
  assert.equal(attempts, 2);
});

test('handheld photos are only taken before the touch-up starts, and not next to a walk-around scan', async () => {
  const {service, object} = await setup();
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  await service.start(object.id);
  await service.settled(object.id);
  await assert.rejects(service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b')), InvalidStateError);

  const other = await service.create();
  await service.addScan(other.id, 'scan.usdz', Buffer.from('usdz'));
  await assert.rejects(service.addCapturePhoto(other.id, '0001.heic', Buffer.from('a')), InvalidStateError);
  await assert.rejects(service.addCapturePhoto(other.id, '../x.heic', Buffer.from('a')));
});

test('mac-reconstruct output becomes progress words and plain errors', async () => {
  assert.equal(progressWords({stage: 'downloading'}), 'Getting your Mac ready to build from photos. This happens once.');
  assert.equal(progressWords({stage: 'masking', done: 3, total: 90}), 'Finding the object in your photos (3 of 90).');
  assert.equal(progressWords({progress: 0.416}), 'Building the model from your photos (42%).');
  assert.equal(progressWords({skipped: 4}), undefined);

  const root = await mkdtemp(join(tmpdir(), 'mac-reconstruct-fake-'));
  const fake = async (name, body) => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const input = {photosDir: root, output: join(root, 'out.usdz'), masksDir: join(root, 'masks')};
  const seen = [];
  const ok = await fake('ok', `echo '{"stage":"masking","done":1,"total":2}'; echo 'noise'; echo '{"progress":0.5}'; echo '{"done":"/x.usdz"}'`);
  await macReconstructRunner(ok)({...input, onProgress: words => seen.push(words)});
  assert.deepEqual(seen, ['Finding the object in your photos (1 of 2).', 'Building the model from your photos (50%).']);

  const old = await fake('old', `echo '{"error":"needs-macos-27"}'; exit 3`);
  await assert.rejects(macReconstructRunner(old)(input), {message: NEEDS_MACOS_27});
  const broken = await fake('broken', `echo '{"error":"processError"}'; exit 1`);
  await assert.rejects(macReconstructRunner(broken)(input), /couldn't build a model/);
  await assert.rejects(macReconstructRunner(null)(input), /Reinstall Counterpart/);
  assert.ok((await readdir(root)).includes('ok'));
});
