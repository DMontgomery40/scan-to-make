import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm,utimes,symlink,chmod,lstat} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {HandoffBundleStore,InMemoryElicitationRelay,PrinterHandoffRunner,PrinterMcpError,inspectModelFile} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {buildPublishedInvocation,runPublishedWorker,findNamed,defaultRunPublished,arrivedDuring,snapshotFolders,chromeAvailable,folderAccess} from '../dist/published/published.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {mcpPlates, mcpPlatesResult, showing, showingRunner, shownSlice} from './support/shown-print.mjs';
import {tempDir} from './support/temp.mjs';
const {zipSync,strToU8}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
const LINK='https://makerworld.com/en/models/198362-vernier-caliper-ruler-two-lengths';
const model=(title='Caliper',plates=1)=>Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),
 '3D/3dmodel.model':strToU8(`<model><metadata name="Title">${title}</metadata><metadata name="Designer">Fixture Designer</metadata><metadata name="License">Fixture licence</metadata><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>`),
 'Metadata/model_settings.config':strToU8(`<config>${Array.from({length:plates},(_,i)=>`<plate><metadata key="plater_id" value="${i+1}"/><metadata key="plater_name" value="Size ${i+1}"/></plate>`).join('')}</config>`)}));
async function setup(t,runPublished=async()=>({status:'needs_file'}),extra={}){
 const root=await tempDir('published-test-'),store=new ObjectStore(join(root,'objects')),events=[];let holds=0;
 const service=new ObjectService({store,stlInfo:async()=>[1,2,3],claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},
 printGate:{updating:()=>false,hold:()=>{holds++;return()=>{holds--;};}},runPublished,runTouchup:async()=>{throw Error('published retrieval entered design');},events:{emit:async e=>events.push(e)},titleFor:async()=>'Generated',
  // A printer whose MCP lists a 3MF's plates (list_3mf_plates); a test that needs none passes print: undefined.
  print:{services:{runner:{backend:'bambu-printer-mcp',modelPlates:mcpPlates,runBundle:async()=>{throw Error('unused');}}}},...extra});
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});return{root,store,service,events,holds:()=>holds};
}
function spawnAnswer(answer){return()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{child.stdout.end(JSON.stringify({type:'result',structured_output:answer})+'\n');setImmediate(()=>child.emit('close',0));});return child;};}
test('retrieval has browser/web but no printer, geometry, heating or dispatch tools',async t=>{
 const f=await setup(t),pass=await prepareTouchupPass({root:f.root,objectId:'p',scan:[],photos:[],requirePhotos:false});
 const inv=buildPublishedInvocation({pass,printer:{command:'/unused'},claudePath:'/c',request:LINK,link:{url:LINK,site:'MakerWorld'},chrome:true});
 assert.deepEqual(inv.args[inv.args.indexOf('--allowedTools')+1].split(','),['Read','Glob','WebSearch','WebFetch','mcp__claude-in-chrome']);assert.deepEqual(inv.mcpConfig.mcpServers,{});assert.ok(inv.args.includes('--chrome'));
 const cancelled=await runPublishedWorker(inv,pass,{url:LINK,site:'MakerWorld'},{signal:AbortSignal.abort(),spawn:()=>{throw Error('spawned after cancellation');}});assert.equal(cancelled.status,'failed');
});
test('the production pass says when it had no browser to download with (a starter then asks for the files)',async t=>{
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);
 for(const chrome of [false,true]){
  const got=await defaultRunPublished({root:join(f.root,`passes-${chrome}`),photos:[],request:'Print this',link:{url:LINK,site:'MakerWorld'},claudePath:'/c',startedAtMs:Date.now()},
   {chrome:()=>chrome,downloads,spawn:spawnAnswer({status:'needs_file',summary:'Not signed in.'})});
  assert.equal(got.status,'needs_file');assert.equal(got.browser,chrome);
  assert.equal(got.reason,'other','no structured reason is never read as a sign-in');assert.equal(got.run.chrome,chrome);
 }
 // The worker's own structured reason comes through, with what finds its transcript; prose is never parsed for it.
 const why=await defaultRunPublished({root:join(f.root,'passes-why'),photos:[],request:'Print this',link:{url:LINK,site:'MakerWorld'},claudePath:'/c',startedAtMs:Date.now()},
  {chrome:()=>true,downloads,spawn:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{
   child.stdout.end(JSON.stringify({type:'result',session_id:'abc-123',structured_output:{status:'needs_file',reason:'site_error',summary:'The file server answered 503.'}})+'\n');setImmediate(()=>child.emit('close',0));});return child;}});
 assert.equal(why.reason,'site_error');assert.equal(why.summary,'The file server answered 503.');assert.equal(why.run.sessionId,'abc-123');assert.equal(why.run.exitCode,0);
 const odd=await defaultRunPublished({root:join(f.root,'passes-odd'),photos:[],request:'Print this',link:{url:LINK,site:'MakerWorld'},claudePath:'/c',startedAtMs:Date.now()},
  {chrome:()=>true,downloads,spawn:spawnAnswer({status:'needs_file',reason:'cookies_please',summary:'x'})});
 assert.equal(odd.reason,'other');
 // An API or endpoint worker can't drive Chrome even when its extension is set up: it isn't offered it, and says so.
 let args;
 const apiWorker=Object.assign(async inv=>{args=inv.args;return {toolCalls:0,stderrTail:'',exitCode:0,seconds:0,publicText:x=>x,resultEvent:{type:'result',structured_output:{status:'needs_file',summary:'Not signed in.'}}};},{browser:false});
 const api=await defaultRunPublished({worker:apiWorker,root:join(f.root,'passes-api'),photos:[],request:'Print this',link:{url:LINK,site:'MakerWorld'},claudePath:'/c',startedAtMs:Date.now()},{chrome:()=>true,downloads});
 assert.equal(api.status,'needs_file');assert.equal(api.browser,false);assert.ok(!args.includes('--chrome'));
});
test('the companion lists every model file that arrived during the pass itself; hidden browser temp files and earlier ones never count',async t=>{
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);
 await writeFile(join(downloads,'before.3mf'),model());
 await new Promise(r=>setTimeout(r,30));
 const startedAtMs=Date.now();
 const pass=await prepareTouchupPass({root:join(f.root,'passes'),objectId:'p',scan:[],photos:[],requirePhotos:false});
 // The worker "clicks Download" (the file lands under the site's own name) and then says it couldn't find it.
 const spawn=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(async()=>{
  await writeFile(join(downloads,'Vernier+Caliper+Ruler+150mm+COLOR-02.3mf'),model());await writeFile(join(downloads,'.com.brave.Browser.52WYTj'),model());
  await writeFile(join(downloads,'notes.txt'),'x');
  child.stdout.end(JSON.stringify({type:'result',structured_output:{status:'needs_file',reason:'download_not_saved',summary:'Nothing arrived.'}})+'\n');setImmediate(()=>child.emit('close',0));});return child;};
 const got=await runPublishedWorker({command:'/c',args:[],env:{},cwd:pass.dir,mcpConfigPath:'',mcpConfig:{mcpServers:{}}},pass,{url:LINK,site:'MakerWorld'},{downloads,spawn,startedAtMs});
 assert.equal(got.status,'needs_file');assert.deepEqual(got.arrived,[join(downloads,'Vernier+Caliper+Ruler+150mm+COLOR-02.3mf')]);
 assert.deepEqual(await arrivedDuring([downloads],startedAtMs,startedAtMs-1),[],'nothing arrives in an empty window');
 // The extension may run in Chrome or another Chromium browser (David's is Brave): any of their hosts counts.
 await mkdir(join(f.root,'brave'));await writeFile(join(f.root,'brave','host.json'),'{}');
 assert.equal(chromeAvailable([join(f.root,'chrome','host.json'),join(f.root,'brave','host.json')]),true);
 assert.equal(chromeAvailable([join(f.root,'chrome','host.json')]),false);
});
test('file arrival uses the pre-worker snapshot when filesystem and wall clocks disagree',async t=>{
 const f=await setup(t),path=join(f.root,'boundary.3mf');
 const before=new Set();await writeFile(path,model());
 const info=await lstat(path),atMs=info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs;
 // A cached filesystem tick can precede the pass; a fractional tick can follow its integer end.
 for(const tick of [Math.floor(atMs)-1,Math.ceil(atMs)+10]){
  assert.deepEqual(await arrivedDuring([f.root],tick,tick,new Map([[f.root,before]])),[path]);
  assert.deepEqual(await arrivedDuring([f.root],tick,tick,new Map([[f.root,new Set([path])]])),[]);
 }
});
test('a folder the snapshot could not list falls back to the time window, never counting every old file as arrived',async t=>{
 const f=await setup(t),path=join(f.root,'old.3mf');await writeFile(path,model());
 const missing=join(f.root,'not-yet');
 const snapshot=await snapshotFolders([missing]);
 assert.equal(snapshot.has(missing),false,'an unlistable folder has no snapshot entry');
 const info=await lstat(path),atMs=info.birthtimeMs>0?info.birthtimeMs:info.mtimeMs;
 // f.root has no entry either: the old file is judged by the window, which excludes it.
 assert.deepEqual(await arrivedDuring([f.root],atMs+1000,atMs+2000,snapshot),[]);
 assert.deepEqual(await arrivedDuring([f.root],Math.floor(atMs)-1,Math.ceil(atMs)+1,snapshot),[path]);
});
test('a Downloads folder macOS privacy refuses is "denied", never an empty folder, and the pass says so',async t=>{
 if(process.getuid?.()===0)return t.skip('root reads any folder');
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);
 assert.equal(await folderAccess(downloads),'ok');assert.equal(await folderAccess(join(f.root,'nowhere')),'missing');
 await chmod(downloads,0o000);t.after(()=>chmod(downloads,0o700).catch(()=>{}));
 assert.equal(await folderAccess(downloads),'denied');
 const pass=await prepareTouchupPass({root:join(f.root,'passes'),objectId:'p',scan:[],photos:[],requirePhotos:false});
 const got=await runPublishedWorker({command:'/c',args:[],env:{},cwd:pass.dir,mcpConfigPath:'',mcpConfig:{mcpServers:{}}},pass,{url:LINK,site:'MakerWorld'},{downloads,spawn:spawnAnswer({status:'needs_file',reason:'other',summary:'x'})});
 assert.equal(got.status,'needs_file');assert.equal(got.downloadsDenied,true);
});
test('old Downloads names require confirmation; escapes and symlinks never establish identity',async t=>{
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);const path=join(downloads,'caliper.3mf');await writeFile(path,model());const yesterday=new Date(Date.now()-86400000);await utimes(path,yesterday,yesterday);await symlink(path,join(downloads,'alias.3mf'));
 assert.deepEqual((await findNamed(['../caliper.3mf','alias.3mf'],[downloads])).found,[]);
 const pass=await prepareTouchupPass({root:join(f.root,'passes'),objectId:'p',scan:[],photos:[],requirePhotos:false});
 const got=await runPublishedWorker({command:'/c',args:[],env:{},cwd:pass.dir,mcpConfigPath:'',mcpConfig:{mcpServers:{}}},pass,{url:LINK,site:'MakerWorld'},{downloads,spawn:spawnAnswer({status:'downloaded',summary:'Got file',download:{files:['caliper.3mf']}})});
 assert.equal(got.status,'needs_file');assert.equal(got.candidate,path);
 assert.equal(got.reason,'download_not_saved','it said downloaded, but no fresh file arrived');
});
test('a named file that appears during the pass counts as downloaded even when its timestamp lags the pass start',async t=>{
 const f=await setup(t),downloads=join(f.root,'Downloads');await mkdir(downloads);const path=join(downloads,'caliper.3mf');
 const pass=await prepareTouchupPass({root:join(f.root,'passes'),objectId:'p',scan:[],photos:[],requirePhotos:false});
 const answer=spawnAnswer({status:'downloaded',summary:'Got file',download:{files:['caliper.3mf']}});
 // The file system's clock reads a minute behind the pass's own start.
 const spawn=(...args)=>{writeFileSync(path,model());return answer(...args);};
 const got=await runPublishedWorker({command:'/c',args:[],env:{},cwd:pass.dir,mcpConfigPath:'',mcpConfig:{mcpServers:{}}},pass,{url:LINK,site:'MakerWorld'},{downloads,spawn,startedAtMs:Date.now()+60_000});
 assert.equal(got.status,'downloaded');assert.deepEqual(got.files,[path]);
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

test('a downloaded archive without geometry fails the pass instead of remaining Working',async t=>{
 let file;
 const f=await setup(t,async()=>({status:'downloaded',files:[file]}));
 file=join(f.root,'empty-caliper.3mf');
 await writeFile(file,Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),'3D/3dmodel.model':strToU8('<model><resources/><build/></model>')})));
 const object=await f.service.create('Print this','published',LINK);
 await f.service.start(object.id);
 const failed=await f.service.settled(object.id);
 assert.equal(failed.state,'failed');assert.match(failed.failure,/no model or printable plate/);assert.equal(failed.current,undefined);
 assert.equal(failed.passes.at(-1).status,'failed');assert.ok(f.events.some(event=>event.type==='pass.failed'));assert.equal(f.holds(),0);
 const retried=await f.service.start(object.id);assert.equal(retried.state,'touching-up');await f.service.settled(object.id);
});

