// /v1/mcp (docs/design/remote-mcp.md): the SDK's real Streamable HTTP client against the companion on loopback,
// with Serve's forwarded headers, and a fake stdio printer MCP on the destination's shared session.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {createPrintHandoffServices} from '../dist/print-handoff-http.js';
import {PrinterSessionPool, toolClass, callClass} from '@scan-to-make/printer-handoff';

const sdk = path => new URL(`../../printer-handoff/node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`, import.meta.url).href;
const {Client} = await import(sdk('client/index.js'));
const {StreamableHTTPClientTransport} = await import(sdk('client/streamableHttp.js'));

const forwarded = JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8')).expected;
const peer = fileURLToPath(new URL('../../printer-handoff/tests/fixtures/remote-mcp-peer.mjs', import.meta.url));
const LOGIN = 'alice@example.test';

/** fetch over node:http, so the Serve headers (Host included) reach the companion exactly as Serve sends them. */
function serveFetch(extra) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const headers = {...forwarded, ...Object.fromEntries(new Headers(init.headers ?? {}).entries()), ...extra};
    const req = httpRequest(String(url), {method: init.method ?? 'GET', headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode;
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, {status, headers: Object.entries(res.headers).flatMap(([k, v]) => [v].flat().map(x => [k, String(x)]))}));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body ?? undefined);
  });
}

async function setup(t, {scopes = ['mcp:read'], admit, lockTimeoutMs, questionMs = 5000, toolTimeoutMs, selection} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'remote-mcp-')));
  const pool = new PrinterSessionPool();
  t.after(async () => { await pool.close(); await rm(root, {recursive: true, force: true}); });
  const auth = await RemoteAuthStore.create(join(root, 'auth'), {host: forwarded.host, allowedLogins: [LOGIN]});
  const pair = async (granted, name = 'Cloud session') => {
    const invitation = await auth.createPairing(LOGIN, granted);
    return auth.exchange(LOGIN, {code: invitation.code, deviceName: name});
  };
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const bundles = join(root, 'bundles');
  await mkdir(bundles);
  const printHandoff = createPrintHandoffServices({
    backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [peer, log], cwd: root},
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 1500}, ...(selection ? {selection} : {}),
  }, bundles, {pool, destinationId: 'current'});
  const session = printHandoff.runner.session;
  // A second configured printer with its own MCP process and log.
  const otherLog = join(root, 'other.jsonl');
  await writeFile(otherLog, '');
  const other = createPrintHandoffServices({
    backend: 'mcp-3d-printer-server', process: {command: process.execPath, args: [peer, otherLog], cwd: root},
    selection: {host: '192.0.2.7', printerType: 'bambu', port: '8883'},
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 1500},
  }, bundles, {pool, destinationId: 'workshop'});
  const server = await startCompanionServer({port: 0, remoteAuth: auth, printHandoff, remoteMcp: {
    bundleRoot: bundles, destinations: () => new Map([['current', {session, relay: printHandoff.relay}],
      ['workshop', {session: other.runner.session, relay: other.relay}]]),
    questionMs, ...(admit ? {admit} : {}), ...(lockTimeoutMs ? {lockTimeoutMs} : {}), ...(toolTimeoutMs ? {toolTimeoutMs} : {}),
  }});
  t.after(() => server.close());
  const device = await pair(scopes);
  const connect = async (credential = device, path = '/v1/mcp') => {
    const client = new Client({name: 'remote-test', version: '1'});
    const headers = credential ? {authorization: `Bearer ${credential.token}`, 'x-scan-device': credential.deviceId} : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url + path), {fetch: serveFetch(headers)}));
    t.after(() => client.close());
    return client;
  };
  const calls = async (file = log) => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const raw = (path, headers, body = '{}') => serveFetch(headers)(server.url + path, {method: 'POST',
    headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body});
  return {root, bundles, auth, pair, device, connect, calls, raw, printHandoff, session, server, otherLog, other};
}
const text = result => result.content.map(item => item.text).join(' ');

