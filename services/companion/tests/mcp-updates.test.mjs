import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {runTouchup} from '../dist/touchup/touchup.js';
import {PrintGate} from '../dist/printing/print-gate.js';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveMcpInstall, shellCommand, forcedCommand, mcpIdFor, installedVersion, findNpm} from '../dist/printing/mcp-install.js';
import {McpUpdater, McpOverrides} from '../dist/printing/mcp-updates.js';

const HOME = '/Users/ada', APP = `${HOME}/Library/Application Support/Scan to Make`;
/** A fake Mac: files by path, directories implied, symlinks by realpath. */
function mac(files = {}, links = {}) {
  return {
    home: HOME, user: 'ada', appPrinters: `${APP}/printers`,
    readFile: path => files[path],
    // A staged npm install (`.counterpart-update-<uuid>`) has its package once npm ran.
    exists: path => path in files || (path in links && links[path] in files) || Object.keys(files).some(file => file.startsWith(path + '/')) || /\.counterpart-update-[0-9a-f-]+\/lib\/node_modules\/[^/]+\/package\.json$/.test(path),
    isDirectory: path => Object.keys(files).some(file => file.startsWith(path + '/')),
    realpath: path => links[path] ?? path,
  };
}
const bambu = (command, args = [], extra = {}) => ({backend: 'bambu-printer-mcp', process: {command, args, ...extra}});
const pkgJson = (version, name = 'bambu-printer-mcp') => JSON.stringify({name, version});

