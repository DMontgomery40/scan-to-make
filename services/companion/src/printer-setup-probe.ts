import {PrinterMcpClient,toolResultJson,type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {PrinterModelSchema,type PrinterProbe} from './printer-setup-protocol.js';

type Session = Pick<PrinterMcpClient,'connect'|'callTool'|'close'>;
type Factory = (config:PrinterHandoffConfig)=>Session;
/** Only the three read-only backend capabilities are called. Output is projected
 * onto a small schema; raw MQTT reports, backend logs and errors never escape. */
export async function probePrinter(config:PrinterHandoffConfig,fuluConfig:PrinterHandoffConfig|undefined,make:Factory=c=>new PrinterMcpClient(c)):Promise<PrinterProbe> {
  const result:PrinterProbe={status:'failed',camera:config.backend==='bambu-printer-mcp'?'failed':'not-supported',fulu:'unavailable'};
  const client=make(config);
  try {
    await client.connect();
    const status=toolResultJson(await client.callTool('get_printer_status',{}, {timeoutMs:20000}));
    if (config.backend==='bambu-printer-mcp') {
      if (status.connected===true && status.status!=='error') result.status='connected';
      const model=PrinterModelSchema.safeParse(String(status.model ?? '').toLowerCase().replace(/^bambu lab\s+|\s+/g,''));
      if (model.success) result.model=model.data;
      const raw=status.raw as {firmware?:unknown;sw_ver?:unknown;info?:{module?:{name?:unknown;sw_ver?:unknown}[]}}|undefined;
      const firmware=raw?.firmware ?? raw?.sw_ver ?? raw?.info?.module?.find(v=>v.name==='ota')?.sw_ver;
      if (typeof firmware==='string' && /^\d{2}\.\d{2}\.\d{2}\.\d{2}$/.test(firmware)) result.firmware=firmware;
    } else if (status.error===undefined && status.status!=='error' && status.connected!==false && Object.keys(status).length>0) result.status='connected';
    if (config.backend==='bambu-printer-mcp' && result.status==='connected') {
      try {
        const frame=toolResultJson(await client.callTool('camera_snapshot',{timeout_ms:8000},{timeoutMs:12000}));
        if (frame.format==='image/jpeg' && typeof frame.base64==='string' && frame.base64.length<=700000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64)) {
          const bytes=Buffer.from(frame.base64,'base64');
          if (bytes.length>=4 && bytes[0]===0xff && bytes[1]===0xd8 && bytes.at(-2)===0xff && bytes.at(-1)===0xd9) {
            result.camera='connected';result.image={mimeType:'image/jpeg',base64:frame.base64};
          }
        }
      } catch { /* Status success cannot hide a failed camera check. */ }
    }
  } catch { /* Sanitized failed check, never raw tool error. */ }
  finally {await client.close();}
  if (fuluConfig) {
    // The runtime may invoke a configured VM wrapper. This separate MCP process
    // has no printer credential, so discovering it cannot leak an access code.
    const bridge=make(fuluConfig);
    try {
      await bridge.connect();
      const found=toolResultJson(await bridge.callTool('bambu_network_bridge_status',{}, {timeoutMs:5000}));
      if (found.configured===true) {
        const probe=toolResultJson(await bridge.callTool('bambu_network_bridge_status',{connect:true},{timeoutMs:20000}));
        if (probe.connected===true && probe.agentReady===true) result.fulu='available';
      }
    } catch { /* Runtime discovery is optional. */ }
    finally {await bridge.close();}
  }
  return result;
}
