import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync, unzipSync, strToU8} from 'fflate';
import {
  HandoffBundleStore,
  DispatchedPrintError,
  InMemoryElicitationRelay,
  PrinterHandoffRunner,
  PrinterMcpClient,
  PrinterMcpError,
  PrinterSession,
  printerSelectionSchema,
  readPrinterHandoffConfig,
} from '../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/fixture-printer-server.mjs', import.meta.url));
// Real Bambu Studio 02.08.02.61 result.json files from David's stove gap filler (bundle 4dd27c10), sliced by
// bambu-printer-mcp's own sliceSTL: --orient 1 (empty layers), the lay_flat output and the scan as it is
// (floating cantilever), and the lay_flat output turned cap-down (clean).
const slicerResults = fileURLToPath(new URL('./fixtures/slicer-results/', import.meta.url));
const studio = async name => JSON.parse(await readFile(join(slicerResults, `${name}.json`), 'utf8'));
const stl = Buffer.from('solid fixture\n' + ' facet\n'.repeat(20) + 'endsolid fixture\n');
const selection = {
  model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel',
  bedType: 'textured_plate', material: 'PLA', plateIndex: 0,
};

async function setup(t, {progress = false, route, mode = 'bambu', backend = 'bambu-printer-mcp', answer = 'accept', relayTimeoutMs = 5000, choice, dispatch, ephemeral = false, noColour = false, crypto = false, noConnectionType = false, settings = false, supports = false, remote = false, slicer, slicerResult, noSlicerReport = false, noSlicedFacts = false, laidFlat, slicedBytes, slicing, ownProcess, ownProcessArgs, noPlates = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'printer-handoff-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const stlPath = join(root, 'clean.stl');
  await writeFile(stlPath, stl);
  if (slicedBytes) await writeFile(join(root, 'fixture-output.3mf'), slicedBytes);
  const config = {
    backend,
    process: {command: process.execPath, args: [fixture, mode, log], cwd: root,
      env: {...(progress ? {HANDOFF_FIXTURE_PROGRESS: '1'} : {}), ...(slicedBytes ? {HANDOFF_FIXTURE_SLICED_FILE: join(root, 'fixture-output.3mf')} : {}), ...(laidFlat !== undefined ? {HANDOFF_FIXTURE_LAID_FLAT: String(laidFlat)} : {}), ...(slicerResult ? {HANDOFF_FIXTURE_SLICER_RESULT: join(slicerResults, `${slicerResult}.json`)} : {}), ...(noSlicerReport ? {HANDOFF_FIXTURE_NO_SLICER_REPORT: '1'} : {}), ...(noSlicedFacts ? {HANDOFF_FIXTURE_NO_SLICED_FACTS: '1'} : {}), ...(settings ? {HANDOFF_FIXTURE_SLICE_SETTINGS:'1'} : {}), ...(supports ? {HANDOFF_FIXTURE_SUPPORTS:'1'} : {}), ...(slicing ? {HANDOFF_FIXTURE_SLICING: slicing} : {}), ...(remote ? {HANDOFF_FIXTURE_REMOTE:'1'} : {}), ...(noConnectionType ? {HANDOFF_FIXTURE_NO_CONNECTION_TYPE:'1'} : {}), ...(crypto ? {HANDOFF_FIXTURE_CRYPTO:'1'} : {}), ...(route ? {HANDOFF_FIXTURE_ROUTE: JSON.stringify(route)} : {}), ...(dispatch ? {HANDOFF_FIXTURE_DISPATCH: dispatch} : {}), ...(ephemeral ? {HANDOFF_FIXTURE_EPHEMERAL: '1'} : {}), ...(noColour ? {HANDOFF_FIXTURE_NO_COLOUR:'1'} : {}), ...(ownProcess ? {HANDOFF_FIXTURE_OWN_PROCESS: ownProcess} : {}), ...(ownProcessArgs ? {HANDOFF_FIXTURE_OWN_PROCESS_ARGS: ownProcessArgs} : {}), ...(noPlates ? {HANDOFF_FIXTURE_NO_PLATES: '1'} : {})}},
    selection,
    ...(slicer ? {slicer} : {}),
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: relayTimeoutMs},
  };
  const seen = [];
  const relay = new InMemoryElicitationRelay({timeoutMs: relayTimeoutMs});
  relay.subscribe(pending => {
    seen.push(pending);
    if (answer === 'none') return;
    if (answer === 'decline') {
      setImmediate(() => relay.respond(pending.id, {action: 'decline'}));
      return;
    }
    const properties = pending.requestedSchema?.properties ?? {};
    const content = {};
    if ('confirmed' in properties) content.confirmed = true;
    if ('bambu_model' in properties) content.bambu_model = 'p1s';
    if ('choice' in properties) content.choice = choice ?? properties.choice.oneOf?.[0]?.const;
    setImmediate(() => relay.respond(pending.id, {action: 'accept', content}));
  });
  const steps = [];
  const runner = new PrinterHandoffRunner(config, {relay, onStep: step => steps.push(step)});
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return {root, log, stlPath, config, relay, runner, seen, steps, calls};
}

// Counterpart is a bridge: the model goes to the slicer as it is and the slicer orients it, even when the MCP offers lay_flat.
for (const laidFlat of [false, true]) {
  test(`an STL goes to the slicer as it is, with the slicer orienting it (lay_flat offered, laid_flat=${laidFlat})`, async t => {
    const f = await setup(t, {laidFlat});
    const result = await f.runner.run({stlPath: f.stlPath, print: false});
    const calls = (await f.calls()).filter(call => call.tool);
    assert.ok(!calls.some(call => call.tool === 'lay_flat'), 'Counterpart never re-orients the model itself');
    const slice = calls.find(call => call.tool === 'slice_stl');
    assert.equal(slice.arguments.orient, true, 'the slicer orients every STL');
    assert.equal(slice.arguments.stl_path, f.stlPath);
    assert.equal(result.orientedStlPath, f.stlPath);
    assert.deepEqual(result.steps, ['discover', 'slice_stl', 'inspect']);
    assert.ok(!calls.some(call => call.tool === 'print_3mf'));
  });
}

for (const enableSupport of [true, false]) {
  test(`the designer's supports choice reaches the slicer as it is (enable_support=${enableSupport})`, async t => {
    const f = await setup(t, {supports: true});
    await f.runner.run({stlPath: f.stlPath, print: false, slicer: {enableSupport, ...(enableSupport ? {supportType: 'tree(auto)'} : {})}});
    const slice = (await f.calls()).find(call => call.tool === 'slice_stl');
    assert.equal(slice.arguments.enable_support, enableSupport, 'supports off is sent too, never left to the profile');
    assert.equal(slice.arguments.support_type, enableSupport ? 'tree(auto)' : undefined);
  });
}

test('no supports choice leaves the slicer profile in charge, as before', async t => {
  const f = await setup(t, {supports: true});
  await f.runner.run({stlPath: f.stlPath, print: false});
  const slice = (await f.calls()).find(call => call.tool === 'slice_stl');
  assert.equal('enable_support' in slice.arguments, false);
  assert.equal('support_type' in slice.arguments, false);
});

for (const slicer of [{enableSupport: false}, {enableSupport: true, supportType: 'normal(auto)'}]) {
  test(`a supports choice the installed MCP can't take is refused before slicing (${JSON.stringify(slicer)})`, async t => {
    const f = await setup(t);
    await assert.rejects(f.runner.run({stlPath: f.stlPath, slicer}), {code: 'print-settings-unsupported'});
    assert.deepEqual((await f.calls()).filter(call => call.tool).map(call => call.tool), []);
  });
}

