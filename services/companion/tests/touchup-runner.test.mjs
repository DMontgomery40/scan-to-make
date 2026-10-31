import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {runTouchupWorker} from '../dist/touchup/runner.js';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const fakeClaude = join(fixtures, 'fake-claude.mjs');

async function setup(scenario) {
  const root = await mkdtemp(join(tmpdir(), 'touchup-run-'));
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const inv = {command: process.execPath, args: [fakeClaude, scenario], env: {PATH: process.env.PATH}, cwd: pass.dir, mcpConfigPath: join(pass.dir, 'mcp.json'), mcpConfig: {mcpServers: {}}};
  return {pass, inv};
}

test('done', async () => {
  const {pass, inv} = await setup('done');
  const progress = [];
  const result = await runTouchupWorker(inv, pass, {onProgress: p => progress.push(p)});
  assert.equal(result.status, 'done');
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
  assert.equal(result.summary, 'Restored the texture on the underside.');
  assert.equal(result.stats.toolCalls, 3);
  assert.equal(result.stats.costUsd, 1.23);
  assert.deepEqual(result.renders, [join(pass.outDir, 'front.png')]);
  assert.deepEqual(result.checkpoints, [join(pass.checkpointsDir, '01.stl')]);
  assert.ok(progress.some(p => p.lastText === 'Restored the texture on the underside.'));
});

test('needs_closeup', async () => {
  const {pass, inv} = await setup('needs_closeup');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'needs_closeup');
  assert.equal(result.closeup, 'the underside');
});

test('tool-call cap', async () => {
  const {pass, inv} = await setup('toolcap');
  const started = Date.now();
  const result = await runTouchupWorker(inv, pass, {maxToolCalls: 120});
  assert.equal(result.status, 'capped');
  assert.match(result.reason, /120 tool calls/);
  assert.equal(result.model, join(pass.checkpointsDir, '02.stl'));
  assert.ok(Date.now() - started < 10000, 'the hung worker was killed');
});

test('time cap', async () => {
  const {pass, inv} = await setup('hang');
  const result = await runTouchupWorker(inv, pass, {timeoutMs: 300});
  assert.equal(result.status, 'capped');
  assert.match(result.reason, /time/);
  assert.equal(result.model, undefined);
});

test('auth failure', async () => {
  const {pass, inv} = await setup('auth');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Not logged in/);
  assert.equal(result.model, undefined);
});

test('unchanged', async () => {
  const {pass, inv} = await setup('unchanged');
  const input = Buffer.from('solid input\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid input\n');
  await writeFile(join(pass.scanDir, 'input.stl'), input);
  const result = await runTouchupWorker(inv, pass, {inputStlSha256: createHash('sha256').update(input).digest('hex')});
  assert.equal(result.status, 'unchanged');
});

test('invalid output', async () => {
  const {pass, inv} = await setup('empty');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'no model was saved');
  assert.equal(result.model, undefined);
});

test('a missing claude is a failed result, not a crash', async () => {
  const {pass, inv} = await setup('done');
  const result = await runTouchupWorker({...inv, command: '/nonexistent/claude'}, pass);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /Claude Code wasn't found/);
});

test('a broken final STL falls back to the last valid checkpoint', async () => {
  const {pass, inv} = await setup('brokenstl');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.model, join(pass.checkpointsDir, '01.stl'));
});

test('junk is never a model', async () => {
  const {pass, inv} = await setup('junkstl');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'no model was saved');
});

test('done with no checkpoint saved means nothing was fixed', async () => {
  const {pass, inv} = await setup('nocheckpoint');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'unchanged');
});

test('the worker can say it failed, and the last checkpoint is kept', async () => {
  const {pass, inv} = await setup('selffailed');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'Blender crashed while merging the beads.');
  assert.equal(result.model, join(pass.checkpointsDir, '01.stl'));
});
