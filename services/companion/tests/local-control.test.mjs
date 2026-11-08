import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat,writeFile,readFile,symlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {connect,createServer,Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startLocalControl} from '../dist/local-control.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {MAX_REQUEST_BYTES} from '../dist/local-control-protocol.js';
import {InMemoryElicitationRelay,HandoffBundleStore} from '@scan-to-make/printer-handoff';
import {fixture as captureFixture} from './fixtures/scan-processing.mjs';

async function fixture(t, extra={}) {
  // '/tmp', not tmpdir(): the control socket under root must stay within macOS's sun_path limit.
  const root=await mkdtemp('/tmp/stmc-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'fixture.example.ts.net',allowedLogins:['owner@example.test']});
  const services={auth,companionVersion:'0.1.0',...extra};
  const server=await startLocalControl({path:join(root,'control.sock'),dispatch:createControlDispatcher(services),timeoutMs:1000});
  t.after(()=>server.close());
  return {root,auth,services,server,call:(method,params={})=>wire(server.path,{v:1,id:randomUUID(),method,params})};
}
function wire(path,request, split=false) {
  return new Promise((resolve,reject)=>{
    const socket=connect(path);let response='';
    socket.setTimeout(5000,()=>socket.destroy(Error('test timeout')));
    socket.on('error',reject);socket.on('data',chunk=>response+=chunk);
    socket.on('end',()=>{try{resolve(JSON.parse(response));}catch(error){reject(error);}});
    socket.on('connect',()=>{
      const bytes=typeof request==='string'?request:JSON.stringify(request)+'\n';
      if(split){socket.write(bytes.slice(0,3));setImmediate(()=>socket.end(bytes.slice(3)));}
      else socket.end(bytes);
    });
  });
}

test('printer check stays local, bounded to an empty/poll or start request',async t=>{
  const starts=[];const f=await fixture(t,{printerCheck:{get:start=>{starts.push(start);return {state:'checking'};}}});
  assert.equal((await f.call('printer.check',{start:true})).result.state,'checking');
  assert.equal((await f.call('printer.check')).result.state,'checking');
  assert.deepEqual(starts,[true,false]);
  assert.equal((await f.call('printer.check',{host:'caller-picked'})).error.code,'invalid-request');
});

test('private Unix endpoint handles fragmented/half-closed clients and removes its socket on shutdown',async t=>{
  const f=await fixture(t);
  assert.equal((await stat(f.root)).mode&0o777,0o700);
  assert.equal((await stat(f.server.path)).mode&0o777,0o600);
  assert.equal((await stat(f.server.path)).isSocket(),true);
  const id=randomUUID(); const response=await wire(f.server.path,{v:1,id,method:'status.get',params:{}},true);
  assert.equal(response.id,id);assert.equal(response.result.transport,'tailscale');assert.equal(response.result.pairedDeviceCount,0);
  assert.equal('name' in response.result,false,'no name unless the companion has one');
  await assert.rejects(startLocalControl({path:f.server.path,dispatch:async()=>({})}),e=>e.code==='conflict');
  await f.server.close();await assert.rejects(stat(f.server.path),e=>e.code==='ENOENT');
});

test('refuses public directories, symlink endpoints and live sockets; never deletes unrelated files',async t=>{
  const root=await mkdtemp('/tmp/stmc-');t.after(()=>rm(root,{recursive:true,force:true}));
  const dispatch=async()=>({}); const path=join(root,'control.sock');
  await chmod(root,0o755);await assert.rejects(startLocalControl({path,dispatch}),e=>e.code==='unavailable');await chmod(root,0o700);
  const target=join(root,'keep');await writeFile(target,'keep');await symlink(target,path);
  await assert.rejects(startLocalControl({path,dispatch}),e=>e.code==='conflict');assert.equal(await readFile(target,'utf8'),'keep');await rm(path);
  const live=createServer(s=>s.end());await new Promise(r=>live.listen(path,r));
  await assert.rejects(startLocalControl({path,dispatch}),e=>e.code==='conflict');assert((await stat(path)).isSocket());
  await new Promise(r=>live.close(r));
  await assert.rejects(startLocalControl({path:'127.0.0.1:9876',dispatch}),e=>e.code==='unavailable');
});

test('recovers a socket left by a terminated owner',async t=>{
  const root=await mkdtemp('/tmp/stmc-');t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'control.sock');
  const child=spawn(process.execPath,['-e',`require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'))`,path]);
  await new Promise((r,j)=>{child.stdout.once('data',r);child.once('error',j);});child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));
  const server=await startLocalControl({path,dispatch:async()=>({ok:true})});t.after(()=>server.close());
  assert.equal((await wire(path,{v:1,id:randomUUID(),method:'status.get',params:{}})).result.ok,true);
});

