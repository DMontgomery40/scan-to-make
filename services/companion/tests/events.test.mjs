import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {CounterpartEventSchema, EventsPageSchema} from '@scan-to-make/contracts/counterpart';
import {EventLog, EVENT_RETENTION_MS} from '../dist/events/log.js';
import {eventWords, objectStatus, NOTIFY} from '../dist/events/words.js';
import {LiveActivityTokenStore} from '../dist/devices/live-activity-tokens.js';
import {DevicePresence} from '../dist/devices/presence.js';
import {RemoteAuthStore, deviceNameFromHeader} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {pruneLegacyDevices, LEGACY_DEVICE_IDLE_MS} from '../dist/devices/legacy.js';
import {methodDeadlineMs} from '../dist/local-control.js';

const until = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };
const PROJECT = '3f1c2a9e-5b7d-4e21-9a6f-0c8d1e2f3a4b', PRINT = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
const draft = (type, extra = {}) => ({id: randomUUID(), type, projectId: PROJECT, printId: PRINT, destinationId: 'current', printerName: 'Bambu Lab P1S', ...extra});
async function openLog(t, {now = () => Date.now(), context = async () => ({title: 'Mic mount', size: '60 × 45 × 22 mm'})} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'event-log-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'events.ndjson');
  const log = await new EventLog(path, {now, context}).open({prune: false});
  t.after(() => log.close());
  return {root, path, log, reopen: () => new EventLog(path, {now, context}).open({prune: false})};
}

test('events get a monotonic seq, the words from one place, and survive a restart', async t => {
  const {log, path, reopen} = await openLog(t);
  const a = await log.append(draft('print.milestone', {data: {progress: 50, remainingSec: 1140, layer: 37, totalLayers: 74, state: 'printing'}, frame: `prints/${PRINT}/frames/${randomUUID()}.jpg`}));
  const b = await log.append(draft('print.paused', {data: {problems: [{code: 'x', message: 'AMS slot 1 ran out of filament'}]}}));
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(a.title, 'Mic mount is halfway');
  assert.equal(a.body, '19 min left · layer 37 of 74 · Bambu Lab P1S');
  assert.equal(a.notify, 'active');
  assert.equal(b.title, 'Bambu Lab P1S paused Mic mount');
  assert.equal(b.notify, 'timeSensitive');
  for (const line of (await readFile(path, 'utf8')).trim().split('\n')) CounterpartEventSchema.parse(JSON.parse(line));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const again = await reopen();
  assert.equal(again.latest, 2);
  assert.equal((await again.append(draft('print.done'))).seq, 3);
});

test('seven-day retention keeps numbering going, and a page says when history was pruned or the log was reset', async t => {
  let now = Date.parse('2026-11-01T00:00:00Z');
  const {log, reopen} = await openLog(t, {now: () => now});
  for (let i = 0; i < 3; i++) await log.append(draft('print.status', {data: {progress: i}}));
  now += EVENT_RETENTION_MS + 1;
  await log.append(draft('print.done'));
  await log.prune();
  const page = log.page(0);
  assert.deepEqual(page.events.map(e => e.seq), [4]);
  assert.equal(page.truncated, true);
  assert.equal(page.next, 4);
  // Even with nothing retained, the next event continues the numbering.
  now += EVENT_RETENTION_MS + 1;
  await log.prune();
  const empty = await reopen();
  assert.equal(empty.page(0).events.length, 0);
  assert.equal((await empty.append(draft('print.started'))).seq, 5);
  assert.deepEqual(empty.page(99), {events: [], next: 5, latest: 5, reset: true});
  // A client that saw nothing since before the pruned history is told to resync, even with nothing retained.
  now += EVENT_RETENTION_MS + 1;
  await empty.prune();
  assert.deepEqual(empty.page(1), {events: [], next: 1, latest: 5, truncated: true});
  assert.deepEqual(empty.page(0, 0), {events: [], next: 5, latest: 5});
  EventsPageSchema.parse(empty.page(4));
});

test('a long poll returns as soon as an event arrives, at its time limit otherwise, and when its caller leaves', async t => {
  const {log} = await openLog(t);
  const waiting = log.wait(0, {waitMs: 5000});
  setTimeout(() => void log.append(draft('print.started', {data: {stage: 'Heating the bed'}})), 20);
  const started = Date.now();
  const page = await waiting;
  assert.ok(Date.now() - started < 2000);
  assert.equal(page.events[0].body, 'Heating the bed');
  const quiet = await log.wait(page.next, {waitMs: 30});
  assert.deepEqual(quiet.events, []);
  assert.equal(quiet.next, page.next);
  const controller = new AbortController();
  const left = log.wait(page.next, {waitMs: 25000, signal: controller.signal});
  controller.abort();
  assert.deepEqual((await left).events, []);
  assert.equal(log.waiting, 0);
});

