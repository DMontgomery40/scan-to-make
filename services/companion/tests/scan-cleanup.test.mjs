import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ScanProcessingStore} from '../dist/scan-processing.js';
import {DetailStillStore} from '../dist/detail-stills.js';
import {fixture,fakeRunner,png,sha,cube} from './fixtures/scan-processing.mjs';

function cleanupRunner(failCorrect=false){
 return {...fakeRunner,cleanup:{adapter:'scripted',async run(stage,ctx){
  if(stage==='import'){
   await mkdir(ctx.imported,{recursive:true});
   await writeFile(join(ctx.imported,'mesh.obj'),cube);
   await writeFile(join(ctx.imported,'conversion.json'),JSON.stringify({tool:'capture-mesh-convert',toolVersion:'0.3.0',metricQualified:true,metricQualifiedReason:null,unsupportedFeatures:[],unitsAuthored:true,upAxis:'Y',metersPerUnit:1,source:{sha256:sha(await readFile(ctx.source)),bytes:(await readFile(ctx.source)).length},output:{sha256:sha(cube),bytes:cube.length,format:'obj'},outputBasis:{coordinates:'world',units:'native stage units (unrescaled)',metersPerUnit:1,upAxis:'Y'},contributingLayers:[{identifier:'synthetic.usdc',sha256:'a'.repeat(64),bytes:30}],provesCompleteCapture:false,provesPhysicalFit:false,outputs:[{path:'mesh.obj',sha256:sha(cube),bytes:cube.length}]}));
  }
  if(stage==='advise'){
   await mkdir(join(ctx.advice,'renders'),{recursive:true});await writeFile(join(ctx.advice,'renders/target-01.png'),png);
   await writeFile(join(ctx.advice,'advice.json'),JSON.stringify({closeupAdvice:{targets:[{rank:1,render:{path:'renders/target-01.png',sha256:sha(png)}}]}}));
  }
  if(stage==='correct'){
   if(failCorrect)throw Error('private provider detail');
   await mkdir(ctx.corrected,{recursive:true});await writeFile(join(ctx.corrected,'corrected.obj'),cube);
   await writeFile(join(ctx.corrected,'corrected.stl'),'synthetic final stl');await writeFile(join(ctx.corrected,'tool-calls.jsonl'),'{}\n');
   await writeFile(join(ctx.corrected,'report.json'),JSON.stringify({status:'complete',outputs:{'corrected.obj':sha(cube),'corrected.stl':sha(Buffer.from('synthetic final stl'))},
    toolLogSha256:sha(Buffer.from('{}\n'))}));
  }
  return Buffer.from('{}');
 }}};
}

test('one cleanup job imports, repairs, advises, corrects, measures and renders with retained stills',async t=>{
 const runner=cleanupRunner(),f=await fixture(t,runner);
 const stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 const added=await stills.addDetailStill({...f.input,source:png,label:'Synthetic port'});
 const {job}=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});
 await f.store.wait();const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.status,'succeeded');
 assert.deepEqual(result.pipelineStages.map(s=>s.kind),['import','repair','advise','correct','measure','render']);
 assert(result.pipelineStages.every(s=>s.status==='succeeded'));
 assert.equal(result.detailStills[0].id,added.still.id);
 assert.equal(result.detailStills[0].sha256,sha(png));
 assert.deepEqual(result.measuredBoxExtentsMm,[62.9,48.7,21.7]);
 const final=await f.store.artifact(f.input,job.jobId,'corrected.stl');
 const legacy=await f.store.artifact(f.input,job.jobId,'repaired.stl');
 assert.equal(final.ref.sha256,legacy.ref.sha256);
 assert.equal((await f.store.artifact(f.input,job.jobId,'advice-01.png')).ref.sha256,sha(png));
});

test('advice survives failed correction, while unfinished geometry stays unavailable',async t=>{
 const f=await fixture(t,cleanupRunner(true));const {job}=await f.store.start(f.input);await f.store.wait();
 const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.status,'failed');assert.equal(result.pipelineStages.find(s=>s.kind==='correct').status,'failed');
 assert.equal((await f.store.artifact(f.input,job.jobId,'advice-01.png')).ref.sha256,sha(png));
 await assert.rejects(f.store.artifact(f.input,job.jobId,'corrected.stl'));
 assert(!JSON.stringify(result).includes('private provider'));
});

