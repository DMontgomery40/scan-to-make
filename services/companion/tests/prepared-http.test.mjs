import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,chmod} from 'node:fs/promises';
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
async function fixture(t,mode='ok'){
 const root=await mkdtemp(join(tmpdir(),'prepared-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invite=await auth.createPairing('alice@example.test',['generation:health','generation:create','projects:read','projects:write','captures:read','captures:import','prepared-jobs:read','prepared-jobs:prepare']);
 const phone=await auth.exchange('alice@example.test',{code:invite.code,deviceName:'isolated'});
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief:{object:'Cup',context:'Desk',addition:'Holder'},fit});
 const binding={sourceFit:fit,artifact:{...artifact,mediaType:'model/stl'}};
 await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 const log=join(root,'calls.jsonl'),inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),mode,log]},options:{timeoutMs:5000}};
 const makeJobs=()=>new PreparedJobStore(new FileSavedProjectStorage(join(root,'projects')),join(root,'jobs'),{inspection,maxPrintableBytes:1024});
 const f={root,auth,phone,storage,projects,log,makeJobs,headers:{authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId}};
 f.server=await startGenerationServer({port:0,remoteAuth:auth,capture:{storage,preparedJobs:makeJobs()}});t.after(()=>f.server.close());
 const snapshot=await wire(f,`/v1/saved-projects/${fit.id}`);assert.equal(snapshot.status,200);f.etag=snapshot.headers.etag;
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

test('authenticated inspected prepare/reopen/download survives restart and same UUID retry does not reinspect',async t=>{
 const f=await fixture(t),id=randomUUID();assert.equal((await get(f,id)).status,404);
 const prepared=await wire(f,route(id),post(f));assert.equal(prepared.status,201);const value=JSON.parse(prepared.bytes);assert.equal(value.jobId,id);assert.equal(value.job.inspection.receipt.dispatch_authorized,false);
 await f.server.close();f.server=await startGenerationServer({port:0,remoteAuth:await RemoteAuthStore.open(join(f.root,'auth')),capture:{storage:new FileSavedProjectStorage(join(f.root,'projects')),preparedJobs:f.makeJobs()}});
 const opened=await get(f,id);assert.equal(opened.status,200);assert.deepEqual(JSON.parse(opened.bytes),{...value,intent:null});
 const download=await get(f,id,true);assert.equal(download.status,200);assert.deepEqual(download.bytes,bytes);assert.equal(download.headers['x-content-sha256'],artifact.sha256);assert.equal(download.headers.etag,f.etag);
 const replay=await retryBusy(()=>wire(f,route(id),post(f)));assert.equal(replay.status,200);assert.deepEqual(JSON.parse(replay.bytes),value);
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse).filter(x=>x.method==='tools/call');assert.equal(calls.length,1);
 const changed=envelope();changed.selection={...selection,printerId:'different'};assert.equal((await retryBusy(()=>wire(f,route(id),post(f,changed)))).status,409);
 assert.equal((await wire(f,base(id)+'/intent?projectRevision=2',post(f))).status,404);
});

test('old capture credentials, browser, stale and malformed requests cannot gain prepared authority',async t=>{
 const f=await fixture(t),id=randomUUID();const invite=await f.auth.createPairing('alice@example.test',['projects:read','projects:write','captures:read','captures:import']);const old=await f.auth.exchange('alice@example.test',{code:invite.code,deviceName:'old'});
 const oldHeaders={authorization:`Bearer ${old.token}`,'x-scan-device':old.deviceId};
 assert.equal((await wire(f,route(id),{...post(f),headers:{...post(f).headers,...oldHeaders}})).status,403);
 assert.equal((await wire(f,route(id),{...post(f),headers:{...post(f).headers,origin:'https://other.test'}})).status,403);
 assert.equal((await wire(f,route(id),{...post(f),headers:{...post(f).headers,'if-match':'"'+'0'.repeat(64)+'"'}})).status,412);
 assert.equal((await wire(f,route(id),{...post(f),headers:{'content-type':'application/json'}})).status,428);
 for(const extra of [{receipt:{}},{command:'/bin/sh'},{path:'/tmp/anything'}])assert.equal((await wire(f,route(id),post(f,{...envelope(),...extra}))).status,400);
 assert.equal((await wire(f,route(id),post(f,{...envelope(),printableBase64:'!!!!'}))).status,400);
 assert.equal((await wire(f,route(id),{...post(f),headers:{...post(f).headers,'content-type':'text/plain'}})).status,415);
 assert.equal((await wire(f,route(id),{...post(f),headers:{...post(f).headers,'transfer-encoding':'chunked'},body:Buffer.alloc(70*1024)})).status,413);
 assert.equal((await readFile(f.log,'utf8').catch(()=>'')),'');
});

