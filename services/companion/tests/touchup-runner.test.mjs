import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {runTouchupWorker} from '../dist/touchup/runner.js';
import {tempDir} from './support/temp.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const fakeClaude = join(fixtures, 'fake-claude.mjs');

async function setup(scenario) {
  const root = await tempDir('touchup-run-');
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
  assert.equal(progress.at(-1).resumable, false, 'the final answer clears live recovery before later file steps');
});

test('a request in several colours keeps the printer MCP\'s multi-part 3MF beside the merged mesh', async () => {
  const {pass, inv} = await setup('multicolour');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'done');
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
  assert.equal(result.parts, join(pass.outDir, 'touched.3mf'));
  assert.deepEqual(result.partColours, [
    {name: 'body', colour: '#111111', material: 'PLA'},
    {name: 'letters', colour: '#FFD200'},
  ]);
});

test('a touched.3mf that is not a printable 3MF never becomes the model', async () => {
  const {pass, inv} = await setup('multicolourbroken');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.parts, undefined);
  assert.equal(result.partColours, undefined);
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
});

test('part colours the worker garbles lose the garbled field but keep their filament’s place', async () => {
  const {pass, inv} = await setup('multicolourjunk');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.parts, join(pass.outDir, 'touched.3mf'));
  // Positions are filaments: dropping an entry would put every later colour on the wrong part.
  assert.deepEqual(result.partColours, [
    {name: 'body'}, {colour: '#FFD200'}, {}, {name: 'x'.repeat(256)},
  ]);
});

test('part colours without the 3MF they describe do not survive', async () => {
  const {pass, inv} = await setup('done');
  assert.equal((await runTouchupWorker(inv, pass)).partColours, undefined);
});

test('a single-colour pass has no parts file', async () => {
  const {pass, inv} = await setup('done');
  assert.equal((await runTouchupWorker(inv, pass)).parts, undefined);
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
  assert.match(result.reason, /120 tool-call limit/);
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
  assert.equal(result.parts, undefined, 'the final export’s 3MF never pairs with a checkpoint mesh');
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

test('a make job with no scan is done, not unchanged', async () => {
  const root = await tempDir('touchup-run-');
  const pass = await prepareTouchupPass({root, objectId: 'mount', scan: [], photos: [], requirePhotos: false});
  const inv = {command: process.execPath, args: [fakeClaude, 'nocheckpoint'], env: {PATH: process.env.PATH}, cwd: pass.dir, mcpConfigPath: join(pass.dir, 'mcp.json'), mcpConfig: {mcpServers: {}}};
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'done');
});

test('the report records what the worker actually started with', async () => {
  const {pass, inv} = await setup('done');
  const result = await runTouchupWorker(inv, pass);
  assert.deepEqual(result.worker, {model: 'claude-opus-5-5', apiKeySource: 'none', tools: ['Read', 'WebSearch'],
    plugins: ['cc-plugin-telemetry@builtin'], mcpServers: ['printer:connected']});
});

test('a cut-off ASCII STL is not a model; the last checkpoint is used', async () => {
  const {pass, inv} = await setup('truncatedstl');
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.model, join(pass.checkpointsDir, '01.stl'));
});

test('a binary STL with NaN coordinates is not valid', async () => {
  const {isValidStl} = await import('../dist/touchup/runner.js');
  const dir = await tempDir('stl-');
  const bytes = Buffer.alloc(134); bytes.writeUInt32LE(1, 80);
  for (let offset = 84; offset < 132; offset += 4) bytes.writeFloatLE(NaN, offset);
  await writeFile(join(dir, 'nan.stl'), bytes);
  assert.equal(await isValidStl(join(dir, 'nan.stl')), false);
});

