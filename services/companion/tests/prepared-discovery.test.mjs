import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,chmod,mkdir,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore} from '../dist/prepared-jobs.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startGenerationServer} from '../dist/generation.js';
const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url))).expected;
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url)));
const bytes=Buffer.from('isolated protocol fixture printable');
const artifact={sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,mediaType:'model/3mf'};
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}],slicerSettingsSha256:'a'.repeat(64)};
const envelope=()=>({selection,printableArtifact:artifact,printableBase64:bytes.toString('base64')});
async function fixture(t,mode='ok',projectId=fit.id){
 const projectFit={...fit,id:projectId};
 const root=await mkdtemp(join(tmpdir(),'prepared-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invite=await auth.createPairing('alice@example.test',['generation:health','generation:create','projects:read','projects:write','captures:read','captures:import','prepared-jobs:read','prepared-jobs:prepare']);
 const phone=await auth.exchange('alice@example.test',{code:invite.code,deviceName:'isolated'});
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:projectId,brief:{object:'Cup',context:'Desk',addition:'Holder'},fit:projectFit});
 const binding={sourceFit:projectFit,artifact:{...artifact,mediaType:'model/stl'}};
 await projects.change(projectId,0,{kind:'attach-preview',...binding});await projects.change(projectId,1,{kind:'accept-preview',...binding});
 const log=join(root,'calls.jsonl'),inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),mode,log]},options:{timeoutMs:5000}};
 const makeJobs=()=>new PreparedJobStore(new FileSavedProjectStorage(join(root,'projects')),join(root,'jobs'),{inspection,maxPrintableBytes:1024});
 const f={root,auth,phone,storage,projects,log,makeJobs,headers:{authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId}};
 f.server=await startGenerationServer({port:0,remoteAuth:auth,capture:{storage,preparedJobs:makeJobs()}});t.after(()=>f.server.close());
 const snapshot=await wire(f,`/v1/saved-projects/${projectId}`);assert.equal(snapshot.status,200);f.etag=snapshot.headers.etag;
 return f;
}
function wire(f,path,{method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{const req=httpRequest(f.server.url+path,{method,headers:{...forwarded,...f.headers,...headers}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
 });req.on('error',reject);req.end(body);});
}
const base=id=>`/v1/saved-projects/${fit.id}/prepared-jobs/${id}`;
const route=(id,download=false)=>base(id)+(download?'/artifacts/printable':'')+'?projectRevision=2';
const post=(f,body=envelope())=>({method:'POST',headers:{'if-match':f.etag,'content-type':'application/json'},body:JSON.stringify(body)});
async function get(f,id,download=false){for(let n=0;n<30;n++){const r=await wire(f,route(id,download),{headers:{'if-match':f.etag}});if(r.status!==429)return r;await new Promise(r=>setTimeout(r,10));}throw Error('busy');}
async function retryBusy(operation){for(let i=0;i<50;i++){const r=await operation();if(r.status!==429)return r;await new Promise(r=>setTimeout(r,10));}throw Error('busy');}
async function called(f){for(let n=0;n<100;n++){const log=await readFile(f.log,'utf8').catch(()=> '');if(log.includes('tools/call'))return;await new Promise(r=>setTimeout(r,10));}throw Error('no worker call');}


