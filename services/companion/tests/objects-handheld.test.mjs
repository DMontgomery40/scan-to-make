import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError, scanSummary, tooFewPhotos, SCANS_NEED_A_MAC, KEEP_SCAN_UNAVAILABLE, PREVIEW_ONLY} from '../dist/objects/service.js';
import {macReconstructArgs, macReconstructRunner, macScanToStl, linuxReconstructRunner, progressWords, NEEDS_MACOS_27, OBJECT_CAPTURE_NEEDS_MAC, RECONSTRUCTION_FAILED} from '../dist/objects/reconstruct.js';
import {tempDir} from './support/temp.mjs';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';
const manifest = images => ({version: 1, images, depthRequired: true});
/** What the phone sends with every image of an Object Capture session (MacConnection.sendCapture). */
const objectCaptureManifest = images => ({version: 1, images, depthRequired: false, source: 'object-capture'});
/** A walk-around's frames as the phone names them (ProjectUploader.captureFrames): NNNN in capture order. */
const APPLE = ['0001.heic', '0002.heic'];

/** `scanToStl` stands in for `mac-reconstruct stl` (a Mac); `scanToStl: null` is a computer without it. */
async function setup({reconstruct, scanToStl, deps = {}} = {}) {
  const root = await tempDir('objects-handheld-');
  const store = new ObjectStore(join(root, 'objects'));
  const touchups = [], builds = [], changes = [], converted = [];
  const runTouchup = async input => {
    touchups.push(input);
    const passDir = join(root, 'pass-' + touchups.length), out = join(passDir, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    return {status: 'done', summary: 'Smoothed it.', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir, model: join(out, 'touched.stl')};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    onChange: object => changes.push(object), ...deps,
    ...(scanToStl === null ? {} : {objectCaptureRebuild: true, scanToStl: scanToStl ?? (async (scan, stl, {render, removeSupport} = {}) => {
      converted.push({scan, bytes: await readFile(scan, 'utf8'), ...(removeSupport ? {removeSupport} : {})});
      await writeFile(stl, STL);
      if (render) await writeFile(render, 'png');
      return removeSupport ? {supportRemoved: true} : undefined;
    })}),
    reconstruct: reconstruct ?? (async input => {
      builds.push(input);
      input.onProgress?.('Finding the object in your photos (1 of 2).');
      await writeFile(input.output, 'usdz');
      return input.objectCapture ? {status: 'done', inputs: {images: 2, depth: 2}} : {status: 'done'};
    })});
  const object = await service.create();
  return {service, store, object, touchups, builds, changes, converted, root};
}

/** A walk-around as the phone sends it: the image list declared first, every image, then its own model as the preview. */
async function sendWalkAround(service, id, names = APPLE) {
  await service.declareCapture(id, objectCaptureManifest(names));
  for (const name of names) await service.addCapturePhoto(id, name, Buffer.from(name));
  await service.addScan(id, 'scan.usdz', Buffer.from('phone preview'), {preview: true});
}

test('a handheld scan is rebuilt on the Mac from its photos, and kept as the model until a touch-up is asked for', async () => {
  // Changed with PRD §5.3 (Nov 8): this used to start the touch-up by itself after the rebuild.
  const {service, object, touchups, builds, changes, converted} = await setup();
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  await service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b'));
  await service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b'));   // a resumed send
  assert.deepEqual((await service.get(object.id)).capture, ['0001.heic', '0002.heic']);

  const started = await service.start(object.id);   // no description needed: the scan says what it is
  assert.equal(started.state, 'touching-up');
  assert.equal(started.progress, 'Building the model from your photos.');
  assert.equal(started.passes[0].estimate.remainingSec, 310, 'about 5 min to build and a moment to save: no touch-up time');
  const done = await service.settled(object.id);

  const dir = service.dir(object.id);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].photosDir, join(dir, 'capture'));
  assert.equal(builds[0].output, join(dir, 'scan', 'scan.usdz'));
  assert.equal(builds[0].objectCapture, undefined, 'a handheld capture keeps its own (samples) rebuild');
  assert.equal(touchups.length, 0, 'nothing was asked for, so nothing is touched up');
  assert.deepEqual(converted.map(item => item.scan), [join(dir, 'scan', 'scan.usdz')]);
  assert.equal(done.state, 'ready');
  assert.equal(done.scan, 'scan.usdz');
  assert.equal(done.current.model, join('current', 'model.stl'));
  assert.equal(await readFile(join(dir, 'current', 'model.stl'), 'utf8'), STL);
  assert.match(done.current.summary, /^Rebuilt on your Mac from all 2 photos at full detail\. Nothing has been touched up yet\./);
  assert.deepEqual(done.passes[0].stages.map(stage => stage.id), ['building', 'saving']);
  assert.equal(done.progress, undefined);
  assert.ok(changes.some(o => o.progress === 'Finding the object in your photos (1 of 2).'), 'progress reaches the phone');

  // Asking for changes is what starts a touch-up: it works on that model, with the capture's photos.
  await service.correct(object.id, 'Smooth the top');
  const touched = await service.settled(object.id);
  assert.equal(touchups.length, 1);
  assert.deepEqual(touchups[0].scan, [join(dir, 'current', 'model.stl')]);
  assert.deepEqual(touchups[0].photos, [join(dir, 'capture', '0001.heic'), join(dir, 'capture', '0002.heic')]);
  assert.equal(builds.length, 1, 'a change never rebuilds');
  assert.equal(touched.state, 'ready');
});