test('strict envelopes, bounded frames and private errors never execute malformed requests',async t=>{
  const f=await fixture(t);
  for(const input of ['not JSON\n','x'.repeat(MAX_REQUEST_BYTES+1)+'\n',JSON.stringify({v:1,id:randomUUID(),method:'devices.list',params:{extra:true}})+'\n','{}\n{}\n']) {
    assert.equal((await wire(f.server.path,input)).error.code,'invalid-request');
  }
  assert.equal((await wire(f.server.path,{v:2,id:randomUUID(),method:'status.get',params:{}})).error.code,'unsupported-version');
  assert.equal((await f.call('pairing.create',{login:'not-allowed@example.test'})).error.code,'invalid-request');
  const broken=await startLocalControl({path:join(f.root,'broken.sock'),dispatch:async()=>{throw Error('SECRET /private/path');}});t.after(()=>broken.close());
  const failure=await wire(broken.path,{v:1,id:randomUUID(),method:'status.get',params:{}});
  assert.equal(failure.error.code,'internal');assert(!JSON.stringify(failure).includes('SECRET'));
});

test('retained Tailscale identity mints combined pairing, checks activity and revokes only its device',async t=>{
  const f=await fixture(t);
  const invitation=(await f.call('pairing.create')).result;
  assert.equal(new URL(invitation.qrPayload).searchParams.get('c'),invitation.code);
  assert.deepEqual((await f.call('pairing.isActive',{code:invitation.code})).result,{active:true});
  const phone=await f.auth.exchange('owner@example.test',{code:invitation.code,deviceName:'Fixture phone'});
  assert(phone.scopes.includes('printer-handoff:use'));
  assert.deepEqual((await f.call('pairing.isActive',{code:invitation.code})).result,{active:false});
  const devices=(await f.call('devices.list')).result.devices;
  assert.equal(devices[0].deviceId,phone.deviceId);assert(!JSON.stringify(devices).includes('tokenHash'));assert(!JSON.stringify(devices).includes(phone.token));
  assert.deepEqual((await f.call('devices.remove',{deviceId:phone.deviceId})).result,{removed:true});
  assert.equal((await f.call('devices.list')).result.devices.length,0);
  assert.equal((await f.call('devices.remove',{deviceId:phone.deviceId})).error.code,'not-found');
});

test('Mac and phone share one pending confirmation; an answered/expired ID cannot be replayed',async t=>{
  const relay=new InMemoryElicitationRelay();t.after(()=>relay.cancelAll());
  const f=await fixture(t,{printHandoff:{relay}});
  const request=relay.request({method:'elicitation/create',params:{mode:'form',message:'Original confirmation',requestedSchema:{type:'object',properties:{confirmed:{type:'boolean'}},required:['confirmed']}}},{});
  const pending=(await f.call('confirmations.list')).result.items[0];
  // PRD §5.6: no plate picture rides on a printer question.
  assert.equal(pending.message,'Original confirmation');assert.equal('cameraSnapshot' in pending,false);
  assert.deepEqual((await f.call('confirmations.answer',{id:pending.id,answer:{action:'accept',content:{confirmed:true}}})).result,{answered:true});
  assert.deepEqual(await request,{action:'accept',content:{confirmed:true}});
  assert.equal((await f.call('confirmations.answer',{id:pending.id,answer:{action:'accept',content:{confirmed:true}}})).error.code,'not-found');
  const phoneRequest=relay.request({method:'elicitation/create',params:{message:'Next',requestedSchema:{type:'object',properties:{}}}});
  const next=relay.pending()[0];relay.respond(next.id,{action:'cancel'});await phoneRequest;
  assert.equal((await f.call('confirmations.answer',{id:next.id,answer:{action:'decline'}})).error.code,'not-found');
});

