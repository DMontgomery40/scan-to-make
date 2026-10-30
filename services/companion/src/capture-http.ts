import {ScanProcessingStore,ScanProcessingFailure} from './scan-processing.js';
import {ScanProcessingRequestSchema,ScanArtifactNameSchema} from '@scan-to-make/contracts/scan-processing';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {ArtifactRefSchema} from '@scan-to-make/contracts';
import {PrintSelectionSchema} from './index.js';
import {PreparedJobStore,PreparedJobFailure} from './prepared-jobs.js';
import {SavedProjectSync,SavedProjectSyncFailure,MAX_SAVED_PROJECT_SYNC_BYTES,type FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore,DEFAULT_CAPTURE_LIMITS} from './capture-import.js';
import {DetailStillStore,DetailStillFailure,sniffDetailStillMediaType} from './detail-stills.js';
import {MAX_DETAIL_STILL_BYTES} from '@scan-to-make/contracts/detail-still';
import {RemoteAuthFailure,type RemoteScope} from './remote-auth.js';

export interface CaptureServices {storage:FileSavedProjectStorage;captures?:CaptureStore;preparedJobs?:PreparedJobStore;detailStills?:DetailStillStore;scanProcessing?:ScanProcessingStore}
class Failure extends Error {
 constructor(readonly status:number,readonly code:string){super(code);}
}
const snapshotStatus={'invalid-snapshot':400,'invalid-precondition':400,'precondition-required':428,'precondition-failed':412,'revision-conflict':409,'not-found':404,'storage-unavailable':503} as const;
function body(request:IncomingMessage,signal:AbortSignal,limit:number,timeoutMs=5000):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[];let length=0,done=false;
  const finish=(error?:Error)=>{
   if(done)return;done=true;clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('error',failed);request.off('aborted',failed);signal.removeEventListener('abort',aborted);
   if(error){request.resume();reject(error);}else resolve(Buffer.concat(chunks,length));
  };
  const data=(bytes:Buffer)=>{length+=bytes.length;if(length>limit)finish(new Failure(413,'payload-too-large'));else chunks.push(bytes);};
  const end=()=>finish(),failed=()=>finish(new Failure(400,'invalid-request')),aborted=()=>finish(new Failure(499,'cancelled'));
  const timer=setTimeout(()=>finish(new Failure(408,'body-timeout')),timeoutMs);
  request.on('data',data);request.once('end',end);request.once('error',failed);request.once('aborted',failed);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
 });
}
function send(response:ServerResponse,bytes:Buffer|string):Promise<void>{
 if(response.destroyed||response.writableEnded)return Promise.resolve();
 return new Promise(resolve=>{
  const done=()=>{clearTimeout(timer);response.off('finish',done);response.off('close',done);resolve();};
  const timer=setTimeout(()=>{response.destroy();done();},30000);
  response.once('finish',done);response.once('close',done);response.setHeader('Content-Length',Buffer.byteLength(bytes));response.end(bytes);
 });
}

const PREPARED_METADATA_BYTES=64*1024;
function preparedEnvelope(bytes:Buffer,limit:number){
 let value:unknown;
 try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}
 catch {throw new Failure(400,'invalid-envelope');}
 const parsed=z.strictObject({selection:PrintSelectionSchema,printableArtifact:ArtifactRefSchema,
  printableBase64:z.string().max(Math.ceil(limit/3)*4)}).safeParse(value);
 if(!parsed.success)throw new Failure(400,'invalid-envelope');
 const {printableBase64,...metadata}=parsed.data;
 if(metadata.printableArtifact.byteLength>limit||Buffer.byteLength(JSON.stringify(metadata))>PREPARED_METADATA_BYTES)throw new Failure(413,'payload-too-large');
 const printable=Buffer.from(printableBase64,'base64');
 if(!printable.length||printable.toString('base64')!==printableBase64)throw new Failure(400,'invalid-envelope');
 if(printable.length>limit)throw new Failure(413,'payload-too-large');
 return {...metadata,printable};
}

/** Routes share the generation listener's exact Host/browser/Serve boundary.
 * One capture/snapshot request owns the slot through body, worker and response cleanup.
 */