test('explicit missing, duplicate or excessive still selections fail before launch',async t=>{
 const f=await fixture(t,cleanupRunner());
 for(const stillIds of [['00000000-0000-4000-8000-000000000000'],Array(5).fill('00000000-0000-4000-8000-000000000000')])
  await assert.rejects(f.store.start({...f.input,request:{stillIds}}));
});

test('reference comparisons use the minimum-volume box, not PCA extents',async t=>{
 const runner=cleanupRunner(),base=runner.run;
 runner.run=async(...args)=>args[0]==='measure'?Buffer.from(JSON.stringify({principalExtentsMm:[70,50,30],boxExtentsMm:[60,40,20]})):base(...args);
 const f=await fixture(t,runner);const {job}=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});await f.store.wait();
 const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.status,'succeeded');assert.deepEqual(result.measuredPrincipalExtentsMm,[70,50,30]);assert.deepEqual(result.comparison.errorMm,[0,0,0]);
});

test('advice is downloadable while correction is running and after cancellation',async t=>{
 const runner=cleanupRunner(),run=runner.cleanup.run;let entered;const active=new Promise(r=>entered=r);
 runner.cleanup.run=async(stage,ctx)=>{if(stage!=='correct')return run(stage,ctx);entered();await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));ctx.signal.throwIfAborted();};
 const f=await fixture(t,runner);const {job}=await f.store.start(f.input);await active;
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'running');
 assert.equal((await f.store.artifact(f.input,job.jobId,'advice-01.png')).ref.sha256,sha(png));
 const result=(await f.store.cancel(f.input,job.jobId)).job;assert.equal(result.failure,'cancelled');
 assert.equal((await f.store.artifact(f.input,job.jobId,'advice-01.png')).ref.sha256,sha(png));
});

test('forged correction output hashes cannot publish geometry',async t=>{
 const runner=cleanupRunner(),run=runner.cleanup.run;
 runner.cleanup.run=async(stage,ctx)=>{const result=await run(stage,ctx);if(stage==='correct')await writeFile(join(ctx.corrected,'corrected.stl'),'tampered');return result;};
 const f=await fixture(t,runner);const {job}=await f.store.start(f.input);await f.store.wait();
 const result=(await f.store.load(f.input,job.jobId)).job;assert.equal(result.status,'failed');assert.equal(result.pipelineStages.find(s=>s.kind==='correct').status,'failed');
 assert.deepEqual(Object.keys(result.artifacts).sort(),['advice-01.png','advice.json']);
 await assert.rejects(f.store.artifact(f.input,job.jobId,'corrected.stl'));
});

test('advice success is committed with artifacts even if cancellation arrives at that commit',async t=>{
 const f=await fixture(t,cleanupRunner());const persist=f.store.persist.bind(f.store);let cancelled,closed;
 f.store.persist=async(r,job)=>{await persist(r,job);if(!cancelled&&job.artifacts?.['advice.json']&&job.status==='running'){cancelled=true;closed=f.store.close();}};
 const {job}=await f.store.start(f.input);await f.store.wait();await closed;
 const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.failure,'cancelled');assert.equal(result.pipelineStages.find(s=>s.kind==='advise').status,'succeeded');
 assert.equal(result.failureStage,'correct');assert.equal((await f.store.artifact(f.input,job.jobId,'advice.json')).ref.mediaType,'application/json');
});

test('whole-job deadline is distinct from user cancellation',async t=>{
 const runner=cleanupRunner(),run=runner.cleanup.run;
 runner.cleanup.run=async(stage,ctx)=>{if(stage!=='correct')return run(stage,ctx);await new Promise(resolve=>ctx.signal.addEventListener('abort',resolve,{once:true}));ctx.signal.throwIfAborted();};
 const f=await fixture(t,runner,500);const {job}=await f.store.start(f.input);await f.store.wait();
 const result=(await f.store.load(f.input,job.jobId)).job;assert.equal(result.failure,'deadline-exceeded');assert.equal(result.failureStage,'correct');assert.equal(result.wallClockLimitMs,500);
});