test('the front door: no token, wrong login, a revoked device and a non-MCP device are refused', async t => {
  const f = await setup(t);
  const headers = {authorization: `Bearer ${f.device.token}`, 'x-scan-device': f.device.deviceId};
  assert.equal((await f.raw('/v1/mcp', {})).status, 401);
  assert.equal((await f.raw('/v1/mcp', {...headers, 'tailscale-user-login': 'mallory@example.test'})).status, 403);
  assert.equal((await f.raw('/v1/mcp', {...headers, 'tailscale-funnel-request': '?1'})).status, 403);
  assert.equal((await f.raw('/v1/mcp', {...headers, origin: 'https://evil.example'})).status, 403);
  const phone = await f.pair(['generation:health', 'printer-handoff:use'], 'Phone');
  assert.equal((await f.raw('/v1/mcp', {authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId})).status, 403);
  assert.equal((await f.raw('/v1/mcp/nowhere', headers)).status, 404);
  await f.auth.revoke(f.device.deviceId);
  assert.equal((await f.raw('/v1/mcp', headers)).status, 401);
  assert.deepEqual(await f.calls(), []);
});

test('classes come only from what the MCP declares (_meta["counterpart/remote"]); an undeclared tool is raw', () => {
  const declared = (scope, extra = {}) => ({_meta: {'counterpart/remote': {scope, ...extra}}});
  assert.equal(toolClass({name: 'get_printer_status', ...declared('read')}), 'read');
  assert.equal(toolClass({name: 'print_3mf', ...declared('print')}), 'print');
  // No tool name or annotation is read: a tool's name never makes it more trusted or less (PRD §8.0 item 5).
  assert.equal(toolClass({name: 'get_printer_status'}), 'raw', 'an MCP from before the declarations');
  assert.equal(toolClass({name: 'peek', annotations: {readOnlyHint: true}}), 'raw', 'annotations are hints, not scopes');
  assert.equal(toolClass({name: 'peek', ...declared('everything')}), 'raw', 'an unknown scope is raw');
  assert.equal(toolClass({name: 'set_light', annotations: {readOnlyHint: true}, ...declared('control')}), 'control');
  const status = {name: 'fusion_mcp_status', ...declared('read', {raisedBy: {launch: 'design', other: 'nonsense'}})};
  assert.equal(callClass(status, {launch: true}), 'design');
  assert.equal(callClass(status, {launch: 'yes'}), 'read', 'only a true argument raises it');
  assert.equal(callClass(status, {}), 'read');
  assert.equal(callClass({name: 'x', ...declared('print', {raisedBy: {launch: 'design'}})}, {launch: true}), 'print', 'never lowered');
});

test('tools/list is filtered by scope and calls outside scope never reach the MCP', async t => {
  const f = await setup(t, {scopes: ['mcp:read', 'mcp:design']});
  const client = await f.connect();
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['ask', 'fusion_mcp_status', 'get_printer_status', 'peek', 'shape', 'slice_stl']);
  // Keys the device may not set are not offered: a schema-following client is never refused for them.
  const slice = (await client.listTools()).tools.find(tool => tool.name === 'slice_stl');
  assert.deepEqual(slice.inputSchema.required, ['stl_path']);
  for (const key of ['bambu_model', 'host', 'port', 'type', 'bridge_command', 'nozzle_diameter']) assert.equal(key in slice.inputSchema.properties, false, key);
  assert.ok('stl_path' in slice.inputSchema.properties);
  for (const name of ['print_3mf', 'set_light', 'mystery', 'bambu_network_call', 'nonexistent']) {
    const result = await client.callTool({name, arguments: {}});
    assert.equal(result.isError, true);
    assert.match(text(result), /not available to this device/);
  }
  assert.equal(text(await client.callTool({name: 'get_printer_status', arguments: {}})), 'get_printer_status ok');
  assert.deepEqual((await f.calls()).map(call => call.tool), ['get_printer_status']);
  const raw = await f.connect(await f.pair(['mcp:read', 'mcp:raw'], 'Raw'));
  const result = await raw.callTool({name: 'mystery', arguments: {}});
  assert.equal(result.isError, true);
  assert.equal(text(result), 'raw error passes through', 'tool errors pass through unchanged');
});

