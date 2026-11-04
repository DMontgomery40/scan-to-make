import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ModelAccessService} from '../dist/model-access.js';
import {RuntimeSettings} from '../dist/runtime-settings.js';
const claimantId=randomUUID();

async function fixture(t) {
  const root=await mkdtemp('/tmp/stm-runtime-settings-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const ai=await ModelAccessService.open(root,async()=>({exitCode:0,stdout:'{"ok":true}'}));
  t.after(()=>ai.close());
  let now=1000;const events=[];
  const service=new RuntimeSettings({modelAccess:ai,now:()=>now,emit:async event=>events.push(event)});
  return {ai,service,events,advance:ms=>{now+=ms;}};
}
test('phone AI projection excludes credentials/references and reuses exact revision checks',async t=>{
  const {ai,service}=await fixture(t);
  const keychainRef=randomUUID();
  await ai.set(ai.get().revision,{kind:'api',provider:'openai',model:'gpt-5',keychainRef});
  const snapshot=service.snapshot().ai;
  assert.equal(snapshot.scope,'model-jobs');
  assert.deepEqual(snapshot.choice,{kind:'api',provider:'openai',model:'gpt-5'});
  assert(!JSON.stringify(snapshot).includes(keychainRef));
  await assert.rejects(service.setAI({expectedRevision:snapshot.revision,choice:{kind:'endpoint',url:'http://localhost',model:'x'}}));
  await service.setAI({expectedRevision:snapshot.revision,choice:{kind:'codex-cli'}});
  await assert.rejects(service.setAI({expectedRevision:snapshot.revision,choice:{kind:'none'}}),e=>e.code==='conflict');
  assert.throws(()=>service.testAI(snapshot.revision),e=>e.code==='conflict');
  service.testAI(ai.get().revision);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(service.snapshot().ai.check.state,'connected');
});
test('Fusion is app-owned, claimed once and completion is bound to the current request',async t=>{
  const {service,events,advance}=await fixture(t);
  assert.equal(service.snapshot().fusion.state,'unavailable');
  await assert.rejects(service.requestFusion(),e=>e.code==='unavailable');
  await service.reportFusion({installed:true,configured:false,running:false});
  assert.equal(service.snapshot().fusion.state,'not-set-up');
  await service.requestFusion();await service.requestFusion();
  assert.equal(events.length,2,'one availability change plus one deduplicated setup request');
  const {requestId}=service.claimFusion(claimantId);assert.ok(requestId);
  assert.deepEqual(service.claimFusion(randomUUID()),{});
  await assert.rejects(()=>service.completeFusion({requestId:randomUUID(),ok:true}),e=>e.code==='conflict');
  await service.completeFusion({requestId,ok:true});
  assert.equal(service.snapshot().fusion.state,'connected');
  assert.match(service.snapshot().fusion.message,/last setup/i);
  advance(91_000);
  assert.equal(service.snapshot().fusion.state,'unavailable','offline Mac does not retain connected claim');
  await service.reportFusion({installed:true,configured:true,running:false});
  assert.equal(service.snapshot().fusion.state,'not-running');
});
test('removing setup configuration invalidates a prior successful check while Fusion stays running',async t=>{
  const {service}=await fixture(t);
  for(const report of [{installed:true,configured:false,running:true},{installed:false,configured:true,running:true}]) {
    await service.reportFusion({installed:true,configured:true,running:true});
    await service.requestFusion();const claimed=service.claimFusion(claimantId);await service.completeFusion({...claimed,ok:true});
    assert.equal(service.snapshot().fusion.state,'connected');
    await service.reportFusion(report);
    assert.notEqual(service.snapshot().fusion.state,'connected');
  }
});
test('passive Fusion changes refresh phone settings but heartbeat-only reports stay silent',async t=>{
  const {service,events,advance}=await fixture(t);
  await service.reportFusion({installed:true,configured:false,running:false});
  assert.equal(events.length,1);
  advance(30_000);
  await service.reportFusion({installed:true,configured:false,running:false});
  assert.equal(events.length,1,'timestamp refresh is not a user-visible change');
  await service.reportFusion({installed:true,configured:true,running:true});
  assert.equal(events.length,2);
  await service.requestFusion();const claimed=service.claimFusion(claimantId);await service.completeFusion({...claimed,ok:true});
  const before=events.length;
  await service.reportFusion({installed:true,configured:true,running:false});
  assert.equal(events.length,before+1,'closing Fusion invalidates displayed last success promptly');
  assert.equal(service.snapshot().fusion.state,'not-running');
  assert.equal(events.at(-1).type,'settings.changed');
  assert.deepEqual(events.at(-1).data,{keys:['fusion']});
});
test('Fusion timeout is retryable and old completion cannot settle the next request',async t=>{
  const {service,advance}=await fixture(t);
  await service.reportFusion({installed:true,configured:false,running:false});await service.requestFusion();
  const first=service.claimFusion(claimantId);advance(601_000);
  await service.reportFusion({installed:true,configured:false,running:false});
  assert.match(service.snapshot().fusion.message,/timed out/i);
  await service.requestFusion();const second=service.claimFusion(claimantId);
  assert.notEqual(first.requestId,second.requestId);
  await assert.rejects(()=>service.completeFusion({...first,ok:true}),e=>e.code==='conflict');
  await service.completeFusion({...second,ok:false});
  assert.equal(service.snapshot().fusion.state,'not-set-up');
});

test('real server and local socket bridge preserve CAS, permissions and Mac-only Fusion completion',async t=>{
  const {ai,service:runtime,events}=await fixture(t);
  const {join}=await import('node:path');
  const {readFile}=await import('node:fs/promises');
  const {RemoteAuthStore}=await import('../dist/remote-auth.js');
  const {ObjectStore}=await import('../dist/objects/store.js');
  const {ObjectService}=await import('../dist/objects/service.js');
  const {CompanionSettingsStore}=await import('../dist/settings.js');
  const {startCompanionServer}=await import('../dist/server.js');
  const {createControlDispatcher}=await import('../dist/local-control-services.js');
  const root=await mkdtemp('/tmp/stm-runtime-http-');t.after(()=>rm(root,{recursive:true,force:true}));
  const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
  async function phone(scopes){const {code}=await auth.createPairing('alice@example.test',scopes);return auth.exchange('alice@example.test',{code,deviceName:'Test'});}
  const full=await phone(['projects:read','projects:write']),readOnly=await phone(['projects:read']);
  const objects=new ObjectService({store:new ObjectStore(join(root,'objects')),settings:new CompanionSettingsStore(join(root,'settings.json')),runtimeSettings:runtime,
    claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},runTouchup:async()=>{throw Error('unused');},stlInfo:async()=>undefined,events:{emit:async event=>events.push(event)}});
  const server=await startCompanionServer({port:0,remoteAuth:auth,objects});
  t.after(async()=>{await server.close();await objects.close();});
  const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url),'utf8')).expected;
  async function request(path,method='GET',body,credential=full){
    const {request:send}=await import('node:http');
    return new Promise((resolve,reject)=>{
      const req=send(server.url+path,{method,headers:{...forwarded,authorization:`Bearer ${credential.token}`,'x-scan-device':credential.deviceId,'content-type':'application/json'}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  const dispatch=createControlDispatcher({auth,objects,runtimeSettings:runtime,modelAccess:ai,companionVersion:'test'});
  const read=await request('/v1/settings');assert.equal(read.status,200);
  assert.deepEqual((await dispatch('settings.get',{})).settings,read.body.settings);
  const expected=JSON.parse(await readFile(new URL('../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/runtime-settings.json',import.meta.url),'utf8'));
  const normalized=structuredClone(read.body);normalized.settings.ai.revision=expected.settings.ai.revision;
  assert.deepEqual(normalized,expected,'same wire fixture consumed by the Swift phone client');
  const revision=read.body.settings.ai.revision;
  const change={ai:{expectedRevision:revision,choice:{kind:'claude-code'}}};
  assert.equal((await request('/v1/settings','PATCH',change,readOnly)).status,403);
  assert.equal((await request('/v1/settings','PATCH',change)).status,200);
  assert.equal((await request('/v1/settings','PATCH',{...change,general:{showInDock:false}})).status,400);
  assert.equal((await request('/v1/settings','PATCH',change)).status,409);
  assert.equal((await request('/v1/settings','PATCH',{ai:{expectedRevision:ai.get().revision,choice:{kind:'api',keychainRef:randomUUID()}}})).status,400);
  assert.equal((await request('/v1/settings/ai/test','POST',{revision},readOnly)).status,403);
  assert.equal((await request('/v1/settings/ai/test','POST',{revision})).status,409);
  assert.equal((await request('/v1/settings/ai/test','POST',{revision:ai.get().revision})).status,200);
  await dispatch('fusion.report',{installed:true,configured:false,running:false});
  assert.equal((await request('/v1/settings/fusion/setup','POST',{},readOnly)).status,403);
  assert.equal((await request('/v1/settings/fusion/setup','POST',{})).status,200);
  const claimed=await dispatch('fusion.claimSetup',{claimantId});assert.ok(claimed.requestId);
  assert.deepEqual(await dispatch('fusion.claimSetup',{claimantId}),claimed);
  assert.deepEqual(await dispatch('fusion.claimSetup',{claimantId:randomUUID()}),{});
  assert.equal((await request('/v1/settings/fusion/setupDone','POST',{...claimed,ok:true})).status,404);
  await dispatch('fusion.setupDone',{...claimed,ok:false,message:'Open Fusion on your Mac, then try again.'});
  assert.match((await request('/v1/settings')).body.settings.fusion.message,/Open Fusion/);
});

test('a lost Fusion claim reply can be replayed only by the same claimant until expiry',async t=>{
  const {service,advance}=await fixture(t);
  const owner=randomUUID(),other=randomUUID();
  await service.reportFusion({installed:true,configured:false,running:false});await service.requestFusion();
  const lost=service.claimFusion(owner);assert.ok(lost.requestId);
  assert.deepEqual(service.claimFusion(owner),lost,'same coordinator recovers the response it did not receive');
  assert.deepEqual(service.claimFusion(other),{},'another app instance cannot take over active setup');
  advance(601_000);await service.reportFusion({installed:true,configured:false,running:false});
  assert.deepEqual(service.claimFusion(owner),{});
  await assert.rejects(service.completeFusion({...lost,ok:true}),e=>e.code==='conflict');
  await service.requestFusion();assert.ok(service.claimFusion(other).requestId,'explicit retry after expiry can use a new app instance');
});
