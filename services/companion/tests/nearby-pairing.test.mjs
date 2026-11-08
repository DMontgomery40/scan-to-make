import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {createHash, randomBytes, X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {NearbyPairing} from '../dist/nearby-pairing.js';
import {advertise, instanceName} from '../dist/bonjour.js';
import {parsePairingLink} from '@scan-to-make/contracts/pairing-link';
import {NEARBY_PICKUP_MS, NEARBY_SESSION_MS, nearbyCodeFromDigest, nearbyCodeInput, nearbyCommitInput} from '@scan-to-make/contracts/nearby-pairing';
import {tempDir} from './support/temp.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest();
const b64 = bytes => Buffer.from(bytes).toString('base64url');

async function fixture(t) {
  const root = await tempDir('nearby-'); t.after(() => rm(root, {recursive: true, force: true}));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], {stdio: 'ignore'});
  const cert = await readFile(join(root, 'cert.pem')), key = await readFile(join(root, 'key.pem'));
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const certificateSha256 = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  const store = await RemoteAuthStore.create(join(root, 'auth'), {transport: 'lan', host: `127.0.0.1:${port}`, certificateSha256, allowedLogins: ['lan']});
  return {root, store, cert, key, port};
}

/** One HTTPS request as the phone makes it: no name check, and S taken from this handshake's certificate. */
function call(f, path, body, {method = 'POST', signal} = {}) {
  return new Promise((resolve, reject) => {
    const req = request({host: '127.0.0.1', port: f.port, path, method, signal, ca: f.cert, servername: '', checkServerIdentity: () => undefined,
      headers: {host: `127.0.0.1:${f.port}`, ...(body === undefined ? {} : {'content-type': 'application/json'})}}, res => {
      const leaf = new X509Certificate(res.socket.getPeerCertificate(true).raw);
      const S = sha(leaf.publicKey.export({type: 'spki', format: 'der'}));
      const chunks = []; res.on('data', x => chunks.push(x));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({status: res.statusCode, json: text ? JSON.parse(text) : undefined, S}); });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

async function start(t, f, extra = {}) {
  const adverts = [];
  const server = await startCompanionServer({remoteAuth: f.store, lanTls: {cert: f.cert, key: f.key},
    nearby: {name: "David's Mac mini", advertise: options => { const advert = {options, closed: false, async close() { advert.closed = true; }}; adverts.push(advert); return advert; }}, ...extra});
  t.after(() => server.close());
  return {server, adverts};
}

/** The phone's side: commit, then reveal, computing the code from the key it saw. */
async function phone(f, deviceName = 'Test iPhone') {
  const key = randomBytes(32);
  const started = await call(f, '/v1/pair/nearby', {commit: b64(sha(nearbyCommitInput(key))), deviceName});
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const {session, nonce} = started.json;
  const code = nearbyCodeFromDigest(sha(nearbyCodeInput(started.S, key, Buffer.from(nonce, 'base64url'))));
  return {key, session, nonce, code, S: started.S, reveal: () => call(f, '/v1/pair/nearby/reveal', {session, key: b64(key)}),
    result: options => call(f, '/v1/pair/nearby/result', {session, key: b64(key)}, options)};
}

test('nearby pairing end to end: both sides show the same code, Allow releases a v2 link to the key holder only, and it pairs', async t => {
  const f = await fixture(t);
  const {server, adverts} = await start(t, f);
  // Advertised once, under the Mac's name, with the key pin as a hint.
  assert.equal(adverts.length, 1);
  assert.deepEqual(adverts[0].options, {name: "David's Mac mini", port: f.port, txt: {v: '1', k: server.publicKeySha256}});
  const p = await phone(f);
  assert.equal(p.S.toString('hex'), server.publicKeySha256);
  // No code exists before the reveal.
  assert.deepEqual(server.nearby.pending(), []);
  const revealed = await p.reveal();
  assert.deepEqual([revealed.status, revealed.json.status], [200, 'waiting']);
  const [request_] = server.nearby.pending();
  assert.deepEqual({...request_, expiresAt: 0}, {id: p.session, deviceName: 'Test iPhone', code: p.code, expiresAt: 0});
  // The phone waits; Allow answers it at once.
  const waiting = p.result();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await server.nearby.answer(p.session, true), true);
  const allowed = await waiting;
  assert.equal(allowed.json.status, 'allowed');
  const link = parsePairingLink(allowed.json.link);
  assert.deepEqual([link.version, link.publicKeySha256, link.addresses, link.name], [2, p.S.toString('hex'), [`https://127.0.0.1:${f.port}`], "David's Mac mini"]);
  // A retry gets the same answer (no second code), and Allow cannot be replayed.
  assert.deepEqual((await p.result()).json, allowed.json);
  assert.equal(await server.nearby.answer(p.session, true), false);
  assert.deepEqual(server.nearby.pending(), []);
  // The link pairs through the ordinary exchange, and the credential works.
  const paired = await call(f, '/v1/pair', {code: link.code, deviceName: 'Test iPhone'});
  assert.equal(paired.status, 200);
  const device = (await f.store.listDevices()).find(d => d.deviceId === paired.json.deviceId);
  assert.deepEqual([device.deviceName, device.scopes.includes('printer-handoff:use')], ['Test iPhone', true]);
  await server.close();
  assert.equal(adverts[0].closed, true);
});

test('the commit binds the key: a wrong key ends the session, and each step happens once, in order', async t => {
  const f = await fixture(t);
  const {server} = await start(t, f);
  const a = await phone(f);
  assert.equal((await a.result()).status, 401, 'no result before the reveal');
  const wrong = await call(f, '/v1/pair/nearby/reveal', {session: a.session, key: b64(randomBytes(32))});
  assert.equal(wrong.status, 401);
  assert.equal((await a.reveal()).status, 401, 'a failed reveal ends the session');
  const b = await phone(f);
  assert.equal((await b.reveal()).status, 200);
  assert.equal((await b.reveal()).status, 401, 'revealed once');
  assert.equal(server.nearby.pending().length, 1);
  assert.equal((await call(f, '/v1/pair/nearby/result', {session: b.session, key: b64(randomBytes(32))})).status, 401);
  assert.deepEqual(server.nearby.pending(), [], 'a wrong key at the result ends it too');
  assert.equal(await server.nearby.answer(b.session, true), false);
});

test('deny answers the phone; open sessions and pairing attempts are both limited', async t => {
  const f = await fixture(t);
  const {server} = await start(t, f);
  const p = await phone(f);
  await p.reveal();
  assert.equal(await server.nearby.answer(p.session, false), true);
  assert.deepEqual((await p.result()).json, {status: 'denied'});
  assert.deepEqual((await p.result()).json, {status: 'denied'}, 'a retry hears the same answer');
  // Three more starts: attempts 2 to 4, four open sessions (the denied one waits out its pickup minute).
  for (let i = 0; i < 3; i++) await phone(f, `phone ${i}`);
  // Attempt 5 fits the minute's budget of five but not the four open sessions; the sixth fits neither.
  assert.equal((await call(f, '/v1/pair/nearby', {commit: b64(randomBytes(32)), deviceName: 'five'})).status, 429);
  assert.equal((await call(f, '/v1/pair/nearby', {commit: b64(randomBytes(32)), deviceName: 'six'})).status, 429);
  assert.equal((await call(f, '/v1/pair', {code: 'A'.repeat(32), deviceName: 'qr'})).status, 429);
  // Unrevealed sessions never reach the Mac's list.
  assert.deepEqual(server.nearby.pending(), []);
});

test('at most four open sessions; sessions expire, and an allowed link waits a minute for pickup', async () => {
  let now = 1_800_000_000_000;
  const minted = [];
  const auth = {async createPairing(login, scopes, link) { minted.push({login, scopes, link}); return {qrPayload: `link-${minted.length}`}; }};
  const nearby = new NearbyPairing({auth, login: 'lan', publicKeySha256: 'ab'.repeat(32), link: () => ({addresses: ['https://10.0.0.2:9077'], name: 'Mac'}), now: () => now});
  const begin = () => { const key = randomBytes(32); const s = nearby.start({commit: b64(sha(nearbyCommitInput(key))), deviceName: 'p'}); return {...s, key: b64(key)}; };
  const sessions = [begin(), begin(), begin(), begin()];
  assert.throws(begin, e => e.code === 'rate-limited');
  for (const s of sessions) nearby.reveal({session: s.session, key: s.key});
  // The code uses this Mac's key, the phone's key and the nonce.
  const [first] = sessions;
  assert.equal(nearby.pending()[0].code, nearbyCodeFromDigest(sha(nearbyCodeInput(Buffer.from('ab'.repeat(32), 'hex'), Buffer.from(first.key, 'base64url'), Buffer.from(first.nonce, 'base64url')))));
  now += NEARBY_SESSION_MS - 1;
  assert.equal(nearby.pending().length, 4);
  assert.equal(await nearby.answer(first.session, true), true);
  assert.deepEqual(minted, [{login: 'lan', scopes: minted[0].scopes, link: {addresses: ['https://10.0.0.2:9077'], publicKeySha256: 'ab'.repeat(32), name: 'Mac'}}]);
  assert.ok(minted[0].scopes.includes('printer-handoff:use'));
  now += 1;
  // The other three expired; the allowed one waits for pickup, and a fresh start fits again.
  assert.deepEqual(nearby.pending(), []);
  assert.doesNotThrow(begin);
  now += NEARBY_PICKUP_MS - 2;
  assert.deepEqual(await nearby.result({session: first.session, key: first.key}), {status: 'allowed', link: 'link-1'});
  const late = begin(); nearby.reveal({session: late.session, key: late.key});
  await nearby.answer(late.session, false);
  now += NEARBY_PICKUP_MS;
  await assert.rejects(nearby.result({session: late.session, key: late.key}), e => e.code === 'unauthorized');
  // A malformed body is the caller's error.
  for (const bad of [{}, {commit: 'x', deviceName: 'p'}, {commit: b64(randomBytes(32)), deviceName: ''}])
    assert.throws(() => nearby.start(bad), e => e.constructor.name === 'NearbyInputError');
});

test('a wait the phone gave up on never takes the answer from the one still listening', async () => {
  let now = 1_800_000_000_000;
  const auth = {async createPairing() { return {qrPayload: 'link'}; }};
  const nearby = new NearbyPairing({auth, login: 'lan', publicKeySha256: 'ef'.repeat(32), link: () => ({addresses: ['https://10.0.0.2:9077']}), now: () => now});
  const key = randomBytes(32);
  const {session} = nearby.start({commit: b64(sha(nearbyCommitInput(key))), deviceName: 'p'});
  const body = {session, key: b64(key)};
  nearby.reveal(body);
  // A dropped connection the Mac hasn't noticed, a hung-up wait, then the phone's live retry.
  const stale = nearby.result(body), gone = new AbortController(), aborted = nearby.result(body, gone.signal), live = nearby.result(body);
  gone.abort();
  assert.deepEqual(await aborted, {status: 'waiting', expiresAt: now + NEARBY_SESSION_MS});
  assert.equal(await nearby.answer(session, true), true);
  assert.deepEqual([await stale, await live], [{status: 'allowed', link: 'link'}, {status: 'allowed', link: 'link'}]);
  now += NEARBY_PICKUP_MS - 1;
  assert.deepEqual(await nearby.result(body), {status: 'allowed', link: 'link'});
  now += 1;
  await assert.rejects(nearby.result(body), e => e.code === 'unauthorized');
});

test('Allow is answered once, even when clicked twice while the code is minted', async () => {
  let release;
  const auth = {createPairing: () => new Promise(r => { release = () => r({qrPayload: 'link'}); })};
  const nearby = new NearbyPairing({auth, login: 'lan', publicKeySha256: 'cd'.repeat(32), link: () => ({addresses: ['https://10.0.0.2:9077']})});
  const key = randomBytes(32);
  const {session} = nearby.start({commit: b64(sha(nearbyCommitInput(key))), deviceName: 'p'});
  nearby.reveal({session, key: b64(key)});
  const one = nearby.answer(session, true), two = nearby.answer(session, true);
  assert.deepEqual(nearby.pending(), [], 'not listed while it is being answered');
  release();
  assert.deepEqual([await one, await two], [true, false]);
});

test('a waiting phone is released by its own hang-up and by close(); other routes answer as before', async t => {
  const f = await fixture(t);
  const {server} = await start(t, f);
  for (const [path, body, status] of [
    ['/v1/pair/nearby', 'not json', 400], ['/v1/pair/nearby', {commit: 'short', deviceName: 'p'}, 400],
    ['/v1/pair/nearby/reveal', {session: 'x', key: 'y'}, 400], ['/v1/pair/nearby/other', {}, 404],
  ]) assert.equal((await call(f, path, body)).status, status, path);
  assert.equal((await call(f, '/v1/pair/nearby/result', undefined, {method: 'GET'})).status, 405);
  const p = await phone(f);
  await p.reveal();
  const gone = new AbortController();
  const hungUp = p.result({signal: gone.signal});
  await new Promise(r => setTimeout(r, 100));
  gone.abort();
  await assert.rejects(hungUp);
  // The session survives the phone's hang-up; it can ask again.
  assert.equal(server.nearby.pending().length, 1);
  const waiting = p.result().catch(error => error);
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  await server.close();
  const outcome = await waiting;
  assert.ok(outcome instanceof Error || outcome.status === 401, 'close() ends the wait');
  assert.ok(Date.now() - started < 5_000);
});

test('without the nearby option the routes do not exist, and nearby needs LAN pairing', async t => {
  const f = await fixture(t);
  const server = await startCompanionServer({remoteAuth: f.store, lanTls: {cert: f.cert, key: f.key}});
  t.after(() => server.close());
  assert.equal(server.nearby, undefined);
  assert.equal((await call(f, '/v1/pair/nearby', {commit: b64(randomBytes(32)), deviceName: 'p'})).status, 404);
  await assert.rejects(startCompanionServer({port: 0, nearby: {name: 'x'}}), /Nearby pairing requires LAN pairing/);
});

test('the switch needs the v2 addresses and fails closed on any other value', () => {
  const cli = new URL('../dist/server-cli.js', import.meta.url).pathname;
  for (const env of [{SCAN_TO_MAKE_NEARBY_PAIRING: '1'}, {SCAN_TO_MAKE_NEARBY_PAIRING: 'yes', SCAN_TO_MAKE_LAN_ALL_ADDRESSES: '1'}]) {
    const run = spawnSync(process.execPath, [cli], {env: {PATH: process.env.PATH, ...env}, encoding: 'utf8', timeout: 20_000});
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /SCAN_TO_MAKE_NEARBY_PAIRING must be 1 when set, with SCAN_TO_MAKE_LAN_ALL_ADDRESSES=1/);
  }
});

/** A stand-in for dns-sd: records each spawn and lets the test write its output or end it. */
function fakeDnsSd() {
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {command, args, options, stdout: new PassThrough(), exitCode: null, signalCode: null, signals: []});
    child.kill = signal => { child.signals.push(signal); if (child.exitCode === null && child.signalCode === null) setImmediate(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
    children.push(child);
    return child;
  };
  return {children, spawn};
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('the advert: dns-sd -R on macOS, re-registered after a refusal or exit, and withdrawn on close', async () => {
  assert.equal(advertise({name: 'Mac', port: 9077, txt: {}, platform: 'win32', spawn: () => assert.fail('spawned')}), undefined);
  const dns = fakeDnsSd();
  const advert = advertise({name: "David's Mac mini", port: 9077, txt: {v: '1', k: 'ab'.repeat(32)}, platform: 'darwin', spawn: dns.spawn, retryMs: 10});
  assert.equal(dns.children.length, 1);
  assert.deepEqual([dns.children[0].command, dns.children[0].args, dns.children[0].options.stdio],
    ['/usr/bin/dns-sd', ['-R', "David's Mac mini", '_scantomake._tcp', 'local', '9077', 'v=1', `k=${'ab'.repeat(32)}`], ['ignore', 'pipe', 'ignore']]);
  // The first registration refused before the user answered the Local Network alert: dns-sd keeps running, so it is ended and retried.
  dns.children[0].stdout.write(" 9:46:59.222  Got a reply for service David's Mac mini._scantomake._tcp.local.: Error -65570\n");
  await tick(60);
  assert.deepEqual(dns.children[0].signals, ['SIGTERM']);
  assert.equal(dns.children.length, 2);
  dns.children[1].stdout.write(" 9:47:00.100  Got a reply for service David's Mac mini._scantomake._tcp.local.: Name now registered and active\n");
  await tick();
  assert.deepEqual(dns.children[1].signals, [], 'a live registration is left alone');
  // dns-sd missing or killed: tried again.
  dns.children[1].exitCode = 1; dns.children[1].emit('exit', 1, null);
  await tick(60);
  assert.equal(dns.children.length, 3);
  dns.children[2].emit('error', new Error('ENOENT'));
  await tick(60);
  assert.equal(dns.children.length, 4);
  await advert.close();
  assert.deepEqual(dns.children[3].signals, ['SIGTERM']);
  await tick(60);
  assert.equal(dns.children.length, 4, 'nothing restarts after close');
});

test('the advert on Linux: avahi-publish -s through the Avahi daemon, its stderr read, re-published after it exits, withdrawn on close', async () => {
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, {command, args, options, stderr: new PassThrough(), exitCode: null, signalCode: null, signals: []});
    child.kill = signal => { child.signals.push(signal); if (child.exitCode === null && child.signalCode === null) setImmediate(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return true; };
    children.push(child);
    return child;
  };
  const advert = advertise({name: 'Workshop PC', port: 9077, txt: {v: '1', k: 'cd'.repeat(32)}, platform: 'linux', spawn, retryMs: 10});
  assert.deepEqual([children[0].command, children[0].args, children[0].options.stdio],
    ['/usr/bin/avahi-publish', ['-s', 'Workshop PC', '_scantomake._tcp', '9077', 'v=1', `k=${'cd'.repeat(32)}`], ['ignore', 'ignore', 'pipe']]);
  children[0].stderr.write("Established under name 'Workshop PC'\n");
  await tick();
  assert.deepEqual(children[0].signals, [], 'a live registration is left alone');
  // No daemon yet, or Avahi dropped it: avahi-publish exits by itself and is started again.
  children[0].stderr.write('Failed to create client object: Daemon not running\n');
  children[0].exitCode = 1; children[0].emit('exit', 1, null);
  await tick(60);
  assert.equal(children.length, 2);
  children[1].emit('error', new Error('ENOENT'));
  await tick(60);
  assert.equal(children.length, 3, 'avahi-utils missing is retried, never fatal');
  await advert.close();
  assert.deepEqual(children[2].signals, ['SIGTERM']);
  await tick(60);
  assert.equal(children.length, 3, 'nothing restarts after close');
});

test('instance names fit one DNS label without splitting a character', () => {
  assert.equal(instanceName("David's Mac mini"), "David's Mac mini");
  assert.equal(instanceName('  \u0007 '), 'Scan to Make');
  const long = 'é'.repeat(40);
  assert.equal(instanceName(long), 'é'.repeat(31));
  assert.ok(Buffer.byteLength(instanceName('🖨'.repeat(20))) <= 63);
  assert.equal(instanceName('🖨'.repeat(20)), '🖨'.repeat(15));
});