const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const listing=(f,query='')=>retryBusy(()=>wire(f,`/v1/saved-projects/${fit.id}/prepared-jobs?projectRevision=2${query}`,{headers:{'if-match':f.etag}}));
async function seed(f,count,transform=()=>{}){
 const original=randomUUID();const result=await wire(f,route(original),post(f));assert.equal(result.status,201);
 const job=JSON.parse(result.bytes).job;
 for(let n=1;n<=count;n++){
  const {sha256,...body}=structuredClone(job);body.id=uuid(n);transform(body,n);
  const clone={...body,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
  await mkdir(join(f.root,'jobs',body.id));await writeFile(join(f.root,'jobs',body.id,'job.json'),JSON.stringify(clone));
  await copyFile(join(f.root,'jobs',original,'printable.bin'),join(f.root,'jobs',body.id,'printable.bin'));
 }
 await rm(join(f.root,'jobs',original),{recursive:true});
}
test('discovery returns ordered current-project summary handles and paginates across restart',async t=>{
 const f=await fixture(t);await seed(f,5,(job,n)=>{if(n===2)job.projectId='other';if(n===3)job.projectRevision=1;if(n===4)delete job.inspection;});
 const first=await listing(f,'&limit=1');assert.equal(first.status,200);assert.equal(first.headers.etag,f.etag);
 const page=JSON.parse(first.bytes);assert.equal(page.requiresVerifiedGet,true);assert.deepEqual(page.jobs,[{jobId:uuid(1),jobSha256:JSON.parse(await readFile(join(f.root,'jobs',uuid(1),'job.json'))).sha256,printableArtifact:artifact,model:'p1s',plateIndex:0}]);assert.ok(page.nextCursor);
 await f.server.close();f.server=await startGenerationServer({port:0,remoteAuth:await RemoteAuthStore.open(join(f.root,'auth')),capture:{storage:f.storage,preparedJobs:f.makeJobs()}});
 const second=JSON.parse((await listing(f,'&limit=1&cursor='+page.nextCursor)).bytes);assert.deepEqual(second.jobs.map(x=>x.jobId),[uuid(5)]);assert.equal(second.nextCursor,null);
 assert.deepEqual((await get(f,uuid(5),true)).bytes,bytes);
});
test('summary never reads printable bytes; verified GET still rejects corrupted file',async t=>{
 const f=await fixture(t);await seed(f,1);await chmod(join(f.root,'jobs',uuid(1),'printable.bin'),0o600);await writeFile(join(f.root,'jobs',uuid(1),'printable.bin'),'changed');
 const page=await listing(f);assert.equal(page.status,200);assert.equal(JSON.parse(page.bytes).requiresVerifiedGet,true);assert.equal((await get(f,uuid(1))).status,422);
});
test('cursor detects changed catalog and cannot be reused for another revision or project',async t=>{
 const f=await fixture(t);await seed(f,2);const page=JSON.parse((await listing(f,'&limit=1')).bytes);assert.ok(page.nextCursor);
 const decoded=JSON.parse(Buffer.from(page.nextCursor,'base64url'));decoded.projectId='other';const wrong=Buffer.from(JSON.stringify(decoded)).toString('base64url');assert.equal((await listing(f,'&cursor='+wrong)).status,400);
 await rm(join(f.root,'jobs',uuid(2)),{recursive:true});assert.equal((await listing(f,'&cursor='+page.nextCursor)).status,409);
 await f.projects.change(fit.id,2,{kind:'replace-brief',brief:{object:'Changed',context:'Desk',addition:'Holder'}});assert.equal((await listing(f,'&cursor='+page.nextCursor)).status,412);
});
test('listing enforces scope, preconditions, strict bounded query and GET-only method',async t=>{
 const f=await fixture(t);const path=`/v1/saved-projects/${fit.id}/prepared-jobs?projectRevision=2`;
 for(const query of ['&limit=0','&limit=51','&limit=1&limit=2','&extra=1','&cursor=bad','&projectRevision=2'])assert.equal((await listing(f,query)).status,400,query);
 assert.equal((await wire(f,path)).status,428);assert.equal((await wire(f,path,post(f))).status,405);
 const invite=await f.auth.createPairing('alice@example.test',['projects:read','captures:read']);const old=await f.auth.exchange('alice@example.test',{code:invite.code,deviceName:'old'});
 assert.equal((await wire(f,path,{headers:{'if-match':f.etag,authorization:`Bearer ${old.token}`,'x-scan-device':old.deviceId}})).status,403);
 await f.auth.revoke(f.phone.deviceId);assert.equal((await listing(f)).status,401);
});
test('metadata corruption and unsafe job directories are counted without following or repairing them',async t=>{
 const f=await fixture(t);await seed(f,1);await writeFile(join(f.root,'jobs',uuid(1),'job.json'),'{}');let result=await listing(f);assert.equal(result.status,200);assert.equal(JSON.parse(result.bytes).unreadable,1);assert.deepEqual(JSON.parse(result.bytes).jobs,[]);
 await rm(join(f.root,'jobs',uuid(1)),{recursive:true});const {symlink}=await import('node:fs/promises');await symlink(join(f.root,'projects'),join(f.root,'jobs',uuid(1)));result=await listing(f);assert.equal(result.status,200);assert.equal(JSON.parse(result.bytes).unreadable,1);
});
test('bounded scan pages advance through unrelated jobs; too many directory entries reject',async t=>{
 const f=await fixture(t);await seed(f,201,(job,n)=>{if(n<201)job.projectId='other';});
 const first=JSON.parse((await listing(f)).bytes);assert.deepEqual(first.jobs,[]);assert.ok(first.nextCursor);
 const last=JSON.parse((await listing(f,'&cursor='+first.nextCursor)).bytes);assert.deepEqual(last.jobs.map(x=>x.jobId),[uuid(201)]);assert.equal(last.nextCursor,null);
 await Promise.all(Array.from({length:3896},(_,n)=>mkdir(join(f.root,'jobs','ignored-'+n))));assert.equal((await listing(f)).status,503);
});

test('metadata budget yields a continuation and the maximum page never exceeds fifty handles',async t=>{
 const f=await fixture(t);await seed(f,51);
 const page=JSON.parse((await listing(f,'&limit=50')).bytes);assert.equal(page.jobs.length,50);assert.ok(page.nextCursor);assert.ok(Buffer.byteLength(JSON.stringify(page))<64*1024);
 for(let n=1;n<=8;n++)await writeFile(join(f.root,'jobs',uuid(n),'job.json'),Buffer.alloc(1024*1024+1,32));
 const bounded=JSON.parse((await listing(f)).bytes);assert.equal(bounded.unreadable,7);assert.deepEqual(bounded.jobs,[]);assert.ok(bounded.nextCursor);
 const continued=JSON.parse((await listing(f,'&cursor='+bounded.nextCursor)).bytes);assert.equal(continued.jobs[0].jobId,uuid(9));assert.equal(continued.jobs.length,20);
});

test('current accepted-design mismatch is omitted and authorization is rechecked before response',async t=>{
 const f=await fixture(t);await seed(f,2,(job,n)=>{if(n===1)job.designArtifact.sha256='b'.repeat(64);});
 assert.deepEqual(JSON.parse((await listing(f)).bytes).jobs.map(job=>job.jobId),[uuid(2)]);
 await f.server.close();const jobs=f.makeJobs(),list=jobs.listPreparedJobs.bind(jobs);
 jobs.listPreparedJobs=async(...args)=>{const result=await list(...args);await f.auth.revoke(f.phone.deviceId);return result;};
 f.server=await startGenerationServer({port:0,remoteAuth:f.auth,capture:{storage:f.storage,preparedJobs:jobs}});
 const denied=await listing(f);assert.equal(denied.status,401);assert.ok(!denied.bytes.includes(uuid(2)));
});

test('pre-aborted discovery rejects and an empty store does not create an index or directory',async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(f.makeJobs().listPreparedJobs({projectId:fit.id,projectRevision:2,expectedProjectETag:f.etag},controller.signal),/cancelled/);
 const page=JSON.parse((await listing(f)).bytes);assert.deepEqual(page,{jobs:[],nextCursor:null,unreadable:0,requiresVerifiedGet:true});
 await assert.rejects(readFile(join(f.root,'jobs')),error=>error.code==='ENOENT');
});