test('config file parses backend, process, selection and timeouts', async t => {
  const f = await setup(t);
  const path = join(f.root, 'config.json');
  await writeFile(path, JSON.stringify(f.config));
  assert.deepEqual(await readPrinterHandoffConfig(path), f.config);
});

test('a selected colour and profile reach slicing and its AMS slot reaches printing', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'selected-filament'));
  const manifest = await store.create({stl, prompt:'', backend:'bambu-printer-mcp',
    selection:{...selection, useAms:true, amsSlots:[1], autoMatchAms:false}});
  await f.runner.runBundle(store, manifest.id, {slicer:{loadFilaments:'/profiles/pla.json', filamentColours:'#FEC600'}});
  const calls = await f.calls();
  const slice = calls.find(call => call.tool === 'slice_stl');
  const print = calls.find(call => call.tool === 'print_3mf');
  assert.equal(slice.arguments.load_filaments, '/profiles/pla.json');
  assert.equal(slice.arguments.filament_colours, '#FEC600');
  assert.deepEqual(print.arguments.ams_slots, [1]);
  assert.equal(print.arguments.auto_match_ams, false);
});

test('a chosen spool\'s profile replaces the configured filament alias instead of sending both', async t => {
  const f = await setup(t);
  const runner = new PrinterHandoffRunner({...f.config, slicer: {filamentProfile: 'Generic PLA @BBL P1S'}}, {relay: f.relay});
  const store = new HandoffBundleStore(join(f.root, 'chosen-profile'));
  const manifest = await store.create({stl, prompt:'', backend:'bambu-printer-mcp', selection:{...selection, useAms:true, amsSlots:[0], autoMatchAms:false}});
  await runner.runBundle(store, manifest.id, {slicer:{loadFilaments:'/profiles/petg.json', filamentColours:'#000000'}});
  const slice = (await f.calls()).find(call => call.tool === 'slice_stl');
  assert.equal(slice.arguments.load_filaments, '/profiles/petg.json');
  assert.equal(slice.arguments.filament_profile, undefined);
  // Without a chosen profile the configured one is still sent.
  await runner.run({stlPath: f.stlPath, print: false});
  assert.equal((await f.calls()).filter(call => call.tool === 'slice_stl').at(-1).arguments.filament_profile, 'Generic PLA @BBL P1S');
});

test('a backend that cannot honour the chosen colour is refused before slicing or dispatch', async t => {
  const f = await setup(t, {noColour:true});
  await assert.rejects(f.runner.run({stlPath:f.stlPath, slicer:{loadFilaments:'/profiles/pla.json', filamentColours:'#FEC600'}}), /filament-selection-unsupported/);
  assert.deepEqual(await f.calls(), []);
});

test('bundle store creates, verifies, claims and records designed artifacts', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'bundles'));
  const created = await store.create({stl, prompt: 'make it fit', backend: 'bambu-printer-mcp', selection});
  assert.equal(created.status, 'ready');
  assert.equal((await store.read(created.id)).cleanStl.byteLength, stl.length);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.claim(created.id, 'desktop-agent')).status, 'claimed');
  const designed = await store.writeDesignedStl(created.id, Buffer.concat([stl, Buffer.from(' ')]));
  assert.equal(designed.status, 'designed');
  assert.ok(store.stlPath(designed).endsWith('designed.stl'));
  const recorded = await store.recordArtifact(created.id, 'notes', 'notes.txt', Buffer.from('ok'));
  assert.equal(recorded.artifacts.notes.file, 'notes.txt');
  await assert.rejects(store.read('../outside'), /uuid|Invalid/i);
});

test('replacing bundle artifacts twice stays readable; claim requires ready', async t => {
  const f = await setup(t);
  const bundles = join(f.root, 'bundles2');
  const store = new HandoffBundleStore(bundles);
  const created = await store.create({stl, prompt: 'replace me', backend: 'bambu-printer-mcp', selection});
  await store.claim(created.id, 'desktop-agent');
  await assert.rejects(store.claim(created.id, 'second-agent'), /not ready/);
  const first = await store.writeDesignedStl(created.id, Buffer.concat([stl, Buffer.from(' ')]));
  const secondBytes = Buffer.concat([stl, Buffer.from('  ')]);
  const second = await store.writeDesignedStl(created.id, secondBytes);
  assert.notEqual(second.designedStl.file, first.designedStl.file);
  assert.equal((await store.read(created.id)).designedStl.byteLength, secondBytes.length);
  assert.deepEqual(await readFile(store.stlPath(second)), secondBytes);
  await store.recordArtifact(created.id, 'notes', 'notes.txt', Buffer.from('one'));
  const notes = await store.recordArtifact(created.id, 'notes', 'notes.txt', Buffer.from('two!!'));
  assert.equal((await store.read(created.id)).artifacts.notes.byteLength, 5);
  assert.notEqual(notes.artifacts.notes.file, 'notes.txt');
  await assert.rejects(store.recordArtifact(created.id, 'bad', '../escape.txt', Buffer.from('x')));
  const manifestPath = join(bundles, created.id, 'handoff.json');
  const tampered = JSON.parse(await readFile(manifestPath, 'utf8'));
  tampered.cleanStl.file = '../outside.stl';
  await writeFile(manifestPath, JSON.stringify(tampered));
  await assert.rejects(store.read(created.id));
});

test('a new artifact key cannot overwrite a file owned by another bundle entry', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'bundles-collide'));
  const created = await store.create({stl, prompt: 'collide', backend: 'bambu-printer-mcp', selection});
  await store.recordArtifact(created.id, 'notes', 'notes.txt', Buffer.from('first'));
  const second = await store.recordArtifact(created.id, 'other', 'notes.txt', Buffer.from('second!!'));
  assert.notEqual(second.artifacts.other.file, 'notes.txt');
  const guarded = await store.recordArtifact(created.id, 'sneaky', 'clean.stl', Buffer.from('not the scan'));
  assert.notEqual(guarded.artifacts.sneaky.file, 'clean.stl');
  const read = await store.read(created.id);
  assert.equal(read.artifacts.notes.byteLength, 5);
  assert.equal(read.artifacts.other.byteLength, 8);
  assert.equal(read.cleanStl.byteLength, stl.length);
});

test('elicitation relay never answers itself: timeout resolves cancel', async () => {
  const relay = new InMemoryElicitationRelay({timeoutMs: 20});
  const pending = relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'confirm', requestedSchema: {type: 'object', properties: {}}}});
  assert.equal(relay.pending().length, 1);
  assert.equal(relay.respond('missing', {action: 'cancel'}), false);
  assert.deepEqual(await pending, {action: 'cancel'});
  assert.equal(relay.pending().length, 0);
});

test('discovery lists fixture tools without calling one', async t => {
  const f = await setup(t);
  const catalog = await f.runner.discover();
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['counterpart_printer_info', 'lay_flat', 'slice_stl', 'list_3mf_plates', 'inspect_print_file', 'camera_snapshot', 'print_3mf']);
  assert.equal((await f.calls()).filter(entry => entry.tool).length, 0);
});

test('MCP server stderr is forwarded to the configured callback', async t => {
  const f = await setup(t);
  let stderr = '';
  const runner = new PrinterHandoffRunner(f.config, {onStderr: chunk => { stderr += chunk; }});
  await runner.discover();
  assert.match(stderr, /fixture stderr ready/);
});

test('tool arguments are validated against the discovered schema before the call', async t => {
  const f = await setup(t);
  const client = new PrinterMcpClient(f.config, {relay: f.relay});
  await client.connect();
  await assert.rejects(client.callTool('slice_stl', {stl_path: f.stlPath, surprise: true}), {code: 'invalid-tool-arguments'});
  await client.close();
  assert.equal((await f.calls()).filter(entry => entry.tool === 'slice_stl').length, 0);
});