test('a computer that cannot keep a scan as a model never touches it up unasked; it says so instead (Linux)', async () => {
  const {service, object, touchups, builds} = await setup({scanToStl: null});
  assert.equal(service.objectCaptureImages, false, 'the phone is told not to send an Object Capture session here');
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  await assert.rejects(service.start(object.id), {message: KEEP_SCAN_UNAVAILABLE});
  assert.equal((await service.get(object.id)).state, 'new');
  assert.deepEqual([touchups.length, builds.length], [0, 0], 'no AI and no rebuild started');

  // The phone's preview from an older send, and an iPhone walk-around: the design's Linux gate, in words.
  const preview = await service.create();
  await service.addScan(preview.id, 'scan.usdz', Buffer.from('phone model'), {preview: true});
  await service.addPhoto(preview.id, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0]));
  await assert.rejects(service.start(preview.id), {message: SCANS_NEED_A_MAC});
  const walk = await service.create();
  await assert.rejects(service.declareCapture(walk.id, objectCaptureManifest(APPLE)), {message: SCANS_NEED_A_MAC});
  await service.addCapturePhoto(walk.id, '0001.heic', Buffer.from('a'));
  await assert.rejects(service.start(walk.id, objectCaptureManifest(['0001.heic'])), {message: SCANS_NEED_A_MAC});
  assert.equal(touchups.length, 0);

  // An STL needs no conversion: it is kept as it came. And a request is asking: that touch-up runs.
  const stl = await service.create();
  await service.addScan(stl.id, 'scan.stl', Buffer.from(STL));
  await service.addPhoto(stl.id, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0]));
  await service.start(stl.id);
  assert.equal((await service.settled(stl.id)).state, 'ready');
  assert.equal(touchups.length, 0);
  const asked = await service.create();
  await service.updateInstructions(asked.id, 'Copy this, but close the bottom.');
  await service.addCapturePhoto(asked.id, '0001.heic', Buffer.from('a'));
  const started = await service.start(asked.id);
  assert.equal(started.passes[0].estimate.remainingSec, 630, 'build, then the touch-up that was asked for');
  await service.settled(asked.id);
  assert.equal(touchups.length, 1);
});

test('with AI off, a scan kept as it is still rebuilds and becomes the model; only a request needs AI', async () => {
  const off = {modelAccess: {projectWorker() { throw new Error('AI is off. Choose an AI provider in Settings before starting a model job.'); }}, requireModelAccess: true};
  const {service, object, touchups} = await setup({deps: off});
  await sendWalkAround(service, object.id);
  await service.start(object.id, objectCaptureManifest(APPLE));
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.scanSource, 'mac');
  assert.equal(touchups.length, 0);

  const asked = await service.create();
  await service.updateInstructions(asked.id, 'Copy this.');
  await sendWalkAround(service, asked.id);
  await assert.rejects(service.start(asked.id, objectCaptureManifest(APPLE)), /AI is off/);
  assert.equal((await service.get(asked.id)).state, 'new');
});

