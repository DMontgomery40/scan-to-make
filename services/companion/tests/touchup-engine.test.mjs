import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {runTouchup, chooseEngine, printerDesignGuidance} from '../dist/touchup/touchup.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {systemRules, TOUCHUP_SYSTEM_RULES, TOUCHUP_RESULT_SCHEMA, buildTouchupInvocation} from '../dist/touchup/invocation.js';
import {runTouchupWorker} from '../dist/touchup/runner.js';
import {passEstimate, PassTimings, STAGE_DEFAULT_SEC} from '../dist/touchup/stages.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const handoff = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}};
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const error = message => ({isError: true, content: [{type: 'text', text: message}]});
function bridge(results, tools = ['blender_mcp_status', 'blender_mcp_call', 'fusion_mcp_status', 'fusion_mcp_new_design', 'fusion_mcp_call', 'fusion_mcp_export']) {
  const calls = [];
  return {calls, client: () => ({
    async connect() {}, async close() {},
    hasTool: name => tools.includes(name),
    getTool: name => ({name, inputSchema: {type: "object", properties: {bind_document: {type: "boolean"}}}}),
    async callTool(name, args) { calls.push({name, args}); return (typeof results[name] === 'function' ? results[name](args) : results[name]) ?? text(name === "fusion_mcp_new_design" ? {document_binding: 1, document_id: "owned-token"} : {}); },
  })};
}

test('a pass reads both of the printer MCP\'s prompts, fdm_design and fdm_slicing, and an MCP without prompts gives none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'touchup-guidance-'));
  const fixture = fileURLToPath(new URL('../../printer-handoff/tests/fixtures/fixture-printer-server.mjs', import.meta.url));
  const config = env => ({backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [fixture, 'bambu', join(root, 'calls.jsonl')], cwd: root, env},
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 5000}});
  assert.deepEqual(await printerDesignGuidance(config({HANDOFF_FIXTURE_PROMPTS: '1'})), {
    design: 'Design the finished object the user wants, with the manufacturing plan as part of the design.',
    slicing: 'How this printer MCP slices. Its slicer is the fixture slicer.'});
  assert.deepEqual(await printerDesignGuidance(config({})), {});
});

test('copies always use Blender; a design uses Fusion only when it is connected and a new design opens', async () => {
  const copy = bridge({});
  assert.deepEqual(await chooseEngine({handoff, kind: 'copy'}, copy), {engine: 'blender'});
  assert.equal(copy.calls.length, 0, 'a copy never asks about Fusion');
  const ok = bridge({fusion_mcp_status: text({configured: true, connected: true, addinReachable: true, fusionRunning: true, tools: ['extrude']})});
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, ok), {engine: 'fusion', documentId: 'owned-token'});
  assert.deepEqual(ok.calls.map(c => c.name), ['fusion_mcp_status', 'fusion_mcp_new_design']);
  assert.deepEqual(ok.calls[0].args, {launch: true, timeout_ms: 90000});
  // faust-machines/fusion360-mcp-server#12: no new design → Blender, with the reason recorded.
  const blocked = bridge({fusion_mcp_status: text({configured: true, connected: true}), fusion_mcp_new_design: error('No active design')});
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, blocked), {engine: 'blender', note: "Fusion couldn't open a new design: No active design"});
  const off = bridge({fusion_mcp_status: text({configured: true, connected: false, error: 'Fusion is not running'})});
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, off), {engine: 'blender', note: "Fusion isn't connected: Fusion is not running."});
  const notSetUp = bridge({fusion_mcp_status: text({configured: false, connected: false})});
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, notSetUp), {engine: 'blender'});
  const older = bridge({}, ['blender_mcp_status', 'blender_mcp_call']);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, older), {engine: 'blender'});
  const failing = bridge({fusion_mcp_status: error('bridge timed out')});
  assert.equal((await chooseEngine({handoff, kind: 'fit'}, failing)).note, "Fusion isn't reachable: bridge timed out");
});

test('a project choosing Blender does not open Fusion even for a new design', async () => {
  const fusion = bridge({fusion_mcp_status: text({configured: true, connected: true})});
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit', preferredEngine: 'blender'}, fusion), {engine: 'blender'});
  assert.deepEqual(fusion.calls, []);
});

