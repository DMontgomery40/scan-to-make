import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore} from '../dist/prepared-jobs.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url),'utf8'));
const brief={object:'Cup',context:'Console',addition:'Holder insert'};
const designBytes=Buffer.from('synthetic accepted design bytes, isolated fixture only');
const designRef={sha256:sha(designBytes),mediaType:'model/stl',byteLength:designBytes.length};
const printable=Buffer.from('synthetic prepared printable bytes, not a real 3mf');
const printableRef={sha256:sha(printable),mediaType:'model/3mf',byteLength:printable.length};
const selection={printerId:'fixture-printer',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',
 materials:[{projectSlot:0,material:'PLA',physicalTray:254}],slicerSettingsSha256:'a'.repeat(64)};
const REVISION=2; // create(0) -> attach-preview(1) -> accept-preview(2)

async function accepted(t,now=()=>1800000000000){
 const root=await mkdtemp(join(tmpdir(),'prepared-jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects'));
 const projects=createSavedProjects(storage);
 assert.equal((await projects.create({id:fit.id,brief,fit})).status,'ok');
 const binding={sourceFit:fit,artifact:designRef};
 assert.equal((await projects.change(fit.id,0,{kind:'attach-preview',...binding})).status,'ok');
 assert.equal((await projects.change(fit.id,1,{kind:'accept-preview',...binding})).status,'ok');
 const jobs=new PreparedJobStore(storage,join(root,'prepared'),{clock:now});
 return {root,storage,projects,jobs,fresh:()=>new PreparedJobStore(new FileSavedProjectStorage(join(root,'projects')),join(root,'prepared'),{clock:now})};
}
const request=()=>({projectId:fit.id,projectRevision:REVISION,printable:Buffer.from(printable),printableArtifact:structuredClone(printableRef),selection:structuredClone(selection)});
const approval=(job,now=1800000000000)=>({jobSha256:job.sha256,actorId:'fixture-human',confirmed:true,expiresAtMs:now+60000});

test('prepared job survives restart with exact bytes, accepted design and selection binding',async t=>{
 const f=await accepted(t);const prepared=await f.jobs.prepare(request());
 const loaded=await f.fresh().loadPreparedJob(prepared.jobId);
 assert.deepEqual(loaded.printable,printable);
 assert.deepEqual(loaded.job,prepared.job);
 assert.deepEqual(loaded.job.designArtifact,designRef);
 assert.deepEqual(loaded.job.printableArtifact,printableRef);
 assert.deepEqual(loaded.job.selection,selection);
 assert.equal(loaded.job.projectRevision,REVISION);
 assert.equal(loaded.project.acceptedArtifact.artifact.sha256,designRef.sha256);
 assert.equal(loaded.intent,null);
 const stored=join(f.root,'prepared',prepared.jobId,'printable.bin');
 assert.deepEqual(await readFile(stored),printable);
 assert.equal((await stat(stored)).mode&0o777,0o400);
});

test('declared printable identity must match the exact bytes or nothing is committed',async t=>{
 const f=await accepted(t);
 await assert.rejects(f.jobs.prepare({...request(),printableArtifact:{...printableRef,sha256:'b'.repeat(64)}}),/identity|digest|mismatch/);
 await assert.rejects(f.jobs.prepare({...request(),printableArtifact:{...printableRef,byteLength:1}}),/identity|length|mismatch/);
 await assert.rejects(f.jobs.prepare({...request(),printable:Buffer.alloc(0)}),/limit|empty|byte/);
 assert.deepEqual(await readdir(join(f.root,'prepared')).catch(()=>[]),[]);
});

test('prepare requires the current accepted portable project revision',async t=>{
 const f=await accepted(t);
 await assert.rejects(f.jobs.prepare({...request(),projectRevision:1}),/revision/);
 const draft=await f.projects.create({id:'draft-only',brief,fit:null});assert.equal(draft.status,'ok');
 await assert.rejects(f.jobs.prepare({...request(),projectId:'draft-only',projectRevision:0}),/accepted/);
 const prepared=await f.jobs.prepare(request());
 assert.equal((await f.projects.change(fit.id,REVISION,{kind:'replace-brief',brief:{...brief,addition:'Changed'}})).status,'ok');
 await assert.rejects(f.fresh().loadPreparedJob(prepared.jobId),/revision/);
 await assert.rejects(f.fresh().claimIntent(prepared.jobId,approval(prepared.job)),/revision/);
});

test('tampered job profile or printable bytes reject on verified load',async t=>{
 const f=await accepted(t);const prepared=await f.jobs.prepare(request());
 const jobFile=join(f.root,'prepared',prepared.jobId,'job.json');
 const original=await readFile(jobFile,'utf8');
 const tampered=JSON.parse(original);tampered.selection.plateIndex=1;
 await writeFile(jobFile,JSON.stringify(tampered)+'\n');
 await assert.rejects(f.fresh().loadPreparedJob(prepared.jobId),/digest/);
 await writeFile(jobFile,original);
 const bin=join(f.root,'prepared',prepared.jobId,'printable.bin');
 await chmod(bin,0o600);const changed=Buffer.from(printable);changed[0]^=1;await writeFile(bin,changed);await chmod(bin,0o400);
 await assert.rejects(f.fresh().loadPreparedJob(prepared.jobId),/digest|length|mismatch/);
 await assert.rejects(f.fresh().claimIntent(prepared.jobId,approval(prepared.job)),/digest|length|mismatch/);
});

