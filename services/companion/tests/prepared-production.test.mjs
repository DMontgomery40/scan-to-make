import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,chmod} from 'node:fs/promises';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {FileSavedProjectStorage,savedProjectETag} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore} from '../dist/prepared-jobs.js';
import {fakeProductionResult, fakeProductionSettings, fakeSlicedThreeMf} from './fixtures/prepared-production-result.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid test\n');
const ref=(b,mediaType)=>({sha256:sha(b),byteLength:b.length,mediaType});
const sourceRef=ref(source,'model/stl');
const output=fakeSlicedThreeMf;
const importedOutput=Buffer.from('; isolated imported fixture\nG28\n');
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url),'utf8'));
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],nozzleType:'hardened_steel',bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}]};
const settings=fakeProductionSettings({selection,allowSupports:false});
const brief={object:'Cup',context:'Console',addition:'Insert'};
function result(input,request){return fakeProductionResult(input,request);}
async function setup(t,hook){
 const root=await mkdtemp(join(tmpdir(),'produced-jobs-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief,fit});const binding={sourceFit:fit,artifact:sourceRef};await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 let calls=0;const production={identity:'c'.repeat(64),async produce(input,request,signal){calls++;return hook?await hook(input,request,signal,{projects,root}):result(input,request);}};
 const inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),'nozzle-hardened',join(root,'inspector.jsonl')]},options:{timeoutMs:5000}};
 const appProduction={selection:structuredClone(selection),displayName:'P1S fixture'};
 const jobs=new PreparedJobStore(storage,join(root,'jobs'),{production,inspection,appProduction});
 const request={projectId:fit.id,projectRevision:2,expectedProjectETag:savedProjectETag(await storage.read(fit.id)),jobId:randomUUID(),source:Buffer.from(source),selection:structuredClone(selection)};
 return {root,storage,projects,jobs,request,calls:()=>calls,fresh:()=>new PreparedJobStore(storage,join(root,'jobs'),{production,inspection,appProduction})};
}
test('trusted produced job retains exact evidence, survives restart, recovers ID and stays hidden from old discovery',async t=>{
 const f=await setup(t);const first=await f.jobs.prepareProduced(f.request);
 assert.equal(first.job.production.sourceArtifact.sha256,sourceRef.sha256);
 assert.equal(first.job.selection.slicerSettingsSha256,sha(settings));assert.ok(first.job.inspection);
 const loaded=await f.fresh().loadPreparedJob(first.jobId,f.request.expectedProjectETag);assert.deepEqual(loaded.job,first.job);assert.deepEqual(loaded.printable,output);
 for(const [name,bytes] of [['source.stl',source],['settings.json',settings]])assert.deepEqual(await readFile(join(f.root,'jobs',first.jobId,name)),bytes);
 const retry=await f.fresh().prepareProduced(f.request);assert.equal(retry.created,false);assert.equal(f.calls(),1);
 assert.deepEqual((await f.jobs.listPreparedJobs({projectId:fit.id,projectRevision:2,expectedProjectETag:f.request.expectedProjectETag})).jobs,[]);
});
test('source mismatch rejects before invoking producer',async t=>{const f=await setup(t);await assert.rejects(f.jobs.prepareProduced({...f.request,source:Buffer.from('wrong')}),/source|identity|artifact/i);assert.equal(f.calls(),0);});
for(const kind of ['manifest-output','manifest-settings','manifest-source','edited','abort'])test(`${kind} during trusted production publishes nothing`,async t=>{
 const controller=new AbortController();const f=await setup(t,async(input,request,_signal,{projects})=>{
  if(kind==='edited')await projects.change(fit.id,2,{kind:'replace-brief',brief:{...brief,addition:'Changed'}});
  if(kind==='abort')controller.abort();const r=result(input,request);
  if(kind.startsWith('manifest-')){const m=JSON.parse(r.manifest);if(kind==='manifest-source')m.input.sha256='f'.repeat(64);else m.outputs[kind==='manifest-output'?'threeMf':'settings'].sha256='f'.repeat(64);r.manifest=Buffer.from(JSON.stringify(m));}return r;
 });await assert.rejects(f.jobs.prepareProduced(f.request,controller.signal));assert.deepEqual(await readdir(join(f.root,'jobs')).catch(()=>[]),[]);
});
for(const name of ['source.stl','settings.json','production.json'])test(`tampered retained ${name} rejects reopen and retry`,async t=>{const f=await setup(t);const p=await f.jobs.prepareProduced(f.request);const path=join(f.root,'jobs',p.jobId,name);await chmod(path,0o600);await writeFile(path,'corrupt');await assert.rejects(f.fresh().loadPreparedJob(p.jobId));await assert.rejects(f.fresh().prepareProduced(f.request));assert.equal(f.calls(),1);});
test('revocation immediately before publication and imported/produced ID collisions fail closed',async t=>{
 const f=await setup(t);await assert.rejects(f.jobs.prepareProduced(f.request,undefined,async()=>{throw Error('revoked');}),/revoked/);assert.deepEqual(await readdir(join(f.root,'jobs')).catch(()=>[]),[]);
 const imported=await f.jobs.prepare({projectId:fit.id,projectRevision:2,jobId:f.request.jobId,printable:importedOutput,printableArtifact:ref(importedOutput,'text/x.gcode'),selection:{...selection,slicerSettingsSha256:sha(settings)}});
 await assert.rejects(f.jobs.prepareProduced(f.request),/conflict/);assert.equal(imported.job.production,undefined);
 const f2=await setup(t),produced=await f2.jobs.prepareProduced(f2.request);await assert.rejects(f2.jobs.prepare({projectId:fit.id,projectRevision:2,jobId:produced.jobId,printable:importedOutput,printableArtifact:ref(importedOutput,'text/x.gcode'),selection:{...selection,slicerSettingsSha256:sha(settings)}}),/conflict/);
});