test('a Fusion pass never touches Blender: no lock, no launch, no scene reset', async () => {
  const log = [];
  const fusion = bridge({fusion_mcp_status: text({configured: true, connected: true})});
  const root = await mkdtemp(join(tmpdir(), 'touchup-engine-'));
  const stages = [];
  const result = await runTouchup({root, objectId: 'obj', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hook for a 25 mm rail', kind: 'fit',
    onStage: (stage, engine) => stages.push([stage, engine])}, {
    lockPath: join(mkdtempSync(join(tmpdir(), 'touchup-engine-lock-')), 'blender.lock'),
    fusionLockPath: join(mkdtempSync(join(tmpdir(), 'touchup-engine-fusion-')), 'fusion.lock'),
    ensureBlender: async () => { log.push('ensureBlender'); },
    resetScene: async () => { log.push('resetScene'); },
    client: fusion.client,
    prepare: async args => { log.push('prepare'); return prepareTouchupPass(args); },
    guidance: async config => { log.push('guidance'); assert.equal(config, handoff, 'the guidance comes from the configured printer MCP'); return {design: 'Plan the print as part of the design.', slicing: 'Its slicer orients it.'}; },
    run: async (inv, pass) => { log.push('run'); assert.match(inv.args.join(' '), /fusion_mcp_export/);
      assert.match(inv.args[inv.args.indexOf('--append-system-prompt') + 1], /its fdm_design prompt\):\nPlan the print as part of the design\.\n\nHow the printer MCP slices \(its fdm_slicing prompt\):\nIts slicer orients it\.$/); return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  assert.deepEqual(log, ['prepare', 'guidance', 'run']);
  assert.equal(result.engine, 'fusion');
  assert.deepEqual(stages, [['preparing', 'blender'], ['working', 'fusion']]);
});

test('the worker is told its engine, and a later change starts from the Fusion design\'s parameters', async () => {
  assert.equal(TOUCHUP_SYSTEM_RULES, systemRules('blender'));
  assert.match(systemRules('blender'), /blender_mcp_\* tools/);
  assert.doesNotMatch(systemRules('fusion'), /blender_mcp/);
  assert.match(systemRules('fusion'), /named user parameter/);
  assert.doesNotMatch(systemRules('fusion'), /using Blender through MCP/, 'a Fusion worker is never told to model in Blender');
  assert.match(systemRules('blender'), /using Blender through MCP/);
  const root = await mkdtemp(join(tmpdir(), 'touchup-engine-inv-'));
  const pass = await prepareTouchupPass({root, objectId: 'o', scan: [], photos: [], requirePhotos: false});
  const inv = buildTouchupInvocation({pass, printer: handoff.process, claudePath: '/c', instructions: 'A hook', note: 'Make it 1 mm wider', currentModel: true,
    engine: 'fusion', documentId: 'owned-token', handoff, design: {f3d: '/p/current/design.f3d', parameters: '/p/current/parameters.json'}});
  assert.match(inv.args.at(-1), /parametric Fusion design: \/p\/current\/design\.f3d \(its parameters: \/p\/current\/parameters\.json\)/);
  for (const field of ['title', 'changes', 'ask']) assert.ok(TOUCHUP_RESULT_SCHEMA.properties[field], field);
});

function fakeWorker(answer, message) {
  return () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      if (message) child.stdout.write(JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: message}]}}) + '\n');
      child.stdout.end(JSON.stringify({type: 'result', structured_output: answer}) + '\n');
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

test('the worker\'s title, what-changed list and Ask are checked before anyone sees them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touchup-engine-worker-'));
  const pass = await prepareTouchupPass({root, objectId: 'o', scan: [], photos: [], requirePhotos: false});
  await writeFile(join(pass.outDir, 'touched.stl'), 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n');
  await writeFile(join(pass.outDir, 'touched.f3d'), 'f3d');
  const inv = {command: '/c', args: [], env: {}, cwd: pass.dir, mcpConfigPath: '', mcpConfig: {mcpServers: {printer: {command: '/x', args: [], env: {API_KEY: 'secret-key-value'}}}}};
  const result = await runTouchupWorker(inv, pass, {spawn: fakeWorker({status: 'done', summary: 'Made it.', title: 'Mic mount.',
    changes: [{tag: 'added', text: 'Two 4 mm holes'}, {tag: 'estimated', text: 'Pole 25 mm', toleranceMm: 1}, {tag: 'guessed', text: 'bad tag'}, {tag: 'changed', text: 'uses secret-key-value'}],
    ask: {question: 'Can you photograph the clip?', photo: '../../etc/photo-03.jpg', region: {x: 0.1, y: 0.2, width: 2, height: 0.3}}})});
  assert.equal(result.title, 'Mic mount');
  assert.deepEqual(result.changes, [{tag: 'added', text: 'Two 4 mm holes'}, {tag: 'estimated', text: 'Pole 25 mm', toleranceMm: 1}, {tag: 'changed', text: 'uses [redacted]'}]);
  assert.deepEqual(result.ask, {question: 'Can you photograph the clip?', photo: 'photo-03.jpg'}, 'a region outside the picture is dropped');
  assert.deepEqual(result.design, {f3d: join(pass.outDir, 'touched.f3d')});
});

