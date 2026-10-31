import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ScanModelAssetsSchema,type ScanModelAssets} from '@scan-to-make/contracts/scan-processing';
import {meshTextLines} from './mesh-materials.js';
import {readBoundedCaptureFile} from './capture-import.js';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const materialName=/^mesh(?:\.mtl|_(?:basecolor|normal)_[0-9]+\.png)$/;
const limit=64*1024*1024;

/** Final chosen results may have normal maps/PBR values. Capture import keeps
 * its narrower converter grammar. Every final reference is still a retained,
 * hash-checked canonical basename; no arbitrary MTL asset path is imported. */
export async function readScanMaterials(folder:string,obj:Buffer,hashes:Record<string,unknown>={}){
 const assets:Record<string,Buffer>={};
 const entries=Object.entries(hashes).filter(([name])=>materialName.test(name));
 if(entries.length>255)throw Error('Too many scan material assets');
 let remaining=limit-obj.length;
 for(const [name,digest] of entries){
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid scan material identity');
  const bytes=await readBoundedCaptureFile(join(folder,name),Math.max(0,remaining));remaining-=bytes.length;
  if(!bytes.length||sha(bytes)!==digest||name.endsWith('.png')&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Scan material identity mismatch');
  assets[name]=bytes;
 }
 const lines=function*(bytes:Buffer){
  new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  for(const raw of meshTextLines(bytes)){const line=raw.split('#')[0]!.trim();if(line)yield line;}
 };
 const used=new Set<string>(),declared=new Set<string>();
 for(const line of lines(obj)){
  const fields=line.split(/\s+/);
  if(fields[0]==='mtllib'&&(fields.length!==2||fields[1]!=='mesh.mtl'||!assets['mesh.mtl']))throw Error('Missing referenced material library');
  if(fields[0]==='usemtl'){
   if(fields.length!==2)throw Error('Invalid material binding');
   used.add(fields[1]!);
  }
 }
 for(const line of lines(assets['mesh.mtl']??Buffer.alloc(0))){
  const [directive,...values]=line.split(/\s+/);
  if(directive==='newmtl'&&values.length===1&&/^[A-Za-z0-9_.-]+$/.test(values[0]!)){
   if(declared.has(values[0]!))throw Error('Duplicate material name');
   declared.add(values[0]!);continue;
  }
  const count=['Kd','Ka','Ks','Ke','Tf'].includes(directive!)?3:
   ['Ns','Ni','d','Tr','illum','Pr','Pm','Ps','Pc','Pcr','aniso','anisor'].includes(directive!)?1:0;
  if(count&&values.length===count&&values.every(v=>v.trim()!==''&&Number.isFinite(Number(v))))continue;
  const kind=directive==='map_Kd'?'basecolor':['map_Bump','bump','norm'].includes(directive!)?'normal':undefined;
  const file=values.at(-1),opts=values.slice(0,-1);
  const validOptions=opts.length===0||opts.length===2&&(
   opts[0]==='-clamp'&&['on','off'].includes(opts[1]!)||kind==='normal'&&opts[0]==='-bm'&&Number.isFinite(Number(opts[1])));
  if(!kind||!file||!validOptions||!new RegExp(`^mesh_${kind}_[0-9]+\\.png$`).test(file)||!assets[file])throw Error('Unsupported or missing material texture');
 }
 for(const name of used)if(name!=='unbound'&&!declared.has(name))throw Error('Missing referenced material');
 return assets;
}

export function scanModelManifest(jobId:string,obj:Buffer,materials:Record<string,Buffer>):ScanModelAssets{
 return ScanModelAssetsSchema.parse({schema:'scan-to-make.scan-model/0.1',jobId,entrypoint:'repaired.obj',files:Object.entries({'repaired.obj':obj,...materials}).map(([name,bytes])=>({name,sha256:sha(bytes),byteLength:bytes.length,mediaType:name.endsWith('.obj')?'model/obj':name.endsWith('.mtl')?'text/plain':'image/png'}))});
}
