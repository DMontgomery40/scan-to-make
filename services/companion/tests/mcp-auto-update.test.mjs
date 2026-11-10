import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {McpAutoUpdater, companionBusy, contractCheck, AUTO_EVERY_MS, AUTO_JITTER_MS, AUTO_FIRST_MS, AUTO_FIRST_JITTER_MS, AUTO_BUSY_RETRY_MS, AUTO_OFF_POLL_MS, AUTO_QUIET_TRIES, AUTO_LATEST_TTL_MS} from '../dist/printing/mcp-auto-update.js';
import {PrintGate} from '../dist/printing/print-gate.js';
import {tempDir} from './support/temp.mjs';

// Q9, "Keep printer software up to date". The install itself is McpUpdater's and is tested in mcp-updates.test.mjs;
// these are the schedule, the companion's idle states, and the counterpart/1 check.

/** A scheduler over fakes: targets and versions by package, a scripted busy, and every update recorded. */
function scheduler({targets = [{mcpId: 'mcp-a', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}], versions = {'bambu-printer-mcp': '1.1.50'}, busy = async () => undefined,
  update, enabled = () => true, statePath, now, recovered} = {}) {
  const calls = {latest: [], update: [], busy: 0}, scheduled = [];
  const auto = new McpAutoUpdater({
    enabled, targets: () => targets, statePath, random: () => 0.5, ...(now ? {now} : {}), ...(recovered ? {recovered} : {}),
    latest: async pkg => { calls.latest.push(pkg); const version = typeof versions === 'function' ? versions(pkg) : versions[pkg]; if (version instanceof Error) throw version; return version; },
    busy: async () => { calls.busy++; return busy(); },
    update: async (mcpId, latest, options) => { calls.update.push({mcpId, latest, ...options}); return update ? update(mcpId, latest, options) : {state: 'done', toVersion: latest}; },
    // The timer is ours: each scheduled run is recorded with its delay, and run by the test.
    later: (run, ms) => { const item = {run, ms, cancelled: false}; scheduled.push(item); return () => { item.cancelled = true; }; },
  });
  const next = async () => {
    const item = scheduled.at(-1);
    assert.ok(item && !item.cancelled, 'a run is scheduled');
    scheduled.length = 0;
    item.run();
    for (let i = 0; i < 200 && !scheduled.length; i++) await new Promise(resolve => setImmediate(resolve));
    return scheduled.at(-1)?.ms;
  };
  return {auto, calls, scheduled, next};
}

test('Q9: off does nothing: npm isn\'t asked, nothing is checked or installed, and the setting is read again soon', async () => {
  let on = false;
  const s = scheduler({enabled: () => on});
  assert.deepEqual(await s.auto.runOnce(), {state: 'off'});
  assert.deepEqual(s.calls, {latest: [], update: [], busy: 0});
  s.auto.start();
  assert.equal(await s.next(), AUTO_OFF_POLL_MS, 'off: read again in a few minutes');
  assert.deepEqual(s.calls, {latest: [], update: [], busy: 0});
  // Turned on: the next look runs the check (none has run yet), then the six-hour cadence.
  on = true;
  assert.equal(await s.next(), AUTO_EVERY_MS + AUTO_JITTER_MS / 2);
  assert.deepEqual(s.calls.latest, ['bambu-printer-mcp']);
  assert.equal(s.calls.update.length, 1);
  s.auto.close();
});

test('Q9: the schedule: shortly after start, then every six hours with jitter', async () => {
  const s = scheduler({versions: {'bambu-printer-mcp': '1.1.46'}});
  s.auto.start();
  assert.equal(s.scheduled[0].ms, AUTO_FIRST_MS + AUTO_FIRST_JITTER_MS / 2);
  assert.equal(await s.next(), AUTO_EVERY_MS + AUTO_JITTER_MS / 2);
  assert.deepEqual(s.calls.latest, ['bambu-printer-mcp'], 'npm asked at start');
  assert.equal(s.calls.busy, 0, 'nothing newer: no busy check, no printer read');
  assert.equal(s.calls.update.length, 0);
  s.auto.close();
  assert.ok(s.scheduled.every(item => item.cancelled) || s.scheduled.length === 0);
});