test('every event type has words within the limits, and the state line matches the PRD table', () => {
  const context = {title: 'Mic mount', printer: 'Bambu Lab P1S', size: '60 × 45 × 22 mm', item: 'a spool', question: 'Can you take a close-up of the clip?', reason: 'Blender stopped responding.'};
  for (const type of Object.keys(NOTIFY)) {
    const words = eventWords(type, {progress: 25, remainingSec: 3900, layer: 9, totalLayers: 74, problems: [{code: 'x', message: 'AMS slot 1 ran out of filament'}]}, context);
    assert.ok(words.title.length > 0 && words.title.length <= 200, type);
    assert.ok(words.body.length > 0 && words.body.length <= 500, type);
  }
  assert.equal(eventWords('print.milestone', {progress: 25, remainingSec: 3900}, context).title, 'Mic mount is a quarter done');
  assert.equal(eventWords('print.milestone', {progress: 25, remainingSec: 3900}, context).body, '1 h 5 min left · Bambu Lab P1S');
  assert.equal(eventWords('print.paused', {problems: [{code: 'x', message: 'AMS slot 1 ran out of filament'}]}, context).body, 'AMS slot 1 ran out of filament');
  assert.equal(eventWords('print.not-started', undefined, context).title, "Bambu Lab P1S didn't start Mic mount");
  assert.equal(objectStatus({state: 'new', photos: []}).text, 'Sending to your Mac');
  assert.equal(objectStatus({state: 'ready', current: {sizeMm: [60.2, 45.1, 21.7]}}).text, 'Ready to print · 60 × 45 × 22 mm');
  assert.equal(objectStatus({state: 'printing', print: {destination: {name: 'Bambu Lab P1S'}}}).phase, 'preparing');
  const printing = objectStatus({state: 'printing', print: {destination: {name: 'Bambu Lab P1S'}, dispatchedAt: '2026-11-01T18:00:00Z',
    monitor: {phase: 'watching'}, live: {state: 'printing', job: {progress: 42.4, remainingSec: 1500}}}});
  assert.deepEqual(printing, {phase: 'printing', text: 'Printing on Bambu Lab P1S · 42% · 25 min left', symbol: 'printer.fill', tint: 'green'});
  assert.equal(objectStatus({state: 'printed', print: {monitor: {phase: 'ended', endedAt: '2026-11-01T19:00:00Z'}}}).text, 'Printed Nov 1');
  assert.equal(objectStatus({state: 'needs-closeup', question: {closeup: 'the clip'}}).text, 'Needs you · Can you take a close-up of the clip?');
  assert.equal(objectStatus({state: 'failed', failure: 'Bambu Lab P1S is printing something else.'}).tint, 'red');
  assert.deepEqual(objectStatus({state: 'sent', print: {destination: {name: 'Bambu Lab P1S'}}}),
    {phase: 'sent', text: "Sent to Bambu Lab P1S · Counterpart can't follow this print", symbol: 'paperplane', tint: 'secondary'});
  assert.equal(objectStatus({state: 'sent', print: {sentVia: 'bambu-connect'}}).text, 'Finish on your Mac: press Print in Bambu Connect');
  assert.equal(eventWords('print.sent', undefined, context).title, 'Sent Mic mount to Bambu Lab P1S');
});

const forwarded = JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url), 'utf8')).expected;
async function serve(t) {
  const root = await mkdtemp(join(tmpdir(), 'events-http-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test']});
  const pair = async name => remoteAuth.exchange('alice@example.test', {code: (await remoteAuth.createPairing('alice@example.test')).code, deviceName: name});
  const phone = await pair('David’s iPhone');
  const events = await new EventLog(join(root, 'events.ndjson'), {context: async () => ({title: 'Mic mount'})}).open({prune: false});
  t.after(() => events.close());
  const liveActivityTokens = new LiveActivityTokenStore(join(root, 'live-activity-tokens.json'));
  const presence = new DevicePresence(join(root, 'auth', 'device-presence.json'));
  const server = await startCompanionServer({port: 0, remoteAuth, events, liveActivityTokens, presence});
  t.after(() => server.close());
  const headers = {authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId};
  const wire = (path, {method = 'GET', headers: extra = {}, body} = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(server.url + path, {method, headers: {...forwarded, ...headers, ...extra}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    req.on('error', reject);
    req.end(body);
  });
  const dispatch = createControlDispatcher({auth: remoteAuth, companionVersion: 'test', events, liveActivityTokens, presence});
  return {root, remoteAuth, phone, events, wire, dispatch, pair, presence};
}

