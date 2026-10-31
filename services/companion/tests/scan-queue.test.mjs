import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DetailStillStore} from '../dist/detail-stills.js';
import {fixture,fakeRunner,cleanupRunner,png,sha} from './fixtures/scan-processing.mjs';
const untilAbort=(gate,signal)=>signal?Promise.race([gate,new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});if(signal.aborted)reject(new Error('abort'));})]):gate;

test('a second distinct job queues instead of failing busy, then runs in order',async t=>{
 const order=[];let release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const runner={async run(stage,input,output,sidecar,signal){
  if(stage==='repair'){order.push(order.length?'second':'first');if(order.length===1){entered();await untilAbort(gate,signal);}}
  return fakeRunner.run(stage,input,output,sidecar,signal);
 }};
 t.after(()=>release());
 const f=await fixture(t,runner);
 const first=await f.store.start(f.input);await started;
 const second=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});
 assert.notEqual(second.job.jobId,first.job.jobId);
 assert.equal(second.job.status,'queued');
 assert.equal((await f.store.load(f.input,second.job.jobId)).job.status,'queued');
 release();await f.store.wait();
 assert.deepEqual(order,['first','second']);
 assert.equal((await f.store.load(f.input,first.job.jobId)).job.status,'succeeded');
 assert.equal((await f.store.load(f.input,second.job.jobId)).job.status,'succeeded');
});

test('retries dedupe by capture SHA-256 while in flight; explicit re-checks run fresh',async t=>{
 const f=await fixture(t);
 const first=await f.store.start(f.input);
 const retry=await f.store.start(f.input);
 assert.equal(retry.job.jobId,first.job.jobId);
 await f.store.wait();
 const saved=(await f.store.load(f.input,first.job.jobId)).job;
 assert.equal(saved.captureSha256,sha(Buffer.from('synthetic source')));
 assert.equal(saved.trigger,'request');
 // An automatic retry after success still resolves to the finished job...
 assert.equal((await f.store.enqueueForCapture('test',f.input.captureId)).job.jobId,first.job.jobId);
 // ...but an explicit request is a deliberate re-check and runs fresh, so a
 // tool fix or model change is never masked by the old result.
 const after=await f.store.start(f.input);
 assert.notEqual(after.job.jobId,first.job.jobId);await f.store.wait();
 assert.equal((await f.store.list(f.input)).jobs.length,2);
 // A different reference is a different request, not a retry.
 const other=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});
 assert.notEqual(other.job.jobId,first.job.jobId);await f.store.wait();
});

test('one unreadable retained record does not block new jobs for the capture',async t=>{
 const f=await fixture(t);
 const first=await f.store.enqueueForCapture('test',f.input.captureId);await f.store.wait();
 await writeFile(join(f.root,'captures',f.input.captureId,'scan-processing','99999999-9999-4999-8999-999999999999.json'),'not json');
 // Listings still fail closed on the damaged record...
 await assert.rejects(f.store.list(f.input),e=>e.code==='processing-unavailable');
 // ...but enqueue (dedupe) skips it and new work proceeds.
 const next=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[1,1,1]}}});
 await f.store.wait();
 assert.equal((await f.store.load(f.input,next.job.jobId)).job.status,'succeeded');
 assert.notEqual(next.job.jobId,first.job.jobId);
});

test('enqueue resolves the current revision; job reads keep working after later project edits',async t=>{
 const f=await fixture(t);
 const {job}=await f.store.enqueueForCapture('test',f.input.captureId);
 assert.equal(job.projectRevision,0);assert.equal(job.trigger,'capture-import');
 await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 // A later project edit bumps the revision; the retained job must stay readable.
 const changed=await f.projects.change('test',0,{kind:'replace-brief',brief:{object:'Renamed box',context:'Desk',addition:'Holder'}});
 assert.equal(changed.status,'ok');assert.equal(changed.project.revision,1);
 for(const revision of [0,1]){
  const input={...f.input,projectRevision:revision};
  assert.equal((await f.store.load(input,job.jobId)).job.status,'succeeded');
  assert.equal((await f.store.list(input)).jobs.length,1);
  assert.deepEqual((await f.store.artifact(input,job.jobId,'pos_x.png')).bytes,png);
 }
 // A new enqueue after the edit resolves revision 1 with no caller-supplied revision.
 const next=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[1,2,3]}}});
 assert.equal(next.job.projectRevision,1);await f.store.wait();
 assert.equal((await f.store.load({...f.input,projectRevision:1},next.job.jobId)).job.status,'succeeded');
});