test('Q9: busy defers without touching anything and looks again within a minute; it runs when the work ends', async () => {
  let why = 'Counterpart is sending, slicing or designing';
  const s = scheduler({busy: async () => why});
  s.auto.start();
  assert.equal(await s.next(), AUTO_BUSY_RETRY_MS, 'deferred: soon, not at the next six-hour run');
  assert.equal(s.calls.update.length, 0, 'nothing installed while busy');
  assert.equal(await s.next(), AUTO_BUSY_RETRY_MS, 'still busy: still soon');
  assert.equal(s.calls.update.length, 0);
  why = undefined;
  assert.equal(await s.next(), AUTO_EVERY_MS + AUTO_JITTER_MS / 2, 'the work ended: it ran, and the next run is the usual one');
  assert.deepEqual(s.calls.update, [{mcpId: 'mcp-a', latest: '1.1.50', report: false}]);
  // An update that finds Counterpart started working in the meantime is deferred the same way.
  const raced = scheduler({update: async () => ({state: 'busy'})});
  raced.auto.start();
  assert.equal(await raced.next(), AUTO_BUSY_RETRY_MS);
  s.auto.close(); raced.auto.close();
});

test('Q9: two MCPs with updates install one at a time, each after its own idle check', async () => {
  let running = 0, most = 0;
  const order = [];
  const s = scheduler({
    targets: [{mcpId: 'mcp-bambu', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}, {mcpId: 'mcp-generic', pkg: 'mcp-3d-printer-server', fromVersion: '1.2.20'}],
    versions: {'bambu-printer-mcp': '1.1.50', 'mcp-3d-printer-server': '1.2.26'},
    update: async (mcpId, latest) => {
      running++; most = Math.max(most, running); order.push(`start ${mcpId}`);
      await new Promise(resolve => setTimeout(resolve, 20));
      running--; order.push(`end ${mcpId}`);
      return {state: 'done', toVersion: latest};
    },
  });
  const run = await s.auto.runOnce();
  assert.equal(most, 1, 'never two installs at once');
  assert.deepEqual(order, ['start mcp-bambu', 'end mcp-bambu', 'start mcp-generic', 'end mcp-generic']);
  assert.equal(s.calls.busy, 2, 'idle is checked again before the second');
  assert.deepEqual(run.results.map(item => [item.mcpId, item.toVersion, item.outcome.state]), [['mcp-bambu', '1.1.50', 'done'], ['mcp-generic', '1.2.26', 'done']]);
  // Work that starts after the first install defers the second.
  let checks = 0;
  const t2 = scheduler({targets: [{mcpId: 'a', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}, {mcpId: 'b', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}],
    busy: async () => (++checks > 1 ? 'a printer is being set up' : undefined)});
  assert.deepEqual(await t2.auto.runOnce(), {state: 'deferred', why: 'a printer is being set up'});
  assert.deepEqual(t2.calls.update.map(item => item.mcpId), ['a']);
});

test('Q9: a network failure is quiet and asked again at the next run', async () => {
  let reachable = false;
  const logs = [];
  const s = scheduler({versions: () => reachable ? '1.1.50' : new Error('getaddrinfo ENOTFOUND registry.npmjs.org')});
  assert.deepEqual(await s.auto.runOnce(), {state: 'current'}, 'nothing to do, and no error');
  assert.equal(s.calls.update.length, 0);
  assert.equal(s.calls.busy, 0);
  // Unreachable npm also answers nothing (undefined) through McpUpdater.checkLatest: the same.
  const silent = scheduler({versions: {}});
  assert.deepEqual(await silent.auto.runOnce(), {state: 'current'});
  s.auto.start();
  assert.equal(await s.next(), AUTO_EVERY_MS + AUTO_JITTER_MS / 2, 'retried at the next interval');
  reachable = true;
  await s.next();
  assert.equal(s.calls.latest.length, 3, 'asked again');
  assert.equal(s.calls.update.length, 1, 'and installed once npm answered');
  assert.deepEqual(logs, []);
  s.auto.close();
});

