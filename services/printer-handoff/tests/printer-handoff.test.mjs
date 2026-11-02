import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  HandoffBundleStore,
  DispatchedPrintError,
  InMemoryElicitationRelay,
  PrinterHandoffRunner,
  PrinterMcpClient,
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

async function setup(t, {mode = 'bambu', backend = 'bambu-printer-mcp', answer = 'accept', relayTimeoutMs = 5000, dispatch, ephemeral = false, noColour = false, crypto = false, noConnectionType = false, settings = false, remote = false, slicer, slicerResult} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'printer-handoff-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const stlPath = join(root, 'clean.stl');
  await writeFile(stlPath, stl);
  const config = {
    backend,
    process: {command: process.execPath, args: [fixture, mode, log], cwd: root,
      env: {...(slicerResult ? {HANDOFF_FIXTURE_SLICER_RESULT: join(slicerResults, `${slicerResult}.json`)} : {}), ...(settings ? {HANDOFF_FIXTURE_SLICE_SETTINGS:'1'} : {}), ...(remote ? {HANDOFF_FIXTURE_REMOTE:'1'} : {}), ...(noConnectionType ? {HANDOFF_FIXTURE_NO_CONNECTION_TYPE:'1'} : {}), ...(crypto ? {HANDOFF_FIXTURE_CRYPTO:'1'} : {}), ...(dispatch ? {HANDOFF_FIXTURE_DISPATCH: dispatch} : {}), ...(ephemeral ? {HANDOFF_FIXTURE_EPHEMERAL: '1'} : {}), ...(noColour ? {HANDOFF_FIXTURE_NO_COLOUR:'1'} : {})}},
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
    setImmediate(() => relay.respond(pending.id, {action: 'accept', content}));
  });
  const steps = [];
  const runner = new PrinterHandoffRunner(config, {relay, onStep: step => steps.push(step)});
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return {root, log, stlPath, config, relay, runner, seen, steps, calls};
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
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['lay_flat', 'slice_stl', 'inspect_print_file', 'camera_snapshot', 'print_3mf']);
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

test('bambu sequence lays flat, slices, inspects and prints after phone confirmation, with no bed check', async t => {
  const f = await setup(t);
  const result = await f.runner.run({stlPath: f.stlPath});
  assert.deepEqual(result.steps, ['discover', 'lay_flat', 'slice_stl', 'inspect', 'print']);
  assert.ok(result.orientedStlPath.endsWith('clean_flat.stl'));
  assert.ok(result.slicedPath.endsWith('sliced.3mf'));
  assert.equal(result.inspection.tool, 'inspect_print_file');
  assert.equal(result.print.dispatch, 'started');
  const calls = (await f.calls()).filter(entry => entry.tool);
  // PRD §5.6: no camera_snapshot of the plate before printing; Bambu's own bed levelling finds a full plate.
  assert.deepEqual(calls.map(entry => entry.tool), ['lay_flat', 'slice_stl', 'inspect_print_file', 'print_3mf']);
  assert.deepEqual(calls[1].arguments, {
    stl_path: result.orientedStlPath, bambu_model: 'p1s', nozzle_diameter: '0.4',
    bed_type: 'textured_plate', nozzle_type: 'hardened_steel',
    use_printer_filaments: false, orient: false, arrange: true, ensure_on_bed: true,
  });
  assert.equal(calls[3].arguments.three_mf_path, result.slicedPath);
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
  assert.deepEqual(calls.map(entry => entry.tool), ['lay_flat', 'slice_stl', 'confirm_temperatures', 'upload_gcode']);
  assert.equal(result.inspection.tool, 'confirm_temperatures');
  assert.equal(calls.at(-1).arguments.print, true);
  assert.equal(calls.at(-1).arguments.type, 'klipper');
});

test('generic Bambu sequence prints the sliced 3MF with print_3mf', async t => {
  const f = await setup(t, {mode: 'generic', backend: 'mcp-3d-printer-server'});
  await f.runner.run({stlPath: f.stlPath, selection: {...selection, printerType: 'bambu'}});
  const calls = (await f.calls()).filter(entry => entry.tool);
  assert.deepEqual(calls.map(entry => entry.tool), ['lay_flat', 'slice_stl', 'print_3mf']);
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
  assert.equal(outcome.result.orientedStlPath, join(store.directory(bundle.id), outcome.manifest.artifacts.oriented.file));
  assert.ok((await readFile(outcome.result.slicedPath)).length > 0);
  assert.ok((await readFile(outcome.result.orientedStlPath)).length > 0);
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

test('failure saving the second artifact prevents dispatch despite the sliced artifact being saved', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'partial-artifacts'));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection});
  const recordArtifact = store.recordArtifact.bind(store);
  store.recordArtifact = async (id, key, name, bytes) => {
    if (key === 'oriented') throw Object.assign(Error('Cannot save oriented artifact'), {code: 'record-failed'});
    return recordArtifact(id, key, name, bytes);
  };
  await assert.rejects(f.runner.runBundle(store, bundle.id), {code: 'record-failed'});
  const manifest = await store.read(bundle.id);
  assert.ok(manifest.artifacts.sliced);
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

