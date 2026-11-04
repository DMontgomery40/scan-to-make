import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir, userInfo} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {buildTouchupInvocation, systemRules, TOUCHUP_RESULT_SCHEMA, TOUCHUP_SYSTEM_RULES, TOUCHUP_INSTRUCTION} from '../dist/touchup/invocation.js';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
async function pass() {
  const root = await mkdtemp(join(tmpdir(), 'touchup-inv-'));
  return prepareTouchupPass({root, objectId: 'obj', scan: [join(fixtures, 'scan.obj')], photos: [join(fixtures, 'photo.jpg')]});
}
const printer = {command: '/usr/bin/ssh', args: ['-T', 'x@127.0.0.1'], env: {MCP_TRANSPORT: 'stdio'}};
const sourceEnv = {HOME: '/Users/x', USER: 'x', PATH: '/usr/bin:/bin', BAMBU_TOKEN: 'printer-secret', ANTHROPIC_API_KEY: 'sk-secret'};
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

test('args are exactly the lean worker', async () => {
  const p = await pass();
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/usr/local/bin/claude', sourceEnv});
  assert.equal(inv.command, '/usr/local/bin/claude');
  for (const flag of ['-p', '--strict-mcp-config', '--disable-slash-commands', '--verbose']) assert.ok(inv.args.includes(flag), flag);
  assert.equal(valueOf(inv.args, '--model'), 'claude-opus-5-5');
  assert.equal(valueOf(inv.args, '--effort'), 'high');
  assert.equal(valueOf(inv.args, '--mcp-config'), inv.mcpConfigPath);
  assert.equal(valueOf(inv.args, '--tools'), 'Read,WebSearch,WebFetch');
  assert.equal(valueOf(inv.args, '--allowedTools'), 'Read,WebSearch,WebFetch,mcp__printer');
  assert.equal(valueOf(inv.args, '--output-format'), 'stream-json');
  assert.equal(valueOf(inv.args, '--json-schema'), JSON.stringify(TOUCHUP_RESULT_SCHEMA));
  assert.equal(valueOf(inv.args, '--settings'), '{"disableAllHooks":true}');
  assert.equal(valueOf(inv.args, '--append-system-prompt'), TOUCHUP_SYSTEM_RULES);
  assert.equal(inv.args.includes('--resume'), false);
  assert.ok(inv.args.at(-1).startsWith(TOUCHUP_INSTRUCTION + '\n'));
});

test('env is the allowlist plus isolation', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.equal(inv.env.HOME, '/Users/x');
  assert.equal(inv.env.USER, 'x');
  assert.equal(inv.env.PATH, '/usr/bin:/bin');
  assert.equal(inv.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(inv.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal('BAMBU_TOKEN' in inv.env, false);
  assert.equal('ANTHROPIC_API_KEY' in inv.env, false);
});

test('a launchd-style env without USER still gets the signed-in user', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv: {HOME: '/Users/x', PATH: '/usr/bin'}});
  assert.equal(inv.env.USER, userInfo().username);
  assert.equal(inv.env.LOGNAME, userInfo().username);
});

test('printer MCP is passed through unchanged', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.deepEqual(Object.keys(inv.mcpConfig.mcpServers), ['printer']);
  assert.deepEqual(inv.mcpConfig.mcpServers.printer, {command: '/usr/bin/ssh', args: ['-T', 'x@127.0.0.1'], env: {MCP_TRANSPORT: 'stdio'}});
  assert.deepEqual(JSON.parse(await readFile(inv.mcpConfigPath, 'utf8')), inv.mcpConfig);
});

test('a printer MCP working directory is honoured through a quoted shell wrapper', async () => {
  const cwd = await mkdtemp(join(tmpdir(), "printer mcp's dir "));
  const inv = buildTouchupInvocation({pass: await pass(), printer: {command: '/bin/pwd', args: [], cwd}, claudePath: '/c', sourceEnv});
  const server = inv.mcpConfig.mcpServers.printer;
  assert.equal(server.command, '/bin/sh');
  assert.equal(server.args[0], '-c');
  const printed = execFileSync(server.command, server.args).toString().trim();
  assert.equal(execFileSync('/bin/realpath', [printed]).toString().trim(), execFileSync('/bin/realpath', [cwd]).toString().trim());
});

test('correction prompt never resumes', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv,
    note: 'you missed the clip on the side', summary: 'Added texture to the base.', currentModel: true});
  const prompt = inv.args.at(-1);
  assert.ok(prompt.startsWith('This is the current model. Added texture to the base.\n\nChange requested: you missed the clip on the side'));
  assert.equal(inv.args.includes('--resume'), false);
});

test('cwd is the pass dir', async () => {
  const p = await pass();
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv});
  assert.equal(inv.cwd, p.dir);
  assert.ok(inv.mcpConfigPath.startsWith(p.dir + '/'));
  const prompt = inv.args.at(-1);
  for (const path of [...p.scanPaths, p.checkpointsDir, p.outDir]) assert.ok(prompt.includes(path), path);
  assert.ok(prompt.includes(join(p.photosDir, 'photo-01.jpg')));
});

test('the user\'s instructions are the prompt, word for word', async () => {
  const p = await pass();
  const instructions = 'A clip that holds my mic on the monitor arm. The arm tube is 30 mm across.';
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv, instructions});
  assert.ok(inv.args.at(-1).startsWith(instructions + '\n'));
  assert.equal(inv.args.at(-1).includes(TOUCHUP_INSTRUCTION), false);
});

