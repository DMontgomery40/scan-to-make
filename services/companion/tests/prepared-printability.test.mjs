import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {FileSavedProjectStorage,savedProjectETag} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore,PreparedPrintabilityFailure} from '../dist/prepared-jobs.js';
import {createPreparedProducer} from '../dist/prepared-production.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const ref=(b,mediaType)=>({sha256:sha(b),byteLength:b.length,mediaType});
const output=Buffer.from('; isolated production fixture\nG28\n');
const settings=Buffer.from('{"printer_model":"P1S","layer_height":"0.2"}');
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url),'utf8'));
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}]};
const brief={object:'Cup',context:'Console',addition:'Insert'};

// Binary STL builders mirroring tools/printability/tests (rectilinear solids).
function packStl(tris){
 const buffer=Buffer.alloc(84+tris.length*50);buffer.writeUInt32LE(tris.length,80);let offset=84;
 for(const [a,b,c] of tris){
  const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  let n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];const len=Math.hypot(...n);n=n.map(x=>x/len);
  for(const value of [...n,...a,...b,...c]){buffer.writeFloatLE(value,offset);offset+=4;}
  buffer.writeUInt16LE(0,offset);offset+=2;
 }
 return buffer;
}
function rectilinear(xs,ys,zs,occ){
 const tris=[],at=(i,j,k)=>i>=0&&i<xs.length-1&&j>=0&&j<ys.length-1&&k>=0&&k<zs.length-1&&occ(i,j,k);
 for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++)for(let k=0;k<zs.length-1;k++){
  if(!at(i,j,k))continue;const [x0,x1,y0,y1,z0,z1]=[xs[i],xs[i+1],ys[j],ys[j+1],zs[k],zs[k+1]];
  if(!at(i,j,k-1)){tris.push([[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]],[[x0,y0,z0],[x1,y1,z0],[x1,y0,z0]]);}
  if(!at(i,j,k+1)){tris.push([[x0,y0,z1],[x1,y0,z1],[x1,y1,z1]],[[x0,y0,z1],[x1,y1,z1],[x0,y1,z1]]);}
  if(!at(i,j-1,k)){tris.push([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1]],[[x0,y0,z0],[x1,y0,z1],[x0,y0,z1]]);}
  if(!at(i,j+1,k)){tris.push([[x0,y1,z0],[x0,y1,z1],[x1,y1,z1]],[[x0,y1,z0],[x1,y1,z1],[x1,y1,z0]]);}
  if(!at(i-1,j,k)){tris.push([[x0,y0,z0],[x0,y0,z1],[x0,y1,z1]],[[x0,y0,z0],[x0,y1,z1],[x0,y1,z0]]);}
  if(!at(i+1,j,k)){tris.push([[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]],[[x1,y0,z0],[x1,y1,z1],[x1,y0,z1]]);}
 }
 return packStl(tris);
}
const cubeStl=(size=20)=>rectilinear([0,size],[0,size],[0,size],()=>true);
const twoCubesStl=()=>rectilinear([0,10,20,30],[0,10],[0,10],i=>i!==1);
const cantileverStl=()=>rectilinear([0,12,34,50],[0,30],[0,6,14,20],(i,_j,k)=>k===0||(i===0&&(k===1||k===2))||(i===1&&k===2));

function result(input){return {printable:Buffer.from(output),settings:Buffer.from(settings),manifest:Buffer.from(JSON.stringify({schema:'scan-to-make.slicer-producer/0.1.0',operatorOnly:true,exitCode:0,slicer:{version:'02.08.02.61',binary:{sha256:'b'.repeat(64)}},input:{sha256:sha(input),bytes:input.length,expectedDigestChecked:true},invocation:{sandbox:{kind:'macos-sandbox-exec',path:'/usr/bin/sandbox-exec'}},outputs:{gcode:{file:'plate_1.gcode',sha256:sha(output),bytes:output.length},exportedSettings:{file:'exported-settings.json',sha256:sha(settings),bytes:settings.length}}}))};}

