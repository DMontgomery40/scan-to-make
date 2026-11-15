import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_CAPTURE_LIMITS,readBoundedCaptureFile,receiptFromConvertedBytes,readCaptureMaterials,type CaptureConverter} from './capture-import.js';

export interface CaptureConverterOptions {
 /** Trusted operator configuration; never accepted from an import request. */
 executable?:string; adapterPath?:string; temporaryRoot?:string; timeoutMs?:number;
}

/**
 * #852: the largest scan this computer reads for its mesh alone (`convertLocalScan`). Its own rebuild at full detail
 * is about 200 MB, nearly all textures and a displacement map (a 187 MB rig rebuild holds a 2.7 MB mesh of 100,000
 * triangles); the mesh written stays under the converter's usual 64 MiB.
 */
export const LOCAL_SCAN_MAX_BYTES=1024*1024*1024;

/** Why a conversion didn't give a mesh: `reason` is the converter's own words, for diagnostics beside the plain line. */
export class CaptureConversionError extends Error {
 constructor(message:string,readonly reason:string,readonly kind:'too-large'|'failed'|'timed-out'|'aborted'){super(reason?`${message}: ${reason}`:message);this.name='CaptureConversionError';}
}

/** A converter that can also read this computer's own scan in place, for its mesh alone. */
export interface LocalScanConverter extends CaptureConverter {
 /** The scan at `path` (this computer's own rebuild, never an upload) as its mesh alone, in its own frame. */
 convertLocalScan(path:string,signal?:AbortSignal):Promise<{derived:Buffer;report:Buffer;assets:Record<string,Buffer>}>;
}

