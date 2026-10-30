import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { FileSavedProjectStorage } from '@scan-to-make/project';
import { CaptureStore } from '../dist/capture-import.js';
import { DetailStillStore } from '../dist/detail-stills.js';
import { RemoteAuthStore } from '../dist/remote-auth.js';
import { startGenerationServer } from '../dist/generation.js';

const forwarded = JSON.parse(
  await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8'),
).expected;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const project = {
  formatVersion: '0.2.0', id: 'phone', revision: 7,
  brief: { object: 'Bottle', context: 'Drawer', addition: 'Holder' },
  fit: null, preview: null, acceptedArtifact: null,
};
const derived = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const converter = {
  convert: async (bytes) => ({
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
  }),
};
// Synthetic byte fixtures only: image magic headers plus padding.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11), Buffer.from([0xff, 0xd9])]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x22)]);

async function fixture(t, scopes = ['projects:read', 'projects:write', 'captures:read', 'captures:import']) {
  const root = await mkdtemp(join(tmpdir(), 'detail-stills-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {
    host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'],
  });
  const invitation = await remoteAuth.createPairing('alice@example.test', scopes);
  const phone = await remoteAuth.exchange('alice@example.test', { code: invitation.code, deviceName: 'Fixture' });
  const storage = new FileSavedProjectStorage(join(root, 'projects'));
  const captures = new CaptureStore(storage, join(root, 'captures'), converter);
  const detailStills = new DetailStillStore(storage, join(root, 'captures'));
  const server = await startGenerationServer({ port: 0, remoteAuth, capture: { storage, captures, detailStills } });
  t.after(() => server.close());
  return {
    root, remoteAuth, phone, storage, captures, server,
    headers: { authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId },
  };
}
function wire(f, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.server.url + path, { method, headers: { ...forwarded, ...f.headers, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function waitReady(f) {
  // The single capture slot frees after each response; retry explicit 429 only.
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await wire(f, '/v1/saved-projects/phone');
    if (result.status !== 429) return result;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('slot stayed busy');
}
async function setup(t) {
  const f = await fixture(t);
  const sync = await wire(f, '/v1/saved-projects/phone', {
    method: 'PUT', headers: { 'content-type': 'application/json', 'if-none-match': '*' }, body: JSON.stringify(project),
  });
  assert.equal(sync.status, 201);
  const etag = sync.headers.etag;
  await waitReady(f);
  const imported = await wire(f, '/v1/saved-projects/phone/captures?projectRevision=7', {
    method: 'POST', headers: { 'content-type': 'model/vnd.usdz+zip', 'if-match': etag }, body: Buffer.from('synthetic usdz stand-in'),
  });
  assert.equal(imported.status, 201);
  const captureId = JSON.parse(imported.bytes).captureId;
  await waitReady(f);
  return { f, etag, captureId, base: `/v1/saved-projects/phone/captures/${captureId}/detail-stills` };
}
const post = (path, etag, body, type = 'image/jpeg') => ({
  method: 'POST', headers: { 'content-type': type, 'if-match': etag }, body,
});

test('upload, list, download exact bytes and delete over authenticated HTTP', async (t) => {
  const { f, etag, base } = await setup(t);
  const created = await wire(f, `${base}?projectRevision=7&label=${encodeURIComponent('USB-C port')}`, post(base, etag, jpeg));
  assert.equal(created.status, 201);
  assert.equal(created.headers.etag, etag);
  const { still } = JSON.parse(created.bytes);
  assert.equal(still.schema, 'scan-to-make.detail-still/0.1');
  assert.equal(still.label, 'USB-C port');
  assert.equal(still.ordinal, 0);
  assert.equal(still.sha256, sha(jpeg));
  await waitReady(f);

  const created2 = await wire(f, `${base}?projectRevision=7`, post(base, etag, png, 'image/png'));
  assert.equal(created2.status, 201);
  assert.equal(JSON.parse(created2.bytes).still.ordinal, 1);
  await waitReady(f);

  const list = await wire(f, `${base}?projectRevision=7`, { headers: { 'if-match': etag } });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.bytes).stills.map((s) => s.id), [still.id, JSON.parse(created2.bytes).still.id]);
  await waitReady(f);

  const download = await wire(f, `${base}/${still.id}?projectRevision=7`, { headers: { 'if-match': etag } });
  assert.equal(download.status, 200);
  assert.deepEqual(download.bytes, jpeg);
  assert.equal(download.headers['content-type'], 'image/jpeg');
  assert.equal(download.headers['x-content-sha256'], still.sha256);
  assert.equal(download.headers['content-length'], String(jpeg.length));
  await waitReady(f);

  const removed = await wire(f, `${base}/${still.id}?projectRevision=7`, { method: 'DELETE', headers: { 'if-match': etag } });
  assert.equal(removed.status, 200);
  assert.equal(JSON.parse(removed.bytes).deleted, true);
  await waitReady(f);
  assert.equal((await wire(f, `${base}/${still.id}?projectRevision=7`, { headers: { 'if-match': etag } })).status, 404);
});

test('wrong scope, stale ETag, unknown capture, bad type and oversize fail closed', async (t) => {
  const { f, etag, base } = await setup(t);
  // Sniffed type disagrees with declared Content-Type.
  assert.equal((await wire(f, `${base}?projectRevision=7`, post(base, etag, png, 'image/jpeg'))).status, 415);
  await waitReady(f);
  assert.equal((await wire(f, `${base}?projectRevision=7`, post(base, etag, Buffer.from('plain text'), 'image/jpeg'))).status, 415);
  await waitReady(f);
  assert.equal((await wire(f, `${base}?projectRevision=7`, post(base, etag, jpeg, 'text/plain'))).status, 415);
  await waitReady(f);
  // Stale snapshot and missing precondition.
  assert.equal((await wire(f, `${base}?projectRevision=7`, post(base, '"' + '0'.repeat(64) + '"', jpeg))).status, 412);
  await waitReady(f);
  assert.equal((await wire(f, `${base}?projectRevision=7`, { headers: {} })).status, 428);
  await waitReady(f);
  assert.equal((await wire(f, `${base}?projectRevision=8`, { headers: { 'if-match': etag } })).status, 412);
  await waitReady(f);
  // Unknown capture.
  const unknown = '/v1/saved-projects/phone/captures/9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/detail-stills?projectRevision=7';
  assert.equal((await wire(f, unknown, post(base, etag, jpeg))).status, 404);
  await waitReady(f);
  // Oversize by Content-Length, before the body is read.
  assert.equal((await wire(f, `${base}?projectRevision=7`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg', 'if-match': etag, 'content-length': String(26 * 1024 * 1024) },
  })).status, 413);
  await waitReady(f);
  // Bad label.
  assert.equal((await wire(f, `${base}?projectRevision=7&label=${'x'.repeat(201)}`, post(base, etag, jpeg))).status, 400);
});