test('a stopped worker leaves no process behind, even one that ignores SIGTERM', async () => {
  const {pass, inv} = await setup('stubborngrandchild');
  const controller = new AbortController();
  const stopped = await runTouchupWorker(inv, pass, {signal: controller.signal, timeoutMs: 10_000,
    onProgress: progress => { if (progress.lastText === 'stubborn grandchild ready') controller.abort(); }});
  assert.equal(stopped.reason, 'cancelled');
  const pid = Number(await readFile(join(pass.dir, 'grandchild.pid'), 'utf8'));
  await new Promise(r => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a cancelled pass never starts the worker', async () => {
  const {pass, inv} = await setup('hang');
  const controller = new AbortController(); controller.abort();
  const started = Date.now();
  const result = await runTouchupWorker(inv, pass, {signal: controller.signal, timeoutMs: 5000});
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cancelled');
  assert.ok(Date.now() - started < 1000);
});

// The designer's supports choice reaches the result as the slicer takes it; anything else is no choice at all.
for (const [answer, expected] of [
  [{enabled: true, type: 'tree(auto)'}, {enabled: true, type: 'tree(auto)'}],
  [{enabled: true}, {enabled: true}],
  [{enabled: false, type: 'tree(auto)'}, {enabled: false}],
  [{enabled: true, type: 'tree(manual)'}, {enabled: true}],
  [{enabled: 'yes'}, undefined],
  [null, undefined],
]) {
  test(`the designer's supports answer ${JSON.stringify(answer)} becomes ${JSON.stringify(expected)}`, async () => {
    const {pass, inv} = await setup('supports');
    inv.env = {...inv.env, SUPPORTS: JSON.stringify(answer)};
    const result = await runTouchupWorker(inv, pass);
    assert.equal(result.status, 'done');
    assert.deepEqual(result.supports, expected);
  });
}

for (const kind of ['inactivity', 'absolute', 'tool-calls']) {
  test(`${kind} stop keeps the init session and only valid checkpoints`, async t => {
    const {EventEmitter} = await import('node:events');
    const {PassThrough} = await import('node:stream');
    const {pass, inv} = await setup('hang');
    const good = join(pass.checkpointsDir, '01.stl');
    await writeFile(good, 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n');
    await writeFile(join(pass.checkpointsDir, '02.stl'), 'broken');
    const child = Object.assign(new EventEmitter(), {pid: 99999999, stdout: new PassThrough(), stderr: new PassThrough()});
    t.mock.method(process, 'kill', () => { queueMicrotask(() => child.emit('close', null)); return true; });
    t.mock.timers.enable({apis: ['setTimeout', 'Date']});
    const progress = [];
    const pending = runTouchupWorker(inv, pass, {spawn: () => child, inactivityMs: kind === 'absolute' ? 1000 : 60, timeoutMs: 300, maxToolCalls: 1, onProgress: p => progress.push(p)});
    child.stdout.write('{"type":"system","subtype":"init","session_id":"saved-session"}\n');
    if (kind === 'tool-calls') child.stdout.write('{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"tool_use"}]}}\n');
    t.mock.timers.tick(kind === 'absolute' ? 300 : 60);
    const result = await pending;
    assert.equal(result.status, 'capped');
    assert.deepEqual(result.limit, {kind, value: kind === 'absolute' ? 300 : kind === 'inactivity' ? 60 : 1});
    assert.equal(result.sessionId, 'saved-session');
    assert.equal(result.resumable, true);
    assert.deepEqual(result.checkpoints, [good]);
    assert.equal(result.model, good);
    assert.ok(progress.some(p => p.sessionId === 'saved-session' && p.resumable === true));
  });
}

test('every worker event resets inactivity so active work can run beyond 900 seconds', async t => {
  const {EventEmitter} = await import('node:events');
  const {PassThrough} = await import('node:stream');
  const {runClaudeWorker} = await import('../dist/touchup/runner.js');
  const {inv} = await setup('hang');
  const child = Object.assign(new EventEmitter(), {pid: 99999999, stdout: new PassThrough(), stderr: new PassThrough()});
  const kills = t.mock.method(process, 'kill', () => { queueMicrotask(() => child.emit('close', null)); return true; });
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const pending = runClaudeWorker(inv, {spawn: () => child, inactivityMs: 60000, timeoutMs: 2000000});
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(50000); child.stdout.write('{"type":"user","session_id":"still-active"}\n'); }
  assert.equal(kills.mock.callCount(), 0);
  child.stdout.write('{"type":"result","structured_output":{"status":"done"}}\n'); child.emit('close', 0);
  const result = await pending;
  assert.equal(result.stopReason, undefined);
  assert.equal(result.sessionId, 'still-active');
});

test('a crashed worker without a final answer remains resumable, while a person cancel does not', async t => {
  const {EventEmitter} = await import('node:events');const {PassThrough} = await import('node:stream');
  for (const cancelled of [false,true,'error']) {
    const {pass,inv}=await setup('hang'),controller=new AbortController();
    const child=Object.assign(new EventEmitter(),{pid:99999999,stdout:new PassThrough(),stderr:new PassThrough()});
    t.mock.method(process,'kill',()=>{queueMicrotask(()=>child.emit('close',null));return true;});
    const pending=runTouchupWorker(inv,pass,{spawn:()=>child,signal:controller.signal});
    child.stdout.write('{"type":"system","subtype":"init","session_id":"crash-session"}\n');
    if(cancelled === true)controller.abort();else if(cancelled === 'error')child.emit('error',new Error('worker pipe failed'));else child.emit('close',1);
    const result=await pending;
    assert.equal(result.status,'failed');assert.equal(result.sessionId,'crash-session');assert.equal(result.resumable,cancelled !== true);
    if(cancelled === true)assert.equal(result.reason,'cancelled');
  }
});

test('limit words use minutes and hours a person can read', async () => {
 const {limitWords}=await import('../dist/touchup/runner.js');
 assert.equal(limitWords({kind:'inactivity',value:600000}),'Stopped after 10 minutes without worker activity');
 assert.equal(limitWords({kind:'absolute',value:7200000}),'Stopped at the absolute time limit of 2 hours');
 assert.equal(limitWords({kind:'tool-calls',value:120}),'Stopped at the 120 tool-call limit');
});

for (const initialized of [false,true]) test(`real missing-session terminal event identifies loader rejection${initialized ? ' even after init' : ''}`, async () => {
 const {pass,inv}=await setup('hang');
 const raw=await readFile(join(fixtures,'missing-session.ndjson'),'utf8'),stderr=await readFile(join(fixtures,'missing-session.stderr'),'utf8');
 const event=JSON.parse(raw),exit=Number(await readFile(join(fixtures,'missing-session.exit-code'),'utf8'));
 const prefix=initialized?JSON.stringify({type:'system',subtype:'init',session_id:event.session_id})+'\n':'';
 inv.args=['-e',`process.stdout.write(${JSON.stringify(prefix+raw)});process.stderr.write(${JSON.stringify(stderr)});process.exit(${exit});`,'--','--resume',event.session_id];
 const result=await runTouchupWorker(inv,pass);
 assert.equal(result.status,'failed');assert.equal(result.resumeUnavailable,true);
 assert.equal(result.resumable,false);assert.equal(result.sessionId,event.session_id);
});

for (const [name,changes] of [['model turn',{num_turns:1}],['API work',{duration_api_ms:5}],['another session',{errors:['No conversation found with session ID: another-session']}]]) test(`a ${name} is not the CLI loader rejection`, async () => {
 const {pass,inv}=await setup('hang');const event=JSON.parse(await readFile(join(fixtures,'missing-session.ndjson'),'utf8'));
 inv.args=['--resume',event.session_id];
 inv.worker=async()=>({resultEvent:{...event,...changes},sessionId:event.session_id,exitCode:1,toolCalls:0,seconds:0,stderrTail:'',publicText:text=>text});
 assert.equal((await runTouchupWorker(inv,pass)).resumeUnavailable,undefined);
});

// A code pass (PRD §8.9): every cad_run leaves its own `cad-*` folder under the pass's design folder, with the MCP's
// protected receipt `cad-result.json` (cad/1): completed or not, final (the worker's selection) or not, its checks.
// The worker can't write files, so Counterpart files the selected runs and keeps the latest as the model.
const SOLID = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
async function cadRun(cadDir, folder, name, {at, stl = SOLID, step = true, inputs, renders = ['front', 'contact'], final = false, valid = true, status = 'completed', receipt = true, extra = {}} = {}) {
  const {mkdir} = await import('node:fs/promises');
  const dir = join(cadDir, folder);
  await mkdir(join(dir, `${name}.renders`), {recursive: true});
  await writeFile(join(dir, `${name}.py`), `# ${name}`);
  await writeFile(join(dir, `${name}.parameters.json`), JSON.stringify({height: 70}));
  if (stl) await writeFile(join(dir, `${name}.stl`), stl);
  if (step) await writeFile(join(dir, `${name}.step`), 'STEP');
  const views = {};
  for (const view of renders) { await writeFile(join(dir, `${name}.renders`, `${view}.png`), view); views[view] = join(dir, `${name}.renders`, `${view}.png`); }
  let manifest;
  if (inputs) {
    // Input bundles live outside the run folder (cad/1: output_dir/.cad-inputs/<hash>/).
    const bundle = join(cadDir, '.cad-inputs', 'bundle');
    await mkdir(bundle, {recursive: true});
    const listed = {};
    for (const [alias, file] of Object.entries(inputs)) { await writeFile(join(bundle, file), file); listed[alias] = join(bundle, file); }
    manifest = join(dir, `${name}.inputs.json`);
    await writeFile(manifest, JSON.stringify(listed));
  }
  if (receipt) await writeFile(join(dir, 'cad-result.json'), JSON.stringify({status, final, valid, completed_at: new Date(at ?? Date.now()).toISOString(), lineage_id: 'sha',
    script: join(dir, `${name}.py`), parameters: join(dir, `${name}.parameters.json`), stl: join(dir, `${name}.stl`), step: step ? join(dir, `${name}.step`) : null,
    ...(manifest ? {input_manifest: manifest} : {}), renders: views, checks: {watertight: valid, manifold: valid}, ...extra}));
  return dir;
}
const codeWorker = (structured_output, extra = {}) => async () => ({toolCalls: 4, stderrTail: '', exitCode: 0, seconds: 9, publicText: text => text,
  ...(structured_output ? {resultEvent: {type: 'result', structured_output, total_cost_usd: 0.5}} : {}), ...extra});
const codeInv = (pass, worker) => ({command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {}}, engine: 'code', worker});

