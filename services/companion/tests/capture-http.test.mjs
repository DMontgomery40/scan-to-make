import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {CaptureStore} from '../dist/capture-import.js';
import {createCaptureConverter} from '../dist/capture-converter.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url),'utf8')).expected;
const python=process.env.CAPTURE_TEST_PYTHON??'python3';
const project={formatVersion:'0.2.0',id:'phone',revision:7,brief:{object:'Bottle',context:'Drawer',addition:'Holder'},fit:null,preview:null,acceptedArtifact:null};
async function fixture(t,wrap=x=>x){
 const root=await mkdtemp(join(tmpdir(),'capture-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const remoteAuth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invitation=await remoteAuth.createPairing('alice@example.test',['projects:read','projects:write','captures:read','captures:import']);
 const phone=await remoteAuth.exchange('alice@example.test',{code:invitation.code,deviceName:'Fixture'});
 const storage=new FileSavedProjectStorage(join(root,'projects'));
 const captures=new CaptureStore(storage,join(root,'captures'),wrap(createCaptureConverter({executable:python,temporaryRoot:join(root,'workers')})));
 const server=await startCompanionServer({port:0,remoteAuth,capture:{storage,captures}});t.after(()=>server.close());
 const headers={authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId};
 return {root,remoteAuth,phone,storage,captures,server,headers};
}
function wire(f,path,{method='GET',headers={},body}={}){
 return new Promise((resolve,reject)=>{
  const req=httpRequest(f.server.url+path,{method,headers:{...forwarded,...f.headers,...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
  });req.on('error',reject);req.end(body);
 });
}
async function readWithBusyRetry(f,path,options={}){
 // Explicit rejection is safe to retry for reads. Never retry ambiguous capture POST.
 for(let attempt=0;attempt<50;attempt++){
  const result=await wire(f,path,options);if(result.status!==429)return result;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Capture cleanup remained busy');
}
async function sync(f){
 const result=await wire(f,'/v1/saved-projects/phone',{method:'PUT',headers:{'content-type':'application/json','if-none-match':'*'},body:JSON.stringify(project)});
 assert.equal(result.status,201);return result.headers.etag;
}
async function source(f){
 const dest=join(f.root,'fixtures');await promisify(execFile)(python,[fileURLToPath(new URL('../../../tools/capture-mesh-convert/make_fixtures.py',import.meta.url)),dest]);
 return readFile(join(dest,'two_layer.usdz'));
}
const route='/v1/saved-projects/phone/captures?projectRevision=7';
const importOptions=(etag,body)=>({method:'POST',headers:{'content-type':'model/vnd.usdz+zip','if-match':etag},body});

test('authenticated HTTP sync imports real USDZ then reopens metadata and exact source bytes',async t=>{
 const f=await fixture(t),etag=await sync(f),bytes=await source(f);
 const imported=await wire(f,route,importOptions(etag,bytes));assert.equal(imported.status,201);
 const result=JSON.parse(imported.bytes);assert.equal(result.binding.projectRevision,7);assert.equal(result.binding.capture.evidence.physicalFit,'unknown');
 const path=`/v1/saved-projects/phone/captures/${result.captureId}`;
 const metadata=await readWithBusyRetry(f,path+'?projectRevision=7',{headers:{'if-match':etag}});assert.equal(metadata.status,200);
 const original=await readWithBusyRetry(f,path+'/artifacts/original?projectRevision=7',{headers:{'if-match':etag}});
 assert.equal(original.status,200);assert.deepEqual(original.bytes,bytes);assert.equal(original.headers['content-type'],'model/vnd.usdz+zip');
 assert.equal(original.headers['x-content-sha256'],result.binding.capture.original.sha256);
 const reopened=await readWithBusyRetry(f,'/v1/saved-projects/phone');assert.equal(reopened.headers.etag,etag);assert.deepEqual(JSON.parse(reopened.bytes),project);
 await writeFile(join(f.root,'captures',result.captureId,'mesh.obj'),'corrupted');
 assert.equal((await readWithBusyRetry(f,path+'?projectRevision=7',{headers:{'if-match':etag}})).status,422);
});

test('generation-only, revoked, browser and wrong-snapshot requests fail before capture import',async t=>{
 const f=await fixture(t),etag=await sync(f);
 const invite=await f.remoteAuth.createPairing('alice@example.test');const old=await f.remoteAuth.exchange('alice@example.test',{code:invite.code,deviceName:'Old generation'});
 const headers={authorization:`Bearer ${old.token}`,'x-scan-device':old.deviceId};
 assert.equal((await wire(f,'/v1/saved-projects/phone',{headers})).status,403);
 assert.equal((await wire(f,route,{...importOptions(etag,Buffer.from('x')),headers:{...importOptions(etag).headers,...headers}})).status,403);
 assert.equal((await wire(f,'/v1/saved-projects/phone',{headers:{origin:'https://foreign.test'}})).status,403);
 assert.equal((await wire(f,route,importOptions('"'+'0'.repeat(64)+'"',Buffer.from('x')))).status,412);
 await f.remoteAuth.revoke(f.phone.deviceId);
 assert.equal((await wire(f,'/v1/saved-projects/phone')).status,401);
});

test('HTTP snapshot conflicts, input bounds and unsupported media preserve current state',async t=>{
 const f=await fixture(t),etag=await sync(f);
 const changed=JSON.stringify({...project,brief:{...project.brief,addition:'Different'}});
 assert.equal((await wire(f,'/v1/saved-projects/phone',{method:'PUT',headers:{'content-type':'application/json','if-match':etag},body:changed})).status,409);
 assert.equal((await wire(f,route,{method:'POST',headers:{'if-match':etag,'content-type':'text/plain'},body:'x'})).status,415);
 assert.equal((await wire(f,route,{method:'POST',headers:{'if-match':etag,'content-type':'model/vnd.usdz+zip','content-length':String(33*1024*1024)}})).status,413);
 assert.equal((await wire(f,'/v1/saved-projects/phone')).headers.etag,etag);
});

test('revocation during actual conversion prevents publication',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,worker=>({convert:async(...args)=>{entered();await gate;return worker.convert(...args);}}));
 const etag=await sync(f),bytes=await source(f);const importing=wire(f,route,importOptions(etag,bytes));await started;
 await f.remoteAuth.revoke(f.phone.deviceId);release();assert.equal((await importing).status,401);
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('capture routes cannot be enabled in anonymous local mode',async()=>{
 await assert.rejects(startCompanionServer({port:0,capture:{storage:{},captures:{}}}),/authentication/i);
});

test('project edit during conversion rejects stale publication through HTTP',async t=>{
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const f=await fixture(t,worker=>({convert:async(...args)=>{entered();await gate;return worker.convert(...args);}}));
 const etag=await sync(f),bytes=await source(f);const importing=wire(f,route,importOptions(etag,bytes));await started;
 // A native/local edit cooperates with the same storage lock while the worker is running.
 const old=await f.storage.read('phone');await f.storage.compareAndSwap('phone',old,JSON.stringify({...project,revision:8}));
 release();assert.equal((await importing).status,412);assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('disconnect aborts active conversion; busy slot and server shutdown retain cleanup ownership',async t=>{
 let entered,cancelled;const started=new Promise(r=>entered=r),aborted=new Promise(r=>cancelled=r);
 const f=await fixture(t,()=>({convert:async(_bytes,signal)=>{entered();await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{cancelled();reject(new Error('aborted'));},{once:true}));}}));
 const etag=await sync(f);
 const req=httpRequest(f.server.url+route,{method:'POST',headers:{...forwarded,...f.headers,...importOptions(etag).headers}});
 req.on('error',()=>{});req.end('isolated pending source');await started;
 assert.equal((await wire(f,'/v1/saved-projects/phone')).status,429);
 req.destroy();await aborted;await f.server.close();
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('chunked oversized source is rejected by observed bytes without invoking conversion',async t=>{
 let conversions=0;const f=await fixture(t,()=>({convert:async()=>{conversions++;throw new Error('must not run');}}));const etag=await sync(f);
 const result=await wire(f,route,{...importOptions(etag,Buffer.alloc(32*1024*1024+1)),headers:{...importOptions(etag).headers,'transfer-encoding':'chunked'}});
 assert.equal(result.status,413);assert.equal(conversions,0);
});

test('snapshot PUT rechecks authorization at the locked commit boundary',async t=>{
 const f=await fixture(t),etag=await sync(f);let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const cas=f.storage.compareAndSwap.bind(f.storage);
 f.storage.compareAndSwap=async(...args)=>{entered();await gate;return cas(...args);};
 const updating=wire(f,'/v1/saved-projects/phone',{method:'PUT',headers:{'content-type':'application/json','if-match':etag},body:JSON.stringify({...project,revision:8})});
 await started;await f.remoteAuth.revoke(f.phone.deviceId);release();
 assert.equal((await updating).status,401);assert.equal(JSON.parse(await f.storage.read('phone')).revision,7);
});

test('disconnected snapshot upload cannot commit or leave shutdown waiting on an already closed response',async t=>{
 const f=await fixture(t),etag=await sync(f);let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const cas=f.storage.compareAndSwap.bind(f.storage);f.storage.compareAndSwap=async(...args)=>{entered();await gate;return cas(...args);};
 const req=httpRequest(f.server.url+'/v1/saved-projects/phone',{method:'PUT',headers:{...forwarded,...f.headers,'content-type':'application/json','if-match':etag}});req.on('error',()=>{});
 req.end(JSON.stringify({...project,revision:8}));await started;req.destroy();
 const closing=f.server.close();release();await closing;
 assert.equal(JSON.parse(await f.storage.read('phone')).revision,7);
});
