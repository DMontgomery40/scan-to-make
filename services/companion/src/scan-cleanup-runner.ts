import {spawn} from 'node:child_process';
import {accessSync,constants} from 'node:fs';
import {access,copyFile,lstat,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModelAccessEnvironment} from '@scan-to-make/contracts/model-access';
import type {ScanReference} from '@scan-to-make/contracts/scan-processing';
import {validateAccess,type ModelAccess} from './ai-tweak.js';
import {aiTweakRecord,writeAiCorrection} from './ai-tweak-export.js';
import {MAKER_LOOKUP_MS} from './maker-size-lookup.js';
import {createScanRunner,type ScanRunner} from './scan-processing-runner.js';
import type {PrinterMcpProcess} from '@scan-to-make/printer-handoff';

export interface CleanupContext {
 source:string; imported:string; repaired:string; advice:string; corrected:string;
 stills:string[]; reference?:ScanReference; signal:AbortSignal; onProcessGroup?:(pid:number)=>void|Promise<void>;
 /** The imported mesh's scale, known after the import stage. */
 metersPerUnit?:number;
 /** When the whole job's deadline fires (epoch ms); the AI step sizes its budget from it. */
 deadlineAt?:number;
 /** The correction this job was queued for; the runner's current adapter may have changed since (KAN-198). */
 adapter?:CleanupRunner['adapter'];
 /** Bytes of the job's input snapshot (original capture and close-ups) under the job folder. */
 inputBytes?:number;
}
export interface CleanupRunner {
 adapter:'scripted'|'anthropic'|'openai'|'ai-tweak';
 run(stage:'import'|'advise'|'correct',context:CleanupContext):Promise<Buffer>;
}
/** Runs `ai-tweak-cli run <args>` with the user's model access; the Mac app's ModelAccessService.run fits. */
export type AiWorker=(args:string[],options:{signal?:AbortSignal;timeoutMs?:number;onProcessGroup?:(pgid:number)=>void|Promise<void>})=>Promise<{exitCode:number;stdout:string}>;
export interface AiCleanupOptions {
 /**
  * From SCAN_TO_MAKE_AI_* (modelAccessFromEnv) for headless setups and tests, or read live from the Mac app's
  * saved choice (KAN-198). 'none' keeps scan-correct.
  */
 access:ModelAccess|(()=>ModelAccess);
 /** Absolute path to the built ai-tweak-cli.js, spawned directly when no worker is given. */
 cli:string;
 /** Absolute path to tools/ai-tweak-judge, handed to a direct worker as SCAN_TO_MAKE_AI_JUDGE_TOOL (never an argument). */
 judgeTool:string;
 /** A keyed worker (the Mac app's helper) resolves the judge tool from its own installation. */
 worker?:AiWorker;
 attempts?:number;
}
export interface CleanupOptions {
 blender:string; toolPath:string; correctTool:string; python?:string; timeoutMs?:number;
 converterAdapter?:string; adapter?:Exclude<CleanupRunner['adapter'],'ai-tweak'>; model?:string; baseUrl?:string; keyEnv?:string;
 ai?:AiCleanupOptions;
 /** Host bootstrap enables post-correction printability. No printer credentials needed. */
 printable?:{bambu?:PrinterMcpProcess};
}

/** Whole-job deadlines: 30 minutes, or 60 with the AI step (two sealed attempts plus the visual pick). */
export const CLEANUP_JOB_MS=1800000,AI_CLEANUP_JOB_MS=3600000;
/** Time kept back after the AI step for make-printable (about 3 minutes), measure and render (each capped at 5) and publication. */
export const AI_AFTER_MS=14*60000;
const MINUTE=60000;
/**
 * Split the time left before the job deadline. The worker's hard limit ends before the reserve, so an
 * AI step that runs long falls back to the captured scan instead of failing the job. Inside it:
 * Codex's sign-in warm-up (at most 5 minutes), the parallel attempts, the pick's measure and render
 * calls, and the judge. Undefined when too little time is left for an attempt to be worth starting.
 */
export function aiStageBudget(remainingMs:number,kind:Exclude<ModelAccess['kind'],'none'>){
 const stageMs=Math.min(45*MINUTE,remainingMs-AI_AFTER_MS);
 const warmupMs=kind==='codex-cli'?5*MINUTE:0,pickMs=6*MINUTE,judgeMs=Math.min(12*MINUTE,Math.max(3*MINUTE,Math.floor(stageMs/4)));
 // The worker also needs a moment after the attempts to export and exit.
 const attemptMs=stageMs-warmupMs-pickMs-judgeMs-MAKER_LOOKUP_MS-MINUTE;
 if(!(attemptMs>=5*MINUTE))return undefined;
 return {stageMs,attemptMs:Math.min(attemptMs,30*MINUTE),judgeMs,warmupMs,pickMs,makerLookupMs:MAKER_LOOKUP_MS};
}

