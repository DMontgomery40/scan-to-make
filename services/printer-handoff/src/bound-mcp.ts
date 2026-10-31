import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {timeoutsFor,type PrinterHandoffConfig} from './config.js';
import {PrinterMcpClient} from './mcp-client.js';

export interface PrinterBinding {
  host:string; port?:string; type?:string; model?:string;
  connectionMode?:'lan_mqtt_ftps'|'bambu_native'|'bambu_network'|'bambu_connect';
}
// This is the existing handoff's tool surface, not a general credential-bearing
// MCP tunnel. In particular, no raw RPC, executable selector or credential arg.
const allowed:Record<string,readonly string[]> = {
  lay_flat:['stl_path'],
  slice_stl:['stl_path','bambu_model','nozzle_diameter','bed_type','nozzle_type','slicer_type','slicer_profile','filament_profile','load_filaments','template_name','use_printer_filaments','orient','arrange','ensure_on_bed'],
  inspect_print_file:['file_path','bambu_model','plate_index','nozzle_diameters','bed_type'],
  confirm_temperatures:['gcode_path'],
  camera_snapshot:['bambu_model','timeout_ms'],
  get_printer_status:[],
  get_printer_filaments:['bambu_model','nozzle_diameter'],
  print_3mf:['three_mf_path','bambu_model','bed_type','nozzle_type','nozzle_diameter','nozzle_diameters','plate_index','use_ams','ams_slots','ams_mapping','auto_match_ams','bed_leveling','flow_calibration','vibration_calibration','layer_inspect','timelapse'],
  upload_gcode:['gcode_path','print','filename','material','type','host','port'],
};
function invalid():never {throw new McpError(ErrorCode.InvalidParams,'The tool arguments do not match the saved printer');}
export function boundPrinterArguments(binding:PrinterBinding,name:string,input:Record<string,unknown>):Record<string,unknown> {
  if (!Object.hasOwn(allowed,name)) invalid();
  if (Object.keys(input).some(key=>!allowed[name]!.includes(key))) invalid();
  const args=structuredClone(input);
  for (const [key,expected] of [['host',binding.host],['port',binding.port],['type',binding.type],['bambu_model',binding.model]] as const) {
    if (args[key]!==undefined && args[key]!==expected) invalid();
  }
  if (name==='print_3mf' && binding.connectionMode) {
    args.connection_mode=binding.connectionMode;
    if (binding.connectionMode==='bambu_network') args.connection_type='lan';
  }
  return args;
}

/** Redact even successful upstream messages: status raw telemetry and nested
 * JSON text can contain a camera URL. No private backend error crosses IPC. */
export function redactPrinterSecrets(value:unknown,secrets:readonly string[]):unknown {
  if (typeof value==='string') {
    try {const parsed:unknown=JSON.parse(value);if(parsed && typeof parsed==='object') return JSON.stringify(redactPrinterSecrets(parsed,secrets));} catch { /* Plain text. */ }
    for (const secret of secrets) if (secret) value=(value as string).split(secret).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(v=>redactPrinterSecrets(v,secrets));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[redactPrinterSecrets(k,secrets) as string,redactPrinterSecrets(v,secrets)]));
  return value;
}

/** Keep upstream MCP discovery/schema validation/elicitation intact. Only the
 * signed helper supplies config/binding, after resolving the immutable item. */
export async function serveBoundPrinter(config:PrinterHandoffConfig,binding:PrinterBinding) {
  const server=new Server({name:'scan-to-make-saved-printer',version:'1.0.0'},{capabilities:{tools:{}}});
  const secrets=[config.process.env?.BAMBU_TOKEN,config.process.env?.API_KEY].filter((v):v is string=>!!v);
  const client=new PrinterMcpClient(config,{relay:{
    request:request=>server.elicitInput(redactPrinterSecrets(request.params,secrets) as typeof request.params,{timeout:timeoutsFor(config).elicitationMs}),
    pending:()=>[],respond:()=>false,subscribe:()=>()=>{},cancelAll:()=>{},
  }});
  let finish:()=>void=()=>{};
  const closed=new Promise<void>(resolve=>{finish=resolve;});
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;try {await client.close();await server.close();} finally {finish();}};
  server.onclose=()=>{void close();};
  server.onerror=()=>{};
  try {
    const catalog=await client.connect();
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:catalog.tools.filter(t=>Object.hasOwn(allowed,t.name))}));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
      const args=boundPrinterArguments(binding,request.params.name,request.params.arguments ?? {});
      try {
        const result=await client.callTool(request.params.name,args,{signal:extra.signal});
        if(result.isError) return {isError:true,content:[{type:'text' as const,text:'The printer operation failed'}]};
        return redactPrinterSecrets(result,secrets) as typeof result;
      } catch {return {isError:true,content:[{type:'text' as const,text:'The printer operation failed'}]};}
    });
    await server.connect(new StdioServerTransport());
    return {close,closed};
  } catch {await close();throw new Error('Saved printer unavailable');}
}
