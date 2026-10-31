import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {createPrintHandoffServices} from '../dist/print-handoff-http.js';
import {HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';

const forwarded = JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8')).expected;
const fixtureServer = fileURLToPath(new URL('../../printer-handoff/tests/fixtures/fixture-printer-server.mjs', import.meta.url));
const stl = Buffer.from('solid fixture\n' + ' facet\n'.repeat(20) + 'endsolid fixture\n');
const selection = {
  model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel',
  bedType: 'textured_plate', material: 'PLA', plateIndex: 0,
};

async function fixture(t, scopes = ['printer-handoff:use'], makeServices) {
  const root = await mkdtemp(join(tmpdir(), 'print-handoff-http-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {
    host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'],
  });
  const invitation = await remoteAuth.createPairing('alice@example.test', scopes);
  const phone = await remoteAuth.exchange('alice@example.test', {code: invitation.code, deviceName: 'Fixture'});
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const printHandoff = makeServices ? makeServices(root) : createPrintHandoffServices({
    backend: 'bambu-printer-mcp',
    process: {command: process.execPath, args: [fixtureServer, 'bambu', log], cwd: root},
    selection,
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 10000},
  }, join(root, 'bundles'));
  const server = await startCompanionServer({port: 0, remoteAuth, printHandoff});
  t.after(() => server.close());
  const headers = {authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId};
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return {root, server, headers, calls};
}

function wire(f, path, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.server.url + path, {method, headers: {...forwarded, ...f.headers, ...headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const json = result => JSON.parse(result.bytes);
async function createBundle(f, prompt = 'make a hook that fits') {
  const created = await wire(f, '/v1/printer-handoff/bundles', {
    method: 'POST',
    headers: {'content-type': 'model/stl', 'x-handoff-prompt': encodeURIComponent(prompt)},
    body: stl,
  });
  assert.equal(created.status, 201, created.bytes.toString());
  return json(created).bundle;
}

test('handoff routes require the printer-handoff scope', async t => {
  const f = await fixture(t, ['generation:health']);
  assert.equal((await wire(f, '/v1/printer-handoff/bundles')).status, 403);
  assert.equal((await wire(f, '/v1/printer-handoff/elicitations')).status, 403);
});

test('bundle create, list and read round-trip the prompt and configured backend', async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f, 'a bracket — 40mm wide');
  assert.equal(bundle.backend, 'bambu-printer-mcp');
  assert.equal(bundle.selection.model, 'p1s');
  assert.equal(bundle.status, 'ready');
  const listed = json(await wire(f, '/v1/printer-handoff/bundles'));
  assert.equal(listed.bundles.length, 1);
  const read = json(await wire(f, `/v1/printer-handoff/bundles/${bundle.id}`));
  assert.equal(read.bundle.prompt, 'a bracket — 40mm wide');
  assert.equal(read.printing, false);
  assert.equal((await wire(f, '/v1/printer-handoff/bundles', {
    method: 'POST', headers: {'content-type': 'text/plain'}, body: stl,
  })).status, 415);
  const tiny = await wire(f, '/v1/printer-handoff/bundles', {
    method: 'POST', headers: {'content-type': 'model/stl'}, body: Buffer.from('x'),
  });
  assert.equal(tiny.status, 400);
  assert.equal(json(tiny).error.code, 'invalid-stl');
  assert.equal((await wire(f, '/v1/printer-handoff/bundles/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('print runs through the fixture MCP server with phone-answered elicitation', async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f);
  const started = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(started.status, 202, started.bytes.toString());
  assert.equal((await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'})).status, 409);
  let answered = 0;
  let final;
  for (let attempt = 0; attempt < 200; attempt++) {
    const pending = json(await wire(f, '/v1/printer-handoff/elicitations')).elicitations;
    for (const item of pending) {
      const properties = item.requestedSchema?.properties ?? {};
      const content = {};
      if ('confirmed' in properties) content.confirmed = true;
      if ('bambu_model' in properties) content.bambu_model = 'p1s';
      const responded = await wire(f, `/v1/printer-handoff/elicitations/${item.id}/respond`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({action: 'accept', content}),
      });
      assert.equal(responded.status, 200, responded.bytes.toString());
      answered++;
    }
    final = json(await wire(f, `/v1/printer-handoff/bundles/${bundle.id}`));
    if (!final.printing && final.bundle.status === 'printed') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(final.bundle.status, 'printed');
  assert.ok(answered >= 1);
  assert.ok(final.bundle.artifacts.sliced);
  const tools = (await f.calls()).filter(entry => entry.tool).map(entry => entry.tool);
  assert.deepEqual(tools, ['lay_flat', 'slice_stl', 'inspect_print_file', 'camera_snapshot', 'print_3mf']);
});

test('elicitation respond rejects unknown ids and malformed answers', async t => {
  const f = await fixture(t);
  const unknown = await wire(f, '/v1/printer-handoff/elicitations/00000000-0000-4000-8000-000000000000/respond', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'cancel'}),
  });
  assert.equal(unknown.status, 404);
  assert.equal(json(unknown).error.code, 'elicitation-not-pending');
  const malformed = await wire(f, '/v1/printer-handoff/elicitations/00000000-0000-4000-8000-000000000000/respond', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'yes'}),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await wire(f, '/v1/printer-handoff/bundles/00000000-0000-4000-8000-000000000000/print', {method: 'POST'})).status, 404);
});

test('a failure after slicing persists a sanitized failed status instead of running forever', async t => {
  const f = await fixture(t, ['printer-handoff:use'], root => ({
    store: new HandoffBundleStore(join(root, 'bundles-fail')),
    relay: new InMemoryElicitationRelay({timeoutMs: 1000}),
    runner: {
      backend: 'bambu-printer-mcp',
      // Simulates runBundle failing outside its inner run() catch, while
      // recording the sliced artifact back into the bundle.
      runBundle: async (store, id) => {
        await store.recordArtifact(id, 'sliced', 'sliced.3mf', Buffer.from('fixture 3mf'));
        throw Object.assign(new Error('/private/operator/path exploded'), {code: 'record-failed'});
      },
    },
    selection,
  }));
  const bundle = await createBundle(f);
  const started = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(started.status, 202, started.bytes.toString());
  let final;
  for (let attempt = 0; attempt < 200; attempt++) {
    final = json(await wire(f, `/v1/printer-handoff/bundles/${bundle.id}`));
    if (!final.printing) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(final.printing, false);
  assert.equal(final.bundle.status, 'failed');
  assert.equal(final.bundle.failure, 'record-failed');
  assert.ok(!String(final.bundle.failure).includes('/private'));
});