test('a code pass files the runs marked final as checkpoints and keeps the latest as its model, renders and design source', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-collect-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  // As the Nov 10 holder pass left them: the scan measured first, then the design; names don't matter, final does.
  await cadRun(cadDir, 'cad-scan_prep-1', 'scan_prep', {at: t0, step: false});
  await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, final: true, stl: 'not an stl'});
  await cadRun(cadDir, 'cad-holder-3', 'holder', {at: t0 + 2000, final: true, inputs: {scan: 'mesh.obj'}});
  const last = await cadRun(cadDir, 'cad-holder-4', 'holder', {at: t0 + 3000, final: true, inputs: {scan: 'mesh.obj', texture: 'mesh_basecolor_0.png'}});
  await cadRun(cadDir, 'cad-letters-5', 'letters', {at: t0 + 4000, step: false});
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Cleaned up.'})), pass);
  assert.equal(result.status, 'done');
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
  assert.equal(await readFile(result.model, 'utf8'), SOLID);
  // The measuring run, the broken export and the one-colour part are not checkpoints; the final runs are, in order.
  assert.deepEqual(result.checkpoints, ['001.stl', '002.stl'].map(name => join(pass.checkpointsDir, name)));
  // The overall sheet sorts first, as the rules ask of renders.
  assert.deepEqual(result.renders.map(path => path.split('/').at(-1)), ['1-contact.png', '2-front.png']);
  assert.equal(await readFile(join(pass.outDir, '1-contact.png'), 'utf8'), 'contact');
  assert.deepEqual(result.design, {script: join(last, 'holder.py'), parameters: join(last, 'holder.parameters.json'),
    inputs: join(last, 'holder.inputs.json'), step: join(last, 'holder.step'), result: join(last, 'cad-result.json')});
});

