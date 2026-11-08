import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {savedProjectETag} from '@scan-to-make/project';
import {createCaptureRoutes} from '../dist/capture-http.js';
import {fixture,cleanupRunner} from './fixtures/scan-processing.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
for(const action of ['download','disconnect','shutdown'])test(`response drain: ${action} while the previous download releases its project lock`,async t=>{
 const f=await fixture(t,cleanupRunner()),{job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 const routes=createCaptureRoutes({storage:f.storage,captures:f.captures,scanProcessing:f.store});
 const held=deferred(),release=deferred(),secondArrived=deferred(),secondHandled=deferred(),secondClosed=deferred();let firstResponse,requests=0,paused=false,secondEntered=false,storageCalls=0;
 const withCurrent=f.storage.withCurrentProject.bind(f.storage);
 f.storage.withCurrentProject=(id,revision,fn,...rest)=>{
  storageCalls++;
  if(paused)secondEntered=true;
  return withCurrent(id,revision,async project=>{
   const result=await fn(project);
   // Pause the real edit lock after response finish, before its async unlink.
   if(firstResponse?.writableFinished&&!paused){paused=true;held.resolve();await release.promise;paused=false;firstResponse=undefined;}
   return result;
  },...rest);
 };
 const server=createServer((req,res)=>{
  const first=++requests===1;
  if(first)firstResponse=res;else {res.once('close',()=>secondClosed.resolve());secondArrived.resolve();}
  void routes.handle(req,res,async()=>{},name=>req.headers[name]).finally(()=>{if(!first)secondHandled.resolve();});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{release.resolve();await routes.close();await new Promise(r=>server.close(r));});
 const path=`/v1/saved-projects/test/captures/${f.input.captureId}/scan-processing/${job.jobId}/artifacts/repaired.stl?projectRevision=0`;
 const headers={'if-match':savedProjectETag(await f.storage.read('test'))};
 let secondRequest;
 const get=()=>new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port:server.address().port,path,headers},res=>{
   const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks)}));res.on('error',reject);
  });if(requests)secondRequest=req;req.on('error',reject);req.end();
 });
 try{
  const first=await get();assert.equal(first.status,200);await held.promise;
  const next=get();next.catch(()=>{});await secondArrived.promise;await nextTurn();
  assert.equal(secondEntered,false,'next request entered the still-held project lock');
  let closing;
  if(action==='disconnect'){
   secondRequest.destroy();await assert.rejects(next);await secondClosed.promise;
   const calls=storageCalls;release.resolve();await secondHandled.promise;assert.equal(storageCalls,calls);return;
  }
  if(action==='shutdown')closing=routes.close();
  release.resolve();const second=await next;
  if(action==='shutdown'){assert.equal(second.status,503);await closing;assert.equal(secondEntered,false);}
  else{assert.equal(second.status,200,second.bytes.toString());assert.deepEqual(second.bytes,first.bytes);}
 }finally{release.resolve();}
});
