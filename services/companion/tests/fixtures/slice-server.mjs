// Isolated MCP protocol fixture: no slicer, printer implementation or network access.
import {createInterface} from 'node:readline';
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [mode, log] = process.argv.slice(2);
if (process.env.TEMP_DIR) mkdirSync(process.env.TEMP_DIR, {recursive: true});
const slice = {
  name: 'slice_stl',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['stl_path', 'bambu_model'],
    properties: {
      stl_path: {type: 'string'},
      bambu_model: {enum: ['p1s']},
      slicer_type: {enum: ['bambustudio', 'orcaslicer', 'orcaslicer-bambulab', 'fulu-orca', 'orca-studio']},
      nozzle_diameter: {type: 'string'},
      bed_type: {enum: ['textured_plate', 'cool_plate', 'engineering_plate', 'hot_plate', 'supertack_plate']},
      nozzle_type: {enum: ['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']},
      use_printer_filaments: {type: 'boolean'},
      orient: {type: 'boolean'},
      arrange: {type: 'boolean'},
      ensure_on_bed: {type: 'boolean'},
    },
  },
};
const layFlat = {
  name: 'lay_flat',
  inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: {stl_path: {type: 'string'}}},
};
const inspect = {
  name: 'inspect_print_file',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['file_path', 'bambu_model'],
    properties: {
      file_path: {type: 'string'},
      bambu_model: {enum: ['p1s']},
      plate_index: {type: 'integer', minimum: 0},
      nozzle_diameters: {type: 'array', items: {enum: [0.4]}},
      bed_type: {enum: ['textured_plate']},
    },
  },
};
const lines = createInterface({input: process.stdin});
lines.on('close', () => process.exit());
lines.on('line', line => {
  const req = JSON.parse(line);
  appendFileSync(log, JSON.stringify({
    request: req,
    env: {
      SLICER_TYPE: process.env.SLICER_TYPE ?? null,
      SLICER_PATH: process.env.SLICER_PATH ?? null,
      TEMP_DIR: process.env.TEMP_DIR ?? null,
      PATH: process.env.PATH ?? null,
      HOME: process.env.HOME ?? null,
      parentSentinel: 'PARENT_SENTINEL' in process.env,
      printerHost: 'PRINTER_HOST' in process.env,
      bambuSerial: 'BAMBU_SERIAL' in process.env,
      bambuToken: 'BAMBU_TOKEN' in process.env,
    },
  }) + '\n');
  if (req.id === undefined) return;
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: req.id, result}) + '\n');
  if (req.method === 'initialize') {
    return reply({protocolVersion: req.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'slice-fixture', version: '1.1.41'}});
  }
  if (req.method === 'tools/list') {
    return reply({tools: mode === 'missing-slice' ? [layFlat, inspect] : [slice, layFlat, inspect]});
  }
  if (req.method !== 'tools/call') throw Error('Forbidden fixture method');
  if (mode === 'stall') return;
  if (req.params.name === 'lay_flat') {
    const path = join(process.env.TEMP_DIR, 'source_flat.stl');
    writeFileSync(path, 'solid flat\nendsolid flat\n');
    return reply({content: [{type: 'text', text: path}]});
  }
  if (req.params.name !== 'slice_stl') throw Error('Forbidden fixture tool');
  if (mode === 'error') return reply({content: [{type: 'text', text: 'Error: fixture slice failed'}], isError: true});
  if (mode === 'outside') return reply({content: [{type: 'text', text: '/tmp/outside/source_sliced.3mf'}]});
  const path = join(process.env.TEMP_DIR, 'source_sliced.3mf');
  writeFileSync(path, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fixture sliced 3mf')]));
  return reply({content: [{type: 'text', text: path}]});
});
