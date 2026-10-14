import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, logPath, pidPath] = process.argv.slice(2);
writeFileSync(pidPath, String(process.pid));
const schema = {
  type: 'object', required: ['three_mf_path', 'bambu_model'],
  properties: {
    three_mf_path: { type: 'string' }, bambu_model: { type: 'string', enum: ['p1s', 'a1'] },
    plate_index: { type: 'integer', minimum: 1 },
    nozzle_diameters: { type: 'array', minItems: 1, maxItems: 2, items: { enum: [0.2, 0.4, 0.6, 0.8] } },
    bed_type: { type: 'string' }, use_ams: { type: 'boolean' },
    ams_slots: { type: 'array', items: { type: 'integer' } },
    connection_mode: { enum: ['lan_mqtt_ftps', 'bambu_native'] },
    bambu_access_code: { type: 'string' },
  },
};
const print = { name: 'print_3mf', inputSchema: schema };
const status = { name: 'get_printer_status', inputSchema: { type: 'object' } };
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
const lines = createInterface({ input: process.stdin });
lines.on('close', () => { if (mode !== 'stubborn') process.exit(0); });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(request) + '\n');
  if (request.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') {
    if (mode === 'stall-init') return;
    reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    if (mode === 'stubborn' || mode === 'stall-list') return;
    if (mode === 'missing') return reply({ tools: [status] });
    if (mode === 'bad-schema') return reply({ tools: [{ ...print, inputSchema: { type: 'object', properties: { x: { type: 'not-a-type' } } } }] });
    if (mode === 'duplicate') return reply({ tools: [print, print] });
    if (mode === 'cycle') return reply({ tools: request.params?.cursor ? [] : [print], nextCursor: 'again' });
    if (mode === 'pages') return reply({ tools: request.params?.cursor ? [] : [print], nextCursor: String(Number(request.params?.cursor ?? 0) + 1) });
    if (mode === 'large') return reply({ tools: [{ ...print, description: 'x'.repeat(5000) }] });
    if (!request.params?.cursor) reply({ tools: [status], nextCursor: 'second' });
    else reply({ tools: [print] });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'NO EXECUTION IN FIXTURE' } }) + '\n');
  }
});