test('a declared walk-around never starts on part of its images, from any client', async () => {
  const {service, object, builds, touchups} = await setup();
  await service.declareCapture(object.id, objectCaptureManifest(APPLE));
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('a'));
  // Another client (the Mac app, the control socket) presses Start mid-send: no handheld rebuild of the prefix.
  await assert.rejects(service.start(object.id), InvalidStateError);
  await assert.rejects(service.start(object.id, {version: 1, images: ['0001.heic'], depthRequired: false}), InvalidStateError);
  await assert.rejects(service.addCapturePhoto(object.id, '0009.heic', Buffer.from('x')), /isn't part of this scan/);
  assert.deepEqual([builds.length, touchups.length], [0, 0]);
  // A resumed send declares the same list again and finishes.
  await service.declareCapture(object.id, objectCaptureManifest(APPLE));
  await service.addCapturePhoto(object.id, '0002.heic', Buffer.from('b'));
  await service.addScan(object.id, 'scan.usdz', Buffer.from('phone preview'), {preview: true});
  await assert.rejects(service.start(object.id, objectCaptureManifest(['0001.heic'])), InvalidStateError);
  const started = await service.start(object.id, objectCaptureManifest(APPLE));
  assert.equal(started.captureDeclared, undefined);
  // The start went through but its reply was lost: the phone's resumed send declares again, harmlessly.
  assert.equal((await service.declareCapture(object.id, objectCaptureManifest(APPLE))).captureDeclared, undefined);
  await assert.rejects(service.declareCapture(object.id, objectCaptureManifest(['0001.heic'])), InvalidStateError);
  await service.settled(object.id);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].objectCapture, true, 'Apple folder mode, never the handheld samples path');
});

test("the phone's preview from a send without every photo is kept as a preview, and says the full rebuild wasn't available", async () => {
  const {service, object, builds, touchups} = await setup();
  await service.addScan(object.id, 'scan.usdz', Buffer.from('phone model'), {preview: true});
  await service.addPhoto(object.id, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0]));
  assert.equal((await service.get(object.id)).scanSource, 'phone-preview');
  await service.start(object.id);
  const done = await service.settled(object.id);
  assert.deepEqual([builds.length, touchups.length], [0, 0]);
  assert.equal(done.state, 'ready');
  assert.equal(done.current.summary, `${PREVIEW_ONLY} Nothing has been touched up yet. Ask for changes to clean it up.`);
});

test('a walk-around sends every Object Capture image; the Mac rebuilds them at full detail and the phone model stays a preview', async () => {
  const {service, object, touchups, builds, converted} = await setup();
  assert.equal(service.objectCaptureImages, true);
  await sendWalkAround(service, object.id);
  // Exactly {version, images, depthRequired: false, source}: no depth sidecars, camera file or qualification step.
  await assert.rejects(service.start(object.id, {...objectCaptureManifest(APPLE), depthRequired: true}), /capture/i);
  await assert.rejects(service.start(object.id, {...objectCaptureManifest(APPLE), cameraMetadataRequired: true}), /capture/i);
  await assert.rejects(service.start(object.id, {...objectCaptureManifest(APPLE), scaleQualificationRequired: false}), /capture/i);
  await assert.rejects(service.start(object.id, {...objectCaptureManifest(APPLE), source: 'turntable'}), /capture/i);
  await assert.rejects(service.start(object.id, objectCaptureManifest([...APPLE, '0003.heic'])), InvalidStateError);
  // Apple's own names never reach the Mac: the phone numbers them, and the Mac takes NNNN only, whatever the source.
  const named = await service.create();
  await service.addCapturePhoto(named.id, '00041.732011084.HEIC', Buffer.from('a'));
  await assert.rejects(service.start(named.id, objectCaptureManifest(['00041.732011084.HEIC'])), /capture/i);

  const started = await service.start(object.id, objectCaptureManifest(APPLE));
  assert.equal(started.state, 'touching-up');
  assert.equal(started.scanSource, 'phone-preview');
  assert.equal(started.captureCompletion.source, 'object-capture');
  assert.equal(started.passes[0].stages[0].id, 'building');
  assert.equal(started.passes[0].estimate.remainingSec, 310);
  const done = await service.settled(object.id);

  const dir = service.dir(object.id);
  assert.equal(builds.length, 1);
  assert.equal(builds[0].objectCapture, true);
  assert.equal(builds[0].photosDir, join(dir, 'capture'));
  assert.match(builds[0].output, /scan\/rebuilding-[0-9a-f-]+\.usdz$/, 'the rebuild never writes over the preview while it runs');
  assert.equal(touchups.length, 0);
  assert.equal(done.state, 'ready');
  assert.equal(done.scan, 'scan.usdz');
  assert.equal(done.scanSource, 'mac');
  assert.equal(await readFile(join(dir, 'scan', 'scan.usdz'), 'utf8'), 'usdz', 'the scan is the Mac rebuild');
  assert.equal(await readFile(join(dir, 'scan', 'phone-preview.usdz'), 'utf8'), 'phone preview', 'the phone preview is kept');
  assert.deepEqual((await readdir(join(dir, 'scan'))).filter(name => name.startsWith('rebuilding-')), []);
  assert.deepEqual(converted, [{scan: join(dir, 'scan', 'scan.usdz'), bytes: 'usdz', removeSupport: true}],
    'the model is the rebuild, not the preview, with whatever it stood on cut away');
  assert.equal(done.current.summary, 'Rebuilt on your Mac from all 2 photos at full detail. 2 photos are few, so expect gaps; more photos, including some from above, help. Its size comes from the LiDAR depth in every photo. The surface it stood on was removed. Nothing has been touched up yet. Ask for changes to clean it up.');
  assert.deepEqual(done.current.renders, [join('current', 'renders', 'overview.png')], 'every layout gets a picture of the model');
  assert.equal(await readFile(join(dir, 'current', 'renders', 'overview.png'), 'utf8'), 'png');
  assert.deepEqual(done.passes[0].stages.map(stage => stage.id), ['building', 'saving']);

  // Starting again with the same session changes nothing; it is not rebuilt twice.
  assert.equal((await service.start(object.id, objectCaptureManifest(APPLE))).state, 'ready');
  assert.equal(builds.length, 1);
});

