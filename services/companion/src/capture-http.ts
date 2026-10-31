import {ModelSizeRequestSchema,SizePlanError} from '@scan-to-make/contracts/model-size';
import {ModelSizeStore,ModelSizeFailure} from './model-size.js';
import {ScanProcessingStore,ScanProcessingFailure} from './scan-processing.js';
import {ScanProcessingRequestSchema,ScanArtifactNameSchema} from '@scan-to-make/contracts/scan-processing';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {SavedProjectSync,SavedProjectSyncFailure,MAX_SAVED_PROJECT_SYNC_BYTES,type FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore,DEFAULT_CAPTURE_LIMITS} from './capture-import.js';
import {DetailStillStore,DetailStillFailure,sniffDetailStillMediaType} from './detail-stills.js';
import {MAX_DETAIL_STILL_BYTES} from '@scan-to-make/contracts/detail-still';
import {RemoteAuthFailure,type RemoteScope} from './remote-auth.js';

export interface CaptureServices {storage:FileSavedProjectStorage;captures?:CaptureStore;detailStills?:DetailStillStore;scanProcessing?:ScanProcessingStore;modelSize?:ModelSizeStore}
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

/** Routes share the companion listener's exact Host/browser/Serve boundary.
 * One capture/snapshot request owns the slot through body, worker and response cleanup.
 */
