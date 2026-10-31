import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,realpath,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {PrinterMcpClient,toolResultJson,toolResultText,type PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import {BoxDimensionsMmSchema,BoxRotationSchema,SIZE_EDGES,type BoxDimensionsMm,type BoxRotation,type SizeTransformSchema} from '@scan-to-make/contracts/model-size';
import type {z} from 'zod';
import {readBoundedCaptureFile} from './capture-import.js';

export interface SizeModelInput {bytes:Buffer;sha256:string;dimensionsMm:BoxDimensionsMm;rotation:BoxRotation}
export interface SizeModelResult {bytes:Buffer;dimensionsMm:BoxDimensionsMm;transform:z.infer<typeof SizeTransformSchema>}
export type ModelSizeRunner=(input:SizeModelInput,factors:BoxDimensionsMm,work:string,signal:AbortSignal)=>Promise<SizeModelResult>;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const tuple=(v:Record<string,number>)=>[v.x!,v.y!,v.z!] as [number,number,number];
const dimensions=(v:Record<string,number>)=>BoxDimensionsMmSchema.parse({length:v.x,width:v.y,height:v.z});
const near=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(.01,Math.abs(b)*1e-6);

/** Adapt the KAN-115 rotation matrix to Bambu's documented Three XYZ Euler convention. */
export function boxRotationDegrees(input:BoxRotation){
 const m=BoxRotationSchema.parse(input),y=Math.asin(Math.max(-1,Math.min(1,m[0][2])));
 const x=Math.abs(m[0][2])<.9999999?Math.atan2(-m[1][2],m[2][2]):Math.atan2(m[2][1],m[1][1]);
 const z=Math.abs(m[0][2])<.9999999?Math.atan2(-m[0][1],m[0][0]):0;
 return [x,y,z].map(v=>v*180/Math.PI) as [number,number,number];
}

export async function installedBambuProcess():Promise<PrinterMcpProcess>{
 for(const dir of (process.env.PATH??'').split(':').filter(isAbsolute)){
  const file=join(dir,'bambu-printer-mcp');try{await access(file,constants.X_OK);return {command:process.execPath,args:[file]};}catch{/* next trusted host PATH entry */}
 }
 throw Error('Bambu mesh tools are not installed');
}

/** Geometry is changed only by Bambu's MCP tools, in a new private operation directory. */
export function createModelSizeRunner(processFor:()=>Promise<PrinterMcpProcess>):ModelSizeRunner{
 return async(input,factors,work,signal)=>{
  signal.throwIfAborted();BoxRotationSchema.parse(input.rotation);BoxDimensionsMmSchema.parse(factors);
  if(sha(input.bytes)!==input.sha256)throw Error('Size input identity mismatch');
  const root=await realpath(work),temp=join(root,'mcp');await mkdir(temp,{mode:0o700});
  const source=join(root,`source-${randomUUID()}.stl`);await writeFile(source,input.bytes,{flag:'wx',mode:0o600});
  const host=await processFor();signal.throwIfAborted();
  const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:{...host,cwd:host.cwd??root,env:{...host.env,TEMP_DIR:temp}},timeouts:{connectMs:10000,toolMs:30000}});
  // close() clears client fields before awaiting transport/process shutdown.
  // Share the first promise so abort and finally await the same child exit.
  let closing:Promise<void>|undefined;const close=()=>closing??=client.close();
  const abort=()=>{void close();};signal.addEventListener('abort',abort,{once:true});
  const info=async(path:string)=>{
   const r=toolResultJson<{boundingBox:{min:Record<string,number>;max:Record<string,number>;center:Record<string,number>;dimensions:Record<string,number>};faceCount:number}>(await client.callTool('get_stl_info',{stl_path:path},{signal}));
   const box=r.boundingBox,size=dimensions(box.dimensions);
   if(!Number.isSafeInteger(r.faceCount)||r.faceCount<1)throw Error('Invalid STL face count');
   for(const axis of ['x','y','z'])if(!near(box.max[axis]!-box.min[axis]!,box.dimensions[axis]!)||!near((box.max[axis]!+box.min[axis]!)/2,box.center[axis]!))throw Error('Invalid STL bounds');
   return {size,centre:tuple(box.center),faces:r.faceCount};
  };
  const outputPath=async(value:unknown)=>{
   if(typeof value!=='string'||!isAbsolute(value))throw Error('Invalid MCP output path');
   const path=await realpath(value),rel=relative(temp,path);
   if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('MCP output outside operation');
   await readBoundedCaptureFile(path,64*1024*1024);return path;
  };
  try{
   await client.connect(signal);const before=await info(source);
   let oriented=source;const [angle_x,angle_y,angle_z]=boxRotationDegrees(input.rotation);
   if([angle_x,angle_y,angle_z].some(v=>Math.abs(v)>1e-9))oriented=await outputPath(toolResultText(await client.callTool('rotate_stl',{stl_path:source,angle_x,angle_y,angle_z},{signal})));
   const framed=await info(oriented);
   if(framed.faces!==before.faces||SIZE_EDGES.some(e=>!near(framed.size[e],input.dimensionsMm[e])))throw Error('STL disagrees with its oriented box');
   const scaled=await outputPath(toolResultText(await client.callTool('scale_stl',{stl_path:oriented,scale_x:factors.length,scale_y:factors.width,scale_z:factors.height},{signal})));
   if(scaled===oriented)throw Error('Scaling must produce a new model');
   const after=await info(scaled);
   if(after.faces!==before.faces||SIZE_EDGES.some((e,i)=>!near(after.size[e],input.dimensionsMm[e]*factors[e])||!near(after.centre[i]!,framed.centre[i]!*factors[e])))throw Error('Scaled STL dimensions disagree with requested size');
   if(sha(await readBoundedCaptureFile(source,64*1024*1024))!==input.sha256)throw Error('Scaling changed the original');
   signal.throwIfAborted();return {bytes:await readBoundedCaptureFile(scaled,64*1024*1024),dimensionsMm:after.size,
    transform:{rotation:input.rotation,centreMm:before.centre,scaleFactors:factors}};
  }finally{signal.removeEventListener('abort',abort);await close();}
 };
}