test('a walk-around whose rebuild fails keeps the phone preview and says so; a request still gets its touch-up', async () => {
  const {service, object, touchups, converted} = await setup({reconstruct: async () => { throw new Error(RECONSTRUCTION_FAILED); }});
  await sendWalkAround(service, object.id);
  await service.start(object.id, objectCaptureManifest(APPLE));
  const done = await service.settled(object.id);
  const dir = service.dir(object.id);
  assert.equal(done.state, 'ready', 'a failed rebuild is not a failed project: the preview is still a model');
  assert.equal(done.scanSource, 'phone-preview');
  assert.deepEqual(converted, [{scan: join(dir, 'scan', 'scan.usdz'), bytes: 'phone preview', removeSupport: true}]);
  assert.equal(done.current.summary, "Your Mac couldn't rebuild this from the photos, so this is your phone's quick preview. Scan it again to retry the full rebuild. The surface it stood on was removed. Nothing has been touched up yet. Ask for changes to clean it up.");
  assert.deepEqual((await readdir(join(dir, 'scan'))).sort(), ['scan.usdz']);
  assert.equal(touchups.length, 0);

  // With a request, the person asked for the touch-up: it runs on the rebuild (here the preview, said in words above).
  const asked = await setup({reconstruct: async () => { throw new Error("Counterpart's model builder is missing on this Mac. Reinstall Counterpart."); }});
  await asked.service.updateInstructions(asked.object.id, 'Copy this, but close the bottom.');
  await sendWalkAround(asked.service, asked.object.id);
  const askedStart = await asked.service.start(asked.object.id, objectCaptureManifest(APPLE));
  assert.equal(askedStart.passes[0].estimate.remainingSec, 630, 'build, then the touch-up that was asked for');
  const touched = await asked.service.settled(asked.object.id);
  assert.equal(asked.touchups.length, 1);
  assert.deepEqual(touched.passes[0].activity.map(entry => entry.text), [
    "Your Mac couldn't rebuild this from the photos, so this is your phone's quick preview. Counterpart's model builder is missing on this Mac. Reinstall Counterpart. Scan it again to retry the full rebuild."],
    'the touch-up says it started from the preview');
  assert.deepEqual(asked.touchups[0].scan, [join(asked.service.dir(asked.object.id), 'scan', 'scan.usdz')]);
  assert.equal(touched.state, 'ready');
});

