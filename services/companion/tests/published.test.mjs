import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,utimes,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {buildPublishedInvocation,runPublishedWorker,findNamed} from '../dist/published/published.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
const {zipSync,strToU8}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
const LINK='https://makerworld.com/en/models/198362-vernier-caliper-ruler-two-lengths';
const model=(title='Caliper',plates=1)=>Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),
 '3D/3dmodel.model':strToU8(`<model><metadata name="Title">${title}</metadata><metadata name="Designer">Fixture Designer</metadata><metadata name="License">Fixture licence</metadata><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>`),
 'Metadata/model_settings.config':strToU8(`<config>${Array.from({length:plates},(_,i)=>`<plate><metadata key="plater_id" value="${i+1}"/><metadata key="plater_name" value="Size ${i+1}"/></plate>`).join('')}</config>`)}));
async function setup(t,runPublished=async()=>({status:'needs_file'})){
 const root=await mkdtemp(join(tmpdir(),'published-test-')),store=new ObjectStore(join(root,'objects')),events=[];let holds=0;
 const service=new ObjectService({store,stlInfo:async()=>[1,2,3],claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},
 printGate:{hold:()=>{holds++;return()=>{holds--;};}},runPublished,runTouchup:async()=>{throw Error('published retrieval entered design');},events:{emit:async e=>events.push(e)},titleFor:async()=>'Generated'});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});return{root,store,service,events,holds:()=>holds};
}
function spawnAnswer(answer){return()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{child.stdout.end(JSON.stringify({type:'result',structured_output:answer})+'\n');setImmediate(()=>child.emit('close',0));});return child;};}
test('retrieval has browser/web but no printer, geometry, heating or dispatch tools',async t=>{
 const f=await setup(t),pass=await prepareTouchupPass({root:f.root,objectId:'p',scan:[],photos:[],requirePhotos:false});
 const inv=buildPublishedInvocation({pass,printer:{command:'/unused'},claudePath:'/c',request:LINK,link:{url:LINK,site:'MakerWorld'},chrome:true});
 assert.deepEqual(inv.args[inv.args.indexOf('--allowedTools')+1].split(','),['Read','Glob','WebSearch','WebFetch','mcp__claude-in-chrome']);assert.deepEqual(inv.mcpConfig.mcpServers,{});assert.ok(inv.args.includes('--chrome'));
 const cancelled=await runPublishedWorker(inv,pass,{url:LINK,site:'MakerWorld'},{signal:AbortSignal.abort(),spawn:()=>{throw Error('spawned after cancellation');}});assert.equal(cancelled.status,'failed');
});
test('old Downloads names require confirmation; escapes and symlinks never establish identity',async t=>{
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);const path=join(downloads,'caliper.3mf');await writeFile(path,model());const yesterday=new Date(Date.now()-86400000);await utimes(path,yesterday,yesterday);await symlink(path,join(downloads,'alias.3mf'));
 assert.deepEqual((await findNamed(['../caliper.3mf','alias.3mf'],[downloads])).found,[]);
 const pass=await prepareTouchupPass({root:join(f.root,'passes'),objectId:'p',scan:[],photos:[],requirePhotos:false});
 const got=await runPublishedWorker({command:'/c',args:[],env:{},cwd:pass.dir,mcpConfigPath:'',mcpConfig:{mcpServers:{}}},pass,{url:LINK,site:'MakerWorld'},{downloads,spawn:spawnAnswer({status:'downloaded',summary:'Got file',download:{files:['caliper.3mf']}})});
 assert.equal(got.status,'needs_file');assert.equal(got.candidate,path);
});
test('link retrieves or asks; explicit file preserves bytes, hash and embedded credit',async t=>{
 const f=await setup(t),object=await f.service.create('Print this','published',LINK);await f.service.start(object.id);const asking=await f.service.settled(object.id);assert.equal(asking.ask.type,'file');assert.equal(f.holds(),0);
 const bytes=model(),done=await f.service.addModelFile(object.id,'caliper.3mf',bytes);assert.equal(done.state,'ready');assert.equal(done.credit.designer,'Fixture Designer');assert.equal(done.credit.url,LINK);
 assert.deepEqual(await readFile(join(f.service.dir(object.id),done.files.original[0])),bytes);assert.equal(done.files.receipts[0].sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(done.files.current,done.files.original[0]);assert.equal((await f.service.start(object.id)).state,'ready','Mac create-with-file start is idempotent');assert.equal(done.ask.status,'answered');assert.equal(publicObject(done).files.receipts[0].sha256,done.files.receipts[0].sha256);
 const unrelated=await f.service.create('A hook');await assert.rejects(f.service.addModelFile(unrelated.id,'caliper.3mf',bytes),/model’s link/);await assert.rejects(f.service.addModelFile(object.id,'fake.3mf',Buffer.from('PK-not-a-3mf')));
});
test('several plates ask by real IDs and never silently print the first',async t=>{
 const f=await setup(t),object=await f.service.create('Print this','published',LINK),bytes=model('Two sizes',2),asking=await f.service.addModelFile(object.id,'sizes.3mf',bytes);assert.equal(asking.state,'needs-closeup');assert.deepEqual(asking.ask.options.map(x=>x.id),['0:0','0:1']);await assert.rejects(f.service.print(object.id),/Choose the model/);await assert.rejects(f.service.answerAsk(object.id,asking.ask.id,['0:8']),/Pick one/);
 const dispatch=createControlDispatcher({auth:{},companionVersion:'test',objects:f.service}),done=(await dispatch('objects.answerAsk',{id:object.id,askId:asking.ask.id,choices:['0:1']})).object;assert.equal(done.state,'ready');assert.equal(done.publishedSelection.plateIndex,1);assert.deepEqual(await readFile(join(f.service.dir(object.id),done.current.model)),bytes);await assert.rejects(f.service.answerAsk(object.id,asking.ask.id,['0:0']),/answered or replaced/);
});
test('same names never overwrite an earlier original',async t=>{
 const f=await setup(t),object=await f.service.create('Print this','published',LINK),bytes=model('First');const first=await f.service.addModelFile(object.id,'model.3mf',bytes),next=await f.service.addModelFile(object.id,'model.3mf',model('Second'));assert.equal(next.files.original.length,2);assert.equal(next.ask.type,'choice');assert.deepEqual(await readFile(join(f.service.dir(object.id),first.files.original[0])),bytes);
});

test('the supplied file cannot overwrite a name the person chose while retrieval was running',async t=>{
 const f=await setup(t),object=await f.service.create('Print this','published',LINK);await f.service.rename(object.id,'My gauge');const done=await f.service.addModelFile(object.id,'model.3mf',model('Published title'));assert.equal(done.title,'My gauge');assert.equal(done.files.receipts[0].title,'Published title');
});
