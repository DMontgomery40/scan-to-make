// The companion `scripts/ux_screens.py` shows the simulator: the real `server-cli.js` serving a throwaway copy of
// a Mac's projects, with no printer and no model access, behind the simulator-only fixture address
// http://127.0.0.1:<9078 or 9080–9097> (CompanionAddress.isFixture). Started by ux_screens.py, which made the copy.
//
//   node companion.mjs --state <copied state root> --dist <services/companion/dist>
//
// Every run takes free ports of its own (the server any free port, the proxy the first free simulator test port), so
// any number of prepared runs can wait for the lane at once.
//
// It never reads or writes the installed app's state: the server runs with an empty environment, HOME inside the
// copy (so it finds none of this Mac's printer MCPs), its own auth store, and a printer handoff whose MCP command is
// /usr/bin/false. Prints one JSON line {ready, record, objects} when the phone's pairing record is ready.
import {spawn} from 'node:child_process';
import {conditionedProxy, CONDITIONS} from './conditions.mjs';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile, access, mkdtemp, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.state || !args.dist) throw new Error('usage: companion.mjs --state <copied state root> --dist <companion dist>');
const state = resolve(args.state), dist = resolve(args.dist);
// The simulator-only test addresses the app accepts: 9078 in every build, 9080–9097 in Debug (9079 is the https one).
const PROXY_PORTS = [9078, ...Array.from({length: 18}, (_, i) => 9080 + i)];

const host = 'ux-screens.example.ts.net', login = 'ux-screens@example.test';
const {RemoteAuthStore} = await import(pathToFileURL(join(dist, 'remote-auth.js')).href);
const authDir = join(state, 'auth');
try { await access(join(authDir)); } catch { await RemoteAuthStore.create(authDir, {host, allowedLogins: [login]}); }

// A printer handoff that can never reach a printer: its MCP is /usr/bin/false.
const handoffConfig = join(state, 'ux-printer-handoff.json'), handoffDir = join(state, 'ux-printer-handoff');
await mkdir(handoffDir, {recursive: true});
await writeFile(handoffConfig, JSON.stringify({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/false'}}));
const home = join(state, 'home');
await mkdir(home, {recursive: true});

// The control socket sits in a short private folder of its own: a socket path over ~104 bytes (a long --work) makes
// the server's local control fail to start.
const socketDir = await mkdtemp('/tmp/uxs-');
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: join(state, 'tmp'),
  SCAN_TO_MAKE_REMOTE_AUTH_DIR: authDir,
  SCAN_TO_MAKE_CAPTURE_DIR: join(state, 'capture'),
  SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG: handoffConfig,
  SCAN_TO_MAKE_PRINTER_HANDOFF_DIR: handoffDir,
  SCAN_TO_MAKE_GENERATION_PORT: '0',
  SCAN_TO_MAKE_CONTROL_SOCKET: join(socketDir, 'control.sock'),
};
await mkdir(env.TMPDIR, {recursive: true});
const server = spawn(process.execPath, [join(dist, 'server-cli.js')], {env, cwd: state, stdio: ['ignore', 'pipe', 'pipe']});
let log = '';
server.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
const started = await new Promise((done, fail) => {
  server.stdout.on('data', chunk => { log += chunk; if (/ready at (\S+)/.test(log)) done(log.match(/ready at (\S+)/)[1]); });
  server.on('exit', code => fail(new Error(`server-cli exited ${code}: ${log.slice(-2000)}`)));
  setTimeout(() => fail(new Error(`server-cli did not start: ${log.slice(-2000)}`)), 60_000);
}).catch(async error => {
  server.kill('SIGTERM');
  await rm(socketDir, {recursive: true, force: true}).catch(() => {});
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

// The proxy adds the Serve headers and can play a bad day (conditions.mjs). It pairs and checks the list as `none`, then
// takes the run's condition.
const condition = args.condition ?? 'none';
if (!Object.hasOwn(CONDITIONS, condition)) {
  server.kill('SIGTERM');
  await rm(socketDir, {recursive: true, force: true}).catch(() => {});
  process.stderr.write(`Unknown condition ${condition}; choose from ${Object.keys(CONDITIONS).join(', ')}.\n`);
  process.exit(1);
}
const proxy = conditionedProxy({target: started, headers: requestHeaders => ({
  ...requestHeaders, host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'tailscale-user-login': login,
})});
const listen = candidate => new Promise(done => {
  const failed = () => done(false);
  proxy.once('error', failed);
  proxy.listen(candidate, '127.0.0.1', () => { proxy.off('error', failed); done(true); });
});
let proxyPort;
for (const candidate of PROXY_PORTS) if (await listen(candidate)) { proxyPort = candidate; break; }
if (proxyPort === undefined) {
  server.kill('SIGTERM');
  await rm(socketDir, {recursive: true, force: true}).catch(() => {});
  process.stderr.write(`Every simulator test port (9078, 9080–9097) is in use by other capture runs.\n`);
  process.exit(1);
}
const base = `http://127.0.0.1:${proxyPort}`;

// The phone's pairing: the exchange the app's PairingClient makes (POST /v1/pair), done here once.
const store = await RemoteAuthStore.open(authDir);
// No scopes: a phone pairing, PHONE_SCOPES, as the Mac's own QR grants.
const invitation = await store.createPairing(login);
const installationKey = randomBytes(32).toString('base64url');
const paired = await fetch(`${base}/v1/pair`, {method: 'POST', headers: {'content-type': 'application/json'},
  body: JSON.stringify({code: invitation.code, deviceName: 'UX screens simulator', installationKey})});
if (!paired.ok) throw new Error(`pairing failed: ${paired.status} ${await paired.text()}`);
const record = {...await paired.json(), baseUrl: base};
for (const key of ['certificateSha256', 'publicKeySha256', 'addresses', 'activeUrl']) delete record[key];
const listed = await fetch(`${base}/v1/objects`, {headers: {authorization: `Bearer ${record.token}`, 'x-scan-device': record.deviceId}});
const objects = listed.ok ? (await listed.json()).objects.map(object => ({id: object.id, state: object.state, title: object.title ?? null})) : [];
proxy.setCondition(condition);
process.stdout.write(JSON.stringify({ready: true, url: base, proxyPort, condition, server: started, pid: server.pid, record, objects, objectsStatus: listed.status}) + '\n');

const cleanUp = () => rm(socketDir, {recursive: true, force: true}).catch(() => {});
const stop = () => { proxy.close(); server.kill('SIGTERM'); setTimeout(() => cleanUp().then(() => process.exit(0)), 3000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', () => { proxy.close(); cleanUp().then(() => process.exit(0)); });