test('pass estimates come from real stage times on this Mac, with defaults until there are some', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touchup-engine-timings-'));
  const timings = new PassTimings(join(root, 'pass-timings.json'));
  assert.deepEqual(await timings.typical('fit', 'blender'), STAGE_DEFAULT_SEC.fit);
  for (const seconds of [100, 300, 200]) await timings.record('fit', 'blender', 'working', seconds);
  assert.equal((await timings.typical('fit', 'blender')).working, 200);
  assert.equal((await new PassTimings(join(root, 'pass-timings.json')).typical('fit', 'blender')).working, 200, 'kept on disk');
  const typical = {building: 300, preparing: 20, working: 200, saving: 10};
  const now = 1_000_000;
  assert.deepEqual(passEstimate([{id: 'preparing', words: '', startedAtMs: now - 5000, typicalSec: 20}], ['preparing', 'working', 'saving'], typical, now), {remainingSec: 225, endsAtMs: now + 225_000});
  // An overrunning stage never reads as nothing left.
  assert.equal(passEstimate([{id: 'working', words: '', startedAtMs: now - 900_000, typicalSec: 200}], ['preparing', 'working', 'saving'], typical, now).remainingSec, 40);
});

test('design passes hold Fusion across processes from opening the document to the end of the worker', async () => {
  const {acquireBlenderLock} = await import('../dist/touchup/touchup.js');
  const fusionLockPath = join(mkdtempSync(join(tmpdir(), 'touchup-engine-fusion2-')), 'fusion.lock');
  const other = await acquireBlenderLock(fusionLockPath); // another companion holds Fusion
  const fusion = bridge({fusion_mcp_status: text({configured: true, connected: true})});
  const root = await mkdtemp(join(tmpdir(), 'touchup-engine-'));
  let ran = false;
  const pass = runTouchup({root, objectId: 'obj', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hook', kind: 'fit'}, {
    fusionLockPath, lockPath: join(mkdtempSync(join(tmpdir(), 'touchup-engine-lock2-')), 'blender.lock'),
    client: fusion.client, prepare: args => prepareTouchupPass(args),
    run: async (inv, p) => { ran = true; return {status: 'done', model: join(p.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fusion.calls.length, 0, 'no new design while another process has Fusion');
  await other();
  await pass;
  assert.equal(ran, true);
});

test('Fusion selection requires a bound identity and imports the prior archive before the worker', async () => {
  const bound = bridge({fusion_mcp_status: text({configured: true, connected: true}), fusion_mcp_new_design: text({document_binding: 1, document_id: 'owned-token'})});
  const selected = await chooseEngine({handoff, kind: 'fit', design: {f3d: '/project/model.f3d'}}, bound);
  assert.deepEqual(selected, {engine: 'fusion', documentId: 'owned-token'});
  assert.deepEqual(bound.calls.at(-1).args, {bind_document: true, source_f3d: '/project/model.f3d'});
  const legacy = bridge({fusion_mcp_status: text({configured: true, connected: true}), fusion_mcp_new_design: text({document: 'Untitled'})});
  const refused = await chooseEngine({handoff, kind: 'fit'}, legacy);
  assert.equal(refused.engine, 'blender');
  assert.match(refused.note, /document binding/);
});

test('Fusion worker config carries the binding independently of configured SSH arguments', async () => {
  const {readFile} = await import('node:fs/promises');
  const pass = await prepareTouchupPass({root: await mkdtemp(join(tmpdir(), 'fusion-config-')), objectId: 'p', scan: [], photos: [], requirePhotos: false});
  const ssh = {...handoff, process: {command: '/usr/bin/ssh', args: ['-i', '/configured/key', 'localhost', 'forced-printer']}};
  const invocation = buildTouchupInvocation({pass, printer: ssh.process, handoff: ssh, claudePath: '/claude', engine: 'fusion', documentId: 'trusted-document'});
  const entry = invocation.mcpConfig.mcpServers.printer;
  assert.equal(entry.command, process.execPath);
  assert.match(entry.args[0], /fusion-worker-cli\.js$/);
  const binding = JSON.parse(await readFile(entry.args[1], 'utf8'));
  assert.deepEqual(binding, {handoff: ssh, documentId: 'trusted-document'});
  assert.throws(() => buildTouchupInvocation({pass, printer: ssh.process, claudePath: '/claude', engine: 'fusion'}), /binding/);
});

for (const outcome of [
  {status: 'done', archive: 'valid', closed: ['verification-token', 'owned-token']},
  {status: 'unchanged', archive: 'valid', closed: ['verification-token', 'owned-token']},
  {status: 'done', archive: 'valid', closeFailure: 'verification-token', closed: ['verification-token']},
  {status: 'done', archive: 'valid', closeFailure: 'owned-token', closed: ['verification-token', 'owned-token']},
  {status: 'failed', archive: 'valid', closed: []},
  {status: 'capped', archive: 'valid', closed: []},
  {status: 'done', archive: undefined, closed: []},
  {status: 'done', archive: 'empty', closed: [], rejected: true},
  {status: 'done', archive: 'truncated', closed: [], rejected: true},
  {status: 'done', archive: 'valid', returnedId: 'owned-token', closed: [], rejected: true},
]) test(`Fusion archive validation ${JSON.stringify(outcome)}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-owned-lifecycle-'));
  const fusion = bridge({
    fusion_mcp_status: text({configured: true, connected: true}),
    fusion_mcp_new_design: args => args.source_f3d
      ? outcome.archive === 'truncated' ? error('The archive could not be imported') : text({document_binding: 1, document_id: outcome.returnedId ?? 'verification-token'})
      : text({document_binding: 1, document_id: 'owned-token'}),
    fusion_mcp_call: args => args.document_id === outcome.closeFailure ? error('close refused') : text({}),
  });
  const result = await runTouchup({root, objectId: 'o', scan: [], photos: [], instructions: 'A small box', handoff, claudePath: '/claude', kind: 'fit'}, {
    client: fusion.client, fusionLockPath: join(root, 'fusion.lock'),
    run: async (_inv, pass) => {
      const f3d = join(pass.outDir, 'touched.f3d');
      if (outcome.archive) await writeFile(f3d, outcome.archive === 'empty' ? '' : outcome.archive);
      return {status: outcome.status, model: join(pass.outDir, 'touched.stl'), ...(outcome.archive ? {design: {f3d}} : {}), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}};
    },
  });
  assert.equal(result.status, outcome.rejected ? 'failed' : outcome.status);
  const close = fusion.calls.filter(call => call.name === 'fusion_mcp_call' && call.args.tool_name === 'close_document');
  assert.deepEqual(close.map(call => call.args.document_id), outcome.closed);
  if (outcome.rejected) { assert.equal(result.design, undefined); assert.match(result.reason, /archive.*original.*open/i); }
  if (outcome.closeFailure) assert.match(result.note, /document.*open/i);
  if (outcome.closed.length) assert.deepEqual(fusion.calls.find(call => call.name === 'fusion_mcp_new_design' && call.args.source_f3d)?.args,
    {bind_document: true, source_f3d: result.design.f3d});
});

test('bound Fusion workers redact configured credentials without receiving them in their environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-redaction-'));
  const pass = await prepareTouchupPass({root, objectId: 'o', scan: [], photos: [], requirePhotos: false});
  const secret = 'private-printer-credential';
  const config = {...handoff, process: {...handoff.process, env: {ACCESS_CODE: secret}}};
  const inv = buildTouchupInvocation({pass, printer: config.process, handoff: config, claudePath: '/claude', engine: 'fusion', documentId: 'owned-token', instructions: 'A cube'});
  assert.ok(!JSON.stringify(inv.env).includes(secret));
  assert.ok(!JSON.stringify(inv.mcpConfig).includes(secret));
  const progress = [];
  const result = await runTouchupWorker(inv, pass, {spawn: fakeWorker({status: 'needs_closeup', summary: `Message ${secret}`, closeup: `Closeup ${secret}`, changes: [{tag: 'changed', text: `Used ${secret}`}], ask: {question: `Explain ${secret}`}}, `Progress ${secret}`), onProgress: value => progress.push(value)});
  assert.ok(!JSON.stringify({result, progress}).includes(secret));
  assert.match(result.summary, /\[redacted\]/);
  assert.equal(progress[0].lastText, 'Progress [redacted]');
  assert.equal(result.changes[0].text, 'Used [redacted]');
  assert.equal(result.ask.question, 'Explain [redacted]');
  assert.equal(result.closeup, 'Closeup [redacted]');
  const failed = await runTouchupWorker(inv, pass, {spawn: fakeWorker({status: 'failed', summary: `Failure ${secret}`})});
  assert.equal(failed.reason, 'Failure [redacted]');
});