test('bambu sequence slices, inspects and prints after phone confirmation, with no bed check', async t => {
  const f = await setup(t);
  const result = await f.runner.run({stlPath: f.stlPath});
  assert.deepEqual(result.steps, ['discover', 'slice_stl', 'inspect', 'print']);
  assert.equal(result.orientedStlPath, f.stlPath);
  assert.ok(result.slicedPath.endsWith('sliced.3mf'));
  assert.equal(result.inspection.tool, 'inspect_print_file');
  assert.equal(result.print.dispatch, 'started');
  const calls = (await f.calls()).filter(entry => entry.tool);
  // PRD §5.6: no camera_snapshot of the plate before printing; Bambu's own bed levelling finds a full plate.
  assert.deepEqual(calls.map(entry => entry.tool), ['slice_stl', 'inspect_print_file', 'print_3mf']);
  assert.deepEqual(calls[0].arguments, {
    stl_path: f.stlPath, bambu_model: 'p1s', nozzle_diameter: '0.4',
    bed_type: 'textured_plate', nozzle_type: 'hardened_steel',
    use_printer_filaments: false, orient: true, arrange: true, ensure_on_bed: true,
  });
  assert.equal(calls[2].arguments.three_mf_path, result.slicedPath);
  assert.equal('cameraSnapshot' in f.seen.at(-1), false);
  assert.equal(f.relay.pending().length, 0);
});

test('missing bambu model is elicited instead of guessed', async t => {
  const f = await setup(t);
  const result = await f.runner.run({stlPath: f.stlPath, selection: {...selection, model: undefined}});
  assert.equal(result.print.dispatch, 'started');
  assert.ok(f.seen.some(pending => 'bambu_model' in (pending.requestedSchema?.properties ?? {})));
  assert.ok((await f.calls()).some(entry => entry.tool === 'slice_stl' && entry.arguments.bambu_model === 'p1s'));
});

test('declined and timed-out confirmations do not print', async t => {
  const declined = await setup(t, {answer: 'decline'});
  await assert.rejects(declined.runner.run({stlPath: declined.stlPath}), {code: 'tool-failed'});
  const slow = await setup(t, {answer: 'none', relayTimeoutMs: 50});
  await assert.rejects(slow.runner.run({stlPath: slow.stlPath}), {code: 'tool-failed'});
  for (const f of [declined, slow]) {
    const elicitations = (await f.calls()).filter(entry => entry.elicitation);
    assert.notEqual(elicitations.at(-1).elicitation.action, 'accept');
    assert.equal(f.relay.pending().length, 0);
  }
});

test('generic gcode sequence confirms temperatures then uploads with print set', async t => {
  const f = await setup(t, {mode: 'generic-gcode', backend: 'mcp-3d-printer-server'});
  const result = await f.runner.run({stlPath: f.stlPath, selection: {printerType: 'klipper', material: 'PLA'}});
  const calls = (await f.calls()).filter(entry => entry.tool);
  assert.deepEqual(calls.map(entry => entry.tool), ['slice_stl', 'confirm_temperatures', 'upload_gcode']);
  assert.equal(result.inspection.tool, 'confirm_temperatures');
  assert.equal(calls.at(-1).arguments.print, true);
  assert.equal(calls.at(-1).arguments.type, 'klipper');
});

// PrusaSlicer and Cura have no auto-orient through the MCP and refuse support arguments: the model goes to them as it is.
test('a slice route without orient or supports gets the model as it is, and a supports choice is refused before slicing', async t => {
  // As mcp-3d-printer-server 1.2.32 reports a PrusaSlicer route: the app reads it, it never names slicers.
  const prusa = JSON.stringify({supports: false, copies: false, orient: false});
  const f = await setup(t, {mode: 'generic-gcode', backend: 'mcp-3d-printer-server', supports: true, slicing: prusa});
  await f.runner.run({stlPath: f.stlPath, selection: {printerType: 'klipper', material: 'PLA'}});
  const slice = (await f.calls()).find(entry => entry.tool === 'slice_stl');
  assert.equal('orient' in slice.arguments, false, 'orient only where the MCP says its slice orients');
  assert.equal(slice.arguments.stl_path, f.stlPath);
  const refused = await setup(t, {mode: 'generic-gcode', backend: 'mcp-3d-printer-server', supports: true, slicing: prusa});
  await assert.rejects(refused.runner.run({stlPath: refused.stlPath, selection: {printerType: 'klipper', material: 'PLA'}, slicer: {enableSupport: false}}), {code: 'print-settings-unsupported'});
  assert.deepEqual((await refused.calls()).filter(entry => entry.tool).map(entry => entry.tool), []);
});

test('generic Bambu sequence prints the sliced 3MF with print_3mf', async t => {
  const f = await setup(t, {mode: 'generic', backend: 'mcp-3d-printer-server'});
  await f.runner.run({stlPath: f.stlPath, selection: {...selection, printerType: 'bambu'}});
  const calls = (await f.calls()).filter(entry => entry.tool);
  assert.deepEqual(calls.map(entry => entry.tool), ['slice_stl', 'print_3mf']);
  assert.equal(calls.at(-1).arguments.nozzle_diameter, '0.4');
});

test('runBundle prints a claimed bundle and records the sliced artifact back', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'bundles'));
  const bundle = await store.create({stl, prompt: 'print a copy', backend: 'bambu-printer-mcp', selection});
  await store.claim(bundle.id, 'desktop-agent');
  const outcome = await f.runner.runBundle(store, bundle.id);
  assert.equal(outcome.manifest.status, 'printed');
  assert.equal(outcome.manifest.artifacts.sliced.file, 'sliced.3mf');
  assert.equal(outcome.result.print.dispatch, 'started');
  assert.equal(outcome.result.stlPath, store.stlPath(outcome.manifest));
  assert.equal(outcome.result.slicedPath, join(store.directory(bundle.id), outcome.manifest.artifacts.sliced.file));
  // The slicer orients the model itself: Counterpart records no re-oriented copy.
  assert.equal(outcome.manifest.artifacts.oriented, undefined);
  assert.equal(outcome.result.orientedStlPath, store.stlPath(outcome.manifest));
  assert.ok((await readFile(outcome.result.slicedPath)).length > 0);
  assert.ok(!outcome.result.slicedPath.includes('printer-handoff-run-'));
});

test('slicing the same bundle twice with different output bytes stays readable', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'bundles-twice'));
  const bundle = await store.create({stl, prompt: 'slice twice', backend: 'bambu-printer-mcp', selection});
  const first = await f.runner.runBundle(store, bundle.id, {print: false});
  assert.equal(first.manifest.status, 'sliced');
  await store.writeDesignedStl(bundle.id, Buffer.concat([stl, Buffer.from(' ')]));
  const second = await f.runner.runBundle(store, bundle.id, {print: false});
  assert.equal(second.manifest.status, 'sliced');
  assert.notEqual(second.manifest.artifacts.sliced.sha256, first.manifest.artifacts.sliced.sha256);
  assert.equal((await store.read(bundle.id)).artifacts.sliced.sha256, second.manifest.artifacts.sliced.sha256);
});

test('runBundle tags every printer question with its own bundle, so answers reach the right print', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'bundles'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  await f.runner.runBundle(store, bundle.id);
  assert.ok(f.seen.length > 0);
  for (const pending of f.seen) assert.equal(pending.bundleId, bundle.id);
});

test('runBundle stores only a bare failure code on the bundle', async t => {
  const f = await setup(t, {answer: 'decline'});
  const store = new HandoffBundleStore(join(f.root, 'bundles-failcode'));
  const bundle = await store.create({stl, prompt: 'decline it', backend: 'bambu-printer-mcp', selection});
  await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'tool-failed'});
  const read = await store.read(bundle.id);
  assert.equal(read.status, 'failed');
  assert.equal(read.failure, 'tool-failed');
});

