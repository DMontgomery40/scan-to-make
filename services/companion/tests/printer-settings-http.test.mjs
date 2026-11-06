import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as send} from 'node:http';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {loadPrinterCatalog} from '../dist/objects/printers.js';
import {PrinterDirectory} from '../dist/printing/directory.js';
import {PrintGate} from '../dist/printing/print-gate.js';
import {PrinterSetup} from '../dist/printing/setup.js';
import {hostEnvironment} from '../dist/printing/mcp-install.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'phone-printer-settings-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const clone = join(home, 'generic');
  await mkdir(clone);
  const settings = 'PRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_MODEL=p1s\n';
  await writeFile(join(home, '.env'), settings);
  await writeFile(join(clone, '.env'), settings + 'PRINTER_TYPE=bambu\n');
  const configPath = join(home, 'mcp.json');
  await writeFile(configPath, JSON.stringify({mcpServers: {generic: {command: 'node', args: [join(clone, 'mcp-3D-printer-server/dist/index.js')], cwd: clone}}}));
  const config = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', cwd: home}};
  const env = {...hostEnvironment(join(home, 'data')), home};
  const profilesPath = join(env.appPrinters, 'profiles.json');
  const catalog = await loadPrinterCatalog(config, {homeDirectory: home, sourcePaths: [configPath], profilesPath});
  const calls = [];
  let route = 'lan', liveBusy = false, routeBarrier, reloadBarrier;
  const sessions = new Map(catalog.entries().map(entry => [entry.id, new PrinterSession(entry.id, entry.config, {clientFactory: () => ({
    connect: async () => ({server: {name: entry.config.backend, version: '1.0.0'}, tools: ['counterpart_print_route', 'counterpart_print_progress'].map(name => ({name, inputSchema: {type: 'object'}}))}),
    callTool: async (name, args) => {
      calls.push({name, args});
      if (name === 'counterpart_print_progress') return {content: [{type: 'text', text: JSON.stringify({contract: 'counterpart/1', observedAt: new Date().toISOString(), state: liveBusy ? 'printing' : 'idle', problems: []})}]};
      if (args?.route && routeBarrier) {
        const barrier = routeBarrier; routeBarrier = undefined;
        barrier.started.resolve(); await barrier.finished.promise;
      }
      if (args?.route) route = args.route;
      return {content: [{type: 'text', text: JSON.stringify({route, mode: 'bambu_network', type: route, choices: ['lan', 'cloud'],
        options: [{id: 'lan', label: 'Local network', available: true}, {id: 'cloud', label: 'Bambu Cloud', available: true, controls: 'Controls use Bambu Cloud.'}], savedTo: null})}]};
    }, close: async () => {},
  })})]));
  const directory = new PrinterDirectory(catalog, id => sessions.get(id));
  const gate = new PrintGate(), store = new ObjectStore(join(home, 'objects'));
  const objects = new ObjectService({store, printerCatalog: catalog, printers: directory, printGate: gate,
    claudePath: '/unused', handoff: config, runTouchup: async () => { throw Error('unused'); }, stlInfo: async () => undefined});
  const setup = new PrinterSetup({env, profilesPath, gate, configs: () => catalog.entries(), catalog: () => catalog,
    reload: async () => {
      if (reloadBarrier) { const barrier = reloadBarrier; reloadBarrier = undefined; barrier.started.resolve(); await barrier.finished.promise; }
      await catalog.reload();
    }, busy: async id => gate.held(id) || await objects.printerBusy(id) || await directory.printing(id)});
  const auth = await RemoteAuthStore.create(join(home, 'auth'), {host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test']});
  const phone = async scopes => { const {code} = await auth.createPairing('alice@example.test', scopes); return auth.exchange('alice@example.test', {code, deviceName: 'Test'}); };
  const full = await phone(['generation:health', 'projects:read', 'projects:write', 'printer-handoff:use']);
  const readOnly = await phone(['projects:read']);
  const printOnly = await phone(['printer-handoff:use']);
  const settingsOnly = await phone(['projects:write']);
  const server = await startCompanionServer({port: 0, remoteAuth: auth, objects, printerSetup: setup});
  t.after(async () => { await server.close(); await objects.close(); for (const session of sessions.values()) await session.close(); });
  const forwarded = JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8')).expected;
  const call = (path, method = 'GET', body, credential = full) => new Promise((resolve, reject) => {
    const req = send(server.url + path, {method, headers: {...forwarded, authorization: `Bearer ${credential.token}`, 'x-scan-device': credential.deviceId, 'content-type': 'application/json'}}, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString())}));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return {call, readOnly, printOnly, settingsOnly, objects, store, gate, catalog, calls, liveBusy: value => { liveBusy = value; }, holdRoute: () => {
    const barrier = {started: Promise.withResolvers(), finished: Promise.withResolvers()};
    routeBarrier = barrier;
    return {started: barrier.started.promise, release: () => barrier.finished.resolve()};
  }, holdMcp: () => {
    const barrier = {started: Promise.withResolvers(), finished: Promise.withResolvers()};
    reloadBarrier = barrier;
    return {started: barrier.started.promise, release: () => barrier.finished.resolve()};
  }};
}

