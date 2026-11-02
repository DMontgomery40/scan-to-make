import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BlenderAddonRepair} from '../dist/touchup/addon-repair.js';
import {PrintGate} from '../dist/printing/print-gate.js';
const addon = protocol => `bl_info = {"name": "MCP for Blender", "version": (1, 8)}\nADDON_PROTOCOL_VERSION = ${protocol}\n`;
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'addon-repair-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const folder = join(root, 'addons'); await mkdir(folder);
  const target = join(folder, 'addon.py'); await writeFile(target, addon(1));
  const gate = new PrintGate();
  const service = new BlenderAddonRepair({gate, workRoot: root, listening:async()=>true,
    inspect: async () => ({target, protocol:15, installedProtocol:Number(/ADDON_PROTOCOL_VERSION = (\d+)/.exec(await readFile(target,'utf8'))[1])}),
    probe: async () => ({up_to_date:false, protocol_version:1, expected_protocol_version:15}),
    stage: async dir => {const path=join(dir,'blender_mcp.py'); await writeFile(path,addon(15)); return path;},
    lock: async () => async () => {}, ...overrides});
  return {service, root, folder, target, gate};
}
test('old live addon is actionable even when MCP tool discovery works', async t => {
  const {service}=await fixture(t);
  assert.equal((await service.check()).state,'update-needed');
});
test('no listener never claims that the addon is ready', async t => {
  const {service}=await fixture(t,{listening:async()=>false,inspect:async()=>({target:'unused',protocol:15,installedProtocol:15}),probe:async()=>{throw new Error('must not probe a closed listener');}});
  assert.equal((await service.check()).state,'not-running');
});
test('repair preserves the legacy module and leaves the running session awaiting restart', async t => {
  const {service,target,folder}=await fixture(t);
  assert.equal(service.update().state,'updating');
  await service.settled();
  assert.equal(service.current().state,'restart-needed');
  assert.equal(await readFile(target,'utf8'),addon(15));
  const names=await readdir(folder);
  assert.equal(names.includes('blender_mcp.py'),false);
  assert.equal(names.filter(n=>n.endsWith('.bak')).length,1);
  assert.equal(await readFile(join(folder,names.find(n=>n.endsWith('.bak'))),'utf8'),addon(1));
});
test('failed backup preserves the addon bytes', async t => {
  const {service,target}=await fixture(t,{backup:async()=>{throw new Error('disk full');}});
  service.update(); await service.settled();
  assert.equal(service.current().state,'failed');
  assert.equal(await readFile(target,'utf8'),addon(1));
});
test('active pass prevents any installation and repair reservation prevents new passes', async t => {
  let unblock; const waiting=new Promise(r=>{unblock=r;});
  const {service,gate}=await fixture(t,{lock:async()=>{await waiting;return async()=>{};}});
  const release=gate.hold('current');
  assert.equal(service.update().state,'busy'); release();
  service.update(); assert.throws(()=>gate.hold('current'));
  unblock(); await service.settled();
  const next=gate.hold('current'); next();
});
test('only a fresh compatible handshake clears restart-needed', async t => {
  let current=false;
  const {service}=await fixture(t,{probe:async()=>({up_to_date:current,protocol_version:current?15:1,expected_protocol_version:15})});
  service.update(); await service.settled();
  assert.equal((await service.check()).state,'restart-needed');
  current=true; assert.equal((await service.check()).state,'ready');
});

