import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, request as httpRequest} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {RemoteAuthFailure, RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {createPrintHandoffRoutes, createPrintHandoffServices} from '../dist/print-handoff-http.js';
import {DispatchedPrintError, HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';

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
  return {root, server, headers, calls, printHandoff};
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

function answerFixturePrompts(f) {
  f.printHandoff.relay.subscribe(pending => {
    const content = {};
    const properties = pending.requestedSchema?.properties ?? {};
    if ('confirmed' in properties) content.confirmed = true;
    if ('bambu_model' in properties) content.bambu_model = 'p1s';
    setImmediate(() => f.printHandoff.relay.respond(pending.id, {action: 'accept', content}));
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

async function finishPrintOverHttp(f, path, action = 'accept') {
  const deadline = Date.now() + 20000;
  let confirmations = 0;
  while (Date.now() < deadline) {
    const pending = await wire(f, '/v1/printer-handoff/elicitations');
    assert.equal(pending.status, 200, pending.bytes.toString());
    for (const item of json(pending).elicitations) {
      assert.equal(item.requestedSchema.properties.confirmed.type, 'boolean');
      const answer = action === 'accept' ? {action, content: {confirmed: true}} : {action};
      const responded = await wire(f, `/v1/printer-handoff/elicitations/${item.id}/respond`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(answer),
      });
      assert.equal(responded.status, 200, responded.bytes.toString());
      confirmations++;
    }
    const status = await wire(f, path);
    assert.equal(status.status, 200, status.bytes.toString());
    const result = json(status);
    if (!result.printing) return {...result, confirmations};
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Fixture print did not finish within 20 seconds');
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
  const uppercase = await wire(f, `/v1/printer-handoff/bundles/${bundle.id.toUpperCase()}`);
  assert.equal(uppercase.status, 200);
  assert.equal(json(uppercase).bundle.id, bundle.id);
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

test('a malformed prompt header does not wedge later bundle uploads', async t => {
  const f = await fixture(t);
  const bad = await wire(f, '/v1/printer-handoff/bundles', {
    method: 'POST',
    headers: {'content-type': 'model/stl', 'x-handoff-prompt': '%'},
    body: stl,
  });
  assert.equal(bad.status, 400);
  const bundle = await createBundle(f);
  assert.equal(bundle.status, 'ready');
});

test('print runs through the fixture MCP server with phone-answered elicitation', async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f);
  const started = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(started.status, 202, started.bytes.toString());
  assert.equal((await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'})).status, 409);
  let answered = 0;
  let sawSnapshot = false;
  let final;
  for (let attempt = 0; attempt < 200; attempt++) {
    const pending = json(await wire(f, '/v1/printer-handoff/elicitations')).elicitations;
    for (const item of pending) {
      if (item.cameraSnapshot?.base64 === 'ZmFrZQ==') sawSnapshot = true;
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
  assert.equal(sawSnapshot, true);
  const again = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(again.status, 409);
  assert.equal(json(again).error.code, 'already-printed');
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

test('an output persistence failure after dispatch cannot make a bundle printable again', async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f);
  f.printHandoff.store.recordArtifact = async () => {
    throw Object.assign(new Error('/private/operator/output failed'), {code: 'record-failed'});
  };
  answerFixturePrompts(f);
  assert.equal((await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'})).status, 202);
  let final;
  for (let attempt = 0; attempt < 200; attempt++) {
    final = json(await wire(f, `/v1/printer-handoff/bundles/${bundle.id}`));
    if (!final.printing) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(final.printing, false);
  assert.equal(final.bundle.status, 'printed');
  assert.equal(final.bundle.failure, 'record-failed');
  const retry = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(retry.status, 409);
  assert.equal(json(retry).error.code, 'already-printed');
  assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, 1);
});

for (const failedWrites of [2, Infinity]) {
  test(`dispatch cannot be replayed when printed status writes fail (${failedWrites})`, async t => {
    const f = await fixture(t);
    const bundle = await createBundle(f);
    const setStatus = f.printHandoff.store.setStatus.bind(f.printHandoff.store);
    let writes = 0;
    f.printHandoff.store.setStatus = async (...args) => {
      if (args[1] === 'printed' && ++writes <= failedWrites) {
        throw Object.assign(new Error('fixture disk full'), {code: 'ENOSPC'});
      }
      return setStatus(...args);
    };
    answerFixturePrompts(f);
    const path = `/v1/printer-handoff/bundles/${bundle.id}`;
    assert.equal((await wire(f, `${path}/print`, {method: 'POST'})).status, 202);
    let final;
    for (let attempt = 0; attempt < 200; attempt++) {
      final = json(await wire(f, path));
      if (!final.printing) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(final.printing, false);
    assert.equal(final.bundle.status, 'printed');
    assert.equal(final.bundle.failure, 'print-failed');
    assert.equal(json(await wire(f, '/v1/printer-handoff/bundles')).bundles[0].status, 'printed');
    const retry = await wire(f, `${path}/print`, {method: 'POST'});
    assert.equal(retry.status, 409);
    assert.equal(json(retry).error.code, 'already-printed');
    assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, 1);
  });
}

for (const [pauseAt, outputFailure, revokeOnRetry] of [
  ['authorization', true, false],
  ['storage', false, false],
  ['authorization', false, true],
]) {
  test(`status read overlapping completion stays consistent (${pauseAt}, output failure=${outputFailure}, revoked=${revokeOnRetry})`, {timeout: 5000}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'print-status-race-'));
    const store = new HandoffBundleStore(root);
    const bundle = await store.create({stl, prompt: 'one dispatch', backend: 'bambu-printer-mcp'});
    const dispatch = Promise.withResolvers();
    const finishDispatch = Promise.withResolvers();
    const pausedRead = Promise.withResolvers();
    const finishRead = Promise.withResolvers();
    const routes = createPrintHandoffRoutes({
      store, relay: new InMemoryElicitationRelay(),
      runner: {backend: 'bambu-printer-mcp', async runBundle(store, id) {
        await store.setStatus(id, 'uncertain', 'dispatch-uncertain');
        dispatch.resolve();
        await finishDispatch.promise;
        if (outputFailure) throw new DispatchedPrintError(new Error('fixture output persistence failed'));
        await store.setStatus(id, 'printed');
      }},
    });
    let pauseStatusRead = true;
    let pauseStorage = false;
    const read = store.read.bind(store);
    store.read = async (...args) => {
      const manifest = await read(...args);
      if (pauseStorage) {
        pauseStorage = false;
        pausedRead.resolve();
        await finishRead.promise;
      }
      return manifest;
    };
    const server = createServer(async (request, response) => {
      let checks = 0;
      await routes.handle(request, response, async () => {
        if (request.method !== 'GET') return;
        checks++;
        if (checks > 2 && revokeOnRetry) throw new RemoteAuthFailure('forbidden');
        if (checks === 2 && pauseAt === 'authorization' && pauseStatusRead) {
          pauseStatusRead = false;
          pausedRead.resolve();
          await finishRead.promise;
        }
      }, () => undefined);
    });
    t.after(async () => {
      finishDispatch.resolve();
      finishRead.resolve();
      await routes.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, {recursive: true, force: true});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = {server: {url: `http://127.0.0.1:${server.address().port}`}, headers: {}};
    const path = `/v1/printer-handoff/bundles/${bundle.id}`;
    assert.equal((await wire(f, `${path}/print`, {method: 'POST'})).status, 202);
    await dispatch.promise;
    pauseStorage = pauseAt === 'storage';
    const staleRead = wire(f, path);
    await pausedRead.promise;
    finishDispatch.resolve();
    // close waits for terminal persistence and the in-memory dispatch fallback
    // to be cleared. The already-authorized GET remains paused with its old read.
    await routes.close();
    assert.equal((await store.read(bundle.id)).status, 'printed');
    finishRead.resolve();
    const response = await staleRead;
    if (revokeOnRetry) {
      assert.equal(response.status, 403);
      assert.equal(json(response).error.code, 'forbidden');
      assert.equal(json(response).bundle, undefined);
      return;
    }
    assert.equal(response.status, 200);
    const result = json(response);
    assert.equal(result.printing, false);
    assert.equal(result.bundle.status, 'printed');
    assert.equal(result.bundle.failure, outputFailure ? 'print-failed' : undefined);
  });
}

for (const shutdown of [false, true]) {
  test(`pending print admission is exclusive and obeys shutdown (${shutdown})`, {timeout: 5000}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'print-admission-'));
    const store = new HandoffBundleStore(root);
    const bundle = await store.create({stl, prompt: 'one dispatch', backend: 'bambu-printer-mcp'});
    let releaseAuthorization;
    let authorizationReached;
    const paused = new Promise(resolve => { authorizationReached = resolve; });
    const release = new Promise(resolve => { releaseAuthorization = resolve; });
    let runs = 0;
    let requests = 0;
    const routes = createPrintHandoffRoutes({
      store, relay: new InMemoryElicitationRelay(),
      runner: {backend: 'bambu-printer-mcp', async runBundle(store, id) {
        runs++;
        await store.setStatus(id, 'printed');
      }},
    });
    const server = createServer(async (request, response) => {
      const ordinal = ++requests;
      let checks = 0;
      await routes.handle(request, response, async () => {
        if (ordinal === 1 && ++checks === 2) {
          authorizationReached();
          await release;
        }
      }, () => undefined);
    });
    t.after(async () => {
      releaseAuthorization();
      await routes.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, {recursive: true, force: true});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = {server: {url: `http://127.0.0.1:${server.address().port}`}, headers: {}};
    const path = `/v1/printer-handoff/bundles/${bundle.id}/print`;
    const first = wire(f, path, {method: 'POST'});
    await paused;
    if (shutdown) {
      const stopped = routes.close();
      releaseAuthorization();
      await stopped;
      assert.equal((await first).status, 503);
      assert.equal((await wire(f, path, {method: 'POST'})).status, 503);
      assert.equal(runs, 0);
      return;
    }
    const second = await wire(f, path, {method: 'POST'});
    releaseAuthorization();
    const accepted = await first;
    assert.equal(second.status, 409);
    assert.equal(json(second).error.code, 'print-busy');
    assert.equal(accepted.status, 202);
    await routes.close();
    assert.equal(runs, 1);
  });
}

for (const [command, scopes] of [
  ['pair-capture', ['generation:health', 'projects:read', 'projects:write', 'captures:read', 'captures:import']],
  ['pair-printer-handoff', ['generation:health', 'printer-handoff:use']],
  ['pair-capture-and-printer-handoff', ['generation:health', 'projects:read', 'projects:write', 'captures:read', 'captures:import', 'printer-handoff:use']],
]) {
  test(`${command} grants exactly its explicit scopes`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'handoff-pairing-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    const directory = join(root, 'auth');
    const store = await RemoteAuthStore.create(directory, {
      host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'],
    });
    const {stdout} = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../dist/remote-auth-cli.js', import.meta.url)), command, directory, 'alice@example.test',
    ]);
    const phone = await store.exchange('alice@example.test', {code: JSON.parse(stdout).code, deviceName: 'Fixture'});
    assert.deepEqual(phone.scopes, scopes);
    for (const scope of scopes) await store.authorize('alice@example.test', phone.deviceId, phone.token, scope);
  });
}

for (const action of ['decline', 'cancel']) {
  test(`HTTP ${action} resolves a pending elicitation exactly once`, async t => {
    const f = await fixture(t);
    const answer = f.printHandoff.relay.request({
      method: 'elicitation/create',
      params: {
        mode: 'form', message: 'Print this?',
        requestedSchema: {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']},
      },
    });
    const [pending] = f.printHandoff.relay.pending();
    const respond = () => wire(f, `/v1/printer-handoff/elicitations/${pending.id.toUpperCase()}/respond`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action}),
    });
    assert.equal((await respond()).status, 200);
    assert.deepEqual(await answer, {action});
    assert.deepEqual(f.printHandoff.relay.pending(), []);
    assert.equal((await respond()).status, 404);
  });
}

test('elicitation answers are limited to what the printer server asked', async t => {
  const f = await fixture(t, ['printer-handoff:use'], root => ({
    store: new HandoffBundleStore(join(root, 'bundles-answer')),
    relay: new InMemoryElicitationRelay({timeoutMs: 5000}),
    runner: {backend: 'bambu-printer-mcp', runBundle: async () => { throw new Error('unused'); }},
    selection,
  }));
  const relay = f.printHandoff.relay;
  const answerPromise = relay.request({
    method: 'elicitation/create',
    params: {
      mode: 'form', message: 'Print this?',
      requestedSchema: {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']},
    },
  });
  const [pending] = relay.pending();
  const respond = content => wire(f, `/v1/printer-handoff/elicitations/${pending.id.toUpperCase()}/respond`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({action: 'accept', content}),
  });
  const smuggled = await respond({confirmed: true, bambu_model: 'x1c'});
  assert.equal(smuggled.status, 400);
  assert.equal(json(smuggled).error.code, 'invalid-answer');
  assert.equal((await respond({confirmed: 'yes'})).status, 400);
  assert.equal((await respond({})).status, 400);
  assert.equal(relay.pending().length, 1);
  assert.equal((await respond({confirmed: true})).status, 200);
  assert.deepEqual(await answerPromise, {action: 'accept', content: {confirmed: true}});
});

test('a retained uncertain dispatch is visible and cannot be printed again', async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f);
  await f.printHandoff.store.setStatus(bundle.id, 'uncertain', 'dispatch-uncertain');
  assert.equal(json(await wire(f, `/v1/printer-handoff/bundles/${bundle.id}`)).bundle.status, 'uncertain');
  const retry = await wire(f, `/v1/printer-handoff/bundles/${bundle.id}/print`, {method: 'POST'});
  assert.equal(retry.status, 409);
  assert.equal(json(retry).error.code, 'dispatch-uncertain');
  assert.equal((await f.calls()).length, 0);
});

