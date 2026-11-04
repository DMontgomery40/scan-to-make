import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chmod, mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {linuxReconstructRunner, parseRegionOutcome, parseScaleOutcome} from '../dist/objects/reconstruct.js';
import {validateCaptureCamera, InvalidCaptureCameraError} from '../dist/objects/capture-camera.js';

const STL = 'solid m\nendsolid m\n';
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);

function jpeg(width, height, filler) {
  const sof = Buffer.alloc(2 + 1 + 2 + 2 + 1 + 9);
  sof.writeUInt16BE(17, 0); sof[2] = 8; sof.writeUInt16BE(height, 3); sof.writeUInt16BE(width, 5); sof[7] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9]), Buffer.alloc(8, filler)]);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function regionOutcome(input) {
  return writeFile(join(input.workDir, 'preview.stl'), STL).then(() => ({
    status: 'needs-review',
    review: {kind: 'region', previewStl: join(input.workDir, 'preview.stl'), previewMeshSha256: HASH_A,
      boundsMin: [-3, 0, -3], boundsMax: [3, 2, 3], extents: {x: 6, y: 2, z: 6}, scaleKnown: true, scaleMPerUnit: 0.16,
      suggestion: {type: 'component', reason: 'largest piece; may be the table', extents: {x: 6, y: 2, z: 6}},
      components: [{index: 0, vertices: 100, faces: 200, share: 1, boundsMin: [-3, 0, -3], boundsMax: [3, 2, 3], extents: {x: 6, y: 2, z: 6}}]},
  }));
}

async function setup({reconstruct} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reconstruction-'));
  const store = new ObjectStore(join(root, 'objects'));
  const touchups = [], builds = [];
  const runTouchup = async input => {
    touchups.push(input);
    const out = join(root, 'pass-' + touchups.length, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    return {status: 'done', summary: 'Smoothed it.', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(root, 'pass'), model: join(out, 'touched.stl')};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [10, 10, 10], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    reconstruct: reconstruct ?? (async input => { builds.push(input); await writeFile(input.output, 'usdz'); return {status: 'done'}; })});
  const object = await service.create();
  return {service, store, object, touchups, builds, root};
}

test('a region review ends the pass as an Ask, and only the explicit answer resumes it', async () => {
  let calls = 0;
  const {service, object, touchups} = await setup({reconstruct: async input => {
    calls += 1;
    await mkdir(input.workDir, {recursive: true});
    if (calls === 1) return regionOutcome(input);
    assert.ok(input.objectRegion, 'resume passes the stored region answer');
    const answer = JSON.parse(await readFile(input.objectRegion, 'utf8'));
    assert.equal(answer.kind, 'capture-object-region');
    await writeFile(input.output, 'usdz');
    return {status: 'done'};
  }});
  await service.addCapturePhoto(object.id, '0001.jpg', jpeg(64, 64, 1));
  await service.start(object.id, {version: 1, images: ['0001.jpg'], depthRequired: false});
  const waiting = await service.settled(object.id);
  assert.equal(waiting.state, 'needs-closeup');
  assert.equal(waiting.failure, undefined);
  assert.equal(touchups.length, 0, 'no AI cleanup before a qualified USDZ');
  const review = waiting.reconstructionReview;
  assert.equal(review.kind, 'region');
  assert.equal(review.previewMeshSha256, HASH_A);
  assert.equal(review.preview, `reconstruction-preview.stl?reviewId=${review.id}`);
  assert.equal(review.scaleKnown, true);
  assert.ok(!JSON.stringify(review).includes('/'), 'public review carries no paths except the preview route');
  assert.equal(publicObject(waiting).reconstructionReview.id, review.id);

  // Generic answers must not approve it.
  await assert.rejects(service.answerCloseup(object.id, {bestGuess: true}), /Update Counterpart/);
  await assert.rejects(service.answerCloseup(object.id, {text: 'looks fine'}), /Update Counterpart/);
  await assert.rejects(service.answerAsk(object.id, waiting.ask.id, ['x']), /Update Counterpart/);
  // Stale / wrong answers refused.
  await assert.rejects(service.answerReconstruction(object.id, '00000000-0000-0000-0000-000000000000',
    {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'suggested'}}));
  await assert.rejects(service.answerReconstruction(object.id, review.id,
    {type: 'region', previewMeshSha256: HASH_B, selection: {type: 'suggested'}}));
  await assert.rejects(service.answerReconstruction(object.id, review.id,
    {type: 'scale', meshSha256: HASH_A, axis: 'x', extentMm: 100}));
  await assert.rejects(service.answerReconstruction(object.id, review.id,
    {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'crop', min: [100, 100, 100], max: [101, 101, 101]}}));

  const relative = await service.reconstructionPreview(object.id, review.id);
  assert.equal(relative, `reconstruction/preview-${review.id}.stl`);
  await assert.rejects(service.reconstructionPreview(object.id, '00000000-0000-0000-0000-000000000000'));

  await service.answerReconstruction(object.id, review.id,
    {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'component', index: 0}});
  const done = await service.settled(object.id);
  assert.equal(done.state, 'ready');
  assert.equal(done.reconstructionReview, undefined);
  assert.equal(touchups.length, 1);
  assert.equal(calls, 2);
});

