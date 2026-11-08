import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {CaptureStore} from '../dist/capture-import.js';
import {tempDir} from './support/temp.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const source = Buffer.from('isolated synthetic converter fixture');
const derived = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
const brief = {object:'Bottle',context:'Drawer',addition:'Holder'};
function output(bytes = source) {
 return {derived, report:Buffer.from(JSON.stringify({tool:'capture-mesh-convert',toolVersion:'0.3.0',
 source:{sha256:sha(bytes),bytes:bytes.length},output:{sha256:sha(derived),bytes:derived.length,format:'obj'},
 metersPerUnit:.01,unitsAuthored:true,upAxis:'Z',metricQualified:true,metricQualifiedReason:null,
 outputBasis:{coordinates:'world',units:'native stage units (unrescaled)',metersPerUnit:.01,upAxis:'Z'},
 contributingLayers:[{identifier:'fixture.usdc',sha256:'a'.repeat(64),bytes:30}],
 unsupportedFeatures:[],provesCompleteCapture:false,provesPhysicalFit:false}))};
}
function texturedOutput({obj='mtllib mesh.mtl\nusemtl skin\n'+derived,
 mtl='newmtl skin\nKd 1 1 1\nmap_Kd -clamp on mesh_basecolor_0.png\n'}={}) {
 const next=output(),report=JSON.parse(next.report);
 next.derived=Buffer.from(obj);
 next.assets={'mesh.mtl':Buffer.from(mtl),'mesh_basecolor_0.png':Buffer.from('synthetic PNG bytes')};
 report.output={format:'obj',sha256:sha(next.derived),bytes:next.derived.length};
 report.outputs=Object.entries({'mesh.obj':next.derived,...next.assets}).map(([path,bytes])=>({path,bytes:bytes.length,sha256:sha(bytes)}));
 next.report=Buffer.from(JSON.stringify(report));return next;
}
async function fixture(t, converter={convert:async bytes=>output(bytes)}) {
 const root=await tempDir('capture-store-');t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects'));
 const projects=createSavedProjects(storage);
 assert.equal((await projects.create({id:'test',brief})).status,'ok');
 const captures=new CaptureStore(storage,join(root,'captures'),converter);
 return {root,storage,projects,captures,converter};
}
const request=()=>({projectId:'test',projectRevision:0,source:Buffer.from(source)});

test('retained capture survives restart with exact bytes and unknown physical evidence',async t=>{
 const f=await fixture(t);const saved=await f.captures.importCapture(request());
 const fresh=new CaptureStore(new FileSavedProjectStorage(join(f.root,'projects')),join(f.root,'captures'),f.converter);
 const loaded=await fresh.loadCapture('test',0,saved.captureId);
 assert.deepEqual(loaded.original,source);assert.deepEqual(loaded.derived,derived);
 assert.deepEqual(loaded.report,output().report);
 assert.deepEqual(loaded.binding,saved.binding);
 assert.deepEqual(loaded.binding.capture.evidence,{metricAccuracy:'unknown',surfaceCompleteness:'unknown',physicalFit:'unknown'});
 assert.equal(loaded.project.revision,0);
});