test('read-only scope can list but cannot upload or delete', async (t) => {
  const { f, etag, base } = await setup(t);
  const created = await wire(f, `${base}?projectRevision=7`, post(base, etag, jpeg));
  const stillId = JSON.parse(created.bytes).still.id;
  await waitReady(f);
  const invite = await f.remoteAuth.createPairing('alice@example.test', ['projects:read', 'captures:read']);
  const reader = await f.remoteAuth.exchange('alice@example.test', { code: invite.code, deviceName: 'Reader' });
  const readerHeaders = { authorization: `Bearer ${reader.token}`, 'x-scan-device': reader.deviceId };
  assert.equal((await wire(f, `${base}?projectRevision=7`, { headers: { ...readerHeaders, 'if-match': etag } })).status, 200);
  await waitReady(f);
  assert.equal((await wire(f, `${base}?projectRevision=7`, {
    ...post(base, etag, jpeg), headers: { ...post(base, etag, jpeg).headers, ...readerHeaders },
  })).status, 403);
  assert.equal((await wire(f, `${base}/${stillId}?projectRevision=7`, {
    method: 'DELETE', headers: { ...readerHeaders, 'if-match': etag },
  })).status, 403);
});

test('tampered retained bytes are not served', async (t) => {
  const { f, etag, captureId, base } = await setup(t);
  const created = await wire(f, `${base}?projectRevision=7`, post(base, etag, jpeg));
  const stillId = JSON.parse(created.bytes).still.id;
  await waitReady(f);
  await writeFile(
    join(f.root, 'captures', captureId, 'detail-stills', `${stillId}.img`),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(jpeg.length - 3, 0xee)]),
  );
  assert.equal((await wire(f, `${base}/${stillId}?projectRevision=7`, { headers: { 'if-match': etag } })).status, 422);
});

test('detail still routes are absent when the store is not configured', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'detail-stills-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {
    host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'],
  });
  const invitation = await remoteAuth.createPairing('alice@example.test', ['captures:read']);
  const phone = await remoteAuth.exchange('alice@example.test', { code: invitation.code, deviceName: 'Fixture' });
  const storage = new FileSavedProjectStorage(join(root, 'projects'));
  const server = await startGenerationServer({ port: 0, remoteAuth, capture: { storage } });
  t.after(() => server.close());
  const path = '/v1/saved-projects/phone/captures/9a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/detail-stills?projectRevision=7';
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(server.url + path, {
      headers: { ...forwarded, authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(result, 404);
});