for (const print of [true, false]) {
  test(`runBundle refuses dispatch when recording output fails (print=${print})`, async t => {
    const f = await setup(t);
    const store = new HandoffBundleStore(join(f.root, 'bundles-record-failure'));
    const bundle = await store.create({stl, prompt: 'record failure', backend: 'bambu-printer-mcp', selection});
    store.recordArtifact = async () => {
      throw Object.assign(new Error('/private/operator/output failed'), {code: 'record-failed'});
    };
    await assert.rejects(f.runner.runBundle(store, bundle.id, {print}), {code: 'record-failed'});
    assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, 0);
    const read = await store.read(bundle.id);
    assert.equal(read.status, 'failed');
    assert.equal(read.failure, 'record-failed');
  });
}

for (const mode of ['bambu', 'generic-gcode']) for (const print of [true, false]) {
  test(`backend exit cleanup leaves durable artifacts and dispatch paths (${mode}, print=${print})`, async t => {
    const backend = mode === 'bambu' ? 'bambu-printer-mcp' : 'mcp-3d-printer-server';
    const f = await setup(t, {mode, backend, ephemeral: true});
    const store = new HandoffBundleStore(join(f.root, 'durable'));
    const bundle = await store.create({stl, prompt: 'Retain the sliced artifact.', backend, selection});
    const outcome = await f.runner.runBundle(store, bundle.id, {print});
    assert.equal(outcome.manifest.status, print ? 'printed' : 'sliced');
    assert.ok((await readFile(outcome.result.slicedPath)).length > 0);
    assert.ok((await readFile(outcome.result.orientedStlPath)).length > 0);
    const calls = (await f.calls()).filter(call => call.tool);
    const originalOriented = calls.find(call => call.tool === 'slice_stl').arguments.stl_path;
    await assert.rejects(readFile(originalOriented), {code: 'ENOENT'});
    const dispatches = calls.filter(call => ['print_3mf', 'upload_gcode'].includes(call.tool));
    assert.equal(dispatches.length, print ? 1 : 0);
    if (print) {
      const dispatchedPath = dispatches[0].arguments.three_mf_path ?? dispatches[0].arguments.gcode_path;
      assert.equal(dispatchedPath, outcome.result.slicedPath);
      assert.ok(dispatchedPath.startsWith(store.directory(bundle.id)));
    }
  });
}

test('failure saving the sliced artifact prevents dispatch', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'partial-artifacts'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  const recordArtifact = store.recordArtifact.bind(store);
  store.recordArtifact = async (id, key, name, bytes) => {
    if (key === 'sliced') throw Object.assign(Error('Cannot save sliced artifact'), {code: 'record-failed'});
    return recordArtifact(id, key, name, bytes);
  };
  await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'record-failed'});
  const manifest = await store.read(bundle.id);
  assert.equal(manifest.artifacts.sliced, undefined);
  assert.equal(manifest.status, 'failed');
  assert.equal((await f.calls()).filter(call => call.tool === 'print_3mf').length, 0);
});

test('failure recording success after dispatch preserves printed state and cannot replay', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'dispatched-status'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  const setStatus = store.setStatus.bind(store);
  let failOnce = true;
  store.setStatus = async (id, status, failure) => {
    if (status === 'printed' && failOnce) { failOnce = false; throw Object.assign(Error('Cannot record success'), {code: 'record-failed'}); }
    return setStatus(id, status, failure);
  };
  await assert.rejects(f.runner.runBundle(store, bundle.id), error => error instanceof DispatchedPrintError && error.code === 'record-failed');
  assert.equal((await store.read(bundle.id)).status, 'printed');
  await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'already-printed'});
  assert.equal((await f.calls()).filter(call => call.tool === 'print_3mf').length, 1);
});

test('aborting a run awaiting confirmation clears its pending elicitation', async t => {
  const f = await setup(t, {answer: 'none', relayTimeoutMs: 60000});
  const controller = new AbortController();
  const run = f.runner.run({stlPath: f.stlPath, signal: controller.signal});
  for (let attempt = 0; attempt < 200 && f.relay.pending().length === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.relay.pending().length, 1);
  controller.abort();
  await assert.rejects(run);
  assert.deepEqual(f.relay.pending(), []);
});

test('process_and_print_stl uses the generic server one-call pipeline', async t => {
  const f = await setup(t, {mode: 'generic', backend: 'mcp-3d-printer-server'});
  const outcome = await f.runner.processAndPrint({stlPath: f.stlPath, extensionInches: 0.5, material: 'PLA', selection: {printerType: 'klipper'}});
  assert.equal(outcome.result.dispatch, 'started');
  const call = (await f.calls()).find(entry => entry.tool === 'process_and_print_stl');
  assert.equal(call.arguments.extension_inches, 0.5);
});

for (const mode of ['bambu', 'generic-gcode']) {
  for (const dispatch of ['crash', 'timeout']) {
    test(`uncertain ${mode} ${dispatch} cannot replay even with a new store`, async t => {
      const backend = mode === 'bambu' ? 'bambu-printer-mcp' : 'mcp-3d-printer-server';
      const f = await setup(t, {mode, backend, dispatch});
      const directory = join(f.root, 'uncertain');
      const store = new HandoffBundleStore(directory);
      const bundle = await store.create({stl, prompt: 'fixture', backend, selection});
      await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'dispatch-uncertain'});
      const fresh = new HandoffBundleStore(directory);
      assert.equal((await fresh.read(bundle.id)).status, 'uncertain');
      await assert.rejects(f.runner.runBundle(fresh, bundle.id), {code: 'dispatch-uncertain'});
      assert.equal((await f.calls()).filter(x => ['print_3mf','upload_gcode'].includes(x.tool)).length, 1);
    });
  }
}
test('failed dispatch intent persistence prevents the print tool call', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'intent'));
  const bundle = await store.create({stl, prompt: 'fixture', backend: 'bambu-printer-mcp', selection});
  const setStatus = store.setStatus.bind(store);
  store.setStatus = async (id, status, failure) => {
    if (status === 'uncertain') throw Object.assign(Error('disk full'), {code: 'storage-unavailable'});
    return setStatus(id, status, failure);
  };
  await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'storage-unavailable'});
  assert.equal((await f.calls()).filter(x => x.tool === 'print_3mf').length, 0);
  assert.equal((await store.read(bundle.id)).status, 'failed');
});
test('a successful retry clears its prior failure code', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'retry'));
  const bundle = await store.create({stl, prompt: 'fixture', backend: 'bambu-printer-mcp', selection});
  await store.setStatus(bundle.id, 'failed', 'tool-failed');
  const result = await f.runner.runBundle(store, bundle.id);
  assert.equal(result.manifest.status, 'printed');
  assert.equal(result.manifest.failure, undefined);
});


test('a known pre-dispatch printer refusal preserves its reason without claiming it may have started', async t => {
  const f = await setup(t, {dispatch:'preflight-error'});
  await assert.rejects(f.runner.run({stlPath:f.stlPath}), error => {
    assert.equal(error.code, 'printer-not-ready');
    assert.match(error.detail, /Printer state FAILED is not safely idle/);
    return true;
  });
});

test('an upload that never reached the printer is a certain non-start, not an uncertain print', async t => {
  const f = await setup(t, {dispatch:'upload-error'});
  const store = new HandoffBundleStore(join(f.root, 'upload'));
  const bundle = await store.create({stl, prompt: 'fixture', backend: 'bambu-printer-mcp', selection});
  await assert.rejects(f.runner.runBundle(store, bundle.id, {print: true}), error => {
    assert.equal(error.code, 'printer-upload-failed');
    assert.match(error.detail, /did not reach the printer/);
    return true;
  });
  const manifest = await store.read(bundle.id);
  assert.equal(manifest.status, 'failed', 'a retry is allowed: nothing reached the printer');
  assert.equal(manifest.failure, 'printer-upload-failed');
});

