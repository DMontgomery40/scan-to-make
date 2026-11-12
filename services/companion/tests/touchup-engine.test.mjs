import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runTouchup, chooseEngine, printerDesignGuidance, slicingGuidanceUnavailable, slicingGuidanceUnreachable} from '../dist/touchup/touchup.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {systemRules, RULE_SECTIONS, TOUCHUP_RESULT_SCHEMA, buildTouchupInvocation} from '../dist/touchup/invocation.js';
import {runTouchupWorker} from '../dist/touchup/runner.js';
import {passEstimate, PassTimings, STAGE_DEFAULT_SEC} from '../dist/touchup/stages.js';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {tempDir, tempDirSync} from './support/temp.mjs';

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
  const root = await tempDir('touchup-guidance-');
  const fixture = fileURLToPath(new URL('../../printer-handoff/tests/fixtures/fixture-printer-server.mjs', import.meta.url));
  const config = env => ({backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [fixture, 'bambu', join(root, 'calls.jsonl')], cwd: root, env},
    timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 5000}});
  assert.deepEqual(await printerDesignGuidance(config({HANDOFF_FIXTURE_PROMPTS: '1'})), {
    design: 'Design the finished object the user wants, with the manufacturing plan as part of the design.',
    slicing: 'How this printer MCP slices. Its slicer is the fixture slicer.'});
  assert.deepEqual(await printerDesignGuidance(config({})), {});
});