test('Q9: a version put back is never tried again by itself, across a restart; a newer one is', async t => {
  const root = await tempDir('mcp-auto-update-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const statePath = join(root, 'printers', 'auto-update.json');
  let versions = {'bambu-printer-mcp': '1.1.50'};
  const reverted = async () => ({state: 'reverted', fromVersion: '1.1.46', toVersion: '1.1.50', why: "The updated bambu-printer-mcp didn't answer Counterpart's contract (counterpart/1)."});
  const first = scheduler({statePath, versions: () => versions['bambu-printer-mcp'], update: reverted});
  assert.equal((await first.auto.runOnce()).results[0].outcome.state, 'reverted');
  assert.deepEqual(await first.auto.runOnce(), {state: 'current'}, 'the same version is left alone');
  assert.equal(first.calls.update.length, 1);
  // A restarted companion reads what failed.
  let now = 1_000_000;
  const second = scheduler({statePath, versions: () => versions['bambu-printer-mcp'], now: () => now});
  assert.deepEqual(await second.auto.runOnce(), {state: 'current'});
  assert.equal(second.calls.update.length, 0);
  assert.match((await second.auto.failed())['mcp-a'].why, /counterpart\/1/);
  // A newer version is tried, and its success clears the record.
  versions = {'bambu-printer-mcp': '1.1.51'};
  // The next run is hours later (every six), past the time npm's last answer is reused for.
  now += AUTO_LATEST_TTL_MS + 1;
  assert.equal((await second.auto.runOnce()).results[0].outcome.state, 'done');
  assert.deepEqual(second.calls.update, [{mcpId: 'mcp-a', latest: '1.1.51', report: false}]);
  assert.deepEqual(await second.auto.failed(), {});
});

test('Q9: an install that fails before anything changed is tried at the next runs, and the last try is said', async () => {
  const s = scheduler({update: async (_id, latest) => ({state: 'failed', fromVersion: '1.1.46', toVersion: latest, why: 'npm install failed'})});
  for (let i = 0; i < AUTO_QUIET_TRIES; i++) await s.auto.runOnce();
  assert.deepEqual(s.calls.update.map(item => item.report), [...Array(AUTO_QUIET_TRIES - 1).fill(false), true], 'quiet until the last try, which reports');
  await s.auto.runOnce();
  assert.equal(s.calls.update.length, AUTO_QUIET_TRIES, 'then left alone until a newer version');
});

test('Q9: the setting turned off during a run stops before the next install', async () => {
  let on = true;
  const s = scheduler({enabled: () => on,
    targets: [{mcpId: 'a', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}, {mcpId: 'b', pkg: 'bambu-printer-mcp', fromVersion: '1.1.46'}],
    update: async (_id, latest) => { on = false; return {state: 'done', toVersion: latest}; }});
  const run = await s.auto.runOnce();
  assert.deepEqual(s.calls.update.map(item => item.mcpId), ['a']);
  assert.equal(run.state, 'ran');
});

// ---------------------------------------------------------------------------
// The companion's idle states, each from the object that owns it.

const idleSources = (extra = {}) => ({gate: new PrintGate(), updates: {busy: () => false}, printers: () => [{id: 'p1s', name: 'Workshop P1S'}], printing: async () => false, ...extra});

test('Q9 idle: nothing working is idle', async () => {
  assert.equal(await companionBusy(idleSources()), undefined);
});

test('Q9 idle: a send, slice, design pass or answer (PrintGate holds) and a Move or the add-on repair (PrintGate updating) are busy until they end', async () => {
  const gate = new PrintGate();
  const release = gate.hold('current');
  assert.equal(await companionBusy(idleSources({gate})), 'Counterpart is sending, slicing or designing');
  release();
  assert.equal(await companionBusy(idleSources({gate})), undefined);
  assert.ok(gate.beginUpdate(['p1s']));
  assert.equal(await companionBusy(idleSources({gate})), 'Counterpart is sending, slicing or designing');
  gate.endUpdate(['p1s']);
  assert.equal(await companionBusy(idleSources({gate})), undefined);
});

test('Q9 idle: an Update, Download or another automatic update in progress is busy', async () => {
  let updating = true;
  assert.equal(await companionBusy(idleSources({updates: {busy: () => updating}})), 'an MCP update is running');
  updating = false;
  assert.equal(await companionBusy(idleSources({updates: {busy: () => updating}})), undefined);
});

test('Q9 idle: a printer being set up (Add printer…\'s steps) is busy until the step ends', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const root = await tempDir('mcp-auto-setup-');
  t.after(() => rm(root, {recursive: true, force: true}));
  // Find Printers reads the folders more than once: every read waits until the test lets them all answer.
  const waiting = [];
  const finish = () => { for (const resolve of waiting.splice(0)) resolve([]); };
  const env = {home: root, user: 'ada', appPrinters: join(root, 'printers'), readFile: () => undefined, exists: () => false, isDirectory: () => false, realpath: path => path};
  const setup = new PrinterSetup({env, configs: () => [], profilesPath: join(root, 'printers', 'profiles.json'), list: () => [],
    folders: () => new Promise(resolve => { waiting.push(resolve); if (released) resolve([]); })});
  let released = false;
  assert.equal(setup.working(), false);
  const finding = setup.discover();
  assert.equal(setup.working(), true, 'Find Printers is running');
  assert.equal(await companionBusy(idleSources({setup})), 'a printer is being set up');
  await new Promise(resolve => setImmediate(resolve));
  released = true;
  finish();
  await finding;
  assert.equal(setup.working(), false);
  assert.equal(await companionBusy(idleSources({setup})), undefined);
});

