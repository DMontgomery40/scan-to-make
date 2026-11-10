import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTouchup, acquireBlenderLock} from '../dist/touchup/touchup.js';
import {spawn} from 'node:child_process';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {BlenderBridgeUnavailableError} from '../dist/touchup/blender.js';
import {tempDir, tempDirSync} from './support/temp.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const handoff = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', env: {MCP_TRANSPORT: 'stdio'}}};
const done = pass => ({status: 'done', model: join(pass.outDir, 'touched.stl'), summary: 'ok', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}});

async function input(extra = {}) {
  const root = await tempDir('touchup-orch-');
  return {root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')], handoff, claudePath: '/c', ...extra};
}
function recorder(log, runDelayMs = 0) {
  return {
    lockPath: join(tempDirSync('touchup-orch-lock-'), 'blender.lock'),
    ensureBlender: async () => { log.push('ensureBlender'); return 'already-running'; },
    resetScene: async () => { log.push('resetScene'); },
    stopBlender: async () => { log.push('stopBlender'); },
    client: () => ({}),
    guidance: async () => ({design: 'Plan the print.', slicing: 'Its slicer orients it.'}), 
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
  const previous = join(await tempDir('touchup-prev-'), 'touched.stl');
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
  const previous = join(await tempDir('touchup-prev-'), 'original.stl');
  await writeFile(previous, 'solid original\nendsolid original\n');
  let seenPrompt;
  await runTouchup(await input({scan: [previous], note: 'Please try the saved inputs again.', currentModel: false}),
    {...recorder([]), run: async (inv, pass) => { seenPrompt = inv.args.at(-1); return done(pass); }});
  assert.match(seenPrompt, /No completed model is available yet/);
});

test('a correction on an instructions-only job needs no photos', async () => {
  const log = [];
  const previous = join(await tempDir('touchup-prev-'), 'touched.stl');
  await writeFile(previous, 'solid previous\nendsolid previous\n');
  let seenPrompt;
  const deps = {...recorder(log), run: async (inv, pass) => { seenPrompt = inv.args.at(-1); return done(pass); }};
  await runTouchup(await input({scan: [previous], photos: [], instructions: 'A hook.', note: 'thicker', summary: 'Made it.'}), deps);
  assert.ok(seenPrompt.includes('A hook.'));
});

test('another process holding Blender makes this one wait', async () => {
  const lockPath = join(await tempDir('touchup-lock-'), 'blender.lock');
  const holder = spawn('/bin/sleep', ['1']);
  await writeFile(lockPath, String(holder.pid));
  const started = Date.now();
  const release = await acquireBlenderLock(lockPath, {pollMs: 50});
  assert.ok(Date.now() - started >= 800, 'waited for the live holder');
  await release();
});

test('a lock left by a dead process is taken over', async () => {
  const lockPath = join(await tempDir('touchup-lock-'), 'blender.lock');
  await writeFile(lockPath, '999999');
  const started = Date.now();
  const release = await acquireBlenderLock(lockPath, {pollMs: 50});
  assert.ok(Date.now() - started < 500);
  await release();
});

test('many processes racing for the Blender lock never overlap', async () => {
  const dir = await tempDir('touchup-race-');
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
    fusionLockPath: join(tempDirSync('touchup-mixed-lock-'), 'fusion.lock'),
    client: () => ({connect: async () => {}, close: async () => {}, hasTool: () => true,
      getTool: () => ({inputSchema: {properties: {bind_document: {type: "boolean"}}}}),
      callTool: async () => ({content: [{type: 'text', text: JSON.stringify({connected: true, document_binding: 1, document_id: "owned-token"})}]})}),
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

test("a copy of a designer's 3MF is refused when the pass rebuilt it: no 3MF, or print settings that differ (the Nov 4 caliper card)", async () => {
  const root = await tempDir('touchup-designer-');
  const designer = join(root, 'scan.3mf'), working = join(root, 'model.3mf');
  await writeFile(designer, 'PK designer'); await writeFile(working, 'PK working');
  const settings = {[designer]: {summary: {layer_height: 0.16, infill: '100%'}, raw_key_count: 412}};
  const calls = [];
  const client = () => ({
    connect: async () => {}, close: async () => {}, hasTool: name => name === 'get_slice_settings',
    callTool: async (name, args) => {
      calls.push([name, args.source_path]);
      // The pass works on its own copies: the designer's file is found by name, the pass's output by path.
      const found = args.source_path.endsWith('/scan.3mf') ? settings[designer] : settings[args.source_path];
      return found ? {content: [{type: 'text', text: JSON.stringify({source_path: args.source_path, ...found})}]} : {isError: true, content: [{type: 'text', text: 'No slicer settings config found'}]};
    },
  });
  const run = async (writeParts, editedSettings) => {
    const log = [];
    const deps = {...recorder(log), client, run: async (inv, pass) => {
      const result = done(pass);
      await writeFile(result.model, 'solid x');
      if (!writeParts) return result;
      const parts = join(pass.outDir, 'touched.3mf');
      await writeFile(parts, 'PK edited');
      if (editedSettings) settings[parts] = editedSettings; else delete settings[parts];
      return {...result, parts};
    }};
    return runTouchup(await input({scan: [working, designer], designerCopy: true, note: 'Swap the logo'}), deps);
  };
  const noFile = await run(false);
  assert.equal(noFile.status, 'failed');
  assert.match(noFile.reason, /rebuilt the designer's file/);
  assert.equal(noFile.model, undefined, 'nothing from a refused pass becomes the model');
  const kept = await run(true, settings[designer]);
  assert.equal(kept.status, 'done', 'an edit inside the designer\'s project keeps its settings');
  assert.ok(kept.parts.endsWith('touched.3mf'));
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ['get_slice_settings', 'get_slice_settings']);
  assert.ok(calls.at(-2)[1].endsWith(join('scan', 'scan.3mf')), 'compared with the designer\'s own file, copied into the pass');
  const rebuilt = await run(true, {summary: {layer_height: 0.2, infill: '15%'}, raw_key_count: 40});
  assert.equal(rebuilt.status, 'failed');
  assert.equal(rebuilt.parts, undefined);
  assert.equal(rebuilt.model, undefined);
  const bare = await run(true, undefined);
  assert.equal(bare.status, 'failed', 'a bare 3MF has lost the designer\'s settings');
});

test("a designer copy whose last edit already lost the designer's settings starts again from the designer's file", async () => {
  const root = await tempDir('touchup-designer-restart-');
  const designer = join(root, 'scan.3mf'), working = join(root, 'model.3mf');
  await writeFile(designer, 'PK designer'); await writeFile(working, 'PK rebuilt');
  const client = () => ({connect: async () => {}, close: async () => {}, hasTool: () => true,
    callTool: async (_name, args) => args.source_path.endsWith('/scan.3mf') || args.source_path.endsWith('touched.3mf')
      ? {content: [{type: 'text', text: JSON.stringify({summary: {layer_height: 0.16}, raw_key_count: 9})}]}
      : {content: [{type: 'text', text: JSON.stringify({summary: {layer_height: null}, raw_key_count: 0})}]}});
  let prompt;
  const deps = {...recorder([]), client, run: async (inv, pass) => {
    prompt = inv.args.at(-1);
    const result = done(pass); await writeFile(result.model, 'solid x');
    const parts = join(pass.outDir, 'touched.3mf'); await writeFile(parts, 'PK edited');
    return {...result, parts};
  }};
  const result = await runTouchup(await input({scan: [working, designer], designerCopy: true, note: 'redo design'}), deps);
  assert.equal(result.status, 'done');
  assert.match(prompt, /Designer's 3MF project to edit: .*scan\.3mf\n/, "the designer's own file is the one to edit");
  assert.doesNotMatch(prompt, /model\.3mf/, 'the rebuilt file is not offered');
});

/** A printer MCP whose get_slice_settings answers `reply(path)` for each file it is asked about. */
const settingsClient = reply => () => ({connect: async () => {}, close: async () => {}, hasTool: name => name === 'get_slice_settings',
  callTool: async (_name, args) => reply(args.source_path)});
const settingsReply = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const designerSettings = settingsReply({summary: {layer_height: 0.16, infill: '100%'}, raw_key_count: 412});

/** Runs a designer-copy pass whose worker ends with `ending` and writes a model and touched.3mf. */
async function designerPass(client, ending = {}) {
  const root = await tempDir('touchup-designer-check-');
  const designer = join(root, 'scan.3mf');
  await writeFile(designer, 'PK designer');
  const deps = {...recorder([]), client, run: async (inv, pass) => {
    const result = done(pass); await writeFile(result.model, 'solid x');
    const parts = join(pass.outDir, 'touched.3mf'); await writeFile(parts, 'PK edited');
    return {...result, parts, ...ending};
  }};
  return runTouchup(await input({scan: [designer], designerCopy: true, note: 'Swap the logo'}), deps);
}

test("a designer copy is refused when the designer's file can't be inspected: an error, other JSON or no summary never approves", async () => {
  // Codex on #318: a failed read of the original came back as "no settings", which approved any edit.
  const failures = {
    'an error': {isError: true, content: [{type: 'text', text: 'Failed to parse 3MF file'}]},
    'text that is not JSON': {content: [{type: 'text', text: 'not json'}]},
    'JSON without a summary': settingsReply({source_path: 'x'}),
    'a summary without a key count': settingsReply({summary: {layer_height: 0.16}}),
  };
  for (const [what, reply] of Object.entries(failures)) {
    const result = await designerPass(settingsClient(path => path.endsWith('/scan.3mf') ? reply : designerSettings));
    assert.equal(result.status, 'failed', what);
    assert.match(result.reason, /can't check that the designer's settings were kept/, what);
    assert.equal(result.model, undefined, what);
    assert.equal(result.parts, undefined, what);
  }
  const thrown = await designerPass(() => ({connect: async () => { throw new Error('spawn failed'); }, close: async () => {}, hasTool: () => true}));
  assert.match(thrown.reason, /can't check/, 'an MCP that does not start checks nothing');
  const noTool = await designerPass(() => ({connect: async () => {}, close: async () => {}, hasTool: () => false}));
  assert.match(noTool.reason, /can't check/, 'an MCP without get_slice_settings checks nothing');
});

test("a designer's 3MF the MCP read and found no settings in has none to lose", async () => {
  const result = await designerPass(settingsClient(path => path.endsWith('/scan.3mf')
    ? settingsReply({summary: {layer_height: null}, raw_key_count: 0}) : designerSettings));
  assert.equal(result.status, 'done');
  assert.ok(result.parts.endsWith('touched.3mf'));
});

test("every designer-copy result that can become the model is checked, whatever the pass's status", async () => {
  // Codex on #318: a worker that saved a rebuilt model and then hit a limit, failed or asked for a close-up skipped the
  // check, and the project kept that model as "the last saved version".
  const rebuilt = settingsClient(path => path.endsWith('/scan.3mf') ? designerSettings : settingsReply({summary: {layer_height: 0.2}, raw_key_count: 40}));
  const capped = await designerPass(rebuilt, {status: 'capped', reason: 'time limit'});
  assert.equal(capped.status, 'failed');
  assert.match(capped.reason, /rebuilt the designer's file/);
  assert.equal(capped.model, undefined);
  const failed = await designerPass(rebuilt, {status: 'failed', reason: 'The worker stopped.'});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'The worker stopped.', 'a failed pass keeps its own reason');
  assert.equal(failed.model, undefined);
  assert.equal(failed.parts, undefined);
  const closeup = await designerPass(rebuilt, {status: 'needs_closeup', closeup: 'the hinge'});
  assert.equal(closeup.status, 'needs_closeup', 'a close-up request is still asked');
  assert.equal(closeup.model, undefined);
  // A bare STL checkpoint, with no 3MF at all, is a rebuild too.
  const stlOnly = await designerPass(settingsClient(() => designerSettings), {status: 'capped', reason: 'step limit', parts: undefined});
  assert.equal(stlOnly.status, 'failed');
  assert.equal(stlOnly.model, undefined);
  // A capped pass that kept the designer's settings keeps its saved model.
  const kept = await designerPass(settingsClient(() => designerSettings), {status: 'capped', reason: 'time limit'});
  assert.equal(kept.status, 'capped');
  assert.ok(kept.model);
});

for (const unavailable of [false, true]) test(`a recovery uses --resume and a short checkpoint prompt${unavailable ? ', falling back only when the session is missing' : ''}`, async () => {
  const i = await input({instructions:'A unicorn', note:'Add a mane', resume:{sessionId:'old-session',passDir:'/old/pass'}}), seen=[];
  const deps=recorder([]);
  deps.run=async (inv,pass,opts)=>{
    seen.push({args:[...inv.args],cwd:inv.cwd});
    if (unavailable && seen.length===1) return {status:'failed',reason:'No conversation found with session ID: old-session',sessionId:'old-session',resumeUnavailable:true,worker:{tools:[],plugins:[],mcpServers:[]},renders:[],checkpoints:[],stats:{seconds:1,toolCalls:0}};
    return {...done(pass), sessionId:unavailable?'new-session':'old-session',resumable:false};
  };
  const result=await runTouchup(i,deps);
  assert.equal(seen[0].args[seen[0].args.indexOf('--resume')+1],'old-session');
  assert.equal(seen[0].cwd,'/old/pass');
  assert.match(seen[0].args.at(-1),/Continue from where you stopped/);
  assert.match(seen[0].args.at(-1),/\/old\/pass\/out\/checkpoints/);
  assert.match(seen[0].args.at(-1),/Add a mane/);
  assert.doesNotMatch(seen[0].args.at(-1),/Photo 1:/);
  assert.equal(result.resume.outcome,unavailable?'cold-start':'resumed');
  if(unavailable){assert.equal(seen.length,2);assert.equal(seen[1].args.includes('--resume'),false);assert.match(result.resume.reason,/session.*unavailable/i);}
});

test('a second recovery keeps the original session cwd and includes newly supplied evidence', async () => {
 const i=await input({instructions:'A unicorn',resume:{sessionId:'same-session',passDir:'/second/pass',sessionCwd:'/first/pass',photos:[join(fixtures,'photo.jpg')]}});
 const deps=recorder([]),seen=[];deps.run=async(inv,pass)=>{seen.push(inv);return {...done(pass),sessionId:'same-session'};};
 const result=await runTouchup(i,deps);
 assert.equal(seen[0].cwd,'/first/pass');assert.equal(result.sessionCwd,'/first/pass');
 assert.match(seen[0].args[seen[0].args.indexOf('--append-system-prompt')+1],/For this resumed attempt/);
 assert.ok(seen[0].args[seen[0].args.indexOf('--append-system-prompt')+1].includes(join(result.passDir,'out')));
 assert.match(seen[0].args.at(-1),/New photos for this request:/);
});

test('an initialized worker failure is never retried cold even if its answer mentions a missing session', async () => {
 const i=await input({instructions:'A unicorn',resume:{sessionId:'old',passDir:'/old/pass'}}),deps=recorder([]);let calls=0;
 deps.run=async()=>{calls++;return {status:'failed',reason:'Session unavailable in a modeling tool.',sessionId:'old',worker:{tools:[],plugins:[],mcpServers:[]},renders:[],checkpoints:[],stats:{seconds:1,toolCalls:0}};};
 const result=await runTouchup(i,deps);assert.equal(calls,1);assert.equal(result.status,'failed');
});

for (const throws of [false,true]) test(`an unavailable session whose cold start ${throws ? 'throws' : 'returns failed'} explains both failures`, async () => {
 const i=await input({instructions:'A unicorn',resume:{sessionId:'old',passDir:'/old/pass'}}),deps=recorder([]);let calls=0;
 deps.run=async()=>{
  if(++calls===1)return {status:'failed',reason:'No conversation found with session ID: old',sessionId:'old',resumeUnavailable:true,worker:{tools:[],plugins:[],mcpServers:[]},renders:[],checkpoints:[],stats:{seconds:0,toolCalls:0}};
  if(throws)throw new Error('Claude login unavailable');
  return {status:'failed',reason:'Claude login unavailable',resumable:false,renders:[],checkpoints:[],stats:{seconds:0,toolCalls:0}};
 };
 const result=await runTouchup(i,deps);
 assert.equal(calls,2);assert.equal(result.status,'failed');assert.equal(result.resumable,false);
 assert.match(result.reason,/previous Claude Code session.*unavailable/i);assert.match(result.reason,/starting again failed/i);assert.match(result.reason,/Claude login unavailable/);
 assert.equal(result.resume.outcome,'cold-start');
});
