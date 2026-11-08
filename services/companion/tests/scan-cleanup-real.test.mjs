import {test} from 'node:test';
import {request} from 'node:http';
import {tempDir} from './support/temp.mjs';
function fetch(url,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=request(url,{method,headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,json:async()=>JSON.parse(bytes),text:async()=>bytes.toString(),clone:()=>({text:async()=>bytes.toString()}),arrayBuffer:async()=>bytes});});res.on('error',reject);});req.on('error',reject);req.end(body);});}
import assert from 'node:assert/strict';
import {readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {FileSavedProjectStorage,savedProjectETag} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {CaptureStore} from '../dist/capture-import.js';
import {createCaptureConverter} from '../dist/capture-converter.js';
import {ScanProcessingStore,createScanCleanupRunner} from '../dist/scan-processing.js';
import {DetailStillStore} from '../dist/detail-stills.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {sha} from './fixtures/scan-processing.mjs';
const blender=process.env.BLENDER,python=process.env.CAPTURE_TEST_PYTHON??'python3';
let ready=!!blender;try{if(blender)await access(blender);}catch{ready=false;}
const path=relative=>fileURLToPath(new URL(relative,import.meta.url));
test('paired full cleanup: real textured USDZ, PNG still, advice and corrected box within 0.05 mm',{skip:ready?false:'Set BLENDER to Blender 5.0.1',timeout:600000},async t=>{
 const root=await tempDir('companion-cleanup-');t.after(()=>rm(root,{recursive:true,force:true}));
 await promisify(execFile)(python,[path('./fixtures/cleanup-capture.py'),join(root,'fixture')]);
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:'box',brief:{object:'Synthetic box',context:'Desk',addition:'Cleanup'}});
 const captures=new CaptureStore(storage,join(root,'captures'),createCaptureConverter({executable:python,temporaryRoot:join(root,'conversion')}));
 const {captureId}=await captures.importCapture({projectId:'box',projectRevision:0,source:await readFile(join(root,'fixture/capture.usdz'))});
 const stills=new DetailStillStore(storage,join(root,'captures'));
 const added=await stills.addDetailStill({projectId:'box',projectRevision:0,captureId,source:await readFile(join(root,'fixture/synthetic.png')),label:'Synthetic port'});
 const runner=createScanCleanupRunner({blender,python,toolPath:path('../../../tools/scan-repair/repair.py'),correctTool:path('../../../tools/scan-correct/correct.py')});
 const store=new ScanProcessingStore(storage,captures,join(root,'captures'),runner);
 const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invite=await auth.createPairing('alice@example.test',['captures:read','captures:import']);
 const phone=await auth.exchange('alice@example.test',{code:invite.code,deviceName:'Synthetic'});
 const server=await startCompanionServer({port:0,remoteAuth:auth,capture:{storage,captures,detailStills:stills,scanProcessing:store}});t.after(()=>server.close());
 const forwarded=JSON.parse(await readFile(path('./fixtures/tailscale-serve-v1.94.2.json'),'utf8')).expected;
 const headers={...forwarded,authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId,'if-match':savedProjectETag(await storage.read('box'))};
 const base=`${server.url}/v1/saved-projects/box/captures/${captureId}/scan-processing`;
 const started=await fetch(base+'?projectRevision=0',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({reference:{dimensionsMm:[60,40,20]},stillIds:[added.still.id]})});
 assert.equal(started.status,202,await started.clone().text());const {job}=await started.json();await store.wait();
 const response=await fetch(`${base}/${job.jobId}?projectRevision=0`,{headers});assert.equal(response.status,200);
 const saved=(await response.json()).job;assert.equal(saved.status,'succeeded',JSON.stringify(saved));assert(saved.pipelineStages.every(s=>s.status==='succeeded'));
 assert(saved.comparison.errorMm.every(x=>Math.abs(x)<.05));assert.equal(saved.detailStills[0].id,added.still.id);
 for(const [name,ref] of Object.entries(saved.artifacts)){
  const result=await fetch(`${base}/${job.jobId}/artifacts/${name}?projectRevision=0`,{headers});assert.equal(result.status,200,name);
  assert.equal(sha(Buffer.from(await result.arrayBuffer())),ref.sha256,name);
 }
 const input={projectId:'box',projectRevision:0,captureId};
 const report=JSON.parse((await store.artifact(input,job.jobId,'correction.json')).bytes);
 assert.equal(report.detailStills[0].sourceSha256,added.still.sha256);
 assert(Object.keys(report.inputs).some(n=>n.endsWith('.png')),'repair retains base-colour texture into correction');
 assert.equal(saved.artifacts['repaired.stl'].sha256,saved.artifacts['corrected.stl'].sha256);
 assert.equal((await fetch(`${base}/${job.jobId}/artifacts/private-work?projectRevision=0`,{headers})).status,404);
});