test('revocation during inspection rejects publication with no worker details leaked',async t=>{
 const f=await fixture(t,'gate'),id=randomUUID();const preparing=wire(f,route(id),post(f));await called(f);await f.auth.revoke(f.phone.deviceId);await writeFile(f.log+'.release','go');
 assert.equal((await preparing).status,401);assert.deepEqual(await readdir(join(f.root,'jobs')),[]);
});

test('disconnect cancels real inspection process; subsequent request can recover the same UUID',async t=>{
 const f=await fixture(t,'gate'),id=randomUUID();const req=httpRequest(f.server.url+route(id),{method:'POST',headers:{...forwarded,...f.headers,...post(f).headers}});req.on('error',()=>{});req.end(post(f).body);await called(f);
 assert.equal((await wire(f,`/v1/saved-projects/${fit.id}`)).status,429);req.destroy();await f.server.close();assert.deepEqual(await readdir(join(f.root,'jobs')),[]);
 await writeFile(f.log+'.release','go');f.server=await startGenerationServer({port:0,remoteAuth:f.auth,capture:{storage:f.storage,preparedJobs:f.makeJobs()}});
 assert.equal((await get(f,id)).status,404);assert.equal((await wire(f,route(id),post(f))).status,201);
});

test('changed project or corrupted retained file rejects reopen',async t=>{
 const f=await fixture(t),id=randomUUID();assert.equal((await wire(f,route(id),post(f))).status,201);
 await chmod(join(f.root,'jobs',id,'printable.bin'),0o600);await writeFile(join(f.root,'jobs',id,'printable.bin'),'bad');assert.equal((await get(f,id)).status,422);
 await f.projects.change(fit.id,2,{kind:'replace-brief',brief:{object:'Changed',context:'Desk',addition:'Holder'}});assert.equal((await get(f,id)).status,412);
});

test('prepared HTTP cannot be enabled anonymously or with an uninspected store',async t=>{
 await assert.rejects(startGenerationServer({port:0,capture:{storage:{},preparedJobs:{}}}),/authentication/i);
 const f=await fixture(t);await assert.rejects(startGenerationServer({port:0,remoteAuth:f.auth,capture:{storage:f.storage,preparedJobs:new PreparedJobStore(f.storage,join(f.root,'other'))}}),/inspect/i);
});


test('explicit prepared pairing and CLI configuration enable a fresh listener without enlarging old scopes',async t=>{
 const f=await fixture(t);await f.server.close();
 const cli=file=>fileURLToPath(new URL('../dist/'+file,import.meta.url));
 const run=(file,args,env={})=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[cli(file),...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CLI timeout'));},5000);
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
 });
 const paired=await run('remote-auth-cli.js',['pair-prepared',join(f.root,'auth'),'alice@example.test']);assert.equal(paired.code,0,paired.err);
 const phone=await f.auth.exchange('alice@example.test',{code:JSON.parse(paired.out).code,deviceName:'prepared only'});
 assert.deepEqual(phone.scopes,['generation:health','projects:read','projects:write','prepared-jobs:read','prepared-jobs:prepare']);
 assert.ok(!phone.scopes.includes('generation:create'));assert.ok(!phone.scopes.includes('captures:import'));
 const configuration=join(f.root,'inspector.json');
 const env={SCAN_TO_MAKE_REMOTE_AUTH_DIR:join(f.root,'auth'),SCAN_TO_MAKE_CAPTURE_DIR:f.root,SCAN_TO_MAKE_PREPARED_MCP_CONFIG:configuration,SCAN_TO_MAKE_GENERATION_PORT:'0'};
 await writeFile(configuration,JSON.stringify({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),'ok',f.log]}),{mode:0o644});
 assert.notEqual((await run('generation-cli.js',[],env)).code,0);
 await chmod(configuration,0o600);
 const child=spawn(process.execPath,[cli('generation-cli.js')],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const url=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('listener timeout')),5000);child.on('exit',()=>{clearTimeout(timer);reject(Error('listener exited'));});child.stdout.on('data',b=>{out+=b;const match=/ready at (http:\/\/[^\s]+)/.exec(out);if(match){clearTimeout(timer);resolve(match[1]);}});});
 const client={...f,server:{url},headers:{authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId}};
 const id=randomUUID();assert.equal((await wire(client,route(id),post(client))).status,201);assert.deepEqual((await get(client,id,true)).bytes,bytes);
 const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await stopped;
});
