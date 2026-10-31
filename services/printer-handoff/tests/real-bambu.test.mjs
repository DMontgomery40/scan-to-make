import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {InMemoryElicitationRelay, PrinterHandoffRunner} from '../dist/index.js';

// Opt-in only: connects to a real installed bambu-printer-mcp and lists its
// tools. It never calls a tool, so nothing reaches a printer.
//   PRINTER_HANDOFF_REAL_BAMBU=1 \
//   PRINTER_HANDOFF_BAMBU_ENTRY=/path/to/bambu-printer-mcp/dist/index.js \
//   node --test tests/real-bambu.test.mjs
const enabled = process.env.PRINTER_HANDOFF_REAL_BAMBU === '1';
const entry = process.env.PRINTER_HANDOFF_BAMBU_ENTRY;

test('real bambu-printer-mcp discovery exposes the print sequence tools', {skip: !enabled}, async () => {
  assert.ok(entry, 'PRINTER_HANDOFF_BAMBU_ENTRY must point at dist/index.js');
  const absoluteEntry = resolve(entry);
  await access(absoluteEntry);
  const runner = new PrinterHandoffRunner({
    backend: 'bambu-printer-mcp',
    process: {
      command: process.env.PRINTER_HANDOFF_BAMBU_NODE || process.execPath,
      args: [absoluteEntry],
      cwd: resolve(dirname(absoluteEntry), '..'),
      env: {...process.env},
    },
    selection: {model: 'p1s', nozzleDiameterMm: 0.4, nozzleType: 'hardened_steel', bedType: 'textured_plate'},
  }, {relay: new InMemoryElicitationRelay({timeoutMs: 1000})});
  const catalog = await runner.discover();
  const names = new Set(catalog.tools.map(tool => tool.name));
  for (const required of ['slice_stl', 'lay_flat', 'inspect_print_file', 'print_3mf', 'camera_snapshot']) {
    assert.ok(names.has(required), `missing ${required}`);
  }
});
