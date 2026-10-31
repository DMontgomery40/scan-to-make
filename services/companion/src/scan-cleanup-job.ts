import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AI_ATTEMPT_PREVIEW_NAMES,AiTweakRecordSchema,SCAN_VIEW_NAMES,DimensionsMmSchema,type AiTweakRecord,type ScanProcessingJob} from '@scan-to-make/contracts/scan-processing';
import type {DetailStill} from '@scan-to-make/contracts/detail-still';
import {readBoundedCaptureFile,receiptFromConvertedBytes} from './capture-import.js';
import type {ScanRunner} from './scan-processing-runner.js';
import {checkCleanupDisk,type CleanupContext} from './scan-cleanup-runner.js';
import {readScanMaterials} from './scan-model-assets.js';

export interface CleanupSnapshot {source:Buffer;stills:{still:DetailStill;bytes:Buffer}[]}
type Stage=NonNullable<ScanProcessingJob['pipelineStages']>[number]['kind'];
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const readJSON=async(path:string)=>JSON.parse((await readBoundedCaptureFile(path,2*1024*1024)).toString('utf8'));
const write=(path:string,data:Buffer|string)=>writeFile(path,data,{flag:'wx',mode:0o600});

/** Orchestrate existing CLIs; publish only explicit artifacts after their hashes are verified. */
export async function runCleanup(runner:ScanRunner,root:string,job:ScanProcessingJob,snapshot:CleanupSnapshot,signal:AbortSignal,
 onStage:(kind:Stage,status:'running'|'succeeded')=>Promise<void>,onAdvice:(output:string,names:string[])=>Promise<void>,onProcessGroup:(pid:number)=>Promise<void>,deadlineAt?:number){
 const output=join(root,'output'),sidecar=join(root,'units.json');
 const ctx:CleanupContext={source:join(root,'original.usdz'),imported:join(root,'imported'),repaired:join(root,'repaired'),
  advice:join(root,'advice'),corrected:join(root,'corrected'),stills:[],reference:job.reference,signal,onProcessGroup,deadlineAt,
  inputBytes:snapshot.source.length+snapshot.stills.reduce((sum,{bytes})=>sum+bytes.length,0)};
 await mkdir(output,{mode:0o700});await write(ctx.source,snapshot.source);
 const stillDir=join(root,'detail-stills');await mkdir(stillDir,{mode:0o700});
 for(const {still,bytes} of snapshot.stills){
  const path=join(stillDir,`${still.id}.img`);await write(path,bytes);await write(join(stillDir,`${still.id}.json`),JSON.stringify(still));ctx.stills.push(path);
 }
 const stage=async<T>(kind:Stage,action:()=>Promise<T>,commitsStatus=false):Promise<T>=>{
  await onStage(kind,'running');signal.throwIfAborted();const result=await action();
  // Advice publication commits its success status and artifacts together.
  if(!commitsStatus){signal.throwIfAborted();await onStage(kind,'succeeded');}return result;
 };
 const conversion=await stage('import',async()=>{
  await runner.cleanup!.run('import',ctx);
  const mesh=await readBoundedCaptureFile(join(ctx.imported,'mesh.obj'),64*1024*1024),reportBytes=await readBoundedCaptureFile(join(ctx.imported,'conversion.json'),1024*1024);
  const receipt=receiptFromConvertedBytes(snapshot.source,mesh,reportBytes),report=JSON.parse(reportBytes.toString('utf8'));
  if(!Array.isArray(report.outputs)||report.outputs.length>256)throw Error('Missing converter output manifest');
  for(const artifact of report.outputs){
   if(typeof artifact.path!=='string'||!/^mesh(?:\.obj|\.mtl|_basecolor_[0-9]+\.png)$/.test(artifact.path))throw Error('Invalid converter output path');
   const bytes=await readBoundedCaptureFile(join(ctx.imported,artifact.path),64*1024*1024);
   if(bytes.length!==artifact.bytes||sha(bytes)!==artifact.sha256)throw Error('Converter output mismatch');
  }
  await write(sidecar,JSON.stringify({unitsAuthored:true,metersPerUnit:receipt.provenance.metersPerUnit}));ctx.metersPerUnit=receipt.provenance.metersPerUnit;
  return {receipt,report};
 });
 const repair=await stage('repair',async()=>{
  await runner.run('repair',join(ctx.imported,'mesh.obj'),ctx.repaired,sidecar,signal,onProcessGroup);
  return readJSON(join(ctx.repaired,'report.json'));
 });
 const adviceNames=await stage('advise',async()=>{
  await runner.cleanup!.run('advise',ctx);
  const bytes=await readBoundedCaptureFile(join(ctx.advice,'advice.json'),2*1024*1024),advice=JSON.parse(bytes.toString('utf8'));
  const targets=advice.closeupAdvice?.targets;
  if(!Array.isArray(targets)||targets.length>4)throw Error('Invalid close-up advice');
  const names=['advice.json'];await write(join(output,'advice.json'),bytes);
  for(const [index,target] of targets.entries()){
   const suffix=String(index+1).padStart(2,'0'),expected=`renders/target-${suffix}.png`;
   if(target.rank!==index+1||target.render?.path!==expected)throw Error('Invalid advice render path');
   const image=await readBoundedCaptureFile(join(ctx.advice,expected),8*1024*1024);
   if(sha(image)!==target.render.sha256)throw Error('Advice image hash mismatch');
   const name=`advice-${suffix}.png`;await write(join(output,name),image);names.push(name);
  }
  await onAdvice(output,names);return names;
 },true);
 let aiTweak:AiTweakRecord|undefined;const previews:string[]=[];
 const correction=await stage('correct',async()=>{
  await runner.cleanup!.run('correct',ctx);const report=await readJSON(join(ctx.corrected,'report.json'));
  if(report.status!=='complete')throw Error('Incomplete correction');
  for(const name of ['corrected.obj','corrected.stl']){
   const bytes=await readBoundedCaptureFile(join(ctx.corrected,name),64*1024*1024);
   if(sha(bytes)!==report.outputs?.[name])throw Error('Correction output hash mismatch');
   await write(join(output,name),bytes);
   // Existing phone clients download these names; both now refer to final geometry.
   await write(join(output,name.replace('corrected','repaired')),bytes);
  }
  const materials=await readScanMaterials(ctx.corrected,await readBoundedCaptureFile(join(output,'repaired.obj'),64*1024*1024),report.outputs);
  for(const [name,bytes] of Object.entries(materials))await write(join(output,name),bytes);
  const log=await readBoundedCaptureFile(join(ctx.corrected,'tool-calls.jsonl'),16*1024*1024);
  if(sha(log)!==report.toolLogSha256)throw Error('Correction log hash mismatch');
  await write(join(output,'correction-calls.jsonl'),log);
  await write(join(output,'correction.json'),await readBoundedCaptureFile(join(ctx.corrected,'report.json'),2*1024*1024));
  if(runner.cleanup!.adapter==='ai-tweak'){
   // The AI step's record and each rendered attempt's preview (KAN-184); both are hash-bound to the report.
   aiTweak=AiTweakRecordSchema.parse(report.aiTweak);
   for(const name of AI_ATTEMPT_PREVIEW_NAMES){
    if(report.outputs?.[name]===undefined)continue;
    const image=await readBoundedCaptureFile(join(ctx.corrected,name),8*1024*1024);
    if(sha(image)!==report.outputs[name])throw Error('Correction output hash mismatch');
    await write(join(output,name),image);previews.push(name);
   }
  }
  return report;
 });
 const measured=await stage('measure',async()=>{
  const bytes=await runner.run('measure',join(output,'corrected.obj'),output,sidecar,signal,onProcessGroup);
  const metrics=JSON.parse(bytes.toString('utf8'));DimensionsMmSchema.parse(metrics.boxExtentsMm);DimensionsMmSchema.parse(metrics.principalExtentsMm);return bytes;
 });
 const views=join(root,'views');
 await stage('render',async()=>{
  await runner.run('render',join(output,'corrected.obj'),views,sidecar,signal,onProcessGroup);
  for(const name of SCAN_VIEW_NAMES)await write(join(output,name),await readBoundedCaptureFile(join(views,name),8*1024*1024));
  await checkCleanupDisk(root,ctx.inputBytes);
 });
 return {output,measured,repair,conversion,correction,aiTweak,names:[...adviceNames,'corrected.obj','corrected.stl','correction.json','correction-calls.jsonl',...previews]};
}