test('a final run that failed, is invalid or has no receipt is never the model; an unselected run never is', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-receipts-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  const good = await cadRun(cadDir, 'cad-holder-1', 'holder', {at: t0, final: true});
  await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, final: true, valid: false});
  await cadRun(cadDir, 'cad-holder-3', 'holder', {at: t0 + 2000, final: true, status: 'failed'});
  await cadRun(cadDir, 'cad-holder-4', 'holder', {at: t0 + 3000, final: true, receipt: false});
  await cadRun(cadDir, 'cad-holder-5', 'holder', {at: t0 + 4000});
  await cadRun(cadDir, 'notcad-holder-6', 'holder', {at: t0 + 5000, final: true});
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.deepEqual(result.checkpoints, [join(pass.checkpointsDir, '001.stl')]);
  assert.equal(result.design.script, join(good, 'holder.py'), 'the latest completed, valid, selected run');
});

test('a code pass that only measured the scan, then asked or stopped, leaves no model and no design source', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-measured-');
  for (const ending of [{answer: {status: 'needs_closeup', summary: 'Which size?', closeup: 'the cap'}, status: 'needs_closeup'},
    {answer: undefined, extra: {stopReason: 'Stopped at the 120 tool-call limit', limit: {kind: 'tool-calls', value: 120}}, status: 'capped'},
    {answer: {status: 'failed', summary: 'The engine stopped.'}, status: 'failed'}]) {
    const pass = await prepareTouchupPass({root, objectId: ending.status, scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
    const cadDir = join(pass.dir, 'cad');
    await mkdir(cadDir, {recursive: true});
    const t0 = Date.now() - 60_000;
    for (const [index, name] of ['scan_prep', 'scan_aligned_body', 'scan_aligned_full', 'scan_shoulder_slab'].entries())
      await cadRun(cadDir, `cad-${name}-${index}`, name, {at: t0 + index * 1000, step: false});
    const result = await runTouchupWorker(codeInv(pass, codeWorker(ending.answer, ending.extra)), pass);
    assert.equal(result.status, ending.status);
    assert.equal(result.model, undefined, `${ending.status}: a scan measurement never becomes the model`);
    assert.equal(result.design, undefined);
    assert.deepEqual(result.checkpoints, []);
  }
});

test('a code pass stopped at a limit keeps its latest final run, as any capped pass keeps its last checkpoint', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-capped-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  const draft = await cadRun(cadDir, 'cad-holder-1', 'holder', {at: t0, final: true});
  await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, stl: false});
  const capped = await runTouchupWorker(codeInv(pass, codeWorker(undefined, {stopReason: 'Stopped at the 120 tool-call limit', limit: {kind: 'tool-calls', value: 120}})), pass);
  assert.equal(capped.status, 'capped');
  assert.equal(capped.model, join(pass.outDir, 'touched.stl'));
  assert.deepEqual(capped.checkpoints, [join(pass.checkpointsDir, '001.stl')]);
  assert.deepEqual(capped.design, {script: join(draft, 'holder.py'), parameters: join(draft, 'holder.parameters.json'), step: join(draft, 'holder.step'), result: join(draft, 'cad-result.json')});
});