test('PRD §8.10: npx, a global npm prefix, the app\'s own copy and a git checkout are each recognised', () => {
  const env = mac({
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/package.json': pkgJson('1.1.44'),
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js': '',
    [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46'),
    [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`]: '',
    [`${HOME}/src/bambu-printer-mcp/package.json`]: pkgJson('1.2.0-dev'),
    [`${HOME}/src/bambu-printer-mcp/.git/HEAD`]: 'ref',
    [`${HOME}/src/bambu-printer-mcp/dist/index.js`]: '',
  }, {'/opt/homebrew/bin/bambu-printer-mcp': '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js'});
  assert.deepEqual(resolveMcpInstall(bambu('/usr/local/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']), env), {type: 'npx', pkg: 'bambu-printer-mcp', spec: 'bambu-printer-mcp@1.1.40', version: '1.1.40'});
  assert.deepEqual(resolveMcpInstall(bambu('npx', ['bambu-printer-mcp']), env), {type: 'npx', pkg: 'bambu-printer-mcp', spec: 'bambu-printer-mcp'});
  const global = resolveMcpInstall(bambu('/opt/homebrew/bin/bambu-printer-mcp'), env);
  assert.equal(global.type, 'global');
  assert.equal(global.prefix, '/opt/homebrew');
  assert.equal(installedVersion(global, env), '1.1.44');
  const viaNode = resolveMcpInstall(bambu('/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js']), env);
  assert.deepEqual([viaNode.type, viaNode.prefix, viaNode.node], ['global', '/opt/homebrew', '/opt/homebrew/bin/node']);
  const app = resolveMcpInstall(bambu('/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node', [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`]), env);
  assert.deepEqual([app.type, app.prefix], ['app', `${APP}/printers/bambu`]);
  const checkout = resolveMcpInstall(bambu('node', ['dist/index.js'], {cwd: `${HOME}/src/bambu-printer-mcp`}), env);
  assert.deepEqual([checkout.type, checkout.dir], ['checkout', `${HOME}/src/bambu-printer-mcp`]);
  assert.equal(installedVersion(checkout, env), '1.2.0-dev');
  // One install, one id: two printers on the same global copy share it.
  assert.equal(mcpIdFor(global, bambu('/opt/homebrew/bin/bambu-printer-mcp')), mcpIdFor(viaNode, bambu('x')));
  assert.notEqual(mcpIdFor(global, bambu('x')), mcpIdFor(app, bambu('x')));
});

test('a wrapped ssh profile resolves through its remote command or the key\'s forced command in authorized_keys', () => {
  // David's stopgap, with a fake key.
  const forced = `cd /Users/ada/bambu-printer-mcp && MCP_TRANSPORT=stdio TMPDIR='${APP}/printer-handoff/runtime-tmp' exec '/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node' '${APP}/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/dist/index.js'`;
  const authorized = `ssh-ed25519 AAAAother other@mac\nfrom="127.0.0.1,::1",restrict,command="${forced.replace(/"/g, '\\"')}" ssh-ed25519 AAAAstopgap printer@mac\n`;
  const env = mac({
    [`${HOME}/.ssh/authorized_keys`]: authorized,
    [`${HOME}/.ssh/printer_ed25519.pub`]: 'ssh-ed25519 AAAAstopgap printer@mac\n',
    [`${APP}/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46'),
  });
  const profile = bambu('/usr/bin/ssh', ['-T', '-i', `${HOME}/.ssh/printer_ed25519`, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', 'ada@127.0.0.1']);
  const install = resolveMcpInstall(profile, env);
  assert.equal(install.type, 'app');
  assert.equal(install.prefix, `${APP}/printers/bambu-1.1.46`);
  assert.deepEqual(install.via, {kind: 'ssh', host: '127.0.0.1', from: 'authorized-keys', cwd: '/Users/ada/bambu-printer-mcp',
    env: {MCP_TRANSPORT: 'stdio', TMPDIR: `${APP}/printer-handoff/runtime-tmp`}});
  assert.equal(installedVersion(install, env), '1.1.46');
  // An explicit remote command wins.
  const remote = resolveMcpInstall(bambu('/usr/bin/ssh', ['127.0.0.1', 'npx', '-y', 'bambu-printer-mcp@1.1.45']), env);
  assert.deepEqual([remote.type, remote.spec, remote.via.from], ['npx', 'bambu-printer-mcp@1.1.45', 'remote-command']);
  // What Counterpart can't resolve, it says in plain words.
  assert.match(resolveMcpInstall(bambu('/usr/bin/ssh', ['-i', `${HOME}/.ssh/missing`, '127.0.0.1']), env).found, /missing, whose \.pub file isn't there/);
  assert.match(resolveMcpInstall(bambu('/usr/bin/ssh', ['printer.local']), env).found, /on printer\.local over ssh/);
  assert.match(resolveMcpInstall(bambu('/usr/bin/ssh', ['-i', `${HOME}/.ssh/printer_ed25519`, 'other@127.0.0.1']), env).found, /another account/);
  assert.match(resolveMcpInstall(bambu('/opt/tools/printer-wrapper.sh'), env).found, /printer-wrapper\.sh, which isn't an install of bambu-printer-mcp/);
});

test('shell command lines: quotes, escapes, cd and variables', () => {
  assert.deepEqual(shellCommand(`cd "/a b" && FOO=1 BAR='x y' exec node "dist/index.js" --flag`), {argv: ['node', 'dist/index.js', '--flag'], cwd: '/a b', env: {FOO: '1', BAR: 'x y'}});
  assert.deepEqual(shellCommand('env A=1 /usr/bin/node a\\ b.js'), {argv: ['/usr/bin/node', 'a b.js'], env: {A: '1'}});
  assert.equal(forcedCommand('command="echo \\"hi\\"" ssh-ed25519 KEY c', 'ssh-ed25519 KEY'), 'echo "hi"');
  assert.equal(forcedCommand('# command="x" ssh-ed25519 KEY', 'ssh-ed25519 KEY'), undefined);
});

/** A scripted updater: commands are recorded, sessions are fakes, versions come from a fake registry. */
async function updater(t, {profile, profiles, files = {}, links = {}, busy = () => false, latest = '1.1.50', fail, gate, failRename, installed = {}, connectFail, postinstall, installOutput = ''} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-updates-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const env = mac({'/opt/homebrew/bin/npm': '', '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js': '', ...files}, {'/opt/homebrew/bin/npm': '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js', ...links});
  const readFile = env.readFile;
  env.readFile = path => {
    const staged = path.match(/\.counterpart-update-[0-9a-f-]+\/lib\/node_modules\/([^/]+)\/package\.json$/);
    return staged ? JSON.stringify({name: staged[1], version: latest, ...(postinstall ? {scripts: {postinstall}} : {})}) : readFile(path);
  };
  const commands = [], events = [], restarts = [], moves = [];
  let version = '1.1.46';
  const session = id => ({
    restart: async config => { restarts.push({id, ...config}); },
    connect: async () => { if (connectFail?.(id)) throw new Error('spawn ENOENT'); return {server: {name: 'bambu-printer-mcp', version}, tools: []}; },
  });
  const overrides = new McpOverrides(join(root, 'overrides.json'));
  await overrides.load();
  const updates = new McpUpdater({
    gate, fs: {rename: async (from, to) => { moves.push(['rename', from, to]); if (failRename && failRename(from, to)) throw new Error('EXDEV'); }, rm: async path => { moves.push(['rm', path]); }, mkdir: async () => undefined},
    destinations: () => profiles ?? [{id: 'p1s', config: profile}, {id: 'a1', config: profile}],
    env, overrides, session, busy: async id => busy(id), runningVersion: id => id in installed ? installed[id] : '1.1.46',
    emit: async event => { events.push(event); }, waitPollMs: 20, node: '/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node', path: '/usr/bin:/bin',
    run: async (command, args, options) => {
      commands.push([command, ...args, ...(options.cwd ? [`(in ${options.cwd})`] : [])].join(' '));
      if (args.includes('view')) { await new Promise(resolve => setTimeout(resolve, 5)); return {code: 0, output: `${latest}\n`}; }
      if (args.includes('rev-parse')) return {code: 0, output: 'abc123\n'};
      if (fail && (typeof fail === 'function' ? fail(args) : args.join(' ').includes(fail))) return {code: 1, output: 'npm ERR! network'};
      if (args.includes('install') || args.includes('pull')) version = latest;
      return {code: 0, output: args.includes('install') ? installOutput : ''};
    },
  });
  const done = () => until(() => events.some(event => event.type === 'mcp.update.done' || event.type === 'mcp.update.failed'));
  return {updates, commands, events, restarts, overrides, moves, done, mcpId: updates.mcpId('p1s')};
}
const until = async check => { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };

test('Update runs the matching update in that installation, restarts every session on it, and reports the new version', async t => {
  const prefix = `${APP}/printers/bambu-1.1.46`;
  const files = {[`${prefix}/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46'), [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]: ''};
  const node = '/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node';
  const f = await updater(t, {profile: bambu(node, [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]), files});
  assert.equal(f.updates.mcpId('a1'), f.mcpId, 'both printers share the install');
  const started = await f.updates.update(f.mcpId);
  assert.deepEqual(started, {mcpId: f.mcpId, state: 'started', fromVersion: '1.1.46', toVersion: '1.1.50'});
  await f.done();
  assert.equal(f.commands[0], '/opt/homebrew/bin/npm view bambu-printer-mcp version');
  // Installed beside the live copy, then swapped in: a failed install never touches what runs.
  const staging = f.commands[1].match(/--prefix (.+\/\.counterpart-update-[0-9a-f-]+) /)[1];
  assert.equal(f.commands[1], `${node} /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js install --global --prefix ${staging} --allow-scripts=bambu-printer-mcp --ignore-scripts=false --foreground-scripts bambu-printer-mcp@1.1.50`);
  assert.ok(staging.startsWith(`${prefix}/`));
  const live = `${prefix}/lib/node_modules/bambu-printer-mcp`;
  assert.deepEqual(f.moves, [['rename', live, `${staging}/previous`], ['rename', `${staging}/lib/node_modules/bambu-printer-mcp`, live], ['rm', staging]]);
  assert.deepEqual(f.events.map(event => event.type), ['mcp.update.started', 'mcp.update.done']);
  assert.deepEqual(f.events[1].data, {mcpId: f.mcpId, fromVersion: '1.1.46', toVersion: '1.1.50'});
  assert.equal(f.restarts.length, 2, 'every session on that install restarts');
  // Already current: nothing runs.
  const again = await updater(t, {profile: bambu(node, [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]), files, latest: '1.1.46'});
  assert.equal((await again.updates.update(again.mcpId)).state, 'current');
  assert.equal(again.commands.length, 1);
});

test('npx moves the profile to the latest version; a checkout pulls and builds, and refuses local changes', async t => {
  const npx = await updater(t, {profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40'])});
  await npx.updates.update(npx.mcpId);
  await npx.done();
  assert.equal(npx.commands.length, 1, 'only the version check; npx fetches on the next start');
  assert.deepEqual(npx.restarts[0].process.args, ['-y', 'bambu-printer-mcp@1.1.50']);
  assert.deepEqual((await npx.overrides.get('p1s')).args, ['-y', 'bambu-printer-mcp@1.1.50']);
  const dir = `${HOME}/src/bambu-printer-mcp`;
  const files = {[`${dir}/package.json`]: pkgJson('1.1.46'), [`${dir}/.git/HEAD`]: '', [`${dir}/dist/index.js`]: ''};
  const checkout = await updater(t, {profile: bambu('/opt/homebrew/bin/node', [`${dir}/dist/index.js`]), files});
  await checkout.updates.update(checkout.mcpId);
  await checkout.done();
  assert.deepEqual(checkout.commands.slice(1).map(line => line.replace(/ -c .*? sh /, ' -c … sh ')), [
    `/bin/sh -c … sh ${dir}`, `git -C ${dir} rev-parse HEAD`, `git -C ${dir} pull --ff-only`, `/opt/homebrew/bin/npm ci (in ${dir})`, `/opt/homebrew/bin/npm run build (in ${dir})`]);
  // A build that fails after the pull goes back to the commit that was running.
  const broken = await updater(t, {profile: bambu('/opt/homebrew/bin/node', [`${dir}/dist/index.js`]), files, fail: 'run build'});
  await broken.updates.update(broken.mcpId);
  await broken.done();
  assert.equal(broken.events.at(-1).type, 'mcp.update.failed');
  assert.deepEqual(broken.commands.slice(-3), [`git -C ${dir} reset --hard abc123`, `/opt/homebrew/bin/npm ci (in ${dir})`, `/opt/homebrew/bin/npm run build (in ${dir})`]);
  const dirty = await updater(t, {profile: bambu('/opt/homebrew/bin/node', [`${dir}/dist/index.js`]), files, fail: 'status --porcelain'});
  await dirty.updates.update(dirty.mcpId);
  await dirty.done();
  assert.equal(dirty.events.at(-1).type, 'mcp.update.failed');
  assert.equal(dirty.commands.length, 2, 'nothing after the local-changes check');
});

test('an install Counterpart can\'t resolve says what it found and offers a fresh copy; a failure keeps the old version', async t => {
  const f = await updater(t, {profile: bambu('/opt/tools/printer-wrapper.sh', [], {env: {BAMBU_SERIAL: 'S'}})});
  const unresolved = await f.updates.update(f.mcpId);
  assert.equal(unresolved.state, 'unresolved');
  assert.match(unresolved.found, /printer-wrapper\.sh/);
  assert.equal(f.commands.length, 0);
  await f.updates.update(f.mcpId, {fresh: true});
  await f.done();
  assert.ok(f.commands.at(-1).includes(`install --global --prefix ${APP}/printers/bambu/.counterpart-update-`) && f.commands.at(-1).endsWith(' bambu-printer-mcp@1.1.50'));
  const override = await f.overrides.get('p1s');
  assert.deepEqual(override.args, [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`]);
  assert.deepEqual(f.restarts[0].process.env, {BAMBU_SERIAL: 'S'}, 'the profile\'s own variables go with it');
  const failing = await updater(t, {profile: bambu('/opt/tools/printer-wrapper.sh'), fail: 'install'});
  await failing.updates.update(failing.mcpId, {fresh: true});
  await failing.done();
  const failed = failing.events.at(-1);
  assert.equal(failed.type, 'mcp.update.failed');
  assert.match(failed.data.log, /npm ERR! network/);
  assert.ok(Buffer.byteLength(failed.data.log) <= 4096);
  assert.equal(await failing.overrides.get('p1s'), undefined, 'the previous profile stays');
  assert.deepEqual(failing.moves.map(move => move[0]), ['rm'], 'nothing was swapped');
});

test('Update waits while a print on that printer is being prepared or monitored', async t => {
  let printing = true;
  const prefix = `${APP}/printers/bambu`;
  const f = await updater(t, {profile: bambu('/x/node', [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]),
    files: {[`${prefix}/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46')}, busy: id => id === 'a1' && printing});
  assert.equal((await f.updates.update(f.mcpId)).state, 'waiting');
  assert.equal((await f.updates.update(f.mcpId)).state, 'waiting', 'asking again reports the same update');
  assert.deepEqual(f.events.map(event => event.type), ['mcp.update.waiting']);
  assert.equal(f.commands.length, 1);
  printing = false;
  await until(() => f.events.some(event => event.type === 'mcp.update.done'));
  assert.equal(f.commands.length, 2);
});

test('npm is found beside the installation\'s node first, then on PATH and the usual places', () => {
  const env = mac({'/a/bin/npm': '', '/b/npm': '', '/opt/homebrew/bin/npm': ''});
  assert.equal(findNpm('/a/bin/node', env, '/b'), '/a/bin/npm');
  assert.equal(findNpm(undefined, env, '/b'), '/b/npm');
  assert.equal(findNpm(undefined, env, '/nowhere'), '/opt/homebrew/bin/npm');
});

test('the phone route, the Mac method, the capability flags, the printer list and the words agree', async t => {
  const {startCompanionServer} = await import('../dist/server.js');
  const {createControlDispatcher} = await import('../dist/local-control-services.js');
  const {McpUpdateError} = await import('../dist/printing/mcp-updates.js');
  const {PrinterDirectory} = await import('../dist/printing/directory.js');
  const {eventWords} = await import('../dist/events/words.js');
  const calls = [];
  const fake = {update: async (mcpId, options) => {
    calls.push([mcpId, options]);
    if (mcpId === 'mcp-0000000000000000') throw new McpUpdateError('not-found', 'No printer uses that MCP.');
    return {mcpId, state: 'started', fromVersion: '1.1.46', toVersion: '1.1.50'};
  }};
  const server = await startCompanionServer({port: 0, mcpUpdates: fake});
  t.after(() => server.close());
  const post = (path, body) => fetch(server.url + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const id = 'mcp-10cc07925221a48f';
  const ok = await post(`/v1/printers/mcp/${id}/update`, {fresh: true});
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {update: {mcpId: id, state: 'started', fromVersion: '1.1.46', toVersion: '1.1.50'}});
  assert.deepEqual(calls[0], [id, {fresh: true}]);
  assert.equal((await post('/v1/printers/mcp/mcp-0000000000000000/update', {})).status, 404);
  assert.equal((await post(`/v1/printers/mcp/${id}/update`, {fresh: 'yes'})).status, 400);
  assert.equal((await fetch(server.url + '/healthz')).status, 200);
  assert.equal((await (await fetch(server.url + '/healthz')).json()).capabilities.mcpUpdates, true);
  const dispatch = createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', mcpUpdates: fake});
  assert.deepEqual((await dispatch('printers.updateMcp', {mcpId: id})).update.state, 'started');
  assert.equal((await dispatch('status.get', {})).capabilities.mcpUpdates, true);
  await assert.rejects(dispatch('printers.updateMcp', {mcpId: 'mcp-0000000000000000'}), error => error.code === 'not-found' && /No printer uses that MCP/.test(error.message));
  // The list: every printer on the install carries its mcpId, and a newer version shows as an update.
  const catalog = {defaultDestinationId: 'p1s', destinations: [{id: 'p1s', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current'}],
    resolve: () => bambu('/x'), canonical: value => value};
  const directory = new PrinterDirectory(catalog, () => ({config: bambu('/x'), connect: async () => undefined}));
  directory.useVersions({mcpId: () => id, latestVersion: () => '1.1.50'});
  directory.connected('p1s', {server: {name: 'bambu-printer-mcp', version: '1.1.46'}, tools: ['get_printer_status', 'camera_snapshot', 'get_printer_filaments', 'pause_print', 'resume_print', 'cancel_print']
    .map(name => ({name, inputSchema: {type: 'object', properties: name === 'slice_stl' ? {} : {}}}))});
  const [listed] = directory.list().destinations;
  assert.equal(listed.mcpId, id);
  assert.equal(listed.capabilities.update.latestVersion, '1.1.50');
  const words = (type, data) => eventWords(type, data, {title: 'Counterpart', package: 'bambu-printer-mcp', printer: 'Bambu Lab P1S'});
  assert.equal(words('mcp.update.done', {mcpId: id, toVersion: '1.1.50'}).title, 'Updated bambu-printer-mcp to 1.1.50');
  assert.equal(words('mcp.update.waiting', {mcpId: id, fromVersion: '1.1.46', toVersion: '1.1.50'}).body, '1.1.46 to 1.1.50 · Bambu Lab P1S');
  assert.deepEqual([words('mcp.update.failed', {mcpId: id, fromVersion: '1.1.46'}).body, words('mcp.update.failed', {}).notify], ['1.1.46 is still in use. Try again, or install a fresh copy.', 'active']);
});

test('an event about the Mac has no projectId, and the log keeps it like any other', async t => {
  const {EventLog} = await import('../dist/events/log.js');
  const root = await mkdtemp(join(tmpdir(), 'mcp-events-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = await new EventLog(join(root, 'events.ndjson'), {context: async () => ({title: 'Counterpart'})}).open({prune: false});
  t.after(() => log.close());
  const event = await log.append({id: '00000000-0000-4000-8000-000000000099', type: 'mcp.update.done', data: {mcpId: 'mcp-10cc07925221a48f', toVersion: '1.1.50'}, detail: {package: 'bambu-printer-mcp'}});
  assert.equal('projectId' in event, false);
  assert.equal(event.title, 'Updated bambu-printer-mcp to 1.1.50');
  assert.deepEqual(log.page(0).events.map(item => item.type), ['mcp.update.done']);
});

test('one update per install at a time, and never while a print holds its printer or under a starting print', async t => {
  const {PrintGate} = await import('../dist/printing/print-gate.js');
  const gate = new PrintGate();
  const prefix = `${APP}/printers/bambu`;
  const files = {[`${prefix}/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46')};
  const f = await updater(t, {profile: bambu('/x/node', [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]), files, gate});
  // Two requests at once: one update.
  const [a, b] = await Promise.all([f.updates.update(f.mcpId), f.updates.update(f.mcpId)]);
  assert.deepEqual([a.state, b.state], ['started', 'started']);
  assert.throws(() => gate.hold('a1'), /software is updating/, 'no print starts while it updates');
  await f.done();
  assert.equal(f.events.filter(event => event.type === 'mcp.update.started').length, 1);
  assert.equal(f.commands.filter(line => line.includes(' install ')).length, 1);
  // A print that has started holds its printer: the update waits for it.
  const g = await updater(t, {profile: bambu('/x/node', [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]), files, gate});
  const release = gate.hold('p1s');
  assert.equal((await g.updates.update(g.mcpId)).state, 'waiting');
  release();
  await g.done();
  assert.equal(g.events.at(-1).type, 'mcp.update.done');
  const after = gate.hold('p1s'); after();
});

test('ids keep the two MCPs apart under one prefix; after an npx update the install reads as current; npx behind ssh is unresolved', async t => {
  const env = mac({'/opt/homebrew/lib/node_modules/bambu-printer-mcp/package.json': pkgJson('1.1.46'), '/opt/homebrew/lib/node_modules/mcp-3d-printer-server/package.json': pkgJson('1.0.0', 'mcp-3d-printer-server')});
  const generic = {backend: 'mcp-3d-printer-server', process: {command: '/opt/homebrew/bin/node', args: ['/opt/homebrew/lib/node_modules/mcp-3d-printer-server/dist/index.js']}};
  const one = resolveMcpInstall(bambu('/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js']), env), two = resolveMcpInstall(generic, env);
  assert.equal(one.prefix, two.prefix);
  assert.notEqual(mcpIdFor(one, bambu('x')), mcpIdFor(two, generic));
  const npx = await updater(t, {profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40'])});
  await npx.updates.update(npx.mcpId);
  await npx.done();
  assert.equal(npx.updates.mcpId('p1s'), npx.mcpId, 'the id stays');
  assert.equal((await npx.updates.update(npx.mcpId)).state, 'current', 'it runs 1.1.50 now');
  const wrapped = await updater(t, {profile: bambu('/usr/bin/ssh', ['127.0.0.1', 'npx -y bambu-printer-mcp@1.1.40'])});
  const answer = await wrapped.updates.update(wrapped.mcpId);
  assert.equal(answer.state, 'unresolved');
  assert.match(answer.found, /run through ssh/);
});

test('review fixes: each printer keeps its own variables, a failed swap keeps the old copy, shared files lock together', async t => {
  const env = (host, serial) => ({MCP_TRANSPORT: 'stdio', BAMBU_PRINTER_HOST: host, BAMBU_PRINTER_SERIAL: serial});
  const wrapper = vars => bambu('/opt/tools/printer-wrapper.sh', [], {env: vars});
  // Two printers on one unresolved wrapper, each with its own printer: a fresh copy keeps each one's variables.
  const f = await updater(t, {profiles: [{id: 'p1s', config: wrapper(env('10.0.0.5', 'P1S1'))}, {id: 'x1c', config: wrapper(env('10.0.0.6', 'X1C1'))}]});
  await f.updates.update(f.mcpId, {fresh: true});
  await f.done();
  const byId = Object.fromEntries(f.restarts.map(entry => [entry.id, entry.process.env]));
  assert.deepEqual([byId.p1s.BAMBU_PRINTER_SERIAL, byId.x1c.BAMBU_PRINTER_SERIAL], ['P1S1', 'X1C1']);
  // The new copy can't be moved into place: the old one, already moved aside, goes back.
  const prefix = `${APP}/printers/bambu`, live = `${prefix}/lib/node_modules/bambu-printer-mcp`;
  const files = {[`${live}/package.json`]: pkgJson('1.1.46')};
  const g = await updater(t, {profile: bambu('/x/node', [`${live}/dist/index.js`]), files, failRename: (from, to) => to === live && from.includes('.counterpart-update-') && !from.endsWith('/previous')});
  await g.updates.update(g.mcpId);
  await g.done();
  assert.equal(g.events.at(-1).type, 'mcp.update.failed');
  const kept = g.moves.find(move => move[0] === 'rename' && move[1] === live)[2];
  assert.ok(g.moves.some(move => move[0] === 'rename' && move[1] === kept && move[2] === live), 'the previous copy is moved back');
  // Two different profiles moved to the same fresh copy: an update for one waits while the other prints.
  const {PrintGate} = await import('../dist/printing/print-gate.js');
  const gate = new PrintGate();
  const h = await updater(t, {gate, profiles: [{id: 'p1s', config: wrapper(env('10.0.0.5', 'P1S1'))}, {id: 'a1', config: bambu('/opt/other/wrapper.sh')}]});
  const fresh = `${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`;
  await h.overrides.set('p1s', {command: '/node', args: [fresh]});
  await h.overrides.set('a1', {command: '/node', args: [fresh]});
  assert.notEqual(h.updates.mcpId('p1s'), h.updates.mcpId('a1'));
  const holding = gate.hold('a1');
  assert.equal((await h.updates.update(h.updates.mcpId('p1s'))).state, 'waiting', 'the other printer runs the same files');
  holding();
  await h.done();
});

test('review fixes: a checkout that cannot be put back says so; npx profiles pinned differently are not current', async t => {
  const dir = `${HOME}/src/bambu-printer-mcp`;
  const files = {[`${dir}/package.json`]: pkgJson('1.1.46'), [`${dir}/.git/HEAD`]: '', [`${dir}/dist/index.js`]: ''};
  let ci = 0;
  const f = await updater(t, {profile: bambu('/opt/homebrew/bin/node', [`${dir}/dist/index.js`]), files, fail: args => args[0] === 'ci' && ++ci >= 1});
  await f.updates.update(f.mcpId);
  await f.done();
  const failed = f.events.at(-1);
  assert.equal(failed.type, 'mcp.update.failed');
  assert.match(failed.data.log, /couldn't put the previous version back \(npm ci failed\)/);
  // One npx profile already on 1.1.50, another pinned to 1.1.40: the update isn't "current".
  const g = await updater(t, {latest: '1.1.50', installed: {}, profiles: [
    {id: 'p1s', config: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.50'])},
    {id: 'a1', config: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40'])}]});
  assert.equal(g.updates.mcpId('p1s'), g.updates.mcpId('a1'));
  const answer = await g.updates.update(g.mcpId);
  assert.deepEqual([answer.state, answer.fromVersion], ['started', '1.1.40']);
  await g.done();
  assert.deepEqual((await g.overrides.get('a1')).args, ['-y', 'bambu-printer-mcp@1.1.50']);
});

test('review fixes, round two: fresh copies lock their users, stale overrides drop, npm notices, forced commands, wrapped npx', async t => {
  const {PrintGate} = await import('../dist/printing/print-gate.js');
  const gate = new PrintGate();
  const fresh = `${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`;
  const other = bambu('/opt/other/wrapper.sh'), mine = bambu('/opt/tools/printer-wrapper.sh');
  // Printer a1 already runs the app's fresh copy; a fresh copy for p1s replaces those files, so it waits for a1's print.
  const f = await updater(t, {gate, profiles: [{id: 'p1s', config: mine}, {id: 'a1', config: other}]});
  await f.overrides.set('a1', {command: '/node', args: [fresh]}, other);
  const holding = gate.hold('a1');
  assert.equal((await f.updates.update(f.updates.mcpId('p1s'), {fresh: true})).state, 'waiting');
  holding();
  await f.done();
  assert.ok(f.restarts.some(entry => entry.id === 'a1'), 'the printer already on that copy restarts with the new files');
  // An override made from an older profile is dropped when the profile changes.
  await f.overrides.set('p1s', {command: '/node', args: [fresh]}, bambu('/opt/tools/old-wrapper.sh'));
  assert.equal(f.updates.install('p1s').effective.process.command, '/opt/tools/printer-wrapper.sh');
  // npm's notice after the version doesn't hide it.
  const {McpUpdater, McpOverrides} = await import('../dist/printing/mcp-updates.js');
  const noisy = new McpUpdater({destinations: () => [], env: mac({'/opt/homebrew/bin/npm': ''}), overrides: new McpOverrides(join(tmpdir(), `o-${Date.now()}.json`)),
    session: () => undefined, busy: async () => false, runningVersion: () => undefined, node: '/n', path: '/nowhere',
    run: async () => ({code: 0, output: '1.1.50\nnpm notice New minor version of npm available!\n'})});
  assert.equal(await noisy.checkLatest('bambu-printer-mcp'), '1.1.50');
  // A key with a forced command runs that command, whatever the profile asks ssh to run.
  const forcedLine = `command="exec /x/node '${APP}/printers/bambu-1.1.46/lib/node_modules/bambu-printer-mcp/dist/index.js'" ssh-ed25519 AAAAkey me@mac\n`;
  const env = mac({[`${HOME}/.ssh/authorized_keys`]: forcedLine, [`${HOME}/.ssh/k.pub`]: 'ssh-ed25519 AAAAkey me@mac\n'});
  const wrapped = resolveMcpInstall(bambu('/usr/bin/ssh', ['-i', `${HOME}/.ssh/k`, '127.0.0.1', 'npx', '-y', 'bambu-printer-mcp@1.1.40']), env);
  assert.deepEqual([wrapped.type, wrapped.via.from], ['app', 'authorized-keys']);
  // A wrapped npx and a directly launched npx are separate installs.
  const direct = resolveMcpInstall(bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']), mac());
  const viaSsh = resolveMcpInstall(bambu('/usr/bin/ssh', ['127.0.0.1', 'npx', '-y', 'bambu-printer-mcp@1.1.40']), mac());
  assert.notEqual(mcpIdFor(direct, bambu('x')), mcpIdFor(viaSsh, bambu('x')));
});

test('review fixes, round three: one update per set of files, npx ranges, a slow npm, prereleases', async t => {
  // Two unrelated wrappers both asking for a fresh copy write the same app copy: the second waits.
  const f = await updater(t, {profiles: [{id: 'p1s', config: bambu('/opt/a/wrapper.sh')}, {id: 'a1', config: bambu('/opt/b/wrapper.sh')}]});
  const [one, two] = await Promise.all([f.updates.update(f.updates.mcpId('p1s'), {fresh: true}), f.updates.update(f.updates.mcpId('a1'), {fresh: true})]);
  assert.deepEqual([one.state, two.state].sort(), ['started', 'waiting']);
  await until(() => f.events.filter(event => event.type === 'mcp.update.done' || event.type === 'mcp.update.failed').length === 2);
  // npx with a range (@1): the running MCP's version decides, not the range.
  const g = await updater(t, {profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1']), installed: {p1s: '1.1.40', a1: '1.1.40'}});
  assert.deepEqual([(await g.updates.update(g.mcpId)).state, installedVersion(resolveMcpInstall(bambu('npx', ['bambu-printer-mcp@1']), mac()), mac())], ['started', undefined]);
  await g.done();
  // A slow npm is reported within the Mac app's 10 s, and the next tap uses the answer.
  const {McpUpdater, McpOverrides} = await import('../dist/printing/mcp-updates.js');
  let release;
  const slow = new McpUpdater({destinations: () => [{id: 'p1s', config: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40'])}], env: mac({'/opt/homebrew/bin/npm': ''}),
    overrides: new McpOverrides(join(tmpdir(), `o-${Date.now()}-slow.json`)), session: () => ({restart: async () => {}, connect: async () => ({server: {version: '1.1.50'}})}),
    busy: async () => false, runningVersion: () => '1.1.40', node: '/n', path: '/nowhere', lookupTimeoutMs: 30,
    run: async (_command, args) => args.includes('view') ? new Promise(resolve => { release = () => resolve({code: 0, output: '1.1.50\n'}); }) : {code: 0, output: ''}});
  const id = slow.mcpId('p1s');
  await assert.rejects(slow.update(id), /npm is slow to answer/);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await slow.update(id)).state, 'started');
  // A release beats its prereleases.
  const {newerVersion} = await import('../dist/printing/directory.js');
  assert.deepEqual([newerVersion('1.2.0', '1.2.0-dev'), newerVersion('1.2.0-dev', '1.2.0'), newerVersion('1.2.0-beta.2', '1.2.0-beta.10'), newerVersion('1.2.1', '1.2.0'), newerVersion('1.2.0', '1.2.0')],
    [true, false, false, true, false]);
});

test('review fixes, round four: bare commands come from PATH, ::1 is this Mac, unknown npx versions are not current, every launch path runs the update', async t => {
  const entry = `${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`;
  const env = mac({[entry]: '', [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46'), '/opt/homebrew/bin/node': '',
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js': ''}, {'/opt/homebrew/bin/bambu-printer-mcp': '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js'});
  // A bare `node` after `cd` is whatever the shell finds, never <cwd>/node.
  const viaCd = resolveMcpInstall(bambu('/usr/bin/ssh', ['127.0.0.1', `cd /repo && node '${entry}'`]), env);
  assert.deepEqual([viaCd.type, viaCd.node], ['app', undefined]);
  const withPath = resolveMcpInstall(bambu('/usr/bin/ssh', ['127.0.0.1', `cd /repo && PATH=/opt/homebrew/bin node '${entry}'`]), env);
  assert.equal(withPath.node, '/opt/homebrew/bin/node');
  // Run directly: the profile's PATH, else the companion's.
  assert.equal(resolveMcpInstall(bambu('node', [entry], {cwd: '/repo', env: {PATH: '/usr/bin:/opt/homebrew/bin'}}), env).node, '/opt/homebrew/bin/node');
  assert.equal(resolveMcpInstall(bambu('node', [entry], {cwd: '/repo'}), {...env, path: '/opt/homebrew/bin'}).node, '/opt/homebrew/bin/node');
  const bin = resolveMcpInstall(bambu('bambu-printer-mcp', [], {cwd: '/repo'}), {...env, path: '/opt/homebrew/bin'});
  assert.deepEqual([bin.type, bin.prefix], ['global', '/opt/homebrew']);
  assert.match(resolveMcpInstall(bambu('bambu-printer-mcp', [], {cwd: '/repo'}), env).found, /bambu-printer-mcp, which isn't on the PATH/);
  // IPv6 loopback, bare or with a user, and the ssh:// form with a port, are this Mac.
  for (const destination of ['::1', 'ada@::1', 'ssh://[::1]:22', 'ssh://ada@127.0.0.1:2222', '[::1]']) {
    const install = resolveMcpInstall(bambu('/usr/bin/ssh', [destination, 'npx', '-y', 'bambu-printer-mcp@1.1.45']), env);
    assert.deepEqual([install.type, install.via?.host], ['npx', destination.includes('127.0.0.1') ? '127.0.0.1' : '::1'], destination);
  }
  // One npx printer pinned to the latest, one on a range that hasn't connected: not current; both move to the latest.
  const f = await updater(t, {latest: '2.0.0', installed: {p1s: '2.0.0', a1: undefined}, profiles: [
    {id: 'p1s', config: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@2.0.0'])},
    {id: 'a1', config: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1'])}]});
  const answer = await f.updates.update(f.mcpId);
  assert.equal(answer.state, 'started');
  assert.equal(answer.fromVersion, undefined, 'the oldest version is not known');
  await f.done();
  assert.deepEqual((await f.overrides.get('a1')).args, ['-y', 'bambu-printer-mcp@2.0.0']);
  // Cleanup workers, the printer check and STL sizes read the profile through effective(): the update's command.
  const a1 = bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1']);
  assert.deepEqual(f.updates.effective('a1', a1).process.args, ['-y', 'bambu-printer-mcp@2.0.0']);
  // A profile changed since the update is used as it is.
  const changed = bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.9.0']);
  assert.deepEqual(f.updates.effective('a1', changed), changed);
});

test('review fixes, round five: every printer on the files starts the new version first; a failed print check releases the printers', async t => {
  const prefix = `${APP}/printers/bambu`, live = `${prefix}/lib/node_modules/bambu-printer-mcp`;
  const files = {[`${live}/package.json`]: pkgJson('1.1.46'), [`${live}/dist/index.js`]: ''};
  // The second printer on the same copy can't start the new version: the update fails and the old copy goes back.
  const f = await updater(t, {profile: bambu('/x/node', [`${live}/dist/index.js`]), files, connectFail: id => id === 'a1'});
  await f.updates.update(f.mcpId);
  await f.done();
  assert.equal(f.events.at(-1).type, 'mcp.update.failed');
  const kept = f.moves.find(move => move[0] === 'rename' && move[1] === live)[2];
  const back = f.moves.findIndex(move => move[0] === 'rename' && move[1] === kept && move[2] === live);
  assert.ok(back >= 0, 'the previous copy is moved back');
  assert.ok(f.moves.slice(0, back).every(move => !(move[0] === 'rm' && move[1].includes('.counterpart-update-'))), 'nothing of the previous copy was removed first');
  // The print check fails: Update says so, and the printers aren't left marked as updating.
  const {PrintGate} = await import('../dist/printing/print-gate.js');
  const {McpUpdateError} = await import('../dist/printing/mcp-updates.js');
  const gate = new PrintGate();
  const g = await updater(t, {gate, profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']), installed: {p1s: '1.1.40', a1: '1.1.40'},
    busy: () => { throw new Error('EIO: objects'); }});
  await assert.rejects(g.updates.update(g.mcpId), error => error instanceof McpUpdateError && error.code === 'unavailable' && /couldn't check whether a print is running/.test(error.message));
  assert.deepEqual([gate.updating('p1s'), gate.updating('a1')], [false, false]);
  gate.hold('p1s')();
  // The same while waiting: the update ends with mcp.update.failed, and a new request is a new update.
  let checks = 0;
  const gate2 = new PrintGate();
  const h = await updater(t, {gate: gate2, profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']), installed: {p1s: '1.1.40', a1: '1.1.40'},
    busy: () => { checks++; if (checks <= 2) return true; throw new Error('EIO: objects'); }});
  assert.equal((await h.updates.update(h.mcpId)).state, 'waiting');
  await h.done();
  assert.equal(h.events.at(-1).type, 'mcp.update.failed');
  assert.match(h.events.at(-1).data.log, /couldn't check whether a print is running/);
  assert.deepEqual([gate2.updating('p1s'), gate2.updating('a1')], [false, false]);
  assert.equal(h.commands.filter(command => command.includes('install')).length, 0, 'nothing ran');
});

test('review fixes, round six: overrides written at the same time all reach the file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-overrides-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'printers', 'overrides.json');
  const overrides = new McpOverrides(path);
  const ids = Array.from({length: 24}, (_, index) => `printer-${index}`);
  await Promise.all(ids.map(id => overrides.set(id, {command: '/node', args: [`/copy/${id}.js`]})));
  const reread = new McpOverrides(path);
  assert.deepEqual(Object.keys(await reread.load()).sort(), [...ids].sort());
  // Removing one and changing another at the same time keeps both changes.
  await Promise.all([overrides.set('printer-0', undefined), overrides.set('printer-1', {command: '/node', args: ['/copy/new.js']})]);
  const again = await new McpOverrides(path).load();
  assert.deepEqual([again['printer-0'], again['printer-1'].args], [undefined, ['/copy/new.js']]);
});

test('review fixes, round seven: a previous npm copy that cannot be put back is reported, not called "still in use"', async t => {
  const prefix = `${APP}/printers/bambu`, live = `${prefix}/lib/node_modules/bambu-printer-mcp`;
  const files = {[`${live}/package.json`]: pkgJson('1.1.46'), [`${live}/dist/index.js`]: ''};
  // The new copy can't start on a printer, and moving the previous one back fails too.
  const f = await updater(t, {profile: bambu('/x/node', [`${live}/dist/index.js`]), files, connectFail: () => true,
    failRename: (from, to) => to === live && from.endsWith('/previous')});
  await f.updates.update(f.mcpId);
  await f.done();
  const failed = f.events.at(-1);
  assert.equal(failed.type, 'mcp.update.failed');
  assert.match(failed.data.log, /couldn't put the previous version back\. It is kept in .*\/previous: move it to/);
  assert.match(failed.reason, /couldn't be put back/);
  const kept = f.moves.find(move => move[0] === 'rename' && move[1] === live)[2];
  assert.ok(!f.moves.some(move => move[0] === 'rm' && kept.startsWith(move[1] + '/')), 'the folder holding the previous copy is not removed');
  // The words: no "still in use" when it isn't.
  const {eventWords} = await import('../dist/events/words.js');
  const words = eventWords('mcp.update.failed', failed.data, {title: 'Counterpart', package: 'bambu-printer-mcp', reason: failed.reason});
  assert.doesNotMatch(words.body, /still in use/);
  assert.match(eventWords('mcp.update.failed', {mcpId: 'x', fromVersion: '1.1.46'}, {title: 'Counterpart', package: 'bambu-printer-mcp'}).body, /1\.1\.46 is still in use/);
});


test('updates wait for admitted design passes, their queue, and helper shutdown on the shared install', {timeout: 10_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-pass-reservation-'));
  const gate = new PrintGate(), first = Promise.withResolvers(), second = Promise.withResolvers(), cleanup = Promise.withResolvers();
  const prefix = `${APP}/printers/bambu`, profile = bambu('/x/node', [`${prefix}/lib/node_modules/bambu-printer-mcp/dist/index.js`]);
  const f = await updater(t, {gate, profiles: [{id: 'current', config: profile}, {id: 'p1s', config: profile}],
    files: {[`${prefix}/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46')}});
  let runs = 0, stopping = false;
  const service = new ObjectService({store: new ObjectStore(join(root, 'objects')), handoff: profile, printGate: gate, claudePath: '/c',
    runTouchup: input => runTouchup(input, {
      lockPath: join(root, 'blender.lock'), fusionLockPath: join(root, 'fusion.lock'), ensureBlender: async () => {}, resetScene: async () => {}, client: () => ({connect: async () => {}, hasTool: () => false, close: async () => {}}),
      run: async () => { runs++; await (runs === 1 ? first.promise : second.promise); return {status: 'failed', reason: 'test result', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 0}}; },
      stopBlender: async () => { stopping = true; await cleanup.promise; },
    }),
  });
  const a = await service.create('Make a small hook.'), b = await service.create('Make another hook.');
  t.after(async () => { first.resolve(); second.resolve(); cleanup.resolve(); await Promise.all([service.settled(a.id), service.settled(b.id)]); await rm(root, {recursive: true, force: true}); });
  await service.start(a.id); await until(() => runs === 1);
  await service.start(b.id);
  assert.equal((await f.updates.update(f.mcpId)).state, 'waiting', 'design pass reserves the same install as its printer');
  first.resolve(); await until(() => runs === 2);
  assert.equal(gate.held('current'), true, 'queued pass retains the install when the first finishes');
  assert.equal(f.commands.some(command => command.includes(' install ')), false);
  second.resolve(); await until(() => stopping);
  assert.equal(gate.held('current'), true, 'shutdown still needs the MCP executable');
  assert.equal(f.commands.some(command => command.includes(' install ')), false);
  cleanup.resolve(); await service.settled(b.id); await f.done();
  assert.equal(gate.held('current'), false);
  assert.equal(f.commands.filter(command => command.includes(' install ')).length, 1);
});

test('an update reserves the install before its async busy check, so a correction cannot start under it', {timeout: 10_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-pass-admission-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gate = new PrintGate(), checking = Promise.withResolvers();
  const profile = bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']);
  const f = await updater(t, {gate, profiles: [{id: 'current', config: profile}, {id: 'p1s', config: profile}], busy: () => checking.promise});
  let calls = 0;
  const store = new ObjectStore(join(root, 'objects'));
  const service = new ObjectService({store, handoff: profile, printGate: gate, claudePath: '/c', runTouchup: async () => { calls++; throw new Error('must not start'); }});
  const object = await service.create('Make a hook.');
  await store.update(object.id, o => ({...o, state: 'failed'}));
  const updating = f.updates.update(f.mcpId);
  t.after(async () => { checking.resolve(false); await updating; await f.done(); });
  await until(() => gate.updating('current'));
  await assert.rejects(service.correct(object.id, 'Make it wider.'), /software is updating/);
  assert.equal(calls, 0);
  assert.equal((await service.get(object.id)).state, 'failed', 'no pass was admitted or added');
  assert.equal((await service.get(object.id)).passes.length, 0);
});

test('slow printer admission returns an accepted update before client deadlines while preserving the print reservation', {timeout: 5000}, async t => {
  const gate = new PrintGate(), busy = Promise.withResolvers();
  let f;
  t.after(async () => { busy.resolve(false); await f?.done(); });
  f = await updater(t, {gate, profile: bambu('/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js']), files: {
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/package.json': pkgJson('1.1.40'),
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js': '',
  }, busy: () => busy.promise});
  let deadline;
  const result = await Promise.race([f.updates.update(f.mcpId), new Promise(resolve => { deadline = setTimeout(() => resolve('client-timeout'), 1000); })])
    .finally(() => clearTimeout(deadline));
  assert.notEqual(result, 'client-timeout', 'a busy check must not spend the remaining RPC deadline');
  assert.equal(result.state, 'started');
  assert.equal(gate.updating('p1s'), true);
  assert.throws(() => gate.hold('p1s'), /software is updating/);
  assert.deepEqual(await f.updates.update(f.mcpId), result, 'a second tap observes the admitted update');
  assert.equal(f.commands.some(command => command.includes(' install ')), false, 'no files change before the safety check answers');
  busy.resolve(false);
  await f.done();
  assert.equal(f.events.at(-1).type, 'mcp.update.done');
  assert.equal(f.commands.filter(command => command.includes(' install ')).length, 1);
  assert.equal(gate.updating('p1s'), false);
});

test('a slow admitted printer check reports failure by event and releases its reservation without installing', {timeout: 5000}, async t => {
  const gate = new PrintGate(), busy = Promise.withResolvers();
  let f;
  t.after(async () => { busy.reject(new Error('printer unavailable')); await f?.done(); });
  f = await updater(t, {gate, profile: bambu('/opt/homebrew/bin/node', ['/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js']), files: {
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/package.json': pkgJson('1.1.40'),
    '/opt/homebrew/lib/node_modules/bambu-printer-mcp/dist/index.js': '',
  }, busy: () => busy.promise});
  let deadline;
  const result = await Promise.race([f.updates.update(f.mcpId), new Promise(resolve => { deadline = setTimeout(() => resolve('client-timeout'), 1000); })])
    .finally(() => clearTimeout(deadline));
  assert.notEqual(result, 'client-timeout');
  busy.reject(new Error('printer unavailable'));
  await f.done();
  assert.equal(f.events.at(-1).type, 'mcp.update.failed');
  assert.match(f.events.at(-1).data.log, /couldn't check whether a print is running/);
  assert.equal(gate.updating('p1s'), false);
  assert.equal(f.commands.some(command => command.includes(' install ')), false);
  gate.hold('p1s')();
});


test('a delayed busy answer queues an already admitted update until printing finishes', {timeout: 5000}, async t => {
  const gate = new PrintGate(), checking = Promise.withResolvers();
  let busy = true, firstCheck = true, f;
  t.after(async () => { busy = false; checking.resolve(false); await f?.done(); });
  f = await updater(t, {gate, profile: bambu('/opt/homebrew/bin/npx', ['-y', 'bambu-printer-mcp@1.1.40']), busy: () => {
    if (firstCheck) return checking.promise;
    return busy;
  }});
  const accepted = await f.updates.update(f.mcpId);
  assert.equal(accepted.state, 'started');
  firstCheck = false;
  checking.resolve(true);
  await until(() => f.events.some(event => event.type === 'mcp.update.waiting'));
  assert.equal((await f.updates.update(f.mcpId)).state, 'waiting');
  assert.equal(f.restarts.length, 0, 'no MCP restarts while the printer is busy');
  busy = false;
  await f.done();
  assert.equal(f.events.filter(event => event.type === 'mcp.update.started').length, 1);
  assert.equal(f.events.at(-1).type, 'mcp.update.done');
  assert.equal(gate.updating('p1s'), false);
});

test('Download installs only that package into the app\'s own copy (staged, then swapped in) and reports it by the app copy\'s id', async t => {
  const {appMcpId} = await import('../dist/printing/mcp-install.js');
  const f = await updater(t, {profiles: []});
  const started = await f.updates.download('mcp-3d-printer-server');
  const id = appMcpId('mcp-3d-printer-server', {appPrinters: `${APP}/printers`});
  assert.deepEqual(started, {mcpId: id, state: 'started', toVersion: '1.1.50'});
  // A second tap while it runs gets the same download.
  assert.deepEqual(await f.updates.download('mcp-3d-printer-server'), started);
  await f.done();
  const prefix = `${APP}/printers/generic`;
  const staging = f.commands[1].match(/--prefix (.+\/\.counterpart-update-[0-9a-f-]+) /)[1];
  assert.ok(staging.startsWith(`${prefix}/`));
  assert.match(f.commands[1], / install --global --prefix .+ mcp-3d-printer-server@1\.1\.50$/);
  assert.equal(f.commands.filter(line => line.includes(' install ')).length, 1, 'one install, of that package only');
  assert.ok(!f.commands.some(line => line.includes('bambu-printer-mcp')), 'never the other MCP');
  assert.deepEqual(f.moves.filter(move => move[0] === 'rename'), [['rename', `${staging}/lib/node_modules/mcp-3d-printer-server`, `${prefix}/lib/node_modules/mcp-3d-printer-server`]]);
  assert.deepEqual(f.events.map(event => [event.type, event.package, event.data.mcpId]), [['mcp.update.started', 'mcp-3d-printer-server', id], ['mcp.update.done', 'mcp-3d-printer-server', id]]);
  // A failed npm install leaves nothing behind and says so.
  const broken = await updater(t, {profiles: [], fail: 'install'});
  await broken.updates.download('bambu-printer-mcp');
  await broken.done();
  assert.equal(broken.events.at(-1).type, 'mcp.update.failed');
  assert.match(broken.events.at(-1).data.log, /npm ERR! network/);
  assert.ok(!broken.moves.some(move => move[0] === 'rename'), 'nothing swapped in');
  assert.ok(broken.moves.some(move => move[0] === 'rm' && /\.counterpart-update-/.test(move[1])), 'the staging folder is removed');
});

test('Settings → Printers lists both MCPs; any copy this Mac has (a printer\'s, the app\'s, an earlier app copy, a folder) counts as installed', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const node = '/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node';
  const legacy = `${APP}/printers/bambu-1.1.46`;
  // A copy counts when Counterpart can start it: its dist/index.js is there (an npx profile has none until npx runs).
  const env = mac({[`${legacy}/lib/node_modules/bambu-printer-mcp/package.json`]: pkgJson('1.1.46'),
    [`${legacy}/lib/node_modules/bambu-printer-mcp/dist/index.js`]: '', [`${HOME}/mcp-3D-printer-server/dist/index.js`]: ''});
  const downloads = [];
  const setup = (configs, folders = []) => new PrinterSetup({env, configs: () => configs, folders: async () => folders,
    list: path => path === `${APP}/printers` ? ['bambu-1.1.46', 'profiles'] : [], latestVersion: pkg => pkg === 'bambu-printer-mcp' ? '1.1.50' : '1.2.17',
    download: async pkg => { downloads.push(pkg); return {mcpId: 'mcp-0000000000000000', state: 'started', toVersion: '1.2.17'}; }});
  const nothing = await setup([]).mcps();
  assert.deepEqual(nothing.packages.map(item => [item.package, item.label, item.installed]), [['bambu-printer-mcp', 'bambu-printer-mcp', true], ['mcp-3d-printer-server', 'mcp-3D-printer-server', false]]);
  assert.equal(nothing.packages[0].description, 'Bambu Lab printers');
  assert.match(nothing.packages[1].description, /Prusa, Klipper, OctoPrint, Duet, Repetier, Creality/);
  assert.deepEqual(nothing.packages[0].installs, [{kind: 'app', path: legacy, version: '1.1.46'}]);
  assert.equal(nothing.packages[0].latestVersion, '1.1.50');
  // Download installs only the missing one; one already here is never installed again.
  assert.deepEqual(await setup([]).installMcp('mcp-3d-printer-server'), {update: {mcpId: 'mcp-0000000000000000', state: 'started', toVersion: '1.2.17'}});
  assert.deepEqual(await setup([]).installMcp('bambu-printer-mcp'), {installed: true, package: 'bambu-printer-mcp'});
  assert.deepEqual(downloads, ['mcp-3d-printer-server']);
  // A clone in the home folder is a copy too; a printer's npx profile is listed.
  const folder = await setup([], [{dir: `${HOME}/mcp-3D-printer-server`, package: 'mcp-3d-printer-server', version: '1.2.17', hasEnv: true}]).mcps();
  assert.deepEqual(folder.packages[1].installs, [{kind: 'folder', path: `${HOME}/mcp-3D-printer-server`, version: '1.2.17'}]);
  assert.equal(folder.packages[1].installed, true);
  const npx = await setup([{id: 'x', config: {backend: 'mcp-3d-printer-server', process: {command: '/opt/homebrew/bin/npx', args: ['-y', 'mcp-3d-printer-server@1.2.10']}}}]).mcps();
  assert.deepEqual(npx.packages[1].installs, [{kind: 'npx', path: 'mcp-3d-printer-server@1.2.10', version: '1.2.10'}]);
  assert.equal(npx.packages[1].version, '1.2.10');
  assert.equal(npx.packages[1].installed, false, 'listed, but Download is offered: Check and Add need a copy Counterpart can start');
  void node;
});

test('findMcpFolders finds a built copy of either MCP two levels into the home folder, and skips protected and hidden folders', async t => {
  const {findMcpFolders} = await import('../dist/printing/setup.js');
  const {mkdir, writeFile} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'mcp-home-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const copy = async (dir, name, env = true) => {
    await mkdir(join(home, dir, 'dist'), {recursive: true});
    await writeFile(join(home, dir, 'package.json'), JSON.stringify({name, version: '1.2.17'}));
    await writeFile(join(home, dir, 'dist', 'index.js'), '');
    if (env) await writeFile(join(home, dir, '.env'), 'PRINTER_TYPE=bambu\n');
  };
  await copy('mcp-3D-printer-server', 'mcp-3d-printer-server');
  await copy('fleet/bambu-printer-mcp', 'bambu-printer-mcp', false);
  await copy('Documents/bambu-printer-mcp', 'bambu-printer-mcp');
  await copy('.hidden/bambu-printer-mcp', 'bambu-printer-mcp');
  await copy('a/b/bambu-printer-mcp', 'bambu-printer-mcp');
  await copy('other', 'left-pad');
  const found = (await findMcpFolders(home)).sort((a, b) => a.dir.localeCompare(b.dir));
  assert.deepEqual(found, [
    {dir: join(home, 'fleet/bambu-printer-mcp'), package: 'bambu-printer-mcp', version: '1.2.17', hasEnv: false},
    {dir: join(home, 'mcp-3D-printer-server'), package: 'mcp-3d-printer-server', version: '1.2.17', hasEnv: true},
  ]);
});

test('review fix (#295): a printer listed after start (Add, a Printer MCP choice) starts on its saved override, as at start', async t => {
  const fresh = `${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`;
  const profiles = [];
  const f = await updater(t, {profiles});
  profiles.push({id: 'later', config: bambu('/opt/tools/wrapper.sh')});
  await f.overrides.set('later', {command: '/node', args: [fresh]}, profiles[0].config);
  await f.updates.applyOverride('later');
  assert.deepEqual(f.restarts.map(entry => [entry.id, entry.process.args]), [['later', [fresh]]]);
  await f.updates.applyOverride('unknown');
  assert.equal(f.restarts.length, 1, 'an unknown or override-free destination is left alone');
});


test('npm script policy: Update and Download authorize only the selected MCP and refuse a skipped postinstall', async t => {
  for (const pkg of ['bambu-printer-mcp', 'mcp-3d-printer-server']) {
    for (const download of [false, true]) {
      const prefix = `${APP}/printers/${pkg}`;
      const profile = {backend: pkg, process: {command: '/usr/bin/node', args: [`${prefix}/lib/node_modules/${pkg}/dist/index.js`]}};
      const files = {[`${prefix}/lib/node_modules/${pkg}/package.json`]: pkgJson('1.1.46', pkg)};
      for (const ran of [false, true]) {
        const f = await updater(t, {profile, files, postinstall: 'node setup.mjs',
          installOutput: ran ? `> ${pkg}@1.1.50 postinstall\n> node setup.mjs\n` : 'install-scripts: setup was skipped'});
        if (download) await f.updates.download(pkg); else await f.updates.update(f.mcpId);
        await f.done();
        const install = f.commands.find(command => command.includes(' install '));
        assert.ok(install.includes(`--allow-scripts=${pkg} --ignore-scripts=false --foreground-scripts`));
        assert.ok(!install.includes('dangerously-allow-all'));
        assert.equal(f.events.at(-1).type, ran ? 'mcp.update.done' : 'mcp.update.failed');
        if (!ran) {
          assert.equal(f.moves.filter(move => move[0] === 'rename').length, 0, 'skipped setup never swaps the working copy');
          assert.match(f.events.at(-1).data.log, /required setup/);
        }
      }
    }
  }
});
