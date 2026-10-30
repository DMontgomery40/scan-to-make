import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';

const OwnerSchema=z.object({pid:z.number().int().positive(),token:z.uuid()});
type Owner=z.infer<typeof OwnerSchema>;
// Directories already claimed by this process, so a second in-process
// listener fails even if the on-disk lock was removed externally.
const held=new Set<string>();

export class InstanceLockFailure extends Error {
 readonly code='instance-busy' as const;
 constructor(){super('Another companion instance is already using this capture directory');}
}
async function write(path:string,bytes:Buffer){const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
async function readOwner(lock:string):Promise<Owner|undefined>{
 try{
  const bytes=await readFile(join(lock,'owner.json'));
  if(bytes.length>1024)return undefined;
  return OwnerSchema.parse(JSON.parse(bytes.toString('utf8')));
 }catch{return undefined;}
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM';}}
/** A lock with no readable owner is only stale once it is clearly not being created right now. */
async function stale(lock:string,owner:Owner|undefined){
 if(owner)return !alive(owner.pid);
 try{return Date.now()-(await stat(lock)).mtimeMs>60000;}catch{return false;}
}
/**
 * Claim exclusive use of a capture directory for one companion process.
 * A live owner (this or another process) rejects with `instance-busy`; a
 * dead owner's lock is reclaimed under a recovery guard so concurrent
 * starters cannot both win. Release removes the lock only while it is
 * still ours.
 */
export async function acquireInstanceLock(directory:string):Promise<{release():Promise<void>}>{
 const key=resolve(directory);
 if(held.has(key))throw new InstanceLockFailure();
 await mkdir(directory,{recursive:true,mode:0o700});
 const lock=join(directory,'.companion-instance-lock'),token=randomUUID();
 const claim=async()=>{await mkdir(lock,{mode:0o700});await write(join(lock,'owner.json'),Buffer.from(JSON.stringify({pid:process.pid,token})));};
 try{await claim();}catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  const guard=`${lock}.recover`;
  try{await mkdir(guard,{mode:0o700});}catch(guardError){
   if((guardError as NodeJS.ErrnoException).code!=='EEXIST')throw guardError;
   let abandoned=false;try{abandoned=Date.now()-(await stat(guard)).mtimeMs>60000;}catch{ /* vanished */ }
   if(!abandoned)throw new InstanceLockFailure();
   await rm(guard,{recursive:true,force:true});
   try{await mkdir(guard,{mode:0o700});}catch(again){if((again as NodeJS.ErrnoException).code==='EEXIST')throw new InstanceLockFailure();throw again;}
  }
  try{
   if(!(await stale(lock,await readOwner(lock))))throw new InstanceLockFailure();
   await rm(lock,{recursive:true,force:true});
   await claim();
  }finally{await rm(guard,{recursive:true,force:true});}
 }
 held.add(key);
 let released=false;
 return {async release(){
  if(released)return;released=true;held.delete(key);
  const owner=await readOwner(lock);
  if(owner?.token===token)await rm(lock,{recursive:true,force:true});
 }};
}
