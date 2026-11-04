import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {AI_TWEAK_PROMPT,aiTweakInternals,checkModelAccess,claudeSignedIn,defaultShell,modelAccessFromEnv,runAiTweak} from '../dist/ai-tweak.js';
import {findExecutable,loginShellPath,resolveOptions} from '../dist/ai-tweak-cli.js';

const run=promisify(execFile);
const python=process.env.CAPTURE_TEST_PYTHON??'python3';
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ai-tweak-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const scan=join(root,'capture'),home=join(root,'home');await mkdir(scan);await mkdir(home);
 await writeFile(join(scan,'mesh.obj'),'mtllib mesh.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl material_0\nf 1/1 2/2 3/3\nf 1/1 2/2 4/3\nf 1/1 3/2 4/3\nf 2/1 3/2 4/3\n');
 await writeFile(join(scan,'mesh.mtl'),'newmtl material_0\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n');
 await writeFile(join(scan,'mesh_basecolor_0.png'),Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
 await writeFile(join(scan,'original.usdz'),'usdz bytes');
 return {root,scan,home,mesh:join(scan,'mesh.obj'),usdz:join(scan,'original.usdz'),record:join(root,'record.json')};
}

/** A stand-in CLI: records how it was started, then performs `action` in its working directory. */
async function fakeCli(f,name,action,{claudeResult='done',exitCode=0,authStatus}={}){
 const path=join(f.root,'bin',name);await mkdir(join(f.root,'bin'),{recursive:true});
 const body=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const argv=process.argv.slice(2);
if(argv[0]==='--version'){console.log('${name} 9.9.9 (fake)');process.exit(0);}
// Like the real CLIs: Claude Code finds its keychain login by USER; Codex reads CODEX_HOME/auth.json.
const authStatus=${JSON.stringify(authStatus??null)};
if(argv[0]==='auth'&&argv[1]==='status'){
 if(authStatus){process.stdout.write(authStatus.stdout);process.exit(authStatus.code);}
 const ok=!!process.env.USER;console.log(JSON.stringify({loggedIn:ok,authMethod:ok?'claude.ai':'none',apiProvider:'firstParty'}));process.exit(ok?0:1);
}
if(argv[0]==='login'&&argv[1]==='status'){
 if(authStatus){process.stderr.write(authStatus.stdout);process.exit(authStatus.code);}
 if(fs.existsSync(path.join(process.env.CODEX_HOME,'auth.json'))){console.log('Logged in using ChatGPT');process.exit(0);}
 console.error('Not logged in');process.exit(1);
}
if('${name}'==='claude'&&!process.env.USER&&!process.env.ANTHROPIC_API_KEY){console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'Not logged in · Please run /login'}));process.exit(1);}
let stdin;try{stdin=fs.readFileSync(0).length;}catch(e){stdin='error:'+e.code;}
const record={argv,env:process.env,cwd:process.cwd(),files:fs.readdirSync('.').sort(),stdin};
if(process.env.CODEX_HOME){record.codexHome=fs.readdirSync(process.env.CODEX_HOME).sort();record.config=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
 try{record.auth=fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'utf8');}catch{}}