test('cross-project index, pagination and Finder door use retained job identities',async t=>{
  const capture=await captureFixture(t);await capture.store.start(capture.input);await capture.store.wait();
  await capture.projects.create({id:'second',brief:{object:'Second object',context:'',addition:''}});
  const imported=await capture.captures.importCapture({projectId:'second',projectRevision:0,source:Buffer.from('second source')});
  await capture.store.start({projectId:'second',projectRevision:0,captureId:imported.captureId});await capture.store.wait();
  const f=await fixture(t,{capture:{storage:capture.storage,captures:capture.captures,scanProcessing:capture.store},captureDirectory:join(capture.root,'captures')});
  const index=(await f.call('jobs.list',{limit:1})).result;
  assert.equal(index.items.length,1);assert.equal(index.items[0].job.status,'succeeded');
  const secondPage=(await f.call('jobs.list',{limit:1,cursor:index.nextCursor})).result;
  assert.deepEqual(new Set([index.items[0].projectId,secondPage.items[0].projectId]),new Set(['test','second']));
  const finder=(await f.call('doors.prepare',{projectId:'test',door:'finder'})).result;
  assert.equal(finder.action,'reveal');assert(finder.fileURL.endsWith(capture.input.captureId));assert.equal(finder.projectRevision,0);
  assert.equal((await f.call('doors.prepare',{projectId:'test',door:'blender'})).error.code,'unavailable');
  assert.equal((await f.call('doors.prepare',{projectId:'../auth',door:'finder'})).error.code,'invalid-request');
});

test('unassociated print jobs retain bundle IDs and doors open only verified unique artifacts',async t=>{
  const f=await fixture(t);const store=new HandoffBundleStore(join(f.root,'bundles'));const relay=new InMemoryElicitationRelay();t.after(()=>relay.cancelAll());
  const one=await store.create({stl:Buffer.alloc(84),prompt:'One',backend:'bambu-printer-mcp'});
  await store.create({stl:Buffer.alloc(84),prompt:'Two',backend:'bambu-printer-mcp'});
  await store.recordArtifact(one.id,'sliced','plate.3mf',Buffer.from('verified fixture'));
  const server=await startLocalControl({path:join(f.root,'print.sock'),dispatch:createControlDispatcher({...f.services,printHandoff:{store,relay}})});t.after(()=>server.close());
  const call=(method,params={})=>wire(server.path,{v:1,id:randomUUID(),method,params});
  const page=(await call('jobs.list',{limit:1})).result;assert.equal(page.items.length,1);assert.equal(page.items[0].projectId,null);
  const next=(await call('jobs.list',{limit:1,cursor:page.nextCursor})).result;assert.equal(next.items.length,1);assert.notEqual(next.items[0].job.id,page.items[0].job.id);
  assert.equal((await call('jobs.list',{projectId:'different',cursor:page.nextCursor})).error.code,'invalid-request');
  const door=(await call('doors.prepare',{handoffId:one.id,door:'bambu-studio'})).result;
  assert.equal(door.applicationBundleId,'com.bambulab.bambu-studio');assert(door.fileURL.endsWith('/plate.3mf'));
  assert.notEqual(fileURLToPath(door.fileURL),join(store.directory(one.id),'plate.3mf'));
  await writeFile(fileURLToPath(door.fileURL),'desktop editor save');
  assert.equal((await store.read(one.id)).id,one.id);
  assert.equal((await call('jobs.list')).result.items.length,2);
  await writeFile(join(store.directory(one.id),'plate.3mf'),'tampered');
  assert.equal((await call('doors.prepare',{handoffId:one.id,door:'orca'})).error.code,'unavailable');
});