test('editing the project during conversion prevents a stale capture commit',async t=>{
 let started,finish;const entered=new Promise(r=>started=r);const gate=new Promise(r=>finish=r);
 const f=await fixture(t,{convert:async bytes=>{started();await gate;return output(bytes);}});
 const pending=f.captures.importCapture(request());await entered;
 assert.equal((await f.projects.change('test',0,{kind:'replace-brief',brief:{...brief,addition:'Changed'}})).status,'ok');
 finish();await assert.rejects(pending,/revision/);
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('project edits invalidate current capture usability but preserve its historical bytes',async t=>{
 const f=await fixture(t);const saved=await f.captures.importCapture(request());
 await f.projects.change('test',0,{kind:'replace-brief',brief:{...brief,addition:'Changed'}});
 await assert.rejects(f.captures.loadCapture('test',0,saved.captureId),/revision/);
 await assert.rejects(f.captures.loadCapture('test',1,saved.captureId),/revision|binding/);
 assert.deepEqual(await readFile(join(f.root,'captures',saved.captureId,'original.usdz')),source);
});

test('corrupt retained originals, derived meshes, reports and binding metadata reject on reopen',async t=>{
 const f=await fixture(t);
 for(const name of ['original.usdz','mesh.obj','conversion.json','binding.json']) {
  const saved=await f.captures.importCapture(request());const path=join(f.root,'captures',saved.captureId,name);
  const bytes=await readFile(path);await writeFile(path,Buffer.concat([bytes,Buffer.from('broken')]));
  await assert.rejects(f.captures.loadCapture('test',0,saved.captureId));
 }
});

test('abort during conversion leaves no committed bundle even if a converter returns late',async t=>{
 let started,finish;const entered=new Promise(r=>started=r);const gate=new Promise(r=>finish=r);
 const f=await fixture(t,{convert:async bytes=>{started();await gate;return output(bytes);}});
 const controller=new AbortController();const pending=f.captures.importCapture(request(),controller.signal);
 await entered;controller.abort();finish();await assert.rejects(pending,/abort/i);
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('unqualified, inconsistent and forged conversion outputs cannot commit',async t=>{
 const f=await fixture(t);
 for(const mutate of [r=>r.source.sha256='b'.repeat(64),r=>r.output.bytes++,r=>r.metricQualified=false,
 r=>r.unitsAuthored=false,r=>r.outputBasis.metersPerUnit=1,r=>r.unsupportedFeatures=['missing surface']]) {
  const next=output();const report=JSON.parse(next.report);mutate(report);
  const captures=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>({...next,report:Buffer.from(JSON.stringify(report))})});
  await assert.rejects(captures.importCapture(request()));
 }
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('input is copied before asynchronous work and invalid paths/limits reject early',async t=>{
 const f=await fixture(t);const input=request();const pending=f.captures.importCapture(input);input.source.fill(0);
 const saved=await pending;assert.deepEqual((await f.captures.loadCapture('test',0,saved.captureId)).original,source);
 await assert.rejects(f.captures.loadCapture('test',0,'../escape'));
 const bounded=new CaptureStore(f.storage,join(f.root,'captures'),f.converter,{maxSourceBytes:4});
 await assert.rejects(bounded.importCapture(request()),/limit/);
});

test('snapshot ETag pins commit and reopen even if a trusted local writer changes content at the same revision',async t=>{
 const {savedProjectETag}=await import('@scan-to-make/project');
 let started,finish;const entered=new Promise(r=>started=r);const gate=new Promise(r=>finish=r);
 const f=await fixture(t,{convert:async bytes=>{started();await gate;return output(bytes);}});
 const old=await f.storage.read('test');const expectedProjectETag=savedProjectETag(old);
 const pending=f.captures.importCapture({...request(),expectedProjectETag});await entered;
 const replacement=JSON.stringify({...JSON.parse(old),brief:{...brief,addition:'Changed without revision'}});
 await f.storage.compareAndSwap('test',old,replacement);finish();
 await assert.rejects(pending,/snapshot/);assert.deepEqual(await readdir(join(f.root,'captures')),[]);
 const saved=await f.captures.importCapture({...request(),expectedProjectETag:savedProjectETag(replacement)});
 await assert.rejects(f.captures.loadCapture('test',0,saved.captureId,expectedProjectETag),/snapshot/);
 assert.equal((await f.captures.loadCapture('test',0,saved.captureId,savedProjectETag(replacement))).captureId,saved.captureId);
});

test('material assets must match the converter manifest and share the derived byte budget',async t=>{
 const f=await fixture(t);
 const material=Buffer.from('newmtl skin\nKd 1 1 1\n');
 const valid=()=>{
  const next=output();const report=JSON.parse(next.report);
  report.outputs=[{path:'mesh.obj',sha256:sha(derived),bytes:derived.length},{path:'mesh.mtl',sha256:sha(material),bytes:material.length}];
  return {...next,report:Buffer.from(JSON.stringify(report)),assets:{'mesh.mtl':Buffer.from(material)}};
 };
 for(const mutate of [
  v=>delete v.assets['mesh.mtl'],
  v=>v.assets['mesh.mtl'].fill(0),
  v=>v.assets['unexpected.png']=Buffer.from('extra'),
  v=>{const r=JSON.parse(v.report);r.outputs[1].path='../escape.mtl';v.report=Buffer.from(JSON.stringify(r));},
  v=>{const r=JSON.parse(v.report);r.outputs.push(r.outputs[1]);v.report=Buffer.from(JSON.stringify(r));},
  v=>{const r=JSON.parse(v.report);r.outputs[0].sha256='a'.repeat(64);v.report=Buffer.from(JSON.stringify(r));},
  v=>{const bytes=Buffer.from('newmtl skin\nmap_Kd mesh_basecolor_0.png\n');v.assets['mesh.mtl']=bytes;
   const r=JSON.parse(v.report);r.outputs[1]={path:'mesh.mtl',bytes:bytes.length,sha256:sha(bytes)};v.report=Buffer.from(JSON.stringify(r));},
 ]){
  const next=valid();mutate(next);
  const store=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>next});
  await assert.rejects(store.importCapture(request()));
 }
 const bounded=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>valid()},{maxDerivedBytes:derived.length+material.length-1});
 await assert.rejects(bounded.importCapture(request()),/byte limit/);
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
});