test('estimate cache distinguishes selected plates even for identical original files',async t=>{
 const seen=[];
 const runner={backend:'bambu-printer-mcp',modelPlates:mcpPlates,estimate:async input=>{seen.push(input.selection.plateIndex);return{estimate:{seconds:(input.selection.plateIndex+1)*100},settings:{}};}};
 const f=await setup(t,undefined,{print:{services:{runner,selection:{model:'p1s'}}}});
 const ids=[];const bytes=model('Two plates',2);
 for(let plate=0;plate<2;plate++){
  const object=await f.service.create('Print this','published',LINK),asking=await f.service.addModelFile(object.id,'model.3mf',bytes);
  await f.service.answerAsk(object.id,asking.ask.id,[`0:${plate}`]);ids.push(object.id);
 }
 const estimates=await Promise.all(ids.map(id=>f.service.estimate(id)));
 assert.deepEqual(estimates.map(x=>x.seconds),[100,200]);assert.deepEqual(seen.sort(),[0,1]);
});

for (const extension of ['3mf','3MF']) test(`published ${extension} preserves multi-filament bytes instead of inheriting a hidden material default`,async t=>{
 const runs=[];
 const f=await setup(t);
 const bundles=new HandoffBundleStore(join(f.root,'bundles')),relay=new InMemoryElicitationRelay({timeoutMs:1000});
 const service=showing(new ObjectService({store:f.store,stlInfo:async()=>[1,2,3],claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},
  print:{services:{store:bundles,relay,selection:{model:'p1s'},runner:showingRunner({backend:'bambu-printer-mcp',filaments:async()=>{throw Error('hidden material lookup');},runBundle:async(store,id,options)=>{runs.push({id,options});return{bundleId:id};}})}}}));
 t.after(()=>service.close());
 const {unzipSync}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
 const entries=unzipSync(model());entries['Metadata/project_settings.config']=strToU8(JSON.stringify({filament_colour:['#FF0000','#0000FF'],filament_type:['PLA','PETG']}));const bytes=Buffer.from(zipSync(entries));
 const object=await service.create('Print this','published',LINK);await service.addModelFile(object.id,`multicolour.${extension}`,bytes);
 await f.store.update(object.id,o=>({...o,preferences:{printDefaults:{colour:{material:'ABS'}}}}));
 const started=await service.print(object.id);await service.settled(object.id);
 assert.equal(runs.length,1);assert.equal(runs[0].options.slicer?.loadFilaments,undefined);assert.equal(runs[0].options.slicer?.filamentColours,undefined);
 const manifest=await bundles.read(started.print.bundleId);assert.equal(manifest.sourceModel.format,'3mf');assert.deepEqual(manifest.selection,{model:'p1s',plateIndex:0});
 assert.deepEqual(await readFile(bundles.stlPath(manifest)),bytes);
 assert.deepEqual((await service.get(object.id)).preferences.printDefaults.colour,{material:'ABS'},'stored preference is preserved');
});