export function createCaptureRoutes(services:CaptureServices){
 if(services.preparedJobs&&!services.preparedJobs.inspectionEnabled)throw new Error('Prepared HTTP requires a configured file inspector');
 const projects=new SavedProjectSync(services.storage);
 let active:{controller:AbortController;done:Promise<void>}|undefined;
 return {
  async close(){const pending=active;pending?.controller.abort();await pending?.done;await services.scanProcessing?.close();},
  async handle(request:IncomingMessage,response:ServerResponse,authorize:(scope:RemoteScope)=>Promise<void>,header:(name:string)=>string|undefined){
   let finish:(()=>void)|undefined;let disconnected:(()=>void)|undefined;
   try {
    const url=new URL(request.url!,'http://localhost');
    const match=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/captures(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/(original|derived|report))?)?)?$/.exec(url.pathname);
    const prepared=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/prepared-jobs(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/(printable))?)?$/.exec(url.pathname);
    const stills=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/detail-stills(?:\/([a-fA-F0-9-]{36}))?$/.exec(url.pathname);
    const processing=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/scan-processing(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/([^/]+))?)?$/.exec(url.pathname);
    if(!match&&!prepared&&!stills&&!processing)throw new Failure(404,'not-found');
    const id=(processing??prepared??stills??match)![1]!,captureId=match?.[2],kind=match?.[3] as 'original'|'derived'|'report'|undefined;
    const jobId=prepared?.[2]?.toLowerCase(),listing=!!prepared&&!prepared[2];
    if(jobId&&!z.uuid().safeParse(jobId).success)throw new Failure(400,'invalid-request');
    if(prepared&&!services.preparedJobs)throw new Failure(404,'not-found');
    const stillCaptureId=stills?.[2]?.toLowerCase(),stillId=stills?.[3]?.toLowerCase();
    if(stillCaptureId&&!z.uuid().safeParse(stillCaptureId).success)throw new Failure(400,'invalid-request');
    if(stillId&&!z.uuid().safeParse(stillId).success)throw new Failure(400,'invalid-request');
    if(stills&&!services.detailStills)throw new Failure(404,'not-found');
    const stillPost=!!stills&&!stillId&&request.method==='POST';
    const captureRoute=!!match&&match[0]!==`/v1/saved-projects/${id}`;
    if(captureRoute&&!services.captures)throw new Failure(404,'not-found');
    const writing=request.method==='PUT'||request.method==='POST';
    const scope:RemoteScope=processing?(writing||request.method==='DELETE'?'captures:import':'captures:read'):stills?(writing||request.method==='DELETE'?'captures:import':'captures:read'):prepared?(writing?'prepared-jobs:prepare':'prepared-jobs:read'):captureRoute?(writing?'captures:import':'captures:read'):(writing?'projects:write':'projects:read');
    await authorize(scope);
    if(processing?(processing[3]?(processing[4]?request.method!=='GET':!['GET','DELETE'].includes(request.method??'')):!['GET','POST'].includes(request.method??'')):stills?(stillId?!['GET','DELETE'].includes(request.method??''):!['GET','POST'].includes(request.method??'')):prepared?(listing||prepared[3]?request.method!=='GET':!['GET','POST'].includes(request.method??'')):captureRoute?(captureId?request.method!=='GET':request.method!=='POST'):!['GET','PUT'].includes(request.method??''))throw new Failure(405,'method-not-allowed');
    if(active)throw new Failure(429,'busy');
    const controller=new AbortController();active={controller,done:new Promise<void>(resolve=>finish=resolve)};
    disconnected=()=>{if(!response.writableEnded)controller.abort();};response.once('close',disconnected);
    const assertActive=()=>{if(controller.signal.aborted)throw new Failure(499,'cancelled');};
    const ifMatch=header('if-match'),ifNoneMatch=header('if-none-match');
    let revision=0,listLimit:number|undefined,listCursor:string|undefined,productionVersion:1|undefined,stillLabel:string|undefined;
    if(captureRoute||prepared||stills||processing){
     const keys=[...url.searchParams.keys()];const raw=url.searchParams.get('projectRevision');
     if((listing?(new Set(keys).size!==keys.length||keys.some(key=>!['projectRevision','limit','cursor','productionVersion'].includes(key))):stillPost?(new Set(keys).size!==keys.length||keys.some(key=>!['projectRevision','label'].includes(key))):keys.length!==1||keys[0]!=='projectRevision')||raw===null||! /^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Failure(400,'invalid-request');
     if(stillPost)stillLabel=url.searchParams.get('label')??undefined;
     if(listing){
      const limit=url.searchParams.get('limit');listCursor=url.searchParams.get('cursor')??undefined;
      const version=url.searchParams.get('productionVersion');
      if(limit!==null&&(!/^[1-9][0-9]*$/.test(limit)||Number(limit)>50)||listCursor!==undefined&&listCursor.length>1024||version!==null&&version!=='1')throw new Failure(400,'invalid-request');
      listLimit=limit===null?undefined:Number(limit);
      if(version==='1')productionVersion=1;
     }
     revision=Number(raw);
     if(ifNoneMatch!==undefined||ifMatch===undefined)throw new Failure(428,'precondition-required');
     if(!/^"[a-f0-9]{64}"$/.test(ifMatch))throw new Failure(400,'invalid-precondition');
     const current=await projects.get(id);
     if(current.etag!==ifMatch||current.project.revision!==revision)throw new Failure(412,'precondition-failed');
    }else if(url.search)throw new Failure(400,'invalid-request');
    if(processing){
     if(!services.scanProcessing)throw new Failure(404,'not-found');
     const cid=processing[2]!.toLowerCase(),jid=processing[3]?.toLowerCase();
     if(!z.uuid().safeParse(cid).success||jid&&!z.uuid().safeParse(jid).success)throw new Failure(400,'invalid-request');
     const input={projectId:id,projectRevision:revision,captureId:cid,expectedProjectETag:ifMatch};
     let result:unknown,artifact:Awaited<ReturnType<ScanProcessingStore['artifact']>>|undefined;
     if(request.method==='POST'){
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type')??'')||!['identity',undefined].includes(header('content-encoding')))throw new Failure(415,'unsupported-media-type');
      const bytes=await body(request,controller.signal,4096);let value:unknown;
      try{value=ScanProcessingRequestSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new Failure(400,'invalid-request');}
      assertActive();await authorize(scope);assertActive();
      result=await services.scanProcessing.start({...input,request:value},()=>authorize(scope),controller.signal);response.statusCode=202;
     }else if(request.method==='DELETE'){
      await authorize(scope);assertActive();result=await services.scanProcessing.cancel(input,jid!);
     }else if(processing[4]){
      const name=ScanArtifactNameSchema.safeParse(processing[4]);if(!name.success)throw new Failure(404,'not-found');
      artifact=await services.scanProcessing.artifact(input,jid!,name.data);result={job:artifact.job};
     }else if(jid)result=await services.scanProcessing.load(input,jid);
     else result=await services.scanProcessing.list(input);
     await services.storage.withCurrentProject(id,revision,async()=>{
      await authorize(scope);assertActive();response.setHeader('ETag',ifMatch!);
      if(artifact){response.setHeader('Content-Type',artifact.ref.mediaType);response.setHeader('X-Content-SHA256',artifact.ref.sha256);await send(response,artifact.bytes);}
      else await send(response,JSON.stringify(result));
     },ifMatch);
     return;
    }
    if(writing){
     const contentType=header('content-type')??'';
     if(!(stillPost?['image/jpeg','image/heic','image/png'].includes(contentType):captureRoute?contentType==='model/vnd.usdz+zip':/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType))||!['identity',undefined].includes(header('content-encoding')))throw new Failure(415,'unsupported-media-type');
     const limit=stillPost?MAX_DETAIL_STILL_BYTES:prepared?Math.ceil(services.preparedJobs!.maxPrintableBytes/3)*4+PREPARED_METADATA_BYTES:captureRoute?DEFAULT_CAPTURE_LIMITS.maxSourceBytes:MAX_SAVED_PROJECT_SYNC_BYTES;
     if(Number(header('content-length')??0)>limit)throw new Failure(413,'payload-too-large');
     const bytes=await body(request,controller.signal,limit,prepared?30000:5000);assertActive();await authorize(scope);assertActive();
     if(stillPost){
      if(sniffDetailStillMediaType(bytes)!==contentType)throw new Failure(415,'unsupported-media-type');
      const result=await services.detailStills!.addDetailStill({projectId:id,projectRevision:revision,captureId:stillCaptureId!,label:stillLabel,source:bytes,expectedProjectETag:ifMatch},controller.signal,()=>authorize(scope));
      assertActive();response.statusCode=201;response.setHeader('ETag',ifMatch!);await send(response,JSON.stringify(result));
     }else if(prepared){
      const input=preparedEnvelope(bytes,services.preparedJobs!.maxPrintableBytes);
      const result=await services.preparedJobs!.prepare({...input,jobId:jobId!,projectId:id,projectRevision:revision,expectedProjectETag:ifMatch},controller.signal,()=>authorize(scope));
      assertActive();response.statusCode=result.created?201:200;response.setHeader('ETag',ifMatch!);
      await send(response,JSON.stringify({jobId:result.jobId,job:result.job}));
     }else if(captureRoute){
      const result=await services.captures!.importCapture({projectId:id,projectRevision:revision,source:bytes,expectedProjectETag:ifMatch},controller.signal,()=>authorize(scope));
      response.statusCode=201;response.setHeader('ETag',ifMatch!);await send(response,JSON.stringify(result));
     }else{
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Failure(400,'invalid-snapshot');}
      const result=await projects.put(id,text,{ifMatch,ifNoneMatch},async()=>{assertActive();await authorize(scope);assertActive();});response.statusCode=ifNoneMatch==='*'?201:200;response.setHeader('ETag',result.etag);await send(response,result.bytes);
     }
    }else if(stills){
     if(request.method==='DELETE'){
      const result=await services.detailStills!.deleteDetailStill(id,revision,stillCaptureId!,stillId!,ifMatch,controller.signal,()=>authorize(scope));
      await authorize(scope);assertActive();response.setHeader('ETag',ifMatch!);
      await send(response,JSON.stringify({captureId:stillCaptureId,stillId:result.still.id,deleted:true}));
     }else if(stillId){
      const result=await services.detailStills!.loadDetailStill(id,revision,stillCaptureId!,stillId,ifMatch);
      await authorize(scope);assertActive();
      await services.storage.withCurrentProject(id,revision,async()=>{
       assertActive();response.setHeader('ETag',ifMatch!);
       response.setHeader('Content-Type',result.still.mediaType);response.setHeader('X-Content-SHA256',result.still.sha256);await send(response,result.bytes);
      },ifMatch);
     }else{
      const result=await services.detailStills!.listDetailStills(id,revision,stillCaptureId!,ifMatch);
      await authorize(scope);assertActive();
      await services.storage.withCurrentProject(id,revision,async()=>{
       assertActive();response.setHeader('ETag',ifMatch!);await send(response,JSON.stringify(result));
      },ifMatch);
     }
    }else if(listing){
     const result=await services.preparedJobs!.listPreparedJobs({projectId:id,projectRevision:revision,expectedProjectETag:ifMatch!,limit:listLimit,cursor:listCursor,...(productionVersion===1?{productionVersion}:{})},controller.signal);
     await services.storage.withCurrentProject(id,revision,async()=>{
      await authorize(scope);assertActive();response.setHeader('ETag',ifMatch!);await send(response,JSON.stringify(result));
     },ifMatch);
    }else if(prepared){
     const result=await services.preparedJobs!.loadPreparedJob(jobId!,ifMatch);
     if(result.job.projectId!==id||result.job.projectRevision!==revision)throw new Failure(404,'not-found');
     if(!result.job.inspection)throw new Failure(422,'preparation-unavailable');
     await services.storage.withCurrentProject(id,revision,async()=>{
      await authorize(scope);assertActive();response.setHeader('ETag',ifMatch!);
      if(prepared[3]){
       response.setHeader('Content-Type',result.job.printableArtifact.mediaType);
       response.setHeader('X-Content-SHA256',result.job.printableArtifact.sha256);await send(response,result.printable);
      }else await send(response,JSON.stringify({jobId:result.jobId,job:result.job,intent:result.intent}));
     },ifMatch);
    }else if(captureRoute){
     const result=await services.captures!.loadCapture(id,revision,captureId!,ifMatch);
     await authorize(scope);assertActive();
     // Recheck after asynchronous authorization and hold the edit lock through response flush.
     await services.storage.withCurrentProject(id,revision,async()=>{
      assertActive();response.setHeader('ETag',ifMatch!);
      if(kind){
       const ref=kind==='original'?result.binding.capture.original:kind==='derived'?result.binding.capture.derived:result.binding.capture.conversionReport;
       response.setHeader('Content-Type',ref.mediaType);response.setHeader('X-Content-SHA256',ref.sha256);await send(response,result[kind]);
      }else await send(response,JSON.stringify({captureId:result.captureId,binding:result.binding}));
     },ifMatch);
    }else{
     const result=await projects.get(id);await authorize(scope);assertActive();response.setHeader('ETag',result.etag);await send(response,result.bytes);
    }
   }catch(error){
    const failure=error instanceof Failure||error instanceof RemoteAuthFailure?error:error instanceof SavedProjectSyncFailure?new Failure(snapshotStatus[error.code],error.code):error instanceof PreparedJobFailure?new Failure({'not-found':404,'job-conflict':409,cancelled:499,'invalid-cursor':400,'cursor-stale':409,'discovery-unavailable':503}[error.code],error.code):error instanceof ScanProcessingFailure?new Failure({'busy':429,'not-found':404,'processing-unavailable':422,'invalid-request':400}[error.code],error.code):error instanceof DetailStillFailure?new Failure({'not-found':404,'still-limit':409,'unsupported-media-type':415,'invalid-still':400,'payload-too-large':413,'still-unavailable':422}[error.code],error.code):['EACCES','EIO','ENOSPC','EROFS'].includes((error as NodeJS.ErrnoException)?.code??'')?new Failure(503,'storage-unavailable'):new Failure(422,'capture-unavailable');
    if(!response.destroyed&&!response.headersSent){response.statusCode=failure.status;await send(response,JSON.stringify({error:{code:failure.code,message:failure.code}}));}
   }finally{
    if(disconnected)response.off('close',disconnected);
    if(finish){active=undefined;finish();}
   }
  },
 };
}
