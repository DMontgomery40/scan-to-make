import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {macReconstructRunner, progressWords, NEEDS_MACOS_27} from '../dist/objects/reconstruct.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';
const manifest = images => ({version: 1, images, depthRequired: true});

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

test('exact depth uploads survive retries and an incomplete RGB-depth pair cannot start', async () => {
  const {service, object, builds} = await setup();
  const depth = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0, 255, 1, 7, 0])]);
  await service.addCaptureDepth(object.id, '0000.depth.plist', depth);
  await assert.rejects(service.start(object.id), /missing camera or depth files/);
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await service.addCaptureDepth(object.id, '0000.depth.plist', depth);
  const retained = await service.get(object.id);
  assert.deepEqual(retained.captureDepth, ['0000.depth.plist']);
  assert.deepEqual(retained.capture, ['0000.heic']);
  assert.deepEqual(await readFile(join(service.dir(object.id), 'capture', '0000.depth.plist')), depth);
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('rgb2'));
  await assert.rejects(service.start(object.id), /missing camera or depth files/);
  assert.equal(builds.length, 0);
  await service.addCaptureDepth(object.id, '0001.depth.plist', depth);
  await service.start(object.id, manifest(['0000.heic', '0001.heic']));
  assert.equal((await service.settled(object.id)).state, 'ready');
  await assert.rejects(service.addCaptureDepth(object.id, '0002.depth.plist', depth), InvalidStateError);
});

test('depth sidecars have a narrow name and container contract', async () => {
  const {service, object} = await setup();
  await assert.rejects(service.addCaptureDepth(object.id, '../0000.depth.plist', Buffer.from('bplist00')), /Invalid file name/);
  await assert.rejects(service.addCaptureDepth(object.id, '0000.heic', Buffer.from('bplist00')), /Invalid file name/);
  await assert.rejects(service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('not-plist')), /Invalid file name/);
});

test('reconstruction waits for an admitted RGB upload to finish committing its pair', async () => {
  const {service, store, object, builds} = await setup();
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  const writing = Promise.withResolvers(), release = Promise.withResolvers();
  const addFile = store.addFile.bind(store);
  store.addFile = async (...args) => {
    writing.resolve();
    await release.promise;
    return addFile(...args);
  };
  const upload = service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await writing.promise;
  const started = service.start(object.id, manifest(['0000.heic']));
  // Attach rejection handling before releasing the write: the unguarded upload failed here.
  const result = Promise.all([upload, started]);
  release.resolve();
  await result;
  assert.equal((await service.settled(object.id)).state, 'ready');
  assert.equal(builds.length, 1);
});

test('a complete-pair prefix stays uploadable until its source commits the full finished manifest', async () => {
  const {service, object, builds, store} = await setup();
  const depth = Buffer.from('bplist00');
  await service.addCaptureDepth(object.id, '0000.depth.plist', depth);
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb0'));
  await assert.rejects(service.start(object.id), /completed file list/);
  await assert.rejects(service.start(object.id, manifest(['0000.heic', '0001.heic'])), /missing camera or depth/);
  assert.equal((await service.get(object.id)).state, 'new');
  assert.equal((await service.get(object.id)).captureCompletion, undefined);
  assert.equal(builds.length, 0);
  await service.addCaptureDepth(object.id, '0001.depth.plist', depth);
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('rgb1'));
  const full = manifest(['0000.heic', '0001.heic']);
  await service.start(object.id, full);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.captureCompletion.frameCount, 2);
  assert.match(done.captureCompletion.sha256, /^[a-f0-9]{64}$/);
  assert.equal(done.captureCompletion.images, undefined, 'the stored marker does not duplicate image names');
  assert.equal((await new ObjectStore(join(service.dir(object.id), '..')).get(object.id)).captureCompletion.sha256, done.captureCompletion.sha256);
  assert.equal((await service.start(object.id, full)).state, 'ready', 'lost start responses are idempotent');
  assert.equal(builds.length, 1);
  await store.update(object.id, o => ({...o, state: 'needs-closeup'}));
  await service.addPhoto(object.id, 'detail.jpg', Buffer.from('closeup'));
  assert.deepEqual((await service.get(object.id)).captureCompletion, done.captureCompletion, 'ordinary close-ups do not invalidate capture completion');
});

