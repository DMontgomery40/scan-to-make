import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {join,resolve} from 'node:path';
import {lookupMakerSize,MAKER_SIZE_PROMPT,MAKER_LOOKUP_MS} from '../dist/maker-size-lookup.js';
import {AI_TWEAK_PROMPT} from '../dist/ai-tweak.js';
import {aiStageBudget,AI_CLEANUP_JOB_MS,AI_AFTER_MS} from '../dist/scan-cleanup-runner.js';
import {aiTweakRecord} from '../dist/ai-tweak-export.js';
import {fixture,cleanupRunner,sha} from './fixtures/scan-processing.mjs';
import {RemoteAuthStore} from '../dist/remote-auth.js';
import {startCompanionServer} from '../dist/server.js';
import {savedProjectETag} from '@scan-to-make/project';
import {tempDir} from './support/temp.mjs';

const proposal={productName:'AirPods Pro 2 charging case (USB-C)',makerName:'Apple',dimensionsMm:{length:60.6,width:45.2,height:21.7},sourceUrl:'https://support.apple.com/en-us/111834',confidence:.92};
async function lookupFixture(t,action='valid'){
 const root=await tempDir('maker-size-test-');t.after(()=>rm(root,{recursive:true,force:true}));
 const inputs=join(root,'inputs');await mkdir(inputs);const mesh=Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');await writeFile(join(inputs,'mesh.obj'),mesh);
 const manifest={inputs:{'mesh.obj':{sha256:sha(mesh),bytes:mesh.length}}};
 const cli=join(root,'claude'),calls=join(root,'calls');
 await writeFile(cli,`#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]==='--version'){console.log('test');process.exit(0);}
const prompt=process.argv[3];fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(prompt)+'\\n');
if(prompt===${JSON.stringify(MAKER_SIZE_PROMPT)}){
 const action=${JSON.stringify(action)};
 let proposal=${JSON.stringify(proposal)};
 if(action==='none')proposal=null;
 if(action==='invalid')proposal.confidence=2;
 if(action==='mutate')fs.writeFileSync('mesh.obj','changed');
 if(action==='symlink')fs.symlinkSync(${JSON.stringify(join(root,'external.json'))},'maker-size.json');
 else fs.writeFileSync('maker-size.json',action==='malformed'?'oops':JSON.stringify({proposal}));
 if(action==='error'){console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:'failed'}));process.exit(0);}
 if(action==='hang')setInterval(()=>{},1000);
}
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));
`,{mode:0o700});
 await writeFile(join(root,'external.json'),JSON.stringify({proposal}));
 const options={access:{kind:'api',provider:'anthropic',model:'test',keyEnv:'TEST_KEY'},claudePath:cli,requireGuiSession:false,env:{HOME:root,PATH:'/usr/bin:/bin',TEST_KEY:'test-secret'},signal:new AbortController().signal};
 return {root,inputs,manifest,options,cli,calls,mesh};
}
test('AI off does not read inputs, create output or call any model',async()=>{
 assert.equal(await lookupMakerSize('/does/not/exist',{}, {access:{kind:'none'}}),undefined);
});
test('lookup preserves inputs and returns only a validated suggestion',async t=>{
 const f=await lookupFixture(t);assert.deepEqual(await lookupMakerSize(f.root,f.manifest,f.options),proposal);
 assert.deepEqual(await readFile(join(f.inputs,'mesh.obj')),f.mesh);
 const calls=(await readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(calls,[MAKER_SIZE_PROMPT]);
 assert.notEqual(MAKER_SIZE_PROMPT,AI_TWEAK_PROMPT);
});
for(const action of ['none','invalid','mutate','symlink','malformed','error'])test(`${action} lookup has no proposal`,async t=>{
 const f=await lookupFixture(t,action);assert.equal(await lookupMakerSize(f.root,f.manifest,f.options),undefined);
 assert.deepEqual(await readFile(join(f.inputs,'mesh.obj')),f.mesh);
});
test('tampered pristine snapshot is refused before starting the model',async t=>{
 const f=await lookupFixture(t);await writeFile(join(f.inputs,'mesh.obj'),'changed');
 assert.equal(await lookupMakerSize(f.root,f.manifest,f.options),undefined);await assert.rejects(readFile(f.calls),{code:'ENOENT'});
});
test('cancellation stops the optional lookup rather than publishing its early output',async t=>{
 const f=await lookupFixture(t,'hang'),controller=new AbortController();
 const pending=lookupMakerSize(f.root,f.manifest,{...f.options,signal:controller.signal});
 const stop=setTimeout(()=>controller.abort(),300);t.after(()=>clearTimeout(stop));await assert.rejects(pending);
});
test('AI stage reserves lookup time inside the existing job ceiling',()=>{
 for(const kind of ['claude-code','codex-cli','api','endpoint']){
  const b=aiStageBudget(AI_CLEANUP_JOB_MS,kind);
  assert.equal(b.makerLookupMs,MAKER_LOOKUP_MS);
  assert(b.attemptMs+b.warmupMs+b.pickMs+b.judgeMs+b.makerLookupMs+60000<=b.stageMs);
  assert(b.stageMs+AI_AFTER_MS<=AI_CLEANUP_JOB_MS);
 }
});
test('production CLI lookup leaves exported geometry unchanged and publishes its proposal',async t=>{
 const f=await lookupFixture(t),out=join(f.root,'run'),exported=join(f.root,'export');
 const {stdout}=await promisify(execFile)(process.execPath,[resolve('dist/ai-tweak-cli.js'),'run','--mesh',join(f.inputs,'mesh.obj'),'--out',out,'--attempts','1','--pick','--export',exported,'--mm-per-unit','1'],
  {env:{...f.options.env,SCAN_TO_MAKE_AI_ACCESS:'api',SCAN_TO_MAKE_AI_PROVIDER:'anthropic',SCAN_TO_MAKE_AI_MODEL:'test',SCAN_TO_MAKE_AI_KEY_ENV:'TEST_KEY',SCAN_TO_MAKE_CLAUDE_PATH:f.cli},timeout:30000});
 const report=JSON.parse(await readFile(join(exported,'report.json'),'utf8'));
 assert.deepEqual(report.makerSize,proposal,stdout);assert.equal(report.aiTweak.pick.choice,'captured');
 const obj=await readFile(join(exported,'corrected.obj'));assert.deepEqual(obj,f.mesh);
 assert.equal(sha(obj),report.outputs['corrected.obj']);
 assert.deepEqual((await readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse),[AI_TWEAK_PROMPT,MAKER_SIZE_PROMPT]);
});

async function proposalFixture(t,value=proposal,ai=true){
 const runner=cleanupRunner({}),base=runner.cleanup.run;
 runner.cleanup.adapter=ai?'ai-tweak':'scripted';
 runner.cleanup.run=async(stage,ctx)=>{
  const result=await base(stage,ctx);
  if(stage==='correct'){
   const file=join(ctx.corrected,'report.json'),report=JSON.parse(await readFile(file,'utf8'));
   if(ai)report.aiTweak=aiTweakRecord({kind:'claude-code'},undefined,{choice:'captured',decidedBy:'fallback',reason:'Captured scan kept.'});
   if(value!==null)report.makerSize=value;
   await writeFile(file,JSON.stringify(report));
  }return result;
 };
 const f=await fixture(t,runner),{job}=await f.store.start(f.input);await f.store.wait();return {...f,job};
}
test('completed-job lookup is hash-bound, read-only, and rejects corrupt metadata',async t=>{
 const f=await proposalFixture(t);
 const result=await f.store.makerSize(f.input,f.job.jobId);
 assert.deepEqual(result.proposal,proposal);assert.equal(result.baseModelSha256,(await f.store.artifact(f.input,f.job.jobId,'repaired.stl')).ref.sha256);
 assert.equal((await f.store.load(f.input,f.job.jobId)).job.makerSize,undefined);
 const folder=join(f.root,'captures',f.input.captureId,'scan-processing',f.job.jobId);
 assert(!(await readdir(folder)).includes('sizes'));
 await assert.rejects(f.store.makerSize({...f.input,projectId:'elsewhere'},f.job.jobId));
 await writeFile(join(folder,'report.json'),'{}');await assert.rejects(f.store.makerSize(f.input,f.job.jobId),e=>e.code==='processing-unavailable');
});
test('AI-off ignores even otherwise valid proposal metadata; AI-on without a result stays absent',async t=>{
 for(const [p,ai] of [[proposal,false],[null,true]]){const f=await proposalFixture(t,p,ai);assert.equal((await f.store.makerSize(f.input,f.job.jobId)).proposal,null);}
});
test('paired maker-size GET enforces ownership, scopes and preconditions without applying size',async t=>{
 const f=await proposalFixture(t),remoteAuth=await RemoteAuthStore.create(join(f.root,'auth'),{host:'companion.example-tail.ts.net',allowedLogins:['alice@example.test']});
 const pair=async scopes=>{const invite=await remoteAuth.createPairing('alice@example.test',scopes);return remoteAuth.exchange('alice@example.test',{code:invite.code,deviceName:'Test'});};
 const reader=await pair(['captures:read']),writer=await pair(['captures:import']);
 const server=await startCompanionServer({port:0,remoteAuth,capture:{storage:f.storage,captures:f.captures,scanProcessing:f.store}});t.after(()=>server.close());
 const forwarded=JSON.parse(await readFile(new URL('./fixtures/tailscale-serve-v1.94.2.json',import.meta.url),'utf8')).expected;
 const etag=savedProjectETag(await f.storage.read('test')),base=`/v1/saved-projects/test/captures/${f.input.captureId}/scan-processing/${f.job.jobId}/maker-size`;
 const wire=(path=base+'?projectRevision=0',method='GET',device=reader,tag=etag)=>new Promise((resolve,reject)=>{
  const req=httpRequest(server.url+path,{method,headers:{...forwarded,authorization:`Bearer ${device.token}`,'x-scan-device':device.deviceId,'if-match':tag}},res=>{
   const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>setImmediate(()=>resolve({status:res.statusCode,bytes:Buffer.concat(chunks)})));res.on('error',reject);
  });req.on('error',reject);req.end();
 });
 const first=await wire();assert.equal(first.status,200,first.bytes.toString());assert.deepEqual(JSON.parse(first.bytes).proposal,proposal);
 assert.equal((await wire(undefined,'POST')).status,405);
 assert.equal((await wire(undefined,'GET',writer)).status,403);
 assert.equal((await wire(undefined,'GET',reader,'"'+'0'.repeat(64)+'"')).status,412);
 assert.equal((await wire(base)).status,400);
 assert.equal((await wire(base.replace(f.input.captureId,'ffffffff-ffff-4fff-8fff-ffffffffffff')+'?projectRevision=0')).status,404);
 assert.equal((await f.store.load(f.input,f.job.jobId)).job.status,'succeeded');
 await assert.rejects(readdir(join(f.root,'captures',f.input.captureId,'scan-processing',f.job.jobId,'sizes')),{code:'ENOENT'});
});
