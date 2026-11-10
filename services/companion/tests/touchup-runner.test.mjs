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

// A code pass (PRD §8.9): every cad_run leaves its own folder under the pass's design folder. The worker can't
// write files, so Counterpart files the runs as checkpoints and takes the model, renders and design source from
// the last run named "touched" (or, if the pass stopped before one, the last run with a model).
const SOLID = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
async function cadRun(cadDir, folder, name, {at, stl = SOLID, step = true, inputs, renders = ['front', 'contact']} = {}) {
  const {mkdir, utimes} = await import('node:fs/promises');
  const dir = join(cadDir, folder);
  await mkdir(join(dir, `${name}.renders`), {recursive: true});
  await writeFile(join(dir, `${name}.py`), `# ${name}`);
  await writeFile(join(dir, `${name}.parameters.json`), JSON.stringify({height: 70}));
  if (stl) await writeFile(join(dir, `${name}.stl`), stl);
  if (step) await writeFile(join(dir, `${name}.step`), 'STEP');
  for (const view of renders) await writeFile(join(dir, `${name}.renders`, `${view}.png`), view);
  if (inputs) {
    await mkdir(join(dir, 'inputs'), {recursive: true});
    const manifest = {};
    for (const [alias, file] of Object.entries(inputs)) { await writeFile(join(dir, 'inputs', file), file); manifest[alias] = join(dir, 'inputs', file); }
    await writeFile(join(dir, `${name}.inputs.json`), JSON.stringify(manifest));
  }
  if (at) await utimes(join(dir, `${name}.py`), at / 1000, at / 1000);
  return dir;
}
const codeWorker = (structured_output, extra = {}) => async () => ({toolCalls: 4, stderrTail: '', exitCode: 0, seconds: 9, publicText: text => text,
  ...(structured_output ? {resultEvent: {type: 'result', structured_output, total_cost_usd: 0.5}} : {}), ...extra});

test('a code pass files its "touched" runs as checkpoints and keeps the last as its model, renders and design source', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-collect-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  // As the Nov 10 holder pass left them: the scan measured first, then the design.
  await cadRun(cadDir, 'cad-scan_prep-1', 'scan_prep', {at: t0, step: false});
  await cadRun(cadDir, 'cad-touched-2', 'touched', {at: t0 + 1000, stl: 'not an stl'});
  await cadRun(cadDir, 'cad-touched-3', 'touched', {at: t0 + 2000, inputs: {scan: 'mesh.obj'}});
  const last = await cadRun(cadDir, 'cad-touched-4', 'touched', {at: t0 + 3000, inputs: {scan: 'mesh.obj', texture: 'mesh_basecolor_0.png'}});
  await cadRun(cadDir, 'cad-part-5', 'letters', {at: t0 + 4000, step: false});
  const inv = {command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {}}, engine: 'code', worker: codeWorker({status: 'done', summary: 'Cleaned up.'})};
  const result = await runTouchupWorker(inv, pass);
  assert.equal(result.status, 'done');
  assert.equal(result.model, join(pass.outDir, 'touched.stl'));
  assert.equal(await readFile(result.model, 'utf8'), SOLID);
  // The measuring run, the broken export and the one-colour part are not checkpoints; the touched runs are, in order.
  assert.deepEqual(result.checkpoints, ['001.stl', '002.stl'].map(name => join(pass.checkpointsDir, name)));
  // The overall sheet sorts first, as the rules ask of renders.
  assert.deepEqual(result.renders.map(path => path.split('/').at(-1)), ['1-contact.png', '2-front.png']);
  assert.equal(await readFile(join(pass.outDir, '1-contact.png'), 'utf8'), 'contact');
  assert.deepEqual(result.design, {script: join(last, 'touched.py'), parameters: join(last, 'touched.parameters.json'),
    inputs: join(last, 'touched.inputs.json'), step: join(last, 'touched.step')});
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
    const inv = {command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {}}, engine: 'code', worker: codeWorker(ending.answer, ending.extra)};
    const result = await runTouchupWorker(inv, pass);
    assert.equal(result.status, ending.status);
    assert.equal(result.model, undefined, `${ending.status}: a scan measurement never becomes the model`);
    assert.equal(result.design, undefined);
    assert.deepEqual(result.checkpoints, []);
  }
});

test('a code pass stopped at a limit keeps its last touched run, as any capped pass keeps its last checkpoint', async () => {
  const {mkdir} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-capped-');
  const pass = await prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
  const cadDir = join(pass.dir, 'cad');
  await mkdir(cadDir, {recursive: true});
  const t0 = Date.now() - 60_000;
  const draft = await cadRun(cadDir, 'cad-touched-1', 'touched', {at: t0});
  await cadRun(cadDir, 'cad-touched-2', 'touched', {at: t0 + 1000, stl: false});
  const inv = {command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {}}, engine: 'code',
    worker: codeWorker(undefined, {stopReason: 'Stopped at the 120 tool-call limit', limit: {kind: 'tool-calls', value: 120}})};
  const capped = await runTouchupWorker(inv, pass);
  assert.equal(capped.status, 'capped');
  assert.equal(capped.model, join(pass.outDir, 'touched.stl'));
  assert.deepEqual(capped.checkpoints, [join(pass.checkpointsDir, '001.stl')]);
  assert.deepEqual(capped.design, {script: join(draft, 'touched.py'), parameters: join(draft, 'touched.parameters.json'), step: join(draft, 'touched.step')});
});
