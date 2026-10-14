import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ProjectStore} from '@scan-to-make/project';
import {CompanionJournal} from '../dist/index.js';

const spec=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url),'utf8'));
const bytes=Buffer.from('synthetic prepared artifact bytes, not printable gcode');
const ref={sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'application/octet-stream',byteLength:bytes.length};
const selection={printerId:'fixture-printer',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}],slicerSettingsSha256:'a'.repeat(64)};
let root,projects,journal,now,source;
beforeEach(async()=>{
 root=await mkdtemp(join(tmpdir(),'scan-companion-test-')); projects=new ProjectStore(join(root,'projects'));
 now=1800000000000; journal=new CompanionJournal(join(root,'companion'),projects,()=>now);
 source=join(root,'source.bin');await writeFile(source,bytes);
 await projects.create(spec);await projects.attachPreview(spec.id,0,ref);await projects.acceptPreview(spec.id,0,ref);
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
async function plan(){const staged=await journal.stageArtifact(source,ref);return journal.createPlan({projectId:spec.id,snapshotId:staged.id,selection});}
const approval=p=>({planSha256:p.sha256,actorId:'fixture-human',confirmed:true,expiresAtMs:now+60000});

test('staging verifies exact bytes and keeps a private detached snapshot',async()=>{
 const staged=await journal.stageArtifact(source,ref);
 await writeFile(source,'changed source');
 const p=await journal.createPlan({projectId:spec.id,snapshotId:staged.id,selection});
 assert.deepEqual(p.printableArtifact,ref);
 const stored=join(root,'companion','snapshots',staged.id,'artifact.bin');
 assert.deepEqual(await readFile(stored),bytes);assert.equal((await stat(stored)).mode&0o777,0o400);
});

test('wrong content digest or byte length stops before a plan exists',async()=>{
 await assert.rejects(journal.stageArtifact(source,{...ref,sha256:'b'.repeat(64)}));
 await assert.rejects(journal.stageArtifact(source,{...ref,byteLength:1}));
});

test('plan and attempt require the current accepted project revision',async()=>{
 const p=await plan();assert.equal(p.specRevision,0);assert.deepEqual(p.designArtifact,ref);
 await projects.applyPatch(spec.id,{expectedRevision:0,dimensions:{cupSupportHeight:{...spec.dimensions.cupSupportHeight,nominalMm:50,lowerMm:50,upperMm:50}}});
 await assert.rejects(journal.beginAttempt(p,approval(p)));
 const staged=await journal.stageArtifact(source,ref);
 await assert.rejects(journal.createPlan({projectId:spec.id,snapshotId:staged.id,selection}));
});

test('approval binds every plate, material and nozzle setting to the exact plan',async()=>{
 const p=await plan();
 for(const field of [{plateIndex:1},{model:'x1c'},{nozzleDiameters:[0.6]},{materials:[{projectSlot:0,material:'PETG',physicalTray:254}]}]){
  const changed=structuredClone(p);Object.assign(changed.selection,field);
  await assert.rejects(journal.beginAttempt(changed,approval(p)));
 }
 assert.deepEqual(await journal.history(selection.printerId),[]);
});

test('expired or absent human confirmation never records dispatch intent',async()=>{
 const p=await plan();
 await assert.rejects(journal.beginAttempt(p,{...approval(p),expiresAtMs:now}));
 await assert.rejects(journal.beginAttempt(p,{...approval(p),confirmed:false}));
 assert.deepEqual(await journal.history(selection.printerId),[]);
});

test('changed staged bytes reject even after approval was created',async()=>{
 const p=await plan();const staged=join(root,'companion','snapshots',p.snapshotId,'artifact.bin');
 await chmod(staged,0o600); const changed=Buffer.from(bytes); changed[0]^=1; await writeFile(staged,changed); await chmod(staged,0o400);
 await assert.rejects(journal.beginAttempt(p,approval(p)));
 assert.deepEqual(await journal.history(selection.printerId),[]);
});

test('a restarted journal never replays an interrupted intent',async()=>{
 const p=await plan();const intent=await journal.beginAttempt(p,approval(p));
 const restarted=new CompanionJournal(join(root,'companion'),projects,()=>now);
 await assert.rejects(restarted.beginAttempt(p,approval(p)));
 const another=await plan();await assert.rejects(restarted.beginAttempt(another,approval(another)));
 assert.equal((await restarted.history(selection.printerId))[0].attemptId,intent.attemptId);
});

test('two companion instances cannot both reserve the same printer',async()=>{
 const p=await plan();const other=new CompanionJournal(join(root,'companion'),projects,()=>now);
 const results=await Promise.allSettled([journal.beginAttempt(p,approval(p)),other.beginAttempt(p,approval(p))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await journal.history(selection.printerId)).length,1);
});

test('uncertain and unconfirmed outcomes block subsequent attempts',async()=>{
 const p=await plan();const intent=await journal.beginAttempt(p,approval(p));
 await journal.recordOutcome(selection.printerId,intent.attemptId,{state:'uncertain'});
 const next=await plan();await assert.rejects(journal.beginAttempt(next,approval(next)));
 assert.equal((await journal.history(selection.printerId)).length,2);
});

test('explicit human reconciliation preserves history and permits a new plan, never replay',async()=>{
 const p=await plan();const intent=await journal.beginAttempt(p,approval(p));
 await journal.recordOutcome(selection.printerId,intent.attemptId,{state:'unconfirmed'});
 await journal.reconcile(selection.printerId,intent.attemptId,{actorId:'fixture-human',confirmed:true,resolution:'rejected'});
 await assert.rejects(journal.beginAttempt(p,approval(p)));
 const next=await plan();await journal.beginAttempt(next,approval(next));
 const history=await journal.history(selection.printerId);assert.equal(history.length,4);
 assert.equal(history[2].kind,'reconciled');assert.equal(history[3].kind,'intent');
});

test('forged reconciliation and unknown attempts cannot release a printer',async()=>{
 const p=await plan();const intent=await journal.beginAttempt(p,approval(p));
 await assert.rejects(journal.reconcile(selection.printerId,intent.attemptId,{actorId:'',confirmed:true,resolution:'rejected'}));
 await assert.rejects(journal.recordOutcome(selection.printerId,'not-an-attempt',{state:'started'}));
 const next=await plan();await assert.rejects(journal.beginAttempt(next,approval(next)));
});
