import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,open,readdir,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {FileSavedProjectStorage} from '@scan-to-make/project';
import {ScanProcessingJobSchema,ScanProcessingRequestSchema,ScanArtifactNameSchema,SCAN_VIEW_NAMES,SCAN_PROCESSING_SCHEMA_ID,compareScanDimensions,DimensionsMmSchema,type ScanProcessingJob,type ScanArtifactName} from '@scan-to-make/contracts/scan-processing';
import {CaptureStore,readBoundedCaptureFile} from './capture-import.js';
import type {ScanRunner} from './scan-processing-runner.js';
export {createScanRunner} from './scan-processing-runner.js';
const names=['repaired.stl','repaired.obj','report.json',...SCAN_VIEW_NAMES] as const;
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const requestSchema=z.object({projectId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),projectRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),captureId:z.uuid(),expectedProjectETag:z.string().regex(/^"[a-f0-9]{64}"$/).optional()});
type Request=z.infer<typeof requestSchema>;
export class ScanProcessingFailure extends Error {constructor(readonly code:'busy'|'not-found'|'processing-unavailable'|'invalid-request'){super(code);}}
async function write(path:string,bytes:Buffer){const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function sync(path:string){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}
// FileSavedProjectStorage fails fast when its lock exists; a status poll can hold it briefly.
const projectBusy=(e:unknown)=>e instanceof Error&&e.message.startsWith('Saved project is busy');
async function retryProjectBusy<T>(signal:AbortSignal,operation:()=>Promise<T>):Promise<T>{
 for(let attempt=0;;attempt++){
  try{return await operation();}
  catch(e){if(!projectBusy(e)||attempt>=40)throw e;}
  signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,25+attempt*25));
 }
}
const OwnerSchema=z.object({pid:z.number().int().positive(),jobId:z.uuid(),pgid:z.number().int().positive().optional()});
type LockOwner=z.infer<typeof OwnerSchema>;
// Jobs running in this process, across every store instance that shares a capture directory.
// Cancellation routes through this registry, so any same-process instance can cancel the owner.
const activeJobs=new Map<string,{controller:AbortController;done?:Promise<void>}>();
async function readLockOwner(lock:string):Promise<LockOwner|undefined>{
 try{return OwnerSchema.parse(JSON.parse((await readBoundedCaptureFile(join(lock,'owner.json'),1024)).toString('utf8')));}catch{return undefined;}
}
/**
 * Kill a recorded detached worker group and verify it is gone. Fails closed
 * (false) for implausible ids or a group that cannot be signalled or verified
 * dead, so callers keep the lock instead of reclaiming over live workers.
 */