for (const dispatch of ['crash', 'timeout']) {
  test(`HTTP fixture ${dispatch} leaves an uncertain bundle that cannot replay after restart`, {timeout: 30000}, async t => {
    const servicesFor = root => createPrintHandoffServices({
      backend: 'bambu-printer-mcp',
      process: {
        command: process.execPath, args: [fixtureServer, 'bambu', join(root, 'calls.jsonl')], cwd: root,
        env: {HANDOFF_FIXTURE_DISPATCH: dispatch},
      },
      selection,
      timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 10000},
    }, join(root, 'bundles'));
    const f = await fixture(t, ['printer-handoff:use'], servicesFor);
    const bundle = await createBundle(f);
    const path = `/v1/printer-handoff/bundles/${bundle.id}`;
    assert.equal((await wire(f, `${path}/print`, {method: 'POST'})).status, 202);
    const final = await finishPrintOverHttp(f, path);
    assert.equal(final.confirmations, 1);
    assert.equal(final.bundle.status, 'uncertain');
    assert.equal(final.bundle.failure, 'dispatch-uncertain');
    assert.deepEqual((await f.calls()).filter(item => item.tool).map(item => item.tool),
      ['lay_flat', 'slice_stl', 'inspect_print_file', 'camera_snapshot', 'print_3mf']);
    assert.deepEqual((await f.calls()).filter(item => item.elicitation).map(item => item.elicitation),
      [{action: 'accept', content: {confirmed: true}}]);
    for (const restart of [false, true]) {
      let client = f;
      if (restart) {
        await f.server.close();
        const server = await startCompanionServer({port: 0,
          remoteAuth: await RemoteAuthStore.open(join(f.root, 'auth')), printHandoff: servicesFor(f.root)});
        t.after(() => server.close());
        client = {...f, server};
      }
      const status = json(await wire(client, path));
      assert.equal(status.printing, false);
      assert.equal(status.bundle.status, 'uncertain');
      assert.equal(status.bundle.failure, 'dispatch-uncertain');
      const retry = await wire(client, `${path}/print`, {method: 'POST'});
      assert.equal(retry.status, 409);
      assert.equal(json(retry).error.code, 'dispatch-uncertain');
    }
    assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, 1);
  });
}