test('progress reaches the caller before each operation, including the last printer request', async t => {
  const f = await setup(t);
  const progress = [];
  await f.runner.run({stlPath:f.stlPath, onProgress:async update => {progress.push(update.phase);}});
  assert.deepEqual(progress, ['connecting','orienting','slicing','inspecting','slice-ready','checking-printer','requesting-print','accepted']);
});


test('failure recording accepted progress never makes an accepted print replayable', async t => {
  const f = await setup(t);
  const store = new HandoffBundleStore(join(f.root, 'accepted-progress'));
  const bundle = await store.create({stl,prompt:'',backend:'bambu-printer-mcp',selection});
  await f.runner.runBundle(store,bundle.id,{onProgress:async update=>{if(update.phase==='accepted')throw Error('disk full');}});
  assert.equal((await store.read(bundle.id)).status,'printed');
  await assert.rejects(f.runner.runBundle(store,bundle.id),{code:'already-printed'});
});


test('an explicitly selected authenticated transport reaches the MCP print tool', async t => {
  const f=await setup(t);
  await f.runner.run({stlPath:f.stlPath,selection:{...selection,connectionMode:'bambu_network',connectionType:'lan'}});
  const printed=(await f.calls()).find(x=>x.tool==='print_3mf');
  assert.equal(printed.arguments.connection_mode,'bambu_network');
  assert.equal(printed.arguments.connection_type,'lan');
});


test('authenticated LAN recovery relays the printer error acknowledgment before print clearance', async t => {
 const f=await setup(t,{crypto:true});
 await f.runner.run({stlPath:f.stlPath,selection:{...selection,connectionMode:'bambu_network',connectionType:'lan'}});
 const tools=(await f.calls()).filter(x=>x.tool).map(x=>x.tool);
 assert.ok(tools.indexOf('clear_hms_errors')<tools.indexOf('print_3mf'));
 assert.equal(f.seen.length,2);
});

test('declining error acknowledgment stops before the print command', async t => {
 const f=await setup(t,{crypto:true,answer:'decline'});
 await assert.rejects(f.runner.run({stlPath:f.stlPath,selection:{...selection,connectionMode:'bambu_network',connectionType:'lan'}}));
 assert.equal((await f.calls()).filter(x=>x.tool==='print_3mf').length,0);
});


test('an explicit LAN route cannot silently become cloud when a backend omits connection_type', async t => {
 const f=await setup(t,{noConnectionType:true});
 await assert.rejects(f.runner.run({stlPath:f.stlPath,selection:{...selection,connectionMode:'bambu_network',connectionType:'lan'}}),{code:'print-transport-unsupported'});
 assert.deepEqual(await f.calls(),[]);
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
    assert.deepEqual(tools, ['lay_flat', 'slice_stl', 'inspect_print_file', 'print_3mf']);
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
    assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['lay_flat', 'slice_stl', 'inspect_print_file']);
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
  assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['lay_flat', 'slice_stl']);
  assert.equal(f.seen.length, 0, 'nothing to confirm: there is no print');
  // The estimate refuses the same slice, so the print sheet never offers it.
  await assert.rejects(f.runner.estimate({stlPath: f.stlPath}), {code: 'slicer-error', detail: words});
});

test('a clean Bambu Studio slice goes straight to the printer\'s own confirmation, as before', async t => {
  assert.equal((await studio('cap-down-clean')).sliced_plates[0].warning_message, '');
  const f = await setup(t, {slicerResult: 'cap-down-clean'});
  const result = await f.runner.run({stlPath: f.stlPath});
  assert.equal('slicerWarning' in result, false);
  assert.equal(f.seen.length, 1);
  assert.match(f.seen[0].message, /^Fixture bed-clearance confirmation/);
  assert.deepEqual((await f.calls()).filter(entry => entry.tool).map(entry => entry.tool), ['lay_flat', 'slice_stl', 'inspect_print_file', 'print_3mf']);
});

test("an estimate reports Bambu Studio's warning without asking anything", async t => {
  const f = await setup(t, {slicerResult: 'as-scanned-floating-cantilever'});
  const result = await f.runner.run({stlPath: f.stlPath, print: false});
  assert.equal(result.slicerWarning, (await studio('as-scanned-floating-cantilever')).sliced_plates[0].warning_message);
  assert.equal(f.seen.length, 0);
});

test('slicer reports fail closed and keep Studio\'s words', async () => {
  const {slicerReport} = await import('../dist/index.js');
  assert.equal(slicerReport(undefined), undefined);
  assert.equal(slicerReport({path: '/x.3mf'}), undefined, 'an MCP without slicer_result: unchanged');
  assert.deepEqual(slicerReport({slicer_result: {return_code: 0, error_string: 'Success.', sliced_plates: [{warning_message: ''}]}}), {failed: false});
  assert.deepEqual(slicerReport({slicer_result: {error_string: 'Success.'}}), {failed: true, message: 'Success.'}, 'no return code is not success');
  assert.deepEqual(slicerReport({slicer_result: {return_code: -52}}), {failed: true, message: 'Bambu Studio could not slice this model (return code -52).'});
  assert.deepEqual(slicerReport({slicer_result: {return_code: 0, sliced_plates: [{warning_message: 'A.\r\nB.\u0007'}, {warning_message: 'A.\r\nB.\u0007'}]}}),
    {failed: false, message: 'A.\nB.'}, 'line breaks kept, other control characters dropped, one copy per message');
});