test('duplicating a selected published plate preserves its original receipt and plate for the next handoff',async t=>{
 const selections=[];
 const f=await setup(t,undefined,{print:{services:{selection:{model:'p1s'},runner:{backend:'bambu-printer-mcp',modelPlates:mcpPlates,estimate:async input=>{selections.push(input.selection);return{estimate:{seconds:100},settings:{}};}}}}});
 const source=await f.service.create('Print this','published',LINK);
 await f.service.addModelFile(source.id,'first.3mf',model('First'));
 const bytes=model('Selected second file',2),asking=await f.service.addModelFile(source.id,'second.3mf',bytes);
 const selected=await f.service.answerAsk(source.id,asking.ask.id,['1:1']);
 const copy=await f.service.duplicate(source.id);
 assert.deepEqual(copy.publishedSelection,{fileIndex:0,plateIndex:1,sliced:false});
 assert.equal(copy.files.receipts.length,1);assert.deepEqual(copy.files.receipts[0],selected.files.receipts[1]);
 assert.deepEqual(copy.files.original,[selected.current.model]);assert.equal(copy.files.current,copy.current.model);
 assert.deepEqual(await readFile(join(f.service.dir(copy.id),copy.current.model)),bytes);assert.deepEqual(copy.credit,selected.credit);
 await f.service.estimate(copy.id);assert.equal(selections.at(-1).plateIndex,1);
});