test('the refusal is read from the code, never the words: an MCP without the code is not trusted as a refusal', async t => {
  const f = await setup(t, {dispatch:'preflight-error-wording'});
  await assert.rejects(f.runner.run({stlPath:f.stlPath}), error => {
    assert.notEqual(error.code, 'printer-not-ready', 'matching the message is the MCP\'s job (PRD §8.0)');
    return true;
  });
});

test('progress reaches the caller before each operation, including the last printer request', async t => {
  const f = await setup(t);
  const progress = [];
  await f.runner.run({stlPath:f.stlPath, onProgress:async update => {progress.push(update.phase);}});
  assert.deepEqual(progress, ['connecting','slicing','inspecting','slice-ready','checking-printer','requesting-print','accepted']);
});


test('failure recording accepted progress never makes an accepted print replayable', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'accepted-progress'));
  const bundle = await store.create({stl,prompt:'',backend:'bambu-printer-mcp',selection});
  await f.runner.runBundle(store,bundle.id,{onProgress:async update=>{if(update.phase==='accepted')throw Error('disk full');}});
  assert.equal((await store.read(bundle.id)).status,'printed');
  await assert.rejects(f.runner.runBundle(store,bundle.id),{code:'already-printed'});
});


// Handoff item 10: the HMS 0500_0500_0001_0007 auto-clear was a workaround for the old route bug. The MCP owns
// its route and reports that rejection itself; Print never reads or clears the printer's errors on its own.
// Handoff item 10: resetTimeoutOnProgress was set, but without a handler the SDK never asked for progress, so none
// arrived, the timeout never reset, and the caller never heard it.
test('the printer MCP\'s progress reaches the caller, in the phase it belongs to', async t => {
 const f=await setup(t,{progress:true});
 const seen=[];
 await f.runner.run({stlPath:f.stlPath,print:false,onProgress:async update=>{if(update.mcp)seen.push(update);}});
 assert.deepEqual(seen,[{phase:'slicing',mcp:{progress:1,total:2,message:'Slicing plate 1'}},{phase:'slicing',mcp:{progress:2,total:2,message:'Writing the 3MF'}}]);
});

test('print_3mf\'s upload progress reaches the caller with its counterpart/1 stage and byte counts', async t => {
 const f=await setup(t,{progress:true});
 const seen=[];
 await f.runner.run({stlPath:f.stlPath,onProgress:async update=>{if(update.mcp?.stage)seen.push(update);}});
 assert.deepEqual(seen.map(({phase,mcp})=>[phase,mcp.stage,mcp.progress,mcp.total]),
  [['requesting-print','upload',0,18_362_734],['requesting-print','upload',5_000_000,18_362_734],['requesting-print','upload',18_362_734,18_362_734]]);
});

test('Print never clears a printer error itself, even over FULU with the old rejection showing', async t => {
 const f=await setup(t,{crypto:true,route:{mode:'bambu_network',type:'lan'}});
 await f.runner.run({stlPath:f.stlPath});
 const tools=(await f.calls()).filter(x=>x.tool).map(x=>x.tool);
 assert.equal(tools.includes('clear_hms_errors'),false);
 assert.equal(tools.includes('counterpart_print_route'),false,'Print reads no route copy for it either');
 assert.ok(tools.includes('print_3mf'));
 assert.equal(f.seen.length,1,'only the print\'s own confirmation is asked');
});

test('an older printer-handoff.json or bundle that still carries selection.connectionMode loads, and the key is dropped', async t => {
 const legacy={...selection,connectionMode:'bambu_network',connectionType:'lan'};
 const parsed=printerSelectionSchema.parse(legacy);
 assert.equal(Object.hasOwn(parsed,'connectionMode'),false);
 assert.equal(parsed.connectionType,'lan');
 assert.throws(()=>printerSelectionSchema.parse({...selection,connectionMod:'typo'}),'other unknown keys are still refused');
 const f=await setup(t,{crypto:true,route:{mode:'bambu_network',type:'lan'}});
 await f.runner.run({stlPath:f.stlPath,selection:legacy});
 assert.ok((await f.calls()).some(x=>x.tool==='print_3mf'));
});

test('print_3mf carries no route: the printer service prints over its own configured connection', async t => {
 const f=await setup(t,{route:{mode:'bambu_network',type:'lan'}});
 await f.runner.run({stlPath:f.stlPath});
 const printed=(await f.calls()).find(x=>x.tool==='print_3mf');
 assert.ok(printed,'printed');
 assert.equal(printed.arguments.connection_mode,undefined);
 assert.equal(printed.arguments.connection_type,undefined);
});

test('quality and strength reach slice_stl as process overrides, and are refused by an MCP without them', async t => {
  const f = await setup(t, {});
  const slicer = {layerHeightMm: 0.12, wallLoops: 4, sparseInfillDensity: '25%'};
  await assert.rejects(f.runner.run({stlPath: f.stlPath, slicer}), {code: 'print-settings-unsupported'});
  assert.equal((await f.calls()).filter(call => call.tool).length, 0, 'nothing sliced or sent');
  const g = await setup(t, {settings: true, remote: true});
  const result = await g.runner.run({stlPath: g.stlPath, slicer});
  const slice = (await g.calls()).find(call => call.tool === 'slice_stl');
  assert.equal(slice.arguments.layer_height, 0.12);
  assert.equal(slice.arguments.wall_loops, 4);
  assert.equal(slice.arguments.sparse_infill_density, '25%');
  // Today's bambu-printer-mcp returns the uploaded path; the printer reports its name without .3mf.
  assert.deepEqual(result.dispatch, {jobName: 'checked-1b2c-sliced', fileBase: 'sliced'});
  // Copies: slice_stl repetitions, refused by an MCP without it; one copy sends nothing.
  await assert.rejects(f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 3}}), {code: 'print-settings-unsupported'});
  const h = await setup(t, {settings: true, remote: true});
  await h.runner.run({stlPath: h.stlPath, slicer: {repetitions: 3}});
  assert.equal((await h.calls()).find(call => call.tool === 'slice_stl').arguments.repetitions, 3);
});

test('named copies override the config: repetitions 3 in the profile, one copy asked for, one sliced (print and estimate)', async t => {
  const f = await setup(t, {settings: true, remote: true, slicer: {repetitions: 3}});
  const slices = async () => (await f.calls()).filter(call => call.tool === 'slice_stl').map(call => call.arguments.repetitions);
  await f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 1}});
  assert.deepEqual(await slices(), [1]);
  // The estimate slices exactly as Print would (its fixture 3MF has no estimate to read).
  await f.runner.estimate({stlPath: f.stlPath, slicer: {repetitions: 1}}).catch(() => undefined);
  assert.deepEqual(await slices(), [1, 1]);
  // Nothing named: the profile's own repetitions.
  await f.runner.run({stlPath: f.stlPath});
  assert.deepEqual(await slices(), [1, 1, 3]);
  // An MCP without repetitions: one copy is its default, so nothing is sent and nothing refused.
  const g = await setup(t, {});
  await g.runner.run({stlPath: g.stlPath, slicer: {repetitions: 1}});
  assert.equal((await g.calls()).find(call => call.tool === 'slice_stl').arguments.repetitions, undefined);
});

