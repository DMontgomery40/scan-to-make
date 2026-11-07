// Isolated MCP fixture: records calls, writes only beside each input STL.
// It never loads a real printer implementation.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, GetPromptRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {appendFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync, strFromU8} from 'fflate';

// What both MCPs say about a slice (bambu-printer-mcp 1.1.63 / mcp-3d-printer-server 1.2.36), as a stand-in:
// the slicer's verdict, and inspect_print_file's `sliced` plate count and estimate of the file.
function verdict(result) {
  const plates = Array.isArray(result.sliced_plates) ? result.sliced_plates : [];
  const warnings = plates.map(plate => typeof plate.warning_message === 'string' ? plate.warning_message.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').trim() : '').filter(Boolean);
  const failed = result.return_code !== 0;
  const words = [...new Set([...(failed && result.error_string ? [result.error_string] : []), ...warnings])].join('\n');
  const ids = new Set(plates.map(plate => plate.id).filter(id => Number.isSafeInteger(id) && id > 0));
  // A refusal also keeps the slicer's own words in slicer_message (bambu-printer-mcp 1.1.69+), for the client's log.
  return {failed, ...(words ? {message: words} : failed ? {message: `The slicer could not slice this model (return code ${result.return_code}).`} : {}),
    ...(failed && words ? {slicer_message: `Studio: ${words}`} : {}), ...(!failed && ids.size ? {plate_count: ids.size} : {})};
}
function facts(bytes, plateIndex) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return {plate_count: 1, settings: {}};
  let files = {};
  try { files = unzipSync(bytes); } catch { return {settings: {}}; }
  const plates = Object.keys(files).filter(name => /^Metadata\/plate_[1-9]\d*\.gcode$/.test(name)).length;
  const info = files['Metadata/slice_info.config'] ? strFromU8(files['Metadata/slice_info.config']) : '';
  const plate = (info.match(/<plate>[\s\S]*?<\/plate>/g) ?? []).find(block => block.includes(`key="index" value="${plateIndex + 1}"`));
  const value = key => { const found = plate?.match(new RegExp(`key="${key}" value="([\\d.]+)"`))?.[1]; return found ? Number(found) : undefined; };
  const seconds = value('prediction'), grams = value('weight');
  return {...(plates ? {plate_count: plates} : {}), ...(seconds || grams ? {estimate: {...(seconds ? {seconds} : {}), ...(grams ? {grams} : {})}} : {}), settings: {}};
}

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
// counterpart_printer_info as bambu-printer-mcp 1.1.58 / mcp-3d-printer-server 1.2.32 answer it. HANDOFF_FIXTURE_SLICING:
// a JSON capabilities.slicing (e.g. a PrusaSlicer route), or 'none' for an MCP from before the field.
const slicing = process.env.HANDOFF_FIXTURE_SLICING === 'none' ? undefined
  : process.env.HANDOFF_FIXTURE_SLICING ? JSON.parse(process.env.HANDOFF_FIXTURE_SLICING) : {supports: true, copies: true, orient: true};
