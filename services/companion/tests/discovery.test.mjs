import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPrinterTools, createPreparedPrintValidator } from '../dist/mcp-discovery.js';

const fixture = fileURLToPath(new URL('./fixtures/discovery-server.mjs', import.meta.url));
async function runFixture(t, mode, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'requests.jsonl');
  const pid = join(dir, 'pid');
  const discover = () => discoverPrinterTools({ command: process.execPath, args: [fixture, mode, log, pid], cwd: dir }, options);
  const assertClosed = async () => {
    const child = Number(await readFile(pid, 'utf8'));
    assert.throws(() => process.kill(child, 0), { code: 'ESRCH' }, 'actual child PID must be gone');
    const requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(requests.every(r => ['initialize', 'notifications/initialized', 'tools/list', 'notifications/cancelled'].includes(r.method)));
    assert.equal(requests.filter(r => r.method === 'tools/call').length, 0);
    return requests;
  };
  return { discover, assertClosed };
}

test('initializes, reads every tool page, returns immutable metadata, and closes the process without tool execution', async t => {
  const f = await runFixture(t, 'normal');
  const result = await f.discover();
  assert.equal(result.server.name, 'isolated-fixture');
  assert.deepEqual(result.tools.map(x => x.name), ['get_printer_status', 'print_3mf']);
  assert.ok(Object.isFrozen(result.tools[1].inputSchema.properties));
  assert.equal(result.callTool, undefined);
  const requests = await f.assertClosed();
  assert.equal(requests.filter(r => r.method === 'tools/list').length, 2);
  assert.equal(requests.find(r => r.params?.cursor)?.params.cursor, 'second');
});

test('prepared print validation uses the actual discovered schema without coercion or mutation', async t => {
  const f = await runFixture(t, 'normal');
  const validate = createPreparedPrintValidator(await f.discover());
  const input = { three_mf_path: '/private/checked.3mf', bambu_model: 'p1s', plate_index: 2, nozzle_diameters: [0.4], ams_slots: [254], use_ams: false };
  assert.equal(validate(input).ok, true);
  assert.equal(validate({ ...input, bambu_model: 'x1c' }).ok, false);
  assert.equal(validate({ ...input, plate_index: '2' }).ok, false);
  assert.equal(validate({ ...input, nozzle_diameters: [0.5] }).ok, false);
  assert.equal(validate({ ...input, bambu_access_code: 'never-pass-credentials' }).ok, false);
  assert.equal(validate({ ...input, arbitrary_override: true }).ok, false);
  assert.equal(validate({ bambu_model: 'p1s' }).ok, false);
  assert.equal(input.plate_index, 2);
  await f.assertClosed();
});

for (const [mode, code, limits] of [
  ['missing', 'missing-print-tool', {}], ['bad-schema', 'invalid-print-schema', {}],
  ['duplicate', 'duplicate-tool', {}], ['cycle', 'cursor-cycle', {}],
  ['pages', 'catalog-limit', { maxPages: 2 }], ['normal', 'catalog-limit', { maxTools: 1 }],
  ['large', 'catalog-limit', { maxCatalogBytes: 2000 }],
]) test(`rejects ${mode} and verifies actual child cleanup`, async t => {
  const f = await runFixture(t, mode, limits);
  await assert.rejects(f.discover(), e => e.code === code);
  await f.assertClosed();
});

for (const mode of ['stall-init', 'stall-list', 'stubborn']) test(`overall deadline closes ${mode} including a SIGTERM-resistant child`, async t => {
  const f = await runFixture(t, mode, { timeoutMs: 300 });
  const start = Date.now();
  await assert.rejects(f.discover(), e => e.code === 'discovery-timeout');
  assert.ok(Date.now() - start < 6500);
  await f.assertClosed();
});

test('caller cancellation terminates a connected child and never executes a tool', async t => {
  const controller = new AbortController();
  const f = await runFixture(t, 'stall-list', { timeoutMs: 5000, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 300);
  try { await assert.rejects(f.discover(), e => e.code === 'discovery-cancelled'); }
  finally { clearTimeout(timer); }
  await f.assertClosed();
});

test('pre-aborted caller and malformed limits reject before spawn', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverPrinterTools({ command: 'must-not-run' }, { signal: controller.signal }), e => e.code === 'discovery-cancelled');
  await assert.rejects(discoverPrinterTools({ command: 'must-not-run' }, { maxPages: -1 }), e => e.code === 'invalid-configuration');
});

test('missing executable gives a sanitized connection failure', async () => {
  await assert.rejects(discoverPrinterTools({ command: '/nonexistent/secret-command' }), e => e.code === 'connection-failed' && !e.message.includes('secret-command'));
});
