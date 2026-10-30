import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,open,rename,rm} from 'node:fs/promises';
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
/** Local trusted API. No executable, path or repair parameter is taken from a request. */
export class ScanProcessingStore {
 private active?:{id:string;controller:AbortController;done:Promise<void>};
 constructor(private projects:FileSavedProjectStorage,private captures:CaptureStore,private directory:string,private runner:ScanRunner,private timeoutMs=600000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid job timeout');}
 private folder(r:Request){return join(this.directory,r.captureId,'scan-processing');}
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
  try{await mkdir(lock,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ScanProcessingFailure('busy');throw e;}
  let launched=false;
  try{
   const capture=await this.captures.loadCapture(r.projectId,r.projectRevision,r.captureId,r.expectedProjectETag);
   const job:ScanProcessingJob=ScanProcessingJobSchema.parse({schema:SCAN_PROCESSING_SCHEMA_ID,jobId:randomUUID(),projectId:r.projectId,projectRevision:r.projectRevision,captureId:r.captureId,status:'queued',previewOnly:true,...params,
    stages:[{kind:'repair',status:'queued',params:{weldMm:.01,componentFraction:.01,componentMetric:'area',holeMaxEdges:0,voxelSizeMm:.3,forceVoxel:false,denoiseIterations:1,denoiseFactor:.1,denoiseMaxMm:.05,sharpAngleDeg:30,deviationSamples:10000}},{kind:'measure',status:'queued',params:{units:'mm'}},{kind:'render',status:'queued',params:{units:'mm',resolution:512}}]});
   await write(join(lock,'owner.json'),Buffer.from(JSON.stringify({pid:process.pid,jobId:job.jobId})));
   await this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{await authorize?.();signal?.throwIfAborted();await this.persist(r,job);},r.expectedProjectETag);
   const controller=new AbortController();const snapshot=structuredClone(job);
   const done=Promise.resolve().then(()=>this.execute(r,job,capture.derived,capture.binding.capture.provenance.metersPerUnit,controller,authorize)).finally(async()=>{await rm(lock,{recursive:true,force:true});this.active=undefined;});
   this.active={id:job.jobId,controller,done};launched=true;
   // All worker errors are converted to durable generic failure records; storage errors remain fail closed.
   void done.catch(()=>undefined);return {job:snapshot};
  }finally{if(!launched)await rm(lock,{recursive:true,force:true});}
 }
 private async execute(r:Request,job:ScanProcessingJob,mesh:Buffer,metersPerUnit:number,controller:AbortController,authorize?:()=>Promise<void>){
  const timer=setTimeout(()=>controller.abort(),this.timeoutMs);let staging:string|undefined;
  try{
   staging=await mkdtemp(join(this.folder(r),'.work-'));
   const source=join(staging,'input.obj'),sidecar=join(staging,'units.json'),output=join(staging,'output');
   await write(source,mesh);await write(sidecar,Buffer.from(JSON.stringify({unitsAuthored:true,metersPerUnit})));
   job.status='running';await this.persist(r,job);
   let measured:Buffer|undefined;
   for(const stage of job.stages){
    controller.signal.throwIfAborted();stage.status='running';await this.persist(r,job);
    const stageOutput=stage.kind==='render'?join(staging,'views'):output;
    const result=await this.runner.run(stage.kind,stage.kind==='repair'?source:join(output,'repaired.obj'),stageOutput,sidecar,controller.signal);
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
   await this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{
    await authorize?.();controller.signal.throwIfAborted();
    await rename(output,join(this.folder(r),job.jobId));await sync(this.folder(r));
    job.artifacts=artifacts;job.status='succeeded';await this.persist(r,job);
   },r.expectedProjectETag);
  }catch{
   job.status='failed';job.failure=controller.signal.aborted?'cancelled':'processing-failed';delete job.artifacts;
   for(const stage of job.stages)if(stage.status==='running')stage.status='failed';
   await this.persist(r,job);
  }finally{clearTimeout(timer);if(staging)await rm(staging,{recursive:true,force:true});}
 }
 async load(input:Request,jobId:string){
  const r=requestSchema.parse(input);z.uuid().parse(jobId);
  await this.captures.loadCapture(r.projectId,r.projectRevision,r.captureId,r.expectedProjectETag);
  return this.projects.withCurrentProject(r.projectId,r.projectRevision,async()=>{
   let job:ScanProcessingJob;
   try{job=ScanProcessingJobSchema.parse(JSON.parse((await readBoundedCaptureFile(join(this.folder(r),`${jobId}.json`),65536)).toString('utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ScanProcessingFailure('not-found');throw new ScanProcessingFailure('processing-unavailable');}
   if(job.jobId!==jobId||job.projectId!==r.projectId||job.captureId!==r.captureId||job.projectRevision!==r.projectRevision)throw new ScanProcessingFailure('not-found');
   // A dead owner is an interrupted attempt, never an automatic rerun.
   if(job.status==='queued'||job.status==='running'){
    let alive=false;
    try{
     const owner=z.object({pid:z.number().int().positive(),jobId:z.uuid()}).parse(JSON.parse((await readBoundedCaptureFile(join(this.directory,'.scan-processing-lock','owner.json'),1024)).toString('utf8')));
     if(owner.jobId===jobId){process.kill(owner.pid,0);alive=true;}
    }catch{ /* absent or dead owner */ }
    if(!alive){job.status='failed';job.failure='interrupted';for(const stage of job.stages)if(stage.status==='running')stage.status='failed';await this.persist(r,job);}
   }
   return {job};
  },r.expectedProjectETag);
 }
 async artifact(input:Request,jobId:string,name:ScanArtifactName){
  const request=requestSchema.parse(input);ScanArtifactNameSchema.parse(name);const {job}=await this.load(request,jobId);const ref=job.artifacts?.[name];
  if(job.status!=='succeeded'||!ref)throw new ScanProcessingFailure('not-found');
  const bytes=await readBoundedCaptureFile(join(this.folder(request),jobId,name),Math.min(ref.byteLength,64*1024*1024));
  if(bytes.length!==ref.byteLength||sha(bytes)!==ref.sha256)throw new ScanProcessingFailure('processing-unavailable');return {job,ref,bytes};
 }
 async cancel(input:Request,jobId:string){await this.load(input,jobId);if(this.active?.id===jobId){this.active.controller.abort();await this.active.done;}return this.load(input,jobId);}
 async wait(){await this.active?.done;}
 async close(){const active=this.active;active?.controller.abort();await active?.done;}
}
