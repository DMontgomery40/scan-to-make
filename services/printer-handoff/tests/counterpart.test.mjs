import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PrinterSession, bambuStatusReport, genericStatusReport, detectCapabilities, readPrintReport, readPrinterInfo, readiness, updateCommand,
} from '../dist/index.js';

const at = new Date('2026-11-01T18:00:00.000Z');
const bambu = {backend: 'bambu-printer-mcp', process: {command: '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js'}, selection: {model: 'p1s'}};
const generic = {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/npx', args: ['-y', 'mcp-3d-printer-server']}, selection: {printerType: 'octoprint', host: 'octopi.local'}};
const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const catalog = (...tools) => ({server: {name: 'srv', version: '1.2.3'}, tools});

test('the older Bambu status maps to a report: minutes become seconds, HMS entries become codes', () => {
  const report = bambuStatusReport({connected: true, status: 'RUNNING',
    temperatures: {nozzle: {actual: 219.6, target: 220}, bed: {actual: 55, target: 55}, chamber: 31},
    print: {filename: 'checked-1b2c-Mic mount', progress: 42, timeRemaining: 25, currentLayer: 31, totalLayers: 74},
    raw: {gcode_state: 'RUNNING', subtask_name: 'checked-1b2c-Mic mount', task_id: '0', print_error: 0,
      hms: [{attr: 0x07002000, code: 0x00020001}, {attr: 0x0300, code: 0x00010007}, {bogus: true}]}}, at);
  assert.deepEqual(report, {source: 'status-fallback', observedAt: at.toISOString(), state: 'printing',
    job: {name: 'checked-1b2c-Mic mount', id: '0', progress: 42, remainingSec: 1500, layer: 31, totalLayers: 74},
    temps: {nozzle: {actual: 219.6, target: 220}, bed: {actual: 55, target: 55}, chamber: 31},
    problems: [{code: '0700_2000_0002_0001', severity: 'error', message: 'The printer reported problem 0700_2000_0002_0001.'},
      {code: '0000_0300_0001_0007', severity: 'fatal', message: 'The printer reported problem 0000_0300_0001_0007.'}]});
  for (const [gcode, state] of [['IDLE', 'idle'], ['PREPARE', 'preparing'], ['SLICING', 'preparing'], ['PAUSE', 'paused'], ['FINISH', 'finished'], ['FAILED', 'failed'], ['UNKNOWN', 'busy']])
    assert.equal(bambuStatusReport({connected: true, raw: {gcode_state: gcode}}, at).state, state);
  assert.equal(bambuStatusReport({status: 'error', connected: false}, at).state, 'offline');
  // A finished job's leftover time is not "time left".
  assert.equal(bambuStatusReport({connected: true, print: {filename: 'x', timeRemaining: 9}, raw: {gcode_state: 'FINISH'}}, at).job.remainingSec, undefined);
  assert.equal(bambuStatusReport({connected: true, raw: {gcode_state: 'FAILED', print_error: 0x0500400e}}, at).problems[0].code, '0500400E');
});

test("mcp-3D-printer-server's raw printer endpoint gives only a state", () => {
  assert.equal(genericStatusReport({state: {text: 'Printing', flags: {printing: true, operational: true}}}, at).state, 'printing');
  assert.equal(genericStatusReport({state: {flags: {paused: true}}}, at).state, 'paused');
  assert.equal(genericStatusReport({state: {flags: {ready: true, operational: true}}}, at).state, 'idle');
  assert.equal(genericStatusReport({state: 'ready', state_message: 'Printer is ready'}, at).state, 'idle');
  // Moonraker's /printer/info and PrusaLink's /api/v1/status wrap their state.
  // Klippy's "ready" holds while printing: it is not a print state.
  const klippy = genericStatusReport({result: {state: 'ready', state_message: 'Printer is ready', hostname: 'voron'}}, at);
  assert.equal(readiness(klippy), 'unknown');
  assert.equal(genericStatusReport({result: {state: 'shutdown'}}, at).state, 'busy');
  assert.equal(genericStatusReport({state: {status: 'idle'}}, at).state, 'idle');
  assert.equal(genericStatusReport({state: {status: 'processing'}}, at).state, 'printing');
  assert.equal(genericStatusReport({state: {status: 'pausing'}}, at).state, 'paused');
  assert.equal(genericStatusReport({printer: {state: 'PRINTING'}}, at).state, 'printing');
  assert.equal(genericStatusReport({printer: {state: 'ATTENTION'}}, at).state, 'paused');
  assert.equal(genericStatusReport('nope', at).state, 'offline');
  assert.equal(genericStatusReport({state: 'ready'}, at).job, undefined);
});

test('capabilities light up from the tool list, and say exactly which update unlocks the rest', () => {
  const old = detectCapabilities(bambu, catalog(tool('get_printer_status'), tool('camera_snapshot'), tool('get_printer_filaments'),
    tool('pause_print'), tool('resume_print'), tool('cancel_print'), tool('slice_stl', {stl_path: {}})), undefined, at);
  assert.equal(old.progress, true);
  assert.equal(old.camera, 'bambu-tcp');
  assert.equal(old.filaments, 'ams');
  assert.deepEqual(old.missing, ['quality', 'strength', 'multi-colour']);
  assert.deepEqual(old.update, {message: 'Update bambu-printer-mcp to choose quality, strength and colours per part.', package: 'bambu-printer-mcp',
    command: ['npm', 'install', '-g', 'bambu-printer-mcp@latest']});
  const oldGeneric = detectCapabilities(generic, catalog(tool('get_printer_status'), tool('cancel_print'), tool('slice_stl')), undefined, at);
  assert.equal(oldGeneric.progress, false);
  assert.deepEqual(oldGeneric.missing, ['progress', 'camera', 'filaments', 'pause', 'resume', 'quality', 'strength']);
  assert.equal(oldGeneric.update.message, 'Update mcp-3D-printer-server to see progress, camera and the loaded filament, pause and resume prints and choose quality and strength.');
  assert.equal(oldGeneric.update.command, undefined, 'npx fetches the latest itself');
  const info = {contract: 'counterpart/1', server: {name: 'mcp-3d-printer-server', version: '1.3.0'},
    printer: {kind: 'prusa', host: 'prusa.local'},
    capabilities: {progress: true, layers: false, camera: 'none', filaments: 'single', pause: true, resume: true, cancel: true, print3mf: false, gcode: true}};
  const updated = detectCapabilities(generic, catalog(tool('counterpart_printer_info'), tool('counterpart_print_progress'), tool('camera_snapshot'),
    tool('get_printer_filaments'), tool('pause_print'), tool('resume_print'), tool('cancel_print'),
    tool('slice_stl', {layer_height: {}, wall_loops: {}, sparse_infill_density: {}})), info, at);
  assert.equal(updated.contract, 'counterpart/1');
  assert.equal(updated.camera, 'none', 'the firmware has no camera: not something an update unlocks');
  assert.deepEqual(updated.missing, []);
  assert.equal(updated.update, undefined);
  assert.equal(detectCapabilities({...bambu, selection: {model: 'x1c'}}, catalog(tool('camera_snapshot')), undefined, at).camera, 'rtsp');
});

test('update commands follow how the MCP is installed', () => {
  assert.deepEqual(updateCommand({backend: 'mcp-3d-printer-server', process: {command: '/opt/homebrew/bin/mcp-3d-printer-server'}}), ['npm', 'install', '-g', 'mcp-3d-printer-server@latest']);
  assert.deepEqual(updateCommand({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/node', args: ['/Users/a/.nvm/versions/node/v22/lib/node_modules/bambu-printer-mcp/dist/index.js']}}), ['npm', 'install', '-g', 'bambu-printer-mcp@latest']);
  assert.equal(updateCommand({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/node', args: ['/Users/a/bambu-printer-mcp/dist/index.js']}}), undefined);
  assert.equal(updateCommand({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/node', args: ['/x/lib/node_modules/npm/bin/npx-cli.js', '-y', 'bambu-printer-mcp']}}), undefined);
});

function sessionWith(tools, results) {
  const calls = [];
  const factory = () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'srv', version: '1'}, tools}; return this.catalog; },
    hasTool(name) { return tools.some(item => item.name === name); },
    getTool(name) { return tools.find(item => item.name === name); },
    async callTool(name, args) { calls.push({name, args}); return results[name]; },
    async close() {},
  });
  return {session: new PrinterSession('d', generic, {clientFactory: factory}), calls};
}
const json = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});

test('reports come from counterpart_print_progress when present and are validated', async () => {
  const progress = {contract: 'counterpart/1', observedAt: at.toISOString(), state: 'printing', job: {name: 'part.gcode', progress: 12.5, remainingSec: 900, extra: 1},
    problems: [], futureField: true};
  const {session, calls} = sessionWith([tool('counterpart_print_progress', {host: {}, type: {}}), tool('get_printer_status')], {counterpart_print_progress: json(progress)});
  const report = await readPrintReport(session);
  assert.equal(report.source, 'counterpart');
  assert.deepEqual(report.job, {name: 'part.gcode', progress: 12.5, remainingSec: 900});
  assert.equal('futureField' in report, false);
  assert.deepEqual(calls[0], {name: 'counterpart_print_progress', args: {host: 'octopi.local', type: 'octoprint'}});
  const bad = sessionWith([tool('counterpart_print_progress')], {counterpart_print_progress: json({...progress, state: 'exploded'})});
  await assert.rejects(readPrintReport(bad.session), {code: 'invalid-progress'});
  const none = sessionWith([tool('slice_stl')], {});
  await assert.rejects(readPrintReport(none.session), {code: 'progress-unavailable'});
  const fallback = sessionWith([tool('get_printer_status')], {get_printer_status: json({state: {flags: {printing: true}}})});
  assert.equal((await readPrintReport(fallback.session)).state, 'printing');
  assert.equal(await readPrinterInfo(fallback.session), undefined);
});

test('readiness groups printer states for the printer cards', () => {
  assert.deepEqual(['idle', 'finished', 'failed', 'cancelled', 'printing', 'paused', 'preparing', 'busy', 'offline'].map(state => readiness({state})),
    ['ready', 'ready', 'ready', 'ready', 'busy', 'busy', 'busy', 'busy', 'offline']);
  assert.equal(readiness(undefined), 'unknown');
});

test('copies are offered only where the slice makes them: Bambu, or mcp-3D-printer-server on its Bambu-compatible route', () => {
  const slice = {name: 'slice_stl', inputSchema: {type: 'object', properties: {repetitions: {type: 'number'}}}};
  const tools = {server: {name: 'x', version: '1'}, tools: [slice]};
  const bambuConfig = {backend: 'bambu-printer-mcp', process: {command: '/x'}};
  const prusa = {backend: 'mcp-3d-printer-server', process: {command: '/x'}, slicer: {type: 'prusaslicer'}};
  const orcaBambu = {backend: 'mcp-3d-printer-server', process: {command: '/x'}, slicer: {type: 'orcaslicer-bambulab'}};
  assert.equal(detectCapabilities(bambuConfig, tools).copies, true);
  assert.equal(detectCapabilities(prusa, tools).copies, false, 'PrusaSlicer would slice one');
  assert.equal(detectCapabilities(orcaBambu, tools).copies, true);
  assert.equal(detectCapabilities(bambuConfig, {server: tools.server, tools: [{name: 'slice_stl', inputSchema: {type: 'object', properties: {}}}]}).copies, false);
});