for (const action of ['estimate','print']) test(`pre-sliced original ${action} keeps explicit one copy over configured repetitions`,async t=>{
 const root=await tempDir('published-sliced-copy-'),store=new ObjectStore(join(root,'objects')),calls=[];
 const {unzipSync}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
 const entries=unzipSync(model());entries['Metadata/plate_1.gcode']=strToU8('; estimated printing time (normal mode) = 1m\nG1 X1');const bytes=Buffer.from(zipSync(entries));
 const session={hold:()=>()=>{},connect:async()=>({tools:[]}),config:{backend:'bambu-printer-mcp'},hasTool:name=>['inspect_print_file','print_3mf','counterpart_printer_info','list_3mf_plates'].includes(name),getTool:name=>({name,inputSchema:{type:'object',properties:Object.fromEntries(['file_path','bambu_model','plate_index','three_mf_path','include_preview','include_thumbnails'].map(x=>[x,{}]))}}),call:async(name,args,opts)=>{
  if(name==='list_3mf_plates')return mcpPlatesResult(args.three_mf_path);
  // What bambu-printer-mcp answers for a P1S (counterpart/1).
  if(name==='counterpart_printer_info')return{content:[{type:'text',text:JSON.stringify({contract:'counterpart/1',server:{name:'bambu-printer-mcp',version:'1.1.61'},printer:{kind:'bambu',host:'h'},capabilities:{progress:true,layers:true,camera:'none',filaments:'ams',pause:true,resume:true,cancel:true,print3mf:true,gcode:true}})}]};
  calls.push({name,args});
  if(name==='inspect_print_file'){const sha256=inspectModelFile(bytes,'3mf').sha256;const view=v=>({name:v,label:v,png_base64:shownSlice().preview.views[0].png,width:1,height:1});
   return{content:[{type:'text',text:JSON.stringify({artifact:{sha256},selection:{plate_index:0,bambu_model:'p1s'},...(args.include_preview?{preview:{artifact_sha256:sha256,views:[view('top'),view('bed_side')]}}:{})})}]};}
  if(name==='print_3mf'){await opts?.beforeDispatch?.();return{structuredContent:{jobName:'original'},content:[]};}
  throw Error('Unexpected tool '+name);
 }};
 const runner=new PrinterHandoffRunner({backend:'bambu-printer-mcp',process:{command:'/unused'},selection:{model:'p1s'},slicer:{repetitions:3}},{session});
 const service=showing(new ObjectService({store,claudePath:'/unused',handoff:{backend:'bambu-printer-mcp',process:{command:'/unused'}},print:{services:{runner,store:new HandoffBundleStore(join(root,'bundles')),relay:new InMemoryElicitationRelay({timeoutMs:1000})}}}));
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const object=await service.create('Print this','published',LINK);await service.addModelFile(object.id,'original.3mf',bytes);
 if(action==='estimate')await service.estimate(object.id,{copies:1});
 else {await service.print(object.id,{copies:1});const settled=await service.settled(object.id);assert.notEqual(settled.state,'failed',settled.failure);}
 // Print goes through the sheet: its preview's inspection, then the same file checked just before it is sent.
 assert.deepEqual(calls.map(x=>x.name),action==='estimate'?['inspect_print_file']:['inspect_print_file','inspect_print_file','print_3mf']);
 assert.deepEqual(await readFile(join(service.dir(object.id),(await service.get(object.id)).current.model)),bytes);
});

// #641 review (P1): a designer's 3MF kept as it came is kept like a published file: every plate listed, the person picks.
test('a multi-plate designer 3MF sent as a copy with no words lists its plates and asks which to print; any plate prints',async t=>{
 const seen=[];
 const runner={backend:'bambu-printer-mcp',modelPlates:mcpPlates,estimate:async input=>{seen.push(input.selection.plateIndex);return{estimate:{seconds:100},settings:{}};}};
 const f=await setup(t,undefined,{print:{services:{runner,selection:{model:'p1s'}}}});
 const object=await f.service.create(undefined,'copy');await f.service.addScan(object.id,'scan.3mf',model('Two sizes',2));
 const asking=await f.service.start(object.id);
 assert.equal(asking.kind,'copy','still a copy: words later edit the designer\'s file');
 assert.equal(asking.state,'needs-closeup');assert.equal(asking.ask.type,'choice');assert.deepEqual(asking.ask.options.map(o=>o.id),['0:0','0:1']);
 assert.equal(publicObject(asking).plates.length,2,'every layout\'s plate picker');
 const chosen=await f.service.answerAsk(object.id,asking.ask.id,['0:1']);
 assert.equal(chosen.state,'ready');assert.equal(chosen.kind,'copy');assert.deepEqual(chosen.publishedSelection,{fileIndex:0,plateIndex:1,sliced:false});
 await f.service.estimate(object.id);assert.deepEqual(seen,[1],'plate 2 is what slices');
 const back=await f.service.selectPlate(object.id,0,0);assert.equal(back.publishedSelection.plateIndex,0);
});