export function createCaptureConverter(options:CaptureConverterOptions={}):LocalScanConverter {
 const executable=options.executable??'python3';
 const adapter=options.adapterPath??fileURLToPath(new URL('../python/capture_convert.py',import.meta.url));
 const root=options.temporaryRoot??tmpdir();
 const timeout=options.timeoutMs??60000;
 if(!isAbsolute(adapter)||!isAbsolute(root)||!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new Error('Invalid capture converter configuration');

 /** Runs the adapter; a failure keeps the end of what it said (its own reason) for the error, at most 1 KB. */
 async function run(args:string[],signal?:AbortSignal):Promise<void>{
  const child=spawn(executable,[adapter,...args,'--max-derived-bytes',String(DEFAULT_CAPTURE_LIMITS.maxDerivedBytes),'--timeout-ms',String(timeout)],
   {stdio:['ignore','pipe','pipe'],windowsHide:true});
  let expired=false,overflow=false,spawnFailed=false,total=0,said=Buffer.alloc(0);
  const kill=()=>{child.kill('SIGKILL');};
  const timer=setTimeout(()=>{expired=true;kill();},timeout);
  const drain=(bytes:Buffer)=>{total+=bytes.length;if(total>64*1024){overflow=true;kill();}};
  child.stdout.on('data',drain);
  child.stderr.on('data',(bytes:Buffer)=>{drain(bytes);said=Buffer.concat([said,bytes]).subarray(-1024);});
  const done=new Promise<number|null>(resolve=>{child.once('error',()=>{spawnFailed=true;});child.once('close',resolve);});
  signal?.addEventListener('abort',kill,{once:true});if(signal?.aborted)kill();
  try {
   const code=await done;
   if(signal?.aborted)throw new CaptureConversionError('Capture conversion aborted','', 'aborted');
   if(expired)throw new CaptureConversionError('Capture conversion timed out',`no mesh after ${Math.round(timeout/1000)} s`,'timed-out');
   const reason=spawnFailed?`${executable} could not be started`:overflow?'the converter said too much':
    code===4?'the scan has no authored unit, or features the converter does not export':
    said.toString('utf8').trim().split('\n').at(-1)?.replace(/^capture conversion rejected:\s*/,'').slice(0,300)??'';
   if(spawnFailed||overflow||code!==0)throw new CaptureConversionError('Capture conversion failed or was unqualified',reason,/byte limit|limit \d+/.test(reason)?'too-large':'failed');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',kill);}
 }

 return {async convert(source,signal){
  if(signal?.aborted)throw new Error('Capture conversion aborted');
  if(!Buffer.isBuffer(source)||!source.length||source.length>DEFAULT_CAPTURE_LIMITS.maxSourceBytes)
   throw new CaptureConversionError('Capture source byte limit exceeded',Buffer.isBuffer(source)&&source.length?`${megabytes(source.length)} MB, limit ${megabytes(DEFAULT_CAPTURE_LIMITS.maxSourceBytes)} MB`:'empty','too-large');
  const original=Buffer.from(source);
  await mkdir(root,{recursive:true,mode:0o700});
  const folder=await mkdtemp(join(root,'capture-conversion-'));
  try {
   const input=join(folder,'original.usdz'),out=join(folder,'mesh.obj'),report=join(folder,'conversion.json');
   await writeFile(input,original,{flag:'wx',mode:0o600});
   if(signal?.aborted)throw new Error('Capture conversion aborted');
   await run(['--source',input,'--out',out,'--report',report,'--max-source-bytes',String(DEFAULT_CAPTURE_LIMITS.maxSourceBytes)],signal);
   const derived=await readBoundedCaptureFile(out,DEFAULT_CAPTURE_LIMITS.maxDerivedBytes);
   const reportBytes=await readBoundedCaptureFile(report,DEFAULT_CAPTURE_LIMITS.maxReportBytes);
   receiptFromConvertedBytes(original,derived,reportBytes);
   const assets=await readCaptureMaterials(folder,derived,reportBytes);
   return {derived,report:reportBytes,assets};
  } finally {await rm(folder,{recursive:true,force:true});}
 },
 async convertLocalScan(path,signal){
  if(signal?.aborted)throw new Error('Capture conversion aborted');
  if(!isAbsolute(path))throw new Error('Invalid capture path');
  const size=(await stat(path)).size;
  if(!size||size>LOCAL_SCAN_MAX_BYTES)
   throw new CaptureConversionError('Capture source byte limit exceeded',`${megabytes(size)} MB, limit ${megabytes(LOCAL_SCAN_MAX_BYTES)} MB`,'too-large');
  await mkdir(root,{recursive:true,mode:0o700});
  const folder=await mkdtemp(join(root,'capture-conversion-'));
  try {
   // Read in place: the companion's own file, never an upload, and never copied whole into this process.
   const out=join(folder,'mesh.obj'),report=join(folder,'conversion.json');
   await run(['--source',path,'--out',out,'--report',report,'--max-source-bytes',String(LOCAL_SCAN_MAX_BYTES),'--geometry-only'],signal);
   const derived=await readBoundedCaptureFile(out,DEFAULT_CAPTURE_LIMITS.maxDerivedBytes);
   const reportBytes=await readBoundedCaptureFile(report,DEFAULT_CAPTURE_LIMITS.maxReportBytes);
   const parsed=JSON.parse(reportBytes.toString('utf8')) as {geometryOnly?:unknown;source?:{bytes?:unknown}};
   if(parsed.geometryOnly!==true||parsed.source?.bytes!==size)throw new CaptureConversionError('Capture conversion failed or was unqualified','the report does not match the scan','failed');
   return {derived,report:reportBytes,assets:{}};
  } finally {await rm(folder,{recursive:true,force:true});}
 }};
}

function megabytes(bytes:number):number{return Math.round(bytes/1024/1024*10)/10;}

/**
 * A scan this computer keeps, as a mesh a design reads (#852): converted whole, materials and textures included, up to
 * the converter's usual limit; above it (a Mac or Linux rebuild at full detail), its mesh alone, read in place. Both
 * give the same triangles in the same frame, which the report names (`metersPerUnit`, `upAxis`).
 */
export async function convertScanMesh(converter:LocalScanConverter,path:string,signal?:AbortSignal):Promise<{derived:Buffer;report:Buffer;assets:Record<string,Buffer>;geometryOnly:boolean}>{
 const size=(await stat(path)).size;
 if(size<=DEFAULT_CAPTURE_LIMITS.maxSourceBytes){
  const converted=await converter.convert(await readFile(path),signal);
  return {...converted,assets:converted.assets??{},geometryOnly:false};
 }
 return {...await converter.convertLocalScan(path,signal),geometryOnly:true};
}