test('the pass folder alone gives the selected run and its validation, without building (the receipt read from disk, nothing in memory)', async () => {
  const {mkdir, readFile: read} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-restart-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const run = await cadRun(cadDir, 'cad-holder-1', 'holder', {at: Date.now() - 1000, final: true});
  // A fresh import of the collector, with nothing in memory: only the disk, and no process started.
  const {collectCodeRuns} = await import(`../dist/touchup/code-engine.js?restart=${Date.now()}`);
  const {isValidStl} = await import('../dist/touchup/runner.js');
  const found = await collectCodeRuns(pass, isValidStl);
  assert.equal(found.design.result, join(run, 'cad-result.json'));
  assert.deepEqual(JSON.parse(await read(found.design.result, 'utf8')).checks, {watertight: true, manifold: true});
  assert.equal(await read(join(pass.outDir, 'touched.stl'), 'utf8'), SOLID);
});

// Review of #439, F1: the model and its design source arrive together or not at all.
test('a selected run\'s missing render never costs the design source; a run without an in-folder script and parameters is not selectable', async () => {
  const {mkdir, rm} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-together-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  const earlier = await cadRun(cadDir, 'cad-holder-1', 'holder', {at: t0, final: true});
  const latest = await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, final: true});
  await rm(join(latest, 'holder.renders', 'front.png'));  // a render the receipt names is gone
  const missing = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.equal(missing.model, join(pass.outDir, 'touched.stl'));
  assert.equal(missing.design?.script, join(latest, 'holder.py'), 'the design source comes with the model');
  assert.deepEqual(missing.renders.map(path => path.split('/').at(-1)), ['1-contact.png'], 'the render that exists is kept');
  assert.ok(earlier);
  // The latest final run lost its script: it is not selectable, so the earlier one is the model and the design.
  const again = await prepareTouchupPass({root, objectId: 'obj2', scan: [], photos: [], requirePhotos: false});
  const againCad = join(again.dir, 'cad');
  await mkdir(againCad, {recursive: true});
  const first = await cadRun(againCad, 'cad-holder-1', 'holder', {at: t0, final: true});
  const broken = await cadRun(againCad, 'cad-holder-2', 'holder', {at: t0 + 1000, final: true});
  await rm(join(broken, 'holder.py'));
  const fallback = await runTouchupWorker(codeInv(again, codeWorker({status: 'done', summary: 'Done.'})), again);
  assert.equal(fallback.design?.script, join(first, 'holder.py'));
  assert.deepEqual(fallback.checkpoints, [join(again.checkpointsDir, '001.stl')], 'the unselectable run is no checkpoint either');
});

