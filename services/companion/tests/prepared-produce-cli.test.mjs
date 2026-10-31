import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,chmod,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {FileSavedProjectStorage,savedProjectETag} from '@scan-to-make/project';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
import {PreparedJobStore,PreparedJobFailure} from '../dist/prepared-jobs.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startGenerationServer} from '../dist/generation.js';
import {parseProduceArgs,runProduce} from '../dist/prepared-produce-cli.js';
const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url))).expected;
const fit=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json',import.meta.url),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid test\n');
const output=Buffer.from('; isolated production fixture\nG28\n');
const settings=Buffer.from('{"printer_model":"P1S","layer_height":"0.2"}');
const selection={printerId:'fixture',model:'p1s',plateIndex:0,nozzleDiameters:[0.4],bedType:'textured_plate',materials:[{projectSlot:0,material:'PLA',physicalTray:254}]};
const brief={object:'Cup',context:'Console',addition:'Insert'};
const cli=fileURLToPath(new URL('../dist/prepared-produce-cli.js',import.meta.url));
const inspectorScript=fileURLToPath(new URL('./fixtures/inspection-server.mjs',import.meta.url));
function result(input){return {printable:Buffer.from(output),settings:Buffer.from(settings),manifest:Buffer.from(JSON.stringify({schema:'scan-to-make.slicer-producer/0.1.0',operatorOnly:true,exitCode:0,slicer:{version:'02.08.02.61',binary:{sha256:'b'.repeat(64)}},input:{sha256:sha(input),bytes:input.length,expectedDigestChecked:true},invocation:{sandbox:{kind:'macos-sandbox-exec',path:'/usr/bin/sandbox-exec'}},outputs:{gcode:{file:'plate_1.gcode',sha256:sha(output),bytes:output.length},exportedSettings:{file:'exported-settings.json',sha256:sha(settings),bytes:settings.length}}}))};}
function producerConfig(){return {python:'/usr/bin/python3',script:'/usr/bin/true',expectedScriptSha256:'a'.repeat(64),bundle:'/isolated/test/bundle',expectedVersion:'fixture',expectedBinarySha256:'b'.repeat(64),machine:'fixture',process:'fixture',filament:'fixture'};}
function argvOf(request){return ['--capture-dir',request.captureDir,'--inspector-config',request.inspectorConfig,'--producer-config',request.producerConfig,'--project-id',request.projectId,'--project-revision',String(request.projectRevision),'--etag',request.expectedProjectETag,'--job-id',request.jobId,'--stl',request.stlPath,'--selection',request.selectionPath];}
function jobDirs(root){return readdir(join(root,'prepared-jobs')).then(names=>names.filter(name=>/^[0-9a-f-]{36}$/.test(name)),()=>[]);}
function spawnCli(args,env={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('CLI timeout'));},15000);child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});});}
function wire(f,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=httpRequest(f.server.url+path,{method,headers:{...forwarded,...f.headers,...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);});}
async function retryBusy(operation){for(let i=0;i<50;i++){const r=await operation();if(r.status!==429)return r;await new Promise(ok=>setTimeout(ok,10));}throw Error('busy');}
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'prepared-produce-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const storage=new FileSavedProjectStorage(join(root,'projects')),projects=createSavedProjects(storage);
 await projects.create({id:fit.id,brief,fit});const binding={sourceFit:fit,artifact:{sha256:sha(source),byteLength:source.length,mediaType:'model/stl'}};
 await projects.change(fit.id,0,{kind:'attach-preview',...binding});await projects.change(fit.id,1,{kind:'accept-preview',...binding});
 const inspectorLog=join(root,'inspector.jsonl');
 const inspector={command:process.execPath,args:[inspectorScript,'ok',inspectorLog]};
 const inspectorConfig=join(root,'inspector.json'),producerPath=join(root,'producer.json'),stlPath=join(root,'source.stl'),selectionPath=join(root,'selection.json');
 await writeFile(inspectorConfig,JSON.stringify(inspector));await chmod(inspectorConfig,0o600);
 await writeFile(producerPath,JSON.stringify(producerConfig()));await chmod(producerPath,0o600);
 await writeFile(stlPath,source);await writeFile(selectionPath,JSON.stringify(selection));
 const request={captureDir:root,inspectorConfig,producerConfig:producerPath,projectId:fit.id,projectRevision:2,expectedProjectETag:savedProjectETag(await storage.read(fit.id)),jobId:randomUUID(),stlPath,selectionPath};
 let calls=0;const producer={identity:'c'.repeat(64),async produce(input){calls++;return result(input);}};
 return {root,storage,projects,request,producer,calls:()=>calls,inspectorLog};
}
async function listen(t,f){
 const auth=await RemoteAuthStore.create(join(f.root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const invite=await auth.createPairing('alice@example.test',['generation:health','projects:read','projects:write','prepared-jobs:read','prepared-jobs:prepare']);
 const phone=await auth.exchange('alice@example.test',{code:invite.code,deviceName:'produce-listener'});
 const inspection={process:{command:process.execPath,args:[inspectorScript,'ok',join(f.root,'listener-inspector.jsonl')]},options:{timeoutMs:5000}};
 const preparedJobs=new PreparedJobStore(new FileSavedProjectStorage(join(f.root,'projects')),join(f.root,'prepared-jobs'),{inspection});
 const server=await startGenerationServer({port:0,remoteAuth:auth,capture:{storage:f.storage,preparedJobs}});t.after(()=>server.close());
 return {server,auth,phone,headers:{authorization:`Bearer ${phone.token}`,'x-scan-device':phone.deviceId},etag:f.request.expectedProjectETag};
}

test('injected producer creates a job, listener discovers it only with productionVersion=1, and download matches',async t=>{
 const f=await setup(t);const created=await runProduce(f.request,{producer:f.producer});
 assert.equal(created.created,true);assert.equal(created.jobId,f.request.jobId.toLowerCase());assert.equal(f.calls(),1);assert.match(created.jobSha256,/^[a-f0-9]{64}$/);
 const listener=await listen(t,f);const listing=id=>retryBusy(()=>wire(listener,`/v1/saved-projects/${fit.id}/prepared-jobs?projectRevision=2${id}`,{headers:{'if-match':listener.etag}}));
 const hidden=JSON.parse((await listing('')).bytes);assert.deepEqual(hidden.jobs,[]);
 const shown=JSON.parse((await listing('&productionVersion=1')).bytes);assert.equal(shown.jobs.length,1);assert.equal(shown.jobs[0].jobId,created.jobId);assert.equal(shown.jobs[0].jobSha256,created.jobSha256);
 const verified=await retryBusy(()=>wire(listener,`/v1/saved-projects/${fit.id}/prepared-jobs/${created.jobId}?projectRevision=2`,{headers:{'if-match':listener.etag}}));
 assert.equal(verified.status,200);const body=JSON.parse(verified.bytes);assert.equal(body.job.sha256,created.jobSha256);assert.equal(body.job.production.sourceArtifact.sha256,sha(source));
 const download=await retryBusy(()=>wire(listener,`/v1/saved-projects/${fit.id}/prepared-jobs/${created.jobId}/artifacts/printable?projectRevision=2`,{headers:{'if-match':listener.etag}}));
 assert.equal(download.status,200);assert.deepEqual(download.bytes,output);assert.equal(download.headers['x-content-sha256'],sha(output));assert.equal(Number(download.headers['content-length']),output.length);
});

test('same jobId and request does not re-slice',async t=>{
 const f=await setup(t);const first=await runProduce(f.request,{producer:f.producer});
 const retry=await runProduce(f.request,{producer:f.producer});
 assert.equal(first.created,true);assert.equal(retry.created,false);assert.equal(retry.jobId,first.jobId);assert.equal(retry.jobSha256,first.jobSha256);assert.equal(f.calls(),1);
});

test('mismatched STL is rejected before slicing with no job directory',async t=>{
 const f=await setup(t);await writeFile(f.request.stlPath,'solid other\nendsolid other\n');
 await assert.rejects(runProduce(f.request,{producer:f.producer}),/source|identity|artifact/i);assert.equal(f.calls(),0);assert.deepEqual(await jobDirs(f.root),[]);
});

test('same jobId with a different selection is a job-conflict',async t=>{
 const f=await setup(t);await runProduce(f.request,{producer:f.producer});
 await writeFile(f.request.selectionPath,JSON.stringify({...selection,printerId:'other'}));
 await assert.rejects(runProduce(f.request,{producer:f.producer}),error=>error instanceof PreparedJobFailure&&error.code==='job-conflict');
 assert.equal(f.calls(),1);assert.deepEqual(await jobDirs(f.root),[f.request.jobId.toLowerCase()]);
 const spawned=await spawnCli(argvOf(f.request));assert.notEqual(spawned.code,0);assert.match(spawned.err,/Prepared produce failed \(job-conflict\)/);assert.equal(spawned.out,'');assert.equal(f.calls(),1);
});

test('stale project ETag is rejected with no job directory',async t=>{
 const f=await setup(t);const stale={...f.request,expectedProjectETag:'"'+'0'.repeat(64)+'"'};
 await assert.rejects(runProduce(stale,{producer:f.producer}),/stale|precondition/i);assert.equal(f.calls(),0);assert.deepEqual(await jobDirs(f.root),[]);
});

test('bad producer configuration is rejected before storage opens',async t=>{
 const f=await setup(t);
 const cases=[];
 const mode=join(f.root,'producer-0644.json');await writeFile(mode,JSON.stringify(producerConfig()),{mode:0o644});await chmod(mode,0o644);cases.push(['0644',{...f.request,producerConfig:mode},/private regular file/]);
 const linked=join(f.root,'producer-link.json');await symlink(f.request.producerConfig,linked);assert.equal((await lstat(linked)).isSymbolicLink(),true);cases.push(['symlink',{...f.request,producerConfig:linked},/ELOOP|private regular file/]);
 const huge=join(f.root,'producer-huge.json');await writeFile(huge,'{"python":"/usr/bin/python3"}'+' '.repeat(65537),{mode:0o600});await chmod(huge,0o600);cases.push(['oversize',{...f.request,producerConfig:huge},/private regular file|exceeds byte limit/]);
 cases.push(['relative',{...f.request,producerConfig:'producer.json'},/absolute|private regular file/]);
 const extra=join(f.root,'producer-extra.json');await writeFile(extra,JSON.stringify({...producerConfig(),apiKey:'super-secret-token-xyz'}),{mode:0o600});await chmod(extra,0o600);cases.push(['unknown-keys',{...f.request,producerConfig:extra},/unrecognized|strict|invalid/i]);
 for(const [name,request,pattern] of cases){
  await assert.rejects(runProduce(request,{producer:f.producer}),pattern,name);assert.equal(f.calls(),0,name);assert.deepEqual(await jobDirs(f.root),[],name);
  const spawned=await spawnCli(argvOf(request));assert.notEqual(spawned.code,0,name);assert.match(spawned.err,/Prepared produce failed/,name);assert.equal(spawned.out,'',name);
  assert.doesNotMatch(spawned.err,/super-secret-token-xyz|\/usr\/bin\/python3|SCAN_TO_MAKE/);
 }
});

test('CLI arguments and environment cannot override pinned producer identity',async t=>{
 const f=await setup(t);const env={SCAN_TO_MAKE_PRODUCER_PYTHON:'/tmp/evil-python',SCAN_TO_MAKE_PREPARED_PRODUCER_CONFIG:'/tmp/evil.json'};
 const created=await runProduce(f.request,{producer:f.producer});assert.equal(created.created,true);
 const job=JSON.parse(await readFile(join(f.root,'prepared-jobs',created.jobId,'job.json'),'utf8'));
 assert.equal(job.production.producerIdentity,f.producer.identity);
 const spawned=await spawnCli([...argvOf(f.request),'--python','/tmp/evil-python'],env);
 assert.notEqual(spawned.code,0);assert.equal(spawned.out,'');assert.match(spawned.err,/Prepared produce failed/);assert.doesNotMatch(spawned.err,/evil-python|evil\.json/);
 assert.throws(()=>parseProduceArgs([...argvOf(f.request),'--python','/tmp/evil-python']),/Invalid produce arguments/);
});

test('produce arguments accept the supports opt-in and printability config exactly once',async t=>{
 const f=await setup(t);
 const parsed=parseProduceArgs([...argvOf(f.request),'--allow-supports','--printability-config','/operator/printability.json']);
 assert.equal(parsed.allowSupports,true);assert.equal(parsed.printabilityConfig,'/operator/printability.json');
 assert.equal(parseProduceArgs(argvOf(f.request)).allowSupports,false);
 assert.throws(()=>parseProduceArgs([...argvOf(f.request),'--allow-supports','--allow-supports']),/Invalid produce arguments/);
 assert.throws(()=>parseProduceArgs([...argvOf(f.request),'--printability-config']),/Invalid produce arguments/);
});

test('overlapping same jobId fails closed without a second slice',async t=>{
 const f=await setup(t);let resolveProduce;const gate=new Promise(resolve=>{resolveProduce=resolve;});
 const producer={identity:f.producer.identity,async produce(input){f.producer.produce(input);await gate;return result(input);}};
 const first=runProduce(f.request,{producer});
 while(f.calls()<1)await new Promise(ok=>setTimeout(ok,10));
 await assert.rejects(runProduce(f.request,{producer}),error=>error instanceof PreparedJobFailure&&error.code==='job-conflict');
 assert.equal(f.calls(),1);resolveProduce();const created=await first;assert.equal(created.created,true);assert.equal(f.calls(),1);
});

test('separate processes cannot double-slice the same jobId',async t=>{
 const f=await setup(t);
 const started=join(f.root,'started.jsonl'),helper=join(f.root,'race.mjs'),produceUrl=new URL('../dist/prepared-produce-cli.js',import.meta.url).href;
 await writeFile(helper,`import {appendFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runProduce} from ${JSON.stringify(produceUrl)};
const request=${JSON.stringify(f.request)};
const sha=b=>createHash('sha256').update(b).digest('hex');
const output=Buffer.from(${JSON.stringify(output.toString('base64'))},'base64');
const settings=Buffer.from(${JSON.stringify(settings.toString('base64'))},'base64');
const producer={identity:${JSON.stringify(f.producer.identity)},async produce(input){
 appendFileSync(${JSON.stringify(started)},'1\\n');
 await new Promise(ok=>setTimeout(ok,1500));
 return {printable:Buffer.from(output),settings:Buffer.from(settings),manifest:Buffer.from(JSON.stringify({schema:'scan-to-make.slicer-producer/0.1.0',operatorOnly:true,exitCode:0,slicer:{version:'02.08.02.61',binary:{sha256:${JSON.stringify('b'.repeat(64))}}},input:{sha256:sha(input),bytes:input.length,expectedDigestChecked:true},invocation:{sandbox:{kind:'macos-sandbox-exec',path:'/usr/bin/sandbox-exec'}},outputs:{gcode:{file:'plate_1.gcode',sha256:sha(output),bytes:output.length},exportedSettings:{file:'exported-settings.json',sha256:sha(settings),bytes:settings.length}}}))};
}};
try {
 writeFileSync(process.argv[2],JSON.stringify({ok:true,result:await runProduce(request,{producer})})+'\\n');
} catch (error) {
 writeFileSync(process.argv[2],JSON.stringify({ok:false,code:error.code??String(error)})+'\\n');
 process.exitCode=1;
}
`);
 const run=out=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[helper,out],{stdio:['ignore','pipe','pipe']});let err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('race timeout'));},10000);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,err});});});
 const aOut=join(f.root,'a.json'),bOut=join(f.root,'b.json');
 const first=run(aOut);
 for(let i=0;i<200;i++){try{if((await readFile(started,'utf8')).includes('1'))break;}catch{}await new Promise(ok=>setTimeout(ok,10));}
 assert.equal((await readFile(started,'utf8')).trim(),'1','first process must start slicing before the second launches');
 const second=run(bOut);const [ra,rb]=await Promise.all([first,second]);
 const reports=[JSON.parse(await readFile(aOut,'utf8')),JSON.parse(await readFile(bOut,'utf8'))];
 assert.equal(reports.filter(row=>row.ok&&row.result.created).length,1);
 assert.equal(reports.filter(row=>!row.ok&&row.code==='job-conflict').length,1);
 assert.equal((await readFile(started,'utf8')).trim().split('\n').length,1);
 assert.ok(ra.code===0&&rb.code===1||ra.code===1&&rb.code===0);
});

test('live produce path stays macOS-gated; injected fixtures stay portable',async t=>{
 const f=await setup(t);
 await assert.rejects(runProduce(f.request),process.platform==='darwin'?/identity mismatch|Producer|failed|macOS/: /Enforced slicer isolation requires macOS/);
 assert.equal(f.calls(),0);assert.deepEqual(await jobDirs(f.root),[]);
 const portable=await runProduce({...f.request,jobId:randomUUID()},{producer:f.producer});assert.equal(portable.created,true);
});


test('invalid job IDs are rejected before creating lock or store directories',async t=>{
 const f=await setup(t);
 for(const jobId of ['../../escaped','not-a-uuid','']){
  await assert.rejects(runProduce({...f.request,jobId},{producer:f.producer}));
  await assert.rejects(lstat(join(f.root,'prepared-jobs')), {code:'ENOENT'});
  assert.equal(f.calls(),0);
 }
});
