import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {CompanionSettingsStore} from '../dist/settings.js';
import {tempDir} from './support/temp.mjs';

async function fixture(t, value) {
  const root = await tempDir('companion-settings-');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'settings.json');
  if(value!==undefined)await writeFile(path,JSON.stringify(value));
  return {path,store:new CompanionSettingsStore(path)};
}
test('absent and legacy settings expose supported notification and General sections without inventing the Mac\'s choices',async t=>{
  for(const value of [undefined,{milestones:'25-50-75'}]) {
    const {store}=await fixture(t,value);
    // Only the companion's own choice has a default: Keep printer software up to date is on (Q9).
    assert.deepEqual(await store.load(),{milestones:value?.milestones??'50',notifications:{mac:{},devices:{}},general:{autoUpdateMcps:true}});
  }
});
test('Q9: Keep printer software up to date is on for a new install and for a settings file from before it, and off stays off',async t=>{
  const {autoUpdatesMcps}=await import('../dist/settings.js');
  // A new install: no settings file at all.
  const fresh=await fixture(t);
  assert.equal(autoUpdatesMcps(await fresh.store.load()),true,'a new install is on');
  // An existing file written before the key existed, with the Mac's own General choices in it.
  const old=await fixture(t,{milestones:'50',general:{showInDock:false,keepAwake:true}});
  const loaded=await old.store.load();
  assert.equal(autoUpdatesMcps(loaded),true,'an existing file without the key is on');
  assert.deepEqual(loaded.general,{autoUpdateMcps:true,showInDock:false,keepAwake:true},'and keeps the Mac\'s choices');
  // Turned off, it stays off, through another change and a restart.
  await old.store.update({general:{autoUpdateMcps:false}});
  await old.store.update({milestones:'every-10'});
  const again=new CompanionSettingsStore(old.path);
  assert.equal(autoUpdatesMcps(await again.load()),false,'off is saved and read back as off');
  assert.equal(JSON.parse(await readFile(old.path,'utf8')).general.autoUpdateMcps,false);
  // The default isn't stuck on: it is the store's reading of a missing key, not a value forced over a saved one.
  assert.equal(autoUpdatesMcps({milestones:'50',general:{}}),true);
  assert.equal(autoUpdatesMcps({milestones:'50'}),true);
});
test('nested patches and concurrent changes preserve every explicit opt-out and unrelated stored section',async t=>{
  const {store,path}=await fixture(t,{milestones:'50',notifications:{mac:{'pass.ready':false,'future.event':false},devices:{phoneA:{'print.done':false}}},general:{showInDock:false},futureSection:{kept:true}});
  await Promise.all([
    store.update({notifications:{mac:{'print.milestone':true}}}),
    store.update({notifications:{devices:{phoneB:{'pass.ask':false}}},general:{keepAwake:false}}),
    store.update({milestones:'every-10'})
  ]);
  const expected={milestones:'every-10',notifications:{mac:{'pass.ready':false,'future.event':false,'print.milestone':true},devices:{phoneA:{'print.done':false},phoneB:{'pass.ask':false}}},general:{autoUpdateMcps:true,showInDock:false,keepAwake:false}};
  assert.deepEqual(await store.load(),expected);
  assert.deepEqual(await new CompanionSettingsStore(path).load(),expected);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).futureSection,{kept:true});
});
test('invalid stored preferences fail without overwriting explicit false values',async t=>{
  const {store,path}=await fixture(t,{milestones:'50',notifications:{mac:{'pass.ready':false},devices:{bad:{'print.done':'no'}}}});
  const before=await readFile(path,'utf8');
  await assert.rejects(store.update({milestones:'off'}));
  assert.equal(await readFile(path,'utf8'),before);
});

test('actual HTTP and control settings responses preserve fields consumed by both Swift clients',async t=>{
  const {createServer}=await import('node:http');
  const {ObjectStore}=await import('../dist/objects/store.js');
  const {ObjectService}=await import('../dist/objects/service.js');
  const {createObjectRoutes}=await import('../dist/objects/http.js');
  const {createControlDispatcher}=await import('../dist/local-control-services.js');
  const {store:settings,path}=await fixture(t);
  const events=[];
  const service=new ObjectService({store:new ObjectStore(join(path,'../objects')),settings,runTouchup:async()=>{throw Error('unused');},stlInfo:async()=>undefined,claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},events:{emit:async event=>events.push(event)}});
  const routes=createObjectRoutes(service),scopes=[];
  const server=createServer(async(req,res)=>{try{await routes.handle(req,res,async scope=>{scopes.push(scope);},name=>req.headers[name]);}catch{res.statusCode=500;res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await service.close();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/v1/settings`;
  const get=await (await fetch(url)).json();
  const expected=JSON.parse(await readFile(new URL('../../../packages/CounterpartKit/Tests/CounterpartKitTests/Fixtures/notification-settings.json',import.meta.url),'utf8'));
  assert.deepEqual(get,expected,'same actual JSON decoded by Swift tests');
  const dispatch=createControlDispatcher({auth:{transport:'lan',listDevices:async()=>[]},companionVersion:'test',objects:service});
  assert.deepEqual(await dispatch('settings.get',{}),expected);
  assert.equal((await fetch(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({notifications:{devices:{phone:{'pass.ready':false}}},general:{showInDock:false}})})).status,200);
  const changed=await dispatch('settings.set',{notifications:{mac:{'print.done':false}},milestones:'25-50-75'});
  assert.equal(changed.settings.notifications.devices.phone['pass.ready'],false);
  assert.equal(changed.settings.notifications.mac['print.done'],false);
  assert.equal(changed.settings.general.showInDock,false);
  assert.equal((await (await fetch(url)).json()).settings.milestones,'25-50-75','old milestones-only clients still work');
  assert.equal(events.filter(e=>e.type==='settings.changed').length,2);
  assert.ok(scopes.includes('projects:write'));
  assert.equal((await fetch(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({general:{showInDock:'yes'}})})).status,400);
});
