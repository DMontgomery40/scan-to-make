import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, realpath, rm, chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

/** A login shell whose PATH is `path`, running the agent's own command (`-ilc <script>`) after `before`. */
async function fakeShell(root, path, before = '') {
  const shell = join(root, 'fake-shell');
  await writeFile(shell, `#!/bin/sh\nPATH='${path}'; export PATH\nexec /bin/sh -c "${before}$2"\n`);
  await chmod(shell, 0o755);
  return shell;
}
async function fakeClaude(path) {
  await mkdir(join(path, '..'), {recursive:true});
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o755);
  return path;
}

async function runAgent(t, workerEnvironment = {}, configuration = '', prepare = async () => ({})) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stm-runtime-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  const resources = join(root, 'Resources');
  const state = join(root, 'private state');
  const server = join(resources, 'Payload/source/services/companion/dist');
  await mkdir(server, {recursive:true});
  await mkdir(state);
  await copyFile(new URL('../Resources/agent.mjs', import.meta.url), join(resources, 'agent.mjs'));
  await writeFile(join(state, 'app-agent-enabled'), '');
  await writeFile(join(state, 'app-migration.json'), JSON.stringify({workerEnvironment}));
  if (configuration) await writeFile(join(state, 'companion.env'), configuration);
  await writeFile(join(server, 'server-cli.js'), `
    require('node:fs').writeFileSync(require('node:path').join(process.env.STM_STATE, 'receipt.json'),
      JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        key.startsWith('SCAN_TO_MAKE_') || key === 'BLENDER'))));
  `);
  // Hermetic: this Mac's own HOME, login shell and Claude never leak into the result.
  const home = join(root, 'home');
  await mkdir(home);
  const extra = {SHELL:await fakeShell(root, join(root, 'empty')), ...await prepare({root, home})};
  const result = spawnSync(process.execPath, [join(resources, 'agent.mjs'), 'serve'], {
    env:{STM_STATE:state, PATH:process.env.PATH, HOME:home, ...extra}, timeout:10000, encoding:'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return {env:JSON.parse(await readFile(join(state, 'receipt.json'), 'utf8')), resources, state, root, home};
}

test('fresh agent uses bundled Python without inventing optional worker paths', async t => {
  const {env, resources, state} = await runAgent(t);
  assert.equal(env.SCAN_TO_MAKE_CAPTURE_PYTHON, join(resources, 'Payload/python/bin/python3'));
  assert.equal(env.SCAN_TO_MAKE_CAPTURE_DIR, join(state, 'capture'));
  assert.equal(env.SCAN_TO_MAKE_SCAN_REPAIR_TOOL, undefined);
  assert.equal(env.SCAN_TO_MAKE_SCAN_BLENDER, undefined);
});

test('app-owned printer runtime cannot be redirected by retained companion.env', async t => {
  const {env}=await runAgent(t,{},'SCAN_TO_MAKE_PRINTER_NODE=/opt/homebrew/bin/node\n');
  assert.equal(env.SCAN_TO_MAKE_PRINTER_NODE,process.execPath);
});

test('migrated agent preserves external worker executables and Python', async t => {
  const paths = {
    SCAN_TO_MAKE_CAPTURE_PYTHON:'/external worker/.venv/bin/python3',
    SCAN_TO_MAKE_SCAN_REPAIR_TOOL:'/external worker/repair.py',
    SCAN_TO_MAKE_SCAN_CORRECT_TOOL:'/external worker/correct.py',
    SCAN_TO_MAKE_SCAN_BLENDER:'/Applications/Blender.app/Contents/MacOS/Blender',
    BLENDER:'/Applications/Blender.app/Contents/MacOS/Blender',
  };
  const {env} = await runAgent(t, paths);
  for (const [key, value] of Object.entries(paths)) assert.equal(env[key], value);
});

test('explicit companion configuration overrides migrated worker paths', async t => {
  const {env} = await runAgent(t, {
    SCAN_TO_MAKE_CAPTURE_PYTHON:'/old/python3', SCAN_TO_MAKE_SCAN_REPAIR_TOOL:'/old/repair.py',
  }, 'SCAN_TO_MAKE_CAPTURE_PYTHON=/chosen/python3\nSCAN_TO_MAKE_SCAN_REPAIR_TOOL=/chosen/repair.py\n');
  assert.equal(env.SCAN_TO_MAKE_CAPTURE_PYTHON, '/chosen/python3');
  assert.equal(env.SCAN_TO_MAKE_SCAN_REPAIR_TOOL, '/chosen/repair.py');
});

test('objects get the Claude Code the user runs in their login shell', async t => {
  let claude;
  const {env} = await runAgent(t, {}, '', async ({root, home}) => {
    claude = await fakeClaude(join(root, 'shell bin/claude'));
    await fakeClaude(join(home, '.local/bin/claude'));
    return {SHELL:await fakeShell(root, join(root, 'shell bin'))};
  });
  assert.equal(env.SCAN_TO_MAKE_CLAUDE_PATH, claude, 'the shell decides which installed claude is the user\'s');
});

for (const place of ['.local/bin/claude', '.claude/local/claude']) {
  test(`objects find Claude Code in ~/${place} when the login shell has none`, async t => {
    let claude;
    const {env} = await runAgent(t, {}, '', async ({root, home}) => {
      claude = await fakeClaude(join(home, place));
      // An alias is not a path the companion can run.
      return {SHELL:await fakeShell(root, join(root, 'empty'), "alias claude='npx claude'; ")};
    });
    assert.equal(env.SCAN_TO_MAKE_CLAUDE_PATH, claude);
  });
}

test('an explicit absolute Claude path wins; a relative one is never passed on', async t => {
  const chosen = await runAgent(t, {}, 'SCAN_TO_MAKE_CLAUDE_PATH=/chosen/claude\n', async ({home}) => {
    await fakeClaude(join(home, '.local/bin/claude'));
    return {};
  });
  assert.equal(chosen.env.SCAN_TO_MAKE_CLAUDE_PATH, '/chosen/claude');
  const relative = await runAgent(t, {}, 'SCAN_TO_MAKE_CLAUDE_PATH=claude\n', async ({home}) => {
    await fakeClaude(join(home, '.local/bin/claude'));
    return {};
  });
  assert.equal(relative.env.SCAN_TO_MAKE_CLAUDE_PATH, join(relative.home, '.local/bin/claude'));
});

test('without Claude Code installed, objects stay off instead of getting a broken path', async t => {
  if (['/opt/homebrew/bin/claude', '/usr/local/bin/claude'].some(path => existsSync(path))) {
    t.skip('this Mac has a system-wide claude');
    return;
  }
  const {env} = await runAgent(t);
  assert.equal(env.SCAN_TO_MAKE_CLAUDE_PATH, undefined);
});

for (const transport of ['tailscale', undefined, 'lan']) {
  test(`bundled pairing preserves the retained ${transport ?? 'default Tailscale'} login`, async t => {
    const {resources, state} = await runAgent(t);
    const auth = join(state, 'auth');
    await mkdir(auth);
    const bytes = JSON.stringify({version:2, configuration:{transport, allowedLogins:['owner@example.test', 'other@example.test']}});
    await writeFile(join(auth, 'auth.json'), bytes);
    // Exercise the actual app-owned agent invocation, including the CLI boundary.
    await writeFile(join(resources, 'Payload/source/services/companion/dist/remote-auth-cli.js'), `
      const args = process.argv.slice(2);
      const expected = ${JSON.stringify(transport === 'lan' ? [] : ['owner@example.test'])};
      require('node:assert/strict').deepEqual(args, ['pair-capture-and-printer-handoff', process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR, ...expected]);
      process.stdout.write(JSON.stringify({accepted:true}));
    `);
    const result = spawnSync(process.execPath, [join(resources, 'agent.mjs'), 'pair-capture-and-printer-handoff'], {
      env:{STM_STATE:state, PATH:process.env.PATH}, timeout:5000, encoding:'utf8',
    });
    assert.equal(result.status, 0, 'bundled pairing must supply the retained transport login');
    assert.deepEqual(JSON.parse(result.stdout), {accepted:true});
    assert.equal(result.stderr, '');
    assert.equal(await readFile(join(auth, 'auth.json'), 'utf8'), bytes);
  });
}

test('pairing activity uses the selected module and private stdin without printing the code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stm-pairing-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const module = join(root, 'selected auth module.mjs');
  const code = 'a'.repeat(32);
  await writeFile(module, `
    import {readFile} from 'node:fs/promises';
    export class RemoteAuthStore {
      static async open(directory) {
        const state = JSON.parse(await readFile(directory + '/state.json','utf8'));
        return {isPairingActive: async code => code === state.code};
      }
    }
  `);
  const run = input => spawnSync(process.execPath, [
    new URL('../Resources/pairing-active.mjs', import.meta.url).pathname, module, root,
  ], {input, encoding:'utf8', timeout:5000});
  await writeFile(join(root,'state.json'),JSON.stringify({code}));
  const payload = `scantomake://pair?v=1&c=${code}`;
  const active = run(payload);
  assert.equal(active.status,0);
  assert.equal(active.stdout,'true');
  assert.equal(active.stderr,'');
  await writeFile(join(root,'state.json'),JSON.stringify({code:null}));
  const consumed = run(payload);
  assert.equal(consumed.status,0);
  assert.equal(consumed.stdout,'false');
  assert.equal(consumed.stderr,'');
  const invalid = run('invalid-secret-fixture');
  assert.equal(invalid.status,1);
  assert.equal(invalid.stdout,'');
  assert.equal(invalid.stderr,'');
});
