import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileSavedProjectStorage } from '@scan-to-make/project';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import { CaptureStore } from '../dist/capture-import.js';
import { DetailStillStore, sniffDetailStillMediaType } from '../dist/detail-stills.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const brief = { object: 'Bottle', context: 'Drawer', addition: 'Holder' };
const derived = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
function converterOutput(bytes) {
  return {
    derived,
    report: Buffer.from(JSON.stringify({
      tool: 'capture-mesh-convert', toolVersion: '0.3.0',
      source: { sha256: sha(bytes), bytes: bytes.length },
      output: { sha256: sha(derived), bytes: derived.length, format: 'obj' },
      metersPerUnit: 0.01, unitsAuthored: true, upAxis: 'Z',
      metricQualified: true, metricQualifiedReason: null,
      outputBasis: { coordinates: 'world', units: 'native stage units (unrescaled)', metersPerUnit: 0.01, upAxis: 'Z' },
      contributingLayers: [{ identifier: 'fixture.usdc', sha256: 'a'.repeat(64), bytes: 30 }],
      unsupportedFeatures: [], provesCompleteCapture: false, provesPhysicalFit: false,
    })),
  };
}

// Tiny synthetic byte fixtures: magic headers plus padding, never real photos.
export const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
export const pngBytes = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x22)]);
export const heicBytes = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64, 0x33)]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'detail-stills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new FileSavedProjectStorage(join(root, 'projects'));
  const projects = createSavedProjects(storage);
  assert.equal((await projects.create({ id: 'test', brief })).status, 'ok');
  const converter = { convert: async (bytes) => converterOutput(bytes) };
  const captures = new CaptureStore(storage, join(root, 'captures'), converter);
  const saved = await captures.importCapture({ projectId: 'test', projectRevision: 0, source: Buffer.from('synthetic source') });
  const stills = new DetailStillStore(storage, join(root, 'captures'));
  return { root, storage, projects, captures, stills, captureId: saved.captureId };
}
const add = (f, source, extra = {}) =>
  f.stills.addDetailStill({ projectId: 'test', projectRevision: 0, captureId: f.captureId, source, ...extra });

test('sniffing accepts only JPEG, PNG and HEIC magic bytes', () => {
  assert.equal(sniffDetailStillMediaType(jpegBytes()), 'image/jpeg');
  assert.equal(sniffDetailStillMediaType(pngBytes()), 'image/png');
  assert.equal(sniffDetailStillMediaType(heicBytes()), 'image/heic');
  assert.equal(sniffDetailStillMediaType(Buffer.from('GIF89a' + 'x'.repeat(32))), null);
  assert.equal(sniffDetailStillMediaType(Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypavif')])), null);
  assert.equal(sniffDetailStillMediaType(Buffer.alloc(0)), null);
  assert.equal(sniffDetailStillMediaType(Buffer.from([0xff, 0xd8])), null);
});

test('still survives a fresh store instance with exact bytes, label and ordinals', async (t) => {
  const f = await fixture(t);
  const first = await add(f, jpegBytes(), { label: 'USB-C port' });
  const second = await add(f, pngBytes());
  assert.equal(first.still.ordinal, 0);
  assert.equal(second.still.ordinal, 1);
  assert.equal(first.still.sha256, sha(jpegBytes()));
  assert.equal(first.still.byteLength, jpegBytes().length);

  const fresh = new DetailStillStore(new FileSavedProjectStorage(join(f.root, 'projects')), join(f.root, 'captures'));
  const list = await fresh.listDetailStills('test', 0, f.captureId);
  assert.deepEqual(list.stills, [first.still, second.still]);
  const loaded = await fresh.loadDetailStill('test', 0, f.captureId, first.still.id);
  assert.deepEqual(loaded.bytes, jpegBytes());
  assert.deepEqual(loaded.still, first.still);
});

test('bad type, empty, oversize and bad label reject without writing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(add(f, Buffer.from('not an image')), (e) => e.code === 'unsupported-media-type');
  await assert.rejects(add(f, Buffer.alloc(0)), (e) => e.code === 'unsupported-media-type');
  await assert.rejects(add(f, jpegBytes(), { label: 'x'.repeat(201) }), (e) => e.code === 'invalid-still');
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(25 * 1024 * 1024, 1)]);
  await assert.rejects(add(f, big), (e) => e.code === 'payload-too-large');
  assert.deepEqual(await readdir(join(f.root, 'captures', f.captureId)), [
    'binding.json', 'conversion.json', 'mesh.obj', 'original.usdz',
  ]);
});

