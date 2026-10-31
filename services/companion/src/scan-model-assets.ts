import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {ScanModelAssetsSchema,type ScanModelAssets} from '@scan-to-make/contracts/scan-processing';
import {readBoundedCaptureFile,snapshotCaptureMaterials} from './capture-import.js';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const materialName=/^mesh(?:\.mtl|_basecolor_[0-9]+\.png)$/;
const limit=64*1024*1024;

/** Reuse the converter's closed material grammar; neither output paths nor MTL
 * references can introduce files outside the canonical retained capture bundle. */
export async function readScanMaterials(folder:string,obj:Buffer,hashes:Record<string,unknown>={}){
 const assets:Record<string,Buffer>={},outputs:{path:string;bytes:number;sha256:string}[]=[];
 const entries=Object.entries(hashes).filter(([name])=>materialName.test(name));
 if(entries.length>255)throw Error('Too many scan material assets');
 let remaining=limit-obj.length;
 for(const [name,digest] of entries){
  if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid scan material identity');
  const bytes=await readBoundedCaptureFile(join(folder,name),Math.max(0,remaining));remaining-=bytes.length;
  if(!bytes.length||sha(bytes)!==digest||name.endsWith('.png')&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Scan material identity mismatch');
  assets[name]=bytes;outputs.push({path:name,bytes:bytes.length,sha256:digest});
 }
 return snapshotCaptureMaterials(obj,Buffer.from(JSON.stringify({outputs})),assets,limit);
}

export function scanModelManifest(jobId:string,obj:Buffer,materials:Record<string,Buffer>):ScanModelAssets{
 return ScanModelAssetsSchema.parse({schema:'scan-to-make.scan-model/0.1',jobId,entrypoint:'repaired.obj',files:Object.entries({'repaired.obj':obj,...materials}).map(([name,bytes])=>({name,sha256:sha(bytes),byteLength:bytes.length,mediaType:name.endsWith('.obj')?'model/obj':name.endsWith('.mtl')?'text/plain':'image/png'}))});
}
