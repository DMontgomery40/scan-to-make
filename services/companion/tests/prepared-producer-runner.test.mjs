import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPreparedProducer} from '../dist/prepared-production.js';
import {layFlatPreparedStl} from '../dist/mcp-discovery.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = fileURLToPath(new URL('./fixtures/slice-server.mjs', import.meta.url));
const selection = {
  printerId: 'fixture',
  model: 'p1s',
  plateIndex: 0,
  nozzleDiameters: [0.4],
  bedType: 'textured_plate',
  nozzleType: 'hardened_steel',
  materials: [{projectSlot: 0, material: 'PLA', physicalTray: 254}],
};
async function setup(t, mode = 'ok', env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'prepared-producer-mcp-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = join(root, 'mcp.jsonl');
  const config = {
    process: {
      command: process.execPath,
      args: [fixture, mode, log],
      env: {SLICER_TYPE: 'bambustudio', SLICER_PATH: '/operator/BambuStudio', ...env},
    },
    timeoutMs: 5000,
  };
  return {root, log, config, producer: createPreparedProducer(config)};
}
async function requests(log) {
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('producer identity binds the trusted MCP process and slicer environment', async t => {
  const f = await setup(t);
  const identity = env => createPreparedProducer({
    ...f.config,
    process: {...f.config.process, env: {...f.config.process.env, ...env}},
  }).identity;
  assert.equal(f.producer.identity, identity({}));
  assert.notEqual(f.producer.identity, identity({SLICER_PATH: '/operator/OtherStudio'}));
  assert.notEqual(f.producer.identity, identity({SLICER_TYPE: 'orcaslicer-bambulab'}));
});

for (const key of ['PRINTER_HOST', 'BAMBU_SERIAL', 'BAMBU_TOKEN', 'BAMBU_PRINTER_ACCESS_TOKEN']) {
  test(`producer fails closed when ${key} is configured`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'prepared-producer-credential-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    assert.throws(() => createPreparedProducer({
      process: {
        command: process.execPath,
        args: [fixture, 'ok', join(root, 'mcp.jsonl')],
        env: {SLICER_TYPE: 'bambustudio', SLICER_PATH: '/operator/BambuStudio', [key]: 'must-not-be-used'},
      },
    }), error => error.code === 'credentialed-process' && !error.message.includes('must-not-be-used'));
  });
}

test('producer requires operator-configured slicer type and absolute slicer path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prepared-producer-slicer-env-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const base = {
    command: process.execPath,
    args: [fixture, 'ok', join(root, 'mcp.jsonl')],
  };
  assert.throws(() => createPreparedProducer({process: {...base, env: {SLICER_PATH: '/operator/BambuStudio'}}}));
  assert.throws(() => createPreparedProducer({process: {...base, env: {SLICER_TYPE: 'bambustudio'}}}), /SLICER_PATH/);
  assert.throws(() => createPreparedProducer({
    process: {...base, env: {SLICER_TYPE: 'bambustudio', SLICER_PATH: 'relative/BambuStudio'}},
  }), /SLICER_PATH/);
});

test('slice_stl production returns a sliced 3MF with retained MCP evidence and no inherited sentinel env', async t => {
  const f = await setup(t);
  const source = Buffer.from('solid fixture\nendsolid fixture\n');
  const previous = process.env.PARENT_SENTINEL;
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PARENT_SENTINEL = 'must-not-inherit';
  process.env.PATH = '/sentinel-path';
  process.env.HOME = '/sentinel-home';
  let result;
  try {
    result = await f.producer.produce(source, {selection, allowSupports: true});
  } finally {
    if (previous === undefined) delete process.env.PARENT_SENTINEL;
    else process.env.PARENT_SENTINEL = previous;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  assert.deepEqual(result.printable.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const settings = JSON.parse(result.settings);
  assert.deepEqual(settings, {
    schema: 'scan-to-make.bambu-slice-settings/0.1.0',
    tool: 'slice_stl',
    slicerType: 'bambustudio',
    bambuModel: 'p1s',
    nozzleDiameter: '0.4',
    bedType: 'textured_plate',
    nozzleType: 'hardened_steel',
    plateIndex: 0,
    allowSupports: true,
    usePrinterFilaments: false,
    orient: true,
    arrange: true,
    ensureOnBed: true,
  });
  const manifest = JSON.parse(result.manifest);
  assert.equal(manifest.schema, 'scan-to-make.bambu-slice/0.1.0');
  assert.equal(manifest.tool, 'slice_stl');
  assert.deepEqual(manifest.server, {name: 'slice-fixture', version: '1.1.41'});
  assert.equal(manifest.input.sha256, sha(source));
  assert.equal(manifest.outputs.threeMf.sha256, sha(result.printable));
  assert.equal(manifest.outputs.settings.sha256, sha(result.settings));
  const logged = await requests(f.log);
  const calls = logged.filter(entry => entry.request.method === 'tools/call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.params.name, 'slice_stl');
  assert.deepEqual(calls[0].request.params.arguments, {
    stl_path: calls[0].request.params.arguments.stl_path,
    bambu_model: 'p1s',
    nozzle_diameter: '0.4',
    bed_type: 'textured_plate',
    nozzle_type: 'hardened_steel',
    use_printer_filaments: false,
    orient: true,
    arrange: true,
    ensure_on_bed: true,
    slicer_type: 'bambustudio',
  });
  assert.equal(calls[0].env.SLICER_TYPE, 'bambustudio');
  assert.equal(calls[0].env.SLICER_PATH, '/operator/BambuStudio');
  assert.equal(calls[0].env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.equal(calls[0].env.HOME, calls[0].env.TEMP_DIR);
  assert.equal(calls[0].env.parentSentinel, false);
  assert.equal(calls[0].env.printerHost, false);
  assert.equal(calls[0].env.bambuSerial, false);
  assert.equal(calls[0].env.bambuToken, false);
  await assert.rejects(access(dirname(calls[0].request.params.arguments.stl_path)));
});

test('lay_flat is available only through the same fixed file-tool operation', async t => {
  const f = await setup(t);
  const temp = join(f.root, 'lay-flat-temp');
  const result = await layFlatPreparedStl(
    {...f.config.process, env: {...f.config.process.env, TEMP_DIR: temp}},
    '/fixture/source.stl',
    {timeoutMs: 5000},
  );
  assert.equal(result.path, join(temp, 'source_flat.stl'));
  const calls = (await requests(f.log)).filter(entry => entry.request.method === 'tools/call');
  assert.deepEqual(calls.map(entry => entry.request.params.name), ['lay_flat']);
});

for (const [mode, pattern] of [
  ['outside', /outside the production scratch/],
  ['error', /slice-failed/],
  ['missing-slice', /invalid-slice-schema/],
]) {
  test(`${mode} slice result fails closed`, async t => {
    const f = await setup(t, mode);
    await assert.rejects(
      f.producer.produce(Buffer.from('solid fixture\nendsolid fixture\n'), {selection, allowSupports: false}),
      pattern,
    );
  });
}

test('pre-aborted production does not spawn the MCP process', async t => {
  const f = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.producer.produce(Buffer.from('solid fixture\nendsolid fixture\n'), {selection, allowSupports: false}, controller.signal),
    /cancelled/,
  );
  await assert.rejects(readFile(f.log, 'utf8'));
});