/** An executable by absolute path, or found on PATH; the pick takes only absolute tool paths. */
function absoluteExecutable(name:string,path=process.env.PATH??''){
 if(isAbsolute(name))return name;
 for(const dir of path.split(':')){if(!isAbsolute(dir))continue;const full=join(dir,name);try{accessSync(full,constants.X_OK);return full;}catch{/* keep looking */}}
 return undefined;
}

/**
 * A directly spawned worker's environment. The model route is written from the runner's own access
 * (never re-read from the companion's environment), with only the key it names. The tools are the
 * runner's own. Sign-in locations come from the companion; nothing else does (no printer or other secrets).
 */
export function aiWorkerEnv(access:ModelAccess,tools:{blender:string;python?:string;judgeTool:string},source:NodeJS.ProcessEnv=process.env){
 const env:NodeJS.ProcessEnv={};
 for(const name of ['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','SHELL','CLAUDE_CONFIG_DIR','CODEX_HOME','SCAN_TO_MAKE_CLAUDE_PATH','SCAN_TO_MAKE_CODEX_PATH'])
  if(source[name])env[name]=source[name];
 const names=ModelAccessEnvironment,set=(name:string,value:string|undefined)=>{if(value)env[name]=value;};
 set(names.kind,access.kind);
 if('model' in access)set(names.model,access.model);
 if('reasoningEffort' in access)set(names.effort,access.reasoningEffort);
 if(access.kind==='api')set(names.provider,access.provider);
 if(access.kind==='endpoint')set(names.endpoint,access.url);
 if((access.kind==='api'||access.kind==='endpoint')&&access.keyEnv){set(names.keyName,access.keyEnv);set(access.keyEnv,source[access.keyEnv]);}
 env.SCAN_TO_MAKE_SCAN_BLENDER=tools.blender;
 set('SCAN_TO_MAKE_CAPTURE_PYTHON',absoluteExecutable(tools.python??'python3',source.PATH));
 env[names.judgeTool]=tools.judgeTool;
 return env;
}
const supervisor=fileURLToPath(new URL('../python/scan_job.py',import.meta.url));
async function executable(name:string){
 for(const candidate of isAbsolute(name)?[name]:(process.env.PATH??'').split(':').filter(isAbsolute).map(p=>join(p,name))){
  try{await access(candidate,constants.X_OK);return candidate;}catch{/* next host PATH entry */}
 }
 throw Error('Required make-printable executable is not installed');
}