test('copies split across plates explain the separate prints before estimate or dispatch', async t => {
  const f = await setup(t, {settings: true, slicerResult: 'copies-two-plates'});
  const options = {stlPath: f.stlPath, slicer: {repetitions: 2}};
  const expected = {code: 'copies-multiple-plates', detail: 'The slicer placed 2 copies on 2 plates, requiring 2 separate prints. Choose fewer copies for this print.'};
  await assert.rejects(f.runner.estimate(options), expected);
  await assert.rejects(f.runner.run(options), expected);
  assert.equal(f.seen.length, 0, 'no print is offered with fewer than the requested copies');
  assert.ok(!(await f.calls()).some(call => call.tool === 'print_3mf'));
});

test('multiple copies on one plate still reach the existing print flow', async t => {
  const f = await setup(t, {settings: true, slicerResult: 'cap-down-clean'});
  await f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 2}});
  assert.equal((await f.calls()).filter(call => call.tool === 'print_3mf').length, 1);
});

test('path-only MCP output cannot silently drop copies on a second plate', async t => {
  const slicedBytes = zipSync({'Metadata/plate_1.gcode': strToU8('; one'), 'Metadata/plate_2.gcode': strToU8('; two')});
  const f = await setup(t, {settings: true, slicedBytes});
  await assert.rejects(f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 2}}), {code: 'copies-multiple-plates'});
  assert.ok(!(await f.calls()).some(call => call.tool === 'print_3mf'));
});

test('copies need the MCP to say how many plates the slice has: an MCP that gives no count is refused with Update, never printed short', async t => {
  // Codex on #344: a path-only slice of two plates from an MCP without `sliced` or `slicer_report`.
  const slicedBytes = zipSync({'Metadata/plate_1.gcode': strToU8('; one'), 'Metadata/plate_2.gcode': strToU8('; two')});
  const f = await setup(t, {settings: true, slicedBytes, noSlicedFacts: true});
  const expected = error => error.code === 'print-settings-unsupported' && /^Update bambu-printer-mcp in Settings → Printers to print copies/.test(error.detail);
  await assert.rejects(f.runner.estimate({stlPath: f.stlPath, slicer: {repetitions: 2}}), expected);
  await assert.rejects(f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 2}}), expected);
  assert.ok(!(await f.calls()).some(call => call.tool === 'print_3mf'));
  // One copy needs no count.
  await f.runner.run({stlPath: f.stlPath, slicer: {repetitions: 1}});
  assert.equal((await f.calls()).filter(call => call.tool === 'print_3mf').length, 1);
});

test('one-plate copy estimate uses the sliced total without multiplying it again', async t => {
  const slicedBytes = zipSync({'Metadata/plate_1.gcode': strToU8('; two copies'),
    'Metadata/slice_info.config': strToU8('<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="1800"/><metadata key="weight" value="20"/></plate></config>')});
  const f = await setup(t, {settings: true, slicedBytes});
  const result = await f.runner.estimate({stlPath: f.stlPath, slicer: {repetitions: 2}});
  assert.deepEqual(result.estimate, {seconds: 1800, grams: 20});
});

for (const name of ['lay-flat-floating-cantilever', 'as-scanned-floating-cantilever']) {
  test(`Bambu Studio's warning (${name}) is shown word for word and printed only on the user's explicit go`, async t => {
    const words = (await studio(name)).sliced_plates[0].warning_message;
    assert.match(words, /has floating cantilever\. Please re-orient the object or enable support generation\.$/);
    const f = await setup(t, {slicerResult: name});
    const result = await f.runner.run({stlPath: f.stlPath});
    assert.equal(result.slicerWarning, words);
    // Studio's question first, in its own words, tagged like the printer's; then the MCP's own print confirmation.
    assert.equal(f.seen.length, 2);
    assert.equal(f.seen[0].message, words);
    assert.deepEqual(f.seen[0].requestedSchema, {type: 'object', required: ['confirmed'],
      properties: {confirmed: {type: 'boolean', title: 'Print anyway', default: false}}});
    assert.equal(result.print.dispatch, 'started');
    const tools = (await f.calls()).filter(entry => entry.tool).map(entry => entry.tool);
    assert.deepEqual(tools, ['slice_stl', 'inspect_print_file', 'print_3mf']);
  });
}

test("declining or not answering Bambu Studio's warning stops before the printer is asked anything", async t => {
  const words = (await studio('lay-flat-floating-cantilever')).sliced_plates[0].warning_message;
  const declined = await setup(t, {slicerResult: 'lay-flat-floating-cantilever', answer: 'decline'});
  const store = new HandoffBundleStore(join(declined.root, 'declined-warning'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  await assert.rejects(declined.runner.runBundle(store, bundle.id), error => {
    assert.equal(error.code, 'slicer-warning-declined');
    assert.equal(error.detail, words);
    return true;
  });
  assert.equal((await store.read(bundle.id)).failure, 'slicer-warning-declined');
  const timedOut = await setup(t, {slicerResult: 'lay-flat-floating-cantilever', answer: 'none', relayTimeoutMs: 50});
  await assert.rejects(timedOut.runner.run({stlPath: timedOut.stlPath}), {code: 'slicer-warning-declined'});
  for (const f of [declined, timedOut]) {
    assert.equal(f.seen.length, 1, 'only Studio\'s question was asked');
    assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['slice_stl', 'inspect_print_file']);
    assert.equal(f.relay.pending().length, 0);
  }
});

test("aborting a print waiting on Bambu Studio's warning withdraws the question", async t => {
  const f = await setup(t, {slicerResult: 'lay-flat-floating-cantilever', answer: 'none', relayTimeoutMs: 60000});
  const controller = new AbortController();
  const run = f.runner.run({stlPath: f.stlPath, signal: controller.signal});
  for (let attempt = 0; attempt < 200 && f.relay.pending().length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.relay.pending().length, 1);
  controller.abort();
  await assert.rejects(run, {code: 'cancelled'});
  assert.deepEqual(f.relay.pending(), []);
  assert.equal((await f.calls()).filter(entry => entry.tool === 'print_3mf').length, 0);
});

test("Bambu Studio's slicing error blocks the print and keeps its own words", async t => {
  const result = await studio('orient-empty-layers');
  const words = `${result.error_string}\n${result.sliced_plates[0].warning_message}`;
  assert.match(words, /^Failed slicing the model\. .*\nObject can't be printed for empty layer between 18\.2 and 24\.4\./s);
  const f = await setup(t, {slicerResult: 'orient-empty-layers'});
  // The person reads the MCP's sentence; the slicer's own words (slicer_message) go to the companion's log, once per refusal.
  const logged = [];
  const error = console.error;
  console.error = (...line) => { if (String(line[0]).startsWith('slicer refused')) logged.push(line.join(' ')); else error(...line); };
  t.after(() => { console.error = error; });
  const store = new HandoffBundleStore(join(f.root, 'slicer-error'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  await assert.rejects(f.runner.runBundle(store, bundle.id), error => {
    assert.equal(error.code, 'slicer-error');
    assert.equal(error.detail, words);
    return true;
  });
  const read = await store.read(bundle.id);
  assert.equal(read.status, 'failed');
  assert.equal(read.failure, 'slicer-error');
  assert.equal(read.artifacts.sliced, undefined, 'no sliced file to print');
  assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['slice_stl']);
  assert.equal(f.seen.length, 0, 'nothing to confirm: there is no print');
  // The estimate refuses the same slice, so the print sheet never offers it.
  await assert.rejects(f.runner.estimate({stlPath: f.stlPath}), {code: 'slicer-error', detail: words});
  const logLine = `slicer refused the slice: Studio: ${words.replace(/\s+/g, ' ').trim()}`;
  assert.deepEqual(logged, [logLine, logLine], 'the print and the estimate each logged the slicer\'s words once');
});

test('a clean Bambu Studio slice goes straight to the printer\'s own confirmation, as before', async t => {
  assert.equal((await studio('cap-down-clean')).sliced_plates[0].warning_message, '');
  const f = await setup(t, {slicerResult: 'cap-down-clean'});
  const result = await f.runner.run({stlPath: f.stlPath});
  assert.equal('slicerWarning' in result, false);
  assert.equal(f.seen.length, 1);
  assert.match(f.seen[0].message, /^Fixture bed-clearance confirmation/);
  assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['slice_stl', 'inspect_print_file', 'print_3mf']);
});

test("an estimate reports Bambu Studio's warning without asking anything", async t => {
  const f = await setup(t, {slicerResult: 'as-scanned-floating-cantilever'});
  const result = await f.runner.run({stlPath: f.stlPath, print: false});
  assert.equal(result.slicerWarning, (await studio('as-scanned-floating-cantilever')).sliced_plates[0].warning_message);
  assert.equal(f.seen.length, 0);
});

test("the slicer's verdict is read from the MCP's slicer_report, and an MCP that passes only result.json must be updated", async t => {
  const {slicerReport, lacksSlicerReport} = await import('../dist/index.js');
  assert.equal(slicerReport(undefined), undefined);
  assert.equal(slicerReport({path: '/x.3mf'}), undefined);
  assert.deepEqual(slicerReport({slicer_report: {failed: false, plate_count: 2}}), {failed: false, plateCount: 2});
  assert.deepEqual(slicerReport({slicer_report: {failed: true, message: 'Failed slicing the model.'}}), {failed: true, message: 'Failed slicing the model.'});
  assert.deepEqual(slicerReport({slicer_report: {failed: true, message: 'The slicer couldn\'t slice this model.', slicer_message: 'Failed slicing the model.'}}),
    {failed: true, message: 'The slicer couldn\'t slice this model.', slicerMessage: 'Failed slicing the model.'}, 'the slicer\'s own words, for the log');
  assert.equal(slicerReport({slicer_report: {message: 'no verdict'}}), undefined, 'a report without its verdict is none');
  // Counterpart never reads result.json itself (PRD §8.0 item 9): an MCP from before slicer_report is refused, never trusted.
  assert.equal(lacksSlicerReport({path: '/x.3mf', slicer_result: {return_code: 0}}), true);
  assert.equal(lacksSlicerReport({path: '/x.3mf'}), false, 'a slicer without a result.json');
  const f = await setup(t, {slicerResult: 'lay-flat-floating-cantilever', noSlicerReport: true});
  await assert.rejects(f.runner.run({stlPath: f.stlPath}), error => error.code === 'slicer-report-unavailable' && /^Update bambu-printer-mcp in Settings → Printers/.test(error.detail));
  assert.ok(!(await f.calls()).some(call => call.tool === 'print_3mf'), 'a slice whose warning the app can\'t see is never printed');
});

test('the printer MCP\'s design guidance is read as an MCP prompt, and an MCP without prompts gives none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'printer-prompts-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const config = env => ({backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [fixture, 'bambu', join(root, 'calls.jsonl')], cwd: root, env},
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 5000}});
  const serving = new PrinterMcpClient(config({HANDOFF_FIXTURE_PROMPTS: '1'}));
  t.after(() => serving.close());
  await serving.connect();
  assert.equal(await serving.prompt('fdm_design'), 'Design the finished object the user wants, with the manufacturing plan as part of the design.');
  assert.equal(await serving.prompt('fdm_unknown'), undefined, 'an unknown prompt is no guidance, not a failure');
  const older = new PrinterMcpClient(config({}));
  t.after(() => older.close());
  await older.connect();
  assert.equal(await older.prompt('fdm_design'), undefined);
});