test('GET /v1/events long-polls on the phone pairing; events.wait gives the Mac the same page', async t => {
  const f = await serve(t);
  const polling = f.wire('/v1/events?after=0&wait=5');
  setTimeout(() => void f.events.append(draft('print.done')), 30);
  const reply = await polling;
  assert.equal(reply.status, 200);
  const page = EventsPageSchema.parse(reply.json());
  assert.deepEqual(page.events.map(e => [e.seq, e.title]), [[1, 'Mic mount is done']]);
  assert.deepEqual(await f.dispatch('events.wait', {after: 0, timeoutMs: 0}), page);
  for (const bad of ['after=-1', 'wait=26', 'limit=501', 'after=1&nope=1', 'after=1.5'])
    assert.equal((await f.wire(`/v1/events?${bad}`)).status, 400, bad);
  assert.equal((await f.wire('/v1/events?after=0', {headers: {authorization: 'Bearer ' + 'x'.repeat(43)}})).status, 401);
  assert.deepEqual((await f.wire('/v1/events?after=0&limit=0')).json(), {events: [], next: 1, latest: 1});
  assert.equal(methodDeadlineMs('events.wait', {after: 0, timeoutMs: 25000}), 30000);
});

test('a pairing revoked while its long poll waits gets no events', async t => {
  const f = await serve(t);
  const polling = f.wire('/v1/events?after=0&wait=5');
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.remoteAuth.revoke(f.phone.deviceId);
  await f.events.append(draft('print.done'));
  const reply = await polling;
  assert.notEqual(reply.status, 200);
});

test('Live Activity tokens: stored per device for the Mac, forgotten on request, and removed with the device', async t => {
  const f = await serve(t);
  const post = body => f.wire('/v1/devices/live-activity-tokens', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post({pushToStart: '80F1A2B3C4D5E6F708192A3B4C5D6E7F'})).status, 200);
  assert.deepEqual((await post({activity: {printId: PRINT, token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90'}})).json(), {stored: true});
  for (const bad of [{}, {pushToStart: 'not-hex'}, {activity: {printId: 'x', token: 'a1b2c3d4e5f60718'}}, {pushToStart: 'a1b2c3d4e5f60718', extra: 1}])
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  const tokens = await f.dispatch('liveActivity.tokens', {});
  assert.deepEqual(tokens.pushToStart.map(item => [item.deviceId, item.token]), [[f.phone.deviceId, '80f1a2b3c4d5e6f708192a3b4c5d6e7f']]);
  assert.deepEqual(tokens.activities.map(item => [item.printId, item.deviceId, item.token]), [[PRINT, f.phone.deviceId, 'a1b2c3d4e5f60718293a4b5c6d7e8f90']]);
  assert.equal((await stat(join(f.root, 'live-activity-tokens.json'))).mode & 0o777, 0o600);
  await post({activity: {printId: PRINT, token: null}});
  assert.deepEqual((await f.dispatch('liveActivity.tokens', {})).activities, []);
  await f.dispatch('devices.remove', {deviceId: f.phone.deviceId});
  assert.deepEqual(await f.dispatch('liveActivity.tokens', {}), {pushToStart: [], activities: []});
});

test('devices.list shows each phone\'s model and when it was last seen; re-pairing the same install keeps one device', async t => {
  const f = await serve(t);
  assert.equal((await f.wire('/v1/events?after=0', {headers: {'x-scan-device-model': 'iPhone18,2'}})).status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  const [device] = (await f.dispatch('devices.list', {})).devices;
  assert.equal(device.model, 'iPhone18,2');
  assert.ok(device.lastSeenAt > Date.now() - 60_000);
  // A bad model header is ignored, never stored.
  await f.wire('/v1/events?after=0', {headers: {'x-scan-device-model': '<script>'}});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.dispatch('devices.list', {})).devices[0].model, 'iPhone18,2');
  const key = 'k'.repeat(43);
  const pairInstall = async () => f.remoteAuth.exchange('alice@example.test', {code: (await f.remoteAuth.createPairing('alice@example.test')).code, deviceName: 'David’s iPad', installationKey: key});
  const first = await pairInstall(), second = await pairInstall();
  assert.equal(first.deviceId, second.deviceId);
  assert.equal((await f.dispatch('devices.list', {})).devices.length, 2);

});

test('a prune running while an event is written never loses it, and a torn last line is repaired before appending', async t => {
  const {log, path, reopen} = await openLog(t);
  await log.append(draft('print.started'));
  const [appended] = await Promise.all([log.append(draft('print.done')), log.prune()]);
  assert.deepEqual((await reopen()).page(0).events.map(e => e.seq), [1, appended.seq]);
  const {appendFile} = await import('node:fs/promises');
  await appendFile(path, '{"v":1,"seq":3,"id":"half');
  const repaired = await reopen();
  const next = await repaired.append(draft('print.failed'));
  assert.equal(next.seq, 3);
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line).seq), [1, 2, 3]);

});

