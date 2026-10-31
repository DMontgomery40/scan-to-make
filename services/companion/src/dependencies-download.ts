import {createHash} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {lstat,open,rename,rm} from 'node:fs/promises';

export interface DownloadArtifact {url:string;integrity:string;maxBytes:number}
async function size(path:string){
 try {const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())throw Error('Invalid download file');return s.size;}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;}
}
async function verified(path:string,artifact:DownloadArtifact){
 const match=/^(sha256|sha512)-([A-Za-z0-9+/]+=*)$/.exec(artifact.integrity);
 if(!match)throw Error('Invalid artifact integrity');
 if(!await size(path))return false;
 const hash=createHash(match[1]!);for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('base64')===match[2];
}
/** Keep interrupted bytes, but publish only an entirely verified archive. Caller serializes each path. */
export async function downloadArtifact(artifact:DownloadArtifact,path:string,options:{signal?:AbortSignal;onProgress?:(bytes:number,total?:number)=>void}={}):Promise<void>{
 const partial=path+'.part';
 options.signal?.throwIfAborted();
 if(await size(path)>artifact.maxBytes)await rm(path);
 if(await verified(path,artifact)){const n=await size(path);options.onProgress?.(n,n);return;}
 await rm(path,{force:true});
 let offset=await size(partial);
 if(offset>artifact.maxBytes){await rm(partial);offset=0;}
 if(offset&&await verified(partial,artifact)){await rename(partial,path);options.onProgress?.(offset,offset);return;}
 const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(30*60*1000)]);
 let response=await fetch(artifact.url,{signal,headers:{'Accept-Encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})}});
 // A stale partial can exceed the current object. A single clean restart is safe;
 // the full pin still decides whether any returned bytes may be used.
 if(response.status===416&&offset){await response.body?.cancel();await rm(partial);offset=0;response=await fetch(artifact.url,{signal,headers:{'Accept-Encoding':'identity'}});}
 let total:number|undefined;
 try{
  if(response.status===206){
   const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')??'');
   if(!range||Number(range[1])!==offset||Number(range[2])!==Number(range[3])-1)throw Error('Invalid download range');
   total=Number(range[3]);
  }else if(response.status===200){offset=0;const length=response.headers.get('content-length');if(length!==null)total=Number(length);}
  else throw Error('Download request failed');
  if(response.headers.get('content-encoding')&&!['identity'].includes(response.headers.get('content-encoding')!))throw Error('Invalid download encoding');
  if(total!==undefined&&(!Number.isSafeInteger(total)||total<offset||total>artifact.maxBytes)){await rm(partial,{force:true});throw Error('Download size limit');}
  if(!response.body)throw Error('Download body missing');
  const file=await open(partial,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(offset?constants.O_APPEND:constants.O_TRUNC),0o600);
  let received=offset;
  try{
   options.onProgress?.(received,total);
   for await(const value of response.body){
    signal.throwIfAborted();received+=value.byteLength;
    if(received>artifact.maxBytes||(total!==undefined&&received>total))throw Error('Download size limit');
    // FileHandle.write may write fewer bytes than requested.
    let written=0;while(written<value.byteLength){const n=await file.write(value,written,value.byteLength-written);if(!n.bytesWritten)throw Error('Download write failed');written+=n.bytesWritten;}
    options.onProgress?.(received,total);
   }
   if(total!==undefined&&received!==total)throw Error('Download incomplete');
   await file.sync();
  }catch(e){if(e instanceof Error&&e.message==='Download size limit')await rm(partial,{force:true});throw e;}
  finally{await file.close();}
  if(!await verified(partial,artifact)){await rm(partial,{force:true});throw Error('Download integrity mismatch');}
  signal.throwIfAborted();await rename(partial,path);options.onProgress?.(received,received);
 }finally{if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});}
}
