import test from 'node:test';
import assert from 'node:assert/strict';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {PrinterDirectory, READINESS_REFRESH_MS} from '../dist/printing/directory.js';

const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const until = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };
function destination({tools, status, failing = () => false}) {
  let directory;
  const reads = [];
  const factory = () => ({
    catalog: undefined,
    async connect() { if (failing()) throw Object.assign(new Error('down'), {code: 'connection-failed'}); this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.44'}, tools}; return this.catalog; },
    hasTool(name) { return tools.some(item => item.name === name); },
    getTool(name) { return tools.find(item => item.name === name); },
    async callTool(name) { reads.push(name); return {content: [{type: 'text', text: JSON.stringify(status())}]}; },
    async close() {},
  });
  const session = new PrinterSession('current', {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}, selection: {model: 'p1s'}},
    {clientFactory: factory, onConnect: catalog => directory.connected('current', catalog)});
  return {session, reads, set: value => { directory = value; }};
}
const catalog = {defaultDestinationId: 'current', destinations: [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff'}],
  resolve: () => undefined, canonical: id => id === 'current' || id === 'old-duplicate' ? 'current' : undefined};

test('a printer list answers at once, then fills in state and capabilities from the session without waiting on it', async () => {
  let now = 1_000_000;
  const d = destination({tools: [tool('get_printer_status'), tool('camera_snapshot'), tool('pause_print')], status: () => ({connected: true, raw: {gcode_state: 'RUNNING'}})});
  const directory = new PrinterDirectory(catalog, id => id === 'current' ? d.session : undefined, {now: () => now});
  d.set(directory);
  const first = directory.list();
  assert.equal(first.destinations[0].state, 'unknown');
  assert.equal(first.destinations[0].capabilities, undefined);
  await directory.refresh('current');
  const second = directory.list().destinations[0];
  assert.equal(second.state, 'busy');
  assert.equal(second.stateCheckedAt, new Date(now).toISOString());
  assert.equal(second.capabilities.camera, 'bambu-tcp');
  assert.deepEqual(second.capabilities.missing.includes('resume'), true);
  assert.equal(directory.lastReport('old-duplicate').state, 'printing');
  // At most one background read per destination every 30 s.
  directory.list(); directory.list();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.reads.length, 1);
  now += READINESS_REFRESH_MS;
  await directory.refresh('current');
  assert.equal(d.reads.length, 2);
});

test('a printer whose MCP can\'t be reached reads as offline', async () => {
  const d = destination({tools: [tool('get_printer_status')], status: () => ({}), failing: () => true});
  const directory = new PrinterDirectory(catalog, () => d.session);
  d.set(directory);
  await directory.refresh('current');
  assert.equal(directory.list().destinations[0].state, 'offline');
});

test('camera frames go to the destination\'s own route on mcp-3D-printer-server', async () => {
  const {CameraFrames} = await import('../dist/printing/camera.js');
  const calls = [];
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)]);
  const tools = [tool('camera_snapshot', {host: {}, type: {}, port: {}, timeout_ms: {}})];
  const session = new PrinterSession('voron', {backend: 'mcp-3d-printer-server', process: {command: '/usr/bin/true'}, selection: {host: 'voron.local', printerType: 'klipper', port: '7125'}}, {clientFactory: () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'mcp-3d-printer-server', version: '1'}, tools}; return this.catalog; },
    hasTool: name => tools.some(item => item.name === name), getTool: name => tools.find(item => item.name === name),
    async callTool(name, args) { calls.push(args); return {content: [{type: 'text', text: JSON.stringify({format: 'image/jpeg', base64: jpeg.toString('base64')})}]}; },
    async close() {},
  })});
  await new CameraFrames().frame('voron', session);
  assert.deepEqual(calls, [{host: 'voron.local', type: 'klipper', port: '7125', timeout_ms: 8000}]);
});

test('a view never waits on the camera when a recent frame exists, and opening one warms the session and the first frame', async () => {
  const {CameraFrames, CAMERA_STALE_MS} = await import('../dist/printing/camera.js');
  const frameOf = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8, n)]);
  let calls = 0, gate;
  const tools = [tool('camera_snapshot', {timeout_ms: {}})];
  const session = new PrinterSession('p1s', {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, {clientFactory: () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'bambu-printer-mcp', version: '1'}, tools}; return this.catalog; },
    hasTool: name => tools.some(item => item.name === name), getTool: name => tools.find(item => item.name === name),
    async callTool() {
      const n = ++calls;
      if (n > 1) await new Promise(resolve => { gate = resolve; });
      return {content: [{type: 'text', text: JSON.stringify({format: 'image/jpeg', base64: frameOf(n).toString('base64'), capturedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()})}]};
    },
    async close() {},
  })});
  const clock = {t: 1_000_000};
  const camera = new CameraFrames({now: () => clock.t});
  const view = {view: true};
  const first = await camera.frame('p1s', session, view);
  assert.equal(first.bytes[4], 1);
  assert.equal(session.health().holders, 1, 'a viewer holds the session');
  // 5 s later: the last frame at once, with when it was really taken, while the next one is fetched.
  clock.t += 5000;
  const meanwhile = await camera.frame('p1s', session, view);
  assert.equal(meanwhile.capturedAt, first.capturedAt);
  await until(() => calls === 2);
  clock.t += 1000;
  assert.equal((await camera.frame('p1s', session)).capturedAt, first.capturedAt, 'one fetch at a time');
  assert.equal(calls, 2);
  gate();
  await until(async () => (await camera.frame('p1s', session)).bytes[4] === 2);
  // Too old to show: wait for a fresh one.
  clock.t += CAMERA_STALE_MS + 1;
  const waiting = camera.frame('p1s', session);
  await until(() => calls === 3);
  gate();
  assert.equal((await waiting).bytes[4], 3);
  // Opening a view with nothing recent fetches ahead, once a minute at most; the request then reads the cache.
  const fresh = new CameraFrames({now: () => clock.t});
  fresh.warm('p1s', session);
  fresh.warm('p1s', session);
  await until(() => calls === 4);
  gate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fresh.frame('p1s', session)).bytes[4], 4);
  assert.equal(calls, 4);
  camera.close(); fresh.close();
  assert.equal(session.health().holders, 0, 'closing lets the session go');
  await session.close();
});
