import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore} from '../dist/prepared-jobs.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startGenerationServer} from '../dist/generation.js';
import {fakeProductionResult} from './fixtures/prepared-production-result.mjs';

const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url))).expected;
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url)));
const sha=b=>createHash('sha256').update(b).digest('hex');
const ref=(b,mediaType)=>({sha256:sha(b),byteLength:b.length,mediaType});
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],nozzleType:'hardened_steel',bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}]};

function packStl(tris){
 const buffer=Buffer.alloc(84+tris.length*50);buffer.writeUInt32LE(tris.length,80);let offset=84;
 for(const [a,b,c] of tris){
  const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const len=Math.hypot(...n)||1;n=n.map(x=>x/len);
  for(const value of [...n,...a,...b,...c]){buffer.writeFloatLE(value,offset);offset+=4;}
  buffer.writeUInt16LE(0,offset);offset+=2;
 }
 return buffer;
}
function rectilinear(xs,ys,zs,occ){
 const tris=[],at=(i,j,k)=>i>=0&&i<xs.length-1&&j>=0&&j<ys.length-1&&k>=0&&k<zs.length-1&&occ(i,j,k);
 for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++)for(let k=0;k<zs.length-1;k++){
  if(!at(i,j,k))continue;const [x0,x1,y0,y1,z0,z1]=[xs[i],xs[i+1],ys[j],ys[j+1],zs[k],zs[k+1]];
  if(!at(i,j,k-1))tris.push([[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]],[[x0,y0,z0],[x1,y1,z0],[x1,y0,z0]]);
  if(!at(i,j,k+1))tris.push([[x0,y0,z1],[x1,y0,z1],[x1,y1,z1]],[[x0,y0,z1],[x1,y1,z1],[x0,y1,z1]]);
  if(!at(i,j-1,k))tris.push([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1]],[[x0,y0,z0],[x1,y0,z1],[x0,y0,z1]]);
  if(!at(i,j+1,k))tris.push([[x0,y1,z0],[x0,y1,z1],[x1,y1,z1]],[[x0,y1,z0],[x1,y1,z1],[x1,y1,z0]]);
  if(!at(i-1,j,k))tris.push([[x0,y0,z0],[x0,y0,z1],[x0,y1,z1]],[[x0,y0,z0],[x0,y1,z1],[x0,y1,z0]]);
  if(!at(i+1,j,k))tris.push([[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]],[[x1,y0,z0],[x1,y1,z1],[x1,y0,z1]]);
 }
 return packStl(tris);
}
const cube=rectilinear([0,20],[0,20],[0,20],()=>true);
const twoCubes=rectilinear([0,10,20,30],[0,10],[0,10],i=>i!==1);

function result(input,request){return fakeProductionResult(input,request);}