test('arguments: selectors, relative paths, .., list escapes, embedded paths, symlinks and writes outside the device folder are refused', async t => {
  const f = await setup(t, {scopes: ['mcp:read', 'mcp:design']});
  const client = await f.connect();
  const own = join(f.bundles, 'remote', f.device.deviceId);
  await mkdir(own, {recursive: true});
  await writeFile(join(own, 'part.stl'), 'solid x');
  await writeFile(join(f.bundles, 'bundle.3mf'), 'pk');
  await symlink('/etc/hosts', join(own, 'link.stl'));
  const refused = async (name, args, reason) => {
    const result = await client.callTool({name, arguments: args});
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(text(result), reason, JSON.stringify(args));
  };
  await refused('peek', {host: '10.0.0.9'}, /Argument host refused/);
  await refused('peek', {nested: {bridge_command: 'node'}}, /nested.bridge_command refused/);
  await refused('peek', {stl_path: 'part.stl'}, /absolute/);
  await refused('peek', {stl_path: `${own}/../../../../etc/hosts`}, /\.\./);
  await refused('shape', {slicer_profile: `${own}/part.stl;/etc/hosts`}, /outside/);
  await refused('shape', {note: 'boolean_union:/etc/hosts'}, /only in path arguments/);
  await refused('peek', {stl_path: join(own, 'link.stl')}, /symbolic links/);
  await refused('shape', {stl_path: join(f.bundles, 'bundle.3mf')}, /outside/);
  await refused('shape', {output_path: join(f.bundles, 'bundle.3mf')}, /outside/);
  await refused('peek', {save_path: join(f.bundles, 'bundle.3mf')}, /outside/);
  const other = join(f.bundles, 'remote', '00000000-0000-4000-8000-000000000000');
  await mkdir(other, {recursive: true});
  await writeFile(join(other, 'theirs.stl'), 'solid y');
  await refused('peek', {stl_path: join(other, 'theirs.stl')}, /outside/);
  assert.deepEqual(await f.calls(), [], 'nothing refused reached the MCP');
  assert.equal(text(await client.callTool({name: 'peek', arguments: {stl_path: join(f.bundles, 'bundle.3mf'), save_path: join(own, 'shot.jpg')}})), 'peek ok');
  assert.equal(text(await client.callTool({name: 'shape', arguments: {stl_path: join(own, 'part.stl'), output_path: join(own, 'out.stl'), note: 'make it 2 mm taller'}})), 'shape ok');
  // A Fusion archive to reopen is a path: confined like the others, accepted inside the device folder.
  await writeFile(join(own, 'saved.f3d'), 'f3d');
  assert.equal(text(await client.callTool({name: 'shape', arguments: {source_f3d: join(own, 'saved.f3d')}})), 'shape ok');
  await refused('shape', {source_f3d: join(f.bundles, 'bundle.3mf')}, /outside/);
  assert.equal((await f.calls()).length, 3);
});

test('prompts and listed resources pass through unchanged; templates and unlisted URIs do not', async t => {
  const f = await setup(t);
  const client = await f.connect();
  assert.ok(client.getServerCapabilities().prompts && client.getServerCapabilities().resources);
  assert.equal((await client.listPrompts()).prompts[0].description, 'Call slice_stl after lay_flat.');
  assert.equal((await client.getPrompt({name: 'fdm_guide', arguments: {topic: 'walls'}})).messages[0].content.text, 'Guide on walls: call slice_stl.');
  await assert.rejects(client.getPrompt({name: 'fdm_guide', arguments: {topic: '/etc/hosts'}}), /only in path arguments/);
  const listed = await client.listResources();
  assert.deepEqual(listed.resources.map(resource => resource.uri), ['printer://10.0.0.5/status', 'printer://10.0.0.5/broken']);
  assert.equal(listed.templates, undefined);
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
  assert.equal((await client.readResource({uri: 'printer://10.0.0.5/status'})).contents[0].text, '{"state":"IDLE"}');
  await assert.rejects(client.readResource({uri: 'printer://10.0.0.9/status'}), /Only listed resources/);
  assert.deepEqual((await f.calls()).filter(call => call.resource).map(call => call.resource), ['printer://10.0.0.5/status']);
});

test('a remote question goes to the owner tagged with the device; the asking device cannot answer it, a phone can', async t => {
  const f = await setup(t, {scopes: ['mcp:read']});
  const client = await f.connect();
  // The asking device has no relay scope at all.
  const self = await f.raw('/v1/printer-handoff/elicitations', {authorization: `Bearer ${f.device.token}`, 'x-scan-device': f.device.deviceId});
  assert.equal(self.status, 403);
  const phone = await f.pair(['generation:health', 'printer-handoff:use'], 'Phone');
  const phoneHeaders = {authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId};
  const asked = client.callTool({name: 'ask', arguments: {}});
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    const listed = await serveFetch(phoneHeaders)(f.server.url + '/v1/printer-handoff/elicitations');
    pending = (await listed.json()).elicitations[0];
    if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pending.remoteDeviceId, f.device.deviceId);
  assert.equal(pending.remoteDeviceName, 'Cloud session');
  assert.equal(pending.bundleId, undefined);
  const answered = await f.raw(`/v1/printer-handoff/elicitations/${pending.id}/respond`, phoneHeaders,
    JSON.stringify({action: 'accept', content: {confirmed: true}}));
  assert.equal(answered.status, 200, await answered.text());
  assert.equal(text(await asked), 'ask ok');
});