test('jobs carry enqueue/start/finish and per-stage timestamps for estimates',async t=>{
 const f=await fixture(t,cleanupRunner());
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 await stills.addDetailStill({...f.input,source:png,label:'Synthetic port'});
 const {job}=await f.store.enqueueForCapture('test',f.input.captureId);
 await f.store.wait();
 const saved=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(saved.status,'succeeded');
 for(const key of ['enqueuedAt','startedAt','finishedAt'])assert.match(saved[key],/^\d{4}-\d{2}-\d{2}T/,key);
 assert(saved.enqueuedAt<=saved.startedAt&&saved.startedAt<=saved.finishedAt);
 let previous=saved.startedAt;
 for(const stage of saved.pipelineStages){
  assert.match(stage.startedAt,/^\d{4}-\d{2}-\d{2}T/,stage.kind);
  assert.match(stage.finishedAt,/^\d{4}-\d{2}-\d{2}T/,stage.kind);
  assert(previous<=stage.startedAt&&stage.startedAt<=stage.finishedAt,stage.kind);
  previous=stage.finishedAt;
 }
 for(const stage of saved.stages){assert.match(stage.startedAt,/T/,stage.kind);assert.match(stage.finishedAt,/T/,stage.kind);}
});

test('close-ups arriving after correction starts queue one follow-up; newest finished wins',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const first=await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 const added=await stills.addDetailStill({...f.input,source:png,label:'Late close-up'});
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId);
 assert(followUp);assert.notEqual(followUp.job.jobId,first.job.jobId);
 assert.equal(followUp.job.status,'queued');assert.equal(followUp.job.trigger,'detail-still');
 // A second late close-up coalesces into the already-queued follow-up.
 await stills.addDetailStill({...f.input,source:png,label:'Later close-up'});
 const again=await f.store.enqueueFollowUp('test',f.input.captureId);
 assert.equal(again.job.jobId,followUp.job.jobId);
 release();await f.store.wait();
 const firstDone=(await f.store.load(f.input,first.job.jobId)).job;
 const followDone=(await f.store.load(f.input,followUp.job.jobId)).job;
 assert.equal(firstDone.status,'succeeded');assert.equal(followDone.status,'succeeded');
 assert.deepEqual(firstDone.detailStills,[]);
 assert(followDone.detailStills.some(s=>s.id===added.still.id));
 assert(firstDone.finishedAt<followDone.finishedAt);
 // The cross-project index is newest-first: the follow-up leads.
 const mine=(await f.store.listJobIndex()).filter(entry=>entry.captureId===f.input.captureId);
 assert.deepEqual(mine.map(entry=>entry.jobId),[followUp.job.jobId,first.job.jobId]);
 assert(mine.every(entry=>entry.status==='succeeded'&&entry.captureSha256===firstDone.captureSha256));
});

test('the job index spans projects and survives a fresh store instance',async t=>{
 const f=await fixture(t);
 await f.projects.create({id:'second',brief:{object:'Cup',context:'Desk',addition:'Sleeve'}});
 const imported=await f.captures.importCapture({projectId:'second',projectRevision:0,source:Buffer.from('another synthetic source')});
 const a=await f.store.enqueueForCapture('test',f.input.captureId);
 const b=await f.store.enqueueForCapture('second',imported.captureId);
 await f.store.wait();
 const {ScanProcessingStore}=await import('../dist/scan-processing.js');
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);
 const index=await fresh.listJobIndex();
 assert.deepEqual(index.map(entry=>entry.jobId).sort(),[a.job.jobId,b.job.jobId].sort());
 const byProject=Object.fromEntries(index.map(entry=>[entry.projectId,entry]));
 assert.equal(byProject.test.captureId,f.input.captureId);
 assert.equal(byProject.second.captureId,imported.captureId);
 assert.notEqual(byProject.test.captureSha256,byProject.second.captureSha256);
 assert(index.every(entry=>entry.status==='succeeded'&&entry.enqueuedAt&&entry.finishedAt));
});

test('a follow-up correction inherits the reference that drives correction scaling',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const reference={dimensionsMm:[60,40,20]};
 const first=await f.store.start({...f.input,request:{reference}});
 await inCorrect;
 await stills.addDetailStill({...f.input,source:png,label:'Late'});
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId);
 assert.notEqual(followUp.job.jobId,first.job.jobId);
 assert.deepEqual(followUp.job.reference,reference);
 release();await f.store.wait();
 assert.deepEqual((await f.store.load(f.input,followUp.job.jobId)).job.reference,reference);
});