const LEGACY_ASK = {message: 'This design was made in several colours before Counterpart kept each colour as its own part.', title: 'Colours',
  choices: [{value: 'one-colour', title: 'Print it in one colour'}, {value: 'remake', title: 'Make it again in colour'}], proceed: 'one-colour'};

test("Counterpart's own question comes before slicing: only the proceed choice slices and prints", async t => {
  const go = await setup(t, {choice: 'one-colour'});
  const result = await go.runner.run({stlPath: go.stlPath, ask: LEGACY_ASK});
  assert.equal(go.seen[0].message, LEGACY_ASK.message);
  assert.deepEqual(go.seen[0].requestedSchema, {type: 'object', required: ['choice'], properties: {choice: {type: 'string', title: 'Colours',
    oneOf: [{const: 'one-colour', title: 'Print it in one colour'}, {const: 'remake', title: 'Make it again in colour'}]}}});
  assert.equal(result.print.dispatch, 'started');
  assert.deepEqual((await go.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['slice_stl', 'inspect_print_file', 'print_3mf']);
});

test("another choice, a decline or a timeout on Counterpart's question stops before anything is sliced; an estimate never asks", async t => {
  const remake = await setup(t, {choice: 'remake'});
  await assert.rejects(remake.runner.run({stlPath: remake.stlPath, ask: LEGACY_ASK}), {code: 'print-choice', detail: 'remake'});
  const declined = await setup(t, {answer: 'decline'});
  await assert.rejects(declined.runner.run({stlPath: declined.stlPath, ask: LEGACY_ASK}), {code: 'print-choice', detail: 'declined'});
  const timedOut = await setup(t, {answer: 'none', relayTimeoutMs: 50});
  await assert.rejects(timedOut.runner.run({stlPath: timedOut.stlPath, ask: LEGACY_ASK}), {code: 'print-choice', detail: 'declined'});
  for (const f of [remake, declined, timedOut]) {
    assert.equal(f.seen.length, 1, 'only Counterpart\'s question was asked');
    assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), [], 'nothing sliced or sent');
    assert.equal(f.relay.pending().length, 0);
  }
  const estimate = await setup(t, {choice: 'remake'});
  await estimate.runner.run({stlPath: estimate.stlPath, print: false, ask: LEGACY_ASK});
  assert.equal(estimate.seen.length, 0, 'an estimate slices without asking');
});

test("an estimate returns its exact sliced file and the MCP's preview of it; Print sends that file, never a fresh slice (Nov 5)", async t => {
  const {createHash} = await import('node:crypto');
  const slicedBytes = zipSync({'Metadata/plate_1.gcode': strToU8('; the previewed slice')});
  const f = await setup(t, {settings: true, slicedBytes});
  const shown = await f.runner.estimate({stlPath: f.stlPath});
  assert.equal(shown.sliced.sha256, createHash('sha256').update(shown.sliced.bytes).digest('hex'));
  assert.equal(shown.preview.sha256, shown.sliced.sha256, 'the preview is of exactly that file');
  assert.deepEqual(shown.preview.views.map(view => view.name), ['top', 'bed_side']);
  const inspected = (await f.calls()).filter(call => call.tool === 'inspect_print_file');
  assert.equal(inspected.at(-1).arguments.include_preview, true);
  const slicesBefore = (await f.calls()).filter(call => call.tool === 'slice_stl').length;
  await f.runner.run({stlPath: f.stlPath, presliced: {bytes: shown.sliced.bytes, extension: shown.sliced.extension}, expectedSha256: shown.sliced.sha256});
  const calls = (await f.calls()).filter(call => call.tool);
  assert.equal(calls.filter(call => call.tool === 'slice_stl').length, slicesBefore, 'not sliced again');
  assert.ok(calls.some(call => call.tool === 'print_3mf'), 'the shown file printed');
});

test('Print refuses, sending nothing, when the file about to be sent is not the one previewed', async t => {
  const f = await setup(t, {settings: true});
  await assert.rejects(f.runner.run({stlPath: f.stlPath, presliced: {bytes: Buffer.from('PK another file'), extension: '.3mf'}, expectedSha256: 'a'.repeat(64)}),
    {code: 'preview-mismatch'});
  assert.equal((await f.calls()).some(call => call.tool === 'print_3mf'), false, 'nothing was sent');
});

