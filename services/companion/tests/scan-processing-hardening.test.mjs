import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {ScanProcessingStore} from '../dist/scan-processing.js';
import {acquireInstanceLock} from '../dist/instance-lock.js';
import {CaptureStore} from '../dist/capture-import.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startGenerationServer} from '../dist/generation.js';
import {fixture,fakeRunner} from './fixtures/scan-processing.mjs';

const deadOwnerPid=async()=>{const child=spawn(process.execPath,['-e','']);return new Promise(r=>child.once('exit',()=>r(child.pid)));};
const sleeper=()=>spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});
const orphanGroup=()=>{
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});
 const exited=new Promise(r=>child.once('exit',r));
 return {child,exited,pgid:child.pid};
};
async function eventually(check,label){
 for(let n=0;n<200;n++){if(await check())return;await new Promise(r=>setTimeout(r,10));}
 assert.fail(`timed out: ${label}`);
}

test('instance lock admits one holder, reclaims a dead owner, and release only removes its own lock',async t=>{
 const root=await mkdtemp(join(tmpdir(),'instance-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await acquireInstanceLock(root);
 await assert.rejects(acquireInstanceLock(root),e=>e.code==='instance-busy');
 await first.release();
 const again=await acquireInstanceLock(root);
 // A release whose token no longer matches must not remove a foreign lock.
 const lock=join(root,'.companion-instance-lock');
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:randomUUID()}));
 await again.release();
 await readFile(join(lock,'owner.json'),'utf8');
 await rm(lock,{recursive:true,force:true});
 // Dead owner: reclaim succeeds. Live owner: stays busy.
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:await deadOwnerPid(),token:randomUUID()}));
 const reclaimed=await acquireInstanceLock(root);await reclaimed.release();
 const live=sleeper();t.after(()=>live.kill('SIGKILL'));
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:live.pid,token:randomUUID()}));
 await assert.rejects(acquireInstanceLock(root),e=>e.code==='instance-busy');
});

test('a second listener on the same capture directory fails to start until the first closes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'instance-server-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const remoteAuth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const storage=new FileSavedProjectStorage(join(root,'projects'));
 const converter={convert:async()=>{throw new Error('unused');}};
 const captures=new CaptureStore(storage,join(root,'captures'),converter);
 const services=()=>({storage,captures,scanProcessing:new ScanProcessingStore(storage,captures,join(root,'captures'),fakeRunner)});
 const first=await startGenerationServer({port:0,remoteAuth,capture:services()});
 try{
  await assert.rejects(startGenerationServer({port:0,remoteAuth,capture:services()}),e=>e.code==='instance-busy');
 }finally{await first.close();}
 const second=await startGenerationServer({port:0,remoteAuth,capture:services()});
 await second.close();
});

test('cancellation from another same-process instance reaches the owning instance',async t=>{
 let entered;const started=new Promise(r=>entered=r);let cleaned=false;
 const runner={async run(stage,input,output,sidecar,signal){
  if(stage!=='repair')return fakeRunner.run(stage,input,output,sidecar,signal);
  entered();
  await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{cleaned=true;reject(new Error('abort'));},{once:true});});
 }};
 const f=await fixture(t,runner);
 const {job}=await f.store.start(f.input);await started;
 const other=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),runner);t.after(()=>other.close());
 const cancelled=(await other.cancel(f.input,job.jobId)).job;
 assert.equal(cancelled.status,'failed');assert.equal(cancelled.failure,'cancelled');assert(cleaned);
 await f.store.wait();
});

test('the worker process group reported by the runner is recorded in the job lock',async t=>{
 let release;const gate=new Promise(r=>release=r);
 const runner={async run(stage,input,output,sidecar,signal,onProcessGroup){
  if(stage==='repair'){onProcessGroup?.(424242);await gate;}
  return fakeRunner.run(stage,input,output,sidecar,signal);
 }};
 const f=await fixture(t,runner);
 try{
  const {job}=await f.store.start(f.input);
  const ownerPath=join(f.root,'captures','.scan-processing-lock','owner.json');
  await eventually(async()=>{
   try{const owner=JSON.parse(await readFile(ownerPath,'utf8'));return owner.jobId===job.jobId&&owner.pgid===424242;}catch{return false;}
  },'pgid recorded in lock owner');
 }finally{release();}
 await f.store.wait();
});

test('recovering a dead owner lock terminates its recorded orphaned worker group first',async t=>{
 const f=await fixture(t);
 const orphan=orphanGroup();t.after(()=>{try{process.kill(-orphan.pgid,'SIGKILL');}catch{ /* already gone */ }});
 const lock=join(f.root,'captures','.scan-processing-lock');
 await mkdir(lock);
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:await deadOwnerPid(),jobId:randomUUID(),pgid:orphan.pgid}));
 const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 await Promise.race([orphan.exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('orphan survived')),3000))]);
});

test('loading an interrupted job reaps its recorded orphaned worker group',async t=>{
 const f=await fixture(t);const {job}=await f.store.start(f.input);await f.store.wait();
 const path=join(f.root,'captures',f.input.captureId,'scan-processing',job.jobId+'.json');
 const record=JSON.parse(await readFile(path,'utf8'));record.status='running';record.stages[0].status='running';delete record.artifacts;await writeFile(path,JSON.stringify(record));
 const orphan=orphanGroup();t.after(()=>{try{process.kill(-orphan.pgid,'SIGKILL');}catch{ /* already gone */ }});
 const lock=join(f.root,'captures','.scan-processing-lock');
 await mkdir(lock);
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:await deadOwnerPid(),jobId:job.jobId,pgid:orphan.pgid}));
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);
 const saved=(await fresh.load(f.input,job.jobId)).job;
 assert.equal(saved.status,'failed');assert.equal(saved.failure,'interrupted');
 await Promise.race([orphan.exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('orphan survived')),3000))]);
});