test('a walk-around whose rebuild failed retries it when started again, while its model is still the preview', async () => {
  let attempts = 0;
  const {service, object, touchups} = await setup({reconstruct: async input => {
    attempts += 1;
    if (attempts === 1) throw new Error(RECONSTRUCTION_FAILED);
    await writeFile(input.output, 'usdz');
    return {status: 'done', inputs: {images: 2, depth: 2}};
  }});
  await sendWalkAround(service, object.id);
  await service.start(object.id, objectCaptureManifest(APPLE));
  const preview = await service.settled(object.id);
  assert.equal(preview.state, 'ready');
  assert.equal(preview.scanSource, 'phone-preview');
  // The same manifest again is a resent start: nothing new. A start with no note retries the rebuild.
  assert.equal((await service.start(object.id, objectCaptureManifest(APPLE))).state, 'ready');
  assert.equal(attempts, 1);
  await service.start(object.id);
  const rebuilt = await service.settled(object.id);
  assert.equal(attempts, 2);
  assert.equal(rebuilt.scanSource, 'mac');
  assert.match(rebuilt.current.summary, /^Rebuilt on your Mac from all 2 photos/);
  assert.equal(touchups.length, 0);
  // Once rebuilt, it is a model like any other: starting again changes nothing.
  await assert.rejects(service.start(object.id), InvalidStateError);
});

test('a cancelled walk-around rebuild is not turned into the preview', async () => {
  let aborted, building;
  const started = new Promise(resolve => { building = resolve; });
  const {service, object, touchups, converted} = await setup({reconstruct: async input => {
    await writeFile(input.output, 'half-written');   // Apple's session had started writing when it was cancelled
    return new Promise((_, reject) => {
      const stop = () => { aborted = true; reject(Object.assign(new Error('The operation was aborted'), {name: 'AbortError'})); };
      if (input.signal.aborted) stop(); else input.signal.addEventListener('abort', stop);
      building();
    });
  }});
  await sendWalkAround(service, object.id);
  await service.start(object.id, objectCaptureManifest(APPLE));
  await started;
  await service.close();
  const stopped = await service.get(object.id);
  assert.equal(aborted, true);
  assert.equal(stopped.state, 'failed');
  assert.equal(stopped.current, undefined);
  assert.equal(stopped.scanSource, 'phone-preview');
  assert.deepEqual(converted, []);
  assert.equal(touchups.length, 0);
  assert.deepEqual((await readdir(join(service.dir(object.id), 'scan'))).sort(), ['scan.usdz']);
});