const production={requestSha256:'a'.repeat(64),producerIdentity:'b'.repeat(64),
 sourceArtifact:{sha256:'c'.repeat(64),mediaType:'model/stl',byteLength:16},
 settingsArtifact:{sha256:'d'.repeat(64),mediaType:'application/json',byteLength:2},
 manifestArtifact:{sha256:'e'.repeat(64),mediaType:'application/json',byteLength:2},
 slicer:{version:'02.08.02.61',binarySha256:'f'.repeat(64)}};
const handle=async (root,id)=>({jobId:id,jobSha256:JSON.parse(await readFile(join(root,'jobs',id,'job.json'))).sha256,printableArtifact:artifact,model:'p1s',plateIndex:0});
function cursorMode(value){const body=JSON.parse(Buffer.from(value,'base64url'));return {keys:Object.keys(body).sort(),productionVersion:body.productionVersion};}

test('omitted discovery keeps produced jobs hidden and the imported-only response shape',async t=>{
 const f=await fixture(t);await seed(f,3,(job,n)=>{if(n===2)job.production=structuredClone(production);});
 const omitted=await listing(f);assert.equal(omitted.status,200);
 const page=JSON.parse(omitted.bytes);
 assert.deepEqual(page,{jobs:[await handle(f.root,uuid(1)),await handle(f.root,uuid(3))],nextCursor:null,unreadable:0,requiresVerifiedGet:true});
 assert.deepEqual(page.jobs.map(job=>job.jobId),[uuid(1),uuid(3)]);
 const store=await f.makeJobs().listPreparedJobs({projectId:fit.id,projectRevision:2,expectedProjectETag:f.etag});
 assert.deepEqual(store,page);
});

test('productionVersion=1 returns imported and produced summaries in catalog order',async t=>{
 const f=await fixture(t);await seed(f,3,(job,n)=>{if(n===2)job.production=structuredClone(production);});
 const opted=await listing(f,'&productionVersion=1');assert.equal(opted.status,200);
 const page=JSON.parse(opted.bytes);
 assert.deepEqual(page.jobs,[await handle(f.root,uuid(1)),await handle(f.root,uuid(2)),await handle(f.root,uuid(3))]);
 assert.equal(page.nextCursor,null);assert.equal(page.unreadable,0);assert.equal(page.requiresVerifiedGet,true);
 const store=await f.makeJobs().listPreparedJobs({projectId:fit.id,projectRevision:2,expectedProjectETag:f.etag,productionVersion:1});
 assert.deepEqual(store.jobs.map(job=>job.jobId),[uuid(1),uuid(2),uuid(3)]);
});

