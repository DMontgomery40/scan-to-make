// Isolated MCP fixture: records calls, writes only beside each input STL.
// It never loads a real printer implementation.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, GetPromptRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {appendFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {tmpdir} from 'node:os';

const ephemeral = process.env.HANDOFF_FIXTURE_EPHEMERAL === '1' ? mkdtempSync(join(tmpdir(), 'fixture-printer-output-')) : undefined;
if (ephemeral) {
  process.once('exit', () => rmSync(ephemeral, {recursive: true, force: true}));
  process.once('SIGTERM', () => process.exit(0));
}

const [mode, log] = process.argv.slice(2);
const record = entry => appendFileSync(log, JSON.stringify(entry) + '\n');
if (process.env.HANDOFF_FIXTURE_PID === '1') record({started: process.pid});
const string = {type: 'string'};
const number = {type: 'number'};
const integer = {type: 'integer'};
const bool = {type: 'boolean'};
const sliceProps = {
  stl_path: string, bambu_model: {type: 'string', enum: ['p1s']}, nozzle_diameter: string,
  bed_type: string, nozzle_type: string, slicer_type: string, slicer_profile: string,
  filament_profile: string, load_filaments: string, filament_colours: string, template_name: string,
  use_printer_filaments: bool, orient: bool, arrange: bool, ensure_on_bed: bool,
};
if (process.env.HANDOFF_FIXTURE_NO_COLOUR === '1') delete sliceProps.filament_colours;
if (process.env.HANDOFF_FIXTURE_SLICE_SETTINGS === '1') Object.assign(sliceProps, {layer_height: number, wall_loops: integer, sparse_infill_density: string, repetitions: integer});
// The slice_stl support arguments a newer MCP takes (enable_support, support_type).
if (process.env.HANDOFF_FIXTURE_SUPPORTS === '1') Object.assign(sliceProps, {enable_support: bool, support_type: {type: 'string', enum: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)']}});
const bambuPrintProps = {
  connection_mode:string, connection_type:string, three_mf_path: string, bambu_model: string, bed_type: string, nozzle_type: string,
  nozzle_diameter: string, nozzle_diameters: {type: 'array', items: number}, plate_index: integer,
  use_ams: bool, ams_slots: {type: 'array', items: integer},
  ams_mapping: {type: 'array', items: integer}, auto_match_ams: bool,
  bed_leveling: bool, flow_calibration: bool, vibration_calibration: bool,
  layer_inspect: bool, timelapse: bool,
};
if (process.env.HANDOFF_FIXTURE_NO_CONNECTION_TYPE) delete bambuPrintProps.connection_type;
const genericPrintProps = {
  connection_mode:string, connection_type:string, three_mf_path: string, bambu_model: string, bed_type: string, nozzle_type: string,
  // The real generic server accepts ams_mapping as an array or an object (anyOf); this fixture takes the array Counterpart sends.
  nozzle_diameter: string, use_ams: bool, ams_mapping: {type: 'array', items: integer}, ams_slots: {type: 'array', items: integer},
};
const tools = [
  {name: 'lay_flat', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: {stl_path: string}}},
  {name: 'slice_stl', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: sliceProps}},
  ...(mode === 'bambu' ? [
    // HANDOFF_FIXTURE_ROUTE: the MCP's own route, as counterpart_print_route reports it.
    ...(process.env.HANDOFF_FIXTURE_ROUTE ? [{name:'counterpart_print_route',inputSchema:{type:'object',properties:{route:string}}}] : []),
    ...(process.env.HANDOFF_FIXTURE_CRYPTO ? [
      {name:'get_printer_status',inputSchema:{type:'object',properties:{}}},
      {name:'clear_hms_errors',inputSchema:{type:'object',properties:{bambu_model:string}}},
    ] : []),
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
// HANDOFF_FIXTURE_PROMPTS=1 serves the MCPs' fdm_design prompt, as bambu-printer-mcp and mcp-3D-printer-server do.
const prompts = process.env.HANDOFF_FIXTURE_PROMPTS === '1';
const server = new Server({name: `fixture-${mode}`, version: '0.0.0'}, {capabilities: {tools: {}, ...(prompts ? {prompts: {}} : {})}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));
if (prompts) server.setRequestHandler(GetPromptRequestSchema, async request => {
  if (request.params.name !== 'fdm_design') throw new Error(`Unknown prompt: ${request.params.name}`);
  return {messages: [{role: 'user', content: {type: 'text', text: 'Design the finished object the user wants, with the manufacturing plan as part of the design.'}}]};
});

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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  // HANDOFF_FIXTURE_PROGRESS: slice_stl reports its progress, as a slicer MCP may.
  const progressToken = request.params._meta?.progressToken;
  if (process.env.HANDOFF_FIXTURE_PROGRESS === '1' && name === 'slice_stl' && progressToken !== undefined)
    for (const [progress, message] of [[1, 'Slicing plate 1'], [2, 'Writing the 3MF']]) {
      await extra.sendNotification({method: 'notifications/progress', params: {progressToken, progress, total: 2, message}});
      // As a slicer that is still working: the progress arrives before the result.
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  let args = request.params.arguments ?? {};
  if ((name === 'slice_stl' || name === 'print_3mf') && !args.bambu_model) args = await elicitModel(args);
  record({tool: name, arguments: args});
  const directory = ephemeral ?? dirname(args.stl_path ?? args.three_mf_path ?? args.gcode_path ?? process.cwd());
  if (name === 'lay_flat') {
    if (process.env.HANDOFF_FIXTURE_LAID_FLAT === 'false') return {
      ...text(args.stl_path), structuredContent: {path: args.stl_path, laid_flat: false, message: 'No face lies on the model’s lowest plane; unchanged.'},
    };
    const path = join(directory, `${basename(args.stl_path, '.stl')}_flat.stl`);
    writeFileSync(path, 'solid flat\nendsolid flat\n');
    return process.env.HANDOFF_FIXTURE_LAID_FLAT === 'true'
      ? {...text(path), structuredContent: {path, laid_flat: true}} : text(path);
  }
  if (name === 'slice_stl') {
    // A real Bambu Studio result.json, returned as bambu-printer-mcp's slicer_result (verbatim).
    const slicerResult = process.env.HANDOFF_FIXTURE_SLICER_RESULT ? JSON.parse(readFileSync(process.env.HANDOFF_FIXTURE_SLICER_RESULT, 'utf8')) : undefined;
    if (slicerResult && slicerResult.return_code !== 0) return {isError: true, structuredContent: {slicer_result: slicerResult},
      content: [{type: 'text', text: `Slicer failed: the slicer exited with code 156 (${slicerResult.error_string} [${slicerResult.return_code}]). Command failed: /Applications/BambuStudio.app/Contents/MacOS/BambuStudio --slice 0`}]};
    const path = join(directory, mode === 'generic-gcode' ? 'sliced.gcode' : 'sliced.3mf');
    writeFileSync(path, process.env.HANDOFF_FIXTURE_SLICED_FILE ? readFileSync(process.env.HANDOFF_FIXTURE_SLICED_FILE)
      : path.endsWith('.3mf') ? `fixture 3mf ${Date.now()}-${Math.random()}` : `; fixture gcode ${Date.now()}-${Math.random()}\n`);
    return slicerResult ? {...text(path), structuredContent: {path, slicer_result: slicerResult}} : text(path);
  }
  if (name === 'inspect_print_file') {
    return text({dispatchAuthorized: false, inspection: {model: args.bambu_model, plate: args.plate_index ?? 0}});
  }
  if (name === 'confirm_temperatures') return text({compatible: true, peakNozzleTempC: 220});
  if (name === 'counterpart_print_route') {
    if (process.env.HANDOFF_FIXTURE_ROUTE === '"error"') return {isError: true, content: [{type: 'text', text: 'route unavailable'}]};
    const {mode, type} = JSON.parse(process.env.HANDOFF_FIXTURE_ROUTE);
    return text({route: mode === 'bambu_network' && type === 'cloud' ? 'cloud' : 'lan', mode, type, choices: ['lan', 'cloud'], savedTo: null});
  }
  if (name === 'get_printer_status') return text({raw:{hms:[{attr:0x05000500,code:0x00010007}]}});
  if (name === 'clear_hms_errors') {await confirmPrint();return text({status:'success'});}
  if (name === 'camera_snapshot') return text({format: 'jpeg', base64: 'ZmFrZQ==', savedTo: join(directory, 'snapshot.jpg')});
  if (name === 'print_3mf' || name === 'upload_gcode' || name === 'process_and_print_stl') {
    // As bambu-printer-mcp 1.1.57 / mcp-3d-printer-server 1.2.31 return a refusal: the words plus a stable code.
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'preflight-error') return {isError:true, content:[{type:'text',text:'Error: Printer state FAILED is not safely idle.'}],
      structuredContent:{status:'error', retryable:false, suggestion:'Fix the printer state first.', message:'Printer state FAILED is not safely idle.', tool:name, code:'printer-not-ready'}};
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'preflight-error-wording') return {isError:true, content:[{type:'text',text:'Printer state FAILED is not safely idle.'}]};
    await confirmPrint();
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'crash') process.exit(9);
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'timeout') await new Promise(() => {});
    if (process.env.HANDOFF_FIXTURE_REMOTE === '1') return text({status: 'success', dispatch: 'started', remoteProjectPath: 'cache/checked-1b2c-sliced.3mf', tool: name});
    return text({dispatch: 'started', tool: name});
  }
  throw Error(`Unknown fixture tool: ${name}`);
});

console.error('fixture stderr ready');
await server.connect(new StdioServerTransport());
