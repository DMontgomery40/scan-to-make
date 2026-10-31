import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureReceiptSchema,CaptureBindingSchema,validateCaptureBinding,type CaptureReceipt,type CaptureBinding} from '@scan-to-make/contracts/capture';
import {materialLibrary,meshTextLines,textureMap} from './mesh-materials.js';

export interface CaptureConverter {
  /** Trusted host configuration only; never supplied by an import request. */
  convert(original: Buffer, signal?: AbortSignal): Promise<{derived: Buffer; report: Buffer; assets?: Record<string, Buffer>}>;
}
export interface CaptureLimits {maxSourceBytes?: number; maxDerivedBytes?: number; maxReportBytes?: number}
export const DEFAULT_CAPTURE_LIMITS = {maxSourceBytes:32*1024*1024,maxDerivedBytes:64*1024*1024,maxReportBytes:1024*1024};
const identity=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive()});
const reportSchema=z.object({
 tool:z.literal('capture-mesh-convert'),toolVersion:z.string().min(1).max(100),
 source:identity,output:identity.extend({format:z.literal('obj')}),
 metersPerUnit:z.number().finite().positive(),unitsAuthored:z.literal(true),upAxis:z.enum(['Y','Z']),
 metricQualified:z.literal(true),metricQualifiedReason:z.null(),unsupportedFeatures:z.array(z.unknown()).length(0),
 outputBasis:z.object({coordinates:z.literal('world'),units:z.literal('native stage units (unrescaled)'),metersPerUnit:z.number().finite().positive(),upAxis:z.enum(['Y','Z'])}),
 contributingLayers:z.array(identity.extend({identifier:z.string().min(1).max(1024)})).min(1).max(1024),
 provesCompleteCapture:z.literal(false),provesPhysicalFit:z.literal(false),
});
const requestSchema=z.object({projectId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),projectRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const captureIdSchema=z.string().uuid();
const ref=(bytes:Buffer,mediaType:string)=>({sha256:createHash('sha256').update(bytes).digest('hex'),mediaType,byteLength:bytes.length});
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new Error('Capture import aborted');};
function limits(input:CaptureLimits) {
 const result={...DEFAULT_CAPTURE_LIMITS,...input};
 for(const [key,value] of Object.entries(result))if(!Number.isSafeInteger(value)||value<1||value>DEFAULT_CAPTURE_LIMITS[key as keyof typeof result])throw new Error('Invalid capture byte limit');
 return result;
}

/** Checks exact bytes against output of a converter the host actually invoked.
 * A caller-supplied report is not an attestation; only the trusted worker invokes this.
 */
export function receiptFromConvertedBytes(original:Buffer,derived:Buffer,reportBytes:Buffer):CaptureReceipt {
 const report=reportSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reportBytes)));
 const sourceRef=ref(original,'model/vnd.usdz+zip'),derivedRef=ref(derived,'model/obj');
 if(report.source.sha256!==sourceRef.sha256||report.source.bytes!==sourceRef.byteLength||
 report.output.sha256!==derivedRef.sha256||report.output.bytes!==derivedRef.byteLength)throw new Error('Converter artifact identity mismatch');
 if(report.outputBasis.metersPerUnit!==report.metersPerUnit||report.outputBasis.upAxis!==report.upAxis)throw new Error('Inconsistent converter coordinate basis');
 return CaptureReceiptSchema.parse({formatVersion:'0.1.0',original:sourceRef,derived:derivedRef,conversionReport:ref(reportBytes,'application/json'),
 converter:{name:report.tool,version:report.toolVersion},
 provenance:{metersPerUnit:report.metersPerUnit,unitsAuthored:true,upAxis:report.upAxis,coordinates:'world',transformPolicy:'composed-once-native-unrescaled',
 contributingLayers:report.contributingLayers.map(layer=>({identifier:layer.identifier,artifact:{sha256:layer.sha256,byteLength:layer.bytes,mediaType:'application/octet-stream'}}))},
 qualification:{status:'qualified',reasons:[]},evidence:{metricAccuracy:'unknown',surfaceCompleteness:'unknown',physicalFit:'unknown'}});
}