test('a collector that fails promotes nothing and says why on the pass', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-collect-fails-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  await cadRun(cadDir, 'cad-holder-1', 'holder', {at: Date.now() - 1000, final: true});
  await mkdir(join(pass.outDir, 'touched.stl'));  // the model can't be written
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.equal(result.status, 'failed');
  assert.equal(result.model, undefined, 'no model without its design source');
  assert.equal(result.design, undefined);
  assert.match(result.reason, /^Counterpart couldn't keep this pass's design/);
});

// #788: engine round 4 (#608) makes cad_run refuse final until the part's purpose checks pass. A pass whose worker
// answered done with no final run keeps its last valid run as a draft, with the MCP's own reasons, never nothing.
const round4 = fileURLToPath(new URL('./fixtures/cad-round4/', import.meta.url));
/** A real round-4 receipt's own fields (the fixture, with this run's folder put in), over the helper's base receipt. */
async function round4Receipt(fixture, dir) {
  const receipt = JSON.parse((await readFile(join(round4, fixture), 'utf8')).replaceAll('@RUN@', dir));
  const {mkdir} = await import('node:fs/promises');
  await mkdir(join(dir, 'phone_mount.renders'), {recursive: true});
  for (const [view, path] of Object.entries(receipt.renders)) await writeFile(path, view);
  for (const file of ['py', 'parameters.json', 'step']) await writeFile(join(dir, `phone_mount.${file}`), file);
  await writeFile(join(dir, 'phone_mount.stl'), SOLID);
  await writeFile(join(dir, 'phone_mount.inputs.json'), '{}');
  await writeFile(join(dir, 'cad-result.json'), JSON.stringify(receipt));
  return receipt;
}

test('#788: a code pass answered done with only non-final runs keeps the last valid one as a draft, with the engine\'s reasons', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-draft-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.parse('2026-11-12T19:00:00Z');
  await cadRun(cadDir, 'cad-phone_mount-1', 'phone_mount', {at: t0});
  await cadRun(cadDir, 'cad-phone_mount-2', 'phone_mount', {at: t0 + 1000, valid: false});
  const run = join(cadDir, 'cad-phone_mount-3');
  const receipt = await round4Receipt('final-refused.cad-result.json', run);
  await cadRun(cadDir, 'cad-phone_mount-4', 'phone_mount', {at: Date.parse('2026-11-12T19:30:00Z'), status: 'failed'});
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'A dash mount for the phone.'})), pass);
  assert.equal(result.status, 'done');
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
  assert.equal(await readFile(result.model, 'utf8'), SOLID);
  assert.deepEqual(result.draft, {reasons: receipt.final_refused}, 'final_refused, word for word');
  assert.equal(result.design.script, join(run, 'phone_mount.py'));
  assert.equal(result.design.result, join(run, 'cad-result.json'));
  // Filed as any pass's result is: one checkpoint (a scan pass with none would read as unchanged), its views as renders.
  assert.deepEqual(result.checkpoints, [join(pass.checkpointsDir, '001.stl')]);
  assert.ok(result.renders.some(path => path.endsWith('-use.png')), 'renders.use comes with it');
  assert.equal(result.renders[0].split('/').at(-1), '1-contact.png');
});

