import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ModelAccessService} from '../dist/model-access.js';
import {createModelWorker} from '../dist/model-access-worker.js';
import {parseRequest} from '../dist/local-control-protocol.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {RemoteAuthStore} from '../dist/remote-auth.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,worker=async()=>({exitCode:0,stdout:JSON.stringify({ok:true})})){
 const root=await mkdtemp('/tmp/stm-model-');t.after(()=>rm(root,{recursive:true,force:true}));
 const service=await ModelAccessService.open(root,worker);t.after(()=>service.close());
 return {root,service};
}
const api=()=>({kind:'api',provider:'anthropic',model:'claude-opus-5-5',keychainRef:randomUUID()});

test('all five choices survive restart with private metadata and no connected claim',async t=>{
 const {root,service}=await fixture(t);
 for(const choice of [{kind:'none'},{kind:'claude-code'},{kind:'codex-cli'},api(),{kind:'endpoint',url:'http://127.0.0.1:1234/v1',model:'local',keychainRef:randomUUID()}]){
  await service.set(service.get().revision,choice);
  assert.deepEqual((await ModelAccessService.open(root)).get(),service.get());
 }
 const current=service.get();service.startCheck(current.revision);await tick();assert.equal(service.get().check.state,'connected');
 assert.equal((await ModelAccessService.open(root)).get().check,null);
 assert.equal((await stat(join(root,'model-access.json'))).mode&0o777,0o600);
 assert(!JSON.stringify(JSON.parse(await readFile(join(root,'model-access.json'),'utf8'))).includes('connected'));
});

test('CAS serializes simultaneous edits; input/snapshot mutation cannot change stored choice',async t=>{
 const {service}=await fixture(t);const revision=service.get().revision,choice=api();
 const first=service.set(revision,choice),second=service.set(revision,{kind:'codex-cli'});
 choice.model='mutated';await first;await assert.rejects(second,e=>e.code==='conflict');
 const snapshot=service.get();snapshot.choice.model='also mutated';assert.equal(service.get().choice.model,'claude-opus-5-5');
});

test('check is immediate, deduplicated, sanitized and bound to revision; set cancels stale result',async t=>{
 let finish,signal,calls=0;
 const {service}=await fixture(t,async(_choice,args,options)=>{calls++;signal=options.signal;assert.deepEqual(args,['check']);return new Promise(resolve=>finish=resolve);});
 await service.set(service.get().revision,api());
 const start=service.startCheck(service.get().revision);
 assert.equal(start.check.state,'checking');assert.equal(service.startCheck(start.revision).check.id,start.check.id);assert.equal(calls,1);
 await service.set(start.revision,{kind:'codex-cli'});assert(signal.aborted);
 finish({exitCode:0,stdout:JSON.stringify({ok:true,reason:'SECRET',seal:{token:'SECRET'}})});await tick();assert.equal(service.get().check,null);
 const again=service.startCheck(service.get().revision);finish({exitCode:1,stdout:JSON.stringify({ok:false,outcome:'auth-failed',reason:'SECRET'})});await tick();
 assert.equal(service.get().check.state,'failed');assert.equal(service.get().check.outcome,'auth-failed');assert(!JSON.stringify(service.get()).includes('SECRET'));
 assert.throws(()=>service.startCheck(start.revision),e=>e.code==='conflict');assert.equal(again.revision,service.get().revision);
});

test('none skips without launching; malformed/failed worker output never becomes connected',async t=>{
 let calls=0;const results=[{exitCode:1,stdout:'{"ok":true}'},{exitCode:0,stdout:'{"ok":"true"}'},{exitCode:0,stdout:'not-json SECRET'}];
 const {service}=await fixture(t,async()=>{calls++;return results.shift();});
 assert.equal(service.startCheck(service.get().revision).check.state,'skipped');assert.equal(calls,0);
 await service.set(service.get().revision,{kind:'claude-code'});
 for(let i=0;i<3;i++){service.startCheck(service.get().revision);await tick();assert.equal(service.get().check.state,'failed');}
});