test('invalid stored schemas report unavailable instead of blaming valid request parameters',async t=>{
  const capture=await captureFixture(t);await capture.store.start(capture.input);await capture.store.wait();
  const f=await fixture(t,{capture:{storage:capture.storage,captures:capture.captures,scanProcessing:capture.store},captureDirectory:join(capture.root,'captures')});
  await writeFile(join(capture.root,'captures',capture.input.captureId,'binding.json'),'{}');
  assert.equal((await f.call('jobs.list')).error.code,'unavailable');
  assert.equal((await f.call('jobs.list',{limit:0})).error.code,'invalid-request');
});

test('LAN pairing needs no login and an incomplete frame expires without a mutation',async t=>{
  // Authentication writes must not race the deliberately short incomplete-frame clock.
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t);
  const auth=await RemoteAuthStore.create(join(f.root,'lan-auth'),{transport:'lan',host:'192.168.1.2:9077',certificateSha256:'a'.repeat(64),allowedLogins:['lan']});
  let calls=0;
  const dispatch=createControlDispatcher({auth,companionVersion:'0.1.0'});
  const server=await startLocalControl({path:join(f.root,'lan.sock'),timeoutMs:50,dispatch:async(...args)=>{calls++;return dispatch(...args);}});t.after(()=>server.close());
  const invitation=(await wire(server.path,{v:1,id:randomUUID(),method:'pairing.create',params:{}})).result;
  assert.equal(new URL(invitation.qrPayload).searchParams.get('f'),'a'.repeat(64));
  assert.equal(invitation.baseUrl,'https://192.168.1.2:9077');
  let read;const partial=new Promise(resolve=>{read=resolve;});
  const emit=Socket.prototype.emit;let bytes='';
  t.mock.method(Socket.prototype,'emit',function(event,...args){
    const result=emit.call(this,event,...args);
    if(event==='data'){bytes+=args[0].toString();if(bytes==='{"v":1')read();}
    return result;
  });
  const closed=new Promise((resolve,reject)=>{const s=connect(server.path);s.on('error',reject);s.on('close',resolve);s.on('connect',()=>s.write('{"v":1'));s.resume();});
  await partial; // The incomplete frame reached the server before its deadline.
  t.mock.timers.tick(50);
  await closed;
  assert.equal(calls,1);
});

