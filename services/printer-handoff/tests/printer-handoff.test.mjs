import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  HandoffBundleStore,
  InMemoryElicitationRelay,
  PrinterHandoffRunner,
  PrinterMcpClient,
  readPrinterHandoffConfig,
} from '../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/fixture-printer-server.mjs', import.meta.url));
const stl = Buffer.from('solid fixture\n' + ' facet\n'.repeat(20) + 'endsolid fixture\n');
const selection = {
  model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel',
  bedType: 'textured_plate', material: 'PLA', plateIndex: 0,
};

async function setup(t, {mode = 'bambu', backend = 'bambu-printer-mcp', answer = 'accept', relayTimeoutMs = 5000, dispatch} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'printer-handoff-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const stlPath = join(root, 'clean.stl');
  await writeFile(stlPath, stl);
  const config = {
    backend,
    process: {command: process.execPath, args: [fixture, mode, log], cwd: root, ...(dispatch ? {env: {HANDOFF_FIXTURE_DISPATCH: dispatch}} : {})},
    selection,
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

test('bambu sequence lays flat, slices, inspects, snapshots and prints after phone confirmation', async t => {
  const f = await setup(t);
  const result = await f.runner.run({stlPath: f.stlPath});
  assert.deepEqual(result.steps, ['discover', 'lay_flat', 'slice_stl', 'inspect', 'camera_snapshot', 'print']);
  assert.ok(result.orientedStlPath.endsWith('clean_flat.stl'));
  assert.ok(result.slicedPath.endsWith('sliced.3mf'));
  assert.equal(result.inspection.tool, 'inspect_print_file');
  assert.equal(result.print.dispatch, 'started');
  const calls = (await f.calls()).filter(entry => entry.tool);
  assert.deepEqual(calls.map(entry => entry.tool), ['lay_flat', 'slice_stl', 'inspect_print_file', 'camera_snapshot', 'print_3mf']);
  assert.deepEqual(calls[1].arguments, {
    stl_path: result.orientedStlPath, bambu_model: 'p1s', nozzle_diameter: '0.4',
    bed_type: 'textured_plate', nozzle_type: 'hardened_steel',
    use_printer_filaments: false, orient: false, arrange: true, ensure_on_bed: true,
  });
  assert.equal(calls[4].arguments.three_mf_path, result.slicedPath);
  assert.equal(f.seen.at(-1).cameraSnapshot.base64, 'ZmFrZQ==');
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
  assert.equal(f.seen.at(-1).cameraSnapshot.base64, 'ZmFrZQ==');
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
  test(`runBundle preserves dispatch state when recording output fails (print=${print})`, async t => {
    const f = await setup(t);
    const store = new HandoffBundleStore(join(f.root, 'bundles-record-failure'));
    const bundle = await store.create({stl, prompt: 'record failure', backend: 'bambu-printer-mcp', selection});
    store.recordArtifact = async () => {
      throw Object.assign(new Error('/private/operator/output failed'), {code: 'record-failed'});
    };
    await assert.rejects(f.runner.runBundle(store, bundle.id, {print}), {code: 'record-failed'});
    assert.equal((await f.calls()).filter(item => item.tool === 'print_3mf').length, print ? 1 : 0);
    const read = await store.read(bundle.id);
    assert.equal(read.status, print ? 'printed' : 'failed');
    assert.equal(read.failure, 'record-failed');
  });
}

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