test('HTTP successful retry of a declined print clears its persisted failure', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const bundle = await createBundle(f);
  const path = `/v1/printer-handoff/bundles/${bundle.id}`;
  assert.equal((await wire(f, `${path}/print`, {method: 'POST'})).status, 202);
  const declined = await finishPrintOverHttp(f, path, 'decline');
  assert.equal(declined.confirmations, 1);
  assert.equal(declined.bundle.status, 'failed');
  assert.equal(declined.bundle.failure, 'tool-failed');
  assert.equal((await wire(f, `${path}/print`, {method: 'POST'})).status, 202);
  const retried = await finishPrintOverHttp(f, path);
  assert.equal(retried.confirmations, 1);
  assert.equal(retried.bundle.status, 'printed');
  assert.equal(Object.hasOwn(retried.bundle, 'failure'), false);
  assert.ok(retried.bundle.artifacts.sliced);
  assert.ok(retried.bundle.artifacts.oriented);
  const listed = json(await wire(f, '/v1/printer-handoff/bundles')).bundles.find(item => item.id === bundle.id);
  assert.equal(listed.status, 'printed');
  assert.equal(Object.hasOwn(listed, 'failure'), false);
  assert.deepEqual((await f.calls()).filter(item => item.elicitation).map(item => item.elicitation.action), ['decline', 'accept']);
  const replay = await wire(f, `${path}/print`, {method: 'POST'});
  assert.equal(replay.status, 409);
  assert.equal(json(replay).error.code, 'already-printed');
  assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, 2);
});