const toolDirectory=fileURLToPath(new URL('../../../tools/printability/',import.meta.url));
async function fixture(t,source=cube){
 const root=await mkdtemp(join(tmpdir(),'prepared-production-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invite=await auth.createPairing('alice@example.test',['generation:health','projects:read','projects:write','prepared-jobs:read','prepared-jobs:prepare','prints:approve']);
 const phone=await auth.exchange('alice@example.test',{code:invite.code,deviceName:'print phone'});
 const readerInvite=await auth.createPairing('alice@example.test',['generation:health','projects:read','projects:write','prepared-jobs:read','prepared-jobs:prepare']);
 const reader=await auth.exchange('alice@example.test',{code:readerInvite.code,deviceName:'prepared only'});
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief:{object:'Cup',context:'Desk',addition:'Holder'},fit});
 const binding={sourceFit:fit,artifact:ref(source,'model/stl')};
 await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 let calls=0;const requests=[];
 const production={identity:'c'.repeat(64),async produce(input,request){calls++;requests.push(request);return result(input,request);}};
 const inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),'nozzle-hardened',join(root,'calls.jsonl')]},options:{timeoutMs:5000}};
 const read=async name=>readFile(join(toolDirectory,name));
 const printability={python:execFileSync('which',['python3'],{encoding:'utf8'}).trim(),script:join(toolDirectory,'printability.py'),
  expectedScriptSha256:sha(await read('printability.py')),expectedAnalyzerSha256:sha(await read('analyzer.py')),
  expectedProfilesSha256:sha(await read('profiles.json')),profileId:'p1s-0.4-hardened'};
 const jobs=new PreparedJobStore(storage,join(root,'jobs'),{production,inspection,printability,appProduction:{selection,displayName:'P1S · PLA basic'}});
 const f={root,auth,phone,reader,storage,jobs,source,calls:()=>calls,requests,headers:{authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId}};
 f.server=await startGenerationServer({port:0,remoteAuth:auth,capture:{storage,preparedJobs:jobs}});t.after(()=>f.server.close());
 const snapshot=await wire(f,`/v1/saved-projects/${fit.id}`);assert.equal(snapshot.status,200);f.etag=snapshot.headers.etag;
 return f;
}
function wire(f,path,{method='GET',headers={},body,device}={}){
 return new Promise((resolve,reject)=>{
  const auth=device?{authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId}:f.headers;
  const req=httpRequest(f.server.url+path,{method,headers:{...forwarded,...auth,...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
   res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
  });req.on('error',reject);req.end(body);
 });
}
const route=(id,sub='production')=>`/v1/saved-projects/${fit.id}/prepared-jobs/${id}/${sub}?projectRevision=2`;
async function poll(f,id){
 for(let n=0;n<200;n++){
  const r=await wire(f,route(id),{headers:{'if-match':f.etag}});
  if(r.status===429){await new Promise(ok=>setTimeout(ok,25));continue;}
  assert.equal(r.status,200,r.bytes.toString());const view=JSON.parse(r.bytes).production;
  if(view.status!=='running')return view;
  await new Promise(ok=>setTimeout(ok,25));
 }
 throw Error('production did not finish');
}

test('app production runs gated slicing asynchronously, then approval and attempt status follow the journal link',async t=>{
 const f=await fixture(t),id=randomUUID();
 assert.equal((await wire(f,route(id),{method:'POST',headers:{'content-type':'model/stl'},body:f.source})).status,428);
 assert.equal((await wire(f,route(id),{method:'POST',headers:{'if-match':'"'+'0'.repeat(64)+'"','content-type':'model/stl'},body:f.source})).status,412);
 assert.equal((await wire(f,route(id),{method:'POST',headers:{'if-match':f.etag,'content-type':'text/plain'},body:f.source})).status,415);
 const started=await wire(f,route(id),{method:'POST',headers:{'if-match':f.etag,'content-type':'model/stl'},body:f.source});
 assert.equal(started.status,202,started.bytes.toString());assert.equal(JSON.parse(started.bytes).production.status,'running');
 const view=await poll(f,id);
 assert.equal(view.status,'succeeded',JSON.stringify(view));assert.equal(view.job.jobId,id);assert.match(view.job.jobSha256,/^[a-f0-9]{64}$/);
 assert.equal(view.printability.verdict,'printable');assert.equal(view.gcodeSummary,undefined);
 assert.equal(view.job.printableArtifact.mediaType,'model/3mf');
 assert.deepEqual(view.profile,{displayName:'P1S · PLA basic',nozzleDiameterMm:0.4,nozzleType:'hardened_steel',bedType:'textured_plate'});
 assert.equal(f.requests[0].selection.nozzleType,'hardened_steel');
 const replay=await wire(f,route(id),{method:'POST',headers:{'if-match':f.etag,'content-type':'model/stl'},body:f.source});
 assert.equal(replay.status,200);assert.equal(f.calls(),1);
 const attempt=JSON.parse((await wire(f,route(id,'attempt'),{headers:{'if-match':f.etag}})).bytes).attempt;
 assert.equal(attempt.intent,null);assert.equal(attempt.linkedAttempt,null);
 const approve=body=>wire(f,route(id,'intent'),{method:'POST',headers:{'if-match':f.etag,'content-type':'application/json'},body:JSON.stringify(body)});
 const denied=await wire(f,route(id,'intent'),{method:'POST',headers:{'if-match':f.etag,'content-type':'application/json'},body:JSON.stringify({jobSha256:view.job.jobSha256,confirmed:true}),device:f.reader});
 assert.equal(denied.status,403);
 assert.equal((await approve({jobSha256:'0'.repeat(64),confirmed:true})).status,409);
 assert.equal(JSON.parse((await approve({jobSha256:'0'.repeat(64),confirmed:true})).bytes).error.code,'approval-mismatch');
 assert.equal((await approve({jobSha256:view.job.jobSha256,confirmed:true,actorId:'mallory'})).status,400);
 const claimed=await approve({jobSha256:view.job.jobSha256,confirmed:true});assert.equal(claimed.status,201);
 const intent=JSON.parse(claimed.bytes).intent;assert.match(intent.intentId,/^[a-f0-9-]{36}$/);
 const stored=await f.jobs.loadPreparedJob(id,f.etag);
 assert.equal(stored.intent.approval.actorId,f.phone.deviceId);
 assert(stored.intent.approval.expiresAtMs>Date.now()&&stored.intent.approval.expiresAtMs<=Date.now()+300000);
 assert.equal((await approve({jobSha256:view.job.jobSha256,confirmed:true})).status,409);
 assert.equal(JSON.parse((await approve({jobSha256:view.job.jobSha256,confirmed:true})).bytes).error.code,'already-approved');
 await writeFile(join(f.root,'jobs',id,'attempt-link.json'),JSON.stringify({attemptId:randomUUID(),printerId:'fixture',planSha256:'d'.repeat(64),outcome:'started'}));
 const linked=JSON.parse((await wire(f,route(id,'attempt'),{headers:{'if-match':f.etag}})).bytes).attempt;
 assert.equal(linked.intent.intentId,intent.intentId);assert.equal(linked.linkedAttempt.outcome,'started');
 await f.jobs.close();
});

test('a not-printable scan fails the operation with the retained verdict and never slices',async t=>{
 const f=await fixture(t,twoCubes),id=randomUUID();
 const started=await wire(f,route(id),{method:'POST',headers:{'if-match':f.etag,'content-type':'model/stl'},body:f.source});
 assert.equal(started.status,202);
 const view=await poll(f,id);
 assert.equal(view.status,'failed');assert.equal(view.failure.code,'printability-failed');
 assert.equal(view.failure.printability.verdict,'not-printable');
 assert(view.failure.printability.reasonCodes.includes('multiple-disconnected-solids'));
 assert.equal(f.calls(),0);
 await f.jobs.close();
});
