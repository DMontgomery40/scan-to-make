import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ModelAccessService} from '../dist/model-access.js';
import {ObjectService} from '../dist/objects/service.js';
import {ObjectStore} from '../dist/objects/store.js';
import {tempDir} from './support/temp.mjs';

const invocation=root=>({command:'/must-not-run-claude',args:['-p','--append-system-prompt','rules','--json-schema','{}','make a bracket'],cwd:root,env:{},mcpConfigPath:join(root,'mcp.json'),mcpConfig:{mcpServers:{}}});
test('project dispatch uses saved Codex then API after restart; changing selection cannot retarget an admitted pass; Off refuses dispatch',async t=>{
 const root=await tempDir('provider-dispatch-');t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[];
 const worker=async(choice,args)=>{calls.push({choice,args});return {exitCode:0,stdout:JSON.stringify({toolCalls:0,seconds:0,exitCode:0,stderrTail:'',resultEvent:{structured_output:{status:'failed',summary:'fixture'}}})};};
 let access=await ModelAccessService.open(root,worker);
 await access.set(access.get().revision,{kind:'codex-cli'});
 let release,entered;
 const waiting=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
 const service=new ObjectService({store:new ObjectStore(join(root,'objects')),modelAccess:access,claudePath:'/must-not-run-claude',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},runTouchup:async input=>{
  entered();await gate;
  assert.equal(typeof input.worker,'function','project dispatch must supply the selected worker');
  await input.worker(invocation(root),{signal:input.signal});
  return {status:'failed',reason:'fixture',passDir:root,renders:[],checkpoints:[],stats:{seconds:0,toolCalls:0}};
 }});t.after(()=>service.close());
 const project=await service.create('A harmless bracket','fit');await service.start(project.id);await waiting;
 const api={kind:'api',provider:'openai',model:'gpt-6',keychainRef:randomUUID()};await access.set(access.get().revision,api);release();
 await service.settled(project.id);assert.equal(calls.length,1);assert.equal(calls[0].choice.kind,'codex-cli');assert.equal(calls[0].args[0],'project');
 access=await ModelAccessService.open(root,worker);
 const next=new ObjectService({store:new ObjectStore(join(root,'next')),modelAccess:access,claudePath:'/must-not-run-claude',handoff:{backend:'bambu-printer-mcp',process:{command:'/usr/bin/true'}},runTouchup:async input=>{
  await input.worker(invocation(root),{});return {status:'failed',reason:'fixture',passDir:root,renders:[],checkpoints:[],stats:{seconds:0,toolCalls:0}};
 }});t.after(()=>next.close());
 const second=await next.create('Another bracket','fit');await next.start(second.id);await next.settled(second.id);assert.deepEqual(calls[1].choice,api);
 await access.set(access.get().revision,{kind:'none'});const off=await next.create('No model','fit');await assert.rejects(next.start(off.id),/AI is off/);assert.equal(calls.length,2);
});

test('title and completion helpers use the selected worker with tools disabled',async t=>{
 const {generateTitle}=await import('../dist/objects/title.js');const {reportsCompletion}=await import('../dist/objects/completion-intent.js');
 const root=await tempDir('provider-text-');t.after(()=>rm(root,{recursive:true,force:true}));const seen=[];
 const access=await ModelAccessService.open(root,async(choice,args)=>{
  const {readFile}=await import('node:fs/promises');const input=JSON.parse(await readFile(args[1],'utf8'));seen.push({choice,input});
  const answer=seen.length===1?{title:'Shelf bracket'}:{intent:'works'};
  return {exitCode:0,stdout:JSON.stringify({toolCalls:0,seconds:0,exitCode:0,stderrTail:'',resultEvent:{structured_output:answer}})};
 });await access.set(access.get().revision,{kind:'codex-cli'});
 assert.equal(await generateTitle('A shelf bracket','/must-not-run',{worker:access.projectWorker()}),'Shelf bracket');
 assert.equal(await reportsCompletion('It works','/must-not-run',access.projectWorker()),'works');
 assert(seen.every(s=>s.choice.kind==='codex-cli'&&s.input.args[s.input.args.indexOf('--tools')+1]===''&&Object.keys(s.input.mcpConfig.mcpServers).length===0));
});

test('cleanup dispatch snapshots the saved provider across a later switch and Off keeps deterministic cleanup',async t=>{
 const {createScanCleanupRunner}=await import('../dist/scan-cleanup-runner.js');
 const root=await tempDir('provider-cleanup-');t.after(()=>rm(root,{recursive:true,force:true}));const seen=[];
 const access=await ModelAccessService.open(root,async(choice,args)=>{seen.push({choice,args});return {exitCode:0,stdout:'{}'};});
 await access.set(access.get().revision,{kind:'codex-cli'});
 const snapshot=access.cleanupSnapshot();
 const runner=createScanCleanupRunner({toolPath:'/repair',blender:'/blender',correctTool:'/correct',selectAI:()=>access.cleanupSnapshot(),ai:{access:{kind:'none'},cli:'/cli',judgeTool:'/judge'}});
 const admitted=runner.snapshot();assert.equal(admitted.cleanup.adapter,'ai-tweak');
 await access.set(access.get().revision,{kind:'none'});
 assert.equal(runner.snapshot().cleanup.adapter,'scripted');assert.equal(admitted.cleanup.adapter,'ai-tweak');
 await snapshot.worker(['--mesh','/mesh'],{});assert.equal(seen[0].choice.kind,'codex-cli');assert.equal(seen[0].args[0],'run');
});