test('a follow-up coalesces into a waiting job whatever its reference',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 const waiting=await f.store.start({...f.input,request:{reference:{dimensionsMm:[1,2,3]}}});
 assert.equal(waiting.job.status,'queued');
 await stills.addDetailStill({...f.input,source:png,label:'Late'});
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId);
 assert.equal(followUp.job.jobId,waiting.job.jobId);
 release();await f.store.wait();
 assert.equal((await f.store.list(f.input)).jobs.length,2);
});

test('a follow-up is not absorbed by a waiting job with an explicit still selection',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 const explicit=await f.store.start({...f.input,request:{stillIds:[]}});
 assert.equal(explicit.job.status,'queued');
 const added=await stills.addDetailStill({...f.input,source:png,label:'Late'});
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId);
 assert.notEqual(followUp.job.jobId,explicit.job.jobId);
 release();await f.store.wait();
 assert.deepEqual((await f.store.load(f.input,explicit.job.jobId)).job.detailStills,[]);
 assert.deepEqual((await f.store.load(f.input,followUp.job.jobId)).job.detailStills.map(s=>s.id),[added.still.id]);
});

test('automatic jobs carry the originating authorization: revocation before publication fails the job',async t=>{
 const f=await fixture(t);let calls=0;
 const {job}=await f.store.enqueueForCapture('test',f.input.captureId,{authorize:async()=>{if(++calls>1)throw Error('revoked');}});
 await f.store.wait();
 const saved=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(saved.status,'failed');assert.equal(saved.failureStage,'publish');
});

test('live-job dedupe respects pipeline and adapter identity across store instances',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const first=await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 const other=cleanupRunner();other.cleanup.adapter='anthropic';
 const {ScanProcessingStore}=await import('../dist/scan-processing.js');
 const upgraded=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),other);t.after(()=>upgraded.close());
 const second=await upgraded.enqueueForCapture('test',f.input.captureId);
 assert.notEqual(second.job.jobId,first.job.jobId);
 assert.equal(second.job.correctionAdapter,'anthropic');assert.equal(second.job.status,'queued');
 release();await f.store.wait();
 assert.equal((await upgraded.load(f.input,second.job.jobId)).job.status,'succeeded');
});

test('a coalesced follow-up adopts the latest authorization for the waiting job',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const runner={async run(stage,input,output,sidecar,signal){
  if(stage==='repair'){entered();await untilAbort(gate,signal);}
  return fakeRunner.run(stage,input,output,sidecar,signal);
 }};
 t.after(()=>release());
 const f=await fixture(t,runner);
 await f.store.start(f.input);await started;
 let calls=0;
 const revoked=async()=>{if(++calls>1)throw Error('revoked');};
 const waiting=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[2,2,2]}},authorize:revoked});
 assert.equal(waiting.job.status,'queued');
 // The follow-up coalesces: publication must re-check the newest
 // authorization, not the revoked one captured at enqueue.
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId,async()=>undefined);
 assert.equal(followUp.job.jobId,waiting.job.jobId);
 release();await f.store.wait();
 assert.equal((await f.store.load(f.input,waiting.job.jobId)).job.status,'succeeded');
});

test('losing the index file rebuilds it from records on the next job, keeping history',async t=>{
 const f=await fixture(t);
 const a=await f.store.enqueueForCapture('test',f.input.captureId);await f.store.wait();
 await rm(join(f.root,'captures','scan-job-index.json'));
 const b=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[5,5,5]}}});await f.store.wait();
 const index=await f.store.listJobIndex();
 assert.deepEqual(index.map(entry=>entry.jobId),[b.job.jobId,a.job.jobId]);
});

test('a finished job from another correction adapter does not satisfy new requests',async t=>{
 const f=await fixture(t,cleanupRunner());
 const first=await f.store.enqueueForCapture('test',f.input.captureId);await f.store.wait();
 const other=cleanupRunner();other.cleanup.adapter='anthropic';
 const {ScanProcessingStore}=await import('../dist/scan-processing.js');
 const upgraded=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),other);t.after(()=>upgraded.close());
 const second=await upgraded.enqueueForCapture('test',f.input.captureId);
 assert.notEqual(second.job.jobId,first.job.jobId);
 assert.equal(second.job.correctionAdapter,'anthropic');await upgraded.wait();
});

