import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore} from '../dist/prepared-jobs.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from('isolated transport fixture, not actual sliced geometry');
const artifact={sha256:sha(bytes),byteLength:bytes.length,mediaType:'model/3mf'};
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}],slicerSettingsSha256:'a'.repeat(64)};
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url)));
async function setup(t,mode='ok'){
 const root=await mkdtemp(join(tmpdir(),'prepared-inspection-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief:{object:'Cup',context:'Desk',addition:'Holder'},fit});
 const binding={sourceFit:fit,artifact:{...artifact,mediaType:'model/stl'}};
 await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 const log=join(root,'calls.jsonl');
 const inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),mode,log]},options:{timeoutMs:mode==='stall'?150:5000}};
 const jobs=new PreparedJobStore(storage,join(root,'jobs'),{inspection});
 return {root,storage,jobs,log,request:{projectId:fit.id,projectRevision:2,printable:bytes,printableArtifact:artifact,selection}};
}
test('trusted inspection is persisted in the exact job digest and survives reopen; only file inspector is called',async t=>{
 const f=await setup(t),result=await f.jobs.prepare(f.request);
 assert.equal(result.job.inspection.receipt.artifact.sha256,artifact.sha256);
 assert.equal(result.job.inspection.receipt.dispatch_authorized,false);
 assert.match(result.job.inspection.catalogSha256,/^[a-f0-9]{64}$/);
 const reopened=await new PreparedJobStore(f.storage,join(f.root,'jobs')).loadPreparedJob(result.jobId);
 assert.deepEqual(reopened.job,result.job);assert.deepEqual(reopened.printable,bytes);
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.method==='tools/call');
 assert.deepEqual(calls.map(x=>x.params.name),['inspect_print_file']);
 assert.equal(calls[0].params.arguments.plate_index,0);
 assert.deepEqual((await readdir(join(f.root,'jobs',result.jobId))).sort(),['job.json','printable.bin']);
 const path=join(f.root,'jobs',result.jobId,'job.json'),job=JSON.parse(await readFile(path));job.inspection.receipt.inspection.materials=['ABS'];await writeFile(path,JSON.stringify(job));
 await assert.rejects(new PreparedJobStore(f.storage,join(f.root,'jobs')).loadPreparedJob(result.jobId),/digest/);
});
for(const mode of ['wrong-hash','wrong-model','wrong-plate','wrong-material','authorized','missing','incompatible','tool-error','large','stall'])test(`${mode} cannot publish a prepared job`,async t=>{
 const f=await setup(t,mode);const code=mode==='stall'?'discovery-timeout':mode==='large'?'inspection-limit':mode==='missing'?'invalid-inspection-schema':mode==='incompatible'?'incompatible-print-schema':'inspection-failed';await assert.rejects(f.jobs.prepare(f.request),{code});assert.deepEqual(await readdir(join(f.root,'jobs')),[]);
});
test('caller receipt cannot replace the trusted inspection',async t=>{
 const f=await setup(t,'wrong-hash');await assert.rejects(f.jobs.prepare({...f.request,inspection:{dispatch_authorized:false}}));
});

test('raw G-code uses only plate zero and keeps verified format evidence',async t=>{
 const f=await setup(t);const req={...f.request,printableArtifact:{...artifact,mediaType:'text/x.gcode'}};
 const result=await f.jobs.prepare(req);assert.equal(result.job.inspection.receipt.artifact.file_format,'gcode');
 await assert.rejects(f.jobs.prepare({...req,selection:{...selection,plateIndex:1}}),{code:'inspection-failed'});
});
test('unsupported media and invalid external material mapping never publish',async t=>{
 const f=await setup(t);await assert.rejects(f.jobs.prepare({...f.request,printableArtifact:{...artifact,mediaType:'model/stl'}}),/requires sliced/);
 await assert.rejects(f.jobs.prepare({...f.request,selection:{...selection,materials:[{projectSlot:1,material:'PLA',physicalTray:254}]}}),{code:'inspection-failed'});
 assert.deepEqual(await readdir(join(f.root,'jobs')),[]);
});

test('sparse project filament mapping remains correct independent of selection and plate order',async t=>{
 const f=await setup(t,'multi');const result=await f.jobs.prepare({...f.request,selection:{...selection,materials:[
  {projectSlot:2,material:'PETG',physicalTray:129},{projectSlot:0,material:'PLA',physicalTray:3}]}});
 assert.deepEqual(result.job.inspection.receipt.inspection.usedFilamentPositions,[0,2]);
});
test('unknown physical tray identifiers are rejected even when a loose tool schema allows them',async t=>{
 const f=await setup(t);await assert.rejects(f.jobs.prepare({...f.request,selection:{...selection,materials:[{projectSlot:0,material:'PLA',physicalTray:99}]}}),{code:'inspection-failed'});
});
