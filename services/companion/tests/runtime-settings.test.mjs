import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ModelAccessService} from '../dist/model-access.js';
import {RuntimeSettings} from '../dist/runtime-settings.js';
import {tempDir} from './support/temp.mjs';
const claimantId=randomUUID();

async function fixture(t) {
  const root=await tempDir('stm-runtime-settings-');
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
  const root=await tempDir('stm-runtime-http-');t.after(()=>rm(root,{recursive:true,force:true}));
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
  const root=await tempDir('fusion-status-');t.after(()=>rm(root,{recursive:true,force:true}));
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
  // The real client's shape for a connection that closed mid-call (Codex P2 on #377): tool-failed, incomplete. Not an answer.
  const {PrinterMcpError:Refused}=await import('@scan-to-make/printer-handoff');
  const lost=Object.assign(new Refused('tool-failed',undefined,'connection closed'),{incomplete:true});
  const closingStatus=fusionCalls(()=>profile,config=>({...client(config),callTool:async()=>{throw lost;}}));
  await assert.rejects(closingStatus.fusionStatus(),error=>error===lost,'the status call itself');
  // The MCP says whether a design is open (activeDesign); the companion never reads the design itself.
  tools=['fusion_mcp_status','fusion_mcp_setup','fusion_mcp_call'];
  reply={structuredContent:{configured:true,connected:true,addinReachable:true,fusionRunning:true,tools:[]},content:[{type:'text',text:'{}'}]};calls.length=0;
  assert.equal('design' in await dispatch('fusion.status',{}),false);
  assert.deepEqual(calls.map(c=>c[0]),['fusion_mcp_status']);
  tools=['fusion_mcp_status','fusion_mcp_setup'];
  reply={structuredContent:{configured:true,connected:true,addinReachable:true,fusionRunning:true,activeDesign:false,tools:[]},content:[{type:'text',text:'{}'}]};
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

// Settings → the code design engine (PRD §8.9): the printer MCP's cad_status and cad_setup, as every layout shows them.
test('the code design engine row: from cad_status, Set Up runs cad_setup in the background with progress, and its failure is the MCP\'s own words', async () => {
  const {CadSettings, CadSetupRefused} = await import('../dist/cad-settings.js');
  const events = [];
  let status = {configured: false, ready: false, python: null, build123d: '0.13.0', platform: 'darwin', error: 'Run cad_setup with install: true to install and verify the confined CAD runtime.'};
  let finish, progress;
  let statusCalls = 0;
  const calls = {
    status: async () => { statusCalls++; return {status, server: 'bambu-printer-mcp'}; },
    setup: onProgress => { progress = onProgress; return new Promise(resolve => { finish = resolve; }); },
  };
  let now = 1_000_000;
  const locks = [];
  const settings = new CadSettings({calls, emit: async event => { events.push(event); }, now: () => now, lock: async () => { locks.push('held'); return async () => { locks.push('released'); }; }});
  const notSetUp = await settings.view();
  assert.deepEqual(notSetUp, {state: 'not-set-up', message: 'Not set up yet.', server: 'bambu-printer-mcp', canSetUp: true});
  assert.doesNotMatch(JSON.stringify(notSetUp), /cad_setup|install: true/, 'the MCP\'s developer text is not the row\'s words');
  // Fresh for 30 s; then asked again. A passive settings read (snapshot) never asks.
  await settings.view(); assert.equal(statusCalls, 1);
  now += 31_000; settings.snapshot(); assert.equal(statusCalls, 1, 'a passive read starts no MCP');
  await settings.view(); assert.equal(statusCalls, 2);
  // Set Up returns at once and shows its progress.
  const started = await settings.setUp();
  assert.equal(started.state, 'setting-up');
  assert.equal(started.canSetUp, false);
  assert.deepEqual(locks, ['held'], 'it takes the code engine\'s turn, so no pass runs during the install');
  now += 25_000; progress();
  assert.equal(settings.current().message, 'Setting up… 25 s so far.');
  assert.ok(events.every(event => event.type === 'settings.changed' && event.data.keys[0] === 'cad'));
  // It finishes: the MCP's own message, and the row reads cad_status again.
  status = {...status, configured: true, ready: true, python: '/cad/python'};
  finish({setup: {supported: true, configured: true, ready: true, installed: true, message: 'CAD is ready; confined import, build, STL and STEP round trip passed.'}, server: 'bambu-printer-mcp'});
  for (let i = 0; i < 50 && settings.current().state === 'setting-up'; i++) await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 50 && settings.current().state !== 'ready'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(settings.current(), {state: 'ready', message: 'Ready. New designs and scan cleanups use it.', server: 'bambu-printer-mcp', canSetUp: true,
    result: {ok: true, message: 'CAD is ready; confined import, build, STL and STEP round trip passed.'}});
  assert.deepEqual(locks, ['held', 'released']);
  // A failed setup keeps the MCP's own reason on the row.
  status = {...status, ready: false};
  await settings.refresh();
  const again = await settings.setUp();
  assert.equal(again.state, 'setting-up');
  finish({setup: null, server: 'bambu-printer-mcp', error: 'Code-CAD on macOS requires an internal disk with file ownership enabled.'});
  for (let i = 0; i < 100 && settings.current().state === 'setting-up'; i++) await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 100 && !settings.current().result; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(settings.current().result, {ok: false, message: 'Code-CAD on macOS requires an internal disk with file ownership enabled.'});
  assert.equal(settings.current().state, 'not-set-up');
  // An MCP without the engine: update it; Set Up isn't offered and is refused.
  const older = new CadSettings({calls: {status: async () => ({status: null, server: 'mcp-3D-printer-server'}), setup: async () => assert.fail('no setup')}, emit: async () => {}});
  assert.deepEqual(await older.view(), {state: 'unavailable', message: 'Update mcp-3D-printer-server in Settings → Printers to use its code design engine.', server: 'mcp-3D-printer-server', canSetUp: false});
  await assert.rejects(older.setUp(), CadSetupRefused);
  // A code pass is running: Set Up waits its turn briefly, then says why it can't start.
  const busy = new CadSettings({calls, emit: async () => {}, lock: async () => { throw new Error('timed out'); }});
  await assert.rejects(busy.setUp(), {name: 'CadSetupRefused', message: 'Wait until the design that is running finishes, then set it up.'});
});

test('cad.status and cad.setup reach the code design engine row over the control socket; a phone reads it in settings and sets it up over HTTP', async t => {
  const {createControlDispatcher} = await import('../dist/local-control-services.js');
  const {CadSettings} = await import('../dist/cad-settings.js');
  const {ObjectStore} = await import('../dist/objects/store.js');
  const {ObjectService} = await import('../dist/objects/service.js');
  const {createObjectRoutes} = await import('../dist/objects/http.js');
  const {createServer} = await import('node:http');
  const {join} = await import('node:path');
  const setups = [];
  const make = () => new CadSettings({calls: {status: async () => ({status: {configured: false, ready: false}, server: 'bambu-printer-mcp'}), setup: () => { setups.push('setup'); return new Promise(() => {}); }}, emit: async () => {}});
  const dispatch = createControlDispatcher({cadSettings: make()});
  assert.equal((await dispatch('cad.status', {})).cad.state, 'not-set-up');
  assert.equal((await dispatch('cad.setup', {})).cad.state, 'setting-up');
  assert.deepEqual(setups, ['setup']);
  await assert.rejects(dispatch('cad.setup', {extra: true}), {code: 'invalid-request'});
  // A phone (or Android) reads the row in GET /v1/settings and presses Set Up with POST /v1/settings/cad/setup.
  const root = await tempDir('stm-cad-http-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const cadSettings = make();
  const service = new ObjectService({store: new ObjectStore(join(root, 'objects')), runTouchup: async () => assert.fail('no pass'), stlInfo: async () => [1, 1, 1], claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, events: {emit: async () => {}}, cadSettings});
  t.after(() => service.close());
  await cadSettings.refresh();
  const scopes = [];
  const routes = createObjectRoutes(service);
  const server = createServer((request, response) => void routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/settings`;
  assert.equal((await (await fetch(base)).json()).settings.cad.state, 'not-set-up');
  // A passive settings read never starts the printer MCP; the row's own read does.
  const before = cadSettings.current();
  assert.equal((await (await fetch(`${base}/cad`)).json()).cad.state, before.state);
  assert.equal(scopes.at(-1), 'projects:read');
  const pressed = await fetch(`${base}/cad/setup`, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(pressed.status, 200);
  assert.equal((await pressed.json()).settings.cad.state, 'setting-up');
  assert.equal(scopes.at(-1), 'projects:write', 'Set Up needs the same scope as Fusion\'s Set Up');
  assert.equal((await fetch(`${base}/cad/setup`, {method: 'GET'})).status, 405);
});

// cad/1 (bambu-printer-mcp #136 d2f04c75): storage sizes and structured refusals.
test('the code design engine row shows what Set Up takes, then what it uses, from the MCP\'s storage fields', async () => {
  const {CadSettings, storageWords} = await import('../dist/cad-settings.js');
  const storage = installed => ({expected_download_bytes: 367001600, expected_installed_bytes: 1610612736, installed_bytes: installed, measurement: 'allocated-last-setup'});
  let status = {configured: false, ready: false, python: null, build123d: '0.13.0', platform: 'darwin', storage: storage(0)};
  let finish;
  const settings = new CadSettings({calls: {status: async () => ({status, server: 'bambu-printer-mcp'}), setup: () => new Promise(resolve => { finish = resolve; })}, emit: async () => {}});
  assert.equal((await settings.view()).size, 'Set Up downloads about 367 MB and uses about 1.6 GB on this computer.');
  const started = await settings.setUp();
  assert.equal(started.size, 'Set Up downloads about 367 MB and uses about 1.6 GB on this computer.', 'shown while it sets up');
  status = {...status, configured: true, ready: true, python: '/cad/python', storage: {...storage(1395412992), measured_at: '2026-11-10T04:00:00Z'}};
  finish({setup: {supported: true, ...status, installed: true, message: 'CAD is ready.'}, server: 'bambu-printer-mcp'});
  for (let i = 0; i < 100 && settings.current().state !== 'ready'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settings.current().size, 'Uses 1.4 GB on this computer.');
  // An environment present but not yet measured (null), or a status without storage: no size line, never a guess.
  assert.equal(storageWords({expected_download_bytes: 1, expected_installed_bytes: 1, installed_bytes: null}, true), undefined);
  assert.equal(storageWords(undefined, false), undefined);
});

// #639: with the Mac at load ~600 the check timed out, and the row said "Counterpart couldn't check your printer MCP.
// Check it in Settings → Printers." A slow computer is not a broken MCP: it says so and checks again by itself.
test('a cad_status check that runs out of time says the computer is busy and checks again by itself; only a real failure sends the person to Settings', async () => {
  const {CadSettings, CadCheckTimedOut, cadCalls} = await import('../dist/cad-settings.js');
  const {PrinterMcpError} = await import('@scan-to-make/printer-handoff');
  const tick = async (check, rounds = 200) => { for (let i = 0; i < rounds && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  // The transport outcome decides, never the MCP's words: connect's own deadline, a request timeout, or ours.
  const config = () => ({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}});
  const failing = (where, error) => () => ({async connect() { if (where === 'connect') throw error; }, async close() {}, hasTool: () => true,
    async callTool() { throw error; }});
  const connectDeadline = new PrinterMcpError('connection-failed', new DOMException('This operation was aborted', 'AbortError'));
  await assert.rejects(cadCalls(config, failing('connect', connectDeadline)).status(), error => error instanceof CadCheckTimedOut && error.server === 'bambu-printer-mcp');
  const requestTimeout = Object.assign(new PrinterMcpError('tool-failed', Object.assign(new Error('MCP error -32001: Request timed out'), {name: 'McpError', code: -32001})), {incomplete: true});
  await assert.rejects(cadCalls(config, failing('call', requestTimeout)).status(), CadCheckTimedOut);
  const ours = AbortSignal.timeout(1); await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(cadCalls(config, failing('call', new PrinterMcpError('cancelled'))).status(ours), CadCheckTimedOut);
  // Not installed, or the process died: not a timeout.
  const missing = new PrinterMcpError('connection-failed', Object.assign(new Error('spawn bambu-printer-mcp ENOENT'), {code: 'ENOENT'}));
  await assert.rejects(cadCalls(config, failing('connect', missing)).status(), error => error === missing);
  const closed = new PrinterMcpError('connection-failed', Object.assign(new Error('MCP error -32000: Connection closed'), {name: 'McpError', code: -32000}));
  await assert.rejects(cadCalls(config, failing('connect', closed)).status(), error => error === closed);

  // The row: busy and checking again (clients keep reading while it is `checking`), then the answer when it comes.
  const events = [];
  let answers = [new CadCheckTimedOut('bambu-printer-mcp'), {status: {configured: false, ready: false}, server: 'bambu-printer-mcp'}];
  let asked = 0;
  const calls = {status: async () => { const next = answers[Math.min(asked++, answers.length - 1)]; if (next instanceof Error) throw next; return next; }, setup: async () => assert.fail('no setup')};
  const settings = new CadSettings({calls, emit: async event => { events.push(event); }, retryMs: [5, 5]});
  const busy = await settings.view();
  assert.equal(busy.state, 'checking');
  assert.equal(busy.message, 'This computer is busy, so bambu-printer-mcp is slow to answer. Counterpart is checking again.');
  assert.doesNotMatch(busy.message, /Settings|couldn/, 'a slow computer never sends the person to Settings');
  await tick(() => settings.current().state === 'not-set-up');
  assert.equal(settings.current().state, 'not-set-up', 'it checked again by itself');
  assert.ok(events.some(event => event.type === 'settings.changed' && event.data.keys[0] === 'cad'), 'every layout is told the row changed');
  // A row that was answered keeps its answer through a timeout: no flapping between Ready and busy.
  answers = [new CadCheckTimedOut('bambu-printer-mcp')]; asked = 0;
  await settings.refresh(); await settings.refresh(); await settings.refresh();
  assert.equal(settings.current().state, 'not-set-up');
  // Slow checks behind an answer never use up the retries: once the answer is gone (Set Up reads the row afresh), a
  // timeout still says busy and checks again.
  const T = () => new CadCheckTimedOut('bambu-printer-mcp');
  let queue = [{status: {configured: false, ready: false}, server: 'bambu-printer-mcp'}, T(), T(), T(), T(), {status: {configured: true, ready: true}, server: 'bambu-printer-mcp'}];
  const fresh = new CadSettings({calls: {status: async () => { const next = queue.length > 1 ? queue.shift() : queue[0]; if (next instanceof Error) throw next; return next; },
    setup: async () => ({setup: {ready: true, message: 'Set up.'}, server: 'bambu-printer-mcp'})}, emit: async () => {}, retryMs: [50, 50]});
  for (let i = 0; i < 4; i++) await fresh.refresh();
  assert.equal(fresh.current().state, 'not-set-up', 'three slow checks kept the answer');
  await fresh.setUp();
  // Set Up reads the row afresh when it ends: wait for that read's outcome.
  await tick(() => ['checking', 'unavailable'].includes(fresh.current().state) && fresh.current().message !== 'Checking…');
  assert.equal(fresh.current().message, 'This computer is busy, so bambu-printer-mcp is slow to answer. Counterpart is checking again.', 'busy and checking again, not given up');
  await tick(() => fresh.current().state === 'ready');
  assert.equal(fresh.current().state, 'ready');
  settings.close(); fresh.close();

  // Still too busy after the retries: it stops asking and says when it will check again; still not "go to Settings".
  const stuck = new CadSettings({calls: {status: async () => { throw new CadCheckTimedOut('bambu-printer-mcp'); }, setup: async () => assert.fail('no setup')}, emit: async () => {}, retryMs: [5, 5]});
  await stuck.view();
  await tick(() => stuck.current().state === 'unavailable');
  assert.deepEqual(stuck.current(), {state: 'unavailable', message: 'This computer is too busy to check bambu-printer-mcp right now. Counterpart checks again when you next open Settings.', server: 'bambu-printer-mcp', canSetUp: false});
  stuck.close();

  // A real failure (not installed, crashed, refused) still says to check the MCP in Settings → Printers.
  const broken = new CadSettings({calls: {status: async () => { throw missing; }, setup: async () => assert.fail('no setup')}, emit: async () => {}, retryMs: [5]});
  assert.deepEqual(await broken.view(), {state: 'unavailable', message: "Counterpart couldn't check your printer MCP. Check it in Settings → Printers.", server: 'your printer MCP', canSetUp: false});
  broken.close();
});

test('a refused Set Up shows the MCP\'s own sentence and suggestion, and passes its structured result through unread', async () => {
  const {CadSettings, cadCalls} = await import('../dist/cad-settings.js');
  const {PrinterMcpError} = await import('@scan-to-make/printer-handoff');
  const refusal = {status: 'error', code: 'cad-data-volume-refused', message: 'Code-CAD on macOS requires an internal disk with file ownership enabled.', tool: 'cad_setup',
    retryable: false, suggestion: 'Set CAD_DATA_DIR to an internal folder and set it up again.', storage: {expected_download_bytes: 1, expected_installed_bytes: 2, installed_bytes: 0, measurement: 'allocated-last-setup'}};
  // The printer MCP client turns the tool's error result into an error carrying its structured content.
  const error = new PrinterMcpError('tool-failed', undefined, 'text');
  error.structured = refusal;
  const client = () => ({async connect() {}, async close() {}, hasTool: () => true, async callTool(name) { if (name === 'cad_setup') throw error; return {structuredContent: {configured: false, ready: false, storage: refusal.storage}, content: []}; }});
  const calls = cadCalls(() => ({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}), client);
  assert.deepEqual(await calls.setup(() => {}), {setup: null, server: 'bambu-printer-mcp', error: refusal.message, refusal});
  const settings = new CadSettings({calls, emit: async () => {}});
  await settings.setUp();
  for (let i = 0; i < 100 && !settings.current().result; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(settings.current().result, {ok: false, message: refusal.message, suggestion: refusal.suggestion, refusal});
  // Every code gets the same treatment: the words are the MCP's, whatever the code.
  for (const code of ['cad-uv-missing', 'cad-setup-busy', 'cad-something-new']) {
    error.structured = {...refusal, code, message: `The MCP's sentence for ${code}.`};
    const other = new CadSettings({calls, emit: async () => {}});
    await other.setUp();
    for (let i = 0; i < 100 && !other.current().result; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(other.current().result.message, `The MCP's sentence for ${code}.`);
    assert.equal(other.current().result.refusal.code, code);
  }
});