test('unknown capture, stale revision and unknown still fail closed', async (t) => {
  const f = await fixture(t);
  const unknown = '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  await assert.rejects(
    f.stills.addDetailStill({ projectId: 'test', projectRevision: 0, captureId: unknown, source: jpegBytes() }),
    (e) => e.code === 'not-found',
  );
  await assert.rejects(add(f, jpegBytes(), { projectRevision: 1 }));
  await assert.rejects(
    f.stills.loadDetailStill('test', 0, f.captureId, unknown),
    (e) => e.code === 'not-found',
  );
  await assert.rejects(f.stills.loadDetailStill('test', 0, '../escape', unknown));
});

test('at most 24 stills per capture', async (t) => {
  const f = await fixture(t);
  const added = [];
  for (let i = 0; i < 24; i++) added.push(await add(f, jpegBytes()));
  await assert.rejects(add(f, jpegBytes()), (e) => e.code === 'still-limit');
  assert.equal((await f.stills.listDetailStills('test', 0, f.captureId)).stills.length, 24);
  // Deleting from a full set frees a slot; the next ordinal stays monotonic.
  await f.stills.deleteDetailStill('test', 0, f.captureId, added[0].still.id);
  const replacement = await add(f, jpegBytes());
  assert.equal(replacement.still.ordinal, 24);
  assert.equal((await f.stills.listDetailStills('test', 0, f.captureId)).stills.length, 24);
});

test('corrupted retained bytes or metadata reject on load and list', async (t) => {
  const f = await fixture(t);
  const { still } = await add(f, jpegBytes());
  const dir = join(f.root, 'captures', f.captureId, 'detail-stills');
  await writeFile(join(dir, `${still.id}.img`), Buffer.from('tampered bytes with jpeg head \xff\xd8\xff'));
  await assert.rejects(f.stills.loadDetailStill('test', 0, f.captureId, still.id), (e) => e.code === 'still-unavailable');
  const meta = JSON.parse(await readFile(join(dir, `${still.id}.json`), 'utf8'));
  await writeFile(join(dir, `${still.id}.json`), JSON.stringify({ ...meta, sha256: 'b'.repeat(64) }));
  await assert.rejects(f.stills.listDetailStills('test', 0, f.captureId), (e) => e.code === 'still-unavailable');
});

test('delete removes one still and preserves the remaining order', async (t) => {
  const f = await fixture(t);
  const first = await add(f, jpegBytes());
  const second = await add(f, heicBytes(), { label: 'switch' });
  await f.stills.deleteDetailStill('test', 0, f.captureId, first.still.id);
  const list = await f.stills.listDetailStills('test', 0, f.captureId);
  assert.deepEqual(list.stills, [second.still]);
  await assert.rejects(f.stills.loadDetailStill('test', 0, f.captureId, first.still.id), (e) => e.code === 'not-found');
  await assert.rejects(f.stills.deleteDetailStill('test', 0, f.captureId, first.still.id), (e) => e.code === 'not-found');
  const third = await add(f, pngBytes());
  assert.equal(third.still.ordinal, 2);
});

test('deleting the newest or every still never rewinds attachment order', async (t) => {
  const f = await fixture(t);
  const first = await add(f, jpegBytes());
  const second = await add(f, pngBytes());
  await f.stills.deleteDetailStill('test', 0, f.captureId, second.still.id);
  const third = await add(f, heicBytes());
  assert.equal(third.still.ordinal, 2);
  await f.stills.deleteDetailStill('test', 0, f.captureId, first.still.id);
  await f.stills.deleteDetailStill('test', 0, f.captureId, third.still.id);
  assert.deepEqual((await f.stills.listDetailStills('test', 0, f.captureId)).stills, []);
  // A fresh store instance reads the persisted high-water mark.
  const reopened = new DetailStillStore(f.storage, join(f.root, 'captures'));
  const fourth = await reopened.addDetailStill({ projectId: 'test', projectRevision: 0, captureId: f.captureId, source: jpegBytes() });
  assert.equal(fourth.still.ordinal, 3);
});

test('a corrupted ordinal high-water mark fails closed', async (t) => {
  const f = await fixture(t);
  await add(f, jpegBytes());
  await writeFile(join(f.root, 'captures', f.captureId, 'detail-stills', '.ordinal-high-water'), 'not a number');
  await assert.rejects(add(f, jpegBytes()), (e) => e.code === 'still-unavailable');
});

test('revoked commit authorization leaves no still behind', async (t) => {
  const f = await fixture(t);
  await add(f, jpegBytes());
  await assert.rejects(
    f.stills.addDetailStill(
      { projectId: 'test', projectRevision: 0, captureId: f.captureId, source: jpegBytes() },
      undefined,
      async () => { throw new Error('revoked'); },
    ),
    /revoked/,
  );
  assert.equal((await f.stills.listDetailStills('test', 0, f.captureId)).stills.length, 1);
});