test('report validation, missing renders and publication rejection identify the failing phase',async t=>{
 for(const phase of ['repair','render','publish','report-write']){
  const runner=cleanupRunner(),run=runner.run;
  runner.run=async(...args)=>{const result=await run(...args);if(args[0]===phase){if(phase==='repair')await writeFile(join(args[2],'report.json'),'invalid JSON');else await (await import('node:fs/promises')).rm(join(args[2],'pos_x.png'));}if(phase==='report-write'&&args[0]==='render')await mkdir(join(args[2],'..','output','report.json'));return result;};
  const f=await fixture(t,runner);let authorizations=0;
  const {job}=await f.store.start(f.input,async()=>{if(phase==='publish'&&++authorizations===3)throw Error('revoked');});await f.store.wait();
  const result=(await f.store.load(f.input,job.jobId)).job;assert.equal(result.status,'failed');assert.equal(result.failureStage,phase==='report-write'?'publish':phase);
  if(['repair','render'].includes(phase))assert.equal(result.pipelineStages.find(s=>s.kind===phase).status,'failed');
 }
});

test('diagnostic retention failure cannot hide the durable correction failure',async t=>{
 const runner=cleanupRunner(true),run=runner.cleanup.run;let f,jobId;
 runner.cleanup.run=async(stage,ctx)=>{if(stage==='correct')await writeFile(join(f.root,'captures',f.input.captureId,'scan-processing',jobId,'private-work'),'occupied');return run(stage,ctx);};
 f=await fixture(t,runner);const {job}=await f.store.start(f.input);jobId=job.jobId;await f.store.wait();
 const result=(await f.store.load(f.input,jobId)).job;assert.equal(result.failure,'processing-failed');assert.equal(result.failureStage,'correct');
 assert.equal(result.pipelineStages.find(s=>s.kind==='correct').status,'failed');
});


test('correction carries its hash-verified material closure into the public result',async t=>{
 const runner=cleanupRunner(),run=runner.cleanup.run;
 const obj=Buffer.from('mtllib mesh.mtl\n'+cube.toString()),mtl=Buffer.from('newmtl captured\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n');
 runner.cleanup.run=async(stage,ctx)=>{
  const result=await run(stage,ctx);
  if(stage==='correct'){
   const report=JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8'));
   for(const [name,bytes] of Object.entries({'corrected.obj':obj,'mesh.mtl':mtl,'mesh_basecolor_0.png':png})){
    await writeFile(join(ctx.corrected,name),bytes);report.outputs[name]=sha(bytes);
   }
   await writeFile(join(ctx.corrected,'report.json'),JSON.stringify(report));
  }
  return result;
 };
 const f=await fixture(t,runner);const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 const {model}=await f.store.modelAssets(f.input,job.jobId);assert.equal(model.files.length,3);
 assert.deepEqual((await f.store.modelAsset(f.input,job.jobId,'repaired.obj')).bytes,obj);
 assert.deepEqual((await f.store.modelAsset(f.input,job.jobId,'mesh.mtl')).bytes,mtl);
 assert.deepEqual((await f.store.modelAsset(f.input,job.jobId,'mesh_basecolor_0.png')).bytes,png);
});

test('correction cannot publish dangling or altered material references',async t=>{
 for(const defect of ['missing','hash','escape','unsupported-map']){
  const runner=cleanupRunner(),run=runner.cleanup.run;
  runner.cleanup.run=async(stage,ctx)=>{
   const result=await run(stage,ctx);
   if(stage==='correct'){
    const obj=Buffer.from('mtllib mesh.mtl\n'+cube.toString());
    const mtl=Buffer.from('newmtl captured\n'+(defect==='unsupported-map'?'bump':'map_Kd')+' '+(defect==='escape'?'../secret.png':'mesh_basecolor_0.png')+'\n');
    const report=JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8'));
    for(const [name,bytes] of Object.entries({'corrected.obj':obj,'mesh.mtl':mtl,'mesh_basecolor_0.png':png})){
     if(defect==='missing'&&name==='mesh.mtl')continue;
     await writeFile(join(ctx.corrected,name),bytes);report.outputs[name]=defect==='hash'&&name.endsWith('.png')?'0'.repeat(64):sha(bytes);
    }
    await writeFile(join(ctx.corrected,'report.json'),JSON.stringify(report));
   }
   return result;
  };
  const f=await fixture(t,runner);const {job}=await f.store.start(f.input);await f.store.wait();
  assert.equal((await f.store.load(f.input,job.jobId)).job.status,'failed',defect);
  await assert.rejects(f.store.modelAssets(f.input,job.jobId));
 }
});