test('strict socket schemas reject plaintext keys, arbitrary references and credential URLs',async()=>{
 for(const choice of [{...api(),key:'SECRET'},{...api(),keychainRef:'existing-service/account'},{...api(),provider:'unsupported'},
  ...['https://user:SECRET@example.test','https://example.test?token=SECRET','https://example.test/#SECRET','file:///tmp/key'].map(url=>({kind:'endpoint',url,model:'m'}))]){
  assert.throws(()=>parseRequest({v:1,id:randomUUID(),method:'modelAccess.set',params:{expectedRevision:randomUUID(),choice}}),e=>e.code==='invalid-request');
 }
});

test('socket dispatcher exposes metadata and sanitized asynchronous check results',async t=>{
 const {root,service}=await fixture(t,async()=>{throw Error('SECRET');});
 const auth=await RemoteAuthStore.create(join(root,'auth'),{host:'fixture.example.ts.net',allowedLogins:['owner@example.test']});
 const dispatch=createControlDispatcher({auth,companionVersion:'test',modelAccess:service});
 const initial=await dispatch('modelAccess.get',{});
 const selected=await dispatch('modelAccess.set',{expectedRevision:initial.revision,choice:api()});
 const checking=await dispatch('modelAccess.check',{revision:selected.revision});assert.equal(checking.check.state,'checking');
 await tick();assert.equal((await dispatch('modelAccess.get',{})).check.state,'failed');
 assert(!JSON.stringify(await dispatch('modelAccess.get',{})).includes('SECRET'));
});

test('refuses public/malformed/symlink preferences without replacing their bytes',async t=>{
 const {root}=await fixture(t);const path=join(root,'model-access.json');
 await chmod(path,0o644);await assert.rejects(ModelAccessService.open(root));await chmod(path,0o600);
 await writeFile(path,'invalid SECRET');await assert.rejects(ModelAccessService.open(root));assert.equal(await readFile(path,'utf8'),'invalid SECRET');
 await rm(path);const outside=join(root,'unrelated');await writeFile(outside,'keep');await symlink(outside,path);
 await assert.rejects(ModelAccessService.open(root));assert.equal(await readFile(outside,'utf8'),'keep');
});

test('cleanup invocation snapshots metadata and propagates cancellation signal',async t=>{
 let captured;const {service}=await fixture(t,async(choice,args,options)=>{captured={choice,args,options};return {exitCode:0,stdout:'{}'};});
 const choice=api();await service.set(service.get().revision,choice);const controller=new AbortController();
 await service.run(['--mesh','/private/input.obj','--out','/private/output'],{signal:controller.signal});
 assert.deepEqual(captured.choice,choice);assert.equal(captured.args[0],'run');assert.equal(captured.options.signal,controller.signal);
 await service.set(service.get().revision,{kind:'none'});assert.deepEqual(captured.choice,choice);
});

test('worker boundary sends only metadata on stdin and removes inherited provider/printer secrets',async t=>{
 const {root}=await fixture(t);const helper=join(root,'helper');
 await writeFile(helper,`#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),choice:JSON.parse(input),envNames:Object.keys(process.env),leaked:Object.keys(process.env).some(k=>['ANTHROPIC_API_KEY','BAMBU_TOKEN','SCAN_TO_MAKE_MODEL_KEY'].includes(k))})));`,{mode:0o700});
 const old=process.env.BAMBU_TOKEN;process.env.BAMBU_TOKEN='SECRET';
 t.after(()=>{if(old===undefined)delete process.env.BAMBU_TOKEN;else process.env.BAMBU_TOKEN=old;});
 const choice=api(),result=await createModelWorker(helper)(choice,['check'],{}),value=JSON.parse(result.stdout);
 assert.equal(result.exitCode,0);assert.deepEqual(value.argv,['--model-worker','check']);assert.deepEqual(value.choice,choice);assert.equal(value.leaked,false);assert.deepEqual(value.envNames,[]);
 await assert.rejects(createModelWorker(undefined)(choice,['check'],{}));
});

test('shared environment fixtures parse through the existing AI module without changing routes',async()=>{
 const {modelAccessFromEnv}=await import('../dist/ai-tweak.js');
 const {ModelAccessChoiceSchema,ModelAccessEnvironment}=await import('@scan-to-make/contracts/model-access');
 const rows=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/model-access.json',import.meta.url),'utf8'));
 for(const row of rows){
  ModelAccessChoiceSchema.parse(row.choice);
  const parsed=modelAccessFromEnv(row.environment);assert.equal(parsed.kind,row.choice.kind);
  if(row.choice.model)assert.equal(parsed.model,row.choice.model);
  if(row.choice.keychainRef)assert.equal(parsed.keyEnv,ModelAccessEnvironment.secret);
 }
});