test('paired phone reads and changes the actual MCP route and switches the existing MCP preference', async t => {
  const f = await fixture(t);
  const health = await f.call('/healthz');
  assert.equal(health.body.capabilities.printerSettings, true);
  assert.equal(health.body.capabilities.printLayerPauses, true);
  const path = '/v1/objects/printers/current';
  const read = await f.call(path + '/route');
  assert.equal(read.status, 200);
  assert.equal(read.body.route.route, 'lan');
  const changed = await f.call(path + '/route', 'POST', {route: 'cloud'});
  assert.equal(changed.status, 200);
  assert.equal(changed.body.route.options[1].controls, 'Controls use Bambu Cloud.');
  assert.equal((await f.objects.printRoute('current')).route, 'cloud');
  const switched = await f.call(path + '/mcp', 'POST', {backend: 'mcp-3d-printer-server'});
  assert.equal(switched.status, 200);
  assert.equal(switched.body.destinations.find(printer => printer.id === switched.body.destinationId).backend, 'mcp-3d-printer-server');
  assert.equal(f.catalog.canonical('current'), switched.body.destinationId);
});

test('printer settings require their existing scopes and refuse malformed mutations before changing the MCP', async t => {
  const f = await fixture(t), path = '/v1/objects/printers/current';
  for (const [suffix, method, body] of [['/route', 'GET'], ['/route', 'POST', {route: 'cloud'}], ['/mcp', 'POST', {backend: 'mcp-3d-printer-server'}]]) {
    assert.equal((await f.call(path + suffix, method, body, f.readOnly)).status, 403);
  }
  for (const body of [{route: '../cloud'}, {route: 'cloud', destinationId: 'elsewhere'}, null, {route: 'cloud', extra: true}]) {
    assert.equal((await f.call(path + '/route', 'POST', body)).status, 400);
  }
  assert.equal((await f.call(path + '/mcp', 'POST', {backend: 'other'})).status, 400);
  assert.equal((await f.call(path + '/route', 'DELETE')).status, 405);
  assert.equal((await f.call('/v1/objects/printers/missing/route')).status, 404);
  assert.equal(f.calls.length, 0, 'unauthorized or invalid requests must not reach the printer');
  assert.equal((await f.call(path + '/route', 'GET', undefined, f.printOnly)).status, 200);
  assert.equal((await f.call(path + '/route', 'POST', {route: 'cloud'}, f.printOnly)).status, 403);
  assert.equal((await f.call(path + '/route', 'POST', {route: 'lan'}, f.settingsOnly)).status, 403, 'settings permission does not grant printer controls');
  assert.equal((await f.call(path + '/mcp', 'POST', {backend: 'mcp-3d-printer-server'}, f.printOnly)).status, 403, 'print permission does not grant settings mutations');
  assert.equal((await f.call(path + '/mcp', 'POST', {backend: 'mcp-3d-printer-server'}, f.settingsOnly)).status, 403);
});