test('Q9 idle: the code design engine\'s Set Up and Fusion\'s Set Up are busy until they end', async () => {
  const {CadSettings} = await import('../dist/cad-settings.js');
  let finish;
  const cad = new CadSettings({calls: {status: async () => ({status: {configured: false, ready: false}, server: 'bambu-printer-mcp'}),
    setup: () => new Promise(resolve => { finish = resolve; })}, emit: async () => {}, lock: async () => async () => {}});
  assert.equal(await companionBusy(idleSources({cad})), undefined);
  await cad.setUp();
  assert.equal(cad.current().state, 'setting-up');
  assert.equal(await companionBusy(idleSources({cad})), 'the code design engine is being set up');
  finish({setup: {supported: true, configured: true, ready: true, message: 'Ready.'}, server: 'bambu-printer-mcp'});
  for (let i = 0; i < 50 && cad.current().state === 'setting-up'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await companionBusy(idleSources({cad})), undefined);

  const {RuntimeSettings} = await import('../dist/runtime-settings.js');
  const fusion = new RuntimeSettings({emit: async () => {}});
  await fusion.reportFusion({installed: true, configured: false, running: true});
  assert.equal(await companionBusy(idleSources({fusion})), undefined);
  await fusion.requestFusion();
  assert.equal(await companionBusy(idleSources({fusion})), 'Fusion is being set up');
  const claimant = '00000000-0000-4000-8000-000000000001';
  const {requestId} = fusion.claimFusion(claimant);
  await fusion.completeFusion({requestId, ok: true});
  assert.equal(await companionBusy(idleSources({fusion})), undefined);
});

test('Q9 idle: a printer printing (a project, or its own report) is busy, and a check that fails is never read as idle', async () => {
  let printing = true;
  const sources = idleSources({printers: () => [{id: 'a1', name: 'A1'}, {id: 'p1s', name: 'Workshop P1S'}], printing: async id => id === 'p1s' && printing});
  assert.equal(await companionBusy(sources), 'Workshop P1S is printing');
  printing = false;
  assert.equal(await companionBusy(sources), undefined);
  assert.equal(await companionBusy(idleSources({printing: async () => { throw new Error('report timed out'); }})), 'Workshop P1S is printing');
  // Cheap checks first: a printer's report isn't read while something else already says busy.
  let reads = 0;
  const gate = new PrintGate(); gate.hold('current');
  await companionBusy(idleSources({gate, printing: async () => { reads++; return false; }}));
  assert.equal(reads, 0);
});

// ---------------------------------------------------------------------------
// The counterpart/1 check an automatic update keeps a new copy by.