test('the device that asked cannot answer its own question, even if it also holds the relay scope', async t => {
  const f = await setup(t, {scopes: ['mcp:read', 'printer-handoff:use']});
  const client = await f.connect();
  const headers = {authorization: `Bearer ${f.device.token}`, 'x-scan-device': f.device.deviceId};
  const asked = client.callTool({name: 'ask', arguments: {}});
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    pending = f.printHandoff.relay.pending()[0];
    if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  const refused = await f.raw(`/v1/printer-handoff/elicitations/${pending.id}/respond`, headers,
    JSON.stringify({action: 'accept', content: {confirmed: true}}));
  assert.equal(refused.status, 403);
  // Unanswered, it times out as cancel: fail closed.
  const result = await asked;
  assert.equal(result.isError, true);
  assert.match(text(result), /Declined/);
});

test('a remote call waits for the app holding the session mutex, and its question never borrows the app tag', async t => {
  const f = await setup(t, {scopes: ['mcp:read']});
  const client = await f.connect();
  let release;
  const held = f.session.exclusive(() => new Promise(resolve => { release = resolve; }));
  const asked = client.callTool({name: 'ask', arguments: {}});
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual((await f.calls()).filter(call => call.tool), [], 'queued behind the app');
  release();
  await held;
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    pending = f.printHandoff.relay.pending()[0];
    if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pending.remoteDeviceId, f.device.deviceId);
  f.printHandoff.relay.respond(pending.id, {action: 'accept', content: {confirmed: true}});
  assert.equal(text(await asked), 'ask ok');
});

test('the mutex wait is bounded, and a device revoked while queued never dispatches', async t => {
  const f = await setup(t, {scopes: ['mcp:read'], lockTimeoutMs: 300});
  const client = await f.connect();
  let release;
  const held = f.session.exclusive(() => new Promise(resolve => { release = resolve; }));
  const busy = await client.callTool({name: 'peek', arguments: {}});
  assert.match(text(busy), /busy/);
  release();
  await held;
  const g = await setup(t, {scopes: ['mcp:read']});
  const other = await g.connect();
  let free;
  const holding = g.session.exclusive(() => new Promise(resolve => { free = resolve; }));
  const queued = other.callTool({name: 'peek', arguments: {}});
  await new Promise(resolve => setTimeout(resolve, 100));
  await g.auth.revoke(g.device.deviceId);
  free();
  await holding;
  const result = await queued;
  assert.equal(result.isError, true);
  assert.deepEqual((await g.calls()).filter(call => call.tool), []);
});

test('design, control and print calls are admitted by the print gate; an update refuses them', async t => {
  const admitted = [];
  let updating = false;
  const f = await setup(t, {scopes: ['mcp:read', 'mcp:design', 'mcp:control', 'mcp:print'], admit: id => {
    if (updating) { const error = new Error("The printer's software is updating. Try again in a minute."); error.name = 'PrinterUpdatingError'; throw error; }
    admitted.push(id); return () => admitted.push(`released ${id}`);
  }});
  const client = await f.connect();
  assert.equal(text(await client.callTool({name: 'set_light', arguments: {}})), 'set_light ok');
  assert.equal(text(await client.callTool({name: 'peek', arguments: {}})), 'peek ok');
  assert.equal(text(await client.callTool({name: 'shape', arguments: {}})), 'shape ok');
  assert.deepEqual(admitted, ['current', 'released current', 'current', 'released current'], 'set_light and shape; not the read');
  updating = true;
  assert.match(text(await client.callTool({name: 'print_3mf', arguments: {}})), /updating/);
  assert.match(text(await client.callTool({name: 'shape', arguments: {}})), /updating/);
  assert.deepEqual((await f.calls()).map(call => call.tool), ['set_light', 'peek', 'shape']);
});

