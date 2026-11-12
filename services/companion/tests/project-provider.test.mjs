import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {runProjectModel} from '../dist/project-worker.js';
import {ModelAccessService} from '../dist/model-access.js';
import {tempDir} from './support/temp.mjs';

async function fixture(t){const root=await tempDir('project-provider-');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const request=root=>({cwd:root,args:['-p','--mcp-config',join(root,'mcp.json'),'--append-system-prompt','Design a bracket','--json-schema',JSON.stringify({type:'object',properties:{status:{type:'string'},summary:{type:'string'}},required:['status','summary']}),'Make a bracket'],mcpConfig:{mcpServers:{printer:{command:process.execPath,args:[resolve('tests/fixtures/project-provider-mcp.mjs')],env:{RECEIPT:join(root,'receipt.json')}}}}});
async function server(t,handler){const s=createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r));});return `http://127.0.0.1:${s.address().port}/v1`;}
for(const kind of ['endpoint','openai','anthropic'])test(`${kind} executes real MCP tools, returns images and structured slicer feedback to the model and isolates its credential`,async t=>{
 const root=await fixture(t),seen=[];
 const endpoint=await server(t,async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);seen.push({body,headers:req.headers});res.setHeader('content-type','application/json');
  const use=seen.length<3,tool=seen.length===1?'mcp_printer_design_view':'mcp_printer_slice_stl';
  if(kind==='anthropic')res.end(JSON.stringify({content:use?[{type:'tool_use',id:`call${seen.length}`,name:tool,input:{}}]:[{type:'tool_use',id:'finish',name:'finish',input:{status:'done',summary:'Bracket complete'}}]}));
  else res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:use?`call${seen.length}`:'finish',type:'function',function:{name:use?tool:'finish',arguments:use?'{}':JSON.stringify({status:'done',summary:'Bracket complete'})}}]}}]}));
 });
 const original=global.fetch;if(kind!=='endpoint'){global.fetch=(url,opts)=>original(String(url).replace(kind==='anthropic'?'https://api.anthropic.com/v1':'https://api.openai.com/v1',endpoint),opts);t.after(()=>global.fetch=original);}
 const access=kind==='endpoint'?{kind,url:endpoint,model:'vision-tools',keyEnv:'MODEL_SECRET'}:{kind:'api',provider:kind,model:'vision-tools',keyEnv:'MODEL_SECRET'};
 const result=await runProjectModel(request(root),{access,env:{HOME:root,PATH:process.env.PATH,MODEL_SECRET:'private-key'}});
 assert.equal(result.resultEvent.structured_output.summary,'Bracket complete');assert.equal(seen.length,3);
 assert.equal(kind==='anthropic'?seen[0].headers['x-api-key']:seen[0].headers.authorization,kind==='anthropic'?'private-key':'Bearer private-key');
 const receipt=JSON.parse(await readFile(join(root,'receipt.json'),'utf8'));assert.deepEqual(receipt,{called:'slice_stl',secretPresent:false});
 assert.match(JSON.stringify(seen[1].body.messages),kind==='anthropic'?/"media_type":"image\/png"/:/data:image\/png;base64,iVBOR/);
 const messages=seen[2].body.messages;
 const sliceResult=kind==='anthropic'
  ? messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='tool_result'&&b.tool_use_id==='call2').content.map(b=>b.text??'').join('\n')
  : messages.find(m=>m.role==='tool'&&m.tool_call_id==='call2').content;
 assert.match(sliceResult,/out\/part.gcode/);
 const structured=JSON.parse(sliceResult.split('Structured result:\n')[1]);
 assert.deepEqual(structured.slicer_result,{return_code:0,error:null,plates:[{plate_index:1,warnings:['floating cantilever needs supports']}]});
 assert(!JSON.stringify(result).includes('private-key'));
});

test('API refusal is actionable, does not echo response secrets, and never falls back to Claude',async t=>{
 const root=await fixture(t),url=await server(t,(_q,res)=>{res.writeHead(400);res.end('private-key unsupported images');});
 const req=request(root);req.mcpConfig={mcpServers:{}};
 const result=await runProjectModel(req,{access:{kind:'endpoint',url,model:'text-only'},claudePath:'/must-not-run'});
 assert.equal(result.exitCode,1);assert.match(result.resultEvent.result,/tool calling and image support/);assert(!JSON.stringify(result).includes('private-key'));
});

test('API cancellation and deadline interrupt the HTTP request',async t=>{
 const root=await fixture(t),url=await server(t,()=>{}),req=request(root);req.mcpConfig={mcpServers:{}};
 const opts={access:{kind:'endpoint',url,model:'slow'}};
 const c=new AbortController();const running=runProjectModel(req,opts,c.signal);setTimeout(()=>c.abort(),30);
 assert.equal((await running).stopReason,'cancelled');
 assert.deepEqual((await runProjectModel({...req,timeoutMs:30},opts)).limit,{kind:'absolute',value:30});
});

test('legacy initialization preserves configured Claude only when no saved choice exists; explicit Off survives restart',async t=>{
 const root=await fixture(t),worker=async()=>({exitCode:0,stdout:'{}'});
 let service=await ModelAccessService.open(root,worker,{legacyClaude:true});assert.equal(service.get().choice.kind,'claude-code');
 await service.set(service.get().revision,{kind:'none'});service=await ModelAccessService.open(root,worker,{legacyClaude:true});assert.equal(service.get().choice.kind,'none');assert.throws(()=>service.projectWorker(),/AI is off/);
});