const prompt=argv[1];fs.appendFileSync(${JSON.stringify(join(f.root,'calls.log'))},prompt+'\\n');
const action=${JSON.stringify(action)};
const sessionId=require('node:crypto').randomUUID();
if('${name}'==='claude'){
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId,model:'claude-opus-5-5',apiKeySource:process.env.ANTHROPIC_API_KEY?'ANTHROPIC_API_KEY':'none',mcp_servers:[],plugins:[{source:'builtin@builtin'}],skills:['x']}));
 const projects=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME,'.claude'),'projects','-sealed');fs.mkdirSync(projects,{recursive:true});
 fs.writeFileSync(path.join(projects,sessionId+'.jsonl'),[{type:'user',message:{content:prompt}},{type:'attachment',attachment:{type:'environment'}},{type:'attachment',attachment:{type:'skill_listing'}}].map(e=>JSON.stringify(e)).join('\\n')+'\\n');
}else{
 console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'}));
 const sessions=path.join(process.env.CODEX_HOME,'sessions','2026');fs.mkdirSync(sessions,{recursive:true});
 fs.writeFileSync(path.join(sessions,'rollout-x-thread-1.jsonl'),[{type:'turn_context',payload:{model:'gpt-6-astra',effort:'xhigh'}},{type:'response_item',payload:{type:'message',role:'developer',content:[{text:'You are Codex'}]}},{type:'response_item',payload:{type:'message',role:'user',content:[{text:'<environment_context>x'}]}},{type:'response_item',payload:{type:'message',role:'user',content:[{text:prompt}]}}].map(e=>JSON.stringify(e)).join('\\n')+'\\n');
}
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
if(action==='new-folder'){
 write('tweaked/mesh.obj',fs.readFileSync('mesh.obj'));write('tweaked/mesh.mtl',fs.readFileSync('mesh.mtl'));write('tweaked/mesh_basecolor_0.png',Buffer.from([137,80,78,71,13,10,26,10,9,9]));
}else if(action==='in-place'){
 fs.mkdirSync('original_scan');for(const n of ['mesh.obj','mesh.mtl','mesh_basecolor_0.png'])fs.copyFileSync(n,'original_scan/'+n);
 fs.mkdirSync('.work');fs.renameSync('mesh.obj','.work/old.obj');write('mesh.obj',fs.readFileSync('.work/old.obj','utf8')+'v 2 2 2\\n');
}else if(action==='glb-only'){write('scan.glb','glTF');}
else if(action==='symlink-dir'){fs.mkdirSync(${JSON.stringify(join(f.root,'outside'))},{recursive:true});fs.writeFileSync(${JSON.stringify(join(f.root,'outside','a.mtl'))},'newmtl x\\n');fs.symlinkSync(${JSON.stringify(join(f.root,'outside'))},'textures');write('evil.obj','mtllib textures/a.mtl\\nv 0 0 0\\n');}
else if(action==='absolute-refs'){const here=process.cwd();write('tweaked/mesh_basecolor_0.png',Buffer.from([137,80,78,71,13,10,26,10,7]));write('tweaked/mesh.mtl','newmtl material_0\\nmap_Kd '+path.join(here,'tweaked','mesh_basecolor_0.png')+'\\n');write('tweaked/mesh.obj','mtllib '+path.join(here,'tweaked','mesh.mtl')+'\\nv 0 0 0\\nv 1 0 0\\nv 0 1 0\\nf 1 2 3\\n');}
else if(action==='spaced-names'){write('tweaked/my scan.obj','mtllib my scan.mtl\\nv 0 0 0\\nv 1 0 0\\nv 0 1 0\\nf 1 2 3\\n');write('tweaked/my scan.mtl','newmtl m\\nmap_Kd -clamp off base color.png\\nmap_Bump -bm 1.0 normal map.png\\n');write('tweaked/base color.png',Buffer.from([137,80,78,71,13,10,26,10,5]));write('tweaked/normal map.png',Buffer.from([137,80,78,71,13,10,26,10,6]));write('tweaked/color.png','decoy');}
else if(action==='leftover-pipe'){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});child.unref();record.grandchild=child.pid;}
else if(action==='big-transcript'){const pad='x'.repeat(1024*1024);for(let i=0;i<24;i++)console.log(JSON.stringify({type:'assistant',pad}));}
else if(action==='escape'){write('evil.obj','mtllib ../../../../etc/hosts\\nv 0 0 0\\n');}
else if(action==='hang'||action==='leftover'){
 const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();record.grandchild=child.pid;
}else if(action==='refresh-auth'){fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'{"tokens":"refreshed"}');}
else if(action==='refresh-auth-conflict'){fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'{"tokens":"refreshed"}');fs.writeFileSync(${JSON.stringify(join(f.home,'.codex','auth.json'))},'{"tokens":"other"}');}
fs.writeFileSync(${JSON.stringify(f.record)},JSON.stringify(record));
if(action==='hang'){setInterval(()=>{},1000);}
else{
 if('${name}'==='claude')console.log(JSON.stringify({type:'result',subtype:${exitCode?"'error'":"'success'"},is_error:${exitCode?'true':'false'},duration_ms:5,num_turns:1,result:${JSON.stringify(claudeResult)},usage:{output_tokens:1}}));
 else{const o=argv[argv.indexOf('-o')+1];fs.writeFileSync(o,${JSON.stringify(claudeResult)});console.log(JSON.stringify({type:'turn.completed',usage:{output_tokens:2}}));}
 process.exitCode=${exitCode};
}
`;
 await writeFile(path,body);await chmod(path,0o755);return path;
}

const base=(f,extra={})=>({attempts:1,requireGuiSession:false,env:{HOME:f.home,PATH:'/usr/bin:/bin',ANTHROPIC_API_KEY:'sk-companion-key',OPENAI_API_KEY:'sk-openai',SCAN_TO_MAKE_REMOTE_AUTH_DIR:'/secret',MY_KEY:'sk-mine'},python,...extra});
const record=async f=>JSON.parse(await readFile(f.record,'utf8'));
const manifestOf=async out=>JSON.parse(await readFile(join(out,'ai-tweak.json'),'utf8'));

test('claude-code attempt is sealed, keyless and collects a new-folder bundle',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','new-folder'),out=join(f.root,'out');
 const manifest=await runAiTweak({mesh:f.mesh,usdz:f.usdz,stills:[]},out,base(f,{access:{kind:'claude-code'},claudePath}));
 const r=await record(f),a=manifest.attempts[0];
 assert.deepEqual(r.argv.slice(0,2),['-p',AI_TWEAK_PROMPT]);
 for(const flag of ['--dangerously-skip-permissions','--strict-mcp-config'])assert.ok(r.argv.includes(flag));
 assert.equal(r.argv[r.argv.indexOf('--setting-sources')+1],'');
 assert.deepEqual(JSON.parse(r.argv[r.argv.indexOf('--settings')+1]),{disableAllHooks:true,autoMemoryEnabled:false,enabledPlugins:{}});
 assert.equal(r.argv[r.argv.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert.equal(r.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,'1');assert.equal(r.env.ENABLE_CLAUDEAI_MCP_SERVERS,'false');assert.equal(r.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,'1');
 // No key moves a subscription run onto API billing, and no companion setting leaks in.
 for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','SCAN_TO_MAKE_REMOTE_AUTH_DIR','MY_KEY'])assert.equal(r.env[name],undefined,name);
 assert.equal(r.stdin,0);
 assert.deepEqual(r.files,['mesh.mtl','mesh.obj','mesh_basecolor_0.png','original.usdz']);
 assert.equal(a.outcome,'changed');assert.equal(a.result.sourcePath,'tweaked/mesh.obj');assert.equal(a.result.obj,'mesh.obj');
 assert.deepEqual(Object.keys(a.result.files).sort(),['mesh.mtl','mesh.obj','mesh_basecolor_0.png']);
 assert.deepEqual([...(await readFile(join(out,a.result.dir,'mesh_basecolor_0.png')))],[137,80,78,71,13,10,26,10,9,9]);
 assert.equal(a.seal.apiKeySource,'none');assert.deepEqual(a.seal.mcpServers,[]);assert.equal(a.seal.hookEvents,0);
 assert.equal(a.seal.firstUserMessageIsPrompt,true);assert.deepEqual(a.seal.memoryAttachments,[]);
 // The session moves into Scan to Make's logs and out of the user's Claude history.
 assert.ok(await stat(join(out,a.logs.session)));await assert.rejects(stat(join(f.home,'.claude','projects','-sealed')));
 assert.deepEqual(await manifestOf(out),manifest);
 assert.equal(manifest.inputs['mesh.obj'].sha256,(await import('node:crypto')).createHash('sha256').update(await readFile(f.mesh)).digest('hex'));
});

test('api access passes only the named key; codex-cli gets a fresh CODEX_HOME holding only auth and model config',async t=>{
 const f=await fixture(t);
 const claudePath=await fakeCli(f,'claude','nothing');
 await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'a'),base(f,{access:{kind:'api',provider:'anthropic',keyEnv:'MY_KEY'},claudePath}));
 let r=await record(f);assert.equal(r.env.ANTHROPIC_API_KEY,'sk-mine');assert.equal(r.env.OPENAI_API_KEY,undefined);
 await mkdir(join(f.home,'.codex'));await writeFile(join(f.home,'.codex','auth.json'),'{"tokens":"user"}',{mode:0o600});
 await writeFile(join(f.home,'.codex','config.toml'),'model = "should-not-be-read"\n[mcp_servers.x]\ncommand = "x"\n');
 const codexPath=await fakeCli(f,'codex','in-place'),out=join(f.root,'b');
 const manifest=await runAiTweak({mesh:f.mesh,usdz:f.usdz,stills:[]},out,base(f,{access:{kind:'codex-cli'},codexPath}));
 r=await record(f);const a=manifest.attempts[0];
 assert.deepEqual(r.argv,['exec',AI_TWEAK_PROMPT,'--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--json','-o',r.argv[6]]);
 assert.deepEqual(r.codexHome,['auth.json','config.toml']);assert.equal(r.auth,'{"tokens":"user"}');
 // A private HOME keeps ~/.agents/skills and shell profiles out; the sign-in was still read from the real one.
 assert.notEqual(r.env.HOME,f.home);assert.ok(r.env.HOME.startsWith(tmpdir()));
 assert.match(r.config,/^model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n/);
 assert.match(r.config,/\[features\]\napps = false\nplugins = false\nremote_plugin = false\nplugin_discovery_prefetch = false\nmemories = false/);
 assert.doesNotMatch(r.config,/mcp_servers|should-not-be-read/);
 for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','MY_KEY'])assert.equal(r.env[name],undefined,name);
 // In-place edit: the backup copy is ignored, the edited mesh.obj is the result, and the change is reported.
 assert.equal(a.outcome,'changed');assert.equal(a.result.sourcePath,'mesh.obj');assert.deepEqual(a.inputsModified,['mesh.obj']);assert.deepEqual(a.alternates,[]);
 assert.match(await readFile(join(out,a.result.dir,'mesh.obj'),'utf8'),/v 2 2 2/);
 assert.equal(a.seal.model,'gpt-6-astra');assert.equal(a.seal.userMessagesArePrompt,true);assert.equal(a.finalMessage,'done');
 assert.deepEqual(a.auth,{refreshed:false,writtenBack:false,conflict:false});
 assert.equal(await readFile(join(f.home,'.codex','auth.json'),'utf8'),'{"tokens":"user"}');
 const endpoint=join(f.root,'c');
 await runAiTweak({mesh:f.mesh,stills:[]},endpoint,base(f,{access:{kind:'endpoint',url:'http://127.0.0.1:8317/v1',model:'local-model',keyEnv:'MY_KEY'},codexPath}));
 r=await record(f);assert.equal(r.env.SCAN_TO_MAKE_AI_KEY,'sk-mine');assert.deepEqual(r.codexHome,['config.toml']);
 assert.match(r.config,/model_provider = "scan-to-make"/);assert.match(r.config,/base_url = "http:\/\/127.0.0.1:8317\/v1"\nwire_api = "responses"\nenv_key = "SCAN_TO_MAKE_AI_KEY"/);
 assert.equal((await manifestOf(endpoint)).access.host,'127.0.0.1:8317');
});

test('a refreshed Codex sign-in is written back only when the source is unchanged',async t=>{
 const f=await fixture(t);await mkdir(join(f.home,'.codex'));const source=join(f.home,'.codex','auth.json');
 await writeFile(source,'{"tokens":"user"}',{mode:0o600});
 let codexPath=await fakeCli(f,'codex','refresh-auth');
 let manifest=await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'a'),base(f,{access:{kind:'codex-cli'},codexPath}));
 assert.deepEqual(manifest.attempts[0].auth,{refreshed:true,writtenBack:true,conflict:false});
 assert.equal(await readFile(source,'utf8'),'{"tokens":"refreshed"}');assert.equal((await stat(source)).mode&0o777,0o600);
 await writeFile(source,'{"tokens":"user"}');await rm(join(f.root,'bin'),{recursive:true});
 codexPath=await fakeCli(f,'codex','refresh-auth-conflict');
 manifest=await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'b'),base(f,{access:{kind:'codex-cli'},codexPath}));
 assert.deepEqual(manifest.attempts[0].auth,{refreshed:true,writtenBack:false,conflict:true});
 assert.equal(await readFile(source,'utf8'),'{"tokens":"other"}');
 await rm(source);
 manifest=await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'c'),base(f,{access:{kind:'codex-cli'},codexPath}));
 assert.equal(manifest.attempts[0].outcome,'auth-failed');
});

test('evidence survives transcripts larger than the in-memory window',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','big-transcript',{claudeResult:'final words'});
 const a=(await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'out'),base(f,{access:{kind:'claude-code'},claudePath}))).attempts[0];
 assert.equal(a.finalMessage,'final words');assert.equal(a.seal.model,'claude-opus-5-5');assert.equal(a.usage.turns,1);
 assert.ok((await stat(join(f.root,'out',a.logs.transcript))).size>24*1024*1024);
});

test('review fixes: symlinked folders, absolute references, pipe-holding leftovers and parallel sign-in refresh',async t=>{
 const f=await fixture(t);let n=0;
 const one=async(name,action,extra={})=>{
  await rm(join(f.root,'bin'),{recursive:true,force:true});
  const cli=await fakeCli(f,name,action),out=join(f.root,`fix-${++n}`);
  return [await runAiTweak({mesh:f.mesh,stills:[]},out,base(f,{access:{kind:name==='claude'?'claude-code':'codex-cli'},[name==='claude'?'claudePath':'codexPath']:cli,...extra})),out];
 };
 let [m]=await one('claude','symlink-dir');assert.equal(m.attempts[0].outcome,'invalid-output');
 let out;[m,out]=await one('claude','absolute-refs');const a=m.attempts[0];
 assert.equal(a.outcome,'changed');assert.equal(a.result.sourcePath,'tweaked/mesh.obj');
 assert.match(await readFile(join(out,a.result.dir,'mesh.obj'),'utf8'),/^mtllib mesh\.mtl\n/);
 assert.match(await readFile(join(out,a.result.dir,'mesh.mtl'),'utf8'),/map_Kd mesh_basecolor_0\.png\n/);
 const started=Date.now();[m]=await one('claude','leftover-pipe',{timeoutMs:60000});
 assert.equal(m.attempts[0].outcome,'unchanged');assert.ok(Date.now()-started<30000,'finished without waiting for the time limit');
 assert.equal(alive((await record(f)).grandchild),false);
 // Parallel Codex attempts: one warm-up call refreshes the shared sign-in once, before the attempts start.
 await mkdir(join(f.home,'.codex'),{recursive:true});await writeFile(join(f.home,'.codex','auth.json'),'{"tokens":"user"}',{mode:0o600});
 await rm(join(f.root,'calls.log'),{force:true});
 [m]=await one('codex','refresh-auth',{attempts:2});
 assert.deepEqual(m.warmup,{outcome:'unchanged',auth:{refreshed:true,writtenBack:true,conflict:false}});
 assert.deepEqual((await readFile(join(f.root,'calls.log'),'utf8')).trim().split('\n'),['Reply with the single word OK.',AI_TWEAK_PROMPT,AI_TWEAK_PROMPT]);
 assert.deepEqual(m.attempts.map(x=>x.auth.refreshed),[false,false]);
 // Concurrent write-backs from two attempts: one wins, the other is recorded as a conflict.
 const source=join(f.root,'auth-source.json');await writeFile(source,'{"v":0}');
 const sha=(await import('node:crypto')).createHash('sha256').update('{"v":0}').digest('hex');
 await writeFile(join(f.root,'sealed-1.json'),'{"v":1}');await writeFile(join(f.root,'sealed-2.json'),'{"v":2}');
 const results=await Promise.all([1,2].map(i=>aiTweakInternals.returnCodexAuth({source,sourceSha:sha,copySha:sha},join(f.root,`sealed-${i}.json`))));
 assert.deepEqual(results.map(r=>r.writtenBack).sort(),[false,true]);assert.deepEqual(results.map(r=>r.conflict).sort(),[false,true]);
 assert.match(await readFile(source,'utf8'),/"v":[12]/);
});

test('log write failures stop the attempt instead of the companion, and oversized MTLs invalidate a bundle',async t=>{
 const f=await fixture(t);let failed=false;
 const log=aiTweakInternals.sink(join(f.root,'missing-dir','x.log'),1024,()=>{},()=>{failed=true;});
 log.write(Buffer.from('x'));await new Promise(r=>setTimeout(r,100));await log.close();assert.equal(failed,true);
 const dir=join(f.root,'big');await mkdir(dir);
 await writeFile(join(dir,'m.obj'),'mtllib big.mtl\nv 0 0 0\n');await writeFile(join(dir,'big.mtl'),'#'.repeat(5*1024*1024));
 assert.equal((await aiTweakInternals.objBundle(dir,join(dir,'m.obj'))).escaped,true);
});

test('spaced texture filenames and -clamp options resolve to the whole name',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','spaced-names'),out=join(f.root,'out');
 const a=(await runAiTweak({mesh:f.mesh,stills:[]},out,base(f,{access:{kind:'claude-code'},claudePath}))).attempts[0];
 assert.equal(a.outcome,'changed');assert.equal(a.result.sourcePath,'tweaked/my scan.obj');
 assert.deepEqual(Object.keys(a.result.files).sort(),['base color.png','my scan.mtl','my scan.obj','normal map.png']);
});

test('the stills helper can use a Pillow installed only in the user site',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','nothing'),still=join(f.root,'p.jpg');
 await run(python,['-c',`from PIL import Image\nImage.new('RGB',(8,8),'red').save(${JSON.stringify(still)})`]);
 // Real interpreter: -I turns the user site off (it implies -s); -E -P keep it on.
 const userSite=async flags=>(await run(python,[...flags,'-c','import sys;print(sys.flags.no_user_site)'])).stdout.trim();
 assert.equal(await userSite(['-I']),'1');assert.equal(await userSite(['-E','-P']),'0');
 // A Python whose Pillow lives only in the user site: it fails exactly as Python does when the user
 // site is off (-I/-s) or HOME isn't the user's, and otherwise runs the real interpreter.
 const userPython=join(f.root,'user-python');
 await writeFile(userPython,`#!/bin/sh