/** `inputBytes`: the job's own snapshot (capture and close-ups), allowed on top of the worker budget. */
export async function checkCleanupDisk(root:string,inputBytes=0){
 let bytes=0,files=0;const limit=512*1024*1024+inputBytes;
 const walk=async(path:string):Promise<void>=>{
  let entries:string[];try{entries=await readdir(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  for(const entry of entries){
   const full=join(path,entry);let info;try{info=await lstat(full);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
   if(info.isSymbolicLink())throw Error('Unexpected worker symlink');
   if(++files>4000)throw Error('Worker file count exceeded');
   if(info.isDirectory())await walk(full);
   else if(info.isFile()){bytes+=info.size;if(bytes>limit)throw Error('Worker byte budget exceeded');}
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
 const diskTimer=setInterval(()=>{if(checking)return;checking=checkCleanupDisk(root,context.inputBytes).catch(()=>{failed=true;terminate();}).finally(()=>checking=undefined);},250);
 const drain=(b:Buffer,save:boolean)=>{size+=b.length;if(size>2*1024*1024){failed=true;terminate();}else if(save)chunks.push(b);};
 child.stdout.on('data',b=>drain(b,true));child.stderr.on('data',b=>drain(b,false));
 const done=new Promise<number|null>(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
 context.signal.addEventListener('abort',terminate,{once:true});if(context.signal.aborted)terminate();
 try{
  try{if(child.pid)await context.onProcessGroup?.(child.pid);}catch{failed=true;terminate();}
  const code=await done;await checking;await checkCleanupDisk(root,context.inputBytes);context.signal.throwIfAborted();
  if(failed||code!==0)throw Error('Cleanup subprocess failed');
  return Buffer.concat(chunks);
 }finally{
  clearTimeout(timer);clearInterval(diskTimer);if(fallback)clearTimeout(fallback);
  context.signal.removeEventListener('abort',terminate);
 }
}

/** Operator-selected executables/provider only; no executable or provider URL comes from the phone. */
export function createScanCleanupRunner(options:CleanupOptions):ScanRunner{
 const repair=createScanRunner(options),timeout=options.timeoutMs??300000;
 const ai=options.ai,live=typeof ai?.access==='function',fixed=options.adapter??'scripted';
 // The access in force right now; an unreadable choice counts as none.
 const accessNow=()=>{
  if(!ai)return undefined;
  try{const access=typeof ai.access==='function'?ai.access():ai.access;validateAccess(access);return access;}catch{return undefined;}
 };
 const aiOn=()=>{const access=accessNow();return !!access&&access.kind!=='none';};
 const converter=options.converterAdapter??fileURLToPath(new URL('../python/capture_convert.py',import.meta.url));
 if(!isAbsolute(options.correctTool)||!isAbsolute(converter)||!['scripted','anthropic','openai'].includes(fixed))throw Error('Invalid cleanup configuration');
 if(ai&&!live)validateAccess(ai.access as ModelAccess);
 if(ai&&(live||aiOn())&&(!isAbsolute(ai.cli)||!isAbsolute(ai.judgeTool)))throw Error('Invalid cleanup configuration');
 // A live choice can turn the AI step on at any time, so its jobs always get the AI deadline.
 return {...repair,jobTimeoutMs:ai&&(live||aiOn())?AI_CLEANUP_JOB_MS:CLEANUP_JOB_MS,cleanup:{
  get adapter():CleanupRunner['adapter']{return aiOn()?'ai-tweak':fixed;},
  async run(stage,ctx){
  if(stage==='correct'&&ai&&(ctx.adapter??(aiOn()?'ai-tweak':fixed))==='ai-tweak'){
   const access=accessNow();
   if(access&&access.kind!=='none'){const result=await aiCorrect(ai,access,options,ctx);if(options.printable)await makePrintable(options,ctx);return result;}
   // The AI step was turned off after this job was queued: correct it the way an AI-off job would be.
  }
  const adapter=fixed;
  // An AI job corrected without AI may hold up to 24 close-ups; scan-correct takes the newest four.
  const stills=ctx.stills.slice(-4);
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
    ...stills.flatMap(path=>['--still',path])];
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
  const result=await command(options.python??'python3',args,join(ctx.imported,'..'),options.blender,stageBudget+30000,ctx);
  if(stage==='correct'&&options.printable)await makePrintable(options,ctx);
  return result;
 }}};
}

/**
 * KAN-185: make the chosen correction printable, after scan-correct or the AI step alike, and point
 * ctx.corrected at the result. The AI step's attempt previews and record carry over unchanged.
 */
async function makePrintable(options:CleanupOptions,ctx:CleanupContext){
 const root=join(ctx.imported,'..'),out=join(root,'printable');
 const report=JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8'));
 if(report.status!=='complete')throw Error('Incomplete correction');
 const config=join(root,'printable-config.json');
 await writeFile(config,JSON.stringify({input:ctx.corrected,output:out,hashes:report.outputs,
  repairTool:resolve(options.toolPath),blender:options.blender,python:await executable(options.python??'python3'),
  bambu:options.printable!.bambu??{command:process.execPath,args:[await executable('bambu-printer-mcp')]}}),{flag:'wx',mode:0o600});
 await command(options.python??'python3',[fileURLToPath(new URL('../python/scan_node.py',import.meta.url)),
  process.execPath,fileURLToPath(new URL('./scan-printable-cli.js',import.meta.url)),config],root,options.blender,150000,ctx);
 const printable=JSON.parse(await readFile(join(out,'printable.json'),'utf8'));
 if(printable.status!=='ready')throw Error('Make-printable requires attention');
 await copyFile(join(ctx.corrected,'tool-calls.jsonl'),join(out,'tool-calls.jsonl'));
 const previews:Record<string,string>={};
 for(const [name,digest] of Object.entries(report.outputs??{}))if(/^ai-attempt-[1-4]-preview\.png$/.test(name)&&typeof digest==='string'){
  await copyFile(join(ctx.corrected,name),join(out,name));previews[name]=digest;
 }
 await writeFile(join(out,'report.json'),JSON.stringify({...report,outputs:{...printable.outputs,...previews},makePrintable:printable}),{flag:'wx',mode:0o600});
 ctx.corrected=out;
}

/**
 * The AI step of the correct stage (KAN-184): David's sentence on the imported textured mesh, the original
 * USDZ and every retained close-up, then the blind visual pick, then the mm export into ctx.corrected.
 * Anything short of cancellation that stops the worker keeps the captured scan, so the job still finishes.
 */
async function aiCorrect(ai:AiCleanupOptions,access:Exclude<ModelAccess,{kind:'none'}>,options:CleanupOptions,ctx:CleanupContext):Promise<Buffer>{
 ctx.signal.throwIfAborted();
 const mmPerUnit=(ctx.metersPerUnit??1)*1000,mesh=join(ctx.imported,'mesh.obj');
 const budget=aiStageBudget((ctx.deadlineAt??Date.now()+AI_CLEANUP_JOB_MS)-Date.now(),access.kind);
 const fallback=async(reason:string)=>{
  await rm(ctx.corrected,{recursive:true,force:true});
  await writeAiCorrection({obj:mesh,mmPerUnit,out:ctx.corrected,record:aiTweakRecord(access,undefined,{choice:'captured',decidedBy:'fallback',reason})});
  return Buffer.from('{}');
 };
 if(!budget)return fallback('There was not enough time left for the AI step, so the captured scan is kept.');
 // Attempt and judge work stays outside the job folder: renders of every candidate would exceed its disk budget.
 const work=await mkdtemp(join(tmpdir(),'stm-ai-cleanup-')),out=join(work,'run');
 const args=['--mesh',mesh,'--usdz',ctx.source,...ctx.stills.flatMap(path=>['--still',path]),'--out',out,
  '--attempts',String(ai.attempts??2),'--timeout-ms',String(budget.attemptMs),'--pick',
  '--judge-timeout-ms',String(budget.judgeMs),'--export',ctx.corrected,'--mm-per-unit',String(mmPerUnit)];
 try{
  let result:{exitCode:number;stdout:string}|undefined;
  const env=()=>aiWorkerEnv(access,{blender:options.blender,python:options.python,judgeTool:ai.judgeTool});
  try{result=await (ai.worker??directWorker(ai.cli,env))(args,{signal:ctx.signal,timeoutMs:budget.stageMs,onProcessGroup:ctx.onProcessGroup});}
  catch(error){if(ctx.signal.aborted)throw error;}
  ctx.signal.throwIfAborted();
  // Private diagnostics: the attempt manifest and the pick (never published).
  const keep=join(ctx.imported,'..','ai-tweak');await mkdir(keep,{mode:0o700});
  for(const name of ['ai-tweak.json','pick.json'])await copyFile(join(out,name),join(keep,name)).catch(()=>undefined);
  let complete=false;
  try{complete=JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8')).status==='complete';}catch{/* no export */}
  if(result?.exitCode!==0||!complete)return fallback('The AI step could not finish, so the captured scan is kept.');
  return Buffer.from(result.stdout);
 }finally{await rm(work,{recursive:true,force:true});}
}

/** Spawn ai-tweak-cli in its own process group, registered with the job so a crash can reap it. */
function directWorker(cli:string,env:()=>NodeJS.ProcessEnv):AiWorker{
 return async(args,{signal,timeoutMs,onProcessGroup})=>{
  signal?.throwIfAborted();
  const child=spawn(process.execPath,[cli,'run',...args],{detached:true,stdio:['ignore','pipe','pipe'],env:env(),windowsHide:true});
  let failed=false,size=0;const chunks:Buffer[]=[];let fallback:NodeJS.Timeout|undefined;
  // SIGTERM lets the CLI stop its own detached attempt groups (about 3 s) before the group is killed.
  const terminate=()=>{
   if(!child.pid)return;try{process.kill(child.pid,'SIGTERM');}catch{/* gone */}
   fallback??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{/* gone */}},AI_WORKER_GRACE_MS);
  };
  const timer=setTimeout(()=>{failed=true;terminate();},timeoutMs??AI_CLEANUP_JOB_MS);
  const drain=(b:Buffer,save:boolean)=>{size+=b.length;if(size>2*1024*1024){failed=true;terminate();}else if(save)chunks.push(b);};
  child.stdout.on('data',b=>drain(b,true));child.stderr.on('data',b=>drain(b,false));
  const done=new Promise<number|null>(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
  signal?.addEventListener('abort',terminate,{once:true});if(signal?.aborted)terminate();
  try{
   try{if(child.pid)await onProcessGroup?.(child.pid);}catch{failed=true;terminate();}
   const code=await done;signal?.throwIfAborted();
   return {exitCode:failed?1:code??1,stdout:Buffer.concat(chunks).toString('utf8')};
  }finally{
   clearTimeout(timer);if(fallback)clearTimeout(fallback);signal?.removeEventListener('abort',terminate);
   // Reap anything left in the worker's own group (its Blender and Python helpers).
   if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* gone */}
  }
 };
}
export const AI_WORKER_GRACE_MS=10000;