test('with the server\'s v2 details the QR is a v2 link; nearby requests are listed and answered once (MAC-5)',async t=>{
  const f=await fixture(t);
  const auth=await RemoteAuthStore.create(join(f.root,'lan-v2'),{transport:'lan',host:'192.168.1.2:9077',certificateSha256:'a'.repeat(64),allowedLogins:['lan']});
  const id=randomUUID(),answers=[];
  const nearby={pending:()=>answers.length?[]:[{id,deviceName:"David's iPhone",code:'482913',expiresAt:1}],
    async answer(requestId,allow){answers.push([requestId,allow]);return requestId===id&&answers.length===1;}};
  const pairingLink=()=>({addresses:['https://192.168.1.2:9077','https://Mac-mini.local:9077'],publicKeySha256:'b'.repeat(64),name:'Mac mini'});
  const server=await startLocalControl({path:join(f.root,'v2.sock'),dispatch:createControlDispatcher({auth,companionVersion:'0.1.0',pairingLink,nearby})});
  t.after(()=>server.close());
  const call=(method,params={})=>wire(server.path,{v:1,id:randomUUID(),method,params});
  assert.equal((await call('status.get')).result.capabilities.nearbyPairing,true);
  // The JSON keeps the v1 fields the Mac app decodes; the QR carries every address and the key pin.
  const invitation=(await call('pairing.create')).result;
  assert.deepEqual([invitation.version,invitation.baseUrl],[1,'https://192.168.1.2:9077']);
  const qr=new URL(invitation.qrPayload);
  assert.deepEqual([qr.searchParams.get('v'),qr.searchParams.getAll('a'),qr.searchParams.get('k'),qr.searchParams.get('n'),qr.searchParams.get('c')],
    ['2',pairingLink().addresses,'b'.repeat(64),'Mac mini',invitation.code]);
  assert.deepEqual((await call('nearby.list')).result,{items:[{id,deviceName:"David's iPhone",code:'482913',expiresAt:1}]});
  assert.deepEqual((await call('nearby.answer',{id,allow:true})).result,{answered:true});
  assert.equal((await call('nearby.answer',{id,allow:true})).error.code,'not-found');
  assert.deepEqual(answers,[[id,true],[id,true]]);
  assert.deepEqual((await call('nearby.list')).result,{items:[]});
  for(const params of [{id},{id,allow:'yes'},{id:'x',allow:true},{id,allow:true,extra:1}])
    assert.equal((await call('nearby.answer',params)).error.code,'invalid-request');
  // Without nearby pairing: nothing listed, answers unavailable, and the QR stays v1.
  assert.equal((await f.call('status.get')).result.capabilities.nearbyPairing,false);
  assert.deepEqual((await f.call('nearby.list')).result,{items:[]});
  assert.equal((await f.call('nearby.answer',{id,allow:true})).error.code,'unavailable');
  assert.equal(new URL((await f.call('pairing.create')).result.qrPayload).searchParams.get('v'),'1');
});