test('route and MCP mutations refuse active project prints, reservations and printer-reported jobs while reads remain available', async t => {
  const f = await fixture(t), path = '/v1/objects/printers/current';
  const refused = async () => {
    const route = await f.call(path + '/route', 'POST', {route: 'cloud'});
    assert.equal(route.status, 409); assert.match(route.body.error.message, /printing|work|finish/i);
    assert.equal((await f.call(path + '/mcp', 'POST', {backend: 'mcp-3d-printer-server'})).status, 409);
    assert.equal((await f.call(path + '/route')).status, 200, 'connection can still be inspected');
  };
  const object = await f.objects.create();
  await f.store.update(object.id, current => ({...current, state: 'printing', printerDestinationId: 'current'}));
  await refused();
  await f.store.update(object.id, current => ({...current, state: 'ready'}));
  const release = f.gate.hold('current'); await refused(); release();
  f.liveBusy(true); await refused();
  assert.equal(f.calls.filter(call => call.name === 'counterpart_print_route' && call.args?.route).length, 0);
});

test('a route mutation excludes new print admissions until it finishes while connection reads remain free', async t => {
  const f = await fixture(t), path = '/v1/objects/printers/current/route';
  const barrier = f.holdRoute();
  const changing = f.call(path, 'POST', {route: 'cloud'});
  await barrier.started;
  let unexpectedRelease;
  try {
    assert.equal((await f.call(path)).status, 200);
    assert.throws(() => { unexpectedRelease = f.gate.hold('current'); }, /updating/);
    assert.equal((await f.call(path, 'POST', {route: 'lan'})).status, 409);
    assert.equal((await f.call('/v1/objects/printers/current/mcp', 'POST', {backend: 'mcp-3d-printer-server'})).status, 409);
  } finally { unexpectedRelease?.(); barrier.release(); await changing; }
  assert.equal(f.gate.updating('current'), false, 'the exclusion is released after the MCP answers');
  const release = f.gate.hold('current'); release();
});

test('an MCP preference mutation excludes print admissions through both aliases until catalog reload completes', async t => {
  const f = await fixture(t);
  const barrier = f.holdMcp();
  const changing = f.call('/v1/objects/printers/current/mcp', 'POST', {backend: 'mcp-3d-printer-server'});
  await barrier.started;
  let unexpectedRelease;
  try {
    assert.equal((await f.call('/v1/objects/printers/current/route')).status, 200);
    for (const choice of f.catalog.destinations[0].mcps) {
      assert.throws(() => { unexpectedRelease = f.gate.hold(choice.destinationId); }, /updating/);
    }
    assert.equal((await f.call('/v1/objects/printers/current/route', 'POST', {route: 'cloud'})).status, 409);
  } finally { unexpectedRelease?.(); barrier.release(); await changing; }
  for (const choice of f.catalog.destinations[0].mcps) assert.equal(f.gate.updating(choice.destinationId), false);
});

test('paired clients can read every MCP copy, including hidden profiles, without update permission', async t => {
  const f = await fixture(t);
  const response = await f.call('/v1/printers/mcps', 'GET', undefined, f.readOnly);
  assert.equal(response.status, 200);
  const generic = response.body.packages.find(item => item.package === 'mcp-3d-printer-server');
  assert.equal(generic.uses.length, 1);
  assert.equal(generic.uses[0].printerId, f.catalog.canonical(generic.uses[0].destinationId));
  assert.equal(JSON.stringify(response.body).includes('192.0.2.1'), false, 'process environment is not exposed');
  assert.equal((await f.call('/v1/printers/mcps', 'GET', undefined, f.printOnly)).status, 403);
  assert.equal((await f.call('/v1/printers/mcps', 'POST', {}, f.readOnly)).status, 405);
});