test('a walk-around without a request on an older phone (model and photos, no session) is kept as it came', async () => {
  const {service, object, touchups, builds, converted} = await setup();
  await service.addScan(object.id, 'scan.usdz', Buffer.from('phone model'));
  await service.addPhoto(object.id, 'a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0]));
  await service.start(object.id);
  const done = await service.settled(object.id);
  assert.equal(builds.length, 0);
  assert.equal(touchups.length, 0);
  assert.equal(converted.length, 1);
  assert.equal(done.state, 'ready');
  assert.equal(done.current.summary, 'This is the scan as it came. Nothing has been touched up yet. Ask for changes to clean it up.');
  assert.deepEqual(done.passes[0].stages.map(stage => stage.id), ['saving']);
});

test("the companion rebuilds an Object Capture session from Apple's images folder, reads its depth count, and makes STLs", async t => {
  assert.deepEqual(macReconstructArgs({photosDir: '/p', output: '/o.usdz', masksDir: '/m', objectCapture: true}), ['/p', '/o.usdz', 'full']);
  assert.deepEqual(macReconstructArgs({photosDir: '/p', output: '/o.usdz', masksDir: '/m'}), ['samples', '/p', '/o.usdz', 'full', '--save-masks', '/m']);
  await assert.rejects(linuxReconstructRunner('/bin/true')({photosDir: '/p', output: '/o', masksDir: '/m', objectCapture: true}), {message: OBJECT_CAPTURE_NEEDS_MAC});

  const root = await tempDir('mac-reconstruct-folder-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const fake = async (name, body) => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const argv = join(root, 'argv');
  const folder = await fake('folder', `echo "$@" > '${argv}'; echo '{"images":59,"depth":58,"stage":"reconstructing"}'; echo '{"progress":0.5}'; echo '{"skipped":3,"reason":"not used"}'; echo '{"skipped":3,"reason":"x"}'; echo '{"skipped":7,"reason":"not used"}'; echo '{"warning":"stitching-incomplete"}'; echo '{"done":"/x.usdz"}'`);
  const seen = [];
  const outcome = await macReconstructRunner(folder)({photosDir: '/in', output: '/out.usdz', masksDir: '/m', objectCapture: true, onProgress: words => seen.push(words)});
  assert.equal((await readFile(argv, 'utf8')).trim(), '/in /out.usdz full');
  assert.deepEqual(outcome, {status: 'done', inputs: {images: 59, depth: 58, skipped: 2, stitchingIncomplete: true}});
  assert.equal(scanSummary({scan: 'scan.usdz', inputs: outcome.inputs}),
    "Rebuilt on your Mac from 57 of your 59 photos at full detail. Apple couldn't place the other 2, so more overlapping photos, including some from above, would help. Its size comes from the LiDAR depth in 58 of them. Apple couldn't join every photo together, so check every side. Nothing has been touched up yet. Ask for changes to clean it up.");
  assert.equal(scanSummary({scan: 'scan.usdz', inputs: {images: 72, depth: 72}}, 'mac', true),
    'Rebuilt on your Mac from all 72 photos at full detail. Its size comes from the LiDAR depth in every photo. The surface it stood on was removed. Nothing has been touched up yet. Ask for changes to clean it up.');
  assert.match(scanSummary({scan: 'scan.usdz', inputs: {images: 3, depth: 0}}), /These photos carry no depth, so its size isn't measured/);
  assert.deepEqual(seen, ['Building the model from your photos.', 'Building the model from your photos (50%).']);

  const stl = await fake('stl', `echo "$@" > '${argv}'; echo '{"done":"'$3'","triangles":12}'`);
  await macScanToStl(stl)('/scan.usdz', '/model.stl');
  assert.equal((await readFile(argv, 'utf8')).trim(), 'stl /scan.usdz /model.stl');
  assert.deepEqual(await macScanToStl(stl)('/scan.usdz', '/model.stl', {render: '/overview.png'}), {supportRemoved: false});
  assert.equal((await readFile(argv, 'utf8')).trim(), 'stl /scan.usdz /model.stl --render /overview.png');
  const cut = await fake('stl-cut', `echo "$@" > '${argv}'; echo '{"done":"'$3'","triangles":12,"support":{"tiltDegrees":4.9}}'`);
  assert.deepEqual(await macScanToStl(cut)('/scan.usdz', '/model.stl', {removeSupport: true}), {supportRemoved: true});
  assert.equal((await readFile(argv, 'utf8')).trim(), 'stl /scan.usdz /model.stl --remove-support');
  const broken = await fake('broken-stl', `echo '{"error":"no triangles"}'; echo 'PRIVATE ModelIO detail' >&2; exit 1`);
  await assert.rejects(macScanToStl(broken)(join(root, 'scan.usdz'), join(root, 'out', 'model.stl')), {message: "Your Mac couldn't turn this scan into a printable model."});
  const kept = await readFile(join(root, 'out', '.reconstruction-diagnostics', 'last-failure.log'), 'utf8');
  assert.match(kept, /"error":"no triangles"/);
  assert.match(kept, /PRIVATE ModelIO detail/, 'stderr is kept privately, like the rebuild');
  assert.equal(macScanToStl(null), undefined);
});

test('a stopped scan sent as photos alone is rebuilt on the Mac, and too few photos are said plainly', async () => {
  // David, Nov 9: the unicorn's scan was stopped with 9 photos and no phone model. Send to your Mac sends the photos.
  let fail = true;
  const {service, object, converted} = await setup({reconstruct: async input => {
    if (fail) throw new Error(RECONSTRUCTION_FAILED);
    await writeFile(input.output, 'usdz');
    return {status: 'done', inputs: {images: 2, depth: 2}};
  }});
  await service.declareCapture(object.id, objectCaptureManifest(APPLE));
  for (const name of APPLE) await service.addCapturePhoto(object.id, name, Buffer.from(name));
  assert.equal((await service.get(object.id)).scan, undefined, 'no phone model came with it');
  await service.start(object.id, objectCaptureManifest(APPLE));
  const failed = await service.settled(object.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, tooFewPhotos(2));
  assert.match(failed.failure, /^Your Mac couldn't build a model from these 2 photos\. That's too few/);
  fail = false;
  await service.start(object.id, objectCaptureManifest(APPLE));
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.scanSource, 'mac');
  assert.equal(converted.at(-1).removeSupport, true);
  assert.match(done.current.summary, /2 photos are few, so expect gaps; more photos, including some from above, help\./);
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
  // A close-up question comes from a touch-up, which runs when the person asks for one (PRD §5.3).
  await service.updateInstructions(object.id, 'Copy this.');
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

test('mac-reconstruct output becomes progress words and plain errors', async t => {
  assert.equal(progressWords({stage: 'downloading'}), 'Getting your Mac ready to build from photos. This happens once.');
  assert.equal(progressWords({stage: 'masking', done: 3, total: 90}), 'Finding the object in your photos (3 of 90).');
  assert.equal(progressWords({progress: 0.416}), 'Building the model from your photos (42%).');
  assert.equal(progressWords({skipped: 4}), undefined);

  const root = await tempDir('mac-reconstruct-fake-');
  t.after(() => rm(root, {recursive: true, force: true}));
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


async function diagnosticFixture(t, script) {
  const root = await tempDir('reconstruct-diagnostic-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const binary = join(root, 'helper');
  await writeFile(binary, `#!${process.execPath}\n${script}\n`, {mode: 0o755});
  const input = {photosDir: root, output: join(root, 'scan', 'out.usdz'), masksDir: join(root, 'masks')};
  const directory = join(root, 'scan', '.reconstruction-diagnostics');
  return {root, binary, input, directory, log: join(directory, 'last-failure.log')};
}

test('failed reconstruction retains only a private bounded stderr tail across retries', async t => {
  const f = await diagnosticFixture(t, `process.stderr.write('PRIVATE-START' + 'x'.repeat(100000) + 'PRIVATE-END');
    console.log(JSON.stringify({error: 'private helper reason'})); process.exitCode = 1;`);
  const progress = [];
  await assert.rejects(macReconstructRunner(f.binary)({...f.input, onProgress: words => progress.push(words)}), {message: RECONSTRUCTION_FAILED});
  const content = await readFile(f.log);
  const split = content.indexOf(10);
  const header = JSON.parse(content.subarray(0, split));
  assert.equal(header.exitCode, 1);
  assert.equal(header.stderrTruncated, true);
  assert.equal(header.error, 'private helper reason');
  assert.ok(Number.isFinite(Date.parse(header.recordedAt)));
  assert.equal(content.length - split - 1, 64 * 1024);
  assert.ok(content.length < 66 * 1024);
  assert.ok(content.toString().endsWith('PRIVATE-END'));
  assert.equal(content.includes('PRIVATE-START'), false);
  assert.deepEqual(progress, []);
  assert.equal((await stat(f.log)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);

  await writeFile(join(f.directory, 'unrelated.log'), 'keep this');
  await writeFile(f.binary, `#!${process.execPath}\nprocess.stderr.write('SECOND-FAILURE'); process.exitCode = 2;\n`, {mode: 0o755});
  await assert.rejects(macReconstructRunner(f.binary)(f.input), {message: RECONSTRUCTION_FAILED});
  const retry = await readFile(f.log, 'utf8');
  assert.ok(retry.endsWith('SECOND-FAILURE'));
  assert.equal(retry.includes('PRIVATE-END'), false);
  assert.equal((await stat(f.log)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(f.directory)).sort(), ['last-failure.log', 'unrelated.log']);
  assert.equal(await readFile(join(f.directory, 'unrelated.log'), 'utf8'), 'keep this');
});

test('healthy reconstruction neither creates a warning nor replaces an earlier failure diagnostic', async t => {
  const f = await diagnosticFixture(t, `process.stderr.write('informational helper output'); console.log(JSON.stringify({done: '/out.usdz'}));`);
  await macReconstructRunner(f.binary)(f.input);
  await assert.rejects(stat(f.directory), {code: 'ENOENT'});
  await mkdir(f.directory, {recursive: true, mode: 0o700});
  await writeFile(f.log, 'previous timestamped failure', {mode: 0o600});
  await macReconstructRunner(f.binary)(f.input);
  assert.equal(await readFile(f.log, 'utf8'), 'previous timestamped failure');
});

test('diagnostic storage failure cannot redirect a write or leak helper text into the public error', async t => {
  const f = await diagnosticFixture(t, `process.stderr.write('PRIVATE-ERROR'); process.exitCode = 1;`);
  const outside = join(f.root, 'unrelated');
  await mkdir(outside);
  await mkdir(join(f.root, 'scan'));
  await writeFile(join(outside, 'last-failure.log'), 'must stay unchanged');
  await symlink(outside, f.directory);
  await assert.rejects(macReconstructRunner(f.binary)(f.input), {message: RECONSTRUCTION_FAILED});
  assert.deepEqual(await readdir(outside), ['last-failure.log']);
  assert.equal(await readFile(join(outside, 'last-failure.log'), 'utf8'), 'must stay unchanged');
});
