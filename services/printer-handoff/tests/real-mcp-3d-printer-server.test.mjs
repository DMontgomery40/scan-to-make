import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access, copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {InMemoryElicitationRelay, PrinterHandoffRunner} from '../dist/index.js';
import {SAFE_PLA_GCODE, startFakePrinter} from './fixtures/fake-printer-http.mjs';

// Opt-in: runs printer-handoff against a real mcp-3D-printer-server process and
// a loopback OctoPrint/Moonraker stub. Default CI skips this file's cases.
//
//   PRINTER_HANDOFF_REAL_MCP_3D=1 \
//   PRINTER_HANDOFF_MCP_3D_ENTRY=/path/to/mcp-3D-printer-server/dist/index.js \
//   npm test --prefix services/printer-handoff -- tests/real-mcp-3d-printer-server.test.mjs
//
// Optional: PRINTER_HANDOFF_MCP_3D_ROOT (repo root; defaults to parent of dist/)

const enabled = process.env.PRINTER_HANDOFF_REAL_MCP_3D === '1';
const entry = process.env.PRINTER_HANDOFF_MCP_3D_ENTRY;

async function resolvePaths() {
  assert.ok(entry, 'PRINTER_HANDOFF_MCP_3D_ENTRY must point at dist/index.js');
  const absoluteEntry = resolve(entry);
  await access(absoluteEntry);
  const root = resolve(process.env.PRINTER_HANDOFF_MCP_3D_ROOT || join(dirname(absoluteEntry), '..'));
  const sampleStl = join(root, 'test', 'sample_cube.stl');
  await access(sampleStl);
  return {absoluteEntry, root, sampleStl};
}

async function writeSlicePreload(preloadDir, mcpRoot, gcode = SAFE_PLA_GCODE) {
  const preload = join(preloadDir, 'slice-preload.mjs');
  const href = file => JSON.stringify(pathToFileURL(join(mcpRoot, file)).href);
  await writeFile(preload, `import fs from 'node:fs';
import {STLManipulator} from ${href('dist/stl/stl-manipulator.js')};
STLManipulator.prototype.sliceSTL = async (input) => {
  const out = input.replace(/\\.stl$/i, '.gcode');
  fs.writeFileSync(out, ${JSON.stringify(gcode)});
  return out;
};
`);
  return preload;
}

async function handoffEnv(t, {root, absoluteEntry, printerType, port}) {
  const work = await mkdtemp(join(tmpdir(), 'printer-handoff-real-'));
  t.after(() => rm(work, {recursive: true, force: true}));
  const preloadDir = await mkdtemp(join(tmpdir(), 'printer-handoff-preload-'));
  t.after(() => rm(preloadDir, {recursive: true, force: true}));
  const preload = await writeSlicePreload(preloadDir, root);
  const stlPath = join(work, 'clean.stl');
  await copyFile(join(root, 'test', 'sample_cube.stl'), stlPath);
  const serverCwd = await mkdtemp(join(tmpdir(), 'mcp-server-cwd-'));
  t.after(() => rm(serverCwd, {recursive: true, force: true}));
  const envType = printerType === 'klipper' ? 'klipper' : 'octoprint';
  const config = {
    backend: 'mcp-3d-printer-server',
    process: {
      command: process.execPath,
      args: ['--import', preload, absoluteEntry],
      cwd: serverCwd,
      env: {
        MCP_TRANSPORT: 'stdio',
        PRINTER_TYPE: envType,
        PRINTER_HOST: '127.0.0.1',
        PRINTER_PORT: port,
        API_KEY: 'handoff-test-key',
        SLICER_TYPE: 'prusaslicer',
        BAMBU_MODEL: '',
        BAMBU_SERIAL: '',
        BAMBU_TOKEN: '',
        PRINT_REQUIRE_CONFIRMATION: '',
        BAMBU_REQUIRE_CONFIRMATION: '',
      },
    },
    selection: {
      printerType,
      host: '127.0.0.1',
      port,
      material: 'PLA',
    },
    timeouts: {connectMs: 20000, toolMs: 120000, elicitationMs: 30000},
  };
  return {work, stlPath, config};
}