test('reopen verifies material and texture identities, presence and regular files',async t=>{
 const f=await fixture(t,{convert:async()=>texturedOutput()});
 const fresh=new CaptureStore(f.storage,join(f.root,'captures'),f.converter);
 for(const name of ['mesh.mtl','mesh_basecolor_0.png'])for(const damage of ['changed','truncated','oversized','missing','symlink']){
  const saved=await f.captures.importCapture(request());
  await fresh.loadCapture('test',0,saved.captureId);
  const path=join(f.root,'captures',saved.captureId,name),bytes=await readFile(path);
  if(damage==='changed'){
   // Keep the MTL syntactically valid and the same size: only its hash differs.
   if(name==='mesh.mtl')await writeFile(path,bytes.toString().replace('Kd 1 1 1','Kd 0 1 1'));
   else {bytes[0]^=1;await writeFile(path,bytes);}
  }
  if(damage==='truncated')await writeFile(path,bytes.subarray(0,bytes.length-1));
  if(damage==='oversized')await writeFile(path,Buffer.concat([bytes,Buffer.from('extra')]));
  if(damage==='missing')await rm(path);
  if(damage==='symlink'){
   const target=join(f.root,'outside-'+name);await writeFile(target,bytes);await rm(path);await symlink(target,path);
  }
  await assert.rejects(fresh.loadCapture('test',0,saved.captureId),damage==='changed'?/identity mismatch/:undefined,`${name}: ${damage}`);
 }
});

test('material references cannot escape the retained bundle or hide in other map directives',async t=>{
 const f=await fixture(t);
 for(const invalid of [
  {obj:'  mtllib outside.mtl\n'+derived},
  {obj:'mtllib mesh.mtl outside.mtl\n'+derived},
  {obj:'mtllib mesh .mtl\n'+derived},
  {obj:'mtllib mesh.\tmtl\n'+derived},
  {obj:'mtllib\n'+derived},
  {mtl:'newmtl skin\n  map_Kd ../outside.png\n'},
  {mtl:'newmtl skin\nmap_Kd mesh_basecolor_9.png\n'},
  ...['map_Ka','map_Ks','bump','disp','decal','refl','norm'].map(command=>({mtl:`newmtl skin\n${command} outside.png\n`})),
  ...['\r','\v','\f','\x1c','\x85','\u2028','\u2029'].flatMap(separator=>[
   {obj:`# comment${separator}mtllib outside.mtl\n`+derived},
   {mtl:`newmtl skin${separator}map_Kd outside.png\n`},
  ]),
 ]){
  const store=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>texturedOutput(invalid)});
  await assert.rejects(store.importCapture(request()),undefined,JSON.stringify(invalid));
 }
 assert.deepEqual(await readdir(join(f.root,'captures')),[]);
 const valid=texturedOutput({obj:'\tmtllib\tmesh.mtl  \r\n'+derived,
  mtl:'  newmtl skin\r\nKd 1 1 1\r\n\tmap_Kd\t-clamp off\tmesh_basecolor_0.png  \r\n'});
 const store=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>valid});
 const saved=await store.importCapture(request());
 await store.loadCapture('test',0,saved.captureId);
});

test('material library spacing preserves the exact retained filename on import and reopen',async t=>{
 const f=await fixture(t);
 for(const line of ['mtllib    mesh.mtl','  mtllib \t  mesh.mtl \t','\tmtllib\t\tmesh.mtl  ']){
  const next=texturedOutput({obj:line+'\r\n'+derived});
  const store=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>next});
  const saved=await store.importCapture(request());
  const fresh=new CaptureStore(f.storage,join(f.root,'captures'),{convert:async()=>{throw new Error('Reopen must use retained bytes');}});
  const loaded=await fresh.loadCapture('test',0,saved.captureId);
  assert.deepEqual(loaded.derived,next.derived);
  assert.deepEqual(await readFile(join(f.root,'captures',saved.captureId,'mesh.mtl')),next.assets['mesh.mtl']);
 }
});

test('reopen applies the combined derived material byte budget',async t=>{
 const next=texturedOutput(),f=await fixture(t,{convert:async()=>next});
 const saved=await f.captures.importCapture(request());
 const total=next.derived.length+Object.values(next.assets).reduce((n,bytes)=>n+bytes.length,0);
 const bounded=new CaptureStore(f.storage,join(f.root,'captures'),f.converter,{maxDerivedBytes:total-1});
 await assert.rejects(bounded.loadCapture('test',0,saved.captureId),/byte limit/);
});