const toolDirectory=fileURLToPath(new URL('../../../tools/printability/',import.meta.url));
async function gateConfig(){
 const read=async name=>readFile(join(toolDirectory,name));
 return {
  python:execFileSync('which',['python3'],{encoding:'utf8'}).trim(),
  script:join(toolDirectory,'printability.py'),
  expectedScriptSha256:sha(await read('printability.py')),
  expectedAnalyzerSha256:sha(await read('analyzer.py')),
  expectedProfilesSha256:sha(await read('profiles.json')),
  profileId:'p1s-0.4-hardened',
 };
}
async function setup(t,source){
 const root=await mkdtemp(join(tmpdir(),'prepared-printability-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief,fit});
 const binding={sourceFit:fit,artifact:ref(source,'model/stl')};
 await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 const overrides=[];let calls=0;
 const production={identity:'c'.repeat(64),async produce(input,options){calls++;overrides.push(options);return result(input);}};
 const inspection={process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),'ok',join(root,'inspector.jsonl')]},options:{timeoutMs:5000}};
 const printability=await gateConfig();
 const jobs=new PreparedJobStore(storage,join(root,'jobs'),{production,inspection,printability});
 const request={projectId:fit.id,projectRevision:2,expectedProjectETag:savedProjectETag(await storage.read(fit.id)),jobId:randomUUID(),source:Buffer.from(source),selection:structuredClone(selection)};
 return {root,storage,jobs,request,calls:()=>calls,overrides,fresh:()=>new PreparedJobStore(storage,join(root,'jobs'),{production,inspection,printability})};
}

test('producer identity binds bed, nozzle and support configuration at adapter version 2',()=>{
 const base={python:'/usr/bin/python3',script:'/operator/producer.py',expectedScriptSha256:'a'.repeat(64),bundle:'/operator/BambuStudio.app',expectedVersion:'02.08.02.61',expectedBinarySha256:'b'.repeat(64),machine:'m',process:'p',filament:'f'};
 const identity=config=>createPreparedProducer(config).identity;
 assert.equal(identity(base),identity({...base}));
 assert.notEqual(identity(base),identity({...base,bedType:'textured_plate'}));
 assert.notEqual(identity(base),identity({...base,nozzleType:'hardened_steel'}));
 assert.notEqual(identity(base),identity({...base,enableSupport:true}));
 assert.notEqual(identity({...base,bedType:'textured_plate'}),identity({...base,bedType:'cool_plate'}));
});

test('gate records a printable verdict, retains the report, and reopens verified after restart',async t=>{
 const f=await setup(t,cubeStl());
 const produced=await f.jobs.prepareProduced(f.request);
 assert.equal(f.calls(),1);assert.equal(f.overrides[0],undefined);
 assert.equal(produced.job.production.printability.verdict,'printable');
 assert.equal(produced.job.production.printability.profileId,'p1s-0.4-hardened');
 const reportBytes=await readFile(join(f.root,'jobs',produced.jobId,'printability.json'));
 assert.deepEqual(ref(reportBytes,'application/json'),produced.job.production.printability.reportArtifact);
 assert.equal(JSON.parse(reportBytes).input.sha256,sha(f.request.source));
 const retry=await f.fresh().prepareProduced(f.request);assert.equal(retry.created,false);assert.equal(f.calls(),1);
 assert.deepEqual((await f.fresh().loadPreparedJob(produced.jobId,f.request.expectedProjectETag)).job,produced.job);
});

test('not-printable fails closed before the producer is invoked and publishes nothing',async t=>{
 const f=await setup(t,twoCubesStl());
 await assert.rejects(f.jobs.prepareProduced(f.request),error=>{
  assert(error instanceof PreparedPrintabilityFailure);assert.equal(error.code,'printability-failed');
  assert(error.summary.reasonCodes.includes('multiple-disconnected-solids'));return true;
 });
 assert.equal(f.calls(),0);assert.deepEqual(await readdir(join(f.root,'jobs')).catch(()=>[]),[]);
});

test('printable-with-supports requires an explicit opt-in and then enables supports',async t=>{
 const f=await setup(t,cantileverStl());
 await assert.rejects(f.jobs.prepareProduced(f.request),error=>{
  assert(error instanceof PreparedPrintabilityFailure);assert.equal(error.code,'supports-required');return true;
 });
 assert.equal(f.calls(),0);
 const produced=await f.jobs.prepareProduced({...f.request,allowSupports:true});
 assert.equal(produced.job.production.printability.verdict,'printable-with-supports');
 assert.equal(produced.job.production.printability.allowSupports,true);
 assert.deepEqual(f.overrides[0],{enableSupport:true});
});

test('a tampered gate script is printability-unavailable and never slices',async t=>{
 const f=await setup(t,cubeStl());
 const tampered=new PreparedJobStore(f.storage,join(f.root,'jobs'),{
  production:{identity:'c'.repeat(64),async produce(){throw new Error('must not run');}},
  inspection:{process:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url)),'ok',join(f.root,'inspector.jsonl')]},options:{timeoutMs:5000}},
  printability:{...(await gateConfig()),expectedScriptSha256:'0'.repeat(64)},
 });
 await assert.rejects(tampered.prepareProduced(f.request),error=>{
  assert(error instanceof PreparedPrintabilityFailure);assert.equal(error.code,'printability-unavailable');return true;
 });
});