/** Converter-owned basenames only; the report already records their byte identities. */
export function captureMaterialManifest(reportBytes:Buffer) {
 const report=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reportBytes));
 const outputs=z.array(identity.extend({path:z.string().regex(/^mesh(?:\.obj|\.mtl|_basecolor_[0-9]+\.png)$/)})).max(256).parse(report.outputs??[]);
 if(new Set(outputs.map(item=>item.path)).size!==outputs.length)throw new Error('Duplicate converter output');
 const obj=outputs.find(item=>item.path==='mesh.obj');
 if(obj&&(obj.sha256!==report.output?.sha256||obj.bytes!==report.output?.bytes))throw new Error('Inconsistent converter OBJ identity');
 return outputs.filter(item=>item.path!=='mesh.obj');
}
export function snapshotCaptureMaterials(derived:Buffer,report:Buffer,assets:Record<string,Buffer>={},maxBytes:number=DEFAULT_CAPTURE_LIMITS.maxDerivedBytes) {
 const manifest=captureMaterialManifest(report),result:Record<string,Buffer>={};
 if(Object.keys(assets).length!==manifest.length)throw new Error('Converter material bundle is incomplete');
 let total=derived.length;
 for(const item of manifest){
  const bytes=assets[item.path];
  if(!Buffer.isBuffer(bytes))throw new Error('Missing converter material asset');
  const copy=Buffer.from(bytes);total+=copy.length;
  if(total>maxBytes)throw new Error('Converted capture byte limit exceeded');
  if(copy.length!==item.bytes||ref(copy,'application/octet-stream').sha256!==item.sha256)throw new Error('Converter material identity mismatch');
  result[item.path]=copy;
 }
 for(const line of meshTextLines(derived)){
  const library=materialLibrary(line);
  if(library!==undefined&&(library!=='mesh.mtl'||!result['mesh.mtl']))throw new Error('Missing referenced material library');
 }
 for(const line of meshTextLines(result['mesh.mtl'])){
  const [directive]=line.split(/\s+/);
  // The trusted converter emits only base colour materials. Reject other MTL
  // directives instead of silently accepting an unchecked map/bump/refl path.
  if(directive==='newmtl'||directive==='Kd')continue;
  if(directive!=='map_Kd')throw new Error('Unsupported converter material directive');
  const map=textureMap(line);
  const clampOnly=map&&(map.options.length===0||map.options.length===2&&map.options[0]==='-clamp'&&/^(on|off)$/.test(map.options[1]!));
  const texture=clampOnly&&/^mesh_basecolor_[0-9]+\.png$/.test(map.file)?map.file:undefined;
  if(!texture||!result[texture])throw new Error('Missing referenced material texture');
 }
 return result;
}