test('invalid selection rejects before slicing and UUID casing recovers the same job',async t=>{
 const f=await setup(t);
 await assert.rejects(f.jobs.prepareProduced({...f.request,selection:{...selection,materials:[...selection.materials,...selection.materials]}}));assert.equal(f.calls(),0);
 const first=await f.jobs.prepareProduced({...f.request,jobId:f.request.jobId.toUpperCase()});
 const retry=await f.jobs.prepareProduced(f.request);assert.equal(retry.jobId,first.jobId);assert.equal(f.calls(),1);
});
test('source bytes are snapshotted before the first async boundary',async t=>{
 const f=await setup(t),request={...f.request,source:Buffer.from(source)};
 const pending=f.jobs.prepareProduced(request);request.source.fill(0);
 const job=await pending;assert.equal(job.job.production.sourceArtifact.sha256,sha(source));
});
test('app production replay of a CLI-produced job must match the retained request identity',async t=>{
 const f=await setup(t);
 const produced=await f.jobs.prepareProduced({...f.request,selection:{...selection,printerId:'other-printer'}});
 await assert.rejects(f.jobs.startPreparedProduction({projectId:fit.id,projectRevision:2,
  expectedProjectETag:f.request.expectedProjectETag,jobId:produced.jobId,source:Buffer.from(source)}),{code:'job-conflict'});
 const matching=await setup(t),cli=await matching.jobs.prepareProduced(matching.request);
 const replay=await matching.jobs.startPreparedProduction({projectId:fit.id,projectRevision:2,
  expectedProjectETag:matching.request.expectedProjectETag,jobId:cli.jobId,source:Buffer.from(source)});
 assert.equal(replay.created,false);assert.equal(replay.view.status,'succeeded');assert.equal(replay.view.job.jobSha256,cli.job.sha256);
});
test('ownerless running operation reconciles with its matching published job',async t=>{
 const f=await setup(t),jobId=f.request.jobId;
 const start={projectId:fit.id,projectRevision:2,expectedProjectETag:f.request.expectedProjectETag,jobId,source:Buffer.from(source)};
 const load={projectId:fit.id,projectRevision:2,expectedProjectETag:f.request.expectedProjectETag,jobId};
 await f.jobs.startPreparedProduction(start);
 let view;
 for(let attempt=0;attempt<200;attempt++){view=(await f.jobs.loadPreparedProduction(load)).view;if(view.status==='succeeded')break;await delay(10);}
 assert.equal(view?.status,'succeeded');
 // Simulate a crash after publication but before the success record landed.
 const operationPath=join(f.root,'jobs','.production-operations',`${jobId}.json`);
 const operation=JSON.parse(await readFile(operationPath,'utf8'));
 operation.status='running';delete operation.finishedAtMs;
 await writeFile(operationPath,JSON.stringify(operation)+'\n');
 const recovered=await f.fresh().loadPreparedProduction(load);
 assert.equal(recovered.view.status,'succeeded');assert.equal(recovered.view.job.jobId,jobId);
 assert.equal(JSON.parse(await readFile(operationPath,'utf8')).status,'succeeded');
});