test('a bridge without a compatibility API is unverified', async t => {
  const {service}=await fixture(t,{probe:async()=>undefined});
  const status=await service.check();assert.equal(status.state,'unavailable');assert.equal(status.canUpdate,false);
});
test('wrong staged protocol never replaces the addon', async t => {
  const {service,target}=await fixture(t,{stage:async dir=>{const path=join(dir,'blender_mcp.py');await writeFile(path,addon(14));return path;}});
  service.update();await service.settled();assert.equal(service.current().state,'failed');assert.equal(await readFile(target,'utf8'),addon(1));
});
test('both control actions start bounded operations and return the same status', async t => {
  const {createControlDispatcher}=await import('../dist/local-control-services.js');
  const {service}=await fixture(t);
  const call=createControlDispatcher({auth:{},companionVersion:'test',blenderAddon:service});
  assert.equal((await call('blender.check',{})).blender.state,'checking');
  await service.settled();assert.equal((await call('blender.status',{})).blender.state,'update-needed');
  assert.equal((await call('blender.update',{})).blender.state,'updating');
  await service.settled();assert.equal((await call('blender.status',{})).blender.state,'restart-needed');
});
test('installer follows the configured local package and environment without a shell', async () => {
  const {configuredAddonInstaller}=await import('../dist/touchup/addon-installer.js');
  const host={home:'/home/user',user:'user',appPrinters:'/state/printers',exists:()=>false,isDirectory:()=>false,realpath:p=>p,
    readFile:p=>p==='/mcp/.env'?'BLENDER_MCP_COMMAND=/opt/uvx\nBLENDER_MCP_ARGS=["blender-mcp"]\n':undefined};
  const config={backend:'bambu-printer-mcp',process:{command:'/node',args:['/mcp/dist/index.js'],cwd:'/mcp'}};
  const result=configuredAddonInstaller(config,host);
  assert.equal(result.command,'/opt/uvx');assert.deepEqual(result.prefix,['--from','blender-mcp']);
  assert.equal(result.cwd,'/mcp');
  const pinned=configuredAddonInstaller({...config,process:{...config.process,env:{BLENDER_MCP_ARGS:'["--from","mcp-for-blender==2.2.4","mcp-for-blender"]'}}},host);
  assert.deepEqual(pinned.prefix,['--from','mcp-for-blender==2.2.4']);
});
test('repair targets the running Blender version without treating old versions as duplicate modules', async () => {
  const {selectAddonTarget}=await import('../dist/touchup/addon-installer.js');
  const files=[{path:'/home/Library/Application Support/Blender/5.0/scripts/addons/addon.py'},
    {path:'/home/Library/Application Support/Blender/4.4/scripts/addons/addon.py'}];
  assert.equal(selectAddonTarget(files,'4.4.1').path,files[1].path);
  assert.equal(selectAddonTarget(files).path,files[0].path,'no listener follows upstream directory priority');
  assert.throws(()=>selectAddonTarget([...files,{path:files[0].path.replace('addon.py','blender_mcp.py')}],'5.0.1'));
});
test('HTTP status requires read scope and repair/check require write scope', async t => {
  const {startCompanionServer}=await import('../dist/server.js');
  const {RemoteAuthStore}=await import('../dist/remote-auth.js');
  const {request}=await import('node:http');
  const {service,root}=await fixture(t);
  const remoteAuth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
  const pair=async scopes=>{const invitation=await remoteAuth.createPairing('alice@example.test',scopes);return remoteAuth.exchange('alice@example.test',{code:invitation.code,deviceName:'Fixture'});};
  const reader=await pair(['projects:read']),writer=await pair(['projects:read','projects:write']);
  const server=await startCompanionServer({port:0,remoteAuth,blenderAddon:service});t.after(()=>server.close());
  const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url),'utf8')).expected;
  const call=(method,path,phone)=>new Promise((resolve,reject)=>{
    const req=request(server.url+path,{method,headers:{...forwarded,authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end();});
  const initial=await call('GET','/v1/blender',reader);
  assert.equal(initial.status,200);assert.equal(initial.body.blender.state,'unchecked');
  for(const action of ['check','update'])assert.equal((await call('POST','/v1/blender/'+action,reader)).status,403);
  assert.equal((await call('POST','/v1/blender/check',writer)).body.blender.state,'checking');
  await service.settled();assert.equal((await call('GET','/v1/blender',writer)).body.blender.state,'update-needed');
  assert.equal((await call('POST','/v1/blender/update',writer)).body.blender.state,'updating');
  await service.settled();assert.equal((await call('GET','/v1/blender',writer)).body.blender.state,'restart-needed');
});
test('repair can stop waiting for the shared helper lock without acquiring it later', async t => {
  const {acquireBlenderLock}=await import('../dist/touchup/touchup.js');
  const root=await mkdtemp(join(tmpdir(),'addon-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'blender.lock'),release=await acquireBlenderLock(path);
  await assert.rejects(acquireBlenderLock(path,{pollMs:2,signal:AbortSignal.timeout(10)}),{name:'TimeoutError'});
  await release();const next=await acquireBlenderLock(path);await next();
});

test('closed outdated Blender offers repair and reports ready for next launch afterward', async t => {
  const {service,target}=await fixture(t,{listening:async()=>false});
  const before=await service.check();assert.equal(before.state,'update-needed');assert.equal(before.canUpdate,true);
  service.update();await service.settled();
  assert.equal(service.current().state,'not-running');assert.match(service.current().message,/opens it when cleanup starts/);
  assert.equal(service.current().canUpdate,false);assert.equal(await readFile(target,'utf8'),addon(15));
});
test('reachable bridge errors remain unverified rather than pretending Blender is stopped', async t => {
  const {service}=await fixture(t,{probe:async()=>{throw new Error('Could not read addon handshake');}});
  assert.equal((await service.check()).state,'unavailable');
});

test('a failed later repair cannot reuse the success state of an earlier replacement', async t => {
  const {service,target}=await fixture(t);
  service.update();await service.settled();
  service.deps.inspect=async()=>({target,protocol:16,installedProtocol:15});
  service.deps.probe=async()=>({up_to_date:false,protocol_version:15,expected_protocol_version:16});
  assert.equal((await service.check()).state,'update-needed');
  service.deps.stage=async()=>{throw new Error('installer failed');};
  service.update();await service.settled();
  assert.equal(service.current().state,'failed');
  assert.equal(await readFile(target,'utf8'),addon(15));
});
test('host-only Blender variables cannot select an unconfigured bridge for repair', async () => {
  const {configuredAddonInstaller}=await import('../dist/touchup/addon-installer.js');
  const before={command:process.env.BLENDER_MCP_COMMAND,args:process.env.BLENDER_MCP_ARGS};
  process.env.BLENDER_MCP_COMMAND='/opt/uvx';process.env.BLENDER_MCP_ARGS='["blender-mcp"]';
  try {
    const host={home:'/home/user',user:'user',appPrinters:'/state/printers',exists:()=>false,isDirectory:()=>false,realpath:p=>p,readFile:()=>undefined};
    assert.throws(()=>configuredAddonInstaller({backend:'bambu-printer-mcp',process:{command:'/node',args:['/mcp/index.js']}},host),/does not name a Blender installer/);
  } finally {
    if(before.command===undefined)delete process.env.BLENDER_MCP_COMMAND;else process.env.BLENDER_MCP_COMMAND=before.command;
    if(before.args===undefined)delete process.env.BLENDER_MCP_ARGS;else process.env.BLENDER_MCP_ARGS=before.args;
  }
});
test('a fresh companion status read never reports phantom work', async t => {
  let inspected=0;
  const {service}=await fixture(t,{inspect:async()=>{inspected++;throw new Error('not requested');}});
  assert.equal(service.current().state,'unchecked');
  assert.equal(service.current().canUpdate,false);
  assert.equal(inspected,0,'status-only reappearance must not start a check');
});