function relayWithAnswer(answer) {
  const relay = new InMemoryElicitationRelay({timeoutMs: 30000});
  relay.subscribe(pending => {
    if (answer === 'none') return;
    setImmediate(() => {
      if (answer === 'decline') {
        relay.respond(pending.id, {action: 'decline'});
        return;
      }
      relay.respond(pending.id, {action: 'accept', content: {confirmed: true}});
    });
  });
  return relay;
}

test('real mcp-3D-printer-server discovery exposes the generic G-code handoff tools', {skip: !enabled}, async t => {
  const {absoluteEntry, root} = await resolvePaths();
  const fake = await startFakePrinter('octoprint');
  t.after(() => fake.close());
  const {config} = await handoffEnv(t, {root, absoluteEntry, printerType: 'octoprint', port: fake.port});
  const runner = new PrinterHandoffRunner(config, {relay: relayWithAnswer('accept')});
  const catalog = await runner.discover();
  const names = new Set(catalog.tools.map(tool => tool.name));
  for (const required of ['lay_flat', 'slice_stl', 'confirm_temperatures', 'upload_gcode']) {
    assert.ok(names.has(required), `missing ${required}`);
  }
  assert.match(catalog.server.name, /3d|printer/i);
});

test('real server OctoPrint path: slice → confirm_temperatures → upload_gcode after confirmation', {skip: !enabled}, async t => {
  const {absoluteEntry, root} = await resolvePaths();
  const fake = await startFakePrinter('octoprint');
  t.after(() => fake.close());
  const {stlPath, config} = await handoffEnv(t, {root, absoluteEntry, printerType: 'octoprint', port: fake.port});
  const prompts = [];
  const relay = relayWithAnswer('accept');
  relay.subscribe(p => prompts.push(p.message));
  const runner = new PrinterHandoffRunner(config, {relay});
  const result = await runner.run({stlPath});
  assert.deepEqual(result.steps, ['discover', 'slice_stl', 'inspect', 'print']);
  assert.equal(result.inspection.tool, 'confirm_temperatures');
  assert.equal(result.print?.printRequested, true);
  // The model goes to the slicer as it is.
  assert.equal(result.orientedStlPath, stlPath);
  assert.ok(result.slicedPath.endsWith('.gcode'));
  const posts = fake.requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 1, 'one upload-and-print POST expected');
  assert.ok(posts[0].body.includes('M109 S215'));
  assert.ok(posts[0].body.includes('name="print"'));
  assert.ok(prompts.length >= 1, 'print gate should elicit before upload');
});

test('real server Klipper path reaches Moonraker upload after confirmation', {skip: !enabled}, async t => {
  const {absoluteEntry, root} = await resolvePaths();
  const fake = await startFakePrinter('klipper');
  t.after(() => fake.close());
  const {stlPath, config} = await handoffEnv(t, {root, absoluteEntry, printerType: 'klipper', port: fake.port});
  const runner = new PrinterHandoffRunner(config, {relay: relayWithAnswer('accept')});
  const result = await runner.run({stlPath});
  assert.equal(result.print?.printRequested, true);
  const mutations = fake.requests.filter(r => r.method === 'POST' || r.method === 'PUT');
  assert.ok(mutations.length >= 1, 'Moonraker upload/start expected');
  assert.ok(mutations.some(r => r.url.includes('/server/files/upload') || r.url.includes('/printer/print/start')));
});

test('declined confirmation on the real server sends nothing to the fake printer', {skip: !enabled}, async t => {
  const {absoluteEntry, root} = await resolvePaths();
  const fake = await startFakePrinter('octoprint');
  t.after(() => fake.close());
  const {stlPath, config} = await handoffEnv(t, {root, absoluteEntry, printerType: 'octoprint', port: fake.port});
  const runner = new PrinterHandoffRunner(config, {relay: relayWithAnswer('decline')});
  await assert.rejects(runner.run({stlPath}), {code: 'tool-failed'});
  assert.equal(fake.requests.filter(r => r.method === 'POST').length, 0);
});
