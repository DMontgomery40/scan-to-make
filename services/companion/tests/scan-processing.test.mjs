import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {ScanProcessingStore} from '../dist/scan-processing.js';
import {fixture,fakeRunner,png} from './fixtures/scan-processing.mjs';
test('queued → all three stages → retained outputs and sorted reference errors; restart and tamper',async t=>{
 const f=await fixture(t);const {job}=await f.store.start({...f.input,request:{reference:{dimensionsMm:[21.7,60.6,45.2],source:'Published spec',productName:'Synthetic box'}}});
 assert.equal(job.status,'queued');await f.store.wait();
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);
 const saved=(await fresh.load(f.input,job.jobId)).job;assert.equal(saved.status,'succeeded');assert.equal(saved.previewOnly,true);assert.equal(Object.keys(saved.artifacts).length,13);
 assert.deepEqual(saved.stages.map(s=>s.status),['succeeded','succeeded','succeeded']);
 assert.deepEqual(saved.comparison.errorMm.map(x=>+x.toFixed(3)),[2.3,3.5,0]);
 assert.deepEqual((await fresh.artifact(f.input,job.jobId,'pos_x.png')).bytes,png);
 await writeFile(join(f.root,'captures',f.input.captureId,'scan-processing',job.jobId,'pos_x.png'),'corrupt');
 await assert.rejects(fresh.artifact(f.input,job.jobId,'pos_x.png'));
 // BE-2: the job pins the revision resolved at enqueue; reads do not re-check it.
 assert.equal((await fresh.load({...f.input,projectRevision:1},job.jobId)).job.status,'succeeded');
 await assert.rejects(fresh.load({...f.input,captureId:'bad'},job.jobId));
});
test('worker failure persists, incomplete artifacts never download',async t=>{
 const f=await fixture(t,{async run(){throw Error('private diagnostic');}});const {job}=await f.store.start(f.input);await f.store.wait();
 const saved=(await f.store.load(f.input,job.jobId)).job;assert.equal(saved.status,'failed');assert.equal(saved.failure,'processing-failed');assert(!JSON.stringify(saved).includes('private diagnostic'));
 await assert.rejects(f.store.artifact(f.input,job.jobId,'repaired.obj'));
});
test('single job, cancellation, deadline and shutdown await worker cleanup',async t=>{
 for(const mode of ['cancel','timeout','close']){
  let cleaned=false,entered;const started=new Promise(r=>entered=r);const f=await fixture(t,{async run(stage,input,output,sidecar,signal){entered();await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{cleaned=true;reject(Error('abort'));},{once:true});if(signal.aborted){cleaned=true;reject(Error('abort'));}});}},mode==='timeout'?1000:600000);
  const {job}=await f.store.start(f.input);await started;
  // BE-2: an identical retry dedupes onto the running job instead of failing busy.
  assert.equal((await f.store.start(f.input)).job.jobId,job.jobId);
  if(mode==='cancel')await f.store.cancel(f.input,job.jobId);else if(mode==='close')await f.store.close();else await f.store.wait();
  assert.equal((await f.store.load(f.input,job.jobId)).job.status,'failed');if(mode!=='close')assert(cleaned);
 }
});
test('invalid remote parameters and commit authorization fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(f.store.start({...f.input,request:{toolPath:'/evil'}}));await assert.rejects(f.store.start({...f.input,request:{reference:{dimensionsMm:[0,1,2]}}}));
 await assert.rejects(f.store.start(f.input,async()=>{throw Error('revoked');}));
 let auth=0;const {job}=await f.store.start(f.input,async()=>{if(++auth>1)throw Error('revoked');});await f.store.wait();assert.equal((await f.store.load(f.input,job.jobId)).job.status,'failed');
});
test('interrupted nonterminal record reopens failed and is never rerun',async t=>{
 const f=await fixture(t);const {job}=await f.store.start(f.input);await f.store.wait();
 const path=join(f.root,'captures',f.input.captureId,'scan-processing',job.jobId+'.json');
 const record=JSON.parse(await readFile(path,'utf8'));record.status='running';record.stages[2].status='running';delete record.artifacts;await writeFile(path,JSON.stringify(record));
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),{run(){throw Error('must not rerun');}});
 const saved=(await fresh.load(f.input,job.jobId)).job;assert.equal(saved.status,'failed');assert.equal(saved.failure,'interrupted');
});
test('a status poll holding the project lock during publication does not fail the job',async t=>{
 let f,held;
 const runner={async run(stage,input,output,sidecar,signal){
  const result=await fakeRunner.run(stage,input,output,sidecar,signal);
  // Hold the project lock across the moment publication starts, as a concurrent GET would.
  if(stage==='render')held=f.storage.withCurrentProject('test',0,()=>new Promise(r=>setTimeout(r,300)));
  return result;
 }};
 f=await fixture(t,runner);const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 await held;
});
test('a lock left by a dead owner is recovered; a live foreign owner leaves the job queued',async t=>{
 const f=await fixture(t);const lock=join(f.root,'captures','.scan-processing-lock');
 const child=spawn(process.execPath,['-e','']);const deadPid=await new Promise(r=>child.once('exit',()=>r(child.pid)));
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:deadPid,jobId:'00000000-0000-4000-8000-000000000000'}));
 const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.ppid,jobId:'00000000-0000-4000-8000-000000000000'}));
 // BE-2: the job queues behind the foreign owner instead of failing busy.
 const waiting=await f.store.start({...f.input,request:{reference:{dimensionsMm:[9,9,9]}}});
 await new Promise(r=>setTimeout(r,250));
 assert.equal((await f.store.load(f.input,waiting.job.jobId)).job.status,'queued');
 await rm(lock,{recursive:true,force:true});await f.store.wait();
 assert.equal((await f.store.load(f.input,waiting.job.jobId)).job.status,'succeeded');
});
test('concurrent identical starts across instances dedupe to exactly one worker',async t=>{
 let release;const gate=new Promise(r=>release=r);let runs=0;
 const runner={async run(stage,input,output,sidecar,signal){if(stage==='repair'){runs++;await gate;}return fakeRunner.run(stage,input,output,sidecar,signal);}};
 const f=await fixture(t,runner);const lock=join(f.root,'captures','.scan-processing-lock');
 const child=spawn(process.execPath,['-e','']);const deadPid=await new Promise(r=>child.once('exit',()=>r(child.pid)));
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:deadPid,jobId:'00000000-0000-4000-8000-000000000000'}));
 const other=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),runner);t.after(()=>other.close());
 try{
  const [a,b]=await Promise.all([f.store.start(f.input),other.start(f.input)]);
  assert.equal(a.job.jobId,b.job.jobId);
  // While it runs, a fresh instance dedupes onto the same live job.
  const third=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),runner);
  assert.equal((await third.start(f.input)).job.jobId,a.job.jobId);
 }finally{release();}
 await f.store.wait();await other.wait();assert.equal(runs,1);
});
test('a same-process start paused before launch serializes a second instance onto the same job',async t=>{
 const f=await fixture(t);let release,entered;const gate=new Promise(r=>release=r);const paused=new Promise(r=>entered=r);
 const first=f.store.start(f.input,async()=>{entered();await gate;});
 await paused;
 const other=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);t.after(()=>other.close());
 // The second enqueue waits for the first, then dedupes onto its job.
 let settled=false;const second=other.start(f.input).then(result=>{settled=true;return result;});
 await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);
 release();
 const {job}=await first;assert.equal((await second).job.jobId,job.jobId);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 // A failed start releases its registration for the next caller.
 await assert.rejects(f.store.start({...f.input,request:{reference:{dimensionsMm:[8,8,8]}}},async()=>{throw Error('revoked');}));
 const next=await other.start({...f.input,request:{reference:{dimensionsMm:[8,8,8]}}});await other.wait();assert.equal((await other.load(f.input,next.job.jobId)).job.status,'succeeded');
});
test('list returns every retained job for the capture so a finished check can reopen after relaunch',async t=>{
 const f=await fixture(t);
 assert.deepEqual((await f.store.list(f.input)).jobs,[]);
 const first=await f.store.start(f.input);await f.store.wait();
 // BE-2: an automatic re-enqueue dedupes onto the finished job; an explicit
 // re-check after success runs fresh, and a different reference is a third job.
 assert.equal((await f.store.enqueueForCapture('test',f.input.captureId)).job.jobId,first.job.jobId);
 const second=await f.store.start(f.input);await f.store.wait();
 assert.notEqual(second.job.jobId,first.job.jobId);
 const third=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});await f.store.wait();
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);
 const {jobs}=await fresh.list(f.input);
 assert.deepEqual(jobs.map(job=>job.jobId),[first.job.jobId,second.job.jobId,third.job.jobId].sort());
 assert(jobs.every(job=>job.status==='succeeded'));
 // Reads keep working with a stale caller revision after later edits.
 assert.equal((await fresh.list({...f.input,projectRevision:1})).jobs.length,3);
});
