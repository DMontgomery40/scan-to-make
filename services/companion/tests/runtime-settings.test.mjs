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

test('fusion.setup asks the printer MCP the companion runs, and passes its answer to the Mac as it is',async()=>{
  const {createControlDispatcher}=await import('../dist/local-control-services.js');
  const asked=[];
  const fusionSetup=async install=>{asked.push(install);return {setup:{fusion:{installed:true,path:'/Applications/Autodesk Fusion.app'},ready:install},server:'bambu-printer-mcp'};};
  const dispatch=createControlDispatcher({auth:{},companionVersion:'test',fusionSetup});
  assert.deepEqual(await dispatch('fusion.setup',{install:false}),{setup:{fusion:{installed:true,path:'/Applications/Autodesk Fusion.app'},ready:false},server:'bambu-printer-mcp'});
  assert.equal((await dispatch('fusion.setup',{install:true})).setup.ready,true);
  assert.deepEqual(asked,[false,true]);
  await assert.rejects(dispatch('fusion.setup',{}),'install is required');
  await assert.rejects(dispatch('fusion.setup',{install:true,command:'/bin/sh'}),'nothing else is passed through');
  await assert.rejects(createControlDispatcher({auth:{},companionVersion:'test'})('fusion.setup',{install:false}),{code:'unavailable'});
});

test('fusion.status asks the printer MCP as the companion runs it (with its Move override), and passes its structured result as it is',async t=>{
  const {createControlDispatcher}=await import('../dist/local-control-services.js');
  const {fusionCalls}=await import('../dist/fusion-calls.js');
  const {McpOverrides}=await import('../dist/printing/mcp-updates.js');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'fusion-status-'));t.after(()=>rm(root,{recursive:true,force:true}));
  // printer-handoff.json's own route is ssh to an older copy; the Move left an override to Counterpart's copy (Nov 6).
  const profile={backend:'bambu-printer-mcp',process:{command:'/usr/bin/ssh',args:['-i','/k','me@127.0.0.1']}};
  const overrides=new McpOverrides(join(root,'overrides.json'));await overrides.load();
  await overrides.set('current',{command:'/node',args:['/app/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js']},profile);
  const started=[],calls=[];let tools=['fusion_mcp_status','fusion_mcp_setup'],reply={structuredContent:{configured:true,connected:true,addinReachable:true,fusionRunning:true,activeDesign:false,tools:[]},content:[{type:'text',text:'{}'}]};
  const client=config=>({connect:async()=>{started.push(config.process);},hasTool:name=>tools.includes(name),
    callTool:async(name,args)=>{calls.push([name,args]);return reply;},close:async()=>{}});
  const {fusionSetup,fusionStatus}=fusionCalls(()=>overrides.apply(profile,overrides.peek('current',profile)),client);
  const dispatch=createControlDispatcher({auth:{},companionVersion:'test',fusionSetup,fusionStatus});
  const answer=await dispatch('fusion.status',{});
  assert.deepEqual([started[0].command,started[0].args],['/node',['/app/printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js']],'never the ssh route');
  assert.deepEqual(calls[0],['fusion_mcp_status',{launch:true,timeout_ms:90_000}]);
  assert.deepEqual(answer,{status:reply.structuredContent,server:'bambu-printer-mcp'});
  await dispatch('fusion.setup',{install:false});
  assert.equal(started[1].command,'/node','Set Up and its check run the same copy');
  reply={isError:true,content:[{type:'text',text:'Fusion MCP timed out during connect.'}]};
  assert.deepEqual(await dispatch('fusion.status',{}),{status:null,server:'bambu-printer-mcp',error:'Fusion MCP timed out during connect.'});
  // The real client throws an error result (Codex P2 on #377): its diagnostic is still the answer, for both calls.
  const {PrinterMcpError}=await import('@scan-to-make/printer-handoff');
  reply=null;const thrown=new PrinterMcpError('tool-failed',undefined,'Fusion MCP timed out during discovery.');
  const throwing=fusionCalls(()=>profile,config=>({...client(config),callTool:async()=>{throw thrown;}}));
  assert.deepEqual(await throwing.fusionStatus(),{status:null,server:'bambu-printer-mcp',error:'Fusion MCP timed out during discovery.'});
  assert.deepEqual(await throwing.fusionSetup(false),{setup:null,server:'bambu-printer-mcp',error:'Fusion MCP timed out during discovery.'});
  const broken=fusionCalls(()=>profile,config=>({...client(config),callTool:async()=>{throw new PrinterMcpError('connection-lost');}}));
  await assert.rejects(broken.fusionStatus(),{code:'connection-lost'},'a lost connection is not an answer');
  tools=[];
  assert.deepEqual(await dispatch('fusion.status',{}),{status:null,server:'bambu-printer-mcp'},'an MCP without the tool: the Mac says Update it');
  await assert.rejects(dispatch('fusion.status',{launch:false}),'nothing is passed through');
  await assert.rejects(createControlDispatcher({auth:{},companionVersion:'test'})('fusion.status',{}),{code:'unavailable'});
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