test('#788: a draft from a run the worker never asked to make final gives the failing purpose requirements; an older MCP\'s gives none', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-draft-reqs-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const receipt = await round4Receipt('not-ready.cad-result.json', join(cadDir, 'cad-phone_mount-1'));
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.equal(result.status, 'done', 'a scan pass\'s draft is a change, not unchanged');
  const failing = receipt.purpose.requirements.filter(item => item.status !== 'pass');
  assert.equal(failing.length, 3);
  assert.deepEqual(result.draft, {reasons: failing.map(item => item.fix)});
  // An MCP from before round 4: no final_refused, no purpose. Still a draft, with no reasons.
  const older = await prepareTouchupPass({root, objectId: 'older', scan: [], photos: [], requirePhotos: false});
  await mkdir(join(older.dir, 'cad'), {recursive: true});
  await cadRun(join(older.dir, 'cad'), 'cad-holder-1', 'holder', {at: Date.now() - 1000});
  const plain = await runTouchupWorker(codeInv(older, codeWorker({status: 'done', summary: 'Done.'})), older);
  assert.equal(plain.status, 'done');
  assert.deepEqual(plain.draft, {});
  assert.ok(plain.model);
});

test('#788: a final run still wins over a later non-final one, and is no draft', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-draft-final-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  const chosen = await cadRun(cadDir, 'cad-holder-1', 'holder', {at: t0, final: true});
  await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, extra: {ready: false, final_requested: true, final_refused: ['Model the desk as world:desk in use().']}});
  const result = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.equal(result.design.script, join(chosen, 'holder.py'));
  assert.equal(result.draft, undefined);
});

test('#788: with no valid run at all the pass still fails with no model; a locate pass, a question, a limit or a failure never draft', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-draft-none-');
  const pass = await prepareTouchupPass({root, objectId: 'none', scan: [], photos: [], requirePhotos: false});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  await cadRun(cadDir, 'cad-holder-1', 'holder', {at: t0, valid: false});
  await cadRun(cadDir, 'cad-holder-2', 'holder', {at: t0 + 1000, stl: 'not an stl'});
  await cadRun(cadDir, 'cad-holder-3', 'holder', {at: t0 + 2000, status: 'failed'});
  const none = await runTouchupWorker(codeInv(pass, codeWorker({status: 'done', summary: 'Done.'})), pass);
  assert.equal(none.status, 'failed');
  assert.equal(none.reason, 'no model was saved');
  assert.equal(none.model, undefined);
  assert.equal(none.draft, undefined);
  for (const ending of [{answer: {status: 'done', summary: 'It sits at the back.'}, opts: {locate: true}, status: 'done'},
    {answer: {status: 'needs_closeup', summary: 'Which size?', closeup: 'the cap'}, status: 'needs_closeup'},
    {answer: undefined, extra: {stopReason: 'Stopped at the 120 tool-call limit', limit: {kind: 'tool-calls', value: 120}}, status: 'capped'},
    {answer: {status: 'failed', summary: 'The engine stopped.'}, status: 'failed'}]) {
    const other = await prepareTouchupPass({root, objectId: ending.status + (ending.opts ? '-locate' : ''), scan: [], photos: [], requirePhotos: false});
    await mkdir(join(other.dir, 'cad'), {recursive: true});
    await cadRun(join(other.dir, 'cad'), 'cad-holder-1', 'holder', {at: t0});
    const result = await runTouchupWorker(codeInv(other, codeWorker(ending.answer, ending.extra)), other, ending.opts);
    assert.equal(result.status, ending.status);
    assert.equal(result.model, undefined, `${ending.status}${ending.opts ? ' (locate)' : ''}: no draft`);
    assert.equal(result.draft, undefined);
  }
});

// Review of #439, F6: the saved script keeps the extension the MCP gave it.
test('a saved code design keeps the script\'s own extension from the receipt', async () => {
  const {mkdir} = await import('node:fs/promises');
  const {copyDesign} = await import('../dist/touchup/code-engine.js');
  const root = await tempDir('touchup-code-ext-');
  await mkdir(join(root, 'run'), {recursive: true});
  await writeFile(join(root, 'run', 'holder.cad'), '# script');
  await writeFile(join(root, 'run', 'holder.parameters.json'), '{}');
  const copy = await copyDesign({script: join(root, 'run', 'holder.cad'), parameters: join(root, 'run', 'holder.parameters.json')}, join(root, 'saved'));
  assert.equal(copy.script, join(root, 'saved', 'touched.cad'));
  assert.equal(copy.parameters, join(root, 'saved', 'touched.parameters.json'));
});