test('cancellation lets the worker reap detached model descendants before supervisor shutdown',async t=>{
 const {root}=await fixture(t),helper=join(root,'slow-cleanup'),receipt=join(root,'child.pid');
 await writeFile(helper,`#!${process.execPath}\nconst {spawn}=require('node:child_process'),fs=require('node:fs');\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});\nfs.writeFileSync(${JSON.stringify(receipt)},String(child.pid));\nprocess.on('SIGTERM',()=>setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{};child.once('exit',()=>process.exit(0));},3000));\nsetInterval(()=>{},1000);`,{mode:0o700});
 const controller=new AbortController(),pending=createModelWorker(helper)({kind:'codex-cli'},['check'],{signal:controller.signal});
 const rejected=assert.rejects(pending,e=>e.name==='AbortError');
 let pid;for(let i=0;i<100;i++){try{pid=Number(await readFile(receipt,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,10));}}
 assert(pid);t.after(()=>{try{process.kill(-pid,'SIGKILL');}catch{}});controller.abort();await rejected;
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('Swift uppercase UUID revisions compare by identity for both save and check',async t=>{
 const {service}=await fixture(t);
 const saved=await service.set(service.get().revision.toUpperCase(),{kind:'codex-cli'});
 const check=service.startCheck(saved.revision.toUpperCase());
 assert.equal(check.revision,check.check.revision);await tick();assert.equal(service.get().check.state,'connected');
});

test('shared URL fixtures agree with the Swift wire validator',async()=>{
 const {ModelAccessChoiceSchema}=await import('@scan-to-make/contracts/model-access');
 const rows=JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/model-access-urls.json',import.meta.url),'utf8'));
 for(const row of rows) assert.equal(ModelAccessChoiceSchema.safeParse({kind:'endpoint',url:row.url,model:'local'}).success,row.valid,row.url);
});

test('concurrent first-create publishes one complete record and ignores interrupted temporary files',async t=>{
 const root=await mkdtemp('/tmp/stm-model-');t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'model-access.json.interrupted'),'{"version":',{mode:0o600});
 const stores=await Promise.all(Array.from({length:12},()=>ModelAccessService.open(root)));
 assert.equal(new Set(stores.map(s=>s.get().revision)).size,1);
 const snapshot=stores[0].get(),stored=JSON.parse(await readFile(join(root,'model-access.json'),'utf8'));
 assert.deepEqual(stored,{version:1,revision:snapshot.revision,choice:{kind:'none'}});
 assert.equal((await stat(join(root,'model-access.json'))).mode&0o777,0o600);
});

test('stdout flood plus timeout and abort send only one graceful termination',async t=>{
 const {root}=await fixture(t),helper=join(root,'flood'),receipt=join(root,'cleaned');
 await writeFile(helper,`#!${process.execPath}\nconst fs=require('node:fs');process.once('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(receipt)},'done');process.exit(0)},300));process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`,{mode:0o700});
 const controller=new AbortController();
 const pending=createModelWorker(helper)({kind:'none'},['check'],{signal:controller.signal,timeoutMs:200});
 const rejected=assert.rejects(pending);setTimeout(()=>controller.abort(),150);await rejected;
 assert.equal(await readFile(receipt,'utf8'),'done');
});

test('custom CLI login directories reach subscription helpers only',async t=>{
 const {root}=await fixture(t),helper=join(root,'login-env');
 await writeFile(helper,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR})));`,{mode:0o700});
 const expected={CODEX_HOME:'/custom/codex',CLAUDE_CONFIG_DIR:'/custom/claude'};
 for(const [key,value] of Object.entries(expected)) {const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}
 for(const choice of [{kind:'claude-code'},{kind:'codex-cli'},{kind:'none'},api(),{kind:'endpoint',url:'http://localhost:1234',model:'local'},{kind:'endpoint',url:'https://example.test',model:'local',keychainRef:randomUUID()}]) {
  const result=await createModelWorker(helper)(choice,['check'],{});
  assert.deepEqual(JSON.parse(result.stdout),['claude-code','codex-cli'].includes(choice.kind)?expected:{},choice.kind);
 }
});
