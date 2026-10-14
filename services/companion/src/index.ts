import {copyFile,chmod,mkdir,readFile,open,rmdir,rm,stat} from 'node:fs/promises';
import {createReadStream,constants} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ArtifactRefSchema,validateArtifactRef,type ArtifactRef} from '@scan-to-make/contracts';
import {ProjectStore} from '@scan-to-make/project';

const safeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema=z.strictObject({id:z.uuid(),artifact:ArtifactRefSchema});
export const PrintSelectionSchema=z.strictObject({
 printerId:safeId, model:z.string().trim().min(1), plateIndex:integer,
 nozzleDiameters:z.array(z.literal([0.2,0.4,0.6,0.8])).min(1).max(2),
 bedType:z.enum(['textured_plate','cool_plate','engineering_plate','hot_plate','supertack_plate']),
 materials:z.array(z.strictObject({projectSlot:integer,material:z.string().trim().min(1),physicalTray:integer})).min(1),
 slicerSettingsSha256:digest,
}).refine(s=>new Set(s.materials.map(m=>m.projectSlot)).size===s.materials.length,{message:'Project filament positions must be unique'});
const planBody=z.strictObject({
 schemaVersion:z.literal('0.1.0'),id:z.uuid(),projectId:safeId,specRevision:integer,snapshotId:z.uuid(),
 designArtifact:ArtifactRefSchema,printableArtifact:ArtifactRefSchema,selection:PrintSelectionSchema,
});
function hashPlan(body:z.infer<typeof planBody>):string{
 return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
export const PrintPlanSchema=planBody.extend({sha256:digest}).refine(plan=>{
 const {sha256,...body}=plan;return sha256===hashPlan(body);
},{message:'Print plan content does not match its digest'});
const approvalSchema=z.strictObject({planSha256:digest,actorId:z.string().trim().min(1),confirmed:z.literal(true),expiresAtMs:integer});
const outcomeSchema=z.strictObject({state:z.enum(['started','unconfirmed','uncertain'])});
const reconciliationSchema=z.strictObject({actorId:z.string().trim().min(1),confirmed:z.literal(true),resolution:z.enum(['finished','cancelled','rejected'])});
const eventBase={attemptId:z.uuid(),atMs:integer};
const intentSchema=z.strictObject({...eventBase,kind:z.literal('intent'),plan:PrintPlanSchema,approval:approvalSchema});
const eventSchema=z.union([
 intentSchema,
 z.strictObject({...eventBase,kind:z.literal('outcome'),outcome:outcomeSchema}),
 z.strictObject({...eventBase,kind:z.literal('reconciled'),report:reconciliationSchema}),
]);
export type PrintPlan=z.infer<typeof PrintPlanSchema>;
export type JournalEvent=z.infer<typeof eventSchema>;
export type DispatchIntent=z.infer<typeof intentSchema>;

function sameRef(a:ArtifactRef,b:ArtifactRef):boolean{
 return a.sha256===b.sha256&&a.byteLength===b.byteLength&&a.mediaType===b.mediaType;
}

/** Records preparation and intent only. This class never calls a printer or MCP tool. */
export class CompanionJournal {
 constructor(private readonly directory:string,private readonly projects:ProjectStore,private readonly clock:()=>number=Date.now){}

 async stageArtifact(source:string,input:unknown):Promise<z.infer<typeof snapshotSchema>>{
  const artifact=validateArtifactRef(input);const id=randomUUID();
  if(!(await stat(source)).isFile())throw new Error('Artifact source must be a regular file');
  const folder=join(this.directory,'snapshots',id);await mkdir(folder,{recursive:true,mode:0o700});
  try{
   const file=join(folder,'artifact.bin');await copyFile(source,file,constants.COPYFILE_EXCL);await chmod(file,0o400);
   await this.verifyBytes(file,artifact);
   const metadata=snapshotSchema.parse({id,artifact});
   const handle=await open(join(folder,'metadata.json'),'wx',0o600);
   try{await handle.writeFile(JSON.stringify(metadata)+'\n');await handle.sync();}finally{await handle.close();}
   return metadata;
  }catch(error){await rm(folder,{recursive:true,force:true});throw error;}
 }

 async createPlan(input:unknown):Promise<PrintPlan>{
  const request=z.strictObject({projectId:safeId,snapshotId:z.uuid(),selection:PrintSelectionSchema}).parse(input);
  const project=await this.projects.load(request.projectId);
  if(!project.acceptedArtifact)throw new Error('Current design must be accepted before preparing a plan');
  const snapshot=await this.readSnapshot(request.snapshotId);
  const body=planBody.parse({schemaVersion:'0.1.0',id:randomUUID(),projectId:request.projectId,
   specRevision:project.spec.revision,snapshotId:snapshot.id,designArtifact:project.acceptedArtifact.artifact,
   printableArtifact:snapshot.artifact,selection:request.selection});
  return PrintPlanSchema.parse({...body,sha256:hashPlan(body)});
 }

 async beginAttempt(input:unknown,approvalInput:unknown):Promise<DispatchIntent>{
  const plan=PrintPlanSchema.parse(input);const approval=approvalSchema.parse(approvalInput);
  return this.withLock(plan.selection.printerId,async()=>{
   const now=integer.parse(this.clock());
   if(approval.planSha256!==plan.sha256||approval.expiresAtMs<=now||approval.expiresAtMs>now+300000)
    throw new Error('Approval must match this plan and expire within five minutes');
   const history=await this.readHistory(plan.selection.printerId);
   const intents=history.filter((e):e is DispatchIntent=>e.kind==='intent');
   if(intents.some(e=>e.plan.sha256===plan.sha256))throw new Error('This print plan already has an attempt; never replay it');
   if(intents.some(e=>!history.some(r=>r.kind==='reconciled'&&r.attemptId===e.attemptId)))
    throw new Error('Printer has an unreconciled attempt; check the actual job before another attempt');
   const project=await this.projects.load(plan.projectId);
   if(project.spec.revision!==plan.specRevision||!project.acceptedArtifact||!sameRef(project.acceptedArtifact.artifact,plan.designArtifact))
    throw new Error('Project revision or accepted design changed after plan preparation');
   const snapshot=await this.readSnapshot(plan.snapshotId);
   if(!sameRef(snapshot.artifact,plan.printableArtifact))throw new Error('Snapshot identity does not match the plan');
   const intent=intentSchema.parse({kind:'intent',attemptId:randomUUID(),atMs:now,plan,approval});
   await this.append(plan.selection.printerId,intent);return intent;
  });
 }

 async recordOutcome(printerId:string,attemptId:string,input:unknown):Promise<JournalEvent>{
  printerId=safeId.parse(printerId);attemptId=z.uuid().parse(attemptId);const outcome=outcomeSchema.parse(input);
  return this.withLock(printerId,async()=>{
   const history=await this.readHistory(printerId);this.requireOpenAttempt(history,attemptId);
   if(history.some(e=>e.attemptId===attemptId&&e.kind==='outcome'))throw new Error('Attempt already has an outcome');
   const event=eventSchema.parse({kind:'outcome',attemptId,atMs:this.clock(),outcome});await this.append(printerId,event);return event;
  });
 }

 async reconcile(printerId:string,attemptId:string,input:unknown):Promise<JournalEvent>{
  printerId=safeId.parse(printerId);attemptId=z.uuid().parse(attemptId);const report=reconciliationSchema.parse(input);
  return this.withLock(printerId,async()=>{
   const history=await this.readHistory(printerId);this.requireOpenAttempt(history,attemptId);
   const event=eventSchema.parse({kind:'reconciled',attemptId,atMs:this.clock(),report});await this.append(printerId,event);return event;
  });
 }

 async history(printerId:string):Promise<JournalEvent[]>{
  printerId=safeId.parse(printerId);return this.withLock(printerId,()=>this.readHistory(printerId));
 }

 private requireOpenAttempt(history:JournalEvent[],id:string):void{
  if(!history.some(e=>e.kind==='intent'&&e.attemptId===id)||history.some(e=>e.kind==='reconciled'&&e.attemptId===id))
   throw new Error('Attempt is missing or already reconciled');
 }
 private async readSnapshot(id:string):Promise<z.infer<typeof snapshotSchema>>{
  id=z.uuid().parse(id);const folder=join(this.directory,'snapshots',id);
  const metadata=snapshotSchema.parse(JSON.parse(await readFile(join(folder,'metadata.json'),'utf8')));
  if(metadata.id!==id)throw new Error('Stored snapshot identity mismatch');
  await this.verifyBytes(join(folder,'artifact.bin'),metadata.artifact);return metadata;
 }
 private async verifyBytes(file:string,expected:ArtifactRef):Promise<void>{
  if(!(await stat(file)).isFile())throw new Error('Snapshot must be a regular file');
  const hash=createHash('sha256');let length=0;
  for await(const chunk of createReadStream(file)){
   length+=chunk.length;if(length>expected.byteLength)throw new Error('Artifact byte length mismatch');hash.update(chunk);
  }
  if(length!==expected.byteLength||hash.digest('hex')!==expected.sha256)throw new Error('Artifact digest or byte length mismatch');
 }
 private async withLock<T>(printerId:string,operation:()=>Promise<T>):Promise<T>{
  const folder=join(this.directory,'journal');await mkdir(folder,{recursive:true,mode:0o700});const lock=join(folder,printerId+'.lock');
  try{await mkdir(lock,{mode:0o700});}catch(error){
   if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Printer journal busy or interrupted; inspect before recovery');throw error;
  }
  try{return await operation();}finally{await rmdir(lock);}
 }
 private async readHistory(printerId:string):Promise<JournalEvent[]>{
  let text:string;try{text=await readFile(join(this.directory,'journal',printerId+'.jsonl'),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const events=text.split('\n').filter(Boolean).map(line=>eventSchema.parse(JSON.parse(line)));
  const seen=new Map<string,{outcome:boolean,closed:boolean}>();
  for(const event of events){
   if(event.kind==='intent'){
    if(seen.has(event.attemptId)||event.plan.selection.printerId!==printerId)throw new Error('Corrupt journal intent');
    seen.set(event.attemptId,{outcome:false,closed:false});
   }else{
    const state=seen.get(event.attemptId);if(!state||state.closed)throw new Error('Corrupt journal transition');
    if(event.kind==='outcome'){if(state.outcome)throw new Error('Duplicate journal outcome');state.outcome=true;}
    else state.closed=true;
   }
  }
  return events;
 }
 private async append(printerId:string,event:JournalEvent):Promise<void>{
  const file=await open(join(this.directory,'journal',printerId+'.jsonl'),'a',0o600);
  try{await file.writeFile(JSON.stringify(event)+'\n');await file.sync();}finally{await file.close();}
 }
}
