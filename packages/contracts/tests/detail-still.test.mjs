import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as api from '../dist/detail-still.js';
import * as rootApi from '../dist/index.js';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/detail-still.json', import.meta.url), 'utf8'),
);
const still = (overrides = {}) => ({ ...fixture, ...overrides });

test('fixture validates and is re-exported from the package root', () => {
  assert.deepEqual(api.validateDetailStill(fixture), fixture);
  assert.equal(api.DETAIL_STILL_SCHEMA_ID, 'scan-to-make.detail-still/0.1');
  assert.equal(rootApi.DetailStillSchema, api.DetailStillSchema);
  assert.equal(rootApi.validateDetailStill, api.validateDetailStill);
  assert.equal(api.MAX_DETAIL_STILL_BYTES, 25 * 1024 * 1024);
  assert.equal(api.MAX_DETAIL_STILLS_PER_CAPTURE, 24);
});

test('label is optional free text capped at 200 chars', () => {
  const { label: _label, ...without } = fixture;
  assert.deepEqual(api.validateDetailStill(without), without);
  assert.equal(api.DetailStillSchema.safeParse(still({ label: 'x'.repeat(200) })).success, true);
  assert.equal(api.DetailStillSchema.safeParse(still({ label: 'x'.repeat(201) })).success, false);
  assert.equal(api.DetailStillSchema.safeParse(still({ label: '' })).success, false);
  assert.equal(api.DetailStillSchema.safeParse(still({ label: 'line\nbreak' })).success, false);
});

test('rejects wrong schema, media type, identity and unknown fields', () => {
  for (const mutate of [
    (s) => (s.schema = 'scan-to-make.detail-still/0.2'),
    (s) => delete s.schema,
    (s) => (s.mediaType = 'image/gif'),
    (s) => (s.mediaType = 'application/octet-stream'),
    (s) => (s.sha256 = 'A'.repeat(64)),
    (s) => (s.sha256 = 'ab'),
    (s) => (s.byteLength = 0),
    (s) => (s.byteLength = 25 * 1024 * 1024 + 1),
    (s) => (s.byteLength = 1.5),
    (s) => (s.projectRevision = -1),
    (s) => (s.ordinal = -1),
    (s) => (s.ordinal = 24),
    (s) => (s.ordinal = 0.5),
    (s) => (s.id = 'not a uuid'),
    (s) => (s.captureId = 'not-a-uuid'),
    (s) => (s.projectId = '../escape'),
    (s) => (s.region = { x: 0, y: 0 }),
  ]) {
    const candidate = still();
    mutate(candidate);
    assert.equal(api.DetailStillSchema.safeParse(candidate).success, false);
  }
  for (const mediaType of ['image/jpeg', 'image/heic', 'image/png']) {
    assert.equal(api.DetailStillSchema.safeParse(still({ mediaType })).success, true);
  }
});

test('list validator enforces one capture, unique ids/ordinals and ordinal order', () => {
  const second = still({
    id: '4f9c2a44-7c5b-4b1e-9a2d-0e8f7a6b5c4e',
    ordinal: 1,
    label: 'power switch',
  });
  assert.deepEqual(api.validateDetailStills([fixture, second]), [fixture, second]);
  assert.deepEqual(api.validateDetailStills([]), []);
  for (const list of [
    [second, fixture],
    [fixture, still({ ordinal: 1 })],
    [fixture, still({ id: second.id })],
    [fixture, still({ id: second.id, ordinal: 1, captureId: '9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })],
    [fixture, still({ id: second.id, ordinal: 1, projectRevision: 4 })],
    [fixture, still({ id: second.id, ordinal: 1, projectId: 'other' })],
  ]) {
    assert.equal(api.DetailStillListSchema.safeParse(list).success, false);
  }
  const tooMany = Array.from({ length: 25 }, (_, i) =>
    still({
      id: `3f9c2a44-7c5b-4b1e-9a2d-${String(i).padStart(12, '0')}`,
      ordinal: i,
    }),
  );
  assert.equal(api.DetailStillListSchema.safeParse(tooMany).success, false);
});

test('parsed record is detached from caller mutations', () => {
  const input = still();
  const parsed = api.validateDetailStill(input);
  input.label = 'changed';
  input.sha256 = 'b'.repeat(64);
  assert.equal(parsed.label, 'USB-C port');
  assert.equal(parsed.sha256, 'a'.repeat(64));
});