test('two first requests at once both leave their device\'s presence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'presence-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const presence = new DevicePresence(join(root, 'device-presence.json'));
  const a = randomUUID(), b = randomUUID();
  await Promise.all([presence.seen(a, 'iPhone18,2'), presence.seen(b, 'iPad16,3')]);
  assert.equal((await presence.get(a)).model, 'iPhone18,2');
  assert.equal((await presence.get(b)).model, 'iPad16,3');
  const fresh = new DevicePresence(join(root, 'device-presence.json'));
  assert.equal((await fresh.get(a)).model, 'iPhone18,2');
  assert.equal((await fresh.get(b)).model, 'iPad16,3');
});

const DAY = 24 * 60 * 60 * 1000;
async function devicesFixture(t, start) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-devices-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 3}));
  const clock = {now: start};
  const auth = await RemoteAuthStore.create(join(root, 'auth'), {host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test']}, () => clock.now);
  const pair = async (deviceName, installationKey) => auth.exchange('alice@example.test', {code: (await auth.createPairing('alice@example.test')).code, deviceName,
    ...(installationKey ? {installationKey} : {})});
  const presencePath = join(root, 'auth', 'device-presence.json');
  const presence = () => new DevicePresence(presencePath, {now: () => clock.now});
  const tokens = new LiveActivityTokenStore(join(root, 'live-activity-tokens.json'));
  return {root, auth, pair, clock, presence, presencePath, tokens};
}

test('devices.list marks pairings from before stable install identity as legacy', async t => {
  const f = await devicesFixture(t, Date.now());
  const old = await f.pair('My phone'), current = await f.pair('David’s iPhone', 'k'.repeat(43));
  const dispatch = createControlDispatcher({auth: f.auth, companionVersion: 'test', presence: f.presence()});
  const listed = Object.fromEntries((await dispatch('devices.list', {})).devices.map(device => [device.deviceId, device]));
  assert.equal(listed[old.deviceId].legacy, true);
  assert.equal('legacy' in listed[current.deviceId], false, 'a device with an install identity is never legacy');
  assert.deepEqual(await f.auth.legacyDeviceIds(), new Set([old.deviceId]));
});

test('legacy devices unused for 14 days from this release are removed; a used one stays until it goes quiet', async t => {
  const release = Date.UTC(2026, 10, 1);
  const f = await devicesFixture(t, release);
  const idle = await f.pair('My phone'), used = await f.pair('My phone'), current = await f.pair('David’s iPhone', 'k'.repeat(43));
  await f.tokens.store(idle.deviceId, {pushToStart: 'a'.repeat(64)});
  let presence = f.presence();
  assert.equal(await presence.since(), release, 'the 14 days count from the first run of this version');
  f.clock.now = release + 10 * DAY;
  await presence.seen(used.deviceId, 'iPhone15,2');
  f.clock.now = release + LEGACY_DEVICE_IDLE_MS - 1;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now, tokens: f.tokens}), [], 'nothing before 14 days');
  // A restart keeps the start of the 14 days.
  presence = f.presence();
  f.clock.now = release + LEGACY_DEVICE_IDLE_MS;
  assert.equal(await presence.since(), release);
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now, tokens: f.tokens}), [idle.deviceId]);
  const left = (await f.auth.listDevices()).map(device => device.deviceId).sort();
  assert.deepEqual(left, [used.deviceId, current.deviceId].sort(), 'a recently used legacy device and a current one stay');
  assert.deepEqual((await f.tokens.list()).pushToStart, [], 'its Live Activity tokens go with it');
  await assert.rejects(f.auth.authorize('alice@example.test', idle.deviceId, idle.token, 'projects:read'));
  // The used one goes 14 days after its last request; a current device never does.
  f.clock.now = release + 10 * DAY + LEGACY_DEVICE_IDLE_MS;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now, tokens: f.tokens}), [used.deviceId]);
  // (29 days: still inside the 30-day credential lifetime, after which any unrefreshed pairing lapses by itself.)
  f.clock.now = release + 29 * DAY;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now}), []);
  assert.deepEqual((await f.auth.listDevices()).map(device => device.deviceId), [current.deviceId]);
});