export function createCaptureRoutes(services:CaptureServices){
 const projects=new SavedProjectSync(services.storage);
 let active:{controller:AbortController;done:Promise<void>}|undefined;
 return {
  async close(){const pending=active;pending?.controller.abort();await pending?.done;await services.scanProcessing?.close();},
  async handle(request:IncomingMessage,response:ServerResponse,authorize:(scope:RemoteScope)=>Promise<void>,header:(name:string)=>string|undefined){
   let finish:(()=>void)|undefined;let disconnected:(()=>void)|undefined;
   try {
    const url=new URL(request.url!,'http://localhost');
    const match=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/captures(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/(original|derived|report))?)?)?$/.exec(url.pathname);
    const stills=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/detail-stills(?:\/([a-fA-F0-9-]{36}))?$/.exec(url.pathname);
    const processing=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/scan-processing(?:\/([a-fA-F0-9-]{36})(?:\/artifacts\/([^/]+))?)?$/.exec(url.pathname);
    const modelAssets=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/scan-processing\/([a-fA-F0-9-]{36})\/model-assets(?:\/([^/]+))?$/.exec(url.pathname);
    const size=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/scan-processing\/([a-fA-F0-9-]{36})\/size(?:\/artifacts\/([a-fA-F0-9-]{36}))?$/.exec(url.pathname);
    const makerSize=/^\/v1\/saved-projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/captures\/([a-fA-F0-9-]{36})\/scan-processing\/([a-fA-F0-9-]{36})\/maker-size$/.exec(url.pathname);
    if(!match&&!stills&&!processing&&!modelAssets&&!size&&!makerSize)throw new Failure(404,'not-found');
    const id=(size??makerSize??modelAssets??processing??stills??match)![1]!,captureId=match?.[2],kind=match?.[3] as 'original'|'derived'|'report'|undefined;
    const stillCaptureId=stills?.[2]?.toLowerCase(),stillId=stills?.[3]?.toLowerCase();
    if(stillCaptureId&&!z.uuid().safeParse(stillCaptureId).success)throw new Failure(400,'invalid-request');
    if(stillId&&!z.uuid().safeParse(stillId).success)throw new Failure(400,'invalid-request');
    if(stills&&!services.detailStills)throw new Failure(404,'not-found');
    const stillPost=!!stills&&!stillId&&request.method==='POST';
    const captureRoute=!!match&&match[0]!==`/v1/saved-projects/${id}`;
    if(captureRoute&&!services.captures)throw new Failure(404,'not-found');
    const writing=request.method==='PUT'||request.method==='POST';
    const scope:RemoteScope=size?(writing?'captures:import':'captures:read'):(modelAssets||makerSize)?'captures:read':processing?(writing||request.method==='DELETE'?'captures:import':'captures:read'):stills?(writing||request.method==='DELETE'?'captures:import':'captures:read'):captureRoute?(writing?'captures:import':'captures:read'):(writing?'projects:write':'projects:read');
    await authorize(scope);
    if(size?(size[4]?request.method!=='GET':!['GET','POST'].includes(request.method??'')):(modelAssets||makerSize)?request.method!=='GET':processing?(processing[3]?(processing[4]?request.method!=='GET':!['GET','DELETE'].includes(request.method??'')):!['GET','POST'].includes(request.method??'')):stills?(stillId?!['GET','DELETE'].includes(request.method??''):!['GET','POST'].includes(request.method??'')):captureRoute?(captureId?request.method!=='GET':request.method!=='POST'):!['GET','PUT'].includes(request.method??''))throw new Failure(405,'method-not-allowed');
    if(active)throw new Failure(429,'busy');
    const controller=new AbortController();active={controller,done:new Promise<void>(resolve=>finish=resolve)};
    disconnected=()=>{if(!response.writableEnded)controller.abort();};response.once('close',disconnected);
    const assertActive=()=>{if(controller.signal.aborted)throw new Failure(499,'cancelled');};
    const ifMatch=header('if-match'),ifNoneMatch=header('if-none-match');
    let revision=0,stillLabel:string|undefined;
    if(captureRoute||stills||processing||modelAssets||size||makerSize){
     const keys=[...url.searchParams.keys()];const raw=url.searchParams.get('projectRevision');
     if((stillPost?(new Set(keys).size!==keys.length||keys.some(key=>!['projectRevision','label'].includes(key))):keys.length!==1||keys[0]!=='projectRevision')||raw===null||! /^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new Failure(400,'invalid-request');
     if(stillPost)stillLabel=url.searchParams.get('label')??undefined;
     revision=Number(raw);
     if(ifNoneMatch!==undefined||ifMatch===undefined)throw new Failure(428,'precondition-required');
     if(!/^"[a-f0-9]{64}"$/.test(ifMatch))throw new Failure(400,'invalid-precondition');
     const current=await projects.get(id);
     if(current.etag!==ifMatch||current.project.revision!==revision)throw new Failure(412,'precondition-failed');
    }else if(url.search)throw new Failure(400,'invalid-request');
    if(size){
     if(!services.modelSize)throw new Failure(404,'not-found');
     const cid=size[2]!.toLowerCase(),jid=size[3]!.toLowerCase();
     if(![cid,jid,...(size[4]?[size[4].toLowerCase()]:[])].every(v=>z.uuid().safeParse(v).success))throw new Failure(400,'invalid-request');
     const input={projectId:id,projectRevision:revision,captureId:cid,expectedProjectETag:ifMatch};
     let result:unknown,artifact:Awaited<ReturnType<ModelSizeStore['artifact']>>|undefined;
     if(size[4])artifact=await services.modelSize.artifact(input,jid,z.uuid().parse(size[4].toLowerCase()));
     else if(request.method==='POST'){
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type')??'')||!['identity',undefined].includes(header('content-encoding')))throw new Failure(415,'unsupported-media-type');
      const bytes=await body(request,controller.signal,4096);let value;
      try{value=ModelSizeRequestSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new Failure(400,'invalid-request');}
      result={size:await services.modelSize.apply(input,jid,value,controller.signal,()=>authorize(scope))};
     }else result={size:await services.modelSize.get(input,jid)};
     await services.storage.withCurrentProject(id,revision,async()=>{
      await authorize(scope);assertActive();response.setHeader('ETag',ifMatch!);
      if(artifact){response.setHeader('Content-Type',artifact.ref.mediaType);response.setHeader('X-Content-SHA256',artifact.ref.sha256);await send(response,artifact.bytes);}
      else{response.setHeader('Content-Type','application/json');await send(response,JSON.stringify(result));}
     },ifMatch);
     return;
    }else if(processing||modelAssets||makerSize){
     if(!services.scanProcessing)throw new Failure(404,'not-found');
     const route=(makerSize??modelAssets??processing)!,cid=route[2]!.toLowerCase(),jid=route[3]?.toLowerCase();
     if(!z.uuid().safeParse(cid).success||jid&&!z.uuid().safeParse(jid).success)throw new Failure(400,'invalid-request');
     const input={projectId:id,projectRevision:revision,captureId:cid,expectedProjectETag:ifMatch};
     let result:unknown,artifact:Awaited<ReturnType<ScanProcessingStore['artifact']>>|Awaited<ReturnType<ScanProcessingStore['modelAsset']>>|undefined;
     if(makerSize)result=await services.scanProcessing.makerSize(input,jid!);
     else if(modelAssets){
      if(modelAssets[4])artifact=await services.scanProcessing.modelAsset(input,jid!,modelAssets[4]);
      else result={model:(await services.scanProcessing.modelAssets(input,jid!)).model};
     }else if(request.method==='POST'){
      if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type')??'')||!['identity',undefined].includes(header('content-encoding')))throw new Failure(415,'unsupported-media-type');
      const bytes=await body(request,controller.signal,4096);let value:unknown;
      try{value=ScanProcessingRequestSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw new Failure(400,'invalid-request');}
      assertActive();await authorize(scope);assertActive();
      result=await services.scanProcessing.start({...input,request:value},()=>authorize(scope),controller.signal);response.statusCode=202;
     }else if(request.method==='DELETE'){
      await authorize(scope);assertActive();result=await services.scanProcessing.cancel(input,jid!);
     }else if(processing![4]){
      const name=ScanArtifactNameSchema.safeParse(processing![4]);if(!name.success)throw new Failure(404,'not-found');
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
     const limit=stillPost?MAX_DETAIL_STILL_BYTES:captureRoute?DEFAULT_CAPTURE_LIMITS.maxSourceBytes:MAX_SAVED_PROJECT_SYNC_BYTES;
     if(Number(header('content-length')??0)>limit)throw new Failure(413,'payload-too-large');
     const bytes=await body(request,controller.signal,limit);assertActive();await authorize(scope);assertActive();
     if(stillPost){
      if(sniffDetailStillMediaType(bytes)!==contentType)throw new Failure(415,'unsupported-media-type');
      const result=await services.detailStills!.addDetailStill({projectId:id,projectRevision:revision,captureId:stillCaptureId!,label:stillLabel,source:bytes,expectedProjectETag:ifMatch},controller.signal,()=>authorize(scope));
      // A close-up that arrives after correction started queues a follow-up.
      // The still is already committed, so a queue failure never fails this POST.
      if(services.scanProcessing)await services.scanProcessing.enqueueFollowUp(id,stillCaptureId!,()=>authorize(scope)).catch(error=>{process.stderr.write(`scan-processing follow-up enqueue failed for capture ${stillCaptureId}: ${error instanceof Error?error.message:'unknown'}\n`);});
      assertActive();response.statusCode=201;response.setHeader('ETag',ifMatch!);await send(response,JSON.stringify(result));
     }else if(captureRoute){
      const result=await services.captures!.importCapture({projectId:id,projectRevision:revision,source:bytes,expectedProjectETag:ifMatch},controller.signal,()=>authorize(scope));
      // Cleanup starts on arrival; reference dimensions are not needed to begin.
      // The capture is already committed, so a queue failure never fails this POST.
      if(services.scanProcessing)await services.scanProcessing.enqueueForCapture(id,result.captureId,{authorize:()=>authorize(scope)}).catch(error=>{process.stderr.write(`scan-processing import enqueue failed for capture ${result.captureId}: ${error instanceof Error?error.message:'unknown'}\n`);});
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
    const failure=error instanceof Failure||error instanceof RemoteAuthFailure||error instanceof ModelSizeFailure?error:error instanceof SizePlanError?new Failure(422,error.code):error instanceof SavedProjectSyncFailure?new Failure(snapshotStatus[error.code],error.code):error instanceof ScanProcessingFailure?new Failure({'busy':429,'not-found':404,'processing-unavailable':422,'invalid-request':400}[error.code],error.code):error instanceof DetailStillFailure?new Failure({'not-found':404,'still-limit':409,'unsupported-media-type':415,'invalid-still':400,'payload-too-large':413,'still-unavailable':422}[error.code],error.code):['EACCES','EIO','ENOSPC','EROFS'].includes((error as NodeJS.ErrnoException)?.code??'')?new Failure(503,'storage-unavailable'):new Failure(422,'capture-unavailable');
    if(!response.destroyed&&!response.headersSent){response.statusCode=failure.status;await send(response,JSON.stringify({error:{code:failure.code,message:error instanceof SizePlanError?error.message:failure.code}}));}
   }finally{
    if(disconnected)response.off('close',disconnected);
    if(finish){active=undefined;finish();}
   }
  },
 };
}