async function terminateProcessGroup(pgid:number|undefined):Promise<boolean>{
 if(pgid===undefined)return true;
 if(!Number.isSafeInteger(pgid)||pgid<=1||pgid===process.pid)return false;
 const exists=()=>{try{process.kill(-pgid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
 if(!exists())return true;
 try{process.kill(-pgid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return false;}
 for(let attempt=0;attempt<80;attempt++){if(!exists())return true;await new Promise(r=>setTimeout(r,25));}
 return !exists();
}
/** Local trusted API. No executable, path or repair parameter is taken from a request. */
export class ScanProcessingStore {
 private active?:{id:string;controller:AbortController;done:Promise<void>};
 constructor(private projects:FileSavedProjectStorage,private captures:CaptureStore,readonly directory:string,private runner:ScanRunner,private timeoutMs=600000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid job timeout');}
 private folder(r:Request){return join(this.directory,r.captureId,'scan-processing');}
 /** Inspect, remove and re-create under one guard so concurrent recoverers cannot delete a fresh owner's lock. */
 private async recoverStaleLock(lock:string){
  const guard=`${lock}.recover`;
  try{await mkdir(guard,{mode:0o700});}catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   // Recovery holds the guard for milliseconds; an old guard means its holder died mid-recovery.
   let abandoned=false;try{abandoned=Date.now()-(await stat(guard)).mtimeMs>60000;}catch{ /* vanished */ }
   if(!abandoned)throw new ScanProcessingFailure('busy');
   await rm(guard,{recursive:true,force:true});
   try{await mkdir(guard,{mode:0o700});}catch(again){if((again as NodeJS.ErrnoException).code==='EEXIST')throw new ScanProcessingFailure('busy');throw again;}
  }
  try{
   const owner=await readLockOwner(lock);
   if(!(await this.staleLock(lock,owner)))throw new ScanProcessingFailure('busy');
   // The owner process is gone, but its detached worker group can outlive it.
   // Terminate and verify the recorded group before reclaiming the lock.
   if(owner&&!(await terminateProcessGroup(owner.pgid)))throw new ScanProcessingFailure('busy');
   await rm(lock,{recursive:true,force:true});
   try{await mkdir(lock,{mode:0o700});}catch(again){if((again as NodeJS.ErrnoException).code==='EEXIST')throw new ScanProcessingFailure('busy');throw again;}
  }finally{await rm(guard,{recursive:true,force:true});}
 }
 private async staleLock(lock:string,owner:LockOwner|undefined){
  if(owner){
   if(owner.pid===process.pid)return !activeJobs.has(owner.jobId);
   try{process.kill(owner.pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
  }
  // No readable owner yet: only stale once it is clearly not a lock being created right now.
  try{return Date.now()-(await stat(lock)).mtimeMs>60000;}catch{return false;}
 }
 private async persist(r:Request,job:ScanProcessingJob){
  const folder=this.folder(r);await mkdir(folder,{recursive:true,mode:0o700});const temp=join(folder,`.tmp-${randomUUID()}`);
  try{await write(temp,Buffer.from(JSON.stringify(ScanProcessingJobSchema.parse(job))+'\n'));await rename(temp,join(folder,`${job.jobId}.json`));await sync(folder);}finally{await rm(temp,{force:true});}
 }
 async start(input:Request&{request?:unknown},authorize?:()=>Promise<void>,signal?:AbortSignal){
  signal?.throwIfAborted();
  const r=requestSchema.parse(input),params=ScanProcessingRequestSchema.parse(input.request??{});
  if(this.active)throw new ScanProcessingFailure('busy');
  // A filesystem lock serializes separate host instances as well as this instance.
  await mkdir(this.directory,{recursive:true,mode:0o700});const lock=join(this.directory,'.scan-processing-lock');
  try{await mkdir(lock,{mode:0o700});}catch(e){
   if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   // A crashed owner must not leave processing busy forever; a live owner keeps it.
   await this.recoverStaleLock(lock);
  }
  let launched=false,startingId:string|undefined;
  try{
   const capture=await this.captures.loadCapture(r.projectId,r.projectRevision,r.captureId,r.expectedProjectETag);
   const job:ScanProcessingJob=ScanProcessingJobSchema.parse({schema:SCAN_PROCESSING_SCHEMA_ID,jobId:randomUUID(),projectId:r.projectId,projectRevision:r.projectRevision,captureId:r.captureId,status:'queued',previewOnly:true,...params,
    stages:[{kind:'repair',status:'queued',params:{weldMm:.01,componentFraction:.01,componentMetric:'area',holeMaxEdges:0,voxelSizeMm:.3,forceVoxel:false,denoiseIterations:1,denoiseFactor:.1,denoiseMaxMm:.05,sharpAngleDeg:30,deviationSamples:10000}},{kind:'measure',status:'queued',params:{units:'mm'}},{kind:'render',status:'queued',params:{units:'mm',resolution:512}}]});
   // Register before owner.json is visible so a same-process recoverer never sees a live start as abandoned.
   startingId=job.jobId;const controller=new AbortController();const entry:{controller:AbortController;done?:Promise<void>}={controller};activeJobs.set(job.jobId,entry);
   await write(join(lock,'owner.json'),Buffer.from(JSON.stringify({pid:process.pid,jobId:job.jobId})));
   await this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{await authorize?.();signal?.throwIfAborted();await this.persist(r,job);},r.expectedProjectETag);
   const snapshot=structuredClone(job);
   const done=Promise.resolve().then(()=>this.execute(r,job,capture.derived,capture.binding.capture.provenance.metersPerUnit,controller,authorize)).finally(async()=>{await rm(lock,{recursive:true,force:true});this.active=undefined;activeJobs.delete(job.jobId);});
   entry.done=done;this.active={id:job.jobId,controller,done};launched=true;
   // All worker errors are converted to durable generic failure records; storage errors remain fail closed.
   void done.catch(()=>undefined);return {job:snapshot};
  }finally{if(!launched){if(startingId)activeJobs.delete(startingId);await rm(lock,{recursive:true,force:true});}}
 }
 /** Record the live worker group in the job lock so a later starter can reap orphans after a crash. */
 private async recordProcessGroup(jobId:string,pgid:number){
  if(!Number.isSafeInteger(pgid)||pgid<=1||!activeJobs.has(jobId))throw new Error('Invalid scan worker process group');
  const lock=join(this.directory,'.scan-processing-lock'),temp=join(lock,`.owner-${randomUUID()}`);
  try{await write(temp,Buffer.from(JSON.stringify({pid:process.pid,jobId,pgid})));await rename(temp,join(lock,'owner.json'));}finally{await rm(temp,{force:true});}
 }
 private async execute(r:Request,job:ScanProcessingJob,mesh:Buffer,metersPerUnit:number,controller:AbortController,authorize?:()=>Promise<void>){
  const timer=setTimeout(()=>controller.abort(),this.timeoutMs);let staging:string|undefined,registrationFailed=false;
  try{
   staging=await mkdtemp(join(this.folder(r),'.work-'));
   const source=join(staging,'input.obj'),sidecar=join(staging,'units.json'),output=join(staging,'output');
   await write(source,mesh);await write(sidecar,Buffer.from(JSON.stringify({unitsAuthored:true,metersPerUnit})));
   job.status='running';await this.persist(r,job);
   let measured:Buffer|undefined;
   for(const stage of job.stages){
    controller.signal.throwIfAborted();stage.status='running';await this.persist(r,job);
    const stageOutput=stage.kind==='render'?join(staging,'views'):output;
    const registrations:Promise<void>[]=[];
    const result=await this.runner.run(stage.kind,stage.kind==='repair'?source:join(output,'repaired.obj'),stageOutput,sidecar,controller.signal,pgid=>{
     const registration=this.recordProcessGroup(job.jobId,pgid);registrations.push(registration);
     // Abort immediately on failure even if a runner does not await the acknowledgement.
     void registration.catch(()=>{registrationFailed=true;controller.abort();});
     return registration;
    });
    await Promise.all(registrations);
    if(stage.kind==='render')for(const name of SCAN_VIEW_NAMES)await rename(join(stageOutput,name),join(output,name));
    if(stage.kind==='measure')measured=result;
    stage.status='succeeded';await this.persist(r,job);
   }
   const metrics=JSON.parse(measured!.toString('utf8'));
   job.measuredPrincipalExtentsMm=DimensionsMmSchema.parse(metrics.principalExtentsMm);
   if(job.reference)job.comparison=ScanProcessingJobSchema.shape.comparison.parse(compareScanDimensions(job.measuredPrincipalExtentsMm,job.reference.dimensionsMm));
   // Retain the repair tool's report plus measured/reference comparison in one hash-bound report.
   const repair=JSON.parse((await readBoundedCaptureFile(join(output,'report.json'),1024*1024)).toString('utf8'));
   await rm(join(output,'report.json'));await write(join(output,'report.json'),Buffer.from(JSON.stringify({repair,measurement:metrics,reference:job.reference,comparison:job.comparison,previewOnly:true})+'\n'));
   const artifacts={} as NonNullable<ScanProcessingJob['artifacts']>;let total=0;
   for(const name of names){
    const limit=name.endsWith('.png')?8*1024*1024:name==='report.json'?2*1024*1024:64*1024*1024;
    const bytes=await readBoundedCaptureFile(join(output,name),limit);total+=bytes.length;
    if(!bytes.length||total>160*1024*1024||name.endsWith('.png')&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid scan output');
    // Rewrite as private synced files, independent of subprocess file modes.
    await rm(join(output,name));await write(join(output,name),bytes);
    artifacts[name]={sha256:sha(bytes),byteLength:bytes.length,mediaType:name.endsWith('.png')?'image/png':name.endsWith('.stl')?'model/stl':name.endsWith('.obj')?'model/obj':'application/json'};
   }
   await sync(output);
   await retryProjectBusy(controller.signal,()=>this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{
    await authorize?.();controller.signal.throwIfAborted();
    await rename(output,join(this.folder(r),job.jobId));await sync(this.folder(r));
    job.artifacts=artifacts;job.status='succeeded';await this.persist(r,job);
   },r.expectedProjectETag));
  }catch{
   job.status='failed';job.failure=registrationFailed?'processing-failed':controller.signal.aborted?'cancelled':'processing-failed';delete job.artifacts;
   for(const stage of job.stages)if(stage.status==='running')stage.status='failed';
   await this.persist(r,job);
  }finally{clearTimeout(timer);if(staging)await rm(staging,{recursive:true,force:true});}
 }
 private async readRecord(r:Request,jobId:string):Promise<ScanProcessingJob>{
  let job:ScanProcessingJob;
  try{job=ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.folder(r),`${jobId}.json`),65536)).toString('utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ScanProcessingFailure('not-found');throw new ScanProcessingFailure('processing-unavailable');}
  if(job.jobId!==jobId||job.projectId!==r.projectId||job.captureId!==r.captureId||job.projectRevision!==r.projectRevision)throw new ScanProcessingFailure('not-found');
  return job;
 }
 // A dead owner is an interrupted attempt, never an automatic rerun.
 private async interruptedIfDead(r:Request,job:ScanProcessingJob){
  if(job.status!=='queued'&&job.status!=='running')return job;
  const owner=await readLockOwner(join(this.directory,'.scan-processing-lock'));
  let alive=false;
  if(owner?.jobId===job.jobId){try{process.kill(owner.pid,0);alive=true;}catch{ /* dead owner */ }}
  if(!alive){
   // Reap this job's orphaned worker group promptly; lock recovery retries on the next start.
   if(owner?.jobId===job.jobId)await terminateProcessGroup(owner.pgid).catch(()=>false);
   job.status='failed';job.failure='interrupted';for(const stage of job.stages)if(stage.status==='running')stage.status='failed';await this.persist(r,job);
  }
  return job;
 }
 async load(input:Request,jobId:string){
  const r=requestSchema.parse(input);z.uuid().parse(jobId);
  await this.captures.loadCapture(r.projectId,r.projectRevision,r.captureId,r.expectedProjectETag);
  return this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{
   return {job:await this.interruptedIfDead(r,await this.readRecord(r,jobId))};
  },r.expectedProjectETag);
 }
 /** Every retained job for one capture at the current revision, ascending job id. */
 async list(input:Request){
  const r=requestSchema.parse(input);
  await this.captures.loadCapture(r.projectId,r.projectRevision,r.captureId,r.expectedProjectETag);
  return this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{
   let entries:string[];
   try{entries=await readdir(this.folder(r));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {jobs:[]};throw new ScanProcessingFailure('processing-unavailable');}
   const ids=entries.filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5).toLowerCase()).filter(id=>z.uuid().safeParse(id).success).sort();
   const jobs:ScanProcessingJob[]=[];
   for(const jobId of ids){
    try{jobs.push(await this.interruptedIfDead(r,await this.readRecord(r,jobId)));}
    catch(e){if(e instanceof ScanProcessingFailure&&e.code==='not-found')continue;throw e;}
   }
   return {jobs};
  },r.expectedProjectETag);
 }
 async artifact(input:Request,jobId:string,name:ScanArtifactName){
  const request=requestSchema.parse(input);ScanArtifactNameSchema.parse(name);const {job}=await this.load(request,jobId);const ref=job.artifacts?.[name];
  if(job.status!=='succeeded'||!ref)throw new ScanProcessingFailure('not-found');
  const bytes=await readBoundedCaptureFile(join(this.folder(request),jobId,name),Math.min(ref.byteLength,64*1024*1024));
  if(bytes.length!==ref.byteLength||sha(bytes)!==ref.sha256)throw new ScanProcessingFailure('processing-unavailable');return {job,ref,bytes};
 }
 // Routes through the process-wide registry: any same-process instance cancels the owning one.
 // Cross-process ownership is excluded by the listener instance lock (one companion per directory).
 async cancel(input:Request,jobId:string){await this.load(input,jobId);const entry=activeJobs.get(jobId);if(entry){entry.controller.abort();await entry.done;}return this.load(input,jobId);}
 async wait(){await this.active?.done;}
 async close(){const active=this.active;active?.controller.abort();await active?.done;}
}