const tools = [
  {name: 'counterpart_printer_info', inputSchema: {type: 'object', properties: {}}},
  {name: 'lay_flat', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: {stl_path: string}}},
  {name: 'slice_stl', inputSchema: {type: 'object', additionalProperties: false, required: ['stl_path'], properties: sliceProps}},
  // list_3mf_plates, as both MCPs answer it since 1.1.69 / 1.2.49 (HANDOFF_FIXTURE_NO_PLATES: an older MCP).
  ...(process.env.HANDOFF_FIXTURE_NO_PLATES === '1' ? [] : [{name: 'list_3mf_plates', inputSchema: {type: 'object', additionalProperties: false, required: ['three_mf_path'],
    properties: {three_mf_path: string, include_thumbnails: bool}}}]),
  // HANDOFF_FIXTURE_OWN_PROCESS: get_slice_settings' own_process (true, false), none of it (absent) or a tool error;
  // HANDOFF_FIXTURE_OWN_PROCESS_ARGS=old: an MCP that takes only source_path, template_name, slicer_type and bambu_model.
  ...(process.env.HANDOFF_FIXTURE_OWN_PROCESS ? [{name: 'get_slice_settings', inputSchema: {type: 'object', additionalProperties: false,
    properties: {source_path: string, template_name: string, slicer_type: string, bambu_model: string, nozzle_diameter: string,
      ...(process.env.HANDOFF_FIXTURE_OWN_PROCESS_ARGS === 'old' ? {} : {slicer_profile: string, template_3mf_path: string, layer_height: number,
        wall_loops: integer, sparse_infill_density: string, quality: string, strength: string, enable_support: bool, support_type: string})}}}] : []),
  ...(mode === 'bambu' ? [
    // HANDOFF_FIXTURE_ROUTE: the MCP's own route, as counterpart_print_route reports it.
    ...(process.env.HANDOFF_FIXTURE_ROUTE ? [{name:'counterpart_print_route',inputSchema:{type:'object',properties:{route:string}}}] : []),
    ...(process.env.HANDOFF_FIXTURE_CRYPTO ? [
      {name:'get_printer_status',inputSchema:{type:'object',properties:{}}},
      {name:'clear_hms_errors',inputSchema:{type:'object',properties:{bambu_model:string}}},
    ] : []),
    {name: 'inspect_print_file', inputSchema: {type: 'object', additionalProperties: false, required: ['file_path'], properties: {
      file_path: string, bambu_model: string, plate_index: integer,
      nozzle_diameters: {type: 'array', items: number}, bed_type: string, include_preview: {type: 'boolean'}}}},
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
// HANDOFF_FIXTURE_PROMPTS=1 serves the MCPs' fdm_design and fdm_slicing prompts, as bambu-printer-mcp and mcp-3D-printer-server do.
const prompts = process.env.HANDOFF_FIXTURE_PROMPTS === '1';
const server = new Server({name: `fixture-${mode}`, version: '0.0.0'}, {capabilities: {tools: {}, ...(prompts ? {prompts: {}} : {})}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));
if (prompts) server.setRequestHandler(GetPromptRequestSchema, async request => {
  const texts = {fdm_design: 'Design the finished object the user wants, with the manufacturing plan as part of the design.',
    fdm_slicing: 'How this printer MCP slices. Its slicer is the fixture slicer.'};
  if (!(request.params.name in texts)) throw new Error(`Unknown prompt: ${request.params.name}`);
  return {messages: [{role: 'user', content: {type: 'text', text: texts[request.params.name]}}]};
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
  const progressToken = request.params._meta?.progressToken;
  // HANDOFF_FIXTURE_PROGRESS: print_3mf reports its upload as bambu-printer-mcp 1.1.77 does (counterpart/1).
  if (process.env.HANDOFF_FIXTURE_PROGRESS === '1' && name === 'print_3mf' && progressToken !== undefined)
    for (const sent of [0, 5_000_000, 18_362_734])
      await extra.sendNotification({method: 'notifications/progress', params: {progressToken, progress: sent, total: 18_362_734,
        message: `Sending to the printer: ${Math.floor(sent * 100 / 18_362_734)}%`, _meta: {'counterpart/stage': 'upload'}}});
  // HANDOFF_FIXTURE_PROGRESS: slice_stl reports its progress, as a slicer MCP may.
  if (process.env.HANDOFF_FIXTURE_PROGRESS === '1' && name === 'slice_stl' && progressToken !== undefined)
    for (const [progress, message] of [[1, 'Slicing plate 1'], [2, 'Writing the 3MF']]) {
      await extra.sendNotification({method: 'notifications/progress', params: {progressToken, progress, total: 2, message}});
      // As a slicer that is still working: the progress arrives before the result.
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  let args = request.params.arguments ?? {};
  if ((name === 'slice_stl' || name === 'print_3mf') && !args.bambu_model) args = await elicitModel(args);
  // The read-only capability query is not part of a print's sequence; tests assert what the print sends.
  if (name !== 'counterpart_printer_info') record({tool: name, arguments: args});
  if (name === 'get_slice_settings') {
    const own = process.env.HANDOFF_FIXTURE_OWN_PROCESS;
    if (own === 'error') return {isError: true, content: [{type: 'text', text: 'No slicer settings config found'}]};
    // As the MCPs decide it: a named profile or template replaces the file's process; an explicit value or a
    // quality or strength other than standard changes it.
    const changed = ['slicer_profile', 'template_name', 'template_3mf_path', 'layer_height', 'wall_loops', 'sparse_infill_density', 'enable_support', 'support_type'].some(key => args[key] !== undefined)
      || (args.quality ?? 'standard') !== 'standard' || (args.strength ?? 'standard') !== 'standard';
    return text({source_path: args.source_path, source_type: '3mf', summary: {layer_height: 0.16}, ...(own === 'absent' ? {} : {own_process: own === 'true' && !changed})});
  }
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
  if (name === 'list_3mf_plates') {
    // The stand-in MCP reads the plates the way the real ones do (bambu-printer-mcp src/counterpart/model-plates.ts).
    const {inspectModelFile, modelPlatePreview} = await import('../../dist/model-file.js');
    const bytes = readFileSync(args.three_mf_path);
    const info = inspectModelFile(bytes, '3mf');
    const {standInFilaments} = await import('../support/plate-filaments-stand-in.mjs');
    const filaments = standInFilaments(bytes);
    const plates = info.plates.map(plate => {
      const png = args.include_thumbnails ? modelPlatePreview(bytes, plate.index) : undefined;
      return {index: plate.index, name: plate.name, objects: plate.objects, sliced: plate.sliced, filaments: filaments.plates.get(plate.index + 1) ?? [], ...(png ? {thumbnail_png_base64: png.toString('base64')} : {})};
    });
    const value = {plate_count: plates.length, plates, project_filaments: filaments.project, ...(info.title ? {title: info.title} : {}), ...(info.designer ? {designer: info.designer} : {})};
    return {...text(value), structuredContent: value};
  }
  if (name === 'slice_stl') {
    // A real Bambu Studio result.json, returned as bambu-printer-mcp's slicer_result (verbatim).
    const slicerResult = process.env.HANDOFF_FIXTURE_SLICER_RESULT ? JSON.parse(readFileSync(process.env.HANDOFF_FIXTURE_SLICER_RESULT, 'utf8')) : undefined;
    // slicer_report, the verdict both MCPs give beside it since 1.1.63 / 1.2.36 (HANDOFF_FIXTURE_NO_SLICER_REPORT: an older MCP).
    const report = slicerResult && process.env.HANDOFF_FIXTURE_NO_SLICER_REPORT !== '1' ? {slicer_report: verdict(slicerResult)} : {};
    if (slicerResult && slicerResult.return_code !== 0) return {isError: true, structuredContent: {slicer_result: slicerResult, ...report},
      content: [{type: 'text', text: `Slicer failed: the slicer exited with code 156 (${slicerResult.error_string} [${slicerResult.return_code}]). Command failed: /Applications/BambuStudio.app/Contents/MacOS/BambuStudio --slice 0`}]};
    const path = join(directory, mode === 'generic-gcode' ? 'sliced.gcode' : 'sliced.3mf');
    writeFileSync(path, process.env.HANDOFF_FIXTURE_SLICED_FILE ? readFileSync(process.env.HANDOFF_FIXTURE_SLICED_FILE)
      : path.endsWith('.3mf') ? `fixture 3mf ${Date.now()}-${Math.random()}` : `; fixture gcode ${Date.now()}-${Math.random()}\n`);
    return slicerResult ? {...text(path), structuredContent: {path, slicer_result: slicerResult, ...report}} : text(path);
  }
  if (name === 'inspect_print_file') {
    // As bambu-printer-mcp 1.1.60 / mcp-3d-printer-server 1.2.34: the exact file's hash, and its G-code preview when asked.
    const {createHash} = await import('node:crypto');
    const sha256 = createHash('sha256').update(readFileSync(args.file_path)).digest('hex');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC';
    const preview = args.include_preview === true && process.env.HANDOFF_FIXTURE_PREVIEW !== 'none' ? {artifact_sha256: sha256, plate_index: args.plate_index ?? 0, mm_per_pixel: 0.125,
      views: [{name: 'top', label: 'Top, as it sits on the bed', png_base64: png, width: 1, height: 1}, {name: 'bed_side', label: 'Bed side, turned over toward you', png_base64: png, width: 1, height: 1}]} : undefined;
    return text({receipt_version: '1', dispatchAuthorized: false, artifact: {sha256}, selection: {bambu_model: args.bambu_model, plate_index: args.plate_index ?? 0},
      inspection: {model: args.bambu_model, plate: args.plate_index ?? 0}, ...(process.env.HANDOFF_FIXTURE_NO_SLICED_FACTS === '1' ? {} : {sliced: facts(readFileSync(args.file_path), args.plate_index ?? 0)}), ...(preview ? {preview} : {})});
  }
  if (name === 'confirm_temperatures') return text({compatible: true, peakNozzleTempC: 220});
  if (name === 'counterpart_print_route') {
    if (process.env.HANDOFF_FIXTURE_ROUTE === '"error"') return {isError: true, content: [{type: 'text', text: 'route unavailable'}]};
    const {mode, type} = JSON.parse(process.env.HANDOFF_FIXTURE_ROUTE);
    return text({route: mode === 'bambu_network' && type === 'cloud' ? 'cloud' : 'lan', mode, type, choices: ['lan', 'cloud'], savedTo: null});
  }
  if (name === 'counterpart_printer_info') return text({contract: 'counterpart/1', server: {name: 'fixture', version: '0'},
    printer: {kind: mode === 'bambu' ? 'bambu' : 'octoprint', host: '127.0.0.1'},
    capabilities: {progress: true, layers: true, camera: 'none', filaments: mode === 'bambu' ? 'ams' : 'single', pause: true, resume: true, cancel: true,
      // A route whose slice is a 3MF (Bambu, or mcp-3D's Bambu route) prints it with print_3mf.
      print3mf: mode !== 'generic-gcode', gcode: true, ...(slicing ? {slicing} : {})}});
  if (name === 'get_printer_status') return text({raw:{hms:[{attr:0x05000500,code:0x00010007}]}});
  if (name === 'clear_hms_errors') {await confirmPrint();return text({status:'success'});}
  if (name === 'camera_snapshot') return text({format: 'jpeg', base64: 'ZmFrZQ==', savedTo: join(directory, 'snapshot.jpg')});
  if (name === 'print_3mf' || name === 'upload_gcode' || name === 'process_and_print_stl') {
    // As bambu-printer-mcp 1.1.57 / mcp-3d-printer-server 1.2.31 return a refusal: the words plus a stable code.
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'preflight-error') return {isError:true, content:[{type:'text',text:'Error: Printer state FAILED is not safely idle.'}],
      structuredContent:{status:'error', retryable:false, suggestion:'Fix the printer state first.', message:'Printer state FAILED is not safely idle.', tool:name, code:'printer-not-ready'}};
    // As bambu-printer-mcp 1.1.74 reports an upload that failed before any print command was sent.
    if (process.env.HANDOFF_FIXTURE_DISPATCH === 'upload-error') return {isError:true, content:[{type:'text',text:'Error: The print file did not reach the printer (Timeout (data socket)). No print was started.'}],
      structuredContent:{status:'error', retryable:true, message:'The print file did not reach the printer (Timeout (data socket)). No print was started.', tool:name, code:'printer-upload-failed'}};
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