test('a scale review after region confirmation takes a measurement, not a region answer', async () => {
  let calls = 0;
  const {service, object} = await setup({reconstruct: async input => {
    calls += 1;
    await mkdir(input.workDir, {recursive: true});
    if (calls === 1) return regionOutcome(input);
    if (calls === 2) {
      await writeFile(join(input.workDir, 'selected.stl'), STL);
      return {status: 'needs-review', review: {kind: 'scale', previewStl: join(input.workDir, 'selected.stl'),
        meshSha256: HASH_B, boundsMin: [0, 0, 0], boundsMax: [1, 2, 3], extents: {x: 1, y: 2, z: 3}, scaleKnown: false}};
    }
    assert.ok(input.measurement, 'final resume passes the measurement');
    await writeFile(input.output, 'usdz');
    return {status: 'done'};
  }});
  await service.addCapturePhoto(object.id, '0001.jpg', jpeg(64, 64, 2));
  await service.start(object.id, {version: 1, images: ['0001.jpg'], depthRequired: false});
  const first = (await service.settled(object.id)).reconstructionReview;
  await service.answerReconstruction(object.id, first.id, {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'suggested'}});
  const second = (await service.settled(object.id)).reconstructionReview;
  assert.equal(second.kind, 'scale');
  assert.equal(second.meshSha256, HASH_B);
  await assert.rejects(service.answerReconstruction(object.id, second.id,
    {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'suggested'}}));
  await service.answerReconstruction(object.id, second.id, {type: 'scale', meshSha256: HASH_B, axis: 'y', extentMm: 150});
  assert.equal((await service.settled(object.id)).state, 'ready');
});

test('capture-camera binds to exact saved bytes and gates a manifest that requires it', async () => {
  const {service, object, builds} = await setup();
  const one = jpeg(640, 480, 3), two = jpeg(640, 480, 4);
  await service.addCapturePhoto(object.id, '0001.jpg', one);
  await service.addCapturePhoto(object.id, '0002.jpg', two);
  const frame = (image, bytes, x) => ({image, sha256: sha(bytes), width: 640, height: 480, fx: 500, fy: 500,
    cx: 320, cy: 240, timestampMs: 1730000000000, tracking: 'tracking', center: [x, 1.2, 0]});
  const camera = {version: 1, kind: 'capture-camera', frames: [frame('0001.jpg', one, 0), frame('0002.jpg', two, 0.3)], objectAnchor: null};

  await assert.rejects(service.start(object.id, {version: 1, images: ['0001.jpg', '0002.jpg'], depthRequired: false, cameraMetadataRequired: true}),
    /camera information/);
  await assert.rejects(service.addCaptureCamera(object.id, {...camera, frames: [{...camera.frames[0], sha256: HASH_A}, camera.frames[1]]}),
    InvalidCaptureCameraError);
  await assert.rejects(service.addCaptureCamera(object.id, {...camera, frames: [camera.frames[0]]}), InvalidCaptureCameraError);
  const withCamera = await service.addCaptureCamera(object.id, camera);
  assert.equal(withCamera.captureCamera.frameCount, 2);

  await service.start(object.id, {version: 1, images: ['0001.jpg', '0002.jpg'], depthRequired: false, cameraMetadataRequired: true});
  assert.equal((await service.settled(object.id)).state, 'ready');
  assert.ok(builds[0].cameraMetadata?.endsWith('capture-camera.json'));
  assert.ok(builds[0].workDir?.endsWith(join('reconstruction', 'work')));
});

test('replacing a capture photo invalidates bound camera metadata', async () => {
  const {service, object} = await setup();
  const one = jpeg(640, 480, 5);
  await service.addCapturePhoto(object.id, '0001.jpg', one);
  await service.addCaptureCamera(object.id, {version: 1, kind: 'capture-camera', objectAnchor: null,
    frames: [{image: '0001.jpg', sha256: sha(one), width: 640, height: 480, fx: 500, fy: 500, cx: 320, cy: 240,
      timestampMs: 1, tracking: 'tracking', center: [0, 1, 0]}]});
  await service.addCapturePhoto(object.id, '0001.jpg', jpeg(640, 480, 6));
  assert.equal((await service.get(object.id)).captureCamera, undefined);
});

test('manifest accepts numbered jpg/png and keeps depth an iPhone HEIC-only protocol', async () => {
  const {service, object} = await setup();
  await service.addCapturePhoto(object.id, '0001.png', Buffer.from('x'));
  await assert.rejects(service.start(object.id, {version: 1, images: ['0001.png'], depthRequired: true}));
  await service.start(object.id, {version: 1, images: ['0001.png'], depthRequired: false});
  assert.equal((await service.settled(object.id)).state, 'ready');
});

