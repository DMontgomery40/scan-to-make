import type {CleanupRunner} from './scan-cleanup-runner.js';
import {spawn} from 'node:child_process';
import {mkdir,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
export interface ScanRunner {snapshot?:()=>ScanRunner;jobTimeoutMs?:number;cleanup?:CleanupRunner;run(stage:'repair'|'measure'|'render',input:string,output:string,sidecar:string,signal:AbortSignal,onProcessGroup?:(pgid:number)=>void|Promise<void>):Promise<Buffer>}
/** Only trusted host configuration may construct this runner. The entire job has a separate deadline. */
export function createScanRunner(options:{blender:string;toolPath:string;python?:string;timeoutMs?:number}):ScanRunner {
 const {blender,toolPath}=options,timeout=options.timeoutMs??300000;
 if(!isAbsolute(blender)||!isAbsolute(toolPath)||!Number.isSafeInteger(timeout)||timeout<1||timeout>600000)throw new Error('Invalid scan runner configuration');
 return {async run(stage,input,output,sidecar,signal,onProcessGroup){
  signal.throwIfAborted();await mkdir(output,{recursive:true,mode:0o700});
  const args=[toolPath,stage,input,...(stage==='repair'?['--units-sidecar',sidecar]:['--units','mm']),...(stage==='measure'?[]:['--out',output]),...(stage==='repair'?['--weld-mm','.01','--component-fraction','.01','--component-metric','area','--hole-max-edges','0','--voxel-size-mm','.3','--denoise-iterations','15','--denoise-factor','.5','--denoise-mu=-.53','--denoise-max-mm','.35','--sharp-angle-deg','30','--deviation-samples','10000']:stage==='render'?['--resolution','512']:[])];
  const child=spawn(options.python??'python3',args,{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BLENDER:blender},windowsHide:true});
  let failed=false,size=0;const chunks:Buffer[]=[];
  const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{ /* already gone */ }};
  const timer=setTimeout(()=>{failed=true;kill();},timeout);
  // Bound logs and periodically bound output bytes, including files not retained by the store.
  let checking=false;
  const diskTimer=setInterval(()=>{if(checking)return;checking=true;void (async()=>{
   const {readdir}=await import('node:fs/promises');let total=0;
   for(const entry of await readdir(output,{withFileTypes:true})){
    if(!entry.isFile())throw new Error('Unexpected scan output');
    total+=(await stat(join(output,entry.name))).size;
    if(total>160*1024*1024)throw new Error('Scan output limit');
   }
  })().catch(()=>{failed=true;kill();}).finally(()=>checking=false);},100);
  const drain=(b:Buffer,save:boolean)=>{size+=b.length;if(size>1024*1024){failed=true;kill();}else if(save)chunks.push(b);};
  child.stdout.on('data',b=>drain(b,true));child.stderr.on('data',b=>drain(b,false));
  const done=new Promise<number|null>(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
  signal.addEventListener('abort',kill,{once:true});if(signal.aborted)kill();
  try {
   // Detached spawn makes the child its own process-group leader. Registration
   // must be acknowledged before the worker is allowed to continue; if the
   // store cannot record the group, terminate it so crash recovery is not
   // left with an unrecorded orphan.
   let registrationFailed=false;
   try{if(child.pid)await onProcessGroup?.(child.pid);}catch{registrationFailed=true;failed=true;kill();}
   const code=await done;signal.throwIfAborted();if(registrationFailed||failed||code!==0)throw new Error('Scan subprocess failed');return Buffer.concat(chunks);
  }
  finally {clearTimeout(timer);clearInterval(diskTimer);signal.removeEventListener('abort',kill);kill();}
 }};
}
