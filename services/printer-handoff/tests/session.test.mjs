import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  HandoffBundleStore, InMemoryElicitationRelay, PrinterHandoffRunner, PrinterSession, PrinterSessionPool,
  SESSION_BACKOFF_MS, SESSION_IDLE_CLOSE_MS,
} from '../dist/index.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
/** Deterministic time: timers fire only when the test advances the clock. */
export class FakeClock {
  t = 0; timers = [];
  now() { return this.t; }
  setTimeout(fn, ms) { const handle = {at: this.t + ms, fn}; this.timers.push(handle); return handle; }
  clearTimeout(handle) { this.timers = this.timers.filter(item => item !== handle); }
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

const TOOLS = ['get_printer_status', 'camera_snapshot', 'slice_stl', 'print_3mf', 'pause_print', 'counterpart_print_progress']
  .map(name => ({name, inputSchema: {type: 'object', properties: {}}}));
function fakes({failConnect = () => false, gate} = {}) {
  const log = [], clients = [];
  const factory = (_config, {onClose}) => {
    const id = clients.length + 1;
    const client = {
      id, catalog: undefined, closed: false,
      async connect() {
        if (failConnect()) { log.push(['connect-failed', id]); throw Object.assign(new Error('no'), {code: 'connection-failed'}); }
        client.catalog = {server: {name: 'fake', version: '1'}, tools: TOOLS};
        log.push(['connect', id]);
        return client.catalog;
      },
      hasTool: name => TOOLS.some(tool => tool.name === name),
      getTool: name => TOOLS.find(tool => tool.name === name),
      async callTool(name, _args, options = {}) {
        log.push(['start', id, name, options.elicitationContext]);
        if (gate) await gate(name);
        log.push(['end', id, name]);
        return {content: [{type: 'text', text: '{}'}]};
      },
      async close() { client.closed = true; log.push(['close', id]); },
      die() { onClose(); },
    };
    clients.push(client);
    return client;
  };
  return {log, clients, factory};
}
const config = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}};

test('every call shares one connection; reads overlap, printer-changing calls take turns, slicing does not wait', async () => {
  const waits = new Map();
  const gate = name => new Promise(resolve => { (waits.get(name) ?? waits.set(name, []).get(name)).push(resolve); });
  const release = name => { for (const resolve of waits.get(name) ?? []) resolve(); waits.set(name, []); };
  const {log, clients, factory} = fakes({gate});
  const session = new PrinterSession('p1s', config, {clientFactory: factory, clock: new FakeClock()});
  const reads = [session.call('counterpart_print_progress'), session.call('camera_snapshot')];
  const print = session.call('print_3mf', {}, {elicitationContext: {bundleId: 'b1'}});
  const pause = session.call('pause_print');
  await flush(); await flush();
  const slice = session.call('slice_stl');
  await flush(); await flush();
  assert.equal(clients.length, 1);
  const started = log.filter(entry => entry[0] === 'start').map(entry => entry[2]);
  assert.deepEqual(started.sort(), ['camera_snapshot', 'counterpart_print_progress', 'print_3mf', 'slice_stl'].sort());
  release('slice_stl'); await slice;
  release('counterpart_print_progress'); release('camera_snapshot'); await Promise.all(reads);
  assert.equal(log.some(entry => entry[0] === 'start' && entry[2] === 'pause_print'), false, 'pause waits for the print call');
  release('print_3mf'); await print; await flush();
  assert.equal(log.some(entry => entry[0] === 'start' && entry[2] === 'pause_print'), true);
  release('pause_print'); await pause;
  // Only the mutex holder tags the printer's questions; reads never carry a tag.
  const contexts = Object.fromEntries(log.filter(entry => entry[0] === 'start').map(entry => [entry[2], entry[3]]));
  assert.deepEqual(contexts.print_3mf, {bundleId: 'b1'});
  assert.deepEqual(contexts.pause_print, {});
  assert.equal(contexts.camera_snapshot, undefined);
  assert.equal(contexts.slice_stl, undefined);
  assert.ok(session.health().lastSuccessAt !== undefined);
});

test('a session closes 120 s after its last holder and call, and the next call opens a new one', async () => {
  const clock = new FakeClock();
  const {clients, factory} = fakes();
  const session = new PrinterSession('p1s', config, {clientFactory: factory, clock});
  const release = session.hold();
  await session.call('counterpart_print_progress');
  await clock.advance(SESSION_IDLE_CLOSE_MS * 3);
  assert.equal(clients[0].closed, false, 'a holder keeps it open');
  release();
  release(); // releasing twice changes nothing
  await clock.advance(SESSION_IDLE_CLOSE_MS - 1);
  assert.equal(clients[0].closed, false);
  await session.call('camera_snapshot'); // a call restarts the idle wait
  await clock.advance(SESSION_IDLE_CLOSE_MS - 1);
  assert.equal(clients[0].closed, false);
  await clock.advance(1);
  assert.equal(clients[0].closed, true);
  assert.equal(session.health().connected, false);
  await session.call('counterpart_print_progress');
  assert.equal(clients.length, 2);
});