for a in "$@"; do case "$a" in --*) ;; -*[Is]*) echo "ModuleNotFoundError: No module named 'PIL'" >&2; exit 1;; -*) ;; *) break;; esac; done
[ "$HOME" = ${JSON.stringify(f.home)} ] || { echo "ModuleNotFoundError: No module named 'PIL'" >&2; exit 1; }
exec ${JSON.stringify(python)} "$@"
`,{mode:0o755});
 const manifest=await runAiTweak({mesh:f.mesh,stills:[still]},join(f.root,'out'),base(f,{access:{kind:'claude-code'},claudePath,python:userPython}));
 assert.ok(Object.keys(manifest.inputs).some(name=>/^still_00_[0-9a-f]{8}\.jpg$/.test(name)));
});

test('outcomes: unchanged, other format only, escaping references, sign-in failure, missing CLI and none',async t=>{
 const f=await fixture(t);let n=0;
 const outcome=async(action,options={})=>{
  await rm(join(f.root,'bin'),{recursive:true,force:true});
  const claudePath=await fakeCli(f,'claude',action,options),out=join(f.root,`out-${++n}`);
  return (await runAiTweak({mesh:f.mesh,stills:[]},out,base(f,{access:{kind:'claude-code'},claudePath}))).attempts[0];
 };
 assert.equal((await outcome('nothing')).outcome,'unchanged');
 const glb=await outcome('glb-only');assert.equal(glb.outcome,'other-format-only');assert.deepEqual(glb.otherOutputs,['scan.glb']);
 assert.equal((await outcome('escape')).outcome,'invalid-output');
 const auth=await outcome('nothing',{claudeResult:'Not logged in · Please run /login',exitCode:1});assert.equal(auth.outcome,'auth-failed');
 assert.equal((await outcome('nothing',{claudeResult:'Something broke',exitCode:1})).outcome,'failed');
 const missing=await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'missing'),base(f,{access:{kind:'claude-code'},claudePath:join(f.root,'nope','claude')}));
 assert.equal(missing.attempts[0].outcome,'failed');assert.match(missing.attempts[0].reason,/isn't installed/);
 const none=await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'none'),base(f,{access:{kind:'none'}}));
 assert.equal(none.skipped,'access-none');assert.deepEqual(none.attempts,[]);await assert.rejects(stat(join(f.root,'none','inputs')));
});

test('time limit and normal exit both stop every descendant, including detached workers',async t=>{
 const f=await fixture(t);
 let claudePath=await fakeCli(f,'claude','hang');
 const started=Date.now();
 const timed=(await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'a'),base(f,{access:{kind:'claude-code'},claudePath,timeoutMs:2500}))).attempts[0];
 assert.equal(timed.outcome,'timed-out');assert.ok(Date.now()-started<20000);
 let r=await record(f);assert.ok(r.grandchild);assert.equal(alive(r.grandchild),false);
 await rm(join(f.root,'bin'),{recursive:true});claudePath=await fakeCli(f,'claude','leftover');
 const done=(await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'b'),base(f,{access:{kind:'claude-code'},claudePath}))).attempts[0];
 r=await record(f);assert.equal(done.outcome,'unchanged');assert.equal(alive(r.grandchild),false);
 await rm(join(f.root,'bin'),{recursive:true});claudePath=await fakeCli(f,'claude','hang');
 const controller=new AbortController();setTimeout(()=>controller.abort(),1500);
 const cancelled=(await runAiTweak({mesh:f.mesh,stills:[]},join(f.root,'c'),base(f,{access:{kind:'claude-code'},claudePath,signal:controller.signal}))).attempts[0];
 r=await record(f);assert.equal(cancelled.outcome,'cancelled');assert.equal(alive(r.grandchild),false);
});

test('attempts run in separate sealed folders and leave no workspace behind',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','new-folder'),out=join(f.root,'out');
 // A temp root of its own: other test files run in parallel and make stm-ai-* folders in the shared one.
 const own=join(f.root,'tmp');await mkdir(own);const saved=process.env.TMPDIR;process.env.TMPDIR=own;
 t.after(()=>{if(saved===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=saved;});
 const manifest=await runAiTweak({mesh:f.mesh,stills:[]},out,base(f,{access:{kind:'claude-code'},claudePath,attempts:3}));
 assert.equal(new Set(manifest.attempts.map(a=>a.seal.sessionId)).size,3,'parallel CLI invocations have distinct sessions');
 assert.deepEqual(manifest.attempts.map(a=>[a.index,a.outcome]),[[1,'changed'],[2,'changed'],[3,'changed']]);
 assert.deepEqual(await readdir(own),[]);
 await assert.rejects(runAiTweak({mesh:f.mesh,stills:[]},out,base(f,{access:{kind:'claude-code'},claudePath})),/EEXIST/);
});

test('stills reach the agent upright as full-resolution JPEGs',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','nothing'),still=join(f.root,'rotated.jpg');
 // A 40x20 photo stored with EXIF orientation 3 (rotate 180): red left half, blue right half.
 await run(python,['-c',`from PIL import Image
