import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {EXECUTION_LOCK_MS} from '../dist/scan-processing.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DetailStillStore} from '../dist/detail-stills.js';
import {writeAiCorrection,aiTweakRecord} from '../dist/ai-tweak-export.js';
import {createScanCleanupRunner,aiWorkerEnv,AI_WORKER_GRACE_MS} from '../dist/scan-cleanup-runner.js';
import {fixture,cleanupRunner,png,sha} from './fixtures/scan-processing.mjs';

const realPng=Buffer.from([137,80,78,71,13,10,26,10,4,4]);
const record=aiTweakRecord({kind:'codex-cli',model:'gpt-6-astra'},{attempts:[{index:1,outcome:'changed',wallMs:1000},{index:2,outcome:'changed',wallMs:2000}]},
 {choice:'attempt-2',decidedBy:'judge',reason:'Attempt B keeps the stitches the photos show.',candidates:[{id:'captured'},{id:'attempt-1',veto:{reason:'smoothed'}},{id:'attempt-2'}]});

test('an AI cleanup job records the pick, publishes attempt previews and looks at every retained close-up',async t=>{
 let seen;
 const runner=cleanupRunner({});runner.cleanup.adapter='ai-tweak';
 const base=runner.cleanup.run;
 runner.cleanup.run=async(stage,ctx)=>{
  if(stage!=='correct')return base(stage,ctx);
  seen={stills:ctx.stills.length,metersPerUnit:ctx.metersPerUnit,deadlineAt:ctx.deadlineAt};
  const preview=join(ctx.imported,'preview.png');await writeFile(preview,realPng);
  await writeAiCorrection({obj:join(ctx.imported,'mesh.obj'),mmPerUnit:ctx.metersPerUnit*1000,out:ctx.corrected,record,previews:{'ai-attempt-2-preview.png':preview}});
  return Buffer.from('{}');
 };
 const f=await fixture(t,runner),stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 for(let i=0;i<6;i++)await stills.addDetailStill({...f.input,source:Buffer.concat([png,Buffer.from([i])]),label:`Close-up ${i}`});
 const {job}=await f.store.start(f.input);await f.store.wait();const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.status,'succeeded',JSON.stringify(result.pipelineStages));
 assert.equal(result.correctionAdapter,'ai-tweak');
 assert.deepEqual(result.aiTweak,record);
 assert.deepEqual(result.aiTweak.attempts.map(a=>a.veto),['smoothed',undefined]);
 assert.equal(result.detailStills.length,6);assert.equal(seen.stills,6);assert.equal(seen.metersPerUnit,1);
 assert(seen.deadlineAt>Date.now()&&seen.deadlineAt<=Date.now()+600000);
 assert.equal((await f.store.artifact(f.input,job.jobId,'ai-attempt-2-preview.png')).ref.sha256,sha(realPng));
 assert.equal(result.artifacts['ai-attempt-1-preview.png'],undefined);
 const correction=JSON.parse((await f.store.artifact(f.input,job.jobId,'correction.json')).bytes.toString('utf8'));
 assert.deepEqual(correction.aiTweak,record);
 // The job and its published report hold no paths.
 assert(!JSON.stringify(result).includes(f.root)&&!JSON.stringify(correction).includes(f.root));
});

test('a scripted cleanup job keeps the newest four close-ups and records no AI step',async t=>{
 const f=await fixture(t,cleanupRunner({})),stills=new DetailStillStore(f.storage,join(f.root,'captures'));
 for(let i=0;i<6;i++)await stills.addDetailStill({...f.input,source:Buffer.concat([png,Buffer.from([i])]),label:`Close-up ${i}`});
 const {job}=await f.store.start(f.input);await f.store.wait();const result=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(result.status,'succeeded');assert.equal(result.detailStills.length,4);assert.equal(result.aiTweak,undefined);
});