export async function readBoundedCaptureFile(path:string,maxBytes:number):Promise<Buffer> {
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  if(!(await file.stat()).isFile())throw new Error('Capture artifact must be a regular file');
  const buffer=Buffer.alloc(maxBytes+1);let length=0;
  while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  if(length>maxBytes)throw new Error('Capture artifact exceeds byte limit');
  return Buffer.from(buffer.subarray(0,length));
 } finally {await file.close();}
}
/** Reused before converter cleanup and on reopen: only verified retained bytes. */
export async function readCaptureMaterials(folder:string,derived:Buffer,report:Buffer,maxBytes:number=DEFAULT_CAPTURE_LIMITS.maxDerivedBytes) {
 const assets:Record<string,Buffer>={};let remaining=maxBytes-derived.length;
 for(const item of captureMaterialManifest(report)){
  if(item.bytes>remaining)throw new Error('Converted capture byte limit exceeded');
  assets[item.path]=await readBoundedCaptureFile(join(folder,item.path),item.bytes);
  remaining-=item.bytes;
 }
 return snapshotCaptureMaterials(derived,report,assets,maxBytes);
}
async function writeSynced(path:string,bytes:Buffer):Promise<void>{
 const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
async function syncDirectory(path:string):Promise<void>{const file=await open(path,constants.O_RDONLY);try{await file.sync();}finally{await file.close();}}

/** Immutable retained bundles. Publication/reopen is serialized with project edits.
 * Multiple captures may belong to one revision; no capture silently becomes fit-ready.
 * This local API is not an authenticated network endpoint.
 */
export class CaptureStore {
 private readonly bound:ReturnType<typeof limits>;
 constructor(private readonly projects:FileSavedProjectStorage,private readonly directory:string,
 private readonly converter:CaptureConverter,options:CaptureLimits={}){this.bound=limits(options);}

 async importCapture(input:{projectId:string;projectRevision:number;source:Uint8Array;expectedProjectETag?:string},signal?:AbortSignal,authorizeCommit?:()=>Promise<void>):Promise<{captureId:string;binding:CaptureBinding}> {
  const {projectId,projectRevision}=requestSchema.parse(input);abort(signal);
  const expectedProjectETag=input.expectedProjectETag;
  if(expectedProjectETag!==undefined&&!/^"[a-f0-9]{64}"$/.test(expectedProjectETag))throw new Error('Invalid project snapshot ETag');
  if(!(input.source instanceof Uint8Array)||!input.source.byteLength||input.source.byteLength>this.bound.maxSourceBytes)throw new Error('Capture source byte limit exceeded');
  const original=Buffer.from(input.source); // Snapshot before any asynchronous operation.
  await this.projects.withCurrentProject(projectId,projectRevision,async()=>undefined,expectedProjectETag);
  await mkdir(this.directory,{recursive:true,mode:0o700});
  const staging=await mkdtemp(join(this.directory,'.staging-'));
  try {
   const converted=await this.converter.convert(Buffer.from(original),signal);abort(signal);
   if(!Buffer.isBuffer(converted.derived)||!Buffer.isBuffer(converted.report)||converted.derived.length>this.bound.maxDerivedBytes||converted.report.length>this.bound.maxReportBytes)throw new Error('Converted capture byte limit exceeded');
   const derived=Buffer.from(converted.derived),report=Buffer.from(converted.report);
   const capture=receiptFromConvertedBytes(original,derived,report);
   const assets=snapshotCaptureMaterials(derived,report,converted.assets,this.bound.maxDerivedBytes);
   const binding=CaptureBindingSchema.parse({projectId,projectRevision,capture});
   const bindingBytes=Buffer.from(JSON.stringify(binding)+'\n');
   if(bindingBytes.length>this.bound.maxReportBytes)throw new Error('Capture binding byte limit exceeded');
   for(const [name,bytes] of [['original.usdz',original],['mesh.obj',derived],['conversion.json',report],['binding.json',bindingBytes]] as const){abort(signal);await writeSynced(join(staging,name),bytes);}
   for(const [name,bytes] of Object.entries(assets)){abort(signal);await writeSynced(join(staging,name),bytes);}
   await syncDirectory(staging);
   const captureId=randomUUID();
   return await this.projects.withCurrentProject(projectId,projectRevision,async()=>{
    await authorizeCommit?.();abort(signal);
    // Atomic publication is the commit point. A later abort cannot undo a commit.
    await rename(staging,join(this.directory,captureId));
    await syncDirectory(this.directory);
    return {captureId,binding};
   },expectedProjectETag);
  } finally {await rm(staging,{recursive:true,force:true});}
 }

 private async readRetainedBundle(projectId:string,captureId:string) {
  const folder=join(this.directory,captureId);
  const original=await readBoundedCaptureFile(join(folder,'original.usdz'),this.bound.maxSourceBytes);
  const derived=await readBoundedCaptureFile(join(folder,'mesh.obj'),this.bound.maxDerivedBytes);
  const report=await readBoundedCaptureFile(join(folder,'conversion.json'),this.bound.maxReportBytes);
  const bindingBytes=await readBoundedCaptureFile(join(folder,'binding.json'),this.bound.maxReportBytes);
  const binding=CaptureBindingSchema.parse(JSON.parse(bindingBytes.toString('utf8')));
  if(binding.projectId!==projectId)throw new Error('Capture binding does not match the project');
  const capture=receiptFromConvertedBytes(original,derived,report);
  validateCaptureBinding(binding,{projectId,projectRevision:binding.projectRevision,original:capture.original,derived:capture.derived,conversionReport:capture.conversionReport});
  if(!isDeepStrictEqual(capture,binding.capture))throw new Error('Capture provenance does not match retained report');
  await readCaptureMaterials(folder,derived,report,this.bound.maxDerivedBytes);
  return {captureId,binding,original,derived,report};
 }

 async loadCapture(projectId:string,projectRevision:number,captureId:string,expectedProjectETag?:string) {
  requestSchema.parse({projectId,projectRevision});captureIdSchema.parse(captureId);
  return this.projects.withCurrentProject(projectId,projectRevision,async project=>{
   const bundle=await this.readRetainedBundle(projectId,captureId);
   if(bundle.binding.projectRevision!==projectRevision)throw new Error('Capture binding does not match the current project revision');
   return {...bundle,project};
  },expectedProjectETag);
 }

 /** Hash-verified bundle keyed by its retained binding, with no current-revision
  * gate. Cleanup jobs resolve the project revision at enqueue and must keep
  * working after later project edits, so they load captures this way.
  */
 async loadRetainedCapture(projectId:string,captureId:string) {
  z.object({projectId:requestSchema.shape.projectId}).parse({projectId});captureIdSchema.parse(captureId);
  return this.readRetainedBundle(projectId,captureId);
 }
}
