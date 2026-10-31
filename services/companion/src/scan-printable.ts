import {createHash} from 'node:crypto';
import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PrinterMcpClient,toolResultJson,type PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import {readBoundedCaptureFile} from './capture-import.js';
import {readScanMaterials} from './scan-model-assets.js';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const bridge=fileURLToPath(new URL('../python/headless_blender_mcp.py',import.meta.url));
export interface MakePrintableOptions {
 /** Normalized chosen bundle, in mm and with its own output hashes. */
 input:string; output:string; hashes:Record<string,string>;
 /** Trusted installed Bambu MCP process, independent of printer credentials. */
 bambu:PrinterMcpProcess; blender:string; python:string; signal:AbortSignal;
 /** repair.py in the separately installed cleanup tools, outside the app payload. */
 repairTool:string;
}
export interface PrintableReport {
 schema:'scan-to-make.printable/0.1'; status:'ready'|'blocked'; problems:string[]; warnings:string[];
 before:{bboxMm:{min:number[];max:number[]};components:number};
 after:{bboxMm:{min:number[];max:number[]};components:number;watertight:boolean};
 boundsChangeMm:number; exteriorDeviationMm:number; selfIntersections:number;
 [key:string]:unknown;
}

function validateReport(value:unknown):PrintableReport{
 const r=value as PrintableReport;
 if(!r||r.schema!=='scan-to-make.printable/0.1'||!['ready','blocked'].includes(r.status)||
  !Array.isArray(r.problems)||!Array.isArray(r.warnings)||!r.after||!r.before)throw Error('Invalid printability report');
 for(const state of [r.before,r.after])for(const values of [state.bboxMm?.min,state.bboxMm?.max])
  if(!Array.isArray(values)||values.length!==3||!values.every(Number.isFinite))throw Error('Invalid printability bounds');
 const boundsDelta=Math.max(...(['min','max'] as const).flatMap(k=>r.before.bboxMm[k].map((v,i)=>Math.abs(v-r.after.bboxMm[k][i]!))));
 if(r.status==='ready'&&(r.problems.length||r.after.components!==1||!r.after.watertight||r.selfIntersections!==0||
  boundsDelta>.05||Math.abs(boundsDelta-r.boundsChangeMm)>1e-6||
  !Number.isFinite(r.boundsChangeMm)||r.boundsChangeMm>.05||r.boundsChangeMm<0||
  !Number.isFinite(r.exteriorDeviationMm)||r.exteriorDeviationMm>.05||r.exteriorDeviationMm<0))throw Error('Unverified printability result');
 return r;
}

/** Called after the visual pick and before final measurement/publication.
 * Returns a diagnostic-only blocked result when no surface-preserving solid is possible.
 * No HTTP/model-provided command, tool name, Python code or executable is accepted.
 */
