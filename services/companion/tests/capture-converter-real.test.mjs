import {test} from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FileSavedProjectStorage} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {CaptureStore} from '../dist/capture-import.js';
import {createCaptureConverter} from '../dist/capture-converter.js';
const python=process.env.CAPTURE_TEST_PYTHON??'python3';
const makeFixtures=fileURLToPath(new URL('../../../tools/capture-mesh-convert/make_fixtures.py',import.meta.url));

test('real USDZ conversion imports and reopens exact source, binary-layer provenance and OBJ bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'capture-real-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inputs=join(root,'fixtures'),jobs=join(root,'jobs');await mkdir(jobs);
 await promisify(execFile)(python,[makeFixtures,inputs],{timeout:30000});
 const storage=new FileSavedProjectStorage(join(root,'projects'));const projects=createSavedProjects(storage);
 await projects.create({id:'real-fixture',brief:{object:'Synthetic two-layer mesh',context:'Fixture',addition:'Holder'}});
 const worker=createCaptureConverter({executable:python,temporaryRoot:jobs});
 const store=new CaptureStore(storage,join(root,'captures'),worker);
 const original=await readFile(join(inputs,'two_layer.usdz'));
 const saved=await store.importCapture({projectId:'real-fixture',projectRevision:0,source:original});
 const reopened=await new CaptureStore(new FileSavedProjectStorage(join(root,'projects')),join(root,'captures'),worker).loadCapture('real-fixture',0,saved.captureId);
 assert.deepEqual(reopened.original,original);
 assert.equal(reopened.binding.capture.provenance.contributingLayers.length,2);
 assert.equal(reopened.binding.capture.provenance.unitsAuthored,true);
 assert.equal(reopened.binding.capture.evidence.physicalFit,'unknown');
 assert.equal(reopened.binding.capture.derived.byteLength,reopened.derived.length);
 assert.deepEqual(await readdir(jobs),[]);
 for(const name of ['nan_point','bad_index','collinear_tri','nonplanar_quad','external_ref','no_units']){
  await assert.rejects(store.importCapture({projectId:'real-fixture',projectRevision:0,source:await readFile(join(inputs,name+'.usdz'))}),/failed|unqualified/);
 }
 assert.deepEqual(await readdir(join(root,'captures')),[saved.captureId]);
 assert.deepEqual(await readdir(jobs),[]);
});

test('textured capture retains the complete OBJ material bundle after converter cleanup and restart',async t=>{
 const root=await mkdtemp(join(tmpdir(),'capture-textured-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const inputs=join(root,'fixtures'),jobs=join(root,'jobs');await mkdir(jobs);
 await promisify(execFile)(python,[fileURLToPath(new URL('./fixtures/cleanup-capture.py',import.meta.url)),inputs],{timeout:30000});
 const storage=new FileSavedProjectStorage(join(root,'projects'));const projects=createSavedProjects(storage);
 await projects.create({id:'textured-fixture',brief:{object:'Synthetic textured box',context:'Fixture',addition:''}});
 const worker=createCaptureConverter({executable:python,temporaryRoot:jobs});
 const directory=join(root,'captures');const store=new CaptureStore(storage,directory,worker);
 const saved=await store.importCapture({projectId:'textured-fixture',projectRevision:0,source:await readFile(join(inputs,'capture.usdz'))});
 const reopened=await new CaptureStore(storage,directory,worker).loadCapture('textured-fixture',0,saved.captureId);
 assert.match(reopened.derived.toString(),/mtllib mesh\.mtl/);
 const folder=join(directory,saved.captureId);
 const material=await readFile(join(folder,'mesh.mtl'),'utf8');
 assert.match(material,/mesh_basecolor_0\.png/);
 const report=JSON.parse(reopened.report);
 for(const artifact of report.outputs){
  const bytes=await readFile(join(folder,artifact.path));
  assert.equal(bytes.length,artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
 }
 assert.deepEqual(await readdir(jobs),[]);
});