test('a client that disconnects mid-call does not quarantine the shared session', async t => {
  const f = await setup(t, {scopes: ['mcp:read']});
  const headers = {authorization: `Bearer ${f.device.token}`, 'x-scan-device': f.device.deviceId};
  const controller = new AbortController();
  const body = JSON.stringify([
    {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'x', version: '1'}}},
  ]);
  await f.raw('/v1/mcp', headers, body);
  const call = JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'peek', arguments: {ms: 400}}});
  const req = httpRequest(f.server.url + '/v1/mcp', {method: 'POST', signal: controller.signal, headers: {...forwarded, ...headers,
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18'}});
  req.on('error', () => undefined);
  req.end(call);
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(f.session.health().connected, true);
  assert.equal(f.session.health().consecutiveFailures, 0);
  assert.deepEqual((await f.calls()).map(call => call.tool), ['peek']);
});

test('by default a remote question is cancelled at once, so it never holds the mutex waiting for a screen', async t => {
  const f = await setup(t, {scopes: ['mcp:read'], questionMs: 0});
  const client = await f.connect();
  const started = Date.now();
  const result = await client.callTool({name: 'ask', arguments: {}});
  assert.match(text(result), /Declined/);
  assert.ok(Date.now() - started < 1000, 'answered without waiting out the relay timeout');
  assert.deepEqual((await f.calls()).find(call => call.answer).answer, {action: 'cancel'});
});

test('the printer model and nozzle come from the destination config; a caller cannot set them', async t => {
  const f = await setup(t, {scopes: ['mcp:read', 'mcp:design'], selection: {model: 'p1s', nozzleDiameterMm: 0.4}});
  const client = await f.connect();
  assert.equal(text(await client.callTool({name: 'peek', arguments: {}})), 'peek ok');
  assert.deepEqual((await f.calls())[0].args, {bambu_model: 'p1s', nozzle_diameter: '0.4'});
  assert.match(text(await client.callTool({name: 'peek', arguments: {bambu_model: 'x1c'}})), /bambu_model refused/);
  // Starting a program needs design, not read.
  const reader = await f.connect(await f.pair(['mcp:read'], 'Reader'));
  assert.match(text(await reader.callTool({name: 'fusion_mcp_status', arguments: {launch: true}})), /not available/);
  assert.equal(text(await reader.callTool({name: 'fusion_mcp_status', arguments: {}})), 'fusion_mcp_status ok');
  assert.equal(text(await client.callTool({name: 'fusion_mcp_status', arguments: {launch: true}})), 'fusion_mcp_status ok');
});

test('a question a prompt asks is tagged with the remote device, not left untagged', async t => {
  const f = await setup(t, {scopes: ['mcp:read']});
  const client = await f.connect();
  const asked = client.getPrompt({name: 'ask_prompt'});
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    pending = f.printHandoff.relay.pending()[0];
    if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pending.remoteDeviceId, f.device.deviceId);
  f.printHandoff.relay.respond(pending.id, {action: 'cancel'});
  await asked;
});

// Every argument key in both upstream MCPs must be classed: refused, path, injected or known plain.
// Skipped (visibly) where the sibling repos are not checked out, as on the Linux CI boxes.
test('a server error on a prompt or resource is returned as it is and never ends the shared session', async t => {
  const f = await setup(t);
  const client = await f.connect();
  await assert.rejects(client.getPrompt({name: 'nope'}), error => /Prompt nope not found/.test(error.message) && (error.message.match(/MCP error/g) ?? []).length === 1);
  await assert.rejects(client.readResource({uri: 'printer://10.0.0.5/broken'}), /printer offline/);
  assert.equal(f.session.health().connected, true);
  // The app's own unexclusive read on the same session still works without a reconnect.
  const result = await f.session.call('get_printer_status', {}, {forwardResult: true});
  assert.equal(result.content[0].text, 'get_printer_status ok');
  assert.equal(f.session.health().consecutiveFailures, 0);
});

test('remote prompts and resources are limited by the remote call timeout and rechecked after the mutex', async t => {
  const f = await setup(t, {toolTimeoutMs: 300});
  const client = await f.connect();
  // The prompt takes 2 s; the remote limit (300 ms) ends it, then the session reconnects as after any abandoned call.
  await assert.rejects(client.getPrompt({name: 'slow_prompt'}), /timed out/);
  let release;
  const held = f.session.exclusive(() => new Promise(resolve => { release = resolve; }));
  const queued = client.getPrompt({name: 'fdm_guide', arguments: {topic: 'walls'}});
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.auth.revoke(f.device.deviceId);
  release();
  await held;
  await assert.rejects(queued, /no longer allowed/);
  assert.equal((await f.calls()).filter(call => call.prompt === 'fdm_guide').length, 0);
});

