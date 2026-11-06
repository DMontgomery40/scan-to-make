// The companion's Blender add-on check and repair: its states, the print gate and the helper lock. The printer MCP's
// blender_mcp_setup inspects and replaces the add-on (its own tests cover the file checks); here it is a stand-in
// that keeps the add-on's state the way the MCP reports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BlenderAddonRepair, BlenderSetupUnavailableError} from '../dist/touchup/addon-repair.js';
import {PrintGate} from '../dist/printing/print-gate.js';

/** blender_mcp_setup as the MCP answers it: installed and expected protocol, Blender listening, the live handshake. */
function mcp(state = {}) {
  const world = {installed: 1, expected: 15, listening: true, loaded: 1, handshake: true, calls: [], ...state};
  world.setup = async update => {
    world.calls.push(update);
    if (world.fail) throw world.fail;
    if (update) {
      if (world.failUpdate) throw world.failUpdate;
      const replaced = world.installed !== world.expected;
      world.installed = world.expected;
      return {...report(world), replaced};
    }
    return report(world);
  };
  return world;
}
function report(world) {
  if (world.unsupported) return {supported: false, reason: world.unsupported, listening: world.listening, ...(world.message ? {message: world.message} : {})};
  const live = world.listening && world.handshake ? {up_to_date: world.loaded === world.expected, protocol_version: world.loaded, expected_protocol_version: world.expected} : world.listening ? null : undefined;
  return {supported: true, expected_protocol: world.expected, listening: world.listening, ...(live !== undefined ? {live} : {}),
    ...(world.liveError ? {live: null, live_error: world.liveError} : {}),
    ...(world.noTarget ? {target: null, target_problem: world.noTarget, current: false, ...(world.message ? {message: world.message} : {})} : {target: {path: '/addons/addon.py', protocol: world.installed}, current: world.installed === world.expected})};
}
function fixture(state, overrides = {}) {
  const world = mcp(state), gate = new PrintGate();
  const service = new BlenderAddonRepair({gate, setup: update => world.setup(update), lock: async () => async () => {}, ...overrides});
  return {service, world, gate};
}