test('approval is bound to the exact job digest and a five minute window',async t=>{
 const f=await accepted(t);const prepared=await f.jobs.prepare(request());const now=1800000000000;
 await assert.rejects(f.jobs.claimIntent(prepared.jobId,{...approval(prepared.job),jobSha256:'b'.repeat(64)}),/approval/i);
 await assert.rejects(f.jobs.claimIntent(prepared.jobId,{...approval(prepared.job),expiresAtMs:now}),/approval/i);
 await assert.rejects(f.jobs.claimIntent(prepared.jobId,{...approval(prepared.job),expiresAtMs:now+300001}),/approval/i);
 await assert.rejects(f.jobs.claimIntent(prepared.jobId,{...approval(prepared.job),confirmed:false}));
 assert.equal((await f.fresh().loadPreparedJob(prepared.jobId)).intent,null);
 const intent=await f.jobs.claimIntent(prepared.jobId,approval(prepared.job));
 assert.equal(intent.jobSha256,prepared.job.sha256);
 assert.deepEqual((await f.fresh().loadPreparedJob(prepared.jobId)).intent,intent);
});

test('intent is once-only across restarts and concurrent instances',async t=>{
 const f=await accepted(t);const prepared=await f.jobs.prepare(request());
 const results=await Promise.allSettled([
  f.jobs.claimIntent(prepared.jobId,approval(prepared.job)),
  f.fresh().claimIntent(prepared.jobId,approval(prepared.job)),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 await assert.rejects(f.fresh().claimIntent(prepared.jobId,approval(prepared.job)),/intent|replay|busy/);
});

test('selection changes produce a different job digest, so old approvals never bind',async t=>{
 const f=await accepted(t);
 const first=await f.jobs.prepare(request());
 const second=await f.jobs.prepare({...request(),selection:{...structuredClone(selection),plateIndex:1}});
 assert.notEqual(first.job.sha256,second.job.sha256);
 await assert.rejects(f.jobs.claimIntent(second.jobId,approval(first.job)),/approval/i);
 const intent=await f.jobs.claimIntent(second.jobId,approval(second.job));
 assert.equal(intent.jobId,second.jobId);
});

test('oversized serialized intent rejects before publishing an unreadable intent',async t=>{
 const f=await accepted(t);
 const capped=new PreparedJobStore(f.storage,join(f.root,'prepared'),{clock:()=>1800000000000,maxMetadataBytes:4096});
 const prepared=await capped.prepare(request());
 await assert.rejects(capped.claimIntent(prepared.jobId,{...approval(prepared.job),actorId:'x'.repeat(5000)}),/limit/);
 assert.equal((await capped.loadPreparedJob(prepared.jobId)).intent,null);
 const intent=await capped.claimIntent(prepared.jobId,approval(prepared.job));
 assert.deepEqual((await capped.loadPreparedJob(prepared.jobId)).intent,intent);
});

test('approval expiring during the intent write never publishes an intent',async t=>{
 const f=await accepted(t);const T=1800000000000;
 const prepared=await f.jobs.prepare(request());
 let calls=0;const advancing=()=>++calls<=2?T:T+120000;
 const store=new PreparedJobStore(f.storage,join(f.root,'prepared'),{clock:advancing});
 await assert.rejects(store.claimIntent(prepared.jobId,approval(prepared.job,T)),/approval/i);
 assert.equal((await f.fresh().loadPreparedJob(prepared.jobId)).intent,null);
 const intent=await f.jobs.claimIntent(prepared.jobId,approval(prepared.job,T));
 assert.deepEqual((await f.fresh().loadPreparedJob(prepared.jobId)).intent,intent);
});

test('corrupt retained intent fails closed instead of looking unclaimed',async t=>{
 const f=await accepted(t);const prepared=await f.jobs.prepare(request());
 await f.jobs.claimIntent(prepared.jobId,approval(prepared.job));
 await writeFile(join(f.root,'prepared',prepared.jobId,'intent.json'),'{"kind":"intent","truncated":');
 await assert.rejects(f.fresh().loadPreparedJob(prepared.jobId));
 await assert.rejects(f.fresh().claimIntent(prepared.jobId,approval(prepared.job)));
});


test('publication guard runs after staging fsync and abort or revoked authorization leaves no job',async t=>{
 const f=await accepted(t);
 for(const failure of ['abort','revoke']){
  const controller=new AbortController();let called=false;
  await assert.rejects(f.jobs.prepare(request(),controller.signal,async()=>{
   called=true;const files=await readdir(join(f.root,'prepared'));assert.equal(files.length,1);
   const staged=JSON.parse(await readFile(join(f.root,'prepared',files[0],'job.json'),'utf8'));
   assert.equal(staged.projectRevision,REVISION);
   if(failure==='abort')controller.abort();else throw Error('revoked');
  }),failure==='abort'?/cancelled/:/revoked/);
  assert.equal(called,true);assert.deepEqual(await readdir(join(f.root,'prepared')),[]);
 }
});