test('a legacy pairing made after this release gets its own 14 days from pairing, even before its first request', async t => {
  const release = Date.UTC(2026, 10, 1);
  const f = await devicesFixture(t, release);
  const presence = f.presence();
  assert.equal(await presence.since(), release);
  // An older app pairs (no installation key) 20 days after the release and makes no request yet.
  const later = await RemoteAuthStore.open(join(f.root, 'auth'), () => release + 20 * DAY);
  const phone = await later.exchange('alice@example.test', {code: (await later.createPairing('alice@example.test')).code, deviceName: 'My phone'});
  f.clock.now = release + 21 * DAY;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now}), [], 'paired a day ago');
  f.clock.now = release + 20 * DAY + LEGACY_DEVICE_IDLE_MS;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now}), [phone.deviceId]);
});

test('a legacy device that makes a request is recognised: last seen and model recorded, and it is kept', async t => {
  const release = Date.UTC(2026, 10, 1);
  const f = await devicesFixture(t, release);
  const phone = await f.pair('My phone');
  // Presence written by the previous version (a plain map) counts from this release too, and keeps what it knew.
  await writeFile(f.presencePath, JSON.stringify({[phone.deviceId]: {lastSeenAt: release - 30 * DAY}}));
  f.clock.now = release + DAY;
  const presence = f.presence();
  assert.equal(await presence.since(), release + DAY);
  const server = await startCompanionServer({port: 0, remoteAuth: f.auth, presence});
  t.after(() => server.close());
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(server.url + '/healthz', {headers: {...forwarded, authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId, 'x-scan-device-model': 'iPhone16,1'}},
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  const dispatch = createControlDispatcher({auth: f.auth, companionVersion: 'test', presence});
  const [listed] = (await dispatch('devices.list', {})).devices;
  assert.deepEqual([listed.legacy, listed.model, listed.lastSeenAt], [true, 'iPhone16,1', release + DAY]);
  f.clock.now = release + DAY + LEGACY_DEVICE_IDLE_MS - 1;
  assert.deepEqual(await pruneLegacyDevices(f.auth, presence, {now: () => f.clock.now}), []);
  assert.equal(JSON.parse(await readFile(f.presencePath, 'utf8')).version, 2);
});

test('a phone\'s X-Scan-Device-Name renames its device when it changes, never to nothing, at most 64 characters', async t => {
  const f = await devicesFixture(t, Date.now());
  const phone = await f.pair('My phone');
  const server = await startCompanionServer({port: 0, remoteAuth: f.auth, presence: f.presence()});
  t.after(() => server.close());
  const health = name => new Promise((resolve, reject) => {
    const req = httpRequest(server.url + '/healthz', {headers: {...forwarded, authorization: `Bearer ${phone.token}`, 'x-scan-device': phone.deviceId, 'x-scan-device-name': name}},
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  // Read the file itself: listDevices takes the store's lock, which a rename then can't get.
  const name = async () => JSON.parse(await readFile(join(f.root, 'auth', 'auth.json'), 'utf8')).devices.find(device => device.deviceId === phone.deviceId).deviceName;
  assert.equal(await health(encodeURIComponent('David’s iPhone 17 Pro')), 200);
  await until(async () => await name() === 'David’s iPhone 17 Pro');
  await health(encodeURIComponent('   '));
  await health('%E0%A4%A');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await name(), 'David’s iPhone 17 Pro', 'an empty or broken name never replaces one');
  assert.equal(deviceNameFromHeader('x'.repeat(100)).length, 64);
  assert.equal(deviceNameFromHeader(Buffer.from('Ada’s iPad', 'utf8').toString('latin1')), 'Ada’s iPad', 'raw UTF-8 bytes too');
  assert.equal(deviceNameFromHeader('a%0Ab'), 'ab');
});
