import test from 'node:test';
import assert from 'node:assert/strict';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {PrinterDirectory, READINESS_REFRESH_MS} from '../dist/printing/directory.js';

const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
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