test('a lost connection reconnects on the next call after 1, 2, 5, 15 then 30 s; reads during the wait can fail fast', async () => {
  const clock = new FakeClock();
  let failing = false;
  const {clients, factory} = fakes({failConnect: () => failing});
  const session = new PrinterSession('p1s', config, {clientFactory: factory, clock});
  await session.call('counterpart_print_progress');
  clients[0].die();
  assert.equal(session.health().connected, false);
  assert.equal(session.health().retryAt, 1000);
  await assert.rejects(session.call('counterpart_print_progress', {}, {failFast: true}), {code: 'printer-unreachable'});
  failing = true;
  const expected = [...SESSION_BACKOFF_MS.slice(1), 30000, 30000];
  let waited = 1000;
  for (const delay of expected) {
    await clock.advance(waited);
    await assert.rejects(session.call('counterpart_print_progress', {}, {failFast: true}), {code: 'connection-failed'});
    assert.equal(session.health().retryAt - clock.now(), delay);
    waited = delay;
  }
  failing = false;
  // A call that may wait (a print run) waits out the backoff, then reconnects.
  const waiting = session.call('counterpart_print_progress');
  await clock.advance(waited);
  await waiting;
  assert.equal(session.health().consecutiveFailures, 0);
  assert.equal(session.health().connected, true);
});

test('a caller that gives up while waiting for the mutex never blocks the next one', async () => {
  let finish;
  const {log, factory} = fakes({gate: name => name === 'print_3mf' ? new Promise(resolve => { finish = resolve; }) : undefined});
  const session = new PrinterSession('p1s', config, {clientFactory: factory, clock: new FakeClock()});
  const print = session.call('print_3mf');
  await flush(); await flush();
  const controller = new AbortController();
  const cancelled = session.call('cancel_print', {}, {signal: controller.signal, exclusive: true});
  controller.abort();
  await assert.rejects(cancelled, {code: 'cancelled'});
  const pause = session.call('pause_print');
  finish();
  await print; await pause;
  assert.deepEqual(log.filter(entry => entry[0] === 'start').map(entry => entry[2]), ['print_3mf', 'pause_print']);
});

test('the pool keeps one session per destination and closes every MCP process on shutdown', async () => {
  const {clients, factory} = fakes();
  const pool = new PrinterSessionPool({clientFactory: factory, clock: new FakeClock()});
  const a = pool.session('a', config), b = pool.session('b', config);
  assert.equal(pool.session('a', config), a);
  await a.call('camera_snapshot'); await b.call('camera_snapshot');
  await pool.close();
  assert.deepEqual(clients.map(client => client.closed), [true, true]);
  assert.throws(() => pool.session('c', config), {code: 'session-closed'});
  await assert.rejects(a.call('camera_snapshot'), {code: 'session-closed'});
});

const fixture = fileURLToPath(new URL('./fixtures/fixture-printer-server.mjs', import.meta.url));
test('a runner on a shared session prints twice through one MCP process, and a crashed process is replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'printer-session-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const log = join(root, 'calls.jsonl');
  await writeFile(log, '');
  const cfg = {backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [fixture, 'bambu', log], cwd: root, env: {HANDOFF_FIXTURE_PID: '1'}},
    selection: {model: 'p1s'}, timeouts: {connectMs: 5000, toolMs: 5000, elicitationMs: 5000}};
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  relay.subscribe(pending => setImmediate(() => relay.respond(pending.id, {action: 'accept', content: {confirmed: true}})));
  const pool = new PrinterSessionPool();
  t.after(() => pool.close());
  const runner = new PrinterHandoffRunner(cfg, {relay, session: pool.session('current', cfg, {relay})});
  const store = new HandoffBundleStore(join(root, 'bundles'));
  const stl = Buffer.from('solid fixture\n' + ' facet\n'.repeat(20) + 'endsolid fixture\n');
  for (let i = 0; i < 2; i++) {
    const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection: {model: 'p1s'}});
    assert.equal((await runner.runBundle(store, bundle.id)).manifest.status, 'printed');
  }
  const entries = () => readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.equal((await entries()).filter(entry => entry.started).length, 1);
  process.kill((await entries()).find(entry => entry.started).started, 'SIGKILL');
  for (let i = 0; i < 200 && runner.session.health().connected; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runner.session.health().connected, false);
  await new Promise(resolve => setTimeout(resolve, SESSION_BACKOFF_MS[0] + 50));
  const bundle = await store.create({stl, prompt: '', backend: 'bambu-printer-mcp', selection: {model: 'p1s'}});
  assert.equal((await runner.runBundle(store, bundle.id)).manifest.status, 'printed');
  assert.equal((await entries()).filter(entry => entry.started).length, 2);
});