test('unknown and duplicate productionVersion queries are invalid-request',async t=>{
 const f=await fixture(t);
 for(const query of ['&productionVersion=2','&productionVersion=0','&productionVersion=01','&productionVersion=1.0','&productionVersion=','&productionVersion=1&productionVersion=1','&productionVersion=1&productionVersion=2']){
  const result=await listing(f,query);assert.equal(result.status,400,query);
  assert.equal(JSON.parse(result.bytes).error.code,'invalid-request',query);
 }
});

test('discovery cursors bind productionVersion mode and reject cross-mode reuse',async t=>{
 const f=await fixture(t);await seed(f,3,(job,n)=>{if(n===2)job.production=structuredClone(production);});
 const omitted=JSON.parse((await listing(f,'&limit=1')).bytes);
 assert.deepEqual(omitted.jobs.map(job=>job.jobId),[uuid(1)]);
 assert.deepEqual(cursorMode(omitted.nextCursor),{keys:['after','catalog','etag','projectId','projectRevision','version'],productionVersion:undefined});
 const crossedToOptIn=await listing(f,'&limit=1&productionVersion=1&cursor='+omitted.nextCursor);
 assert.equal(crossedToOptIn.status,400);assert.equal(JSON.parse(crossedToOptIn.bytes).error.code,'invalid-cursor');
 const sameOmitted=JSON.parse((await listing(f,'&limit=1&cursor='+omitted.nextCursor)).bytes);
 assert.deepEqual(sameOmitted.jobs.map(job=>job.jobId),[uuid(3)]);assert.equal(sameOmitted.nextCursor,null);
 const opted=JSON.parse((await listing(f,'&limit=1&productionVersion=1')).bytes);
 assert.deepEqual(opted.jobs.map(job=>job.jobId),[uuid(1)]);
 assert.deepEqual(cursorMode(opted.nextCursor),{keys:['after','catalog','etag','productionVersion','projectId','projectRevision','version'],productionVersion:1});
 const crossedToLegacy=await listing(f,'&limit=1&cursor='+opted.nextCursor);
 assert.equal(crossedToLegacy.status,400);assert.equal(JSON.parse(crossedToLegacy.bytes).error.code,'invalid-cursor');
 const sameOpted=JSON.parse((await listing(f,'&limit=1&productionVersion=1&cursor='+opted.nextCursor)).bytes);
 assert.deepEqual(sameOpted.jobs.map(job=>job.jobId),[uuid(2)]);
 const last=JSON.parse((await listing(f,'&limit=1&productionVersion=1&cursor='+sameOpted.nextCursor)).bytes);
 assert.deepEqual(last.jobs.map(job=>job.jobId),[uuid(3)]);assert.equal(last.nextCursor,null);
});

test('uninspected produced jobs stay hidden in both discovery modes',async t=>{
 const f=await fixture(t);await seed(f,3,(job,n)=>{if(n>1)job.production=structuredClone(production);if(n===3)delete job.inspection;});
 assert.deepEqual(JSON.parse((await listing(f)).bytes).jobs.map(job=>job.jobId),[uuid(1)]);
 const opted=JSON.parse((await listing(f,'&productionVersion=1')).bytes);
 assert.deepEqual(opted.jobs.map(job=>job.jobId),[uuid(1),uuid(2)]);
 assert.equal((await get(f,uuid(1))).status,200);
});

test('opt-in listing keeps ETag, revision, limit and verified-GET rules',async t=>{
 const f=await fixture(t);await seed(f,2,(job,n)=>{if(n===2)job.production=structuredClone(production);});
 const path=`/v1/saved-projects/${fit.id}/prepared-jobs?projectRevision=2&productionVersion=1`;
 assert.equal((await wire(f,path)).status,428);
 assert.equal((await listing(f,'&productionVersion=1&limit=51')).status,400);
 assert.equal(JSON.parse((await listing(f,'&productionVersion=1&limit=0')).bytes).error.code,'invalid-request');
 const page=JSON.parse((await listing(f,'&productionVersion=1&limit=1')).bytes);
 assert.equal(page.requiresVerifiedGet,true);assert.equal(page.jobs.length,1);assert.ok(page.nextCursor);
 await f.projects.change(fit.id,2,{kind:'replace-brief',brief:{object:'Changed',context:'Desk',addition:'Holder'}});
 assert.equal((await listing(f,'&productionVersion=1')).status,412);
});
