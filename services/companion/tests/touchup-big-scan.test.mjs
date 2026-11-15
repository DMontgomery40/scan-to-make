import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {runTouchup} from '../dist/touchup/touchup.js';
import {DEFAULT_CAPTURE_LIMITS} from '../dist/capture-import.js';
import {tempDir} from './support/temp.mjs';

// #852: David's DAD scan, rebuilt on his Mac at full detail, was 200.9 MB; the capture converter reads 32 MiB, so every
// big scan went to Fusion or Blender. These run the real converter (python with usd-core, as capture-converter-real
// does) on the same object packaged small and over the limit.
const python = process.env.CAPTURE_TEST_PYTHON ?? 'python3';
// The real converter needs usd-core (pxr); without it this is skipped, not failed (review of #853, P3-1).
const hasPxr = spawnSync(python, ['-c', 'import pxr, PIL'], {stdio: 'ignore'}).status === 0;
const makeRebuild = fileURLToPath(new URL('../../../tools/capture-mesh-convert/make_rebuild_fixture.py', import.meta.url));
const handoff = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}};
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const CAD_TOOLS = ['cad_status', 'cad_setup', 'cad_run', 'cad_check_fit'];
/** A printer MCP whose code engine is set up. */
const codeReady = () => ({
  async connect() {}, async close() {}, hasTool: name => CAD_TOOLS.includes(name), getTool: name => ({name, inputSchema: {type: 'object'}}),
  async callTool(name) { return name === 'cad_status' ? {structuredContent: {configured: true, ready: true, python: '/cad/python', build123d: '0.13.0', platform: 'darwin'}, content: []} : text({}); },
});

/** The mesh the code engine was given, as the prompt names its frame: its box in millimetres, Z up. */
async function meshFromPass(inv, pass) {
  const prompt = inv.args.at(-1);
  const frame = /1 unit is (1 metre|1 millimetre|[\d.e-]+ metres) and \+(\w) is up/.exec(prompt);
  assert.ok(frame, 'the prompt names the scan\'s unit and up axis');
  const unitMm = frame[1] === '1 metre' ? 1000 : frame[1] === '1 millimetre' ? 1 : Number(frame[1].split(' ')[0]) * 1000;
  const obj = pass.scanPaths.find(path => path.endsWith('.obj'));
  assert.ok(obj, 'the engine reads a mesh, not the USDZ');
  const points = (await readFile(obj, 'utf8')).split('\n').filter(line => line.startsWith('v ')).map(line => line.split(/\s+/).slice(1, 4).map(Number));
  const up = frame[2].toUpperCase();
  // In the printer's frame: millimetres, Z up (a Y-up scan's Y is the height).
  const zUp = points.map(([x, y, z]) => (up === 'Y' ? [x, -z, y] : [x, y, z]).map(value => value * unitMm));
  const low = [0, 1, 2].map(axis => Math.min(...zUp.map(point => point[axis]))), high = [0, 1, 2].map(axis => Math.max(...zUp.map(point => point[axis])));
  const lines = (await readFile(obj, 'utf8')).split('\n');
  // The converted mesh itself (review of #853, P2-5): its corners and faces, never just its box.
  const vertices = lines.filter(line => line.startsWith('v '));
  const faces = lines.filter(line => line.startsWith('f ')).map(line => line.split(/\s+/).map(token => token.split('/')[0]).join(' '));
  return {size: high.map((value, axis) => value - low[axis]), low, vertices, faces, files: pass.scanPaths.map(path => path.split('/').at(-1)).sort(), triangles: faces.length};
}

async function codePass(scan, root) {
  const seen = {}, activity = [];
  const result = await runTouchup({root, objectId: 'dad', scan: [scan], photos: [], handoff, claudePath: '/c', instructions: 'A replica of this DAD desk thing', kind: 'copy',
    onProgress: progress => activity.push(...(progress.activity ?? []).map(entry => entry.text))}, {
    lockPath: join(root, 'blender.lock'), fusionLockPath: join(root, 'fusion.lock'), codeLockPath: join(root, 'code.lock'), client: codeReady,
    ensureBlender: async () => { throw new Error('Blender must not start'); },
    guidance: async () => ({design: 'D', slicing: 'S', cad: 'MCP CAD PROMPT'}),
    run: async (inv, pass) => { Object.assign(seen, await meshFromPass(inv, pass), {engine: inv.engine}); return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  return {result, seen, activity};
}

test('a Mac rebuild over the converter\'s limit is designed on the code engine, at the same size as a small scan of the same object (#852)', {skip: hasPxr ? false : 'usd-core (pxr) is not installed for CAPTURE_TEST_PYTHON'}, async t => {
  const root = await tempDir('touchup-big-scan-');
  const small = join(root, 'small', 'scan.usdz'), big = join(root, 'big', 'scan.usdz');
  await promisify(execFile)('mkdir', ['-p', join(root, 'small'), join(root, 'big')]);
  await promisify(execFile)(python, [makeRebuild, small], {timeout: 60_000});
  await promisify(execFile)(python, [makeRebuild, big, '--texture-bytes', String(33 * 1024 * 1024)], {timeout: 120_000});
  assert.ok((await stat(big)).size > DEFAULT_CAPTURE_LIMITS.maxSourceBytes, 'over the 32 MiB the converter reads whole');
  const previous = process.env.SCAN_TO_MAKE_CAPTURE_PYTHON;
  process.env.SCAN_TO_MAKE_CAPTURE_PYTHON = python;
  t.after(() => { if (previous === undefined) delete process.env.SCAN_TO_MAKE_CAPTURE_PYTHON; else process.env.SCAN_TO_MAKE_CAPTURE_PYTHON = previous; });

  const a = await codePass(small, join(root, 'small'));
  const b = await codePass(big, join(root, 'big'));
  for (const pass of [a, b]) {
    assert.equal(pass.result.engine, 'code', 'the code engine designs it');
    assert.equal(pass.seen.engine, 'code');
    assert.equal(pass.activity.some(line => /couldn't read this scan/.test(line)), false, 'no fallback, nothing to explain');
  }
  // The same object, the same size: a big scan never turns into a wrong-size part.
  for (const axis of [0, 1, 2]) assert.ok(Math.abs(a.seen.size[axis] - b.seen.size[axis]) < 0.01, `axis ${axis}: ${a.seen.size} vs ${b.seen.size}`);
  assert.deepEqual(b.seen.size.map(value => Math.round(value * 10) / 10), [195.7, 22.7, 107], 'millimetres, Z up, as the object is');
  assert.equal(a.seen.triangles, b.seen.triangles, 'the same triangles');
  // Exactly the same mesh, through the real Node path: every corner, where it was placed, and every face in its winding.
  assert.deepEqual(b.seen.vertices, a.seen.vertices, 'the same vertices, line for line');
  assert.deepEqual(b.seen.faces, a.seen.faces, 'the same faces and winding');
  // Placed off the origin (31, 12, -44 mm, Y up): in millimetres, Z up, the low corner is (31, 44 - 22.7, 12), never re-centred.
  assert.deepEqual(b.seen.low.map(value => Math.round(value * 100) / 100), [31, 21.3, 12]);
  assert.deepEqual(a.seen.low.map(value => Math.round(value * 100) / 100), [31, 21.3, 12]);
  // The big one comes as its mesh alone: its textures (the bytes over the limit) are never read.
  assert.deepEqual(b.seen.files, ['mesh.obj']);
  assert.ok(a.seen.files.includes('mesh.obj') && a.seen.files.some(name => name.endsWith('.png')), 'a small scan keeps its texture, as before');
});