export async function runMakePrintable(options:MakePrintableOptions){
 const {signal}=options;signal.throwIfAborted();
 for(const path of [options.input,options.output,options.blender,options.python,options.bambu.command,options.repairTool])
  if(!isAbsolute(path))throw Error('Make-printable requires absolute host paths');
 if(resolve(options.input)===resolve(options.output))throw Error('Input and output must differ');
 const mesh=await readBoundedCaptureFile(join(options.input,'corrected.obj'),64*1024*1024);
 if(sha(mesh)!==options.hashes['corrected.obj'])throw Error('Chosen mesh identity mismatch');
 const assets=await readScanMaterials(options.input,mesh,options.hashes);
 await mkdir(options.output,{mode:0o700}); // Fresh, never overwrite an earlier result.
 const input=join(options.output,'.input'),stage=join(options.output,'.stage');
 await mkdir(input,{mode:0o700});await mkdir(stage,{mode:0o700});
 const snapshot={'corrected.obj':mesh,...assets};
 for(const [name,bytes] of Object.entries(snapshot))await writeFile(join(input,name),bytes,{flag:'wx',mode:0o600});
 const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:{...options.bambu,cwd:options.output,
  env:{...options.bambu.env,BLENDER_MCP_COMMAND:options.python,BLENDER_MCP_ARGS:JSON.stringify([bridge]),
   BLENDER_STM_EXECUTABLE:options.blender,BLENDER_MCP_TIMEOUT_MS:'125000'}},timeouts:{connectMs:15000,toolMs:130000}});
 const cancelled=()=>{void client.close();};signal.addEventListener('abort',cancelled,{once:true});
 try{
  await client.connect(signal);
  const connected=await client.callTool('blender_mcp_status',{connect:true},{signal});
  if(connected.isError)throw Error('Blender MCP unavailable');
  const repairRoot=dirname(options.repairTool);
  const worker=join(repairRoot,'scan_printable.py'),repairCore=join(repairRoot,'blender_tool.py');
  const config={input:join(input,'corrected.obj'),output:stage,repairCore};
  // JSON is data here, decoded by Python; no shell interpolation or executable input.
  const code=`import json, runpy\nrunpy.run_path(${JSON.stringify(worker)})['run'](json.loads(${JSON.stringify(JSON.stringify(config))}))\n`;
  const executed=await client.callTool('blender_mcp_call',{tool_name:'execute_blender_code',arguments:{code,user_prompt:'Make the selected scan printable, preserving its captured surface, texture, scale and frame.'}},{signal});
  if(executed.isError)throw Error('Make-printable Blender operation failed');
  const report=validateReport(JSON.parse((await readBoundedCaptureFile(join(stage,'printable.json'),2*1024*1024)).toString()));
  const outputs:Record<string,string>={};
  if(report.status==='ready'){
   const obj=await readBoundedCaptureFile(join(stage,'corrected.obj'),64*1024*1024);
   const stl=await readBoundedCaptureFile(join(stage,'corrected.stl'),64*1024*1024);
   // Verify material closure against the picked assets, including after edits.
   for(const [name,bytes] of Object.entries(assets))await writeFile(join(stage,name),bytes,{flag:'wx',mode:0o600});
   await readScanMaterials(stage,obj,options.hashes);
   const info=toolResultJson<{boundingBox:{min:Record<string,number>;max:Record<string,number>};faceCount:number}>(
    await client.callTool('get_stl_info',{stl_path:join(stage,'corrected.stl')},{signal}));
   for(const bound of ['min','max'] as const)for(const [i,axis] of ['x','y','z'].entries()){
    const measured=info.boundingBox?.[bound]?.[axis],expected=report.after.bboxMm[bound][i];
    if(typeof measured!=='number'||!Number.isFinite(measured)||expected===undefined||Math.abs(measured-expected)>.001)throw Error('STL geometry disagrees with textured result');
   }
   if(!Number.isSafeInteger(info.faceCount)||info.faceCount<4)throw Error('Invalid output STL');
   report.stlInspection={tool:'get_stl_info',faceCount:info.faceCount,boundingBox:info.boundingBox};
   for(const [name,bytes] of Object.entries({'corrected.obj':obj,'corrected.stl':stl,...assets}))outputs[name]=sha(bytes);
  }
  for(const [name,bytes] of Object.entries(snapshot))
   if(sha(await readBoundedCaptureFile(join(input,name),64*1024*1024))!==sha(bytes))throw Error('Make-printable input was modified');
  signal.throwIfAborted();
  const completed={...report,outputs,inputHashes:Object.fromEntries(Object.entries(snapshot).map(([n,b])=>[n,sha(b)]))};
  // The report is the commit marker. Incomplete/aborted output has no report.
  for(const name of Object.keys(outputs))await rename(join(stage,name),join(options.output,name));
  signal.throwIfAborted();
  await writeFile(join(options.output,'printable.json'),JSON.stringify(completed,null,2)+'\n',{flag:'wx',mode:0o600});
  return completed;
 }finally{
  signal.removeEventListener('abort',cancelled);await client.close();
  await rm(input,{recursive:true,force:true});await rm(stage,{recursive:true,force:true});
 }
}