test('a lock left by a finished job is reclaimed even when its pid is alive again',async t=>{
 const f=await fixture(t);
 const {job}=await f.store.start(f.input);await f.store.wait();
 const lock=join(f.root,'captures','.scan-processing-lock');
 await mkdir(lock);
 await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.ppid,jobId:job.jobId,projectId:'test',captureId:f.input.captureId}));
 const next=await f.store.start({...f.input,request:{reference:{dimensionsMm:[7,7,7]}}});
 await f.store.wait();
 assert.equal((await f.store.load(f.input,next.job.jobId)).job.status,'succeeded');
});

test('a failed index write is rebuilt from records by the next job update',async t=>{
 const f=await fixture(t);
 const indexPath=join(f.root,'captures','scan-job-index.json');
 await mkdir(indexPath); // rename onto a directory fails: the first index write cannot land
 const a=await f.store.enqueueForCapture('test',f.input.captureId);await f.store.wait();
 assert.equal((await f.store.load(f.input,a.job.jobId)).job.status,'succeeded');
 await rm(indexPath,{recursive:true});
 const b=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[6,6,6]}}});await f.store.wait();
 assert.deepEqual((await f.store.listJobIndex()).map(entry=>entry.jobId),[b.job.jobId,a.job.jobId]);
});

test('a follow-up is not absorbed by a waiting job from another adapter configuration',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 const waiting=await f.store.start({...f.input,request:{reference:{dimensionsMm:[3,3,3]}}});
 const other=cleanupRunner();other.cleanup.adapter='anthropic';
 const {ScanProcessingStore}=await import('../dist/scan-processing.js');
 const upgraded=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),other);t.after(()=>upgraded.close());
 await stills.addDetailStill({...f.input,source:png,label:'Late'});
 const followUp=await upgraded.enqueueFollowUp('test',f.input.captureId);
 assert.notEqual(followUp.job.jobId,waiting.job.jobId);
 assert.equal(followUp.job.correctionAdapter,'anthropic');
 release();await f.store.wait();
});

test('every job carries createdAtMs for newest-first ordering; earlier BE-2 records derive it',async t=>{
 const f=await fixture(t);
 const before=Date.now();
 const {job}=await f.store.enqueueForCapture('test',f.input.captureId);
 assert(Number.isInteger(job.createdAtMs)&&job.createdAtMs>=before&&job.createdAtMs<=Date.now());
 assert.equal(job.createdAtMs,Date.parse(job.enqueuedAt));
 await f.store.wait();
 const saved=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(saved.createdAtMs,job.createdAtMs);
 const [entry]=await f.store.listJobIndex();
 assert.equal(entry.createdAtMs,job.createdAtMs);
 // A record written before createdAtMs existed derives it from enqueuedAt on read.
 const path=join(f.root,'captures',f.input.captureId,'scan-processing',job.jobId+'.json');
 const {readFile}=await import('node:fs/promises');
 const record=JSON.parse(await readFile(path,'utf8'));delete record.createdAtMs;
 await writeFile(path,JSON.stringify(record));
 const {ScanProcessingStore}=await import('../dist/scan-processing.js');
 const fresh=new ScanProcessingStore(f.storage,f.captures,join(f.root,'captures'),fakeRunner);
 assert.equal((await fresh.load(f.input,job.jobId)).job.createdAtMs,job.createdAtMs);
 // The per-capture list keeps ascending job-id order for the current phone.
 const second=await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[4,4,4]}}});await f.store.wait();
 const listed=(await f.store.list(f.input)).jobs;
 assert.deepEqual(listed.map(j=>j.jobId),listed.map(j=>j.jobId).sort());
 assert.equal(Math.max(...listed.map(j=>j.createdAtMs)),second.job.createdAtMs);
});

test('an index rebuild racing job persistence never loses jobs from the index',async t=>{
 const f=await fixture(t);
 const expected=new Set();
 // Seed enough retained records that a rebuild scan takes a while, widening
 // the window in which an unserialized rebuild used to clobber newer entries.
 for(let seed=0;seed<20;seed++)
  expected.add((await f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[100+seed,2,3]}}})).job.jobId);
 await f.store.wait();
 for(let round=0;round<5;round++){
  await rm(join(f.root,'captures','scan-job-index.json'),{force:true});
  const [started]=await Promise.all([
   f.store.enqueueForCapture('test',f.input.captureId,{request:{reference:{dimensionsMm:[round+1,2,3]}}}),
   f.store.listJobIndex(),f.store.listJobIndex(),
  ]);
  expected.add(started.job.jobId);
  await f.store.wait();
  const index=await f.store.listJobIndex();
  assert.deepEqual(new Set(index.map(entry=>entry.jobId)),expected);
 }
});

