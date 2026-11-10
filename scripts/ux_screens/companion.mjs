// The companion `scripts/ux_screens.py` shows the simulator: the real `server-cli.js` serving a throwaway copy of
// a Mac's projects, with no printer and no model access, behind the simulator-only fixture address
// http://127.0.0.1:9078 (CompanionAddress.isFixture). Started by ux_screens.py, which made the copy.
//
//   node companion.mjs --state <copied state root> --dist <services/companion/dist> [--port 19077]
//
// It never reads or writes the installed app's state: the server runs with an empty environment, HOME inside the
// copy (so it finds none of this Mac's printer MCPs), its own auth store, and a printer handoff whose MCP command is
// /usr/bin/false. Prints one JSON line {ready, record, objects} when the phone's pairing record is ready.
import {spawn} from 'node:child_process';
import {createServer, request} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdir, writeFile, access} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.state || !args.dist) throw new Error('usage: companion.mjs --state <copied state root> --dist <companion dist>');
const state = resolve(args.state), dist = resolve(args.dist);
const port = Number(args.port ?? 19077), proxyPort = 9078;
if (port === 9077) throw new Error('9077 is the installed companion');

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

const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: join(state, 'tmp'),
  SCAN_TO_MAKE_REMOTE_AUTH_DIR: authDir,
  SCAN_TO_MAKE_CAPTURE_DIR: join(state, 'capture'),
  SCAN_TO_MAKE_PRINTER_HANDOFF_CONFIG: handoffConfig,
  SCAN_TO_MAKE_PRINTER_HANDOFF_DIR: handoffDir,
  SCAN_TO_MAKE_GENERATION_PORT: String(port),
};
await mkdir(env.TMPDIR, {recursive: true});
const server = spawn(process.execPath, [join(dist, 'server-cli.js')], {env, cwd: state, stdio: ['ignore', 'pipe', 'pipe']});
let log = '';
server.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
const started = await new Promise((done, fail) => {
  server.stdout.on('data', chunk => { log += chunk; if (/ready at (\S+)/.test(log)) done(log.match(/ready at (\S+)/)[1]); });
  server.on('exit', code => fail(new Error(`server-cli exited ${code}: ${log.slice(-2000)}`)));
  setTimeout(() => fail(new Error(`server-cli did not start: ${log.slice(-2000)}`)), 60_000);
});

const proxy = createServer((req, res) => {
  const upstream = request(`${started}${req.url}`, {method: req.method, headers: {
    ...req.headers, host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'tailscale-user-login': login,
  }}, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => { res.writeHead(503); res.end(); });
  req.pipe(upstream);
});
await new Promise((done, fail) => { proxy.once('error', fail); proxy.listen(proxyPort, '127.0.0.1', done); });
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
process.stdout.write(JSON.stringify({ready: true, url: base, server: started, pid: server.pid, record, objects, objectsStatus: listed.status}) + '\n');

const stop = () => { proxy.close(); server.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', () => { proxy.close(); process.exit(0); });
