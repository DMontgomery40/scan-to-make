import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {CaptureStore} from '../dist/capture-import.js';

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
async function fixture(t, converter={convert:async bytes=>output(bytes)}) {
 const root=await mkdtemp(join(tmpdir(),'capture-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
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
