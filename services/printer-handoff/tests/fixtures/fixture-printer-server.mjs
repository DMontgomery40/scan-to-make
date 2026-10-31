// Isolated MCP fixture: records calls, writes only beside each input STL.
// It never loads a real printer implementation.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {appendFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';

const [mode, log] = process.argv.slice(2);
const record = entry => appendFileSync(log, JSON.stringify(entry) + '\n');
const string = {type: 'string'};
const number = {type: 'number'};
const integer = {type: 'integer'};
const bool = {type: 'boolean'};
const sliceProps = {
  stl_path: string, bambu_model: {type: 'string', enum: ['p1s']}, nozzle_diameter: string,
  bed_type: string, nozzle_type: string, slicer_type: string, slicer_profile: string,
  filament_profile: string, load_filaments: string, template_name: string,
  use_printer_filaments: bool, orient: bool, arrange: bool, ensure_on_bed: bool,
};
const bambuPrintProps = {
  three_mf_path: string, bambu_model: string, bed_type: string, nozzle_type: string,
  nozzle_diameter: string, nozzle_diameters: {type: 'array', items: number}, plate_index: integer,
  use_ams: bool, ams_slots: {type: 'array', items: integer},
  ams_mapping: {type: 'array', items: integer}, auto_match_ams: bool,
  bed_leveling: bool, flow_calibration: bool, vibration_calibration: bool,
  layer_inspect: bool, timelapse: bool,
};
const genericPrintProps = {
  three_mf_path: string, bambu_model: string, bed_type: string, nozzle_type: string,
  nozzle_diameter: string, use_ams: bool, ams_mapping: {type: 'object'},
};
const tools = [
  {name: 'lay_flat', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: {stl_path: string}}},
  {name: 'slice_stl', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: sliceProps}},
  ...(mode === 'bambu' ? [
    {name: 'inspect_print_file', inputSchema: {type: 'object', additionalProperties: false, required: ['file_path'], properties: {
      file_path: string, bambu_model: string, plate_index: integer,
      nozzle_diameters: {type: 'array', items: number}, bed_type: string}}},
    {name: 'camera_snapshot', inputSchema: {type: 'object', additionalProperties: false, properties: {bambu_model: string, timeout_ms: integer}}},
    {name: 'print_3mf', inputSchema: {type: 'object', additionalProperties: false, required: ['three_mf_path'], properties: bambuPrintProps}},
  ] : [
    {name: 'confirm_temperatures', inputSchema: {type: 'object', additionalProperties: false, required: ['gcode_path'], properties: {gcode_path: string}}},
    {name: 'upload_gcode', inputSchema: {type: 'object', additionalProperties: false, required: ['gcode_path'], properties: {
      gcode_path: string, print: bool, filename: string, material: string, type: string, host: string, port: string}}},
    {name: 'print_3mf', inputSchema: {type: 'object', additionalProperties: false, required: ['three_mf_path'], properties: genericPrintProps}},
    {name: 'process_and_print_stl', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: {
      stl_path: string, extension_inches: number, material: string, type: string, host: string, port: string}}},
  ]),
];
const text = value => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]});
const server = new Server({name: `fixture-${mode}`, version: '0.0.0'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));

async function confirmPrint() {
  const response = await server.elicitInput({
    mode: 'form',
    message: mode === 'bambu'
      ? 'Fixture bed-clearance confirmation: check the snapshot and confirm printing.'
      : 'Fixture print confirmation: confirm printing.',
    requestedSchema: {
      type: 'object',
      properties: {confirmed: {type: 'boolean', title: 'I checked the printer and confirm', default: false}},
      required: ['confirmed'],
    },
  }, {timeout: 600000});
  record({elicitation: response});
  if (response.action !== 'accept' || response.content?.confirmed !== true) {
    throw Error('Fixture print was not confirmed. Nothing was printed.');
  }
}
async function elicitModel(args) {
  if (args.bambu_model) return args;
  const response = await server.elicitInput({
    mode: 'form',
    message: 'Fixture printer model is required.',
    requestedSchema: {
      type: 'object',
      properties: {bambu_model: {type: 'string', title: 'Printer Model', oneOf: [{const: 'p1s', title: 'P1S'}]}},
      required: ['bambu_model'],
    },
  }, {timeout: 600000});
  record({elicitation: response});
  if (response.action !== 'accept' || response.content?.bambu_model !== 'p1s') throw Error('Fixture model was not selected.');
  return {...args, bambu_model: 'p1s'};
}

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  let args = request.params.arguments ?? {};
  if ((name === 'slice_stl' || name === 'print_3mf') && !args.bambu_model) args = await elicitModel(args);
  record({tool: name, arguments: args});
  const directory = dirname(args.stl_path ?? args.three_mf_path ?? args.gcode_path ?? process.cwd());
  if (name === 'lay_flat') {
    const path = join(directory, `${basename(args.stl_path, '.stl')}_flat.stl`);
    writeFileSync(path, 'solid flat\nendsolid flat\n');
    return text(path);
  }
  if (name === 'slice_stl') {
    const path = join(directory, mode === 'generic-gcode' ? 'sliced.gcode' : 'sliced.3mf');
    writeFileSync(path, path.endsWith('.3mf') ? 'fixture 3mf' : '; fixture gcode\n');
    return text(path);
  }
  if (name === 'inspect_print_file') {
    return text({dispatchAuthorized: false, inspection: {model: args.bambu_model, plate: args.plate_index ?? 0}});
  }
  if (name === 'confirm_temperatures') return text({compatible: true, peakNozzleTempC: 220});
  if (name === 'camera_snapshot') return text({format: 'jpeg', base64: 'ZmFrZQ==', savedTo: join(directory, 'snapshot.jpg')});
  if (name === 'print_3mf' || name === 'upload_gcode' || name === 'process_and_print_stl') {
    await confirmPrint();
    return text({dispatch: 'started', tool: name});
  }
  throw Error(`Unknown fixture tool: ${name}`);
});

await server.connect(new StdioServerTransport());
