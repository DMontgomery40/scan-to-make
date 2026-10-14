import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as api from '../dist/generation.js';

const fit = JSON.parse(
  readFileSync(new URL('../fixtures/drawer-tray.json', import.meta.url))
);
fit.revision = 3;
const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
const sha = async (value) => createHash('sha256').update(value).digest('hex');
const response = () => ({
  formatVersion: '0.1.0',
  receipt: {
    sourceFit: structuredClone(fit),
    artifact: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'model/stl',
      byteLength: bytes.length,
    },
    geometry: {
      encoding: 'binary',
      triangleCount: 1,
      boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    },
    generator: { name: 'drawer-tray', version: '0.1.0' },
    assumptions: { cornerRadiusAssumedMm: 0 },
    status: 'preview-only',
  },
  stlBase64: bytes.toString('base64'),
});
const reverse = (value) =>
  Array.isArray(value)
    ? value.map(reverse)
    : value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([k, v]) => [k, reverse(v)])
      )
    : value;

test('generation protocol preserves full edited source and verifies exact bytes without Node APIs', async () => {
  const request = api.GenerationRequestSchema.parse({
    formatVersion: '0.1.0',
    sourceFit: fit,
  });
  assert.equal(request.sourceFit.revision, 3);
  const verified = await api.verifyGenerationResponse(
    reverse(response()),
    reverse(fit),
    sha
  );
  assert.deepEqual(verified.receipt.sourceFit, fit);
  assert.deepEqual([...verified.bytes], [...bytes]);
});

test('request and receipt reject executable/path overrides, future versions and invalid geometry metadata', () => {
  for (const extra of [
    { command: 'evil' },
    { sourcePath: '/etc/passwd' },
    { outputPath: '/tmp/x' },
  ])
    assert.equal(
      api.GenerationRequestSchema.safeParse({
        formatVersion: '0.1.0',
        sourceFit: fit,
        ...extra,
      }).success,
      false
    );
  for (const mutate of [
    (x) => (x.formatVersion = '9'),
    (x) => (x.receipt.status = 'print-authorized'),
    (x) => (x.receipt.sourceFit.revision = -1),
    (x) => (x.receipt.geometry.boundsMm.min[0] = 2),
    (x) => (x.receipt.geometry.triangleCount = 500001),
    (x) => (x.receipt.artifact.byteLength = api.MAX_GENERATED_STL_BYTES + 1),
    (x) => (x.receipt.artifact.mediaType = 'text/plain'),
    (x) => (x.receipt.assumptions.cornerRadiusAssumedMm = 2),
  ]) {
    const value = response();
    mutate(value);
    assert.equal(api.GenerationResponseSchema.safeParse(value).success, false);
  }
});

test('same id/revision with a different source, digest or length is rejected', async () => {
  for (const mutate of [
    (x) => (x.receipt.sourceFit.parameters.dividersAcross = 3),
    (x) => (x.receipt.sourceFit.dimensions.drawerInnerWidth.sourceId = 'other'),
    (x) => (x.receipt.artifact.sha256 = 'a'.repeat(64)),
    (x) => x.receipt.artifact.byteLength++,
  ]) {
    const value = response();
    mutate(value);
    await assert.rejects(api.verifyGenerationResponse(value, fit, sha));
  }
});

test('base64 verifier rejects malformed and noncanonical encodings before hashing', async () => {
  for (const encoded of [
    '',
    'AA',
    'AA===',
    'AA=A',
    'AA==\n',
    '_A==',
    'AB==',
    'AAB=',
  ]) {
    const value = response();
    value.stlBase64 = encoded;
    let called = false;
    await assert.rejects(
      api.verifyGenerationResponse(value, fit, async () => {
        called = true;
        return 'a'.repeat(64);
      })
    );
    assert.equal(called, false);
  }
  for (const sample of [
    Buffer.from([1]),
    Buffer.from([1, 2]),
    Buffer.from([1, 2, 3]),
    Buffer.from([255, 0, 1, 2]),
  ]) {
    const value = response();
    value.stlBase64 = sample.toString('base64');
    value.receipt.artifact = {
      ...value.receipt.artifact,
      byteLength: sample.length,
      sha256: await sha(sample),
    };
    assert.deepEqual(
      [...(await api.verifyGenerationResponse(value, fit, sha)).bytes],
      [...sample]
    );
  }
});

test('verification snapshots input before asynchronous hashing and propagates digest failure', async () => {
  const value = response(),
    expected = structuredClone(fit);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = api.verifyGenerationResponse(value, expected, async (b) => {
    await gate;
    return sha(b);
  });
  value.receipt.sourceFit.parameters.dividersAcross = 7;
  value.stlBase64 = 'AAAA';
  expected.parameters.dividersAcross = 7;
  release();
  const verified = await pending;
  assert.equal(verified.receipt.sourceFit.parameters.dividersAcross, 2);
  await assert.rejects(
    api.verifyGenerationResponse(response(), fit, async () => {
      throw Error('native digest failed');
    }),
    /native digest failed/
  );
});
