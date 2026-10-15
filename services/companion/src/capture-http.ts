import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {ArtifactRefSchema} from '@scan-to-make/contracts';
import {PrintSelectionSchema} from './index.js';
import {PreparedJobStore,PreparedJobFailure} from './prepared-jobs.js';
import {SavedProjectSync,SavedProjectSyncFailure,MAX_SAVED_PROJECT_SYNC_BYTES,type FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore,DEFAULT_CAPTURE_LIMITS} from './capture-import.js';
import {RemoteAuthFailure,type RemoteScope} from './remote-auth.js';

export interface CaptureServices {storage:FileSavedProjectStorage;captures?:CaptureStore;preparedJobs?:PreparedJobStore}
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
  async close(){const pending=active;pending?.controller.abort();await pending?.done;},
  async handle(request:IncomingMessage,response:ServerResponse,authorize:(scope:RemoteScope)=>Promise<void>,header:(name:string)=>string|undefined){
   let finish:(()=>void)|undefined;let disconnected:(()=>void)|undefined;
   try {
    const url=new URL(request.url!,'http://localhost');
    const match=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/captures(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/(original|derived|report))?)?)?$/.exec(url.pathname);
    const prepared=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/prepared-jobs\/([a-fA-F0-9-]{36})(?:\/artifacts\/(printable))?$/.exec(url.pathname);
    if(!match&&!prepared)throw new Failure(404,'not-found');
    const id=(prepared??match)![1]!,captureId=match?.[2],kind=match?.[3] as 'original'|'derived'|'report'|undefined;
    const jobId=prepared?.[2]?.toLowerCase();
    if(jobId&&!z.uuid().safeParse(jobId).success)throw new Failure(400,'invalid-request');
    if(prepared&&!services.preparedJobs)throw new Failure(404,'not-found');
    const captureRoute=!!match&&match[0]!==`/v1/saved-projects/${id}`;
    if(captureRoute&&!services.captures)throw new Failure(404,'not-found');
    const writing=request.method==='PUT'||request.method==='POST';
    const scope:RemoteScope=prepared?(writing?'prepared-jobs:prepare':'prepared-jobs:read'):captureRoute?(writing?'captures:import':'captures:read'):(writing?'projects:write':'projects:read');
    await authorize(scope);
    if(prepared?(prepared[3]?request.method!=='GET':!['GET','POST'].includes(request.method??'')):captureRoute?(captureId?request.method!=='GET':request.method!=='POST'):!['GET','PUT'].includes(request.method??''))throw new Failure(405,'method-not-allowed');
    if(active)throw new Failure(429,'busy');
    const controller=new AbortController();active={controller,done:new Promise<void>(resolve=>finish=resolve)};
    disconnected=()=>{if(!response.writableEnded)controller.abort();};response.once('close',disconnected);
    const assertActive=()=>{if(controller.signal.aborted)throw new Failure(499,'cancelled');};
    const ifMatch=header('if-match'),ifNoneMatch=header('if-none-match');
    let revision=0;
    if(captureRoute||prepared){
     const keys=[...url.searchParams.keys()];const raw=url.searchParams.get('projectRevision');
     if(keys.length!==1||keys[0]!=='projectRevision'||raw===null||! /^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Failure(400,'invalid-request');
     revision=Number(raw);
     if(ifNoneMatch!==undefined||ifMatch===undefined)throw new Failure(428,'precondition-required');
     if(!/^"[a-f0-9]{64}"$/.test(ifMatch))throw new Failure(400,'invalid-precondition');
     const current=await projects.get(id);
     if(current.etag!==ifMatch||current.project.revision!==revision)throw new Failure(412,'precondition-failed');
    }else if(url.search)throw new Failure(400,'invalid-request');
    if(writing){
     const contentType=header('content-type')??'';
     if(!(captureRoute?contentType==='model/vnd.usdz+zip':/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType))||!['identity',undefined].includes(header('content-encoding')))throw new Failure(415,'unsupported-media-type');
     const limit=prepared?Math.ceil(services.preparedJobs!.maxPrintableBytes/3)*4+PREPARED_METADATA_BYTES:captureRoute?DEFAULT_CAPTURE_LIMITS.maxSourceBytes:MAX_SAVED_PROJECT_SYNC_BYTES;
     if(Number(header('content-length')??0)>limit)throw new Failure(413,'payload-too-large');
     const bytes=await body(request,controller.signal,limit,prepared?30000:5000);assertActive();await authorize(scope);assertActive();
     if(prepared){
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
    const failure=error instanceof Failure||error instanceof RemoteAuthFailure?error:error instanceof SavedProjectSyncFailure?new Failure(snapshotStatus[error.code],error.code):error instanceof PreparedJobFailure?new Failure({'not-found':404,'job-conflict':409,cancelled:499}[error.code],error.code):['EACCES','EIO','ENOSPC','EROFS'].includes((error as NodeJS.ErrnoException)?.code??'')?new Failure(503,'storage-unavailable'):new Failure(422,'capture-unavailable');
    if(!response.destroyed&&!response.headersSent){response.statusCode=failure.status;await send(response,JSON.stringify({error:{code:failure.code,message:failure.code}}));}
   }finally{
    if(disconnected)response.off('close',disconnected);
    if(finish){active=undefined;finish();}
   }
  },
 };
}
