import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runTouchup} from '../dist/touchup/touchup.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {BlenderBridgeUnavailableError} from '../dist/touchup/blender.js';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const handoff = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', env: {MCP_TRANSPORT: 'stdio'}}};
const done = pass => ({status: 'done', model: join(pass.outDir, 'touched.stl'), summary: 'ok', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}});

async function input(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'touchup-orch-'));
  return {root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')], handoff, claudePath: '/c', ...extra};
}
function recorder(log, runDelayMs = 0) {
  return {
    ensureBlender: async () => { log.push('ensureBlender'); return 'already-running'; },
    resetScene: async () => { log.push('resetScene'); },
    client: () => ({}),
    prepare: async args => { log.push('prepare'); return prepareTouchupPass(args); },
    run: async (inv, pass) => { log.push('run:start'); await new Promise(r => setTimeout(r, runDelayMs)); log.push('run:end'); return {...done(pass), inv}; },
  };
}

test('order', async () => {
  const log = [];
  const result = await runTouchup(await input(), recorder(log));
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end']);
  assert.equal(result.status, 'done');
  assert.ok(result.passDir.length > 0);
});

test('bridge missing stops early', async () => {
  const log = [];
  const deps = {...recorder(log), resetScene: async () => { log.push('resetScene'); throw new BlenderBridgeUnavailableError(); }};
  await assert.rejects(runTouchup(await input(), deps), BlenderBridgeUnavailableError);
  assert.deepEqual(log, ['ensureBlender', 'resetScene']);
});

test('one at a time', async () => {
  const log = [];
  const deps = recorder(log, 100);
  await Promise.all([runTouchup(await input(), deps), runTouchup(await input(), deps)]);
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end', 'ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end']);
});

test('a failed touch-up does not block the next one', async () => {
  const log = [];
  const failing = {...recorder(log), run: async () => { throw new Error('worker crashed'); }};
  await assert.rejects(runTouchup(await input(), failing), /worker crashed/);
  const result = await runTouchup(await input(), recorder(log));
  assert.equal(result.status, 'done');
});

test('correction pass', async () => {
  const log = [];
  const previous = join(await mkdtemp(join(tmpdir(), 'touchup-prev-')), 'touched.stl');
  await writeFile(previous, 'solid previous\nendsolid previous\n');
  let seenScan, seenPrompt, seenSha;
  const deps = {...recorder(log),
    prepare: async args => { seenScan = args.scan; return prepareTouchupPass(args); },
    run: async (inv, pass, opts) => { seenPrompt = inv.args.at(-1); seenSha = opts.inputStlSha256; return done(pass); }};
  await runTouchup(await input({scan: [previous], note: 'you missed the clip on the side', summary: 'Added texture.'}), deps);
  assert.deepEqual(seenScan, [previous]);
  assert.ok(seenPrompt.startsWith('This is the current model. Added texture.'));
  assert.match(seenSha, /^[0-9a-f]{64}$/, 'an STL input is hashed so an unchanged result is caught');
});