test('linux runner maps exit 5 and 0, preserves abort, and parses outcomes strictly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-runner-'));
  const script = join(root, 'fake-tool');
  const region = {needsObjectRegion: {receipt: '/w/needs.json', previewMeshSha256: HASH_A, previewMesh: '/w/p.ply', previewStl: '/w/p.stl',
    boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], scaleKnown: false, scaleMPerUnit: null,
    suggestion: {type: 'component', index: 0, reason: 'largest piece', extents: {x: 2, y: 2, z: 2}},
    components: [{index: 0, vertices: 3, faces: 1, share: 1, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], extents: {x: 2, y: 2, z: 2}}]}};
  await writeFile(script, `#!/bin/sh\nif [ -n "$FAKE_DONE" ]; then echo '{"done":"x"}'; exit 0; fi\necho '${JSON.stringify(region)}'\nexit 5\n`);
  await chmod(script, 0o755);
  const run = linuxReconstructRunner(script);
  const outcome = await run({photosDir: root, output: join(root, 'o.usdz'), masksDir: root});
  assert.equal(outcome.status, 'needs-review');
  assert.equal(outcome.review.kind, 'region');
  process.env.FAKE_DONE = '1';
  try { assert.equal((await run({photosDir: root, output: join(root, 'o.usdz'), masksDir: root})).status, 'done'); }
  finally { delete process.env.FAKE_DONE; }
  assert.equal(parseRegionOutcome({previewMeshSha256: 'nope'}), undefined);
  assert.equal(parseScaleOutcome({meshSha256: HASH_B, boundsMin: [0, 0, 0], boundsMax: [1, 1, 1], extents: {x: 1, y: 1, z: 1}, previewStl: '/w/s.stl'}).kind, 'scale');
  assert.equal(parseScaleOutcome({meshSha256: HASH_B, boundsMin: [0, 0, Infinity], boundsMax: [1, 1, 1], extents: {x: 1, y: 1, z: 1}, previewStl: '/w/s.stl'}), undefined);
});

test('HTTP: capture-camera, preview and reconstruction answer routes with scopes', async t => {
  let calls = 0;
  const {service, object} = await setup({reconstruct: async input => {
    calls += 1;
    await mkdir(input.workDir, {recursive: true});
    if (calls === 1) return regionOutcome(input);
    await writeFile(input.output, 'usdz');
    return {status: 'done'};
  }});
  const routes = createObjectRoutes(service);
  const scopes = [];
  const server = createServer(async (request, response) => {
    try { await routes.handle(request, response, async scope => { scopes.push(scope); }, name => request.headers[name]); }
    catch (error) { response.statusCode = 500; response.end(String(error?.stack ?? error)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {method, headers: {'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'},
      ...(body !== undefined ? {body: Buffer.isBuffer(body) ? body : JSON.stringify(body)} : {})});
    const bytes = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    return {status: response.status, json, bytes};
  };
  const one = jpeg(640, 480, 7);
  assert.equal((await call('POST', `/v1/objects/${object.id}/capture?name=0001.jpg`, one)).status, 200);
  const camera = {version: 1, kind: 'capture-camera', objectAnchor: null,
    frames: [{image: '0001.jpg', sha256: sha(one), width: 640, height: 480, fx: 500, fy: 500, cx: 320, cy: 240,
      timestampMs: 1, tracking: 'tracking', center: [0, 1, 0]}]};
  const accepted = await call('POST', `/v1/objects/${object.id}/capture-camera`, camera);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.object.captureCamera.frameCount, 1);
  assert.equal((await call('POST', `/v1/objects/${object.id}/capture-camera`, {...camera, frames: [{...camera.frames[0], sha256: HASH_A}]})).status, 400);

  await call('POST', `/v1/objects/${object.id}/start`, {captureManifest: {version: 1, images: ['0001.jpg'], depthRequired: false, cameraMetadataRequired: true}});
  const waiting = (await service.settled(object.id)).reconstructionReview;
  const preview = await call('GET', `/v1/objects/${object.id}/reconstruction-preview.stl?reviewId=${waiting.id}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.bytes.toString(), STL);
  assert.equal((await call('GET', `/v1/objects/${object.id}/reconstruction-preview.stl?reviewId=00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await call('GET', `/v1/objects/${object.id}/reconstruction-preview.stl`)).status, 404);

  const answered = await call('POST', `/v1/objects/${object.id}/reconstruction`,
    {reviewId: waiting.id, answer: {type: 'region', previewMeshSha256: HASH_A, selection: {type: 'suggested'}}});
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.equal((await service.settled(object.id)).state, 'ready');
  assert.ok(scopes.includes('captures:import') && scopes.includes('projects:read'));
});
