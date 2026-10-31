import {spawn} from 'node:child_process';
import {lstat,mkdir,readdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ScanReference} from '@scan-to-make/contracts/scan-processing';
import {createScanRunner,type ScanRunner} from './scan-processing-runner.js';

export interface CleanupContext {
 source:string; imported:string; repaired:string; advice:string; corrected:string;
 stills:string[]; reference?:ScanReference; signal:AbortSignal; onProcessGroup?:(pid:number)=>void|Promise<void>;
}
export interface CleanupRunner {
 adapter:'scripted'|'anthropic'|'openai';
 run(stage:'import'|'advise'|'correct',context:CleanupContext):Promise<Buffer>;
}
export interface CleanupOptions {
 blender:string; toolPath:string; correctTool:string; python?:string; timeoutMs?:number;
 converterAdapter?:string; adapter?:CleanupRunner['adapter']; model?:string; baseUrl?:string; keyEnv?:string;
}
const supervisor=fileURLToPath(new URL('../python/scan_job.py',import.meta.url));

export async function checkCleanupDisk(root:string){
 let bytes=0,files=0;
 const walk=async(path:string):Promise<void>=>{
  let entries:string[];try{entries=await readdir(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  for(const entry of entries){
   const full=join(path,entry);let info;try{info=await lstat(full);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   if(info.isSymbolicLink())throw Error('Unexpected worker symlink');
   if(++files>4000)throw Error('Worker file count exceeded');
   if(info.isDirectory())await walk(full);
   else if(info.isFile()){bytes+=info.size;if(bytes>512*1024*1024)throw Error('Worker byte budget exceeded');}
   else throw Error('Unexpected worker file type');
  }
 };
 await walk(root);
}

async function command(python:string,args:string[],root:string,blender:string,timeout:number,context:CleanupContext){
 context.signal.throwIfAborted();
 const child=spawn(python,['-I',supervisor,...args],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BLENDER:blender},windowsHide:true});
 let failed=false,size=0;const chunks:Buffer[]=[];let fallback:NodeJS.Timeout|undefined;
 const terminate=()=>{
  if(child.pid){try{process.kill(child.pid,'SIGTERM');}catch{/* gone */}
   fallback??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{/* gone */}},2000);}
 };
 const timer=setTimeout(()=>{failed=true;terminate();},timeout);
 let checking:Promise<void>|undefined;
 const diskTimer=setInterval(()=>{if(checking)return;checking=checkCleanupDisk(root).catch(()=>{failed=true;terminate();}).finally(()=>checking=undefined);},250);
 const drain=(b:Buffer,save:boolean)=>{size+=b.length;if(size>2*1024*1024){failed=true;terminate();}else if(save)chunks.push(b);};
 child.stdout.on('data',b=>drain(b,true));child.stderr.on('data',b=>drain(b,false));
 const done=new Promise<number|null>(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
 context.signal.addEventListener('abort',terminate,{once:true});if(context.signal.aborted)terminate();
 try{
  try{if(child.pid)await context.onProcessGroup?.(child.pid);}catch{failed=true;terminate();}
  const code=await done;await checking;await checkCleanupDisk(root);context.signal.throwIfAborted();
  if(failed||code!==0)throw Error('Cleanup subprocess failed');
  return Buffer.concat(chunks);
 }finally{
  clearTimeout(timer);clearInterval(diskTimer);if(fallback)clearTimeout(fallback);
  context.signal.removeEventListener('abort',terminate);
 }
}

/** Operator-selected executables/provider only; no executable or provider URL comes from the phone. */
export function createScanCleanupRunner(options:CleanupOptions):ScanRunner{
 const repair=createScanRunner(options),adapter=options.adapter??'scripted',timeout=options.timeoutMs??300000;
 const converter=options.converterAdapter??fileURLToPath(new URL('../python/capture_convert.py',import.meta.url));
 if(!isAbsolute(options.correctTool)||!isAbsolute(converter)||!['scripted','anthropic','openai'].includes(adapter))throw Error('Invalid cleanup configuration');
 return {...repair,jobTimeoutMs:1800000,cleanup:{adapter,async run(stage,ctx){
  const dimensions=ctx.reference?[...ctx.reference.dimensionsMm].sort((a,b)=>b-a):undefined;
  const reference=dimensions?['--reference-mm',...dimensions.map(String)]:[];
  const stageBudget=Math.min(timeout,stage==='correct'?300000:120000);
  const workerSeconds=String(Math.max(1,Math.floor(stageBudget/1000)));
  let args:string[];
  if(stage==='import'){
   await mkdir(ctx.imported,{recursive:true,mode:0o700});
   args=[converter,'--source',ctx.source,'--out',join(ctx.imported,'mesh.obj'),'--report',join(ctx.imported,'conversion.json'),
    '--max-source-bytes',String(32*1024*1024),'--max-derived-bytes',String(64*1024*1024),'--timeout-ms',String(stageBudget)];
  }else if(stage==='advise'){
   args=[options.correctTool,'advise',join(ctx.repaired,'repaired.obj'),'--units','mm','--out',ctx.advice,
    '--max-targets','4','--resolution','256','--max-seconds',workerSeconds,...reference];
  }else{
   args=[options.correctTool,'run',join(ctx.repaired,'repaired.obj'),'--units','mm','--out',ctx.corrected,'--adapter',adapter,
    '--max-steps','24','--max-seconds',workerSeconds,'--max-faces','200000','--product',ctx.reference?.productName??'unidentified object',...reference,
    ...ctx.stills.flatMap(path=>['--still',path])];
   if(adapter==='scripted'){
    const script=join(ctx.imported,'cleanup-sequence.json');
    await writeFile(script,JSON.stringify(dimensions?[{name:'scale_to_reference',arguments:{target_mm:dimensions}},{name:'measure',arguments:{}}]:[{name:'measure',arguments:{}}]),{flag:'wx',mode:0o600});
    args.push('--script',script);
   }else{
    if(options.model)args.push('--model',options.model);
    if(options.baseUrl)args.push('--base-url',options.baseUrl);
    if(options.keyEnv)args.push('--key-env',options.keyEnv);
   }
  }
  // Every stage lives under the job directory; include source/still bytes in its budget.
  return command(options.python??'python3',args,join(ctx.imported,'..'),options.blender,stageBudget+30000,ctx);
 }}};
}
