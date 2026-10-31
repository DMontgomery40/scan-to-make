import {createHash} from 'node:crypto';
import {PrinterMcpClient,toolResultJson,type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';

type Session=Pick<PrinterMcpClient,'connect'|'callTool'|'close'|'hasTool'>;
export interface PrinterCheckSnapshot {
  state:'idle'|'checking'|'complete';
  status?:'connected'|'failed';
  camera?:'connected'|'failed'|'not-supported';
  cameraSha256?:string;
  cameraBytes?:number;
}
/** Read-only, single-flight diagnostic in the actual companion process tree.
 * Start/poll avoids extending the control socket's short request deadline. */
export function createPrinterCheck(config:PrinterHandoffConfig,make:(c:PrinterHandoffConfig)=>Session=c=>new PrinterMcpClient(c)) {
  let snapshot:PrinterCheckSnapshot={state:'idle'},running:Promise<void>|undefined;
  const abort=new AbortController();
  async function run() {
    const result:PrinterCheckSnapshot={state:'complete',status:'failed',camera:config.backend==='bambu-printer-mcp'?'failed':'not-supported'};
    const client=make({...config,timeouts:{...config.timeouts,connectMs:10000,toolMs:20000}});
    try {
      await client.connect(abort.signal);
      const cameraEnabled=config.backend==='bambu-printer-mcp' && config.cameraSnapshot!==false && client.hasTool('camera_snapshot');
      if(!cameraEnabled)result.camera='not-supported';
      const target=Object.fromEntries(Object.entries({host:config.selection?.host,
        ...(config.backend==='mcp-3d-printer-server'?{type:config.selection?.printerType,port:config.selection?.port}:{})}).filter(([,value])=>value!==undefined));
      const status=toolResultJson(await client.callTool('get_printer_status',target, {signal:abort.signal,timeoutMs:20000}));
      if(config.backend==='bambu-printer-mcp' ? status.connected===true && status.status!=='error'
        : status.connected!==false && status.error===undefined && status.status!=='error' && Object.keys(status).length>0)result.status='connected';
      if(result.status==='connected' && cameraEnabled){
        const frame=toolResultJson(await client.callTool('camera_snapshot',{...target,timeout_ms:8000,
          ...(config.selection?.model ? {bambu_model:config.selection.model} : {})},{signal:abort.signal,timeoutMs:12000}));
        if(['jpeg','image/jpeg'].includes(String(frame.format)) && typeof frame.base64==='string' && frame.base64.length<=700000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.base64)){
          const bytes=Buffer.from(frame.base64,'base64');
          if(bytes.length>=4 && bytes[0]===0xff && bytes[1]===0xd8 && bytes.at(-2)===0xff && bytes.at(-1)===0xd9){
            result.camera='connected';result.cameraBytes=bytes.length;result.cameraSha256=createHash('sha256').update(bytes).digest('hex');
          }
        }
      }
    }catch{/* No printer reports, credentials, addresses or raw errors cross the socket. */}
    finally{await client.close().catch(()=>undefined);snapshot=result;}
  }
  return {
    get(start=false):PrinterCheckSnapshot {
      if(start&&!running&&!abort.signal.aborted){
        snapshot={state:'checking'};
        running=run().finally(()=>{running=undefined;});
      }
      return {...snapshot};
    },
    async close(){abort.abort();await running;},
  };
}
