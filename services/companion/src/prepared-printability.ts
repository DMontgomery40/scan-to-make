import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, dirname} from 'node:path';
import {z} from 'zod';
import {readBoundedCaptureFile} from './capture-import.js';
import type {ArtifactRef} from '@scan-to-make/contracts';

/** The selection fields the gate cross-checks against the report profile. */
export interface PrintabilitySelection {model:string; bedType:string; nozzleDiameters:readonly number[]; nozzleType?:string}

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const text=(max:number)=>z.string().min(1).max(max);

/** Operator-pinned printability gate configuration (docs/print-path.md section 4.2). */
export const preparedPrintabilityConfigurationSchema=z.strictObject({
 python:z.string().refine(isAbsolute),
 script:z.string().refine(isAbsolute),
 expectedScriptSha256:digest,
 expectedAnalyzerSha256:digest,
 expectedProfilesSha256:digest,
 profileId:z.string().min(1).max(128),
 material:z.enum(['PLA','PETG','TPU','ABS','ASA']).optional(),
 timeoutSeconds:z.number().int().min(1).max(60).default(15),
});
export interface PreparedPrintabilityConfiguration {
 python:string; script:string;
 expectedScriptSha256:string; expectedAnalyzerSha256:string; expectedProfilesSha256:string;
 profileId:string; material?:'PLA'|'PETG'|'TPU'|'ABS'|'ASA'; timeoutSeconds?:number;
}

export const PrintabilityReportSchema=z.strictObject({
 schema:z.literal('scan-to-make.printability/0.1.0'),
 verdict:z.enum(['printable','printable-with-supports','not-printable']),
 reasonCodes:z.array(text(128)).max(64),
 reasons:z.array(text(4096)).max(64),
 warnings:z.array(z.strictObject({code:text(128),message:text(4096)})).max(64),
 dispatchAuthorized:z.literal(false),
 provesPhysicalFit:z.literal(false),
 input:z.strictObject({
  fileName:text(512), format:text(64), sha256:digest,
  byteLength:z.number().int().positive(), mediaType:z.literal('model/stl'),
 }),
 profile:z.strictObject({
  id:text(128), bambuModel:text(128), displayName:text(512),
  bedMm:z.record(z.string(),z.unknown()), excludeZonesMm:z.array(z.unknown()),
  nozzleDiameterMm:z.number().positive(), nozzleCount:z.number().int().positive(),
  nozzleType:text(128), bedType:text(128),
 }),
 topology:z.record(z.string(),z.unknown()),
 checks:z.record(z.string(),z.unknown()),
 estimates:z.record(z.string(),z.unknown()),
});
export type PrintabilityReport=z.infer<typeof PrintabilityReportSchema>;
export type PrintabilitySummary=Pick<PrintabilityReport,'verdict'|'reasonCodes'|'reasons'|'warnings'|'profile'>;

export class PreparedPrintabilityFailure extends Error {
 constructor(
  readonly code:'printability-failed'|'supports-required'|'printability-unavailable',
  readonly summary?:PrintabilitySummary,
 ){super(code);}
}

function sha256(bytes:Buffer):string{return createHash('sha256').update(bytes).digest('hex');}
async function verifyPinned(path:string,expected:string,label:string){
 let bytes:Buffer;
 try{bytes=await readBoundedCaptureFile(path,4*1024*1024);}catch{throw new PreparedPrintabilityFailure('printability-unavailable');}
 if(sha256(bytes)!==expected)throw new PreparedPrintabilityFailure('printability-unavailable');
 if(!bytes.length)throw new PreparedPrintabilityFailure('printability-unavailable');
 void label;
}

export interface PreparedPrintabilityGate {
 readonly identity:string;
 check(sourcePath:string,sourceArtifact:ArtifactRef,selection:PrintabilitySelection,allowSupports:boolean,signal?:AbortSignal):
  Promise<{report:PrintabilityReport;reportBytes:Buffer;enableSupport:boolean}>;
}

/** Trusted host capability, configured at construction; never supplied by a remote request. */
export function createPreparedPrintabilityGate(configuration:PreparedPrintabilityConfiguration):PreparedPrintabilityGate{
 const config=preparedPrintabilityConfigurationSchema.parse(configuration);
 const identity=sha256(Buffer.from(JSON.stringify({adapterVersion:1,...config})));
 return {identity,async check(sourcePath,sourceArtifact,selection,allowSupports,signal){
  if(signal?.aborted)throw new PreparedPrintabilityFailure('printability-unavailable');
  const directory=dirname(config.script);
  await verifyPinned(config.script,config.expectedScriptSha256,'script');
  await verifyPinned(join(directory,'analyzer.py'),config.expectedAnalyzerSha256,'analyzer');
  await verifyPinned(join(directory,'profiles.json'),config.expectedProfilesSha256,'profiles');
  const temp=await mkdtemp(join(tmpdir(),'prepared-printability-'));
  try{
   const out=join(temp,'printability.json');
   const argv=['-I','-B',config.script,'check',sourcePath,'--profile',config.profileId,'--out',out];
   if(config.material)argv.push('--material',config.material);
   const child=spawn(config.python,argv,{detached:true,stdio:['ignore','pipe','pipe'],
    env:{PATH:'/usr/bin:/bin',LANG:'C',TMPDIR:temp}});
   let failed=false,logBytes=0;
   const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* already gone */}};
   const drain=(bytes:Buffer)=>{logBytes+=bytes.length;if(logBytes>1024*1024){failed=true;kill();}};
   child.stdout!.on('data',drain);child.stderr!.on('data',drain);
   const timer=setTimeout(()=>{failed=true;kill();},config.timeoutSeconds*1000);
   const abort=()=>kill();
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)kill();
   const code:number|null=await new Promise(resolve=>{child.once('error',()=>{failed=true;});child.once('close',resolve);});
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   if(signal?.aborted||failed||code!==0)throw new PreparedPrintabilityFailure('printability-unavailable');
   let reportBytes:Buffer;
   try{reportBytes=await readBoundedCaptureFile(out,1024*1024);}catch{throw new PreparedPrintabilityFailure('printability-unavailable');}
   let report:PrintabilityReport;
   try{report=PrintabilityReportSchema.parse(JSON.parse(reportBytes.toString('utf8')));}catch{throw new PreparedPrintabilityFailure('printability-unavailable');}
   if(report.input.sha256!==sourceArtifact.sha256||report.input.byteLength!==sourceArtifact.byteLength||
      report.profile.bambuModel!==selection.model||report.profile.bedType!==selection.bedType||
      (selection.nozzleType!==undefined&&report.profile.nozzleType!==selection.nozzleType)||
      selection.nozzleDiameters.length!==1||report.profile.nozzleDiameterMm!==selection.nozzleDiameters[0]){
    throw new PreparedPrintabilityFailure('printability-unavailable');
   }
   const summary:PrintabilitySummary={verdict:report.verdict,reasonCodes:report.reasonCodes,reasons:report.reasons,warnings:report.warnings,profile:report.profile};
   if(report.verdict==='not-printable')throw new PreparedPrintabilityFailure('printability-failed',summary);
   if(report.verdict==='printable-with-supports'&&!allowSupports)throw new PreparedPrintabilityFailure('supports-required',summary);
   return {report,reportBytes,enableSupport:report.verdict==='printable-with-supports'};
  }finally{await rm(temp,{recursive:true,force:true});}
 }};
}
