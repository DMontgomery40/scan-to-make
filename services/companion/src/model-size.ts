import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rename,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {ModelSizeSchema,ModelSizeRequestSchema,BoxRotationSchema,planModelSize,type ModelSize,type ModelSizeRequest} from '@scan-to-make/contracts/model-size';
import type {FileSavedProjectStorage} from '@scan-to-make/project';
import type {ScanProcessingStore} from './scan-processing.js';
import type {ModelSizeRunner,SizeModelInput} from './model-size-runner.js';
import {readBoundedCaptureFile} from './capture-import.js';

const contextSchema=z.strictObject({projectId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),captureId:z.uuid(),projectRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),expectedProjectETag:z.string().regex(/^"[a-f0-9]{64}"$/).optional()});
export type ModelSizeContext=z.infer<typeof contextSchema>;
export class ModelSizeFailure extends Error {
 constructor(readonly status:number,readonly code:string){super(code);}
}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const durable=async(path:string,bytes:string|Buffer)=>{await writeFile(path,bytes,{flag:'wx',mode:0o600});const f=await open(path,'r');try{await f.sync();}finally{await f.close();}};

/** Separate from legacy job JSON: old phones can still read their completed jobs. */
export class ModelSizeStore {
 constructor(private projects:FileSavedProjectStorage,private jobs:ScanProcessingStore,private directory:string,private runner:ModelSizeRunner){}
 private folder(input:ModelSizeContext,jobId:string){contextSchema.parse(input);z.uuid().parse(jobId);return join(this.directory,input.captureId,'scan-processing',jobId,'sizes');}
 private async original(input:ModelSizeContext,jobId:string):Promise<SizeModelInput>{
  const model=await this.jobs.artifact(input,jobId,'repaired.stl'),report=await this.jobs.artifact(input,jobId,'report.json');
  try{
   const m=JSON.parse(report.bytes.toString('utf8')).measurement;
   const [length,width,height]=z.tuple([z.number().positive().finite(),z.number().positive().finite(),z.number().positive().finite()]).parse(m.boxExtentsMm);
   return {bytes:model.bytes,sha256:model.ref.sha256,dimensionsMm:{length,width,height},rotation:BoxRotationSchema.parse(m.boxRotation)};
  }catch{throw new ModelSizeFailure(422,'box-frame-unavailable');}
 }
 private async current(folder:string,jobId:string,original:SizeModelInput){
  let bytes:Buffer;
  try{bytes=await readBoundedCaptureFile(join(folder,'current.json'),65536);}catch(e){
   if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new ModelSizeFailure(422,'size-unavailable');
   return ModelSizeSchema.parse({schema:'scan-to-make.model-size/0.1',jobId,revision:0,baseModelSha256:original.sha256,
    ...planModelSize(original.dimensionsMm,{source:{kind:'scanned'}}),artifact:null,transform:null});
  }
  try{
   const record=ModelSizeSchema.parse(JSON.parse(bytes.toString()));
   if(record.jobId!==jobId||record.baseModelSha256!==original.sha256||!record.artifact)throw Error('Size identity mismatch');
   const saved=join(folder,record.artifact.id);
   if(!(await readBoundedCaptureFile(join(saved,'record.json'),65536)).equals(bytes))throw Error('Size metadata mismatch');
   const model=await readBoundedCaptureFile(join(saved,'model.stl'),record.artifact.byteLength);
   if(model.length!==record.artifact.byteLength||sha(model)!==record.artifact.sha256)throw Error('Size artifact mismatch');
   return record;
  }catch{throw new ModelSizeFailure(422,'size-unavailable');}
 }
 async get(input:ModelSizeContext,jobId:string){
  const folder=this.folder(input,jobId),original=await this.original(input,jobId);return this.current(folder,jobId,original);
 }
 async apply(input:ModelSizeContext,jobId:string,value:ModelSizeRequest,signal:AbortSignal,authorize:()=>Promise<void>){
  const request=ModelSizeRequestSchema.parse(value),folder=this.folder(input,jobId),original=await this.original(input,jobId);
  const current=await this.current(folder,jobId,original);
  const unchanged=(size:ModelSize)=>{if(request.expectedModelSha256!==original.sha256||request.expectedSizeRevision!==size.revision)throw new ModelSizeFailure(409,'size-changed');};
  unchanged(current);const plan=planModelSize(original.dimensionsMm,{source:request.source,...(request.dimensionsMm?{dimensionsMm:request.dimensionsMm}:{})});
  if(current.revision===Number.MAX_SAFE_INTEGER)throw new ModelSizeFailure(409,'size-changed');
  await authorize();signal.throwIfAborted();await mkdir(folder,{recursive:true,mode:0o700});
  const work=await mkdtemp(join(folder,'.work-')),id=randomUUID(),saved=join(folder,id);let published=false;
  try{
   const result=await this.runner(original,plan.scaleFactors,work,signal);signal.throwIfAborted();
   const record=ModelSizeSchema.parse({schema:'scan-to-make.model-size/0.1',jobId,revision:current.revision+1,baseModelSha256:original.sha256,
    ...plan,dimensionsMm:result.dimensionsMm,transform:result.transform,artifact:{id,sha256:sha(result.bytes),byteLength:result.bytes.length,mediaType:'model/stl'}});
   const ready=join(work,'ready');await mkdir(ready,{mode:0o700});
   await durable(join(ready,'model.stl'),result.bytes);await durable(join(ready,'record.json'),JSON.stringify(record));
   // Prepare the commit marker before the project lock; expensive MCP work never holds it.
   await durable(join(ready,'current.json'),JSON.stringify(record));
   const staged=await open(ready,'r');try{await staged.sync();}finally{await staged.close();}
   if((await this.original(input,jobId)).sha256!==original.sha256)throw new ModelSizeFailure(409,'size-changed');
   return await this.projects.withCurrentProject(input.projectId,input.projectRevision,async()=>{
    await authorize();signal.throwIfAborted();unchanged(await this.current(folder,jobId,original));
    await rename(ready,saved);await authorize();signal.throwIfAborted();
    await rename(join(saved,'current.json'),join(folder,'current.json'));published=true;
    const dir=await open(folder,'r');try{await dir.sync();}finally{await dir.close();}
    return record;
   },input.expectedProjectETag);
  }catch(e){
   if(e instanceof Error&&e.message.startsWith('Saved project is busy'))throw new ModelSizeFailure(409,'size-changed');
   throw e;
  }finally{await rm(work,{recursive:true,force:true});if(!published)await rm(saved,{recursive:true,force:true});}
 }
 async artifact(input:ModelSizeContext,jobId:string,id:string){
  z.uuid().parse(id);const folder=this.folder(input,jobId),original=await this.original(input,jobId);
  try{
   const size=ModelSizeSchema.parse(JSON.parse((await readBoundedCaptureFile(join(folder,id,'record.json'),65536)).toString()));
   if(size.jobId!==jobId||size.baseModelSha256!==original.sha256||size.artifact?.id!==id)throw Error('Size artifact identity mismatch');
   const bytes=await readBoundedCaptureFile(join(folder,id,'model.stl'),size.artifact.byteLength);
   if(bytes.length!==size.artifact.byteLength||sha(bytes)!==size.artifact.sha256)throw Error('Size artifact hash mismatch');
   return {size,ref:size.artifact,bytes};
  }catch(e){throw new ModelSizeFailure((e as NodeJS.ErrnoException).code==='ENOENT'?404:422,'size-unavailable');}
 }
}