im=Image.new('RGB',(40,20),'blue');im.paste((255,0,0),(0,0,20,20));ex=Image.Exif();ex[274]=3;im.save(${JSON.stringify(still)},exif=ex,quality=95)`]);
 const out=join(f.root,'out');
 const manifest=await runAiTweak({mesh:f.mesh,stills:[still]},out,base(f,{access:{kind:'claude-code'},claudePath}));
 const name=Object.keys(manifest.inputs).find(n=>n.startsWith('still_00_'));assert.match(name,/^still_00_[0-9a-f]{8}\.jpg$/);
 assert.ok((await record(f)).files.includes(name));
 const {stdout}=await run(python,['-c',`from PIL import Image
im=Image.open(${JSON.stringify(join(out,'inputs',name))});print(im.size,im.getexif().get(274),im.getpixel((2,10)),im.getpixel((37,10)))`]);
 // Upright: the red half is now on the right, and no orientation tag remains.
 const [w,h,orientation,left,right]=stdout.match(/\((\d+), (\d+)\) (\w+) \((\d+), \d+, \d+\) \((\d+), \d+, \d+\)/).slice(1);
 assert.deepEqual([w,h,orientation],['40','20','None']);assert.ok(Number(left)<60&&Number(right)>200);
});

test('model access parsing fails closed and the Connected check uses the same sealed route',async t=>{
 assert.deepEqual(modelAccessFromEnv({}),{kind:'none'});
 assert.deepEqual(modelAccessFromEnv({SCAN_TO_MAKE_AI_ACCESS:'codex-cli',SCAN_TO_MAKE_AI_EFFORT:'high'}),{kind:'codex-cli',model:undefined,reasoningEffort:'high'});
 for(const env of [{SCAN_TO_MAKE_AI_ACCESS:'subscription-proxy'},{SCAN_TO_MAKE_AI_ACCESS:'api',SCAN_TO_MAKE_AI_PROVIDER:'google',SCAN_TO_MAKE_AI_KEY_ENV:'K'},
  {SCAN_TO_MAKE_AI_ACCESS:'api',SCAN_TO_MAKE_AI_PROVIDER:'anthropic'},{SCAN_TO_MAKE_AI_ACCESS:'endpoint',SCAN_TO_MAKE_AI_ENDPOINT:'ftp://x',SCAN_TO_MAKE_AI_MODEL:'m'},
  {SCAN_TO_MAKE_AI_ACCESS:'endpoint',SCAN_TO_MAKE_AI_ENDPOINT:'https://user:pw@x',SCAN_TO_MAKE_AI_MODEL:'m'},{SCAN_TO_MAKE_AI_ACCESS:'claude-code',SCAN_TO_MAKE_AI_MODEL:'bad model; rm'}])
  assert.throws(()=>modelAccessFromEnv(env),/Invalid/);
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','nothing',{claudeResult:'OK'});
 const ok=await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath}));
 assert.equal(ok.ok,true);assert.equal(ok.cliVersion,'claude 9.9.9 (fake)');assert.equal((await record(f)).argv[1],'Reply with the single word OK.');
 await rm(join(f.root,'bin'),{recursive:true});
 const denied=await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath:await fakeCli(f,'claude','nothing',{claudeResult:'Not logged in · Please run /login',exitCode:1})}));
 assert.deepEqual([denied.ok,denied.outcome],[false,'auth-failed']);
 assert.deepEqual(await checkModelAccess(base(f,{access:{kind:'none'}})),{ok:false,outcome:'skipped'});
});

test('KAN-199: a launchd environment with no USER still finds the keychain login, and the CLI\'s own status decides signed out',async t=>{
 const f=await fixture(t),me=userInfo().username;
 // base() is the companion's worker environment: HOME and PATH, no USER, plus keys that must not leak.
 const ok=await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath:await fakeCli(f,'claude','nothing',{claudeResult:'OK'})}));
 assert.deepEqual([ok.ok,ok.outcome],[true,'unchanged']);
 const r=await record(f);
 assert.deepEqual([r.env.USER,r.env.LOGNAME],[me,me]);
 for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','MY_KEY'])assert.equal(r.env[name],undefined,name);
 assert.equal(r.cwd.endsWith(join('','scan')),true);
 // An operator-set USER is kept.
 await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath:await fakeCli(f,'claude','nothing',{claudeResult:'OK'}),env:{...base(f).env,USER:'operator',LOGNAME:'operator'}}));
 assert.deepEqual([(await record(f)).env.USER,(await record(f)).env.LOGNAME],['operator','operator']);
 // Signed out per `claude auth status`: auth-failed before any prompt is sent.
 await rm(join(f.root,'calls.log'),{force:true});
 const out=await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath:await fakeCli(f,'claude','nothing',{claudeResult:'OK',authStatus:{stdout:'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',code:1}})}));
 assert.deepEqual([out.ok,out.outcome],[false,'auth-failed']);assert.match(out.reason,/isn't signed in/);
 await assert.rejects(stat(join(f.root,'calls.log')));
 // An unreadable status (an older CLI, a crash) falls through to the real call.
 const garbled=await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath:await fakeCli(f,'claude','nothing',{claudeResult:'OK',authStatus:{stdout:'error: unknown command auth',code:2}})}));
 assert.equal(garbled.ok,true);
 // Codex: `codex login status` against the sealed CODEX_HOME.
 await mkdir(join(f.home,'.codex'),{recursive:true});await writeFile(join(f.home,'.codex','auth.json'),'{"tokens":"t"}');
 const codex=await checkModelAccess(base(f,{access:{kind:'codex-cli'},codexPath:await fakeCli(f,'codex','nothing',{claudeResult:'OK'})}));
 assert.equal(codex.ok,true);assert.equal((await record(f)).env.USER,me);
 const codexOut=await checkModelAccess(base(f,{access:{kind:'codex-cli'},codexPath:await fakeCli(f,'codex','nothing',{claudeResult:'OK',authStatus:{stdout:'Not logged in\n',code:1}})}));
 assert.deepEqual([codexOut.ok,codexOut.outcome],[false,'auth-failed']);
});

test('claude auth status follows T3 Code\'s signed-in rule',()=>{
 const yes=[{loggedIn:true},{loggedIn:false,apiProvider:'bedrock'},{authMethod:'claude.ai'},{tokenSource:'oauth'},{apiKeySource:'ANTHROPIC_API_KEY'},{email:'a@b.c'},{subscriptionType:'max'}];
 for(const status of yes)assert.equal(claudeSignedIn(JSON.stringify(status)),true,JSON.stringify(status));
 assert.equal(claudeSignedIn('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'),false);
 for(const text of ['','not json','[]','null','{"apiProvider":"firstParty"}'])assert.equal(claudeSignedIn(text),undefined,text);
});

test('KAN-199: a CLI outside the usual places is found through the login shell, which contributes PATH only',async t=>{
 const f=await fixture(t),bin=join(f.root,'profile-bin');await mkdir(bin);
 await writeFile(join(bin,'claude'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 // A login shell whose profile adds a directory, prints noise and exports a key.
 const shell=join(f.root,'fake-shell');
 await writeFile(shell,`#!/bin/sh\nPATH="${bin}:$PATH"; ANTHROPIC_API_KEY=sk-from-profile; export PATH ANTHROPIC_API_KEY\necho profile noise\n[ "$1" = "-ilc" ] || exit 9\nexec /bin/sh -c "$2"\n`,{mode:0o755});
 const env={HOME:f.home,PATH:'/usr/bin:/bin',SHELL:shell,SCAN_TO_MAKE_AI_ACCESS:'claude-code'};
 const path=await loginShellPath(env);
 assert.equal(path.split(':')[0],bin);assert.ok(!path.includes('profile noise'));
 const options=await resolveOptions(env);
 if(!findExecutable('claude',{HOME:f.home,PATH:'/usr/bin:/bin'}))assert.equal(options.claudePath,join(bin,'claude'));
 assert.equal(options.env,env);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);
 if(options.claudePath===join(bin,'claude'))assert.equal(options.searchPath,path);
 // The discovered PATH follows the CLI into the sealed run, after the system directories, so a
 // `#!/usr/bin/env node` CLI finds the profile's node; it adds no variable besides PATH.
 const claudePath=await fakeCli(f,'claude','nothing',{claudeResult:'OK'});
 assert.equal((await checkModelAccess(base(f,{access:{kind:'claude-code'},claudePath,searchPath:`${bin}:relative/dir`}))).ok,true);
 const sealed=(await record(f)).env.PATH.split(':');
 assert.equal(sealed.at(-1),bin);assert.ok(sealed.indexOf('/usr/bin')<sealed.indexOf(bin));assert.ok(!sealed.includes('relative/dir'));
 // The shell runs only when needed, and never overrides an operator path.
 let asked=0;const spy=async(_env,_timeout,accept)=>{asked++;return accept(bin)?bin:undefined;};
 assert.equal((await resolveOptions({...env,SCAN_TO_MAKE_CLAUDE_PATH:'relative/claude'},spy)).claudePath,undefined);
 assert.equal((await resolveOptions({...env,SCAN_TO_MAKE_CLAUDE_PATH:join(bin,'claude')},spy)).claudePath,join(bin,'claude'));
 await resolveOptions({...env,SCAN_TO_MAKE_AI_ACCESS:'none'},spy);
 assert.equal(asked,0);
 // A profile that leaves a job holding stdout open cannot hold the lookup past its marker or its timer.
 const lingering=join(f.root,'lingering-shell');
 await writeFile(lingering,`#!/bin/sh\nsleep 30 &\nexec /bin/sh -c "$2"\n`,{mode:0o755});
 const started=Date.now();assert.equal((await loginShellPath({...env,SHELL:lingering},3000)).split(':').includes('/usr/bin'),true);
 assert.ok(Date.now()-started<2500);
 // A profile that hangs is stopped at the timer, with its whole process group.
 const hanging=join(f.root,'hanging-shell'),pidFile=join(f.root,'hanging.pid');
 await writeFile(hanging,`#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\nsleep 30\n`,{mode:0o755});
 const before=Date.now();
 assert.equal(await loginShellPath({HOME:f.home,SHELL:hanging,PATH:'/usr/bin:/bin'},500).then(p=>p===undefined||!p.includes('sleep')),true);
 const hungPid=Number((await readFile(pidFile,'utf8')).trim());
 await new Promise(r=>setTimeout(r,200));assert.equal(alive(hungPid),false);
 assert.ok(Date.now()-before<20000);
 // A shell whose PATH lacks the CLI doesn't hide the next candidate (here the account's own shell).
 const plain=join(f.root,'plain-shell');await writeFile(plain,'#!/bin/sh\nexec /bin/sh -c "$2"\n',{mode:0o755});
 const seen=[];
 await loginShellPath({...env,SHELL:plain},3000,p=>{seen.push(p);return p.split(':')[0]===bin;});
 assert.ok(seen.length>=1);assert.equal(seen[0].split(':')[0],'/usr/bin');
 assert.equal(await loginShellPath({...env,SHELL:plain},3000,()=>false),undefined);
 // A fish-style shell runs the probe without POSIX parameter syntax.
 const fishy=join(f.root,'fishy-shell');
 await writeFile(fishy,`#!/bin/sh\ncase "$2" in *'\${'*) echo "fish: Variables cannot be bracketed" >&2; exit 127;; esac\nPATH="${bin}:$PATH"; export PATH\nexec /bin/sh -c "$2"\n`,{mode:0o755});
 assert.equal((await loginShellPath({...env,SHELL:fishy},3000)).split(':')[0],bin);
 // A shell that prints no marked PATH yields nothing rather than a guess.
 const quiet=join(f.root,'quiet-shell');await writeFile(quiet,'#!/bin/sh\necho hello\n',{mode:0o755});
 assert.equal(await loginShellPath({HOME:f.home,SHELL:quiet},2000).then(p=>p===undefined||!p.includes('hello')),true);
});