// #641 review (P2): an already-sliced plate kept as it came prints as it is, as the published path does.
test('a sliced designer 3MF sent as a copy with no words estimates as the sliced file it is',async t=>{
 const root=await tempDir('copy-sliced-'),store=new ObjectStore(join(root,'objects')),calls=[];
 const {unzipSync}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
 const entries=unzipSync(model());entries['Metadata/plate_1.gcode']=strToU8('; estimated printing time (normal mode) = 1m\nG1 X1');const bytes=Buffer.from(zipSync(entries));
 const session={hold:()=>()=>{},connect:async()=>({tools:[]}),config:{backend:'bambu-printer-mcp'},hasTool:name=>['inspect_print_file','print_3mf','counterpart_printer_info','list_3mf_plates'].includes(name),getTool:name=>({name,inputSchema:{type:'object',properties:Object.fromEntries(['file_path','bambu_model','plate_index','three_mf_path','include_preview','include_thumbnails'].map(x=>[x,{}]))}}),call:async(name,args)=>{
  if(name==='list_3mf_plates')return mcpPlatesResult(args.three_mf_path);
  if(name==='counterpart_printer_info')return{content:[{type:'text',text:JSON.stringify({contract:'counterpart/1',server:{name:'bambu-printer-mcp',version:'1.1.61'},printer:{kind:'bambu',host:'h'},capabilities:{progress:true,layers:true,camera:'none',filaments:'ams',pause:true,resume:true,cancel:true,print3mf:true,gcode:true}})}]};
  calls.push({name,args});
  if(name==='inspect_print_file'){const sha256=inspectModelFile(bytes,'3mf').sha256;return{content:[{type:'text',text:JSON.stringify({artifact:{sha256},selection:{plate_index:0,bambu_model:'p1s'}})}]};}
  throw Error('Unexpected tool '+name);
 }};
 const runner=new PrinterHandoffRunner({backend:'bambu-printer-mcp',process:{command:'/unused'},selection:{model:'p1s'}},{session});
 const service=showing(new ObjectService({store,claudePath:'/unused',stlInfo:async()=>[1,2,3],runTouchup:async()=>{throw Error('no pass');},handoff:{backend:'bambu-printer-mcp',process:{command:'/unused'}},print:{services:{runner,store:new HandoffBundleStore(join(root,'bundles')),relay:new InMemoryElicitationRelay({timeoutMs:1000})}}}));
 t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 const object=await service.create(undefined,'copy');await service.addScan(object.id,'scan.3mf',bytes);
 const kept=await service.start(object.id);
 assert.equal(kept.state,'ready');assert.deepEqual(kept.publishedSelection,{fileIndex:0,plateIndex:0,sliced:true});
 await service.estimate(object.id);
 assert.deepEqual(calls.map(x=>x.name),['inspect_print_file'],'read as the sliced file it is, never sliced again with filaments loaded');
});

test('six plates stay selectable in one project after the initial choice, including over the Mac socket', async t => {
 const f=await setup(t), object=await f.service.create('Scan platform','published',LINK);
 const imported=await f.service.addModelFile(object.id,'platform.3mf',model('Scan platform',6));
 const chosen=await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 assert.equal(publicObject(chosen).plates.length,6);
 const dispatch=createControlDispatcher({auth:{},companionVersion:'test',objects:f.service});
 const next=(await dispatch('objects.selectPlate',{id:object.id,fileIndex:0,plateIndex:5})).object;
 assert.equal(next.publishedSelection.plateIndex,5);
 assert.equal(next.plates.filter(p=>p.selected).length,1);
 assert.equal(next.plates[5].selected,true);
 assert.equal(next.state,'ready');
 assert.equal((await f.service.list()).length,1);
 await assert.rejects(f.service.selectPlate(object.id,0,6),/plate/i);
 await assert.rejects(f.service.selectPlate(object.id,0,0.5),/plate/i);
});

