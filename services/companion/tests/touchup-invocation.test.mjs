import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir, userInfo} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {buildTouchupInvocation, TOUCHUP_RESULT_SCHEMA, TOUCHUP_SYSTEM_RULES, TOUCHUP_INSTRUCTION} from '../dist/touchup/invocation.js';

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
  assert.equal(valueOf(inv.args, '--tools'), 'Read');
  assert.equal(valueOf(inv.args, '--allowedTools'), 'Read,mcp__printer');
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
    note: 'you missed the clip on the side', summary: 'Added texture to the base.'});
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
