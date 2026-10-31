import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {sizeFixture} from './fixtures/model-size.mjs';
const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url),'utf8')).expected;
test('paired size API persists choices, enforces scopes/preconditions, and serves the immutable artifact',async t=>{
 const f=await sizeFixture(t),remoteAuth=await RemoteAuthStore.create(join(f.root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const pair=async scopes=>{const invite=await remoteAuth.createPairing('alice@example.test',scopes);return remoteAuth.exchange('alice@example.test',{code:invite.code,deviceName:'Test'});};
 const phone=await pair(['projects:read','captures:read','captures:import']),reader=await pair(['captures:read']);
 const server=await startCompanionServer({port:0,remoteAuth,capture:{storage:f.storage,captures:f.captures,scanProcessing:f.store,modelSize:f.sizes}});t.after(()=>server.close());
 const {savedProjectETag}=await import('@scan-to-make/project');
 const etag=savedProjectETag(await f.storage.read('test')),base=`/v1/saved-projects/test/captures/${f.input.captureId}/scan-processing/${f.job.jobId}/size`;
 const once=(path,method='GET',value,device=phone,headers={})=>new Promise((resolve,reject)=>{
  const req=httpRequest(server.url+path,{method,headers:{...forwarded,authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId,'if-match':etag,'content-type':'application/json',...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>setImmediate(()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)})));res.on('error',reject);
  });req.on('error',reject);req.end(value===undefined?undefined:JSON.stringify(value));
 });
 const wire=async(...args)=>{
  const response=await once(...args);
  for(let i=0;;i++){const ready=await once('/v1/saved-projects/test');if(ready.status!==429)break;assert(i<50,'capture slot stayed busy: '+ready.bytes.toString());await new Promise(r=>setTimeout(r,10));}
  return response;
 };
 const url=base+'?projectRevision=0';
 assert.equal(JSON.parse((await wire(url)).bytes).size.revision,0);
 for(const [path,method,body,device,headers,expected] of [
  [url,'POST',f.request,reader,{},403],
  [url,'POST',{...f.request,scale_x:2},phone,{},400],
  [url,'POST',f.request,phone,{'if-match':'"'+'0'.repeat(64)+'"'},412],
  [url+'&projectRevision=0','GET',undefined,phone,{},400],
  [url,'DELETE',undefined,phone,{},405],
  [base.replace(f.input.captureId,'ffffffff-ffff-4fff-8fff-ffffffffffff')+'?projectRevision=0','GET',undefined,phone,{},404],
 ])assert.equal((await wire(path,method,body,device,headers)).status,expected);
 const refused=await wire(url,'POST',{...f.request,dimensionsMm:{length:100,width:45.2,height:21.7}});
 assert.equal(refused.status,422);assert.equal(JSON.parse(refused.bytes).error.message,"Your scan is too far from Apple's size to fix safely. Scan again, or keep the scanned size.");
 const saved=await wire(url,'POST',f.request);assert.equal(saved.status,200,saved.bytes.toString());const {size}=JSON.parse(saved.bytes);
 assert.equal(size.revision,1);assert.deepEqual(JSON.parse((await wire(url)).bytes).size,size);
 assert.equal((await wire(url,'POST',f.request)).status,409);
 const artifact=await wire(base+'/artifacts/'+size.artifact.id+'?projectRevision=0');
 assert.equal(artifact.status,200);assert.equal(artifact.headers['x-content-sha256'],size.artifact.sha256);assert.equal(artifact.headers['content-type'],'model/stl');assert.equal(artifact.bytes.length,size.artifact.byteLength);
});
