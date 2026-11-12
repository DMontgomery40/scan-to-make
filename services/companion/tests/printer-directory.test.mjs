import test from 'node:test';
import assert from 'node:assert/strict';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {PrinterDirectory, READINESS_REFRESH_MS} from '../dist/printing/directory.js';

const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const until = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };
// What bambu-printer-mcp answers for a P1S (counterpart/1): its capabilities, and its reports as counterpart_print_progress.
const INFO = {contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.61'}, printer: {kind: 'bambu', host: '192.0.2.1', model: 'A1 Mini'},
  capabilities: {progress: true, layers: true, camera: 'bambu-tcp', filaments: 'ams', pause: true, resume: false, cancel: true, print3mf: true, gcode: true}};
const CONTRACT = [tool('counterpart_printer_info'), tool('counterpart_print_progress')];
const progress = state => ({contract: 'counterpart/1', observedAt: new Date().toISOString(), state, problems: []});
function destination({tools, status, failing = () => false, info = INFO, infoFails = 0}) {
  let directory;
  const reads = [];
  const factory = () => ({
    catalog: undefined,
    async connect() { if (failing()) throw Object.assign(new Error('down'), {code: 'connection-failed'}); this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.44'}, tools}; return this.catalog; },
    hasTool(name) { return tools.some(item => item.name === name); },
    getTool(name) { return tools.find(item => item.name === name); },
    async callTool(name) {
      if (name === 'counterpart_printer_info') {
        if (infoFails-- > 0) throw Object.assign(new Error('MCP error -32001: Request timed out'), {code: 'tool-failed'});
        return {content: [{type: 'text', text: JSON.stringify(info)}]};
      }
      reads.push(name); return {content: [{type: 'text', text: JSON.stringify(status())}]};
    },
    async close() {},
  });
  const session = new PrinterSession('current', {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}, selection: {model: 'p1s'}},
    {clientFactory: factory, onConnect: catalog => directory.connected('current', catalog)});
  return {session, reads, set: value => { directory = value; }};
}
const catalog = {defaultDestinationId: 'current', destinations: [{id: 'current', aliases: ['old-duplicate'], name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff'}],
  resolve: () => undefined, canonical: id => id === 'current' || id === 'old-duplicate' ? 'current' : undefined};

test('a printer list answers at once, then fills in state and capabilities from the session without waiting on it', async () => {
  let now = 1_000_000;
  const d = destination({tools: [...CONTRACT, tool('camera_snapshot'), tool('pause_print')], status: () => progress('printing')});
  const directory = new PrinterDirectory(catalog, id => id === 'current' ? d.session : undefined, {now: () => now});
  d.set(directory);
  const first = directory.list();
  assert.deepEqual(JSON.parse(JSON.stringify(first)).destinations[0].aliases, ['old-duplicate']);
  assert.equal(first.destinations[0].state, 'unknown');
  assert.equal(first.destinations[0].capabilities, undefined);
  await directory.refresh('current');
  await until(() => directory.capabilities('current')?.contract);
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

test('a printer info read that fails is tried again at the next refresh, so a timeout never leaves the printer without its capabilities', async () => {
  let now = 1_000_000;
  const d = destination({tools: [...CONTRACT, tool('camera_snapshot'), tool('pause_print')], status: () => progress('idle'), infoFails: 1});
  const directory = new PrinterDirectory(catalog, id => id === 'current' ? d.session : undefined, {now: () => now});
  d.set(directory);
  await directory.refresh('current');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(directory.capabilities('current').contract, undefined, 'the first read timed out');
  assert.deepEqual([directory.capabilities('current').camera, directory.capabilities('current').pause], ['none', false]);
  now += READINESS_REFRESH_MS;
  await directory.refresh('current');
  assert.equal(directory.capabilities('current').contract, 'counterpart/1');
  assert.deepEqual([directory.capabilities('current').camera, directory.capabilities('current').pause], ['bambu-tcp', true]);
  // Once it has answered, a refresh reads only the printer's progress.
  const reads = d.reads.length;
  now += READINESS_REFRESH_MS;
  await directory.refresh('current');
  assert.deepEqual(d.reads.slice(reads), ['counterpart_print_progress']);
});

test('a printer whose MCP can\'t be reached reads as offline', async () => {
  const d = destination({tools: CONTRACT, status: () => ({}), failing: () => true});
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

test('a view shares recent camera frames and event snapshots without overlapping captures', async () => {
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
  assert.equal((await camera.frame('p1s', session, view)).capturedAt, first.capturedAt, 'one fetch at a time');
  assert.equal(calls, 2);
  // An event's frame (no `view`) waits for the fetch in flight rather than taking the older one.
  const forEvent = camera.frame('p1s', session);
  gate();
  assert.equal((await forEvent).bytes[4], 2);
  assert.equal(calls, 2);
  await until(async () => (await camera.frame('p1s', session, view)).bytes[4] === 2);
  // Too old to show: wait for a fresh one.
  clock.t += CAMERA_STALE_MS + 1;
  const waiting = camera.frame('p1s', session);
  await until(() => calls === 3);
  gate();
  assert.equal((await waiting).bytes[4], 3);
  camera.close();
  assert.equal(session.health().holders, 0, 'closing lets the session go');
  await session.close();
});

test('PRD §8.10: printing() asks the printer now, so a print with no project (the phone handoff) still counts', async () => {
  let state = 'printing', now = 1_000_000;
  const d = destination({tools: CONTRACT, status: () => progress(state)});
  const directory = new PrinterDirectory(catalog, id => id === 'current' ? d.session : undefined, {now: () => now});
  d.set(directory);
  assert.equal(await directory.printing('current'), true);
  assert.equal(await directory.printing('old-duplicate'), true, 'a duplicate id is the same printer');
  state = 'finished';
  // Not from the 30 s cache: the second read sees the print end at once.
  assert.equal(await directory.printing('current'), false);
  assert.equal(d.reads.length, 3);
  assert.equal(await directory.printing('nowhere'), false);
  // A printer that can't be read isn't printing.
  const down = destination({tools: CONTRACT, status: () => ({}), failing: () => true});
  const offline = new PrinterDirectory(catalog, id => id === 'current' ? down.session : undefined, {now: () => now});
  down.set(offline);
  assert.equal(await offline.printing('current'), false);
});


test('concurrent fresh camera requests share one snapshot, while a later fresh request bypasses the cache', async () => {
  const {CameraFrames} = await import('../dist/printing/camera.js');
  const camera = new CameraFrames();
  const pending = Promise.withResolvers();
  let snapshots = 0;
  const session = {connect: async () => {}, hasTool: () => true, getTool: () => tool('camera_snapshot'), config: {},
    call: async () => { snapshots++; await pending.promise; return {content: [{type: 'text', text: JSON.stringify({base64: Buffer.from([0xff, 0xd8, snapshots]).toString('base64')})}]}; }};
  const first = camera.frame('current', session, {fresh: true});
  const second = camera.frame('current', session, {fresh: true});
  await new Promise(resolve => setImmediate(resolve));
  pending.resolve();
  const frames = await Promise.all([first, second]);
  assert.equal(snapshots, 1, 'fresh bypasses old frames, not a snapshot already being captured');
  assert.deepEqual(frames[0], frames[1]);
  await camera.frame('current', session, {fresh: true});
  assert.equal(snapshots, 2);
  camera.close();
});

const named = (name, backend = 'bambu-printer-mcp') => ({defaultDestinationId: 'current',
  destinations: [{id: 'current', name, address: '192.0.2.1', backend, source: 'current', origin: 'printer-handoff'}],
  resolve: () => undefined, canonical: id => id === 'current' ? 'current' : undefined});
async function listedName(catalog, info = INFO) {
  const d = destination({tools: [...CONTRACT], status: () => progress('idle'), info});
  const directory = new PrinterDirectory(catalog, id => id === 'current' ? d.session : undefined, {now: () => 1_000_000});
  d.set(directory);
  const before = directory.list().destinations[0].name;
  await directory.refresh('current');
  await until(() => directory.capabilities('current')?.contract);
  return {before, after: directory.list().destinations[0].name};
}

test('a printer nobody named is listed by the display name its MCP reports, exactly as reported (first look U9, review F1)', async () => {
  // bambu-printer-mcp's own display name, as its counterpart_printer_info gives it: no brand added, nothing uppercased.
  assert.deepEqual(await listedName(named('Your printer')), {before: 'Your printer', after: 'A1 Mini'});
  // mcp-3D-printer-server's shape: another kind and a mixed-case model, passed through the same way.
  const prusa = {...INFO, server: {name: 'mcp-3D-printer-server', version: '1.2.40'}, printer: {kind: 'prusa', host: '192.0.2.1', model: 'Original Prusa MK4S'}};
  assert.equal((await listedName(named('Your printer', 'mcp-3d-printer-server'), prusa)).after, 'Original Prusa MK4S');
});

test('names older builds generated count as unnamed; a name someone gave stays (review F6)', async () => {
  for (const legacy of ['Bambu printer', 'Configured printer', 'Printer at 192.0.2.1', 'Printer 2']) assert.equal((await listedName(named(legacy))).after, 'A1 Mini', legacy);
  assert.equal((await listedName(named('Garage printer'))).after, 'Garage printer');
});

test('a config that names a model still shows what the MCP reports; an MCP that cannot be asked leaves where it is (F1 follow-up)', async () => {
  // The config says "p1s": the companion composes nothing from it; the MCP's own display name is shown.
  const withModel = named('Your printer');
  withModel.destinations[0].model = 'p1s';
  assert.equal((await listedName(withModel)).after, 'A1 Mini');
  // No counterpart_printer_info (an MCP without the contract, or one that never answers): "Your printer", never its address.
  const d = destination({tools: [tool('get_printer_status')], status: () => ({connected: true, status: 'idle'})});
  const directory = new PrinterDirectory(named('Your printer'), id => id === 'current' ? d.session : undefined, {now: () => 1_000_000});
  d.set(directory);
  await directory.refresh('current');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(directory.list().destinations[0].name, 'Your printer');
});

// Nov 6, David: "now i only see one to update and missing the other one". A P1S set up in both MCPs is one printer; each
// MCP it is set up in carries its own install, name and versions, so Settings' row for the MCP prints don't go through
// still has its Update (packages/contracts/fixtures/printer-both-mcps.json, which the Mac's row test reads too).
test('PRD §8.10: each MCP a printer is set up in names its install, label and versions', async () => {
  const {readFile} = await import('node:fs/promises');
  const expected = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/printer-both-mcps.json', import.meta.url), 'utf8'));
  const both = {...catalog, destinations: [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff',
    mcps: [{backend: 'bambu-printer-mcp', destinationId: 'current'}, {backend: 'mcp-3d-printer-server', destinationId: 'counterpart-a07c6f7d'}]}]};
  const directory = new PrinterDirectory(both, () => undefined);
  const installs = {current: ['mcp-812bcaf2d1ff2948', '1.1.73'], 'counterpart-a07c6f7d': ['mcp-3a2f0c9e5b7d1e44', '1.2.56']};
  directory.useVersions({mcpId: id => installs[id]?.[0], version: id => installs[id]?.[1],
    latestVersion: pkg => ({'bambu-printer-mcp': '1.1.78', 'mcp-3d-printer-server': '1.2.58'})[pkg]});
  assert.deepEqual(JSON.parse(JSON.stringify(directory.list())), expected);
  // A companion's updater without `version` (or none at all) still lists both MCPs.
  directory.useVersions({mcpId: () => undefined, latestVersion: () => undefined});
  assert.deepEqual(directory.list().destinations[0].mcps, [{backend: 'bambu-printer-mcp', destinationId: 'current', label: 'bambu-printer-mcp'},
    {backend: 'mcp-3d-printer-server', destinationId: 'counterpart-a07c6f7d', label: 'mcp-3D-printer-server'}]);
});
