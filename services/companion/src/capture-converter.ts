import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CAPTURE_LIMITS,readBoundedCaptureFile,receiptFromConvertedBytes,readCaptureMaterials,type CaptureConverter} from './capture-import.js';

export interface CaptureConverterOptions {
 /** Trusted operator configuration; never accepted from an import request. */
 executable?:string; adapterPath?:string; temporaryRoot?:string; timeoutMs?:number;
}
export function createCaptureConverter(options:CaptureConverterOptions={}):CaptureConverter {
 const executable=options.executable??'python3';
 const adapter=options.adapterPath??fileURLToPath(new URL('../python/capture_convert.py',import.meta.url));
 const root=options.temporaryRoot??tmpdir();
 const timeout=options.timeoutMs??60000;
 if(!isAbsolute(adapter)||!isAbsolute(root)||!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new Error('Invalid capture converter configuration');
 return {async convert(source,signal){
  if(signal?.aborted)throw new Error('Capture conversion aborted');
  if(!Buffer.isBuffer(source)||!source.length||source.length>DEFAULT_CAPTURE_LIMITS.maxSourceBytes)throw new Error('Capture source byte limit exceeded');
  const original=Buffer.from(source);
  await mkdir(root,{recursive:true,mode:0o700});
  const folder=await mkdtemp(join(root,'capture-conversion-'));
  try {
   const input=join(folder,'original.usdz'),out=join(folder,'mesh.obj'),report=join(folder,'conversion.json');
   await writeFile(input,original,{flag:'wx',mode:0o600});
   if(signal?.aborted)throw new Error('Capture conversion aborted');
   const child=spawn(executable,[adapter,'--source',input,'--out',out,'--report',report,
    '--max-source-bytes',String(DEFAULT_CAPTURE_LIMITS.maxSourceBytes),'--max-derived-bytes',String(DEFAULT_CAPTURE_LIMITS.maxDerivedBytes),'--timeout-ms',String(timeout)],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
   let expired=false,overflow=false,spawnFailed=false,total=0;
   const kill=()=>{child.kill('SIGKILL');};
   const timer=setTimeout(()=>{expired=true;kill();},timeout);
   const drain=(bytes:Buffer)=>{total+=bytes.length;if(total>64*1024){overflow=true;kill();}};
   child.stdout.on('data',drain);child.stderr.on('data',drain);
   const done=new Promise<number|null>(resolve=>{child.once('error',()=>{spawnFailed=true;});child.once('close',resolve);});
   signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
   try {
    const code=await done;
    if(signal?.aborted)throw new Error('Capture conversion aborted');
    if(expired)throw new Error('Capture conversion timed out');
    if(overflow||spawnFailed||code!==0)throw new Error('Capture conversion failed or was unqualified');
   } finally {clearTimeout(timer);signal?.removeEventListener('abort',kill);}
   const derived=await readBoundedCaptureFile(out,DEFAULT_CAPTURE_LIMITS.maxDerivedBytes);
   const reportBytes=await readBoundedCaptureFile(report,DEFAULT_CAPTURE_LIMITS.maxReportBytes);
   receiptFromConvertedBytes(original,derived,reportBytes);
   const assets=await readCaptureMaterials(folder,derived,reportBytes);
   return {derived,report:reportBytes,assets};
  } finally {await rm(folder,{recursive:true,force:true});}
 }};
}