test('server CLI owns the control socket lifecycle without exposing admin methods over HTTP',async t=>{
  const f=await fixture(t);await f.server.close();
  // Supported container state volumes are searchable; auth remains private.
  await chmod(f.root,0o755);
  const path=join(f.auth.directory,'control.sock');
  const call=(method,params={})=>wire(path,{v:1,id:randomUUID(),method,params});
  const {request}=await import('node:http');
  const child=spawn(process.execPath,[new URL('../dist/server-cli.js',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,SCAN_TO_MAKE_REMOTE_AUTH_DIR:f.auth.directory,SCAN_TO_MAKE_GENERATION_PORT:'0'},stdio:['ignore','pipe','pipe'],
  });
  const exited=new Promise(resolve=>child.once('exit',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}});
  const address=await new Promise((resolve,reject)=>{
    let stdout='';const timer=setTimeout(()=>reject(Error('CLI startup timeout')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('CLI exited before readiness'));});
    child.stdout.on('data',chunk=>{stdout+=chunk;const match=/ready at (http:\/\/[^\s]+)/.exec(stdout);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await stat(f.auth.directory)).mode&0o777,0o700);
  assert.equal((await stat(f.root)).mode&0o777,0o755);
  assert.equal((await call('status.get')).result.transport,'tailscale');
  const invitation=(await call('pairing.create')).result;
  const phone=await f.auth.exchange('owner@example.test',{code:invitation.code,deviceName:'Local fixture'});
  const status=await new Promise((resolve,reject)=>{
    const req=request(address+'/v1/control/status',{headers:{host:f.auth.host,'x-forwarded-host':f.auth.host,'x-forwarded-proto':'https','tailscale-user-login':'owner@example.test','x-scan-device':phone.deviceId,authorization:`Bearer ${phone.token}`}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end();
  });
  assert.equal(status,404);
  child.kill('SIGTERM');await exited;
  await assert.rejects(stat(path),error=>error.code==='ENOENT');
});

test('long methods get their own socket deadline; everything else keeps 10 s', async () => {
  const {methodDeadlineMs} = await import('../dist/local-control.js');
  assert.equal(methodDeadlineMs('objects.correct', {}), 25000);
  assert.equal(methodDeadlineMs('objects.estimate', {}), 630000, 'its slice may take 600 s, after reading what it slices');
  assert.equal(methodDeadlineMs('objects.cancelPrint', {}), 730000, 'the printer question window (10 min) plus 2 min, plus 10 s');
  assert.equal(methodDeadlineMs('objects.get', {}), undefined);
  // Nov 6: a 57 MB STL for a starter's file Ask outlived the 10 s deadline; the Mac got no answer at all.
  assert.equal(methodDeadlineMs('objects.addFile', {}), 120000);
  // Nov 6, 14:43: printers.mcps missed 10 s on a busy Mac and Settings lost an MCP's row. It answers inside the Mac's 15 s.
  assert.equal(methodDeadlineMs('printers.mcps', {}), 13000);
});

// Nov 6: David's project page said "Something went wrong on your Mac." The companion had closed the Mac's request
// at its deadline without a word, then finished the work. Every refused or unfinished request now gets a code and
// a sentence, and the companion's log says which method and why.
test('a request past its deadline is answered timed-out, never dropped, and the refusal is logged',async t=>{
  const root=await mkdtemp('/tmp/stmc-');t.after(()=>rm(root,{recursive:true,force:true}));
  let finished=false;
  const server=await startLocalControl({path:join(root,'slow.sock'),timeoutMs:100,dispatch:async()=>{await new Promise(r=>setTimeout(r,400));finished=true;return {ok:true};}});
  t.after(()=>server.close());
  const logged=[];const original=console.error;console.error=(...args)=>logged.push(args.join(' '));t.after(()=>{console.error=original;});
  const reply=await wire(server.path,{v:1,id:randomUUID(),method:'objects.list',params:{}});
  assert.equal(reply.error.code,'timed-out');assert.match(reply.error.message,/took too long/);
  assert.ok(logged.some(line=>line.includes('objects.list')&&line.includes('timed-out')),logged.join('\n'));
  await new Promise(r=>setTimeout(r,500));assert.equal(finished,true,'the work itself goes on');
});
test('a connection past the limit is answered busy, never dropped; any refusal is logged with its code',async t=>{
  const root=await mkdtemp('/tmp/stmc-');t.after(()=>rm(root,{recursive:true,force:true}));
  let release;const held=new Promise(r=>release=r);
  let calls=0;
  const server=await startLocalControl({path:join(root,'busy.sock'),timeoutMs:5000,dispatch:async()=>{if(++calls<=16){await held;return {ok:true};}throw new Error('not a ControlFailure');}});
  t.after(()=>server.close());
  const logged=[];const original=console.error;console.error=(...args)=>logged.push(args.join(' '));t.after(()=>{console.error=original;});
  const waiting=Array.from({length:16},()=>wire(server.path,{v:1,id:randomUUID(),method:'objects.list',params:{}}));
  await new Promise(r=>setTimeout(r,200));
  const refused=await wire(server.path,{v:1,id:randomUUID(),method:'objects.list',params:{}});
  assert.equal(refused.error.code,'busy');assert.match(refused.error.message,/too many/);
  release();assert.ok((await Promise.all(waiting)).every(reply=>reply.result?.ok));
  const failed=await wire(server.path,{v:1,id:randomUUID(),method:'objects.list',params:{}});
  assert.equal(failed.error.code,'internal');
  assert.ok(logged.some(line=>line.includes('busy')),logged.join('\n'));
  assert.ok(logged.some(line=>line.includes('objects.list')&&line.includes('internal')),logged.join('\n'));
});

test('status.get names the Mac as people know it ("Mac mini"), as /healthz does',async t=>{
  const f=await fixture(t,{name:'Mac mini'});
  assert.equal((await f.call('status.get')).result.name,'Mac mini');
});

test('status.get names the host platform for desktop clients, as an added field', async () => {
  const {hostPlatform} = await import('../dist/local-control-services.js');
  assert.equal(hostPlatform('darwin'), 'macos');
  assert.equal(hostPlatform('linux'), 'linux');
  assert.equal(hostPlatform('win32'), 'other');
});