test('old live addon is actionable even when MCP tool discovery works', async () => {
  const {service} = fixture();
  const status = await service.check();
  assert.equal(status.state, 'update-needed');
  assert.equal(status.canUpdate, true);
  assert.equal(status.protocol, 1);
  assert.equal(status.expectedProtocol, 15);
});
test('no listener never claims that the addon is ready', async () => {
  const {service} = fixture({listening: false, installed: 15});
  assert.equal((await service.check()).state, 'not-running');
});
test('repair leaves the running session awaiting restart until Blender loads the new add-on', async () => {
  const {service, world} = fixture();
  assert.equal(service.update().state, 'updating');
  await service.settled();
  assert.equal(service.current().state, 'restart-needed');
  assert.deepEqual(world.calls, [true]);
  assert.equal((await service.check()).state, 'restart-needed', 'Blender still runs the old add-on');
  world.loaded = 15;
  assert.equal((await service.check()).state, 'ready');
});
test('a failed update keeps the add-on and says so', async () => {
  const {service, world} = fixture({failUpdate: new Error('The staged add-on doesn’t match the configured Blender MCP package. Nothing was replaced.')});
  service.update(); await service.settled();
  assert.equal(service.current().state, 'failed');
  assert.match(service.current().message, /existing add-on was kept/);
  assert.equal(world.installed, 1);
});
test('active pass prevents any installation and repair reservation prevents new passes', async () => {
  let unblock; const waiting = new Promise(r => { unblock = r; });
  const {service, gate} = fixture({}, {lock: async () => { await waiting; return async () => {}; }});
  const release = gate.hold('current');
  assert.equal(service.update().state, 'busy'); release();
  service.update(); assert.throws(() => gate.hold('current'));
  unblock(); await service.settled();
  const next = gate.hold('current'); next();
});
test('a current add-on file that Blender has not loaded yet asks for a restart, not another update, after a companion restart', async () => {
  // A fresh companion (nothing remembered) while Blender still runs the add-on it loaded before an earlier update.
  const {service, world} = fixture({installed: 15, loaded: 1});
  const status = await service.check();
  assert.equal(status.state, 'restart-needed');
  assert.equal(status.canUpdate, false);
  service.update(); await service.settled();
  assert.equal(service.current().state, 'restart-needed', 'the MCP had nothing to replace; Blender still needs the restart');
  assert.deepEqual(world.calls, [false, true]);
});
test('a bridge without a compatibility API is unverified', async () => {
  const {service} = fixture({handshake: false});
  const status = await service.check(); assert.equal(status.state, 'unavailable'); assert.equal(status.canUpdate, false);
});
test('both control actions start bounded operations and return the same status', async () => {
  const {createControlDispatcher} = await import('../dist/local-control-services.js');
  const {service} = fixture();
  const call = createControlDispatcher({auth: {}, companionVersion: 'test', blenderAddon: service});
  assert.equal((await call('blender.check', {})).blender.state, 'checking');
  await service.settled(); assert.equal((await call('blender.status', {})).blender.state, 'update-needed');
  assert.equal((await call('blender.update', {})).blender.state, 'updating');
  await service.settled(); assert.equal((await call('blender.status', {})).blender.state, 'restart-needed');
});
test('HTTP status requires read scope and repair/check require write scope', async t => {
  const {startCompanionServer} = await import('../dist/server.js');
  const {RemoteAuthStore} = await import('../dist/remote-auth.js');
  const {request} = await import('node:http');
  const {service} = fixture();
  const root = await mkdtemp(join(tmpdir(), 'addon-repair-')); t.after(() => rm(root, {recursive: true, force: true}));
  const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test']});
  const pair = async scopes => { const invitation = await remoteAuth.createPairing('alice@example.test', scopes); return remoteAuth.exchange('alice@example.test', {code: invitation.code, deviceName: 'Fixture'}); };
  const reader = await pair(['projects:read']), writer = await pair(['projects:read', 'projects:write']);
  const server = await startCompanionServer({port: 0, remoteAuth, blenderAddon: service}); t.after(() => server.close());
  const forwarded = JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8')).expected;
  const call = (method, path, phone) => new Promise((resolve, reject) => {
    const req = request(server.url + path, {method, headers: {...forwarded, authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId}}, res => { const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(Buffer.concat(chunks))})); }); req.on('error', reject); req.end(); });
  const initial = await call('GET', '/v1/blender', reader);
  assert.equal(initial.status, 200); assert.equal(initial.body.blender.state, 'unchecked');
  for (const action of ['check', 'update']) assert.equal((await call('POST', '/v1/blender/' + action, reader)).status, 403);
  assert.equal((await call('POST', '/v1/blender/check', writer)).body.blender.state, 'checking');
  await service.settled(); assert.equal((await call('GET', '/v1/blender', writer)).body.blender.state, 'update-needed');
  assert.equal((await call('POST', '/v1/blender/update', writer)).body.blender.state, 'updating');
  await service.settled(); assert.equal((await call('GET', '/v1/blender', writer)).body.blender.state, 'restart-needed');
});
test('repair can stop waiting for the shared helper lock without acquiring it later', async t => {
  const {acquireBlenderLock} = await import('../dist/touchup/touchup.js');
  const root = await mkdtemp(join(tmpdir(), 'addon-lock-')); t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'blender.lock'), release = await acquireBlenderLock(path);
  await assert.rejects(acquireBlenderLock(path, {pollMs: 2, signal: AbortSignal.timeout(10)}), {name: 'TimeoutError'});
  await release(); const next = await acquireBlenderLock(path); await next();
});
test('closed outdated Blender offers repair and reports ready for next launch afterward', async () => {
  const {service, world} = fixture({listening: false});
  const before = await service.check(); assert.equal(before.state, 'update-needed'); assert.equal(before.canUpdate, true);
  service.update(); await service.settled();
  assert.equal(service.current().state, 'not-running'); assert.match(service.current().message, /opens it when cleanup starts/);
  assert.equal(service.current().canUpdate, false); assert.equal(world.installed, 15);
});
test('reachable bridge errors remain unverified rather than pretending Blender is stopped', async () => {
  const {service} = fixture({liveError: "Blender's add-on could not be checked: busy"});
  const status = await service.check();
  assert.equal(status.state, 'unavailable');
  assert.match(status.message, /could not be checked: busy/);
});
test('a failed later repair cannot reuse the success state of an earlier replacement', async () => {
  const {service, world} = fixture();
  service.update(); await service.settled();
  world.expected = 16; world.loaded = 15;
  assert.equal((await service.check()).state, 'update-needed');
  world.failUpdate = new Error('installer failed');
  service.update(); await service.settled();
  assert.equal(service.current().state, 'failed');
  assert.equal(world.installed, 15);
});
test('a fresh companion status read never reports phantom work', async () => {
  const {service, world} = fixture();
  assert.equal(service.current().state, 'unchecked');
  assert.equal(service.current().canUpdate, false);
  assert.deepEqual(world.calls, [], 'status-only reappearance must not start a check');
});
test('a bridge this MCP cannot update, or a missing add-on, is unavailable in the MCP\'s own words', async () => {
  for (const state of [{unsupported: 'custom-command', message: "This Blender bridge uses its own command, so its add-on is updated with that bridge's installer."},
    {noTarget: 'not-installed', message: "The MCP for Blender add-on isn't installed for this Blender."},
    // A reason this app has never heard of is shown as the MCP words it, with no app release.
    {unsupported: 'a-reason-added-later', message: 'Something new, in the MCP\'s words.'}]) {
    const {service} = fixture(state);
    const status = await service.check();
    assert.equal(status.state, 'unavailable'); assert.equal(status.message, state.message); assert.equal(status.canUpdate, false);
  }
  const {service} = fixture({unsupported: 'custom-package'});
  assert.match((await service.check()).message, /can’t check the Blender add-on here/, 'without its words, a plain fallback');
});
test('an update that finds the bridge or the add-on changed since the check keeps the MCP\'s words, never claims success', async () => {
  for (const [change, words] of [[{unsupported: 'custom-command'}, "This Blender bridge uses its own command, so its add-on is updated with that bridge's installer."],
    [{noTarget: 'not-installed'}, "The MCP for Blender add-on isn't installed for this Blender."]]) {
    const {service, world} = fixture({listening: false});
    assert.equal((await service.check()).state, 'update-needed');
    // Between Check Again and Update: the MCP's update answers without installing anything.
    Object.assign(world, change, {message: words});
    world.setup = async () => report(world);
    service.update(); await service.settled();
    assert.equal(service.current().state, 'unavailable', JSON.stringify(change));
    assert.equal(service.current().message, words);
  }
});
test('an MCP without blender_mcp_setup is told to update in Settings → Printers; nothing in the app stands in', async () => {
  const {service} = fixture({fail: new BlenderSetupUnavailableError('bambu-printer-mcp')});
  const status = await service.check();
  assert.equal(status.state, 'unavailable');
  assert.equal(status.message, 'Update bambu-printer-mcp in Settings → Printers so Counterpart can check the Blender add-on.');
  assert.equal(status.canUpdate, false);
});
