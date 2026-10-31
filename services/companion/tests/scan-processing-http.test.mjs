import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { FileSavedProjectStorage } from '@scan-to-make/project';
import { CaptureStore } from '../dist/capture-import.js';
import {ScanProcessingStore} from '../dist/scan-processing.js';
import {fakeRunner} from './fixtures/scan-processing.mjs';
import { RemoteAuthStore } from '../dist/remote-auth.js';
import { startCompanionServer } from '../dist/server.js';

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
  const scanProcessing = new ScanProcessingStore(storage,captures,join(root,'captures'),fakeRunner);
  const server = await startCompanionServer({ port: 0, remoteAuth, capture: { storage, captures, scanProcessing } });
  t.after(() => server.close());
  return {
    root, remoteAuth, phone, storage, captures, server, scanProcessing,
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
  return { f, etag, captureId, base: `/v1/saved-projects/phone/captures/${captureId}/scan-processing` };
}

test('authenticated scan jobs: scopes, ETag, strict body, status, artifacts and tampering',async t=>{
 const {f,etag,base,captureId}=await setup(t);
 const post=(body,tag=etag)=>({method:'POST',headers:{'content-type':'application/json','if-match':tag},body:JSON.stringify(body)});
 assert.equal((await wire(f,base+'?projectRevision=7',post({reference:{dimensionsMm:[60.6,45.2,21.7]}}))).status,202);
 await f.scanProcessing.wait();await waitReady(f);
 // Recover the returned ID from a second POST; no retry/idempotency promise on collection POST.
 const created=await wire(f,base+'?projectRevision=7',post({}));assert.equal(created.status,202);const {job}=JSON.parse(created.bytes);
 await f.scanProcessing.wait();await waitReady(f);
 const listing=await wire(f,base+'?projectRevision=7',{headers:{'if-match':etag}});assert.equal(listing.status,200);assert.equal(listing.headers.etag,etag);
 const listed=JSON.parse(listing.bytes).jobs;assert.equal(listed.length,2);assert(listed.some(item=>item.jobId===job.jobId&&item.status==='succeeded'));
 assert.deepEqual(listed.map(item=>item.jobId),listed.map(item=>item.jobId).sort());await waitReady(f);
 const path=base+'/'+job.jobId+'?projectRevision=7';
 const get=await wire(f,path,{headers:{'if-match':etag}});assert.equal(get.status,200);assert.equal(JSON.parse(get.bytes).job.status,'succeeded');await waitReady(f);
 const artifact=base+'/'+job.jobId+'/artifacts/pos_x.png?projectRevision=7';
 const download=await wire(f,artifact,{headers:{'if-match':etag}});assert.equal(download.status,200);assert.equal(download.headers['x-content-sha256'],sha(download.bytes));await waitReady(f);
 for(const [urlPath,options,status] of [
  [base+'?projectRevision=7',post({toolPath:'/evil'}),400],
  [base+'?projectRevision=7',post({},'"'+'0'.repeat(64)+'"'),412],
  [base+'?projectRevision=7&projectRevision=7',post({}),400],
  [path,{headers:{}},428],
  [base+'?projectRevision=7',{headers:{}},428],
  [base+'?projectRevision=7',{headers:{'if-match':'"'+'0'.repeat(64)+'"'}},412],
  [artifact.replace('pos_x.png','binding.json'),{headers:{'if-match':etag}},404],
 ]){assert.equal((await wire(f,urlPath,options)).status,status);await waitReady(f);}
 await writeFile(join(f.root,'captures',captureId,'scan-processing',job.jobId,'pos_x.png'),'tampered');
 assert.equal((await wire(f,artifact,{headers:{'if-match':etag}})).status,422);await waitReady(f);
 const pairing=await f.remoteAuth.createPairing('alice@example.test',['captures:read']);const reader=await f.remoteAuth.exchange('alice@example.test',{code:pairing.code,deviceName:'Reader'});
 assert.equal((await wire(f,base+'?projectRevision=7',{...post({}),headers:{...post({}).headers,authorization:`Bearer ${reader.token}`,'x-scan-device':reader.deviceId}})).status,403);
});
