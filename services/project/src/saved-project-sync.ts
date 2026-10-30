import {createHash} from 'node:crypto';
import type {FileSavedProjectStorage} from './saved-project-storage.js';
import {SavedProjectSchema,type SavedProject} from '@scan-to-make/contracts/saved-project';

export const MAX_SAVED_PROJECT_SYNC_BYTES=4*1024*1024;
export function savedProjectETag(bytes:string):string {
 return '"'+createHash('sha256').update(bytes,'utf8').digest('hex')+'"';
}
export class SavedProjectSyncFailure extends Error {
 constructor(readonly code:'invalid-snapshot'|'invalid-precondition'|'precondition-required'|'precondition-failed'|'revision-conflict'|'not-found'|'storage-unavailable',message:string=code) {super(message);}
}
export interface SavedProjectSnapshot {bytes:string;project:SavedProject;etag:string}
function snapshot(id:string,bytes:string):SavedProjectSnapshot {
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)||typeof bytes!=='string'||Buffer.byteLength(bytes)>MAX_SAVED_PROJECT_SYNC_BYTES||Buffer.from(bytes).toString('utf8')!==bytes)throw new SavedProjectSyncFailure('invalid-snapshot');
 try {
  const project=SavedProjectSchema.parse(JSON.parse(bytes));
  if(project.id!==id)throw new Error('Snapshot identity mismatch');
  return {bytes,project,etag:savedProjectETag(bytes)};
 } catch {throw new SavedProjectSyncFailure('invalid-snapshot');}
}

/** Conditional replication of exact portable 0.2 snapshots, not fit-artifact attestation.
 * The native author remains responsible for valid change/acceptance transitions.
 * This API never marks capture bytes as accepted geometry.
 */
export class SavedProjectSync {
 constructor(private readonly storage:FileSavedProjectStorage){}
 private async current(id:string):Promise<SavedProjectSnapshot|null> {
  try {const bytes=await this.storage.read(id);return bytes===null?null:snapshot(id,bytes);}
  catch {throw new SavedProjectSyncFailure('storage-unavailable');}
 }
 async get(id:string):Promise<SavedProjectSnapshot> {
  const current=await this.current(id);if(!current)throw new SavedProjectSyncFailure('not-found');return current;
 }
 async put(id:string,bytes:string,condition:{ifMatch?:string;ifNoneMatch?:string},beforeCommit?:()=>Promise<void>):Promise<SavedProjectSnapshot> {
  const next=snapshot(id,bytes);
  if(condition.ifMatch===undefined&&condition.ifNoneMatch===undefined)throw new SavedProjectSyncFailure('precondition-required');
  const create=condition.ifNoneMatch==='*'&&condition.ifMatch===undefined;
  const update=condition.ifNoneMatch===undefined&&typeof condition.ifMatch==='string'&&/^"[a-f0-9]{64}"$/.test(condition.ifMatch);
  if(!create&&!update)throw new SavedProjectSyncFailure('invalid-precondition');
  const current=await this.current(id);
  if(create?current!==null:current===null||current.etag!==condition.ifMatch)throw new SavedProjectSyncFailure('precondition-failed');
  if(current&&(next.project.revision<current.project.revision||(next.project.revision===current.project.revision&&next.bytes!==current.bytes)))throw new SavedProjectSyncFailure('revision-conflict');
  // Even an equal snapshot uses CAS so a concurrent edit cannot be acknowledged as current.
  let saved:boolean;let guardFailed=false,guardError:unknown;
  try {saved=await this.storage.compareAndSwap(id,current?.bytes??null,next.bytes,async()=>{
   try {await beforeCommit?.();}catch(error){guardFailed=true;guardError=error;throw error;}
  });}
  catch {if(guardFailed)throw guardError;throw new SavedProjectSyncFailure('storage-unavailable');}
  if(!saved)throw new SavedProjectSyncFailure('precondition-failed');
  return next;
 }
}