function contractClient({connect, tools = ['counterpart_setup_fields'], answer}) {
  const seen = {closed: 0, configs: []};
  const client = config => {
    seen.configs.push(config);
    return {
      connect: async () => { if (connect) await connect(); return {server: {name: 'x', version: '1'}, tools: tools.map(name => ({name}))}; },
      callTool: async name => { assert.equal(name, 'counterpart_setup_fields'); return typeof answer === 'function' ? answer() : answer; },
      close: async () => { seen.closed++; },
    };
  };
  return {client, seen};
}
const json = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const setupAnswer = {contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.50'}, kinds: []};

test('Q9 contract check: a copy that starts and answers counterpart/1 passes; started with no printer settings', async t => {
  const root = await tempDir('mcp-auto-contract-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'printers', 'profiles');
  const {client, seen} = contractClient({answer: json(setupAnswer)});
  const check = contractCheck({cwd, client});
  const config = {backend: 'bambu-printer-mcp', process: {command: '/node', args: ['/copy/dist/index.js'], env: {BAMBU_SERIAL: '01P00A000000000', BAMBU_TOKEN: 'secret'}, cwd: '/Users/ada/printer'}};
  assert.equal(await check(config, '1.1.50'), undefined);
  assert.deepEqual(seen.configs, [{backend: 'bambu-printer-mcp', process: {command: '/node', args: ['/copy/dist/index.js'], cwd}}], 'no printer settings, so nothing reaches a printer');
  assert.equal(seen.closed, 1);
  // structuredContent answers count too.
  assert.equal(await contractCheck({cwd, client: contractClient({answer: {content: [], structuredContent: setupAnswer}}).client})(config, '1.1.50'), undefined);
});

test('Q9 contract check: a copy that doesn\'t start, doesn\'t offer the contract, or answers something else fails, in Counterpart\'s words', async t => {
  const root = await tempDir('mcp-auto-contract-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const cwd = join(root, 'profiles');
  const config = {backend: 'bambu-printer-mcp', process: {command: '/node', args: ['/copy/dist/index.js']}};
  const cases = [
    [{connect: async () => { throw new Error('spawn ENOENT'); }}, /^didn't start within 1 seconds\.$/],
    [{connect: () => new Promise(() => undefined)}, /^didn't start within 1 seconds\.$/],
    [{tools: ['get_printer_status'], answer: json(setupAnswer)}, /^doesn't offer Counterpart's contract \(counterpart\/1\)\.$/],
    [{answer: json({...setupAnswer, contract: 'counterpart/0'})}, /^didn't answer Counterpart's contract \(counterpart\/1\)\.$/],
    [{answer: {isError: true, content: [{type: 'text', text: 'boom'}]}}, /^didn't answer/],
    [{answer: {content: [{type: 'text', text: 'not json'}]}}, /^didn't answer/],
    [{answer: () => new Promise(() => undefined)}, /^didn't answer/],
  ];
  for (const [script, expected] of cases) {
    const {client, seen} = contractClient(script);
    assert.match(await contractCheck({cwd, client, timeoutMs: 1000})(config, '1.1.50'), expected);
    assert.equal(seen.closed, 1, 'the probe is always closed');
  }
});

test('review F3: through a ten-hour print with an update waiting, npm is asked once, not every minute; its answer is reused for 30 minutes', async () => {
  let now = 1_000_000, printing = true;
  const s = scheduler({busy: async () => printing ? 'P1S is printing' : undefined, now: () => now});
  for (let minute = 0; minute < 600; minute++) {
    assert.equal((await s.auto.runOnce()).state, 'deferred');
    now += AUTO_BUSY_RETRY_MS;
  }
  assert.deepEqual(s.calls.latest, ['bambu-printer-mcp'], 'npm asked at the first run only');
  assert.equal(s.calls.busy, 600, 'one cheap "busy?" a minute, asked before npm');
  assert.deepEqual(s.calls.update, []);
  printing = false;
  assert.equal((await s.auto.runOnce()).state, 'ran');
  assert.equal(s.calls.latest.length, 2, 'the print ended ten hours later: npm is asked again, its last answer being old');
  assert.equal(s.calls.update.length, 1);
  // Within 30 minutes the answer is used again; after, npm is asked.
  now += AUTO_LATEST_TTL_MS - 60_000;
  await s.auto.runOnce();
  assert.equal(s.calls.latest.length, 2);
  now += 120_000;
  await s.auto.runOnce();
  assert.equal(s.calls.latest.length, 3);
  // npm that can't answer isn't remembered: the next run asks again.
  const failing = scheduler({versions: {'bambu-printer-mcp': new Error('offline')}, now: () => now});
  assert.equal((await failing.auto.runOnce()).state, 'current');
  assert.equal((await failing.auto.runOnce()).state, 'current');
  assert.equal(failing.calls.latest.length, 2);
});

test('review F4: an automatic update a restart cut short is recorded as failed: its version is not tried again by itself, a newer one is', async t => {
  const root = await tempDir('mcp-auto-recovered-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const statePath = join(root, 'auto-update.json');
  let now = 1_000_000, version = '1.1.50', given = [{mcpId: 'mcp-a', toVersion: '1.1.50'}];
  const recovered = () => { const found = given; given = []; return found; };
  const s = scheduler({versions: () => version, statePath, now: () => now, recovered});
  assert.deepEqual(await s.auto.runOnce(), {state: 'current'}, 'not retried');
  assert.deepEqual(s.calls.update, []);
  assert.equal((await s.auto.failed())['mcp-a'].toVersion, '1.1.50');
  assert.equal((await s.auto.failed())['mcp-a'].reverted, true);
  // After the companion starts again (a new scheduler on the same file), still not retried.
  const again = scheduler({versions: () => version, statePath, now: () => now});
  assert.deepEqual(await again.auto.runOnce(), {state: 'current'});
  assert.deepEqual(again.calls.update, []);
  version = '1.1.51';
  now += AUTO_LATEST_TTL_MS + 1;
  const ran = await again.auto.runOnce();
  assert.equal(ran.state, 'ran');
  assert.deepEqual(again.calls.update.map(call => call.latest), ['1.1.51'], 'a newer version is tried');
});
