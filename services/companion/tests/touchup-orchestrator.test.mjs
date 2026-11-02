import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runTouchup, acquireBlenderLock} from '../dist/touchup/touchup.js';
import {spawn} from 'node:child_process';
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
    lockPath: join(mkdtempSync(join(tmpdir(), 'touchup-orch-lock-')), 'blender.lock'),
    ensureBlender: async () => { log.push('ensureBlender'); return 'already-running'; },
    resetScene: async () => { log.push('resetScene'); },
    stopBlender: async () => { log.push('stopBlender'); },
    client: () => ({}),
    prepare: async args => { log.push('prepare'); return prepareTouchupPass(args); },
    run: async (inv, pass) => { log.push('run:start'); await new Promise(r => setTimeout(r, runDelayMs)); log.push('run:end'); return {...done(pass), inv}; },
  };
}

test('order', async () => {
  const log = [];
  const result = await runTouchup(await input(), recorder(log));
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end', 'stopBlender']);
  assert.equal(result.status, 'done');
  assert.ok(result.passDir.length > 0);
});

test('bridge missing stops early', async () => {
  const log = [];
  const deps = {...recorder(log), resetScene: async () => { log.push('resetScene'); throw new BlenderBridgeUnavailableError(); }};
  await assert.rejects(runTouchup(await input(), deps), BlenderBridgeUnavailableError);
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'stopBlender']);
});

test('one at a time', async () => {
  const log = [];
  const deps = recorder(log, 100);
  await Promise.all([runTouchup(await input(), deps), runTouchup(await input(), deps)]);
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end', 'ensureBlender', 'resetScene', 'prepare', 'run:start', 'run:end', 'stopBlender']);
});

test('a failed touch-up does not block the next one', async () => {
  const log = [];
  const failing = {...recorder(log), run: async () => { throw new Error('worker crashed'); }};
  await assert.rejects(runTouchup(await input(), failing), /worker crashed/);
  const result = await runTouchup(await input(), recorder(log));
  assert.equal(result.status, 'done');
  assert.equal(log.filter(item => item === 'stopBlender').length, 2, 'a crashed pass and its replacement each release Blender');
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

test('making something from instructions needs no scan or photos', async () => {
  const log = [];
  let seenPrompt;
  const deps = {...recorder(log), run: async (inv, pass) => { seenPrompt = inv.args.at(-1); return done(pass); }};
  await runTouchup(await input({scan: [], photos: [], instructions: 'A hook for a 25 mm handle.'}), deps);
  assert.ok(seenPrompt.startsWith('A hook for a 25 mm handle.'));
});

test('explicit original-input recovery does not treat an STL as a completed model', async () => {
  const previous = join(await mkdtemp(join(tmpdir(), 'touchup-prev-')), 'original.stl');
  await writeFile(previous, 'solid original\nendsolid original\n');
  let seenPrompt;
  await runTouchup(await input({scan: [previous], note: 'Please try the saved inputs again.', currentModel: false}),
    {...recorder([]), run: async (inv, pass) => { seenPrompt = inv.args.at(-1); return done(pass); }});
  assert.match(seenPrompt, /No completed model is available yet/);
});

test('a correction on an instructions-only job needs no photos', async () => {
  const log = [];
  const previous = join(await mkdtemp(join(tmpdir(), 'touchup-prev-')), 'touched.stl');
  await writeFile(previous, 'solid previous\nendsolid previous\n');
  let seenPrompt;
  const deps = {...recorder(log), run: async (inv, pass) => { seenPrompt = inv.args.at(-1); return done(pass); }};
  await runTouchup(await input({scan: [previous], photos: [], instructions: 'A hook.', note: 'thicker', summary: 'Made it.'}), deps);
  assert.ok(seenPrompt.includes('A hook.'));
});

test('another process holding Blender makes this one wait', async () => {
  const lockPath = join(await mkdtemp(join(tmpdir(), 'touchup-lock-')), 'blender.lock');
  const holder = spawn('/bin/sleep', ['1']);
  await writeFile(lockPath, String(holder.pid));
  const started = Date.now();
  const release = await acquireBlenderLock(lockPath, {pollMs: 50});
  assert.ok(Date.now() - started >= 800, 'waited for the live holder');
  await release();
});

test('a lock left by a dead process is taken over', async () => {
  const lockPath = join(await mkdtemp(join(tmpdir(), 'touchup-lock-')), 'blender.lock');
  await writeFile(lockPath, '999999');
  const started = Date.now();
  const release = await acquireBlenderLock(lockPath, {pollMs: 50});
  assert.ok(Date.now() - started < 500);
  await release();
});

test('many processes racing for the Blender lock never overlap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'touchup-race-'));
  const lockPath = join(dir, 'blender.lock'), logPath = join(dir, 'log');
  const module = new URL('../dist/touchup/touchup.js', import.meta.url).href;
  const script = `const {acquireBlenderLock} = await import(${JSON.stringify(module)});
const {appendFileSync} = await import('node:fs');
for (let i = 0; i < 8; i++) { const release = await acquireBlenderLock(${JSON.stringify(lockPath)}, {pollMs: 5});
  appendFileSync(${JSON.stringify(logPath)}, 'in\\n'); await new Promise(r => setTimeout(r, 3)); appendFileSync(${JSON.stringify(logPath)}, 'out\\n'); await release(); }`;
  const children = Array.from({length: 8}, () => spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: 'inherit'}));
  await Promise.all(children.map(child => new Promise(r => child.on('exit', r))));
  const {readFile} = await import('node:fs/promises');
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 128);
  for (let i = 0; i < lines.length; i += 2) assert.deepEqual([lines[i], lines[i + 1]], ['in', 'out'], `overlap at line ${i}`);
});