test('ai-tweak-cli run --pick --export is the whole AI step of a cleanup job (KAN-184)',async t=>{
 const f=await fixture(t),claudePath=await fakeCli(f,'claude','new-folder'),out=join(f.root,'run'),exported=join(f.root,'corrected');
 const cli=new URL('../dist/ai-tweak-cli.js',import.meta.url).pathname;
 // The pick takes only absolute tool paths.
 const absolutePython=python.startsWith('/')?python:(await run('/bin/sh',['-c',`command -v ${python}`])).stdout.trim();
 const {stdout}=await run(process.execPath,[cli,'run','--mesh',f.mesh,'--usdz',f.usdz,'--out',out,'--attempts','1','--pick',
  '--export',exported,'--mm-per-unit','1000'],{env:{HOME:f.home,PATH:'/usr/bin:/bin',SCAN_TO_MAKE_AI_ACCESS:'claude-code',SCAN_TO_MAKE_AI_MODEL:'claude-opus-5-5',
  SCAN_TO_MAKE_CLAUDE_PATH:claudePath,SCAN_TO_MAKE_SCAN_BLENDER:'/bin/false',SCAN_TO_MAKE_CAPTURE_PYTHON:absolutePython,SCAN_TO_MAKE_AI_JUDGE_TOOL:join(f.root,'judge')}});
 const report=JSON.parse(await readFile(join(exported,'report.json'),'utf8'));
 // No Blender here, so the attempt can't be measured: the veto rejects it and the captured scan is exported.
 assert.deepEqual(report.aiTweak.attempts.map(a=>[a.index,a.outcome,a.veto]),[[1,'changed','unreadable']]);
 assert.deepEqual([report.aiTweak.pick.choice,report.aiTweak.pick.decidedBy],['captured','veto']);
 assert.deepEqual(report.aiTweak.access,{kind:'claude-code',model:'claude-opus-5-5'});
 assert.deepEqual(JSON.parse(stdout).aiTweak,report.aiTweak);
 assert.deepEqual((await readFile(join(exported,'corrected.obj'),'utf8')).split('\n').filter(l=>l.startsWith('v ')),['v 0 0 0','v 1000 0 0','v 0 1000 0','v 0 0 1000']);
 assert.deepEqual(Object.keys(report.outputs).sort(),['corrected.obj','corrected.stl','mesh.mtl','mesh_basecolor_0.png']);
 assert.equal(report.status,'complete');
});

test('an agent with no SHELL in its environment gets one that exists: zsh on macOS, the account shell or bash on Linux', () => {
  assert.equal(defaultShell('darwin', () => '/usr/local/bin/fish', () => false), '/bin/zsh');
  assert.equal(defaultShell('linux', () => '/usr/bin/fish', path => path === '/usr/bin/fish'), '/usr/bin/fish');
  assert.equal(defaultShell('linux', () => '/bin/zsh', path => path === '/bin/bash'), '/bin/bash', 'an account shell that is not installed is skipped');
  assert.equal(defaultShell('linux', () => undefined, () => false), '/bin/sh');
});