test('a queued job can be cancelled before it starts and never runs',async t=>{
 let runs=0,release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const runner={async run(stage,input,output,sidecar,signal){
  if(stage==='repair'){runs++;if(runs===1){entered();await untilAbort(gate,signal);}}
  return fakeRunner.run(stage,input,output,sidecar,signal);
 }};
 t.after(()=>release());
 const f=await fixture(t,runner);
 const first=await f.store.start(f.input);await started;
 const queued=await f.store.start({...f.input,request:{reference:{dimensionsMm:[9,9,9]}}});
 const cancelled=await f.store.cancel(f.input,queued.job.jobId);
 assert.equal(cancelled.job.status,'failed');assert.equal(cancelled.job.failure,'cancelled');
 assert.match(cancelled.job.finishedAt,/T/);
 release();await f.store.wait();
 assert.equal(runs,1);
 assert.equal((await f.store.load(f.input,first.job.jobId)).job.status,'succeeded');
});

test('a request joins a running job only while its close-up snapshot is still the current selection',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const running=await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 // Same request, same (empty) close-up selection: the running job is this request's job.
 const same=await f.store.start(f.input);
 assert.equal(same.job.jobId,running.job.jobId);
 // A close-up added without a follow-up (say the follow-up was cancelled): the running job
 // snapshotted none, so an explicit request must queue a fresh job instead of joining it.
 await stills.addDetailStill({...f.input,source:png,label:'Close-up the running job never saw'});
 const fresh=await f.store.start(f.input);
 assert.notEqual(fresh.job.jobId,running.job.jobId);assert.equal(fresh.job.status,'queued');
 release();await f.store.wait();
 assert.equal((await f.store.load(f.input,fresh.job.jobId)).job.detailStills.length,1);
});

test('a late close-up never joins a queued job that a later explicit-selection job would supersede',async t=>{
 let release,entered;
 const gate=new Promise(r=>release=r),inCorrect=new Promise(r=>entered=r);
 const runner=cleanupRunner({correct:async ctx=>{entered();await untilAbort(gate,ctx.signal);}});
 t.after(()=>release());
 const f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const running=await f.store.enqueueForCapture('test',f.input.captureId);
 await inCorrect;
 // Queued behind it: an automatic-selection job, then an explicit "no close-ups" job.
 const automatic=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20],source:'Published dimensions'}}});
 const explicit=await f.store.start({...f.input,request:{stillIds:[]}});
 assert.notEqual(automatic.job.jobId,explicit.job.jobId);
 const added=await stills.addDetailStill({...f.input,source:png,label:'Late close-up'});
 const followUp=await f.store.enqueueFollowUp('test',f.input.captureId);
 // It must run after the explicit job, so the newest finished result includes the photo.
 assert(![running.job.jobId,automatic.job.jobId,explicit.job.jobId].includes(followUp.job.jobId));
 release();await f.store.wait();
 const done=(await f.store.load(f.input,followUp.job.jobId)).job;
 assert(done.detailStills.some(s=>s.id===added.still.id));
 assert((await f.store.load(f.input,explicit.job.jobId)).job.finishedAt<done.finishedAt);
});

test('a close-up deleted while a job snapshots stills is simply absent from that snapshot',async t=>{
 const f=await fixture(t,cleanupRunner());
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const kept=await stills.addDetailStill({...f.input,source:png,label:'Kept'});
 const gone=await stills.addDetailStill({...f.input,source:png,label:'Being deleted'});
 const folder=join(f.root,'captures',f.input.captureId,'detail-stills');
 // Mid-deletion: the image is already removed, the record not yet.
 await rm(join(folder,`${gone.still.id}.img`));
 const listed=await stills.listRetainedDetailStills('test',f.input.captureId);
 assert.deepEqual(listed.stills.map(s=>s.id),[kept.still.id]);
 // The phone's locked listing stays strict about the half-deleted folder.
 await assert.rejects(stills.listDetailStills('test',0,f.input.captureId),e=>e.code==='still-unavailable');
});