test('cancelled workers release Blender before the pass finishes', async () => {
  const log = [], controller = new AbortController();
  const deps = {...recorder(log), run: async () => { controller.abort(); throw new Error('cancelled'); }};
  await assert.rejects(runTouchup(await input({signal: controller.signal}), deps), /cancelled/);
  assert.equal(log.at(-1), 'stopBlender');
});

test('an unsuccessful Blender shutdown preserves the completed model and unlocks the next pass', async () => {
  const log = [];
  const deps = {...recorder(log), stopBlender: async () => { throw new Error('shutdown failed'); }};
  const result = await runTouchup(await input(), deps);
  assert.equal(result.status, 'done');
  assert.equal((await runTouchup(await input(), recorder(log))).status, 'done');
});

test('a batch ending in Fusion still releases the Blender used by its earlier pass', async () => {
  const log = [];
  const blender = recorder(log, 50);
  const fusion = {...recorder(log),
    fusionLockPath: join(mkdtempSync(join(tmpdir(), 'touchup-mixed-lock-')), 'fusion.lock'),
    client: () => ({connect: async () => {}, close: async () => {}, hasTool: () => true,
      callTool: async () => ({content: [{type: 'text', text: JSON.stringify({connected: true})}]})}),
  };
  const first = await input(), last = await input({kind: 'fit'});
  await Promise.all([runTouchup(first, blender), runTouchup(last, fusion)]);
  assert.equal(log.filter(item => item === 'ensureBlender').length, 1);
  assert.equal(log.filter(item => item === 'stopBlender').length, 1);
  assert.equal(log.at(-1), 'stopBlender');
});

test('shutdown holds the same Blender lock as the pass', async () => {
  const {readFile} = await import('node:fs/promises');
  const deps = recorder([]);
  let stopped = false;
  deps.stopBlender = async () => {
    assert.equal(await readFile(deps.lockPath, 'utf8'), String(process.pid));
    stopped = true;
  };
  await runTouchup(await input(), deps);
  assert.equal(stopped, true);
});
