// #834: a stand-in for Counterpart's own copy of a printer MCP, installed where Download puts it
// (<data root>/printers/{bambu,generic}/lib/node_modules/<package>/dist/index.js). It answers what Add printer and an
// estimate ask, from `setup-fields.json` copied beside it; it never reaches a printer. Calls are logged to calls.ndjson.
import {createInterface} from 'node:readline';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fields = JSON.parse(readFileSync(join(here, 'setup-fields.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const object = {type: 'object', properties: {}};
const tools = [
  {name: 'counterpart_setup_fields', inputSchema: object},
  {name: 'counterpart_printer_info', inputSchema: object},
  {name: 'counterpart_print_progress', inputSchema: object},
  {name: 'get_printer_status', inputSchema: object},
  {name: 'cad_status', inputSchema: object},
  {name: 'slice_stl', inputSchema: {type: 'object', required: ['stl_path'], properties: {stl_path: {type: 'string'}, bambu_model: {type: 'string'}, slicer_type: {type: 'string'}}}},
  {name: 'inspect_print_file', inputSchema: {type: 'object', required: ['file_path'], properties: {file_path: {type: 'string'}, bambu_model: {type: 'string'}, plate_index: {type: 'integer'}}}},
];
const text = value => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]});
const answers = {
  counterpart_setup_fields: () => text(fields),
  counterpart_printer_info: () => text({contract: 'counterpart/1', server: {name: pkg.name, version: pkg.version},
    printer: {kind: 'bambu', host: process.env.PRINTER_HOST ?? '127.0.0.1'},
    capabilities: {progress: true, layers: true, camera: 'none', filaments: 'single', pause: true, resume: true, cancel: true, print3mf: true, gcode: true,
      slicing: {supports: true, copies: true, orient: true}}}),
  counterpart_print_progress: () => text({contract: 'counterpart/1', state: 'idle', printing: false}),
  get_printer_status: () => text({status: 'IDLE'}),
  cad_status: () => text({ready: true, configured: true, engine: 'build123d', server: pkg.name}),
  slice_stl: args => { const path = join(dirname(args.stl_path), 'sliced.3mf'); writeFileSync(path, 'PK fixture 3mf'); return text(path); },
  inspect_print_file: () => text({sliced: {plate_count: 1, estimate: {seconds: 3720, grams: 14}, settings: {}}}),
};
for await (const line of createInterface({input: process.stdin})) {
  const q = JSON.parse(line);
  if (q.id === undefined) continue;
  let result;
  if (q.method === 'initialize') result = {protocolVersion: q.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: pkg.name, version: pkg.version}};
  else if (q.method === 'tools/list') result = {tools};
  else if (q.method === 'tools/call') {
    appendFileSync(join(here, 'calls.ndjson'), JSON.stringify({tool: q.params.name}) + '\n');
    const answer = answers[q.params.name];
    result = answer ? answer(q.params.arguments ?? {}) : {isError: true, content: [{type: 'text', text: `no ${q.params.name} here`}]};
  } else result = {};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: q.id, result}) + '\n');
}