test("a designer's 3MF prints with its own process only when the MCP says so, asked with this printer's own slice arguments", async t => {
  // Nov 5: the print sheet carried the last print's quality and strength over to a copy of a designer's 3MF. Whether
  // the file has its own settings is the MCP's to say (get_slice_settings own_process); the app never reads the 3MF.
  const ask = async (options, slicer) => {
    const f = await setup(t, {ownProcess: options, ...(slicer ? {slicer} : {})});
    const own = await f.runner.ownProcess({modelPath: f.stlPath});
    return {own, calls: (await f.calls()).filter(call => call.tool === 'get_slice_settings')};
  };
  const yes = await ask('true');
  assert.equal(yes.own, true);
  assert.deepEqual(yes.calls[0].arguments, {source_path: yes.calls[0].arguments.source_path, bambu_model: 'p1s', nozzle_diameter: '0.4'}, 'the bambu_model and nozzle a slice sends');
  assert.equal((await ask('false')).own, false);
  {
    // A failed call is the MCP's to explain; the app reads nothing into it and decides nothing.
    const f = await setup(t, {ownProcess: 'error'});
    await assert.rejects(f.runner.ownProcess({modelPath: f.stlPath}), error => error instanceof PrinterMcpError);
  }
  assert.equal((await ask('absent')).own, 'unsupported', 'an MCP that does not say: update it, never guessed');
  // This printer's own slice arguments go to the MCP as slice_stl takes them; the MCP decides, the app passes them on.
  const named = await ask('true', {profile: '/p/mine.json', templateName: 'house', layerHeightMm: 0.2, wallLoops: 3, sparseInfillDensity: '20%', quality: 'fine', strength: 'strong'});
  assert.equal(named.own, false);
  assert.deepEqual(named.calls[0].arguments, {source_path: named.calls[0].arguments.source_path, bambu_model: 'p1s', nozzle_diameter: '0.4', slicer_profile: '/p/mine.json', template_name: 'house',
    layer_height: 0.2, wall_loops: 3, sparse_infill_density: '20%', quality: 'fine', strength: 'strong'});
  for (const slicer of [{profile: '/p/mine.json'}, {layerHeightMm: 0.2}, {strength: 'strong'}])
    assert.equal((await ask('true', slicer)).own, false, `the MCP says this printer's ${Object.keys(slicer)[0]} changes the file's process`);
  assert.equal((await ask('true', {quality: 'standard'})).own, true, 'standard changes nothing');
  // The design's own supports go too, as Print sends them.
  const supported = await setup(t, {ownProcess: 'true'});
  assert.equal(await supported.runner.ownProcess({modelPath: supported.stlPath, slicer: {enableSupport: true, supportType: 'tree(auto)'}}), false);
  assert.deepEqual((await supported.calls()).find(call => call.tool === 'get_slice_settings').arguments,
    {source_path: supported.stlPath, bambu_model: 'p1s', nozzle_diameter: '0.4', enable_support: true, support_type: 'tree(auto)'});
  // An MCP that can't take one of this printer's arguments would answer for another slice: unknown.
  const old = await setup(t, {ownProcess: 'true', ownProcessArgs: 'old', slicer: {layerHeightMm: 0.2}});
  assert.equal(await old.runner.ownProcess({modelPath: old.stlPath}), 'unsupported');
  const none = await setup(t, {});
  assert.equal(await none.runner.ownProcess({modelPath: none.stlPath}), 'unsupported', 'no get_slice_settings at all');
  // A 3MF's slice never gets the config's template, quality, strength or process values (runSlicer), so neither does
  // the question: only the profile and slicer that its slice does get.
  const threeMf = await setup(t, {ownProcess: 'true', slicer: {profile: '/p/mine.json', templateName: 'house', layerHeightMm: 0.2, quality: 'fine', strength: 'strong'}});
  const designer = join(threeMf.root, 'designer.3mf');
  await writeFile(designer, Buffer.from('not read by the fixture'));
  await threeMf.runner.ownProcess({modelPath: designer});
  assert.deepEqual((await threeMf.calls()).find(call => call.tool === 'get_slice_settings').arguments,
    {source_path: designer, bambu_model: 'p1s', nozzle_diameter: '0.4', slicer_profile: '/p/mine.json'});
});

// A designer's 3MF keeps its own plates (David, Nov 6: "if i download the 3d scanning rig ... and open it in bambu, it
// just shows up as six plates. BEFORE slicing"). The plates come from the MCP's list_3mf_plates, never from the app.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC', 'base64');
const sixPlates = () => {
  const plate = n => `<plate><metadata key="plater_id" value="${n}"/><metadata key="plater_name" value="Plate ${n} parts"/><model_instance><metadata key="object_id" value="${n}"/></model_instance></plate>`;
  const objects = [1, 2, 3, 4, 5, 6].map(n => `<object id="${n}"><metadata key="name" value="Part ${n}"/></object>`).join('');
  return Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config': strToU8(`<config>${objects}${[1, 2, 3, 4, 5, 6].map(plate).join('')}</config>`),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`Metadata/plate_${n}.png`, new Uint8Array(PNG_1PX)]))}));
};
test("a designer's six-plate 3MF lists its six plates and their pictures from the MCP", async t => {
  const f = await setup(t);
  const path = join(f.root, 'kit.3mf');
  await writeFile(path, sixPlates());
  const listed = await f.runner.modelPlates({modelPath: path});
  assert.deepEqual(listed.plates.map(plate => [plate.index, plate.name, plate.objects, plate.sliced]),
    [1, 2, 3, 4, 5, 6].map(n => [n - 1, `Plate ${n} parts`, [`Part ${n}`], false]));
  assert.ok(listed.plates.every(plate => plate.thumbnail?.equals(PNG_1PX)), 'each plate has its own picture');
  assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['list_3mf_plates']);
});

test('an MCP without list_3mf_plates is one to update, for listing and for printing a plate', async t => {
  const f = await setup(t, {noPlates: true});
  const path = join(f.root, 'kit.3mf');
  await writeFile(path, sixPlates());
  const update = {code: 'plates-unsupported', detail: 'Update bambu-printer-mcp in Settings → Printers to show this file’s plates.'};
  await assert.rejects(f.runner.modelPlates({modelPath: path}), update);
  await assert.rejects(f.runner.run({stlPath: path, selection: {plateIndex: 2}}), update);
  assert.ok(!(await f.calls()).some(call => ['slice_stl', 'print_3mf'].includes(call.tool)), 'nothing sliced or sent');
});

// Codex on #370: a kit's plate pictures can together pass the usual 1 MiB result limit. Listing them (a read) is
// bounded by the forwarding limit instead, and the print path's plate check asks for no pictures at all.
test('large plate pictures still list, and the print path checks the plate without pictures', async t => {
  const f = await setup(t);
  const big = Buffer.concat([PNG_1PX.subarray(0, 24), Buffer.alloc(300 * 1024, 7)]);
  const entries = {...Object.fromEntries(Object.entries(unzipSync(sixPlates())))};
  for (let n = 1; n <= 6; n++) entries[`Metadata/plate_${n}.png`] = new Uint8Array(big);
  const path = join(f.root, 'kit.3mf');
  await writeFile(path, Buffer.from(zipSync(entries)));
  const listed = await f.runner.modelPlates({modelPath: path});
  assert.equal(listed.plates.length, 6);
  assert.ok(listed.plates.every(plate => plate.thumbnail?.length === big.length));
  await f.runner.estimate({stlPath: path, selection: {plateIndex: 3}}).catch(() => undefined);
  const lists = (await f.calls()).filter(call => call.tool === 'list_3mf_plates');
  assert.deepEqual(lists.map(call => call.arguments.include_thumbnails), [true, false]);
});