async function aiFixture(t,ai){
 const root=await mkdtemp(join(tmpdir(),'ai-cleanup-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const imported=join(root,'job','imported');await mkdir(imported,{recursive:true});
 await writeFile(join(imported,'mesh.obj'),'mtllib mesh.mtl\nv 0 0 0\nv .01 0 0\nv 0 .01 0\nvt 0 0\nusemtl material_0\nf 1/1 2/1 3/1\n');
 await writeFile(join(imported,'mesh.mtl'),'newmtl material_0\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n');await writeFile(join(imported,'mesh_basecolor_0.png'),realPng);
 await writeFile(join(root,'job','original.usdz'),'usdz');
 const runner=createScanCleanupRunner({blender:'/bin/false',toolPath:'/opt/scan-repair/repair.py',correctTool:'/opt/scan-correct/correct.py',ai:{access:{kind:'claude-code'},cli:join(root,'cli.mjs'),judgeTool:'/opt/ai-tweak-judge',...ai}});
 const controller=new AbortController(),groups=[];
 const ctx={source:join(root,'job','original.usdz'),imported,repaired:join(root,'job','repaired'),advice:join(root,'job','advice'),corrected:join(root,'job','corrected'),
  stills:['/stills/a.img','/stills/b.img'],signal:controller.signal,metersPerUnit:1,deadlineAt:Date.now()+3600000,onProcessGroup:pid=>{groups.push(pid);}};
 return {root,runner,ctx,controller,groups,report:async()=>JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8'))};
}

test('the AI adapter is chosen by model access and gets the 60-minute job deadline',async t=>{
 const {runner}=await aiFixture(t);assert.equal(runner.cleanup.adapter,'ai-tweak');assert.equal(runner.jobTimeoutMs,3600000);
 const off=createScanCleanupRunner({blender:'/bin/false',toolPath:'/opt/r.py',correctTool:'/opt/c.py',ai:{access:{kind:'none'},cli:'/opt/cli.js',judgeTool:'/opt/j'}});
 assert.equal(off.cleanup.adapter,'scripted');assert.equal(off.jobTimeoutMs,1800000);
 assert.throws(()=>createScanCleanupRunner({blender:'/bin/false',toolPath:'/opt/r.py',correctTool:'/opt/c.py',ai:{access:{kind:'claude-code'},cli:'cli.js',judgeTool:'/opt/j'}}),/Invalid cleanup/);
});

test('the AI step passes the whole job to one worker and keeps the captured scan when the worker fails',async t=>{
 let call;
 const {runner,ctx,report}=await aiFixture(t,{worker:async(args,options)=>{call={args,options};return {exitCode:1,stdout:''};}});
 await runner.cleanup.run('correct',ctx);
 const at=name=>call.args[call.args.indexOf(name)+1];
 assert.equal(at('--mesh'),join(ctx.imported,'mesh.obj'));assert.equal(at('--usdz'),ctx.source);assert.equal(at('--export'),ctx.corrected);
 assert.equal(at('--mm-per-unit'),'1000');assert(call.args.includes('--pick'));
 // No executable path reaches a (possibly keyed) worker as an argument.
 assert(!call.args.some(a=>a.includes('ai-tweak-judge')));
 assert.deepEqual(call.args.filter((_,i)=>call.args[i-1]==='--still'),ctx.stills);
 assert(Number(at('--timeout-ms'))<=1800000&&call.options.timeoutMs<=45*60000&&call.options.signal===ctx.signal);
 const r=await report();
 assert.deepEqual([r.aiTweak.pick.choice,r.aiTweak.pick.decidedBy],['captured','fallback']);assert.match(r.aiTweak.pick.reason,/could not finish/);
 assert.deepEqual(r.aiTweak.attempts,[]);
 assert.equal((await readFile(join(ctx.corrected,'corrected.obj'),'utf8')).split('\n')[2],'v 10 0 0');
});

test('a late job skips the AI step, and cancellation is never turned into a fallback',async t=>{
 let calls=0;
 const late=await aiFixture(t,{worker:async()=>{calls++;return {exitCode:0,stdout:''};}});
 late.ctx.deadlineAt=Date.now()+12*60000;await late.runner.cleanup.run('correct',late.ctx);
 assert.equal(calls,0);assert.match((await late.report()).aiTweak.pick.reason,/not enough time/);
 const cancelled=await aiFixture(t,{worker:async(_args,{signal})=>{cancelled.controller.abort();signal.throwIfAborted();}});
 await assert.rejects(cancelled.runner.cleanup.run('correct',cancelled.ctx));
 await assert.rejects(stat(join(cancelled.ctx.corrected,'report.json')));
});

test('a directly spawned worker gets time to stop its own attempts when the job is cancelled',async t=>{
 const f=await aiFixture(t),started=join(f.root,'started'),reaped=join(f.root,'reaped');
 // Stands in for ai-tweak-cli: on SIGTERM it takes 3.5 s to reap its attempt groups, as runAiTweak may.
 await writeFile(join(f.root,'cli.mjs'),`import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({argv:process.argv.slice(2),judge:process.env.SCAN_TO_MAKE_AI_JUDGE_TOOL}));
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(reaped)},'ok');process.exit(0);},3500));
setInterval(()=>{},1000);
`);
 const running=f.runner.cleanup.run('correct',f.ctx);
 for(let i=0;i<100;i++){try{await stat(started);break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const seen=JSON.parse(await readFile(started,'utf8'));
 assert.equal(seen.argv[0],'run');assert.equal(seen.judge,'/opt/ai-tweak-judge');assert.equal(f.groups.length,1);
 f.controller.abort();
 await assert.rejects(running);
 assert.equal(await readFile(reaped,'utf8'),'ok');
 assert(AI_WORKER_GRACE_MS>=10000);
});

test('a direct worker runs the runner’s own access and tools, with only the key that access names',()=>{
 const source={HOME:'/h',PATH:'/bin',SCAN_TO_MAKE_AI_ACCESS:'codex-cli',SCAN_TO_MAKE_AI_MODEL:'stale-model',SCAN_TO_MAKE_CAPTURE_PYTHON:'/stale/python',
  MY_KEY:'sk-user',OTHER_KEY:'sk-other',SCAN_TO_MAKE_PRINTER_TOKEN:'printer',ANTHROPIC_API_KEY:'sk-companion',SCAN_TO_MAKE_REMOTE_AUTH_DIR:'/secret'};
 const tools={blender:'/opt/blender',python:'sh',judgeTool:'/opt/judge'};
 assert.deepEqual(aiWorkerEnv({kind:'api',provider:'anthropic',model:'claude-opus-5-5',keyEnv:'MY_KEY'},tools,source),{HOME:'/h',PATH:'/bin',
  SCAN_TO_MAKE_AI_ACCESS:'api',SCAN_TO_MAKE_AI_MODEL:'claude-opus-5-5',SCAN_TO_MAKE_AI_PROVIDER:'anthropic',SCAN_TO_MAKE_AI_KEY_ENV:'MY_KEY',MY_KEY:'sk-user',
  SCAN_TO_MAKE_SCAN_BLENDER:'/opt/blender',SCAN_TO_MAKE_CAPTURE_PYTHON:'/bin/sh',SCAN_TO_MAKE_AI_JUDGE_TOOL:'/opt/judge'});
 // A subscription route carries no key and no stale model from the companion's environment.
 const cli=aiWorkerEnv({kind:'claude-code'},{...tools,python:undefined},{...source,PATH:'/nowhere'});
 assert.equal(cli.SCAN_TO_MAKE_AI_ACCESS,'claude-code');assert.equal(cli.SCAN_TO_MAKE_AI_MODEL,undefined);assert.equal(cli.SCAN_TO_MAKE_CAPTURE_PYTHON,undefined);
 assert(!Object.values(cli).some(v=>String(v).startsWith('sk-')));
});

test('another instance’s live 60-minute AI job keeps its lock; the next job waits, then runs',async t=>{
 const f=await fixture(t,cleanupRunner({})),lock=join(f.root,'captures','.scan-processing-lock');
 // A live process standing in for another companion instance, 45 minutes into an AI job.
 const owner=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>owner.kill('SIGKILL'));
 await mkdir(lock,{recursive:true});await writeFile(join(lock,'owner.json'),JSON.stringify({pid:owner.pid,jobId:'00000000-0000-4000-8000-0000000000aa'}));
 const old=new Date(Date.now()-45*60000);await utimes(lock,old,old);
 const {job}=await f.store.start(f.input);
 await new Promise(r=>setTimeout(r,800));
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'queued');
 assert.equal(JSON.parse(await readFile(join(lock,'owner.json'),'utf8')).pid,owner.pid,'a live owner inside its deadline is never reclaimed');
 await rm(lock,{recursive:true});
 await f.store.wait();assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
 assert(EXECUTION_LOCK_MS>=60*60000+10000);
});

test('a lock older than any job could run is reclaimed even if its pid is alive again',async t=>{
 const f=await fixture(t,cleanupRunner({})),lock=join(f.root,'captures','.scan-processing-lock');
 const reused=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>reused.kill('SIGKILL'));
 await mkdir(lock,{recursive:true});await writeFile(join(lock,'owner.json'),JSON.stringify({pid:reused.pid,jobId:'00000000-0000-4000-8000-0000000000bb'}));
 const old=new Date(Date.now()-EXECUTION_LOCK_MS-60000);await utimes(lock,old,old);
 const {job}=await f.store.start(f.input);await f.store.wait();
 assert.equal((await f.store.load(f.input,job.jobId)).job.status,'succeeded');
});
