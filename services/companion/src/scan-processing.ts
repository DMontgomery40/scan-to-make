import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,open,readdir,rename,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {SavedProjectSync,SavedProjectSyncFailure,type FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureBindingSchema} from '@scan-to-make/contracts/capture';
import {ScanProcessingJobSchema,ScanProcessingRequestSchema,ScanArtifactNameSchema,SCAN_VIEW_NAMES,SCAN_ADVICE_NAMES,SCAN_CLEANUP_STAGES,SCAN_PROCESSING_SCHEMA_ID,compareScanDimensions,DimensionsMmSchema,ScanModelAssetsSchema,ScanModelAssetNameSchema,type ScanProcessingJob,type ScanArtifactName,type ScanReference} from '@scan-to-make/contracts/scan-processing';
import {CaptureStore,readBoundedCaptureFile} from './capture-import.js';
import {readScanMaterials,scanModelManifest} from './scan-model-assets.js';
import {DetailStillStore,DetailStillFailure} from './detail-stills.js';
import {runCleanup,type CleanupSnapshot} from './scan-cleanup-job.js';
import {AI_CLEANUP_JOB_MS,AI_WORKER_GRACE_MS} from './scan-cleanup-runner.js';
import {MAX_DETAIL_STILLS_PER_CAPTURE} from '@scan-to-make/contracts/detail-still';
import {MakerSizeResultSchema} from '@scan-to-make/contracts/maker-size';
import type {ScanRunner} from './scan-processing-runner.js';
export {createScanCleanupRunner} from './scan-cleanup-runner.js';
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
const now=()=>new Date().toISOString();
type Params=z.infer<typeof ScanProcessingRequestSchema>;
type Trigger=NonNullable<ScanProcessingJob['trigger']>;
const canonicalReference=(reference:ScanReference|undefined)=>JSON.stringify([reference?.dimensionsMm,reference?.source,reference?.productName]);
const sameStillRequest=(a:string[]|undefined,b:string[]|undefined)=>a===b||!!a&&!!b&&a.length===b.length&&a.every((id,i)=>id===b[i]);
const sameIdSet=(a:string[],b:string[])=>a.length===b.length&&a.every(id=>b.includes(id));
const IndexEntrySchema=z.strictObject({jobId:z.uuid(),projectId:requestSchema.shape.projectId,captureId:z.uuid(),captureSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),status:z.enum(['queued','running','succeeded','failed']),trigger:z.enum(['request','capture-import','detail-still']).optional(),createdAtMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),enqueuedAt:z.iso.datetime().optional(),startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional(),updatedAt:z.iso.datetime()});
const IndexSchema=z.strictObject({version:z.literal(1),jobs:z.array(IndexEntrySchema)});
export type ScanJobIndexEntry=z.infer<typeof IndexEntrySchema>;
// Records predating createdAtMs derive it from enqueuedAt; older still: 0 (oldest).
const createdOrder=(job:{createdAtMs?:number;enqueuedAt?:string})=>job.createdAtMs??(job.enqueuedAt?Date.parse(job.enqueuedAt):0);
const indexEntry=(job:ScanProcessingJob):ScanJobIndexEntry=>IndexEntrySchema.parse({jobId:job.jobId,projectId:job.projectId,captureId:job.captureId,captureSha256:job.captureSha256,status:job.status,trigger:job.trigger,createdAtMs:createdOrder(job)||undefined,enqueuedAt:job.enqueuedAt,startedAt:job.startedAt,finishedAt:job.finishedAt,updatedAt:now()});
// Newest first, so the first succeeded entry for a capture is its current result.
const byNewest=(a:ScanJobIndexEntry,b:ScanJobIndexEntry)=>createdOrder(b)-createdOrder(a)||a.jobId.localeCompare(b.jobId);
const OwnerSchema=z.object({pid:z.number().int().positive(),jobId:z.uuid(),pgid:z.number().int().positive().optional(),projectId:requestSchema.shape.projectId.optional(),captureId:z.uuid().optional()});
type LockOwner=z.infer<typeof OwnerSchema>;
// Jobs running in this process, across every store instance that shares a capture directory.
// Cancellation routes through this registry, so any same-process instance can cancel the owner.
const activeJobs=new Map<string,{controller:AbortController;done?:Promise<void>}>();
interface QueueEntry {
 jobId:string;r:Request;stillIds?:string[];authorize?:()=>Promise<void>;
 controller:AbortController;done:Promise<void>;finish:()=>void;store:ScanProcessingStore;
}
interface DirectoryQueue {pending:QueueEntry[];running?:QueueEntry;enqueueChain:Promise<unknown>;indexChain:Promise<unknown>;indexDirty:boolean}
// One FIFO queue per capture directory in this process: cleanup always starts
// on arrival, so a second scan waits its turn instead of failing busy. The key
// is resolved, like the instance lock, so two spellings share one queue.
const directoryQueues=new Map<string,DirectoryQueue>();
function queueFor(directory:string):DirectoryQueue {
 const key=resolve(directory);let queue=directoryQueues.get(key);
 if(!queue){queue={pending:[],enqueueChain:Promise.resolve(),indexChain:Promise.resolve(),indexDirty:false};directoryQueues.set(key,queue);}
 return queue;
}
async function readLockOwner(lock:string):Promise<LockOwner|undefined>{
 try{return OwnerSchema.parse(JSON.parse((await readBoundedCaptureFile(join(lock,'owner.json'),1024)).toString('utf8')));}catch{return undefined;}
}
/**
 * Kill a recorded detached worker group and verify it is gone. Fails closed
 * (false) for implausible ids or a group that cannot be signalled or verified
 * dead, so callers keep the lock instead of reclaiming over live workers.
 */
