import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
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
    exists: path => path in files || Object.keys(files).some(file => file.startsWith(path + '/')) || /\.counterpart-update-[0-9a-f-]+\/lib\/node_modules\/[^/]+\/package\.json$/.test(path),
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
async function updater(t, {profile, files = {}, links = {}, busy = () => false, latest = '1.1.50', fail, gate} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-updates-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const env = mac({'/opt/homebrew/bin/npm': '', '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js': '', ...files}, {'/opt/homebrew/bin/npm': '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js', ...links});
  const commands = [], events = [], restarts = [], moves = [];
  let version = '1.1.46';
  const session = {
    restart: async config => { restarts.push(config); },
    connect: async () => ({server: {name: 'bambu-printer-mcp', version}, tools: []}),
  };
  const overrides = new McpOverrides(join(root, 'overrides.json'));
  await overrides.load();
  const updates = new McpUpdater({
    gate, fs: {rename: async (from, to) => { moves.push(['rename', from, to]); }, rm: async path => { moves.push(['rm', path]); }, mkdir: async () => undefined},
    destinations: () => [{id: 'p1s', config: profile}, {id: 'a1', config: profile}],
    env, overrides, session: () => session, busy: async id => busy(id), runningVersion: () => '1.1.46',
    emit: async event => { events.push(event); }, waitPollMs: 20, node: '/Applications/Scan to Make.app/Contents/Resources/Payload/node/bin/node', path: '/usr/bin:/bin',
    run: async (command, args, options) => {
      commands.push([command, ...args, ...(options.cwd ? [`(in ${options.cwd})`] : [])].join(' '));
      if (args.includes('view')) { await new Promise(resolve => setTimeout(resolve, 5)); return {code: 0, output: `${latest}\n`}; }
      if (args.includes('rev-parse')) return {code: 0, output: 'abc123\n'};
      if (fail && args.join(' ').includes(fail)) return {code: 1, output: 'npm ERR! network'};
      if (args.includes('install') || args.includes('pull')) version = latest;
      return {code: 0, output: ''};
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
  assert.equal(f.commands[1], `${node} /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js install --global --prefix ${staging} bambu-printer-mcp@1.1.50`);
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
  assert.deepEqual((await npx.overrides.get(npx.mcpId)).args, ['-y', 'bambu-printer-mcp@1.1.50']);
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
  const override = await f.overrides.get(f.mcpId);
  assert.deepEqual(override.args, [`${APP}/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js`]);
  assert.deepEqual(f.restarts[0].process.env, {BAMBU_SERIAL: 'S'}, 'the profile\'s own variables go with it');
  const failing = await updater(t, {profile: bambu('/opt/tools/printer-wrapper.sh'), fail: 'install'});
  await failing.updates.update(failing.mcpId, {fresh: true});
  await failing.done();
  const failed = failing.events.at(-1);
  assert.equal(failed.type, 'mcp.update.failed');
  assert.match(failed.data.log, /npm ERR! network/);
  assert.ok(Buffer.byteLength(failed.data.log) <= 4096);
  assert.equal(await failing.overrides.get(failing.mcpId), undefined, 'the previous profile stays');
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
