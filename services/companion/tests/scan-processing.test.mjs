import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
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
 await assert.rejects(fresh.load({...f.input,projectRevision:1},job.jobId));
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
  const {job}=await f.store.start(f.input);await started;await assert.rejects(f.store.start(f.input),e=>e.code==='busy');
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
 let f;
 const runner={async run(stage,input,output,sidecar,signal){
  const result=await fakeRunner.run(stage,input,output,sidecar,signal);
  // Hold the project lock across the moment publication starts, as a concurrent GET would.
  if(stage==='render')void f.storage.withCurrentProject('test',0,()=>new Promise(r=>setTimeout(r,300)));
  return result;
 }};
 f=await fixture(t,runner);const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
});
test('a lock left by a dead owner is recovered; a live owner keeps processing busy',async t=>{
 const f=await fixture(t);const lock=join(f.root,'captures','.scan-processing-lock');
 const child=spawn(process.execPath,['-e','']);const deadPid=await new Promise(r=>child.once('exit',()=>r(child.pid)));
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:deadPid,jobId:'00000000-0000-4000-8000-000000000000'}));
 const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.ppid,jobId:'00000000-0000-4000-8000-000000000000'}));
 await assert.rejects(f.store.start(f.input),e=>e.code==='busy');
});
test('concurrent recoverers of one dead-owner lock start exactly one worker; a second instance never steals a live lock',async t=>{
 let release;const gate=new Promise(r=>release=r);let runs=0;
 const runner={async run(stage,input,output,sidecar,signal){if(stage==='repair'){runs++;await gate;}return fakeRunner.run(stage,input,output,sidecar,signal);}};
 const f=await fixture(t,runner);const lock=join(f.root,'captures','.scan-processing-lock');
 const child=spawn(process.execPath,['-e','']);const deadPid=await new Promise(r=>child.once('exit',()=>r(child.pid)));
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:deadPid,jobId:'00000000-0000-4000-8000-000000000000'}));
 const other=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),runner);t.after(()=>other.close());
 try{
  const results=await Promise.allSettled([f.store.start(f.input),other.start(f.input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'busy');
  // While the winner runs, a fresh instance in the same process must see its lock as live.
  const third=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),runner);
  await assert.rejects(third.start(f.input),e=>e.code==='busy');
 }finally{release();}
 await f.store.wait();await other.wait();assert.equal(runs,1);
});
