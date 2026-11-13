import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  PrinterSession, detectCapabilities, readPrintReport, readPrinterInfo, readiness, updateCommand, readPrintRecordFrames, submitPrintAssessment,
} from '../dist/index.js';

const at = new Date('2026-11-01T18:00:00.000Z');
const bambu = {backend: 'bambu-printer-mcp', process: {command: '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js'}, selection: {model: 'p1s'}};
const generic = {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/npx', args: ['-y', 'mcp-3d-printer-server']}, selection: {printerType: 'octoprint', host: 'octopi.local'}};
const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const catalog = (...tools) => ({server: {name: 'srv', version: '1.2.3'}, tools});

test('capabilities come only from counterpart_printer_info; an MCP without the contract lights up nothing and says Update', () => {
  // An install from before counterpart/1 (get_printer_status only): no package-based guesses (PRD §8.0 item 4).
  const tools = [tool('get_printer_status'), tool('camera_snapshot'), tool('get_printer_filaments'),
    tool('pause_print'), tool('resume_print'), tool('cancel_print'), tool('slice_stl', {stl_path: {}})];
  for (const config of [bambu, {...bambu, selection: {model: 'x1c'}}, generic]) {
    const old = detectCapabilities(config, catalog(...tools), undefined, at);
    assert.equal(old.progress, false);
    assert.equal(old.camera, 'none', 'no camera kind is assumed from the package or the model');
    assert.equal(old.filaments, 'none', 'no AMS is assumed from the package');
    assert.equal(old.pause, false);
    assert.equal(old.cancel, false);
    assert.deepEqual(old.missing, ['progress', 'quality', 'strength']);
    assert.match(old.update.message, /^Update (bambu-printer-mcp|mcp-3D-printer-server) to see progress and choose quality and strength\.$/);
  }
  assert.deepEqual(detectCapabilities(bambu, catalog(...tools), undefined, at).update.command, ['npm', 'install', '-g', 'bambu-printer-mcp@latest']);
  const oldGeneric = detectCapabilities(generic, catalog(tool('get_printer_status'), tool('cancel_print'), tool('slice_stl')), undefined, at);
  assert.deepEqual(oldGeneric.missing, ['progress', 'camera', 'filaments', 'pause', 'resume', 'quality', 'strength']);
  assert.equal(oldGeneric.update.message, 'Update mcp-3D-printer-server to see progress, camera and the loaded filament, pause and resume prints and choose quality and strength.');
  assert.equal(oldGeneric.update.command, undefined, 'npx fetches the latest itself');
  const info = {contract: 'counterpart/1', server: {name: 'mcp-3d-printer-server', version: '1.3.0'},
    printer: {kind: 'prusa', host: 'prusa.local'},
    capabilities: {progress: true, layers: false, camera: 'none', filaments: 'single', pause: true, resume: true, cancel: true, print3mf: false, gcode: true}};
  const contractTools = [tool('counterpart_printer_info'), tool('counterpart_print_progress'), tool('camera_snapshot'),
    tool('get_printer_filaments'), tool('pause_print'), tool('resume_print'), tool('cancel_print'), tool('slice_stl', {quality: {}, strength: {}})];
  const updated = detectCapabilities(generic, catalog(...contractTools), info, at);
  assert.equal(updated.contract, 'counterpart/1');
  assert.equal(updated.progress, true);
  assert.equal(updated.camera, 'none', 'the firmware has no camera: not something an update unlocks');
  assert.deepEqual(updated.missing, []);
  assert.equal(updated.update, undefined);
  // Whatever the package, what lights up is what the MCP said.
  const bambuInfo = {...info, printer: {kind: 'bambu', host: 'p1s.local', model: 'x1c'}, capabilities: {...info.capabilities, layers: true, camera: 'rtsp', filaments: 'ams'}};
  const fromBambu = detectCapabilities(generic, catalog(...contractTools), bambuInfo, at);
  assert.deepEqual([fromBambu.camera, fromBambu.filaments, fromBambu.layers], ['rtsp', 'ams', true]);
  assert.deepEqual(fromBambu.missing, ['multi-colour'], 'an AMS printer without counterpart_make_3mf: Update');
  // The contract tool is there but has not answered yet: nothing is assumed meanwhile, and nothing is called missing.
  const pending = detectCapabilities(bambu, catalog(...contractTools), undefined, at);
  assert.deepEqual([pending.progress, pending.camera, pending.filaments, pending.pause], [false, 'none', 'none', false]);
  assert.deepEqual(pending.missing, []);
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
  // An MCP from before counterpart/1: its raw get_printer_status is never read in its place (PRD §8.0 item 4).
  const old = sessionWith([tool('get_printer_status')], {get_printer_status: json({state: {flags: {printing: true}}})});
  await assert.rejects(readPrintReport(old.session), error => error.code === 'progress-unavailable' && /^Update mcp-3D-printer-server in Settings → Printers/.test(error.detail));
  assert.deepEqual(old.calls, []);
  assert.equal(await readPrinterInfo(old.session), undefined);
});

// #766: both MCPs return printer.displayName in counterpart/1 (bambu-printer-mcp 1.1.93, mcp-3D-printer-server 1.2.75), the
// model with its maker as the MCP names it. It is kept as given; an install without it, or one this version can't read, still
// gives its printer info, capabilities and all.
test('#766: counterpart_printer_info keeps printer.displayName as the MCP gives it, and never needs it', async () => {
  const info = {contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.94'},
    printer: {kind: 'bambu', model: 'P1S', displayName: 'Bambu Lab P1S', serial: '01P00A000000000', host: '192.0.2.1'},
    capabilities: {progress: true, layers: true, camera: 'bambu-tcp', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true}};
  const read = async printer => {
    const {session} = sessionWith([tool('counterpart_printer_info')], {counterpart_printer_info: json({...info, printer})});
    await session.connect();
    return readPrinterInfo(session);
  };
  assert.equal((await read(info.printer)).printer.displayName, 'Bambu Lab P1S');
  const {displayName: _displayName, ...older} = info.printer;
  const withoutIt = await read(older);
  assert.equal(withoutIt.printer.model, 'P1S');
  assert.equal('displayName' in withoutIt.printer, false);
  for (const unreadable of [42, '', '   ', 'x'.repeat(121)]) {
    const kept = await read({...info.printer, displayName: unreadable});
    assert.equal(kept?.capabilities.camera, 'bambu-tcp', `a displayName of ${JSON.stringify(unreadable).slice(0, 12)} costs nothing else`);
    assert.equal(kept.printer.displayName, undefined);
  }
  // A name padded with spaces is shown without them (review of #779).
  assert.equal((await read({...info.printer, displayName: '  Bambu Lab P1S '})).printer.displayName, 'Bambu Lab P1S');
});

test('#630: progress.physical is forwarded (verdict, evidence, the frame to judge); a physical field this version cannot read never costs the report', async () => {
  const frameId = '5468cf4d-81d5-46ab-b8db-2e3342938a53';
  const physical = {status: 'unknown', evidence: [], limitations: ['Firmware completion is separate from physical success.'],
    assessment: {required: true, frameId, referenceFrameIds: [], layer: 1, expectedHeightMm: 0.2, expectedFootprintMm: [10.6, 71.3, 245.4, 180.6], instruction: 'Fetch this frame'}};
  const progress = {contract: 'counterpart/1', observedAt: at.toISOString(), state: 'printing', job: {name: 'part', layer: 1, totalLayers: 265}, problems: [], physical};
  const {session} = sessionWith([tool('counterpart_print_progress', {host: {}, type: {}})], {counterpart_print_progress: json(progress)});
  const report = await readPrintReport(session);
  assert.deepEqual(report.physical, {status: 'unknown', evidence: [], assessment: {required: true, frameId, referenceFrameIds: [], layer: 1, expectedHeightMm: 0.2, expectedFootprintMm: [10.6, 71.3, 245.4, 180.6]}});
  const newer = sessionWith([tool('counterpart_print_progress')], {counterpart_print_progress: json({...progress, physical: {status: 'suspect_something_new', evidence: [frameId], assessment: {frameId: 'not-a-frame'}}})});
  const kept = await readPrintReport(newer.session);
  assert.deepEqual([kept.physical.status, kept.physical.evidence, kept.physical.assessment], ['suspect_something_new', [frameId], undefined], 'an unreadable assessment is dropped, the verdict kept');
  const broken = sessionWith([tool('counterpart_print_progress')], {counterpart_print_progress: json({...progress, physical: 'yes'})});
  const report2 = await readPrintReport(broken.session);
  assert.equal(report2.physical, undefined);
  assert.equal(report2.state, 'printing');
});

test('#630: counterpart_print_record images are bound to their frames, and counterpart_print_assess gets the exact hashes and the route', async () => {
  const jobId = '1b2c3d4e-0000-4000-8000-000000000000', frameId = '5468cf4d-81d5-46ab-b8db-2e3342938a53', sha = 'a'.repeat(64), artifact = 'b'.repeat(64);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const record = {contract: 'counterpart/1', status: 'recorded', record: {id: jobId, dispatch: {sha256: artifact}, frames: [
    {id: frameId, role: 'first_layer', layer: 1, status: 'captured', sha256: sha, imageContentIndex: 1, expectedHeightMm: 0.2},
    {id: '00000000-0000-4000-8000-000000000001', role: 'periodic', layer: 11, status: 'captured', sha256: sha}]}, physical: {status: 'unknown', evidence: [], limitations: []}};
  const assessed = {contract: 'counterpart/1', status: 'recorded', physical: {status: 'suspect_no_extrusion', evidence: [frameId], limitations: []}};
  const {session, calls} = sessionWith([
    tool('counterpart_print_record', {frame_format: {}, frame_ids: {}, job_id: {}, host: {}, type: {}, port: {}}),
    tool('counterpart_print_assess', {job_id: {}, artifact_sha256: {}, frame_id: {}, image_sha256: {}, visibility: {}, footprint_visible: {}, deposition: {}, attempted: {}, host: {}, type: {}}),
  ], {
    counterpart_print_record: {content: [{type: 'text', text: JSON.stringify(record)}, {type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg'}], structuredContent: record},
    counterpart_print_assess: {content: [{type: 'text', text: JSON.stringify(assessed)}], structuredContent: assessed},
  });
  const frames = await readPrintRecordFrames(session, [frameId]);
  assert.deepEqual(calls[0], {name: 'counterpart_print_record', args: {host: 'octopi.local', type: 'octoprint', frame_format: 'images', frame_ids: [frameId]}});
  assert.equal(frames.jobId, jobId);
  assert.equal(frames.artifactSha256, artifact);
  assert.equal(frames.frames.length, 1, 'only the frames asked for');
  assert.deepEqual(frames.frames[0].jpeg, jpeg);
  const physical = await submitPrintAssessment(session, {jobId, artifactSha256: artifact, frameId, imageSha256: sha, visibility: 'clear', footprintVisible: true, deposition: 'absent', attempted: true});
  assert.deepEqual(calls[1], {name: 'counterpart_print_assess', args: {host: 'octopi.local', type: 'octoprint', job_id: jobId, artifact_sha256: artifact, frame_id: frameId,
    image_sha256: sha, visibility: 'clear', footprint_visible: true, deposition: 'absent', attempted: true}});
  assert.equal(physical.status, 'suspect_no_extrusion');
  const old = sessionWith([tool('counterpart_print_progress')], {});
  assert.equal(await readPrintRecordFrames(old.session, [frameId]), undefined);
  assert.equal(await submitPrintAssessment(old.session, {jobId, artifactSha256: artifact, frameId, imageSha256: sha, visibility: 'clear', footprintVisible: true, deposition: 'absent', attempted: true}), undefined);
  assert.deepEqual(old.calls, []);
});

test('readiness groups printer states for the printer cards', () => {
  assert.deepEqual(['idle', 'finished', 'failed', 'cancelled', 'printing', 'paused', 'preparing', 'busy', 'offline'].map(state => readiness({state})),
    ['ready', 'ready', 'ready', 'ready', 'busy', 'busy', 'busy', 'busy', 'offline']);
  assert.equal(readiness(undefined), 'unknown');
});

test('copies are offered only where the MCP says its slice makes them (capabilities.slicing), whatever the slicer is called', () => {
  const slice = {name: 'slice_stl', inputSchema: {type: 'object', properties: {repetitions: {type: 'number'}}}};
  const tools = {server: {name: 'x', version: '1'}, tools: [slice, {name: 'counterpart_printer_info'}]};
  const config = {backend: 'mcp-3d-printer-server', process: {command: '/x'}, slicer: {type: 'prusaslicer'}};
  const info = copies => ({contract: 'counterpart/1', server: {name: 'x', version: '1'}, printer: {kind: 'bambu', host: 'h'},
    capabilities: {progress: true, layers: true, camera: 'none', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true,
      ...(copies === undefined ? {} : {slicing: {supports: true, copies, orient: true}})}});
  assert.equal(detectCapabilities(config, tools, info(true)).copies, true, 'the MCP says so: the slicer type is not the app\'s business');
  assert.equal(detectCapabilities(config, tools, info(false)).copies, false, 'its slice would make one');
  assert.equal(detectCapabilities(config, tools, info(undefined)).copies, false, 'an MCP from before the field: Update');
  assert.equal(detectCapabilities(config, {server: tools.server, tools: [{name: 'slice_stl', inputSchema: {type: 'object', properties: {}}}]}, info(true)).copies, false);
});