test('a repeated completion manifest preserves the close-up question until it is explicitly answered', async () => {
  const {service, object, store, touchups} = await setup();
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  const full = manifest(['0000.heic']);
  await service.start(object.id, full);
  await service.settled(object.id);
  const question = {closeup: 'Show the underside.'};
  await store.update(object.id, o => ({...o, state: 'needs-closeup', question}));
  const before = await service.get(object.id);
  const retried = await service.start(object.id, full);
  assert.equal(retried.state, 'needs-closeup');
  assert.deepEqual(retried.question, question);
  assert.equal(retried.passes.length, before.passes.length);
  assert.equal(touchups.length, 1);
  const answered = await service.answerCloseup(object.id, {bestGuess: true});
  assert.equal(answered.state, 'touching-up');
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.question, undefined);
  assert.equal(done.passes.length, before.passes.length + 1);
  assert.equal(touchups.length, 2);
});

test('pending depth completion cannot be bypassed by failed retry, correction or close-up paths', async () => {
  const {service, object, store, builds, touchups} = await setup();
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await store.update(object.id, o => ({...o, state: 'failed'}));
  await assert.rejects(service.start(object.id), /completed file list/);
  await assert.rejects(service.correct(object.id, 'Use the saved scan.'), /completed file list/);
  await store.update(object.id, o => ({...o, state: 'needs-closeup', question: {closeup: 'Closer.'}}));
  await assert.rejects(service.start(object.id), /completed file list/);
  await assert.rejects(service.answerCloseup(object.id, {bestGuess: true}), /completed file list/);
  assert.equal(builds.length, 0);
  assert.equal(touchups.length, 0);
  assert.equal((await service.get(object.id)).passes.length, 0);
});

test('committed depth completion survives failed reconstruction and an empty-body retry', async () => {
  let attempts = 0;
  const {service, object, store} = await setup({reconstruct: async input => {
    if (++attempts === 1) throw new Error('temporary reconstruction failure');
    await writeFile(input.output, 'usdz');
  }});
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await service.start(object.id, manifest(['0000.heic']));
  const failed = await service.settled(object.id);
  assert.equal(failed.state, 'failed');
  await store.recoverInterrupted();
  await service.start(object.id);
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.deepEqual(done.captureCompletion, failed.captureCompletion);
  assert.equal(attempts, 2);
});

test('capture completion rejects missing or empty retained files and false depth declarations', async () => {
  const {service, object} = await setup();
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.alloc(0));
  const full = manifest(['0000.heic']);
  await assert.rejects(service.start(object.id, full), /missing camera or depth/);
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await assert.rejects(service.start(object.id, {...full, depthRequired: false}), /missing camera or depth/);
  await rm(join(service.dir(object.id), 'capture', '0000.depth.plist'));
  await assert.rejects(service.start(object.id, full), /missing camera or depth/);
  assert.equal((await service.get(object.id)).captureCompletion, undefined);
});

test('capture writes invalidate a persisted marker and optional image-only manifests still validate their exact set', async () => {
  const {service, object, store} = await setup();
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('rgb'));
  await assert.rejects(service.start(object.id, {version: 1, images: ['0000.heic', '0001.heic'], depthRequired: false}), /missing camera or depth/);
  await service.start(object.id, {version: 1, images: ['0000.heic'], depthRequired: false});
  await service.settled(object.id);
  assert.equal((await service.get(object.id)).captureCompletion.depthRequired, false);
  // Simulate a recovered draft with a previously persisted completion marker.
  await store.update(object.id, o => ({...o, state: 'new', scan: undefined}));
  await service.addCapturePhoto(object.id, '0000.heic', Buffer.from('resent'));
  assert.equal((await service.get(object.id)).captureCompletion, undefined);
  await store.update(object.id, o => ({...o, captureCompletion: {version: 1, depthRequired: false, frameCount: 1, sha256: 'old', completedAtMs: 1}}));
  await service.addCaptureDepth(object.id, '0000.depth.plist', Buffer.from('bplist00'));
  assert.equal((await service.get(object.id)).captureCompletion, undefined);
  await assert.rejects(service.start(object.id), /completed file list/);
  await store.update(object.id, o => ({...o, captureCompletion: {version: 1, depthRequired: true, frameCount: 1, sha256: 'old', completedAtMs: 1}}));
  store.addFile = async () => { throw new Error('disk write interrupted'); };
  await assert.rejects(service.addCapturePhoto(object.id, '0000.heic', Buffer.from('retry')), /disk write interrupted/);
  assert.equal((await service.get(object.id)).captureCompletion, undefined, 'failed overwrites invalidate completion before touching existing bytes');
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