/** A job record with 24 close-ups and an AI record, with room for escaped text. */
const JOB_RECORD_BYTES=256*1024;
/**
 * The longest any instance can legitimately hold the execution lock: an AI job's whole deadline, its
 * worker's shutdown grace, and a margin for publication. A live owner younger than this is never
 * reclaimed, and a waiter waits at least this long.
 */
export const EXECUTION_LOCK_MS=AI_CLEANUP_JOB_MS+AI_WORKER_GRACE_MS+5*60000;
async function terminateProcessGroup(pgid:number|undefined):Promise<boolean>{
 if(pgid===undefined)return true;
 if(!Number.isSafeInteger(pgid)||pgid<=1||pgid===process.pid)return false;
 const exists=()=>{try{process.kill(-pgid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}};
 if(!exists())return true;
 // Give a cleanup supervisor time to reap descendants in separate sessions; an AI worker
 // stops its detached attempt groups within AI_WORKER_GRACE_MS of SIGTERM.
 try{process.kill(pgid,'SIGTERM');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return false;}
 for(let attempt=0;attempt<(AI_WORKER_GRACE_MS+2000)/25;attempt++){if(!exists())return true;await new Promise(r=>setTimeout(r,25));}
 try{process.kill(-pgid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return false;}
 for(let attempt=0;attempt<80;attempt++){if(!exists())return true;await new Promise(r=>setTimeout(r,25));}
 return !exists();
}
/** Local trusted API. No executable, path or repair parameter is taken from a request. */
export class ScanProcessingStore {
 private closed=false;
 constructor(private projects:FileSavedProjectStorage,private captures:CaptureStore,readonly directory:string,private runner:ScanRunner,private timeoutMs=runner.jobTimeoutMs??600000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>AI_CLEANUP_JOB_MS)throw new Error('Invalid job timeout');}
 private folder(r:Request){return join(this.directory,r.captureId,'scan-processing');}
 private queue(){return queueFor(this.directory);}
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
   // A finished job's lock is stale even when its pid was reused by an
   // unrelated live process after a crash between record and lock release.
   if(owner.projectId&&owner.captureId){
    try{
     const record=ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.directory,owner.captureId,'scan-processing',`${owner.jobId}.json`),JOB_RECORD_BYTES)).toString('utf8')));
     if(record.status==='succeeded'||record.status==='failed')return true;
    }catch{ /* unreadable record: fall through to pid and age */ }
   }
   try{process.kill(owner.pid,0);}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
   // A live owner is waited out until no job could still be running (60 minutes with the AI step);
   // past that the lock cannot belong to live work, whatever its pid now is.
   try{return Date.now()-(await stat(lock)).mtimeMs>EXECUTION_LOCK_MS;}catch{return false;}
  }
  // No readable owner yet: only stale once it is clearly not a lock being created right now.
  try{return Date.now()-(await stat(lock)).mtimeMs>60000;}catch{return false;}
 }
 private async persist(r:Request,job:ScanProcessingJob){
  const folder=this.folder(r);await mkdir(folder,{recursive:true,mode:0o700});const temp=join(folder,`.tmp-${randomUUID()}`);
  try{await write(temp,Buffer.from(JSON.stringify(ScanProcessingJobSchema.parse(job))+'\n'));await rename(temp,join(folder,`${job.jobId}.json`));await sync(folder);}finally{await rm(temp,{force:true});}
  // The index is derived data: its failure must never flip a published job
  // to failed. Mark it dirty so the next index read rebuilds from records.
  await this.updateIndex(job).catch(()=>{this.queue().indexDirty=true;});
 }
 private indexPath(){return join(this.directory,'scan-job-index.json');}
 private async readIndexFile():Promise<ScanJobIndexEntry[]|undefined>{
  try{return IndexSchema.parse(JSON.parse((await readBoundedCaptureFile(this.indexPath(),16*1024*1024)).toString('utf8'))).jobs;}catch{return undefined;}
 }
 private async writeIndexFile(jobs:ScanJobIndexEntry[]){
  await mkdir(this.directory,{recursive:true,mode:0o700});const temp=join(this.directory,`.tmp-index-${randomUUID()}`);
  try{await write(temp,Buffer.from(JSON.stringify(IndexSchema.parse({version:1,jobs:[...jobs].sort(byNewest)}))+'\n'));await rename(temp,this.indexPath());await sync(this.directory);}finally{await rm(temp,{force:true});}
 }
 private async scanIndexEntries():Promise<ScanJobIndexEntry[]>{
  const entries:ScanJobIndexEntry[]=[];
  let captures:string[]=[];
  try{captures=await readdir(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new ScanProcessingFailure('processing-unavailable');}
  for(const captureId of captures.filter(name=>z.uuid().safeParse(name).success)){
   let files:string[]=[];
   try{files=await readdir(join(this.directory,captureId,'scan-processing'));}catch{continue;}
   for(const file of files.filter(name=>name.endsWith('.json'))){
    try{entries.push(indexEntry(ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.directory,captureId,'scan-processing',file),JOB_RECORD_BYTES)).toString('utf8')))));}catch{ /* a torn record is not an index entry */ }
   }
  }
  return entries;
 }
 // The index is derived from job records; updates serialize per directory so
 // concurrent persists cannot lose each other's entries. A missing or
 // unreadable index (first run after an upgrade, corruption, over the read
 // bound) is rebuilt from records here, never replaced by a one-entry file.
 private updateIndex(job:ScanProcessingJob){
  const queue=this.queue();
  const run=queue.indexChain.then(async()=>{
   // A dirty index (an earlier write failed after its record landed) is
   // rebuilt from records before upserting, or that job stays missing.
   const jobs=queue.indexDirty?await this.scanIndexEntries():await this.readIndexFile()??await this.scanIndexEntries();
   const entry=indexEntry(job),at=jobs.findIndex(item=>item.jobId===job.jobId);
   if(at>=0)jobs[at]=entry;else jobs.push(entry);
   await this.writeIndexFile(jobs);queue.indexDirty=false;
  });
  queue.indexChain=run.catch(()=>undefined);return run;
 }
 // Serialized with updateIndex on the same chain: a rebuild that raced a
 // job persist could otherwise overwrite the newer index and lose that job
 // from every later read. Records are the source of truth, so updates that
 // completed before the rebuild are re-derived from disk, and updates
 // queued after it upsert onto the rebuilt file.
 private rebuildIndexFile():Promise<ScanJobIndexEntry[]>{
  const queue=this.queue();
  const run=queue.indexChain.then(async()=>{
   const entries=await this.scanIndexEntries();
   await this.writeIndexFile(entries);queue.indexDirty=false;return entries;
  });
  queue.indexChain=run.catch(()=>undefined);return run;
 }
 /** Cross-project job index, newest first by createdAtMs. Nonterminal entries are refreshed
  * from their records, so work interrupted by a restart never reads as live.
  */
 async listJobIndex():Promise<ScanJobIndexEntry[]>{
  const entries=this.queue().indexDirty?await this.rebuildIndexFile():await this.readIndexFile()??await this.rebuildIndexFile();
  const refreshed:ScanJobIndexEntry[]=[];
  for(const entry of [...entries].sort(byNewest)){
   if(entry.status!=='queued'&&entry.status!=='running'){refreshed.push(entry);continue;}
   try{
    const r:Request={projectId:entry.projectId,projectRevision:0,captureId:entry.captureId};
    refreshed.push(indexEntry(await this.interruptedIfDead(r,await this.readRecord(r,entry.jobId))));
   }catch{refreshed.push(entry);}
  }
  return refreshed;
 }
 private async readCaptureJobs(r:Request,skipUnreadable=false):Promise<ScanProcessingJob[]>{
  let entries:string[];
  try{entries=await readdir(this.folder(r));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw new ScanProcessingFailure('processing-unavailable');}
  const ids=entries.filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5).toLowerCase()).filter(id=>z.uuid().safeParse(id).success).sort();
  const jobs:ScanProcessingJob[]=[];
  for(const jobId of ids){
   try{jobs.push(await this.interruptedIfDead(r,await this.readRecord(r,jobId)));}
   // Listings fail closed on a damaged record; dedupe skips it, because an
   // unreadable record can never be a dedupe match and must not block new work.
   catch(e){if(e instanceof ScanProcessingFailure&&(e.code==='not-found'||skipUnreadable&&e.code==='processing-unavailable'))continue;throw e;}
  }
  return jobs;
 }
 // Publication re-checks authorization, so a job that has not started yet
 // adopts the newest enqueue's callback when a retry or follow-up resolves
 // to it; a running job already captured its callback in execute().
 private adoptAuthorize(entry:QueueEntry,authorize?:()=>Promise<void>){
  if(authorize&&this.queue().pending.includes(entry))entry.authorize=authorize;
 }
 /** Close-ups a job uses when none are named: the AI step looks at all of them (up to 24). */
 private defaultStillCount(adapter=this.runner.cleanup?.adapter){return adapter==='ai-tweak'?MAX_DETAIL_STILLS_PER_CAPTURE:4;}
 private pipelineMatches(job:ScanProcessingJob){
  return this.runner.cleanup?!!job.pipelineStages&&job.correctionAdapter===this.runner.cleanup.adapter:!job.pipelineStages;
 }
 // Enqueues serialize per directory, so the dedupe check and the job creation
 // cannot interleave into two jobs for one request.
 private enqueueSerialized<T>(operation:()=>Promise<T>):Promise<T>{
  const queue=this.queue();const run=queue.enqueueChain.then(operation);queue.enqueueChain=run.catch(()=>undefined);return run;
 }
 async start(input:Request&{request?:unknown},authorize?:()=>Promise<void>,signal?:AbortSignal){
  signal?.throwIfAborted();
  const r=requestSchema.parse(input),params=ScanProcessingRequestSchema.parse(input.request??{});
  return this.enqueueSerialized(()=>this.enqueueLocked(r,params,'request',authorize,signal,false));
 }
 /** Start cleanup for a freshly imported capture, resolving the project's
  * current revision here. Reference dimensions stay optional.
  */
 async enqueueForCapture(projectId:string,captureId:string,options:{request?:unknown;authorize?:()=>Promise<void>}={}){
  return this.enqueueResolved(projectId,captureId,ScanProcessingRequestSchema.parse(options.request??{}),'capture-import',false,options.authorize);
 }
 /** Queue a follow-up correction after a close-up arrives. Coalesces into a
  * job already waiting, because that job snapshots stills when it starts.
  * The originating authorization is carried through, so revoking the device
  * mid-job blocks publication exactly as for an explicitly requested job.
  */
 async enqueueFollowUp(projectId:string,captureId:string,authorize?:()=>Promise<void>){
  return this.enqueueResolved(projectId,captureId,{},'detail-still',true,authorize);
 }
 private async enqueueResolved(projectId:string,captureId:string,params:Params,trigger:Trigger,followUp:boolean,authorize?:()=>Promise<void>){
  // Resolve afresh each attempt: a project edit or a status poll holding the
  // project lock must not lose an automatic job.
  for(let attempt=0;;attempt++){
   try{
    const current=await new SavedProjectSync(this.projects).get(projectId);
    const r:Request={projectId,projectRevision:current.project.revision,captureId,expectedProjectETag:current.etag};
    return await this.enqueueSerialized(()=>this.enqueueLocked(r,params,trigger,authorize,undefined,followUp));
   }catch(e){
    const retryable=projectBusy(e)||e instanceof SavedProjectSyncFailure&&e.code==='precondition-failed';
    if(!retryable||attempt>=40)throw e;
    await new Promise(resolve=>setTimeout(resolve,25+attempt*25));
   }
  }
 }
 private async enqueueLocked(r:Request,params:Params,trigger:Trigger,authorize?:()=>Promise<void>,signal?:AbortSignal,followUp=false){
  if(this.closed)throw new ScanProcessingFailure('processing-unavailable');
  signal?.throwIfAborted();
  const capture=await this.captures.loadRetainedCapture(r.projectId,r.captureId);
  const captureSha256=capture.binding.capture.original.sha256;
  let retainedStills:Awaited<ReturnType<DetailStillStore['listRetainedDetailStills']>>['stills']=[];
  if(this.runner.cleanup){
   const stillStore=new DetailStillStore(this.projects,this.directory);
   retainedStills=(await stillStore.listRetainedDetailStills(r.projectId,r.captureId)).stills;
   // Explicit selections still fail before launch, as before the queue.
   for(const id of params.stillIds??[])await stillStore.loadRetainedDetailStill(r.projectId,r.captureId,id);
  }else if(params.stillIds?.length)throw new ScanProcessingFailure('invalid-request');
  // Dedupe by capture SHA-256: the same scan with the same reference and
  // close-up selection is one job, however often it is retried. Newest first,
  // so a match is always the job that yields the newest result.
  const queue=this.queue(),existing=(await this.readCaptureJobs(r,true)).sort((a,b)=>createdOrder(b)-createdOrder(a));
  if(followUp){
   // A waiting job with automatic still selection absorbs the new close-up
   // when it starts, whatever its reference. An explicit selection is fixed,
   // so it cannot absorb: the new photo needs its own follow-up job. The
   // reference drives correction scaling, so that follow-up inherits the
   // newest live job's reference instead of dropping it.
   // Only the capture's last queued job may absorb it: an earlier one would
   // finish before a later explicit-selection job, whose photo-less result
   // would then be the newest.
   const queued=queue.pending.filter(entry=>entry.r.captureId===r.captureId&&entry.r.projectId===r.projectId);
   const last=queued[queued.length-1];
   const waiting=last?.stillIds===undefined?last:undefined;
   if(waiting){
    const waitingJob=existing.find(job=>job.jobId===waiting.jobId);
    // Only a waiting job from the same pipeline/adapter configuration can
    // absorb this follow-up; otherwise the requested correction never runs.
    if(waitingJob&&this.pipelineMatches(waitingJob)){this.adoptAuthorize(waiting,authorize);return {job:structuredClone(waitingJob)};}
   }
   const newest=existing.find(job=>job.status!=='failed');
   if(newest?.reference&&params.reference===undefined)params={...params,reference:newest.reference};
  }
  const entryFor=(jobId:string)=>queue.running?.jobId===jobId?queue.running:queue.pending.find(entry=>entry.jobId===jobId);
  for(const job of existing){
   if(job.captureSha256&&job.captureSha256!==captureSha256)continue;
   if(canonicalReference(job.reference)!==canonicalReference(params.reference))continue;
   if(job.status==='queued'||job.status==='running'){
    // Same pipeline/adapter identity as the succeeded pass: a live job from
    // another runner configuration is not this request's job.
    if(!this.pipelineMatches(job))continue;
    const entry=entryFor(job.jobId);if(!entry)continue;
    // A running cleanup job already snapshotted its close-ups; only a
    // waiting job can absorb a follow-up for photos that arrived later.
    if(this.runner.cleanup&&queue.running===entry){
     if(followUp)continue;
     // Any other request joins a running job only if its snapshot is still the
     // current selection: a deleted or newly added close-up needs a fresh job.
     const effective=params.stillIds??retainedStills.slice(-this.defaultStillCount()).map(s=>s.id);
     if(!job.detailStills||!sameIdSet(job.detailStills.map(s=>s.id),effective))continue;
    }
    if(sameStillRequest(entry.stillIds,params.stillIds)){this.adoptAuthorize(entry,authorize);return {job:structuredClone(job)};}
   }
  }
  // Automatic retries dedupe against a finished job too. An explicit
  // request after completion is a deliberate re-check and must run fresh:
  // repair settings, the correction model or the tools may have changed
  // since that result was produced.
  for(const job of trigger==='request'?[]:existing){
   if(job.status!=='succeeded')continue;
   if(job.captureSha256&&job.captureSha256!==captureSha256)continue;
   if(canonicalReference(job.reference)!==canonicalReference(params.reference))continue;
   // A result from another pipeline or adapter is not the same job: after
   // the operator configures a real model, an old scripted result must not
   // satisfy new requests.
   if(!this.pipelineMatches(job))continue;
   if(this.runner.cleanup){
    const effective=params.stillIds??retainedStills.slice(-this.defaultStillCount()).map(s=>s.id);
    if(!sameIdSet((job.detailStills??[]).map(s=>s.id),effective))continue;
   }
   return {job:structuredClone(job)};
  }
  const createdAtMs=Date.now();
  const job:ScanProcessingJob=ScanProcessingJobSchema.parse({schema:SCAN_PROCESSING_SCHEMA_ID,jobId:randomUUID(),projectId:r.projectId,projectRevision:r.projectRevision,captureId:r.captureId,status:'queued',previewOnly:true,wallClockLimitMs:this.timeoutMs,reference:params.reference,captureSha256,trigger,createdAtMs,enqueuedAt:new Date(createdAtMs).toISOString(),...(this.runner.cleanup?{pipelineStages:SCAN_CLEANUP_STAGES.map(kind=>({kind,status:'queued'})),correctionAdapter:this.runner.cleanup.adapter}:{}),
   stages:[{kind:'repair',status:'queued',params:{weldMm:.01,componentFraction:.01,componentMetric:'area',holeMaxEdges:0,voxelSizeMm:.3,forceVoxel:false,denoiseIterations:15,denoiseFactor:.5,denoiseMu:-.53,denoiseMaxMm:.35,sharpAngleDeg:30,deviationSamples:10000}},{kind:'measure',status:'queued',params:{units:'mm'}},{kind:'render',status:'queued',params:{units:'mm',resolution:512}}]});
  let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve);
  const entry:QueueEntry={jobId:job.jobId,r,stillIds:params.stillIds,authorize,controller:new AbortController(),done,finish,store:this};
  // Registered before the record is visible, so reads and lock recovery in
  // this process always see a queued job as alive.
  activeJobs.set(job.jobId,{controller:entry.controller,done});
  try{
   await this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{await authorize?.();signal?.throwIfAborted();await this.persist(r,job);},r.expectedProjectETag);
  }catch(e){activeJobs.delete(job.jobId);finish();throw e;}
  queue.pending.push(entry);this.pump();
  return {job:structuredClone(job)};
 }
 private pump(){
  const queue=this.queue();
  if(queue.running)return;
  const entry=queue.pending.shift();if(!entry)return;
  queue.running=entry;
  // All worker errors become durable failure records inside executeEntry.
  void entry.store.executeEntry(entry).catch(()=>undefined).finally(()=>{if(queue.running===entry)queue.running=undefined;entry.finish();entry.store.pump();});
 }
 private async acquireExecutionLock(lock:string,signal:AbortSignal){
  // A filesystem lock serializes separate host instances; the in-process
  // queue has already serialized this process. The wait is bounded by a
  // little over the longest job (EXECUTION_LOCK_MS): staleLock reclaims
  // terminal or over-age locks by then, so expiry means fail this job rather
  // than block every later job forever.
  const deadline=Date.now()+EXECUTION_LOCK_MS+60000;
  for(;;){
   try{await mkdir(lock,{mode:0o700});return;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   // A crashed owner must not block the queue forever; a live owner is waited out.
   try{await this.recoverStaleLock(lock);return;}catch(e){if(!(e instanceof ScanProcessingFailure&&e.code==='busy'))throw e;}
   signal.throwIfAborted();
   if(Date.now()>=deadline)throw new Error('Scan execution lock wait exceeded');
   await new Promise(resolve=>setTimeout(resolve,100));
  }
 }
 private async executeEntry(entry:QueueEntry){
  const {r}=entry;await mkdir(this.directory,{recursive:true,mode:0o700});const lock=join(this.directory,'.scan-processing-lock');
  let locked=false;
  try{
   await this.acquireExecutionLock(lock,entry.controller.signal);locked=true;
   await write(join(lock,'owner.json'),Buffer.from(JSON.stringify({pid:process.pid,jobId:entry.jobId,projectId:r.projectId,captureId:r.captureId})));
   const job=await this.readRecord(r,entry.jobId);
   const capture=await this.captures.loadRetainedCapture(r.projectId,r.captureId);
   let cleanup:CleanupSnapshot|undefined;
   if(this.runner.cleanup){
    const stillStore=new DetailStillStore(this.projects,this.directory);
    const {stills}=await stillStore.listRetainedDetailStills(r.projectId,r.captureId);
    // Still bytes are snapshotted when the job starts, so close-ups that
    // arrived while it waited are included. Default: the newest four, or
    // every retained close-up when the AI step runs.
    const ids=entry.stillIds??stills.slice(-this.defaultStillCount(job.correctionAdapter)).map(s=>s.id);
    cleanup={source:capture.original,stills:[]};
    for(const id of ids){
     try{cleanup.stills.push(await stillStore.loadRetainedDetailStill(r.projectId,r.captureId,id));}
     // A default-selected still deleted after listing is simply absent;
     // an explicitly requested one still fails the job setup.
     catch(e){if(entry.stillIds||!(e instanceof DetailStillFailure&&e.code==='not-found'))throw e;}
    }
    job.detailStills=cleanup.stills.map(s=>s.still);
   }
   await this.execute(r,job,capture.derived,capture.binding.capture.provenance.metersPerUnit,entry.controller,entry.authorize,cleanup,capture.materials);
  }catch{
   // Acquisition/snapshot failures happen before execute()'s own handling:
   // close the job out durably instead of leaving it queued forever.
   try{
    const job=await this.readRecord(r,entry.jobId);
    if(job.status==='queued'||job.status==='running'){job.status='failed';job.failure=entry.controller.signal.aborted?'cancelled':'processing-failed';job.finishedAt=now();await this.persist(r,job);}
   }catch{ /* the record is unreadable; interruptedIfDead reports it on read */ }
  }finally{
   // Each step guarded separately: a failed lock removal must not strand
   // the in-process registration (staleLock would never reclaim the lock).
   if(locked)await rm(lock,{recursive:true,force:true}).catch(()=>undefined);
   activeJobs.delete(entry.jobId);
  }
 }
 private async assertProjectExists(projectId:string){await new SavedProjectSync(this.projects).get(projectId);}
 private async assertCaptureBelongs(r:Request){
  let binding:ReturnType<typeof CaptureBindingSchema.parse>;
  try{binding=CaptureBindingSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.directory,r.captureId,'binding.json'),1024*1024)).toString('utf8')));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ScanProcessingFailure('not-found');throw new ScanProcessingFailure('processing-unavailable');}
  if(binding.projectId!==r.projectId)throw new ScanProcessingFailure('not-found');
 }
 /** Record the live worker group in the job lock so a later starter can reap orphans after a crash. */
 private async recordProcessGroup(jobId:string,pgid:number){
  if(!Number.isSafeInteger(pgid)||pgid<=1||!activeJobs.has(jobId))throw new Error('Invalid scan worker process group');
  const lock=join(this.directory,'.scan-processing-lock'),temp=join(lock,`.owner-${randomUUID()}`),owner=await readLockOwner(lock);
  try{await write(temp,Buffer.from(JSON.stringify({pid:process.pid,jobId,pgid,projectId:owner?.projectId,captureId:owner?.captureId})));await rename(temp,join(lock,'owner.json'));}finally{await rm(temp,{force:true});}
 }
 private async execute(r:Request,job:ScanProcessingJob,mesh:Buffer,metersPerUnit:number,controller:AbortController,authorize?:()=>Promise<void>,cleanup?:CleanupSnapshot,materials:Record<string,Buffer>={}){
  const deadlineAt=Date.now()+this.timeoutMs,timer=setTimeout(()=>controller.abort('deadline-exceeded'),this.timeoutMs);let staging:string|undefined,registrationFailed=false;
  let activeStage:NonNullable<ScanProcessingJob['failureStage']>=cleanup?'import':'repair';
  try{
   staging=await mkdtemp(join(this.folder(r),'.work-'));
   const source=join(staging,'input.obj'),sidecar=join(staging,'units.json'),output=join(staging,'output');
   if(!cleanup){await write(source,mesh);for(const [name,bytes] of Object.entries(materials))await write(join(staging,name),bytes);await write(sidecar,Buffer.from(JSON.stringify({unitsAuthored:true,metersPerUnit})));}
   job.status='running';job.startedAt=now();await this.persist(r,job);
   let measured:Buffer|undefined,extraNames:string[]=[],extraReport:Record<string,unknown>={};
   const register=async(pgid:number)=>{
    try{await this.recordProcessGroup(job.jobId,pgid);}catch(e){registrationFailed=true;controller.abort();throw e;}
   };
   if(cleanup){
    const result=await runCleanup(this.runner,staging,job,cleanup,controller.signal,async(kind,status)=>{
     if(status==='running')activeStage=kind;
     const stage=job.pipelineStages!.find(s=>s.kind===kind)!;stage.status=status;
     if(status==='running')stage.startedAt=now();else stage.finishedAt=now();
     const legacy=job.stages.find(s=>s.kind===kind);if(legacy){legacy.status=status;legacy.startedAt=stage.startedAt;legacy.finishedAt=stage.finishedAt;}
     await this.persist(r,job);
    },async(adviceOutput,adviceNames)=>{
     const artifacts=await this.collectArtifacts(adviceOutput,adviceNames);
     // Publishing no longer re-checks the enqueue revision: the project may
     // have been edited while the job queued or ran. Authorization is still
     // re-checked, and the project must still exist.
     await authorize?.();controller.signal.throwIfAborted();await this.assertProjectExists(r.projectId);
     const destination=join(this.folder(r),job.jobId);await mkdir(destination,{mode:0o700});
     for(const name of adviceNames)await write(join(destination,name),await readBoundedCaptureFile(join(adviceOutput,name),8*1024*1024));
     await sync(destination);job.artifacts=artifacts;const advise=job.pipelineStages!.find(s=>s.kind==='advise')!;advise.status='succeeded';advise.finishedAt=now();await this.persist(r,job);
    },register,deadlineAt);
    if(result.aiTweak)job.aiTweak=result.aiTweak;
    activeStage='publish';measured=result.measured;extraNames=result.names;extraReport={conversion:result.conversion,correction:result.correction,detailStills:job.detailStills};
    await write(join(output,'report.json'),Buffer.from(JSON.stringify(result.repair)));
   }else for(const stage of job.stages){
    activeStage=stage.kind;controller.signal.throwIfAborted();stage.status='running';stage.startedAt=now();await this.persist(r,job);
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
    stage.status='succeeded';stage.finishedAt=now();await this.persist(r,job);
   }
   activeStage='publish';
   const metrics=JSON.parse(measured!.toString('utf8'));
   job.measuredPrincipalExtentsMm=DimensionsMmSchema.parse(metrics.principalExtentsMm);
   job.measuredBoxExtentsMm=DimensionsMmSchema.parse(metrics.boxExtentsMm);
   if(job.reference)job.comparison=ScanProcessingJobSchema.shape.comparison.parse(compareScanDimensions(job.measuredBoxExtentsMm,job.reference.dimensionsMm));
   // Retain the repair tool's report plus measured/reference comparison in one hash-bound report.
   const repair=JSON.parse((await readBoundedCaptureFile(join(output,'report.json'),1024*1024)).toString('utf8'));
   const finalObj=await readBoundedCaptureFile(join(output,'repaired.obj'),64*1024*1024);
   const finalMaterials=await readScanMaterials(output,finalObj,cleanup?(extraReport.correction as {outputs?:Record<string,unknown>}).outputs:repair.outputSha256);
   const modelAssets=scanModelManifest(job.jobId,finalObj,finalMaterials);
   await rm(join(output,'report.json'));await write(join(output,'report.json'),Buffer.from(JSON.stringify({...extraReport,repair,modelAssets,measurement:metrics,reference:job.reference,comparison:job.comparison,previewOnly:true})+'\n'));
   for(const [name,bytes] of Object.entries(finalMaterials)){await rm(join(output,name));await write(join(output,name),bytes);}
   const artifacts=await this.collectArtifacts(output,[...names,...extraNames],Object.values(finalMaterials).reduce((total,bytes)=>total+bytes.length,0));
   await sync(output);
   await authorize?.();controller.signal.throwIfAborted();await this.assertProjectExists(r.projectId);
   const destination=join(this.folder(r),job.jobId);
   if(cleanup){
    // Advice is already published. The final record is the commit point for geometry.
    for(const name of [...Object.keys(artifacts),...Object.keys(finalMaterials)]){
     if(job.artifacts?.[name as ScanArtifactName])continue;
     await rename(join(output,name),join(destination,name));
    }
    // Retain original texture, source stills, normalized provider images and worker logs privately.
    await rename(staging!,join(destination,'private-work'));staging=undefined;await sync(destination);
   }else await rename(output,destination);
   await sync(this.folder(r));
   job.artifacts=artifacts;job.status='succeeded';job.finishedAt=now();await this.persist(r,job);
  }catch{
   job.status='failed';job.failure=registrationFailed?'processing-failed':controller.signal.reason==='deadline-exceeded'?'deadline-exceeded':controller.signal.aborted?'cancelled':'processing-failed';job.failureStage=activeStage;job.finishedAt=now();if(!cleanup)delete job.artifacts;
   else if(job.artifacts)job.artifacts=Object.fromEntries(Object.entries(job.artifacts).filter(([name])=>SCAN_ADVICE_NAMES.some(n=>n===name)));
   for(const stage of [...job.stages,...(job.pipelineStages??[])])if(stage.status==='running'||stage.kind===activeStage&&stage.status!=='succeeded'){stage.status='failed';if(stage.startedAt&&!stage.finishedAt)stage.finishedAt=job.finishedAt;}
   // Persist the terminal result before optional diagnostics retention can fail.
   await this.persist(r,job);
   if(cleanup&&staging){
    try{
     const destination=join(this.folder(r),job.jobId);await mkdir(destination,{recursive:true,mode:0o700});
     await rename(staging,join(destination,'private-work'));staging=undefined;await sync(destination);
    }catch{/* Private diagnostics are best-effort and never exposed by the artifact API. */}
   }
  }finally{clearTimeout(timer);if(staging)await rm(staging,{recursive:true,force:true});}
 }
 private async collectArtifacts(output:string,artifactNames:readonly string[],materialBytes=0){
  const artifacts={} as NonNullable<ScanProcessingJob['artifacts']>;let total=materialBytes;
  for(const candidate of artifactNames){
   const name=ScanArtifactNameSchema.parse(candidate);
   const limit=name.endsWith('.png')?8*1024*1024:name.endsWith('.json')?2*1024*1024:name.endsWith('.jsonl')?16*1024*1024:64*1024*1024;
   const bytes=await readBoundedCaptureFile(join(output,name),limit);total+=bytes.length;
   if(!bytes.length||total>256*1024*1024||name.endsWith('.png')&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid scan output');
   await rm(join(output,name));await write(join(output,name),bytes);
   artifacts[name]={sha256:sha(bytes),byteLength:bytes.length,mediaType:name.endsWith('.png')?'image/png':name.endsWith('.stl')?'model/stl':name.endsWith('.obj')?'model/obj':name.endsWith('.jsonl')?'application/x-ndjson':'application/json'};
  }
  return artifacts;
 }
 private async readRecord(r:Request,jobId:string):Promise<ScanProcessingJob>{
  let job:ScanProcessingJob;
  try{job=ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.folder(r),`${jobId}.json`),JOB_RECORD_BYTES)).toString('utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ScanProcessingFailure('not-found');throw new ScanProcessingFailure('processing-unavailable');}
  // The caller's revision is not re-checked: the job pins the revision
  // resolved at enqueue, and reads keep working after later project edits.
  if(job.jobId!==jobId||job.projectId!==r.projectId||job.captureId!==r.captureId)throw new ScanProcessingFailure('not-found');
  // Records from before createdAtMs derive it from enqueuedAt, so clients
  // can order every BE-2 job; older records have neither and sort oldest.
  if(job.createdAtMs===undefined&&job.enqueuedAt){const ms=Date.parse(job.enqueuedAt);if(Number.isSafeInteger(ms)&&ms>=0)job.createdAtMs=ms;}
  return job;
 }
 // A dead owner is an interrupted attempt, never an automatic rerun. Queued
 // jobs are alive while this process holds them; the listener instance lock
 // excludes a second companion process sharing the directory.
 private async interruptedIfDead(r:Request,job:ScanProcessingJob){
  if(job.status!=='queued'&&job.status!=='running')return job;
  const queue=this.queue();
  if(activeJobs.has(job.jobId)||queue.running?.jobId===job.jobId||queue.pending.some(entry=>entry.jobId===job.jobId))return job;
  const owner=await readLockOwner(join(this.directory,'.scan-processing-lock'));
  let alive=false;
  if(owner?.jobId===job.jobId){try{process.kill(owner.pid,0);alive=true;}catch{ /* dead owner */ }}
  if(!alive){
   // Reap this job's orphaned worker group promptly; lock recovery retries on the next start.
   if(owner?.jobId===job.jobId)await terminateProcessGroup(owner.pgid).catch(()=>false);
   job.status='failed';job.failure='interrupted';job.finishedAt=now();for(const stage of [...job.stages,...(job.pipelineStages??[])])if(stage.status==='running'){stage.status='failed';if(!stage.finishedAt)stage.finishedAt=job.finishedAt;}await this.persist(r,job);
  }
  return job;
 }
 async load(input:Request,jobId:string){
  const r=requestSchema.parse(input);z.uuid().parse(jobId);
  await this.assertCaptureBelongs(r);
  return {job:await this.interruptedIfDead(r,await this.readRecord(r,jobId))};
 }
 /** Every retained job for one capture, ascending job id. */
 async list(input:Request){
  const r=requestSchema.parse(input);
  await this.assertCaptureBelongs(r);
  return {jobs:await this.readCaptureJobs(r)};
 }
 async artifact(input:Request,jobId:string,name:ScanArtifactName){
  const request=requestSchema.parse(input);ScanArtifactNameSchema.parse(name);const {job}=await this.load(request,jobId);const ref=job.artifacts?.[name];
  if(!ref||(job.status!=='succeeded'&&!SCAN_ADVICE_NAMES.some(n=>n===name)))throw new ScanProcessingFailure('not-found');
  const bytes=await readBoundedCaptureFile(join(this.folder(request),jobId,name),Math.min(ref.byteLength,64*1024*1024));
  if(bytes.length!==ref.byteLength||sha(bytes)!==ref.sha256)throw new ScanProcessingFailure('processing-unavailable');return {job,ref,bytes};
 }
 /** Optional suggestion in the hash-verified report; legacy job JSON remains unchanged. */
 async makerSize(input:Request,jobId:string){
  const {job,bytes}=await this.artifact(input,jobId,'report.json');
  const model=await this.artifact(input,jobId,'repaired.stl');
  try{
   const correction=JSON.parse(bytes.toString('utf8')).correction;
   // AI-off and historical repair-only jobs never offer a maker suggestion.
   const proposal=job.correctionAdapter==='ai-tweak'&&job.aiTweak?correction?.makerSize??null:null;
   if(proposal&&correction?.outputs?.['corrected.stl']!==model.ref.sha256)throw Error('Proposal model mismatch');
   return MakerSizeResultSchema.parse({jobId,baseModelSha256:model.ref.sha256,proposal});
  }catch{throw new ScanProcessingFailure('processing-unavailable');}
 }
 /** A hash-bound dependency manifest, separate from the legacy job artifact enum. */
 async modelAssets(input:Request,jobId:string){
  const request=requestSchema.parse(input);
  const {job,bytes:report}=await this.artifact(request,jobId,'report.json');
  const obj=await this.artifact(request,jobId,'repaired.obj');
  try{
   const retained=JSON.parse(report.toString('utf8')).modelAssets;
   // Old untextured jobs remain downloadable; an old dangling mtllib fails closed.
   const model=retained===undefined?scanModelManifest(jobId,obj.bytes,{}):ScanModelAssetsSchema.parse(retained);
   if(model.jobId!==jobId)throw Error('Model job mismatch');
   const entry=model.files.find(f=>f.name===model.entrypoint)!;
   if(entry.sha256!==obj.ref.sha256||entry.byteLength!==obj.bytes.length)throw Error('Model identity mismatch');
   const hashes=Object.fromEntries(model.files.filter(f=>f.name!==model.entrypoint).map(f=>[f.name,f.sha256]));
   const materials=await readScanMaterials(join(this.folder(request),jobId),obj.bytes,hashes);
   for(const file of model.files)if(file.name!==model.entrypoint&&materials[file.name]?.length!==file.byteLength)throw Error('Material size mismatch');
   const bytes:Record<string,Buffer>={'repaired.obj':obj.bytes,...materials};return {job,model,bytes};
  }catch{throw new ScanProcessingFailure('processing-unavailable');}
 }
 async modelAsset(input:Request,jobId:string,name:string){
  if(!ScanModelAssetNameSchema.safeParse(name).success)throw new ScanProcessingFailure('not-found');
  const {job,model,bytes}=await this.modelAssets(input,jobId),ref=model.files.find(f=>f.name===name);
  if(!ref)throw new ScanProcessingFailure('not-found');return {job,ref,bytes:bytes[name]!};
 }
 // Routes through the process-wide registry: any same-process instance cancels the owning one.
 // Cross-process ownership is excluded by the listener instance lock (one companion per directory).
 async cancel(input:Request,jobId:string){
  await this.load(input,jobId);
  const queue=this.queue(),pendingAt=queue.pending.findIndex(entry=>entry.jobId===jobId);
  if(pendingAt>=0){
   const [entry]=queue.pending.splice(pendingAt,1);
   try{
    const job=await this.readRecord(entry!.r,jobId);
    if(job.status==='queued'){job.status='failed';job.failure='cancelled';job.finishedAt=now();await this.persist(entry!.r,job);}
   }finally{activeJobs.delete(jobId);entry!.finish();}
   return this.load(input,jobId);
  }
  const active=activeJobs.get(jobId);
  if(active&&queue.running?.jobId===jobId){active.controller.abort();await active.done;}
  return this.load(input,jobId);
 }
 /** Resolve once this directory's queue is empty. */
 async wait(){
  const queue=this.queue();
  for(;;){
   const current=[...(queue.running?[queue.running]:[]),...queue.pending];
   if(!current.length)return;
   await Promise.allSettled(current.map(entry=>entry.done));
  }
 }
 async close(){
  this.closed=true;
  const queue=this.queue();
  for(const entry of queue.pending.splice(0)){
   try{
    const job=await this.readRecord(entry.r,entry.jobId);
    if(job.status==='queued'){job.status='failed';job.failure='cancelled';job.finishedAt=now();await this.persist(entry.r,job);}
   }catch{ /* an unreadable record reports as interrupted on read */ }
   activeJobs.delete(entry.jobId);entry.finish();
  }
  const running=queue.running;running?.controller.abort();await running?.done;
 }
}