test('a pass doesn\'t start when the printer MCP serves no fdm_slicing: Update it in Settings → Printers', async () => {
  const log = [];
  const fusion = bridge({fusion_mcp_status: text({configured: true, connected: true})});
  const root = await tempDir('touchup-engine-');
  const base = {root, objectId: 'obj', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hook for a 25 mm rail', kind: 'fit'};
  const deps = guidance => ({
    lockPath: join(tempDirSync('touchup-engine-lock-'), 'blender.lock'),
    fusionLockPath: join(tempDirSync('touchup-engine-fusion-'), 'fusion.lock'),
    ensureBlender: async () => {}, resetScene: async () => {}, client: fusion.client,
    prepare: args => prepareTouchupPass(args),
    guidance: async () => { log.push('guidance'); return typeof guidance === 'function' ? guidance() : guidance; },
    run: async (inv, pass) => { log.push('run'); return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  // An MCP older than fdm_slicing: the slicer facts the app no longer carries would be missing, so nothing runs.
  const older = await runTouchup(base, deps({design: 'Plan the print as part of the design.'}));
  assert.equal(older.status, 'failed');
  assert.equal(older.reason, slicingGuidanceUnavailable('bambu-printer-mcp'));
  assert.match(older.reason, /^Update bambu-printer-mcp in Settings → Printers/);
  assert.deepEqual(log, ['guidance'], 'the worker never started');
  assert.equal(slicingGuidanceUnavailable('mcp-3d-printer-server').startsWith('Update mcp-3D-printer-server in Settings → Printers'), true);
  // An MCP that couldn't be reached gives no guidance: one more try, then the pass refuses rather than design
  // without the slicer rules (R24-003). The words say it's a connection problem, not an old MCP.
  log.length = 0;
  const unreachable = await runTouchup(base, deps(undefined));
  assert.equal(unreachable.status, 'failed');
  assert.equal(unreachable.reason, slicingGuidanceUnreachable('bambu-printer-mcp'));
  assert.doesNotMatch(unreachable.reason, /^Update /);
  assert.deepEqual(log, ['guidance', 'guidance'], 'tried twice, and the worker never started');
  // A blip: the second try answers, so the pass runs with the guidance.
  log.length = 0;
  let calls = 0;
  const blip = await runTouchup(base, deps(() => (++calls === 1 ? undefined : {design: 'Plan the print.', slicing: 'Its slicer orients it.'})));
  assert.equal(blip.status, 'done');
  assert.deepEqual(log, ['guidance', 'guidance', 'run']);
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
  const root = await tempDir('touchup-engine-');
  const stages = [];
  const result = await runTouchup({root, objectId: 'obj', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hook for a 25 mm rail', kind: 'fit',
    onStage: (stage, engine) => stages.push([stage, engine])}, {
    lockPath: join(tempDirSync('touchup-engine-lock-'), 'blender.lock'),
    fusionLockPath: join(tempDirSync('touchup-engine-fusion-'), 'fusion.lock'),
    ensureBlender: async () => { log.push('ensureBlender'); },
    resetScene: async () => { log.push('resetScene'); },
    client: fusion.client,
    prepare: async args => { log.push('prepare'); return prepareTouchupPass(args); },
    guidance: async config => { log.push('guidance'); assert.equal(config, handoff, 'the guidance comes from the configured printer MCP'); return {design: 'Plan the print as part of the design.', slicing: 'Its slicer orients it.'}; },
    run: async (inv, pass) => { log.push('run'); assert.match(inv.args.join(' '), /fusion_mcp_export/);
      // The service's pass kind reaches the rules: a new design's sections, never a scan cleanup's.
      assert.ok(inv.args[inv.args.indexOf('--append-system-prompt') + 1].includes(RULE_SECTIONS.newDesign));
      assert.equal(inv.args[inv.args.indexOf('--append-system-prompt') + 1].includes(RULE_SECTIONS.captured), false);
      assert.match(inv.args[inv.args.indexOf('--append-system-prompt') + 1], /its fdm_design prompt\):\nPlan the print as part of the design\.\n\nHow the printer MCP slices \(its fdm_slicing prompt\):\nIts slicer orients it\.$/); return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  assert.deepEqual(log, ['prepare', 'guidance', 'run']);
  assert.equal(result.engine, 'fusion');
  assert.deepEqual(stages, [['preparing', 'blender'], ['working', 'fusion']]);
});

test('the worker is told its engine, and a later change starts from the Fusion design\'s parameters', async () => {
  const blender = systemRules({kind: 'fit', engine: 'blender', request: true}), fusion = systemRules({kind: 'fit', engine: 'fusion', request: true});
  assert.match(blender, /blender_mcp_\* tools/);
  assert.match(systemRules({kind: 'copy'}), /blender_mcp_\* tools/);
  assert.doesNotMatch(fusion, /blender_mcp/);
  assert.match(fusion, /named user parameter/);
  assert.doesNotMatch(fusion, /using Blender through MCP/, 'a Fusion worker is never told to model in Blender');
  assert.match(fusion, /in Fusion through the printer MCP/);
  assert.match(blender, /using Blender through MCP/);
  const root = await tempDir('touchup-engine-inv-');
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
  const root = await tempDir('touchup-engine-worker-');
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
  const root = await tempDir('touchup-engine-timings-');
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
  const fusionLockPath = join(tempDirSync('touchup-engine-fusion2-'), 'fusion.lock');
  const other = await acquireBlenderLock(fusionLockPath); // another companion holds Fusion
  const fusion = bridge({fusion_mcp_status: text({configured: true, connected: true})});
  const root = await tempDir('touchup-engine-');
  let ran = false;
  const pass = runTouchup({root, objectId: 'obj', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hook', kind: 'fit'}, {
    fusionLockPath, lockPath: join(tempDirSync('touchup-engine-lock2-'), 'blender.lock'),
    client: fusion.client, prepare: args => prepareTouchupPass(args), guidance: async () => ({design: 'Plan the print.', slicing: 'Its slicer orients it.'}), 
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
  const pass = await prepareTouchupPass({root: await tempDir('fusion-config-'), objectId: 'p', scan: [], photos: [], requirePhotos: false});
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
  const root = await tempDir('fusion-owned-lifecycle-');
  const fusion = bridge({
    fusion_mcp_status: text({configured: true, connected: true}),
    fusion_mcp_new_design: args => args.source_f3d
      ? outcome.archive === 'truncated' ? error('The archive could not be imported') : text({document_binding: 1, document_id: outcome.returnedId ?? 'verification-token'})
      : text({document_binding: 1, document_id: 'owned-token'}),
    fusion_mcp_call: args => args.document_id === outcome.closeFailure ? error('close refused') : text({}),
  });
  const result = await runTouchup({root, objectId: 'o', scan: [], photos: [], instructions: 'A small box', handoff, claudePath: '/claude', kind: 'fit'}, {
    client: fusion.client, fusionLockPath: join(root, 'fusion.lock'), guidance: async () => ({design: 'Plan the print.', slicing: 'Its slicer orients it.'}), 
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
  const root = await tempDir('fusion-redaction-');
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

// One engine (PRD §8.9, David Nov 9): the printer MCP's code design engine (cad/1) is chosen whenever it is there
// and set up. Blender and Fusion run exactly as before when it isn't.
const CAD_TOOLS = ['cad_status', 'cad_setup', 'cad_run', 'cad_check_fit'];
const LEGACY_TOOLS = ['blender_mcp_status', 'blender_mcp_call', 'fusion_mcp_status', 'fusion_mcp_new_design', 'fusion_mcp_call', 'fusion_mcp_export'];
const cadStatus = (ready, configured = ready) => ({structuredContent: {configured, ready, python: configured ? '/cad/python' : null, build123d: '0.13.0', platform: 'darwin'}, content: []});

test('the code design engine: ready → it designs and cleans up; installed but not set up → today\'s engine with a note; absent → today\'s engine; a project\'s own choice wins', async () => {
  const {codeEngineNotSetUp} = await import('../dist/touchup/code-engine.js');
  // Ready: fits and copies both use it, and Fusion is never opened.
  for (const kind of ['fit', 'copy']) {
    const ready = bridge({cad_status: cadStatus(true), fusion_mcp_status: text({configured: true, connected: true})}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
    assert.deepEqual(await chooseEngine({handoff, kind}, ready), {engine: 'code'}, kind);
    assert.deepEqual(ready.calls.map(call => call.name), ['cad_status'], `${kind}: only cad_status is asked`);
    assert.deepEqual(ready.calls[0].args, {});
  }
  // A later change to a code design starts from its script, on the code engine.
  const revision = bridge({cad_status: cadStatus(true)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit', design: {script: '/p/current/design/touched.py', parameters: '/p/current/design/touched.parameters.json'}}, revision), {engine: 'code'});
  // The tools are there but the engine isn't set up: today's engine runs, and the pass says the faster one can be set up.
  const copyNotSetUp = bridge({cad_status: cadStatus(false)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'copy'}, copyNotSetUp), {engine: 'blender', note: codeEngineNotSetUp('blender')});
  const installedNotVerified = bridge({cad_status: cadStatus(false, true)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.equal((await chooseEngine({handoff, kind: 'copy'}, installedNotVerified)).engine, 'blender');
  const fitNotSetUp = bridge({cad_status: cadStatus(false), fusion_mcp_status: text({configured: true, connected: true})}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, fitNotSetUp), {engine: 'fusion', documentId: 'owned-token', note: codeEngineNotSetUp('fusion')});
  const fitNeither = bridge({cad_status: cadStatus(false), fusion_mcp_status: text({configured: true, connected: false, error: 'Fusion is not running'})}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, fitNeither), {engine: 'blender', note: `Fusion isn't connected: Fusion is not running. ${codeEngineNotSetUp('blender')}`});
  assert.match(codeEngineNotSetUp('blender'), /Settings/);
  assert.doesNotMatch(codeEngineNotSetUp('blender'), /cad_|build123d|install/);
  // cad_status answering with an error is not "ready".
  const statusError = bridge({cad_status: error('cad_status failed')}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'copy'}, statusError), {engine: 'blender', note: codeEngineNotSetUp('blender')});
  // An MCP without the tools: exactly today's choice, with no note.
  const absentCopy = bridge({}, LEGACY_TOOLS);
  assert.deepEqual(await chooseEngine({handoff, kind: 'copy'}, absentCopy), {engine: 'blender'});
  assert.deepEqual(absentCopy.calls, []);
  const absentFit = bridge({fusion_mcp_status: text({configured: true, connected: true})}, LEGACY_TOOLS);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit'}, absentFit), {engine: 'fusion', documentId: 'owned-token'});
  // The project's own choice wins over the code engine, exactly as it did over Fusion.
  const preferBlender = bridge({cad_status: cadStatus(true)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit', preferredEngine: 'blender'}, preferBlender), {engine: 'blender'});
  assert.deepEqual(preferBlender.calls, []);
  const preferFusion = bridge({cad_status: cadStatus(true), fusion_mcp_status: text({configured: true, connected: false})}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'fit', preferredEngine: 'fusion'}, preferFusion), {engine: 'blender', note: "Fusion isn't connected."});
  assert.equal(preferFusion.calls.some(call => call.name === 'cad_status'), false, 'a Fusion project never asks for the code engine');
  // A Fusion design's next change goes to Fusion; a designer's 3MF is edited in place, which cad/1 can't write.
  const fusionDesign = bridge({cad_status: cadStatus(true), fusion_mcp_status: text({configured: true, connected: true})}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.equal((await chooseEngine({handoff, kind: 'fit', design: {f3d: '/p/current/design.f3d'}}, fusionDesign)).engine, 'fusion');
  const designer = bridge({cad_status: cadStatus(true)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  assert.deepEqual(await chooseEngine({handoff, kind: 'copy', designerCopy: true}, designer), {engine: 'blender'});
  assert.deepEqual(designer.calls, []);
});

test('a project whose passes ran on Blender moves to the code engine while the MCP re-checks itself after an update (#609)', async () => {
  const {CAD_STATUS_TIMEOUT_MS} = await import('../dist/touchup/code-engine.js');
  const {cadCalls} = await import('../dist/cad-settings.js');
  // David, Nov 11 15:39Z: "Use the new design engine so that this comes with the under desk screw", in a project
  // whose eight passes ran on Blender; the pass ran on Blender and said the engine "isn't set up". The first
  // cad_status after an MCP update that changed the engine re-runs its confined round trip (bambu-printer-mcp 1.1.90:
  // 14–22 s measured, and it waits up to 25 s for a busy engine), and a caller that gives up cancels it.
  const RECHECK_MS = 22_000;
  const deadlines = [];
  const rechecking = () => ({
    async connect() {}, async close() {},
    hasTool: name => [...CAD_TOOLS, ...LEGACY_TOOLS].includes(name),
    getTool: name => ({name, inputSchema: {type: 'object', properties: {bind_document: {type: 'boolean'}}}}),
    async callTool(name, _args, options = {}) {
      if (name !== 'cad_status') return text(name === 'fusion_mcp_new_design' ? {document_binding: 1, document_id: 'owned-token'} : {configured: true, connected: true});
      deadlines.push(options.timeoutMs);
      if (!(options.timeoutMs >= RECHECK_MS)) throw new Error(`cad_status timed out after ${options.timeoutMs} ms`);
      return cadStatus(true);
    },
  });
  // A change to a Blender-made model: no saved design, no project engine of its own.
  for (const kind of ['fit', 'copy']) assert.deepEqual(await chooseEngine({handoff, kind}, {client: rechecking}), {engine: 'code'}, kind);
  // The pass waits as long for cad_status as Settings' own row does.
  const settings = cadCalls(() => handoff, () => rechecking());
  assert.equal((await settings.status()).status.ready, true);
  assert.ok(deadlines.length >= 3 && deadlines.every(ms => ms === CAD_STATUS_TIMEOUT_MS), `one deadline for every cad_status read: ${deadlines}`);
});

test('a pass on one engine never resumes a session from another: a Blender attempt\'s next request on the code engine starts fresh (#609)', async () => {
  const root = await tempDir('touchup-resume-engine-');
  const previous = join(root, 'passes', 'pass', 'previous');
  await mkdir(join(previous, 'out', 'checkpoints'), {recursive: true});
  const invocations = [];
  const deps = ready => ({
    lockPath: join(root, 'blender.lock'), fusionLockPath: join(root, 'fusion.lock'), codeLockPath: join(root, 'code.lock'),
    ensureBlender: async () => {}, resetScene: async () => {},
    client: bridge({cad_status: cadStatus(ready)}, [...CAD_TOOLS, ...LEGACY_TOOLS]).client,
    guidance: async () => ({design: 'D', slicing: 'S', cad: 'MCP CAD PROMPT'}),
    run: async (inv, pass) => { invocations.push(inv); return {status: 'done', sessionId: 'new', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  const request = resume => ({root, objectId: 'pass', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hanger', note: 'Use the new design engine so that this comes with the under desk screw', kind: 'fit', resume});
  // The Blender attempt stopped at a limit; the code engine is ready now.
  const moved = await runTouchup(request({sessionId: 'blender-session', passDir: previous, engine: 'blender'}), deps(true));
  assert.equal(moved.engine, 'code');
  const cold = invocations.at(-1);
  assert.equal(cold.args.includes('--resume'), false, 'a code pass never continues a Blender session');
  assert.doesNotMatch(cold.args.at(-1), /Continue from where you stopped/);
  assert.match(cold.args.at(-1), /Use the new design engine so that this comes with the under desk screw/, 'the new request still reaches the worker');
  assert.equal(moved.resume, undefined);
  // The same engine still continues its own session, and a pass saved before passes recorded their engine does too.
  for (const resume of [{sessionId: 'blender-session', passDir: previous, engine: 'blender'}, {sessionId: 'blender-session', passDir: previous}]) {
    const same = await runTouchup(request(resume), deps(false));
    assert.equal(same.engine, 'blender');
    assert.deepEqual(invocations.at(-1).args.slice(invocations.at(-1).args.indexOf('--resume'), invocations.at(-1).args.indexOf('--resume') + 2), ['--resume', 'blender-session']);
    assert.match(invocations.at(-1).args.at(-1), /Continue from where you stopped/);
  }
});

test('a pass offers only its own engine\'s tools and says which engine it is on: no cad_* outside a code pass (#609)', async () => {
  const root = await tempDir('touchup-engine-tools-');
  const pass = await prepareTouchupPass({root: join(root, 'passes'), objectId: 'pass', scan: [], photos: [], requirePhotos: false});
  const printer = {command: '/usr/bin/node', args: ['/mcp/index.js']};
  const disallowed = inv => inv.args[inv.args.indexOf('--disallowedTools') + 1];
  const rules = inv => inv.args[inv.args.indexOf('--append-system-prompt') + 1];
  // Nov 11: a Blender pass ran cad_setup twice and about twenty cad_run calls hunting for a folder the engine
  // would write to. A pass on Blender or Fusion has no cad_* tools at all (Claude Code 2.1.322 drops them from the tool list).
  const blender = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'fit', instructions: 'A hanger'});
  assert.equal(disallowed(blender), 'mcp__printer__cad_*,mcp__printer__fusion_mcp_*', 'nor Fusion\'s, unbound and without its lock');
  assert.match(rules(blender), /This pass runs on Blender/);
  const fusion = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'fit', engine: 'fusion', documentId: 'doc', handoff, instructions: 'A hanger'});
  assert.equal(disallowed(fusion), 'mcp__printer__cad_*,mcp__printer__blender_mcp_*');
  assert.match(rules(fusion), /This pass runs on Fusion/);
  const located = buildTouchupInvocation({pass, printer, claudePath: '/c', locate: true});
  assert.equal(disallowed(located), 'mcp__printer__cad_*,mcp__printer__fusion_mcp_*');
  // A code pass has the code engine's tools and its design folder, and none of Blender's or Fusion's.
  const code = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'fit', engine: 'code', instructions: 'A hanger', guidance: {design: 'D', slicing: 'S', cad: 'MCP CAD PROMPT'}});
  assert.equal(disallowed(code), 'mcp__printer__blender_mcp_*,mcp__printer__fusion_mcp_*');
  assert.match(rules(code), /This pass runs on the printer MCP's code design engine/);
  assert.match(code.args.at(-1), /- Design folder \(output_dir for every cad_run\): /);
  assert.equal(code.args.some(arg => arg.includes('mcp__printer__cad_')), false);
  // A resumed attempt whose session is gone starts cold with the same tools.
  const runs = [];
  const result = await runTouchup({root, objectId: 'pass', scan: [], photos: [], handoff, claudePath: '/c', instructions: 'A hanger', note: 'Taller', kind: 'fit',
    resume: {sessionId: 'gone', passDir: pass.dir, engine: 'blender'}}, {
    lockPath: join(root, 'blender.lock'), fusionLockPath: join(root, 'fusion.lock'), ensureBlender: async () => {}, resetScene: async () => {},
    client: bridge({}, LEGACY_TOOLS).client, guidance: async () => ({design: 'D', slicing: 'S'}),
    run: async (inv, made) => { runs.push(inv.args); return runs.length === 1
      ? {status: 'failed', resumeUnavailable: true, renders: [], checkpoints: [], stats: {seconds: 0, toolCalls: 0}}
      : {status: 'done', model: join(made.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; },
  });
  assert.equal(result.resume?.outcome, 'cold-start');
  assert.equal(runs[1].includes('--resume'), false);
  assert.equal(runs[1][runs[1].indexOf('--disallowedTools') + 1], 'mcp__printer__cad_*,mcp__printer__fusion_mcp_*');
});

test('the composed rules for a code pass: the MCP\'s cad_design prompt plus only Counterpart\'s own sections, with no Blender, Fusion or script-format words', () => {
  const guidance = {design: 'MCP DESIGN GUIDANCE', slicing: 'MCP SLICING GUIDANCE', cad: 'MCP CAD PROMPT'};
  const fit = systemRules({kind: 'fit', engine: 'code', request: true}, guidance);
  const copy = systemRules({kind: 'copy', engine: 'code'}, guidance);
  for (const [name, rules] of [['fit', fit], ['copy', copy]]) {
    assert.match(rules, /cad_design/, name);
    assert.ok(rules.includes('MCP CAD PROMPT'), `${name}: the MCP's own engine prompt is included as served`);
    assert.ok(rules.indexOf('MCP CAD PROMPT') < rules.indexOf('MCP DESIGN GUIDANCE'), `${name}: the engine prompt comes before the manufacturing guidance`);
    assert.doesNotMatch(rules, /Blender|blender_mcp|fusion_mcp|Fusion/, `${name}: no other engine is named`);
    // What the script looks like and which libraries it uses is the MCP's to say (AGENTS.md: the app staples onto the MCPs).
    assert.doesNotMatch(rules.replace('MCP CAD PROMPT', ''), /build123d|trimesh|manifold|load_scan|def build|\bP = \{|numpy|scipy|\.py\b/, `${name}: no script-format knowledge`);
    assert.doesNotMatch(rules, /\(01\.stl, 02\.stl/, `${name}: Counterpart keeps every run as a checkpoint itself`);
    assert.match(rules, /mark the run of the whole model you select as the result so far final/, `${name}: the worker marks the selected run final`);
    assert.match(rules, /Never mark final a run that measures or prepares the scan/, `${name}: measuring runs never become the model`);
    assert.match(rules, /orientation the object is used in/, `${name}: exported as it is used`);
  }
  assert.ok(fit.includes(RULE_SECTIONS.newDesign) && fit.includes(RULE_SECTIONS.fitSizes));
  assert.equal(fit.includes(RULE_SECTIONS.captured), false);
  assert.match(fit, /cad_check_fit/, 'a fit can check itself against the scan');
  assert.doesNotMatch(fit, /out\/touched\.stl/, 'a code worker writes no files itself: the touched run is the whole model');
  assert.match(fit, /counterpart_make_3mf into out\/touched\.3mf/, 'several colours still combine into the 3MF');
  assert.match(systemRules({kind: 'fit', request: true}), /Still export the whole model to out\/touched\.stl\./);
  // How to prepare the reference and that a fit check never resizes a measured interface are the MCP's (cad_design).
  assert.doesNotMatch(fit.replace('MCP CAD PROMPT', ''), /never rescale|as information|never to choose a size/i, 'no sentence duplicates the MCP\'s cad_design prompt');
  // The captured-object rules stay Counterpart's, and apply to a code cleanup pass.
  assert.ok(copy.includes(RULE_SECTIONS.captured));
  assert.match(copy, /First say what the object is/);
  assert.match(copy, /tagged assumed, or estimated with toleranceMm/);
  assert.match(copy, /Organic and handmade surfaces/);
  // Without the code engine the rules are what they were.
  assert.match(systemRules({kind: 'copy'}), /Use Blender's existing sculpt, modelling and modifier tools/);
  assert.match(systemRules({kind: 'copy'}), /\(01\.stl, 02\.stl, …\)/);
});

test('a code cleanup pass names the converted scan with its units and up axis, and the MCP may write only inside the project\'s passes', async () => {
  const root = await tempDir('touchup-code-inv-');
  const source = join(root, 'source');
  await mkdir(source, {recursive: true});
  for (const name of ['mesh.obj', 'mesh.mtl', 'mesh_basecolor_0.png']) await writeFile(join(source, name), name);
  const pass = await prepareTouchupPass({root: join(root, 'passes'), objectId: 'pass', scan: ['mesh.obj', 'mesh.mtl', 'mesh_basecolor_0.png'].map(name => join(source, name)), photos: [], requirePhotos: false});
  const printer = {command: '/usr/bin/node', args: ['/mcp/index.js'], env: {CAD_OUTPUT_DIRS: '/users/own/designs', BAMBU_TOKEN: 'secret'}};
  const inv = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'copy', engine: 'code', scanFrame: {unitMetres: 1, upAxis: 'Y'},
    guidance: {design: 'D', slicing: 'S', cad: 'MCP CAD PROMPT'}});
  const prompt = inv.args.at(-1);
  assert.match(prompt, /- Scan: .*mesh\.obj, .*mesh\.mtl, .*mesh_basecolor_0\.png/);
  assert.match(prompt, /1 unit is 1 metre and \+Y is up/);
  assert.match(prompt, new RegExp(`- Design folder \\(output_dir for every cad_run\\): ${join(pass.dir, 'cad').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(prompt, /Checkpoints folder/, 'every cad_run is a checkpoint; Counterpart files them');
  assert.doesNotMatch(prompt, /get_stl_info/);
  const env = inv.mcpConfig.mcpServers.printer.env;
  assert.equal(env.CAD_OUTPUT_DIRS, ['/users/own/designs', join(root, 'passes', 'pass')].join(':'), 'the person\'s own roots stay, and this project\'s passes are added');
  assert.equal(env.BAMBU_TOKEN, 'secret', 'the printer MCP is otherwise unchanged');
  // A pass on today's engines writes no CAD roots.
  const blender = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'copy'});
  assert.equal(blender.mcpConfig.mcpServers.printer.env.CAD_OUTPUT_DIRS, '/users/own/designs');
  // A change to a code design starts from its saved script and parameters.
  const change = buildTouchupInvocation({pass, printer, claudePath: '/c', kind: 'fit', engine: 'code', instructions: 'A holder', note: 'Make it 1 mm taller', currentModel: true,
    design: {script: join(pass.dir, 'design', 'touched.py'), parameters: join(pass.dir, 'design', 'touched.parameters.json')}});
  assert.match(change.args.at(-1), new RegExp(`The current design is a code design: ${join(pass.dir, 'design', 'touched.py').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(its parameters: .*touched\\.parameters\\.json\\)`));
  assert.match(change.args.at(-1), /cad_design prompt says for an edit/);
});

test('a code pass never touches Blender or Fusion: it converts the capture, reads cad_design, and a change starts from the saved design', async () => {
  const {readFile} = await import('node:fs/promises');
  const root = await tempDir('touchup-code-pass-');
  const usdz = join(root, 'scan.usdz');
  await writeFile(usdz, 'usdz');
  const ready = bridge({cad_status: cadStatus(true)}, [...CAD_TOOLS, ...LEGACY_TOOLS]);
  const log = [], stages = [];
  const deps = {
    lockPath: join(root, 'blender.lock'), fusionLockPath: join(root, 'fusion.lock'), codeLockPath: join(root, 'code.lock'),
    ensureBlender: async () => { log.push('ensureBlender'); }, resetScene: async () => { log.push('resetScene'); },
    client: ready.client,
    convertCapture: async (source, out) => {
      log.push(`convert ${source.split('/').at(-1)}`);
      const files = [];
      for (const name of ['mesh.obj', 'mesh.mtl', 'mesh_basecolor_0.png']) { await writeFile(join(out, name), name); files.push(join(out, name)); }
      return {files, frame: {unitMetres: 1, upAxis: 'Y'}};
    },
    guidance: async () => { log.push('guidance'); return {design: 'D', slicing: 'S', cad: 'MCP CAD PROMPT'}; },
    run: async (inv, pass) => {
      log.push('run');
      const rules = inv.args[inv.args.indexOf('--append-system-prompt') + 1];
      assert.ok(rules.includes('MCP CAD PROMPT'));
      assert.doesNotMatch(rules, /Blender/);
      assert.match(inv.args.at(-1), /mesh\.obj.*1 unit is 1 metre and \+Y is up/);
      assert.doesNotMatch(inv.args.at(-1), /scan\.usdz/, 'the worker gets the converted mesh, which the engine can read');
      assert.equal(inv.engine, 'code');
      return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}};
    },
  };
  const result = await runTouchup({root, objectId: 'obj', scan: [usdz], photos: [], handoff, claudePath: '/c', instructions: 'Clean it up', kind: 'copy',
    onStage: (stage, engine) => stages.push([stage, engine])}, deps);
  assert.equal(result.engine, 'code');
  assert.deepEqual(log, ['convert scan.usdz', 'guidance', 'run'], 'no Blender launch or scene reset');
  assert.deepEqual(stages, [['preparing', 'code'], ['working', 'code']]);
  assert.equal(ready.calls.some(call => call.name.startsWith('fusion_') || call.name.startsWith('blender_')), false);

  // An MCP that has the engine but serves no cad_design prompt is one to update: nothing runs.
  log.length = 0;
  const noPrompt = await runTouchup({root, objectId: 'obj', scan: [usdz], photos: [], handoff, claudePath: '/c', instructions: 'Clean it up', kind: 'copy'},
    {...deps, guidance: async () => ({design: 'D', slicing: 'S'})});
  assert.equal(noPrompt.status, 'failed');
  assert.match(noPrompt.reason, /^Update bambu-printer-mcp in Settings → Printers/);
  assert.equal(log.includes('run'), false);

  // A scan the converter can't read: today's engine cleans it up, and the pass says why.
  log.length = 0;
  const unreadable = await runTouchup({root, objectId: 'obj', scan: [usdz], photos: [], handoff, claudePath: '/c', instructions: 'Clean it up', kind: 'copy'},
    {...deps, convertCapture: async () => { throw new Error('Capture conversion failed or was unqualified'); },
      run: async (inv, pass) => { log.push('run'); assert.equal(inv.engine, 'blender'); return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}}; }});
  assert.equal(unreadable.engine, 'blender');
  assert.match(unreadable.note, /couldn't read this scan/);
  assert.deepEqual(log, ['ensureBlender', 'resetScene', 'guidance', 'run']);

  // A change to a code design: its script, parameters and input snapshots are copied into the pass, and the
  // copy's inputs list points at the copies (the saved design itself is never written to).
  const saved = join(root, 'project', 'current', 'design');
  await mkdir(join(saved, 'inputs'), {recursive: true});
  await writeFile(join(saved, 'touched.py'), 'script');
  await writeFile(join(saved, 'touched.parameters.json'), '{"cup_h":70}');
  await writeFile(join(saved, 'inputs', 'mesh.obj'), 'mesh');
  await writeFile(join(saved, 'touched.inputs.json'), JSON.stringify({scan: join(saved, 'inputs', 'mesh.obj')}));
  const model = join(root, 'model.stl');
  await writeFile(model, 'solid x\nendsolid x\n');
  let copied;
  await runTouchup({root, objectId: 'obj', scan: [model], photos: [], handoff, claudePath: '/c', instructions: 'A holder', note: 'Make it 1 mm taller', currentModel: true, kind: 'fit',
    design: {script: join(saved, 'touched.py'), parameters: join(saved, 'touched.parameters.json'), inputs: join(saved, 'touched.inputs.json')}},
  {...deps, run: async (inv, pass) => {
    const design = join(pass.dir, 'design');
    copied = {script: await readFile(join(design, 'touched.py'), 'utf8'), parameters: await readFile(join(design, 'touched.parameters.json'), 'utf8'),
      inputs: JSON.parse(await readFile(join(design, 'touched.inputs.json'), 'utf8')), mesh: await readFile(join(design, 'inputs', 'mesh.obj'), 'utf8')};
    assert.deepEqual(copied.inputs, {scan: join(design, 'inputs', 'mesh.obj')});
    assert.match(inv.args.at(-1), new RegExp(`code design: ${join(design, 'touched.py').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    return {status: 'done', model: join(pass.outDir, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}};
  }});
  assert.deepEqual({...copied, inputs: undefined}, {script: 'script', parameters: '{"cup_h":70}', inputs: undefined, mesh: 'mesh'});
  assert.equal(await readFile(join(saved, 'touched.inputs.json'), 'utf8'), JSON.stringify({scan: join(saved, 'inputs', 'mesh.obj')}));
});