test('a pass with no scan and no photos lists neither', async () => {
  const root = await mkdtemp(join(tmpdir(), 'touchup-inv-'));
  const p = await prepareTouchupPass({root, objectId: 'mount', scan: [], photos: [], requirePhotos: false});
  const prompt = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv, instructions: 'A hook.'}).args.at(-1);
  assert.equal(prompt.includes('- Scan:'), false);
  assert.equal(prompt.includes('- Photos:'), false);
  assert.ok(prompt.includes('- Output folder:'));
});

test('every STL the worker saves is in millimetres', () => {
  assert.match(TOUCHUP_SYSTEM_RULES, /millimetres/);
  assert.match(TOUCHUP_SYSTEM_RULES, /metres/);
});

test('the rules ask for the fixes the photos show, not just caution', () => {
  assert.match(TOUCHUP_SYSTEM_RULES, /flatten/);
  assert.match(TOUCHUP_SYSTEM_RULES, /too faint/);
  assert.match(TOUCHUP_SYSTEM_RULES, /Keep real surface detail the photos confirm/);
  assert.equal(/never smooth captured surface/.test(TOUCHUP_SYSTEM_RULES), false, 'a lumpy surface the photos show flat must be fixable');
});

test('every pass plans how it prints, with the printer MCP\'s own fdm_design guidance, for copies and new designs alike', async () => {
  const guidance = 'Design the finished object the user wants, with the manufacturing plan as part of the design.';
  for (const engine of ['blender', 'fusion']) {
    const rules = systemRules(engine, guidance);
    assert.ok(rules.endsWith(`Manufacturing guidance from the printer MCP (its fdm_design prompt):\n${guidance}`), engine);
    assert.doesNotMatch(rules, /Don't do print preparation/, 'supports and orientation are design choices now');
    assert.match(rules, /captured objects and new designs alike/);
    assert.doesNotMatch(rules, /PRINTER_FACTS|ENGINE_RULES|ENGINE_NAME/, 'no placeholder survives');
    assert.match(rules, /largest flat face/, 'the worker knows the print step re-orients today');
    // A Fusion pass's proxy passes the printer's read-only tools through, so both engines read the same facts.
    assert.match(rules, /get_printer_filaments/);
    assert.match(rules, /slicer_result/);
    assert.doesNotMatch(systemRules(engine), /Manufacturing guidance from the printer MCP/, 'an MCP without the prompt adds nothing');
  }
  // Every provider reads the same rules from --append-system-prompt (project-worker.ts).
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv, guidance});
  assert.ok(valueOf(inv.args, '--append-system-prompt').endsWith(guidance));
  assert.equal(valueOf(buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv}).args, '--append-system-prompt'), TOUCHUP_SYSTEM_RULES);
});

test('the worker loads none of the user\'s personal Claude settings', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv});
  assert.equal(valueOf(inv.args, '--setting-sources'), '');
});

test('a correction keeps the original instructions and says the model is already in millimetres', async () => {
  const inv = buildTouchupInvocation({pass: await pass(), printer, claudePath: '/c', sourceEnv,
    instructions: 'A hook for a 25 mm handle.', note: 'make it 2 mm thicker', summary: 'Made the hook.', currentModel: true});
  const prompt = inv.args.at(-1);
  assert.ok(prompt.includes('A hook for a 25 mm handle.'));
  assert.ok(prompt.includes('Change requested: make it 2 mm thicker'));
  assert.match(prompt, /already in millimetres/);
});

test('the answer can report a failure', () => {
  assert.deepEqual(TOUCHUP_RESULT_SCHEMA.properties.status.enum, ['done', 'needs_closeup', 'failed']);
});

test('a revised request without a completed model uses original inputs without claiming millimetre STL units', async () => {
  const p = await pass();
  const prompt = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv,
    instructions: 'Copy this object.', note: 'The photos show the missing clip.'}).args.at(-1);
  assert.match(prompt, /No completed model is available yet/);
  assert.ok(prompt.includes('Original request: Copy this object.'));
  assert.ok(prompt.includes('Change requested: The photos show the missing clip.'));
  assert.equal(prompt.includes('already in millimetres'), false);
  assert.ok(prompt.includes(p.scanPaths[0]));
});

test('the worker works only with objects in its own scene', () => {
  assert.match(TOUCHUP_SYSTEM_RULES, /current scene/);
});

test('photo evidence lists overview pages first and every real filename, including PNG inputs', async () => {
  const p = await pass();
  p.photoPaths = [join(p.photosDir, 'photo-01.jpg'), join(p.photosDir, 'photo-02.png')];
  p.photoOverviewPaths = [join(p.photosDir, 'overview-01.jpg')];
  const inv = buildTouchupInvocation({pass: p, printer, claudePath: '/c', sourceEnv});
  const prompt = inv.args.at(-1);
  for (const path of [...p.photoOverviewPaths, ...p.photoPaths]) assert.ok(prompt.includes(path), path);
  assert.ok(prompt.indexOf(p.photoOverviewPaths[0]) < prompt.indexOf(p.photoPaths[0]));
  assert.equal(prompt.includes('…'), false, 'the worker can locate each actual extension rather than guessing a range');
});
