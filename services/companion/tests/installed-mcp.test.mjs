import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPrinterTools, createPreparedPrintValidator } from '../dist/mcp-discovery.js';

test('genuine installed Bambu MCP initializes and lists schemas without a network operation', { skip: !process.env.BAMBU_MCP_ENTRY && 'Set BAMBU_MCP_ENTRY to the built server for separate installed-process evidence' }, async t => {
  const entry = process.env.BAMBU_MCP_ENTRY;
  assert.ok(isAbsolute(entry));
  const dir = await mkdtemp(join(tmpdir(), 'installed-mcp-discovery-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const networkLog = join(dir, 'network.log');
  const catalog = await discoverPrinterTools({
    command: process.execPath,
    args: ['--import', fileURLToPath(new URL('./fixtures/no-network.mjs', import.meta.url)), entry], cwd: dir,
    env: { HOME: dir, MCP_TRANSPORT: 'stdio', BAMBU_MODEL: '', BAMBU_PRINTER_MODEL: '',
      BAMBU_PRINTER_HOST: '127.0.0.1', PRINTER_HOST: '127.0.0.1',
      BAMBU_PRINTER_SERIAL: '', BAMBU_SERIAL: '', BAMBU_PRINTER_ACCESS_TOKEN: '', BAMBU_TOKEN: '',
      BAMBU_DEV_ID: '', BAMBU_REQUIRE_CONFIRMATION: '1', DISCOVERY_NETWORK_LOG: networkLog },
  });
  assert.ok(catalog.tools.length > 1);
  const print = catalog.tools.find(x => x.name === 'print_3mf');
  assert.ok(print);
  const validate = createPreparedPrintValidator(catalog);
  assert.equal(validate({ three_mf_path: '/never-dispatched.3mf', bambu_model: 'p1s', plate_index: 1, nozzle_diameters: [0.4] }).ok, true);
  assert.equal(validate({ three_mf_path: '/never-dispatched.3mf', bambu_model: 'not-a-real-model' }).ok, false);
  assert.equal(validate({ three_mf_path: '/never-dispatched.3mf', bambu_model: 'p1s', bridge_command: 'never-run' }).ok, false);
  await assert.rejects(access(networkLog), { code: 'ENOENT' });
  t.diagnostic(`Installed server ${catalog.server.name} ${catalog.server.version}; ${catalog.tools.length} actual tools discovered; no tools/call or socket operation`);
});