test('plate completion survives switching and restart; failed reprint does not erase an earlier success', async t => {
 const f=await setup(t), object=await f.service.create('Platform','published',LINK);
 const imported=await f.service.addModelFile(object.id,'platform.3mf',model('Platform',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 const sha=imported.files.receipts[0].sha256;
 await f.store.update(object.id,o=>({...o,state:'printed',print:{bundleId:'b',printId:'p1',plate:{sha256:sha,plateIndex:0},live:{state:'done'},monitor:{phase:'ended',endState:'done'}}}));
 await f.service.selectPlate(object.id,0,1);
 const persisted=await new ObjectStore(join(f.root,'objects')).get(object.id);
 assert.ok(publicObject(persisted).plates[0].completedAtMs);
 assert.equal(publicObject(persisted).plates[1].status,'not-printed');
 assert.equal(persisted.print,undefined);
 await f.service.selectPlate(object.id,0,0);
 await f.store.update(object.id,o=>({...o,state:'failed',print:{bundleId:'b2',printId:'p2',plate:{sha256:sha,plateIndex:0},live:{state:'failed'},monitor:{phase:'ended',endState:'failed'}}}));
 const failed=publicObject(await f.service.selectPlate(object.id,0,2));
 assert.equal(failed.plates[0].status,'failed');
 assert.ok(failed.plates[0].completedAtMs);
 assert.equal(failed.plates.filter(p=>p.completedAtMs).length,1);
});

test('an active print locks plate changes; cancelling does not complete the plate', async t => {
 const f=await setup(t), object=await f.service.create('Platform','published',LINK);
 const imported=await f.service.addModelFile(object.id,'platform.3mf',model('Platform',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 const sha=imported.files.receipts[0].sha256;
 await f.store.update(object.id,o=>({...o,state:'printing',print:{bundleId:'b',printId:'p',plate:{sha256:sha,plateIndex:0},live:{state:'printing'}}}));
 await assert.rejects(f.service.selectPlate(object.id,0,1),/finish/i);
 await f.store.update(object.id,o=>({...o,state:'ready',print:{...o.print,live:{state:'cancelled'},monitor:{phase:'ended',endState:'cancelled'}}}));
 const cancelled=publicObject(await f.service.selectPlate(object.id,0,1));
 assert.equal(cancelled.plates[0].status,'cancelled');
 assert.equal(cancelled.plates[0].completedAtMs,undefined);
 await f.service.selectPlate(object.id,0,1);
});

// David, Nov 6, on his six-plate rig: "i can't select which plate to print in the app i can see them but i can't click
// on them". Plate 1's Print timed out waiting for the printer's MQTT report, so the companion kept it uncertain, and that
// locked every other plate. The doubt belongs to the plate that was sent: the others stay choosable and printable (the
// printer MCP refuses a start unless a fresh report shows the printer idle), and only that plate asks for a check again.
const NOT_CONFIRMED=/may already be printing/i;
// The shared fixture every client reads (packages/contracts/fixtures/six-plate-unconfirmed.json): checked here against
// what the companion itself serves, so the clients' tests and the companion can't drift apart.
const SIX_PLATES=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/six-plate-unconfirmed.json',import.meta.url),'utf8'));
const plateView=o=>({state:o.state,uncertain:o.print?.uncertain===true,
 plates:o.plates.map(p=>({fileIndex:p.fileIndex,plateIndex:p.plateIndex,selected:p.selected,status:p.status,uncertain:p.uncertain===true}))});
const notConfirmRefusal=e=>{assert.doesNotMatch(String(e?.message??e),NOT_CONFIRMED);return true;};
for(const [name,end] of [['a timed-out start','failed'],['a send it could not follow','sent']])
test(`after ${name} on one plate, the other plates stay choosable; only that plate asks for a printer check`, async t => {
 const f=await setup(t), object=await f.service.create('Scan rig','published',LINK);
 const imported=await f.service.addModelFile(object.id,'rig.3mf',model('Scan rig',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 const sha=imported.files.receipts[0].sha256;
 await f.store.update(object.id,o=>({...o,state:end,failure:end==='failed'?'Printer service: Error: Timed out waiting for a fresh MQTT safety report':undefined,
  print:{bundleId:'b',printId:'p',uncertain:true,plate:{sha256:sha,plateIndex:0},...(end==='sent'?{monitor:{phase:'ended',endState:'sent'}}:{})}}));
 assert.equal(publicObject(await f.service.get(object.id)).plates[0].status,end==='sent'?'sent':'unknown');
 if(end==='failed'){
  assert.deepEqual(plateView(publicObject(await f.service.get(object.id))),plateView(SIX_PLATES.unconfirmed));
  assert.deepEqual(plateView(publicObject(await f.service.selectPlate(object.id,0,3))),plateView(SIX_PLATES.switched));
  assert.deepEqual(plateView(publicObject(await f.service.selectPlate(object.id,0,0))),plateView(SIX_PLATES.back));
 }
 for(const plateIndex of [3,5,1]){
  const moved=publicObject(await f.service.selectPlate(object.id,0,plateIndex));
  assert.equal(moved.plates[plateIndex].selected,true);
  assert.equal(moved.plates[0].status,end==='sent'?'sent':'unknown');
  await assert.rejects(f.service.print(object.id,{expectedPlate:moved.plates[plateIndex].id}),notConfirmRefusal);
 }
 // Back on the plate that may have started: Print asks for the check, and the check lets it through.
 const back=publicObject(await f.service.selectPlate(object.id,0,0));
 await assert.rejects(f.service.print(object.id,{expectedPlate:back.plates[0].id}),NOT_CONFIRMED);
 await assert.rejects(f.service.print(object.id,{expectedPlate:back.plates[0].id,checked:true}),notConfirmRefusal);
 // Status → Not Printed settles it as well as Printed does: the person looked and nothing started.
 const settled=publicObject(await f.service.setStatus(object.id,'not-printed'));
 assert.equal(settled.plates[0].status,'not-printed');
 assert.equal(settled.print?.uncertain,undefined);
 await assert.rejects(f.service.print(object.id,{expectedPlate:settled.plates[0].id}),notConfirmRefusal);
});

// Codex on #380: a send that was cancelled before anything went out (a declined print confirmation, or the MCP's
// print-choice "Not printed.") returns to Ready with its print record and no end state. It reads "unknown", but it was
// never sent, so Print doesn't ask for the printer check.
for(const [name,failure] of [['a cancelled confirmation',undefined],['a print-choice refusal','Not printed.']])
test(`${name} never asks for the printer check`, async t => {
 const f=await setup(t), object=await f.service.create('Scan rig','published',LINK);
 const imported=await f.service.addModelFile(object.id,'rig.3mf',model('Scan rig',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 const sha=imported.files.receipts[0].sha256;
 await f.store.update(object.id,o=>({...o,state:'ready',...(failure?{failure}:{}),print:{bundleId:'c',printId:'c1',plate:{sha256:sha,plateIndex:0}}}));
 const shown=publicObject(await f.service.get(object.id));
 assert.deepEqual(plateView(shown),plateView(SIX_PLATES.cancelled));
 await assert.rejects(f.service.print(object.id,{expectedPlate:shown.plates[0].id}),notConfirmRefusal);
});

test('a stale sheet cannot dispatch the plate another client selected', async t => {
 const f=await setup(t), object=await f.service.create('Platform','published',LINK);
 const imported=await f.service.addModelFile(object.id,'platform.3mf',model('Platform',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 const first=publicObject(await f.service.get(object.id)).plates[0].id;
 await f.service.selectPlate(object.id,0,5);
 await assert.rejects(f.service.print(object.id,{expectedPlate:first}),/plate changed/i);
});

test('renamed copies of an original do not duplicate plates or completion counts',async t=>{
 const f=await setup(t), object=await f.service.create('Platform','published',LINK), bytes=model('Platform',6);
 await f.service.addModelFile(object.id,'platform.3mf',bytes);
 const again=await f.service.addModelFile(object.id,'platform (1).3mf',bytes);
 const plates=publicObject(again).plates;
 assert.equal(plates.length,6);assert.equal(new Set(plates.map(p=>p.id)).size,6);
});

test('explicit Printed acknowledges just the selected plate, including unmonitored prints',async t=>{
 const f=await setup(t), object=await f.service.create('Platform','published',LINK);
 const imported=await f.service.addModelFile(object.id,'platform.3mf',model('Platform',6));
 await f.service.answerAsk(object.id,imported.ask.id,['0:0']);
 await f.store.update(object.id,o=>({...o,state:'sent',print:{bundleId:'b',printId:'p',uncertain:true,plate:{sha256:o.files.receipts[0].sha256,plateIndex:0},monitor:{phase:'ended',endState:'sent'}}}));
 const acknowledged=publicObject(await f.service.setStatus(object.id,'printed'));
 assert.equal(acknowledged.plates[0].status,'printed');assert.ok(acknowledged.plates[0].completedAtMs);
 await f.service.selectPlate(object.id,0,1);
 const elsewhere=publicObject(await f.service.setStatus(object.id,'works'));
 assert.equal(elsewhere.plates.filter(p=>p.completedAtMs).length,2);
 const reset=publicObject(await f.service.setStatus(object.id,'not-printed'));
 assert.equal(reset.plates[1].status,'not-printed');assert.equal(reset.plates.filter(p=>p.completedAtMs).length,1);
});

// A designer's 3MF keeps its own plates (David, Nov 6: "if i download the 3d scanning rig ... and open it in bambu, it
// just shows up as six plates. BEFORE slicing"). The plates and their pictures are the printer MCP's (list_3mf_plates).
const PNG_1PX=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC','base64');
const kit=()=>{const {unzipSync}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');const entries=unzipSync(model('3D scan platform',6));for(let n=1;n<=6;n++)entries[`Metadata/plate_${n}.png`]=new Uint8Array(PNG_1PX);return Buffer.from(zipSync(entries));};
test('a six-plate kit comes in as its six plates, with their pictures, from the printer MCP',async t=>{
 const asked=[];const f=await setup(t,undefined,{print:{services:{runner:{backend:'bambu-printer-mcp',modelPlates:async input=>{asked.push(input.modelPath);return mcpPlates(input);},runBundle:async()=>{throw Error('unused');}}}}});
 const object=await f.service.create('Print this','published',LINK);const done=await f.service.addModelFile(object.id,'kit.3mf',kit());
 assert.equal(asked.length,1,'the MCP read the kept file');
 assert.deepEqual(done.files.receipts[0].plates.map(p=>[p.index,p.name]),[0,1,2,3,4,5].map(i=>[i,`Size ${i+1}`]));
 for(const plate of done.files.receipts[0].plates)assert.deepEqual(await readFile(join(f.service.dir(object.id),plate.thumbnail)),PNG_1PX);
 assert.equal(publicObject(done).plates.length,6,'every plate in the plate list');
 assert.equal(done.files.receipts[0].platesListed,undefined);
});
test('a 3MF kept with no printer MCP to read it gets its plates when one can',async t=>{
 let reachable=false;const estimates=[];
 const runner={backend:'bambu-printer-mcp',modelPlates:async input=>{if(!reachable)throw new PrinterMcpError('connect-failed');return mcpPlates(input);},
  estimate:async input=>{estimates.push(input.selection?.plateIndex);return{estimate:{seconds:60},settings:{}};},runBundle:async()=>{throw Error('unused');}};
 const f=await setup(t,undefined,{print:{services:{runner,selection:{model:'p1s'}}}});
 const object=await f.service.create('Print this','published',LINK);const kept=await f.service.addModelFile(object.id,'kit.3mf',kit());
 assert.equal(kept.state,'ready');assert.equal(kept.files.receipts[0].platesListed,false);assert.deepEqual(kept.files.receipts[0].plates,[]);
 assert.equal(publicObject(kept).plates.length,1,'one row until the plates are listed');
 reachable=true;
 await f.service.estimate(object.id);
 const listed=await f.service.get(object.id);
 assert.equal(listed.files.receipts[0].platesListed,undefined);assert.equal(listed.files.receipts[0].plates.length,6);
 assert.equal(publicObject(listed).plates.length,6);assert.deepEqual(listed.publishedSelection,{fileIndex:0,plateIndex:0,sliced:false});
 assert.deepEqual(estimates,[0]);
});
test('a printer MCP without list_3mf_plates keeps the file and says to update it where the plates are needed',async t=>{
 const update='Update bambu-printer-mcp in Settings → Printers to show this file’s plates.';
 const runner={backend:'bambu-printer-mcp',modelPlates:async()=>{throw new PrinterMcpError('plates-unsupported',undefined,update);},
  estimate:async()=>{throw Error('estimated without plates');},runBundle:async()=>{throw Error('unused');}};
 const f=await setup(t,undefined,{print:{services:{runner,selection:{model:'p1s'}}}});
 const object=await f.service.create('Print this','published',LINK);const kept=await f.service.addModelFile(object.id,'kit.3mf',kit());
 assert.equal(kept.files.receipts[0].platesListed,false);
 await assert.rejects(f.service.estimate(object.id),{message:update});
});
// Codex on #370: plates are listed through the MCP of the printer the estimate is for, not the startup one.
test('plates are listed through the chosen printer’s MCP, not the startup one',async t=>{
 const update='Update mcp-3D-printer-server in Settings → Printers to show this file’s plates.';
 const startup={backend:'mcp-3d-printer-server',modelPlates:async()=>{throw new PrinterMcpError('plates-unsupported',undefined,update);},runBundle:async()=>{throw Error('unused');}};
 const asked=[];
 const chosen={backend:'bambu-printer-mcp',modelPlates:async input=>{asked.push(input);return mcpPlates(input);},estimate:async()=>({estimate:{seconds:60},settings:{}}),runBundle:async()=>{throw Error('unused');}};
 const catalog={defaultDestinationId:'current',destinations:[{id:'current',name:'Startup',backend:'mcp-3d-printer-server'},{id:'p1s',name:'P1S',backend:'bambu-printer-mcp'}],canonical:id=>['current','p1s'].includes(id)?id:undefined,resolve:()=>undefined};
 const f=await setup(t,undefined,{printerCatalog:catalog,print:{services:{runner:startup},destinations:new Map([['current',{runner:startup}],['p1s',{runner:chosen,selection:{model:'p1s'}}]])}});
 const object=await f.service.create('Print this','published',LINK);const kept=await f.service.addModelFile(object.id,'kit.3mf',kit());
 assert.equal(kept.files.receipts[0].platesListed,false,'the default printer’s MCP couldn’t list them');
 await f.service.estimate(object.id,{destinationId:'p1s'});
 // The chosen printer's MCP listed the plates once (with pictures); it may also be asked the chosen plate's filaments.
 assert.equal(asked.filter(input=>input.thumbnails!==false).length,1);assert.ok(asked.every(input=>input.modelPath.endsWith('.3mf')));
 assert.equal((await f.service.get(object.id)).files.receipts[0].plates.length,6);
});
// Codex on #370: an unlisted 3MF that isn't the one being printed never blocks another file's estimate.
test('an unlisted 3MF that isn’t selected doesn’t block the selected STL’s estimate',async t=>{
 const update='Update bambu-printer-mcp in Settings → Printers to show this file’s plates.';
 const runner={backend:'bambu-printer-mcp',modelPlates:async()=>{throw new PrinterMcpError('plates-unsupported',undefined,update);},
  estimate:async()=>({estimate:{seconds:90},settings:{}}),runBundle:async()=>{throw Error('unused');}};
 const f=await setup(t,undefined,{print:{services:{runner,selection:{model:'p1s'}}}});
 const object=await f.service.create('Print this','published',LINK);
 await f.service.addModelFile(object.id,'kit.3mf',kit());
 const stl=Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n');
 const both=await f.service.addModelFile(object.id,'part.stl',stl);
 const stlIndex=both.files.receipts.findIndex(receipt=>receipt.format==='stl');
 if(both.ask?.status==='open')await f.service.answerAsk(object.id,both.ask.id,[`${stlIndex}:0`]);else await f.service.selectPlate(object.id,stlIndex,0);
 assert.equal((await f.service.estimate(object.id)).seconds,90);
 assert.equal((await f.service.get(object.id)).files.receipts.find(receipt=>receipt.format==='3mf').platesListed,false,'still pending');
 // Selecting the 3MF needs its plates: the MCP to update says so.
 await f.service.selectPlate(object.id,both.files.receipts.findIndex(receipt=>receipt.format==='3mf'),0);
 await assert.rejects(f.service.estimate(object.id),{message:update});
});

// Nov 10: a model-file project made with typed words and a file that carries no name sat in the list as its request
// cut off mid-sentence ("First plate from Counterpart's own kernel…"): published projects were never given a
// generated title. One with a real name from its source keeps it.
test('a model file with no name of its own is titled from the person\'s words; one with a name keeps it',async t=>{
 const asked=[];const f=await setup(t,undefined,{titleFor:async request=>{asked.push(request);return 'Kernel wall holder.';}});
 const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timed out');};
 const words='First plate from our own kernel: a wall holder for the bike-oil bottle, and three more parts on one plate';
 // Before the file is here nothing is generated: the source's own name may still arrive.
 const unnamed=await f.service.create(words,'published',LINK);
 await f.service.list();await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(asked,[],'not before the file arrives');
 assert.equal(publicObject(await f.store.get(unnamed.id)).title,'First plate from our own kernel…','until then, the first words');
 const arrived=await f.service.addModelFile(unnamed.id,'first-plate.3mf',model(''));
 assert.equal(arrived.state,'ready');
 await until(async()=>(await f.store.get(unnamed.id)).title==='Kernel wall holder');
 assert.deepEqual(asked,[words],'asked once, with what the person typed');
 // A file that names itself keeps that name, and nothing is generated for it.
 const named=await f.service.create('Print this in black','published',LINK);
 const done=await f.service.addModelFile(named.id,'caliper.3mf',model('Vernier caliper'));
 assert.equal(done.title,'Vernier caliper');
 await f.service.list();await new Promise(r=>setTimeout(r,30));
 assert.equal(asked.length,1);
 assert.equal((await f.store.get(named.id)).title,'Vernier caliper');
 // A name the person gave is never replaced either.
 const renamed=await f.service.create(words,'published',LINK);await f.service.rename(renamed.id,'My plate');
 await f.service.addModelFile(renamed.id,'plate.3mf',model(''));
 await f.service.list();await new Promise(r=>setTimeout(r,30));
 assert.equal((await f.store.get(renamed.id)).title,'My plate');
 assert.equal(asked.length,1);
});

test('an older model-file project with words and no name gets its title when the list is read',async t=>{
 const asked=[];const f=await setup(t,undefined,{titleFor:async request=>{asked.push(request);return 'Kernel wall holder';}});
 const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timed out');};
 // As stored before this: published, printed, a file, the person's words, no title.
 const old=await f.store.update((await f.store.create('First plate from our own kernel: a wall holder','published')).id,o=>({...o,state:'printed',current:{model:'current/model.3mf',renders:[]}}));
 // Nothing to say and no name: left alone.
 const wordless=await f.store.update((await f.store.create(undefined,'published')).id,o=>({...o,state:'ready',current:{model:'current/model.3mf',renders:[]}}));
 await f.service.list();
 await until(async()=>(await f.store.get(old.id)).title==='Kernel wall holder');
 await f.service.list();
 assert.deepEqual(asked,['First plate from our own kernel: a wall holder']);
 assert.equal((await f.store.get(wordless.id)).title,undefined);
});