test('/v1/mcp/<destinationId> reaches that printer through its own session, never the other', async t => {
  const f = await setup(t);
  const workshop = await f.connect(f.device, '/v1/mcp/workshop');
  assert.equal(text(await workshop.callTool({name: 'peek', arguments: {}})), 'peek ok');
  assert.deepEqual((await f.calls(f.otherLog)).map(call => call.tool), ['peek']);
  assert.deepEqual((await f.calls()).filter(call => call.tool), []);
  assert.equal(f.session.health().connected, false, 'the current printer was never started for it');
});

test('mcp-3D-printer-server calls are pointed at the destination printer, as the app points them', async t => {
  const f = await setup(t);
  const workshop = await f.connect(f.device, '/v1/mcp/workshop');
  await workshop.callTool({name: 'peek', arguments: {}});
  assert.deepEqual((await f.calls(f.otherLog))[0].args, {host: '192.0.2.7', type: 'bambu', port: '8883'});
});

test('an oversized body is refused without being kept, and the companion keeps answering', async t => {
  const f = await setup(t);
  const headers = {...forwarded, authorization: `Bearer ${f.device.token}`, 'x-scan-device': f.device.deviceId,
    'content-type': 'application/json', accept: 'application/json, text/event-stream'};
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(f.server.url + '/v1/mcp', {method: 'POST', headers}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', error => (error.code === 'EPIPE' || error.code === 'ECONNRESET') ? resolve('closed') : reject(error));
    const chunk = Buffer.alloc(256 * 1024, 0x20);
    for (let i = 0; i < 16; i++) req.write(chunk); // 4 MiB, chunked
    req.end();
  });
  assert.ok(status === 413 || status === 'closed', String(status));
  const client = await f.connect();
  assert.equal(text(await client.callTool({name: 'peek', arguments: {}})), 'peek ok');
});

test('the body reader stops listening and keeps nothing once a body is too large', async () => {
  const {readBody} = await import('../dist/remote-mcp-http.js');
  const {PassThrough} = await import('node:stream');
  const request = new PassThrough();
  const read = readBody(request);
  request.write(Buffer.alloc(1024 * 1024));
  request.write(Buffer.alloc(1024));
  await assert.rejects(read, error => error.status === 413);
  assert.equal(request.listenerCount('data'), 0, 'no further chunks are counted or kept');
  request.end(Buffer.alloc(4 * 1024 * 1024));
});

test('a fresh install whose bundle store does not exist yet still answers remote calls', async t => {
  const f = await setup(t);
  await rm(f.bundles, {recursive: true, force: true});
  const client = await f.connect();
  assert.equal(text(await client.callTool({name: 'get_printer_status', arguments: {}})), 'get_printer_status ok');
  assert.equal((await client.getPrompt({name: 'fdm_guide', arguments: {topic: 'walls'}})).messages.length, 1);
});

test('destinations follow the live winner, and current is always the Mac printer', async () => {
  const {remoteDestinationsFor} = await import('../dist/remote-mcp-http.js');
  const services = name => ({runner: {session: {name}}, relay: {name}});
  const current = services('current'), studio = services('studio'), workshop = services('workshop');
  const live = new Map([['current', current], ['studio', studio], ['workshop', workshop]]);
  let winners = new Map([['current', 'current'], ['studio', 'studio'], ['workshop', 'workshop']]);
  const map = () => remoteDestinationsFor(live, id => winners.get(id), current);
  assert.equal(map().get('current').session.name, 'current');
  // A Printer MCP choice made while running: studio now wins for the Mac's printer; current's old entry is ignored.
  winners = new Map([['current', 'studio'], ['studio', 'studio'], ['workshop', 'workshop']]);
  assert.equal(map().get('current').session.name, 'studio');
  assert.equal(map().get('workshop').session.name, 'workshop');
  // The catalog left current out entirely: still served, by its winner, else the handoff's own services.
  live.delete('current');
  assert.equal(map().get('current').session.name, 'studio');
  assert.equal(remoteDestinationsFor(new Map(), () => undefined, current).get('current').session.name, 'current');
});