test('Codex uses its own login and only the pass MCP; cancellation reaps the worker',async t=>{
 const root=await fixture(t);await mkdir(join(root,'.codex'));await writeFile(join(root,'.codex','auth.json'),'login-fixture');
 const cli=join(root,'codex'),receipt=join(root,'codex.json');
 await writeFile(cli,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({auth:fs.readFileSync(process.env.CODEX_HOME+'/auth.json','utf8'),config:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),hasKey:!!process.env.MODEL_SECRET,pid:process.pid}));fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({status:'done',summary:'Codex fixture'}));console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call'}}));`,{mode:0o700});
 const result=await runProjectModel(request(root),{access:{kind:'codex-cli'},codexPath:cli,env:{HOME:root,MODEL_SECRET:'private-key'}});
 assert.equal(result.resultEvent.structured_output.summary,'Codex fixture');assert.equal(result.toolCalls,1);
 const recorded=JSON.parse(await readFile(receipt,'utf8'));assert.equal(recorded.auth,'login-fixture');assert.equal(recorded.hasKey,false);assert.match(recorded.config,/mcp_servers\."printer"/);assert.match(recorded.config,/project-mcp-cli/);
 assert.equal(await readFile(join(root,'.codex','auth.json'),'utf8'),'login-fixture');
 await writeFile(cli,`#!${process.execPath}\nsetInterval(()=>{},1000);`,{mode:0o700});
 assert.deepEqual((await runProjectModel({...request(root),timeoutMs:40},{access:{kind:'codex-cli'},codexPath:cli,env:{HOME:root}})).limit,{kind:'absolute',value:40});
});

test('a pass offers only its own engine\'s tools whichever worker runs it: Codex and API workers drop what the pass blocks, as Claude Code does (#609)',async t=>{
 // A Blender pass's request, as buildTouchupInvocation writes it: the printer MCP also lists the code engine's and Fusion's tools.
 const root=await fixture(t),req=request(root);
 req.args.splice(req.args.length-1,0,'--disallowedTools','mcp__printer__cad_*,mcp__printer__fusion_mcp_*');
 req.mcpConfig.mcpServers.printer.env.EXTRA_TOOLS='cad_status,cad_setup,cad_run,fusion_mcp_call,blender_mcp_call';
 // API and endpoint: the model is never offered a blocked tool.
 const offered=[];
 const url=await server(t,async(q,res)=>{let text='';for await(const chunk of q)text+=chunk;offered.push(JSON.parse(text).tools.map(tool=>tool.function.name));res.setHeader('content-type','application/json');
  res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'finish',type:'function',function:{name:'finish',arguments:JSON.stringify({status:'done',summary:'ok'})}}]}}]}));});
 const api=await runProjectModel(req,{access:{kind:'endpoint',url,model:'tools'},env:{HOME:root,PATH:process.env.PATH}});
 assert.equal(api.resultEvent.structured_output.summary,'ok');
 assert.deepEqual(offered[0].filter(name=>name.startsWith('mcp_')).sort(),['mcp_printer_blender_mcp_call','mcp_printer_design_view','mcp_printer_slice_stl']);
 // Codex: the blocked tools are that server's disabled_tools in the config it reads.
 await mkdir(join(root,'.codex'));await writeFile(join(root,'.codex','auth.json'),'login-fixture');
 const cli=join(root,'codex'),receipt=join(root,'codex.json');
 await writeFile(cli,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(receipt)},fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'));fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({status:'done',summary:'Codex fixture'}));`,{mode:0o700});
 const codex=await runProjectModel(req,{access:{kind:'codex-cli'},codexPath:cli,env:{HOME:root}});
 assert.equal(codex.resultEvent.structured_output.summary,'Codex fixture');
 const config=await readFile(receipt,'utf8');
 const printer=config.slice(config.indexOf('[mcp_servers."printer"]')).split('\n[')[0];
 assert.match(printer,/^disabled_tools = \["cad_status","cad_setup","cad_run","fusion_mcp_call"\]$/m,config);
 // A request that blocks nothing is unchanged.
 await runProjectModel(request(root),{access:{kind:'codex-cli'},codexPath:cli,env:{HOME:root}});
 assert.doesNotMatch(await readFile(receipt,'utf8'),/disabled_tools/);
});

test('provider-supplied key echoes are redacted from final results',async t=>{
 const root=await fixture(t),url=await server(t,(_q,res)=>res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'f',type:'function',function:{name:'finish',arguments:JSON.stringify({status:'failed',summary:'private-key'})}}]}}]})));
 const req=request(root);req.mcpConfig={mcpServers:{}};
 const result=await runProjectModel(req,{access:{kind:'endpoint',url,model:'test',keyEnv:'MODEL_SECRET'},env:{MODEL_SECRET:'private-key'}});
 assert.equal(result.resultEvent.structured_output.summary,'[redacted]');assert(!JSON.stringify(result).includes('private-key'));
});

test('Claude helper reports its own deadline as an absolute limit, never a person cancelling', async t => {
 const root=await fixture(t),cli=join(root,'claude-hang');
 await writeFile(cli,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'helper-session'}));setInterval(()=>{},1000);`,{mode:0o700});
 const result=await runProjectModel({...request(root),timeoutMs:300,inactivityMs:10000},{access:{kind:'claude-code'},claudePath:cli,env:{HOME:root}});
 assert.deepEqual(result.limit,{kind:'absolute',value:300});
 assert.notEqual(result.stopReason,'cancelled');
 assert.equal(result.sessionId,'helper-session');
});

test('a silent API worker records its inactivity limit', async t => {
 const root=await fixture(t),url=await server(t,()=>{}),req={...request(root),inactivityMs:30,timeoutMs:1000};req.mcpConfig={mcpServers:{}};
 const result=await runProjectModel(req,{access:{kind:'endpoint',url,model:'slow'}});
 assert.deepEqual(result.limit,{kind:'inactivity',value:30});assert.notEqual(result.stopReason,'cancelled');
});
