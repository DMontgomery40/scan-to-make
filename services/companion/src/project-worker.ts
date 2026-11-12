import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep,extname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {PrinterMcpClient} from '@scan-to-make/printer-handoff';
import type {AiTweakOptions} from './ai-tweak.js';
import {aiTweakInternals} from './ai-tweak.js';
import {runClaudeWorker,publicTouchupText,TOUCHUP_TIMEOUT_MS,TOUCHUP_INACTIVITY_MS,TOUCHUP_MAX_TOOL_CALLS,limitWords,type WorkerRun,type WorkerLimit,type TouchupProgress} from './touchup/runner.js';
import {toolBlocked,type TouchupInvocation,type McpServerEntry} from './touchup/invocation.js';

type Request = Pick<TouchupInvocation,'args'|'cwd'|'mcpConfig'> & {timeoutMs?:number;inactivityMs?:number;maxToolCalls?:number};
const textBlock=(text:string)=>({type:'text' as const,text});
const value=(args:string[],flag:string)=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;

/** Native MCP children receive only their explicit process configuration plus a
 * minimal runtime environment. In particular they cannot inherit model keys. */
export async function isolatedMcp(entry:McpServerEntry,directory:string,source:NodeJS.ProcessEnv=process.env):Promise<McpServerEntry> {
 const env:Record<string,string>={};
 for(const name of ['HOME','PATH','TMPDIR','LANG','USER','LOGNAME'])if(source[name])env[name]=source[name]!;
 Object.assign(env,entry.env);
 const path=join(directory,`mcp-${randomUUID()}.json`);
 await writeFile(path,JSON.stringify({...entry,env}),{mode:0o600});
 return {command:process.execPath,args:[fileURLToPath(new URL('./project-mcp-cli.js',import.meta.url)),path]};
}

/** Called only by the signed helper after it resolves the immutable credential. */
export async function runProjectRequest(path:string,options:AiTweakOptions,signal?:AbortSignal,onProgress?:(progress:TouchupProgress)=>void):Promise<Omit<WorkerRun,'publicText'>> {
 const request=JSON.parse(await readFile(path,'utf8')) as Request;
 if(!isAbsolute(request.cwd)||!Array.isArray(request.args)||!request.mcpConfig?.mcpServers)throw Error('Invalid project request');
 return runProjectModel(request,options,signal,onProgress);
}

export async function runProjectModel(request:Request,options:AiTweakOptions,signal?:AbortSignal,onProgress?:(progress:TouchupProgress)=>void):Promise<Omit<WorkerRun,'publicText'>> {
 const started=Date.now(),access=options.access;
 const redact=(text:string)=>publicTouchupText(text,{...options.env,...Object.assign({},...Object.values(request.mcpConfig.mcpServers).map(s=>s.env))});
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let limit:WorkerLimit|undefined;
 const atLimit=(kind:WorkerLimit['kind'],value:number)=>{if(!controller.signal.aborted){limit={kind,value};controller.abort('deadline');}};
 const timer=access.kind==='claude-code'?undefined:setTimeout(()=>atLimit('absolute',request.timeoutMs??TOUCHUP_TIMEOUT_MS),request.timeoutMs??TOUCHUP_TIMEOUT_MS);
 let idleTimer:NodeJS.Timeout|undefined;
 const activity=()=>{if(access.kind==='claude-code')return;clearTimeout(idleTimer);idleTimer=setTimeout(()=>atLimit('inactivity',request.inactivityMs??TOUCHUP_INACTIVITY_MS),request.inactivityMs??TOUCHUP_INACTIVITY_MS);};
 activity();
 const progress=(p:TouchupProgress)=>{activity();onProgress?.(p);};
 const base=()=>({seconds:Math.round((Date.now()-started)/1000),stderrTail:'',toolCalls:0,exitCode:0});
 try {
  controller.signal.throwIfAborted();
  if(access.kind==='none')throw Error('AI is off. Choose a provider in Settings.');
  if(access.kind==='api'||access.kind==='endpoint'){
   const run=await runApi(request,options,controller.signal,progress);
   const sanitize=(v:unknown):unknown=>typeof v==='string'?redact(v):Array.isArray(v)?v.map(sanitize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,sanitize(x)])):v;
   return sanitize(run) as Omit<WorkerRun,'publicText'>;
  }
  const work=await mkdtemp(join(tmpdir(),'stm-project-native-'));
  let authCopy:{source:string;sourceSha:string;copySha:string}|undefined;
  try {
   const home=join(work,'home'),codex=join(work,'codex'),tmp=join(work,'tmp');
   await Promise.all([home,codex,tmp].map(path=>mkdir(path,{mode:0o700})));
   const plan=aiTweakInternals.plan(access,options,join(work,'bin'),tmp,codex,home);
   const mcpConfig:TouchupInvocation['mcpConfig']={mcpServers:Object.fromEntries(await Promise.all(Object.entries(request.mcpConfig.mcpServers).map(async([name,entry])=>[name,await isolatedMcp(entry,work,options.env)] as const)))};
   const mcpPath=join(work,'mcp.json');await writeFile(mcpPath,JSON.stringify(mcpConfig),{mode:0o600});
   if(access.kind==='claude-code'){
    const args=[...request.args];args[args.indexOf('--mcp-config')+1]=mcpPath;
    const inv={command:plan.executable,args,env:plan.env,cwd:request.cwd,mcpConfig,mcpConfigPath:mcpPath};
    const {publicText:_redact,...run}=await runClaudeWorker(inv,{signal:controller.signal,maxToolCalls:request.maxToolCalls,timeoutMs:request.timeoutMs,inactivityMs:request.inactivityMs,onProgress});
    return run;
   }
   if(plan.codexAuth){
    const bytes=await readFile(plan.codexAuth).catch(()=>{throw Error('Codex login is missing. Sign in to Codex on this Mac, then retry.');});
    const digest=createHash('sha256').update(bytes).digest('hex');authCopy={source:plan.codexAuth,sourceSha:digest,copySha:digest};
    await writeFile(join(codex,'auth.json'),bytes,{mode:0o600});
   }
   let config=plan.codexConfig!+'\n';
   for(const [name,entry] of Object.entries(mcpConfig.mcpServers)){
    config+=`[mcp_servers.${JSON.stringify(name)}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\nstartup_timeout_sec = 120\ntool_timeout_sec = 120\n`;
    // The pass's tool set (its --disallowedTools): Codex takes tool names, so read the server's catalog once.
    const blocked=await blockedTools(request.args,name,entry,controller.signal);
    if(blocked.length)config+=`disabled_tools = ${JSON.stringify(blocked)}\n`;
   }
   // All modeling goes through the same MCP; no shell execution, hooks, user skills or connectors.
   config+='\n[tools]\n';
   await writeFile(join(codex,'config.toml'),config,{mode:0o600});
   const schema=JSON.parse(value(request.args,'--json-schema')??'{}');
   const prompt=`${value(request.args,'--append-system-prompt')??''}\n\n${request.args.at(-1)}\n\nReturn only a JSON object matching this schema: ${JSON.stringify(schema)}`;
   const last=join(work,'last.json');
   const args=plan.args(last,prompt);
   // Sealed HOME and CODEX_HOME keep the user's MCPs, instructions and hooks out.
   args.push('--ephemeral','--ignore-rules','-c','features.shell_tool=false');
   const child=spawn(plan.executable,args,{cwd:request.cwd,env:plan.env,detached:true,stdio:['ignore','pipe','pipe']});
   let calls=0,bytes=0,tail='',partial='',stopped:string|undefined;
   let killTimer:NodeJS.Timeout|undefined;
   const stop=(reason:string)=>{if(stopped)return;stopped=reason;if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},3000);}};
   const cancel=()=>stop(limit ? limitWords(limit) : 'cancelled');
   controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();
   child.stdout.on('data',chunk=>{
    bytes+=chunk.length;if(bytes>8*1024*1024){stop('worker output limit exceeded');return;}
    partial+=String(chunk);const lines=partial.split('\n');partial=lines.pop()!;
    for(const line of lines){try{
     const event=JSON.parse(line),item=event.item;activity();
     if(event.type==='item.completed'&&['mcp_tool_call','command_execution','web_search'].includes(item?.type)){
      calls++;onProgress?.({seconds:Math.round((Date.now()-started)/1000),toolCalls:calls,activity:[{atMs:Date.now(),kind:'tool',text:redact(item.tool??item.type)}]});
     }else if(event.type==='item.completed'&&item?.type==='agent_message'&&typeof item.text==='string')onProgress?.({seconds:Math.round((Date.now()-started)/1000),toolCalls:calls,activity:[{atMs:Date.now(),kind:'message',text:redact(item.text)}]});
    }catch{}}
    if(calls>(request.maxToolCalls??TOUCHUP_MAX_TOOL_CALLS))atLimit('tool-calls',request.maxToolCalls??TOUCHUP_MAX_TOOL_CALLS);
   });
   child.stderr.on('data',chunk=>tail=(tail+String(chunk)).slice(-2000));
   try {
    const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
    let answer;try{answer=JSON.parse(await readFile(last,'utf8'));}catch{}
    return {...base(),toolCalls:calls,exitCode:code,stderrTail:redact(tail),...(stopped?{stopReason:stopped}:{}),...(limit?{limit}:{}),
     worker:{model:access.model??'gpt-6-astra',tools:['MCP','view_image'],plugins:[],mcpServers:Object.keys(mcpConfig.mcpServers)},
     resultEvent:answer?{structured_output:answer}:{is_error:true,result:'Codex did not return a valid project result. Check its login and model capabilities.'}};
   } finally {
    controller.signal.removeEventListener('abort',cancel);if(killTimer)clearTimeout(killTimer);
    if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
   }
  } finally {
   if(authCopy)await aiTweakInternals.returnCodexAuth(authCopy,join(work,'codex','auth.json')).catch(()=>undefined);
   await rm(work,{recursive:true,force:true});
  }
 } catch(error) {
  if(error instanceof ProviderLimitError)limit=error.limit;
  return {...base(),exitCode:1,...(limit?{limit,stopReason:limitWords(limit)}:controller.signal.aborted?{stopReason:'cancelled'}:{}),resultEvent:{is_error:true,result:redact(error instanceof Error?error.message:'The selected AI provider failed.')}};
 } finally {clearTimeout(timer);clearTimeout(idleTimer);signal?.removeEventListener('abort',abort);}
}

/** The tools of `server` that the request's --disallowedTools takes away, by name, from the server's own catalog. */
async function blockedTools(args:string[],server:string,entry:McpServerEntry,signal:AbortSignal):Promise<string[]>{
 if(!args.includes('--disallowedTools'))return [];
 const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:entry});
 try{return (await client.connect(signal)).tools.map(tool=>tool.name).filter(tool=>toolBlocked(args,server,tool));}
 finally{await client.close().catch(()=>undefined);}
}

class ProviderLimitError extends Error {constructor(readonly limit:WorkerLimit){super(limitWords(limit));}}
type Block={type:string;text?:string;data?:string;mimeType?:string};
type Tool={name:string;description?:string;inputSchema:Record<string,unknown>};
async function runApi(request:Request,options:AiTweakOptions,signal:AbortSignal,onProgress?:(progress:TouchupProgress)=>void):Promise<Omit<WorkerRun,'publicText'>> {
 const access=options.access;if(access.kind!=='api'&&access.kind!=='endpoint')throw Error('API access required');
 const anthropic=access.kind==='api'&&access.provider==='anthropic';
 const key=access.keyEnv?options.env?.[access.keyEnv]??process.env[access.keyEnv]:undefined;
 if(access.keyEnv&&!key)throw Error('API key unavailable. Save the key again in AI Settings.');
 const endpoint=access.kind==='endpoint'?access.url:anthropic?'https://api.anthropic.com/v1':'https://api.openai.com/v1';
 const url=endpoint.replace(/\/$/,'')+(anthropic?'/messages':'/chat/completions');
 const privateDir=await mkdtemp(join(tmpdir(),'stm-api-mcp-'));
 const clients=new Map<string,PrinterMcpClient>(),dispatch=new Map<string,{client:PrinterMcpClient;name:string}>();
 const tools:Tool[]=[],started=Date.now();let calls=0;
 const schema=JSON.parse(value(request.args,'--json-schema')??'{}');
 const system=`${value(request.args,'--append-system-prompt')??''}\nUse finish to return your result. If a site requires an authenticated browser, ask the person to add the original file; do not fabricate a download.`;
 try {
  for(const [name,entry] of Object.entries(request.mcpConfig.mcpServers)){
   const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:await isolatedMcp(entry,privateDir,options.env)});clients.set(name,client);
   const catalog=await client.connect(signal);
   for(const tool of catalog.tools){if(toolBlocked(request.args,name,tool.name))continue;const id=`mcp_${name}_${tool.name}`;tools.push({name:id,description:tool.description,inputSchema:tool.inputSchema});dispatch.set(id,{client,name:tool.name});}
  }
  if(!request.args.includes('--tools')||value(request.args,'--tools')!=='')tools.push({name:'read_file',description:'Read a project file, including images. Paths must be inside the pass folder.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}},
   {name:'fetch_url',description:'Read a public web page, or download an original STL/3MF into the project output folder.',inputSchema:{type:'object',properties:{url:{type:'string'},filename:{type:'string'}},required:['url']}});
  tools.push({name:'finish',description:'Return the final structured project result.',inputSchema:schema});
  const image=(b:Block)=>anthropic?{type:'image',source:{type:'base64',media_type:b.mimeType,data:b.data}}:{type:'image_url',image_url:{url:`data:${b.mimeType};base64,${b.data}`}};
  const messages:any[]=[...(anthropic?[]:[{role:'system',content:system}]),{role:'user',content:request.args.at(-1)}];
  const invoke=async(name:string,args:Record<string,unknown>):Promise<Block[]>=>{
   if(name==='read_file'){
    const path=await realpath(resolve(request.cwd,String(args.path))),root=await realpath(request.cwd);
    if(!path.startsWith(root+sep))throw Error('Read only files in this project pass.');
    if((await stat(path)).size>12*1024*1024)throw Error('File exceeds the 12 MB model input limit.');
    const data=await readFile(path),mime:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
    return mime[extname(path).toLowerCase()]?[{type:'image',data:data.toString('base64'),mimeType:mime[extname(path).toLowerCase()]}]:[textBlock(data.toString('utf8'))];
   }
   if(name==='fetch_url'){
    const target=new URL(String(args.url));if(!['https:','http:'].includes(target.protocol)||target.username||target.password)throw Error('Use a public HTTP URL.');
    const reply=await fetch(target,{signal,redirect:'error'});if(!reply.ok)throw Error(`Page returned HTTP ${reply.status}. Ask the person to add the original file if login is required.`);
    const bytes=await limitedBody(reply,32*1024*1024);
    if(args.filename){const filename=String(args.filename);if(!/^[A-Za-z0-9 _.-]+\.(stl|3mf)$/i.test(filename))throw Error('Use a simple STL or 3MF filename.');await writeFile(join(request.cwd,'out',filename),bytes,{flag:'wx',mode:0o600});return [textBlock(`Saved out/${filename}`)];}
    return [textBlock(bytes.toString('utf8').slice(0,100000))];
   }
   const tool=dispatch.get(name);if(!tool)throw Error('Unknown tool');
   const result=await tool.client.callTool(tool.name,args,{signal,timeoutMs:120000});
   const blocks=(result.content??[]).filter((b:any)=>b.type==='text'||b.type==='image') as Block[];
   // MCP tools can put their warnings/data only in structuredContent. Both API
   // dialects need it in the tool reply alongside the existing text and images.
   if(result.structuredContent!==undefined)blocks.push(textBlock(`Structured result:\n${JSON.stringify(result.structuredContent)}`));
   return blocks;
  };
  for(;;){
   signal.throwIfAborted();
   const body=anthropic?{model:access.model,max_tokens:8192,system,messages,tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema}))}
    :{model:access.model,messages,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}))};
   const response=await fetch(url,{method:'POST',signal,redirect:'error',headers:{'content-type':'application/json',...(anthropic?{'x-api-key':key!,'anthropic-version':'2023-06-01'}:key?{authorization:`Bearer ${key}`}:{})},body:JSON.stringify(body)});
   if(!response.ok){await response.body?.cancel();throw Error(`Selected model returned HTTP ${response.status}. Check the endpoint, API key and model; this job needs tool calling and image support. No other provider was used.`);}
   const result=JSON.parse((await limitedBody(response,8*1024*1024)).toString('utf8'));
   const message=anthropic?{role:'assistant',content:result.content}:result.choices?.[0]?.message;
   if(!message)throw Error('Selected endpoint did not return a compatible model response. Use a model with tool calling and images.');
   messages.push(message);
   const uses=anthropic?(result.content??[]).filter((b:any)=>b.type==='tool_use').map((b:any)=>({id:b.id,name:b.name,args:b.input}))
    :(message.tool_calls??[]).map((b:any)=>({id:b.id,name:b.function.name,args:JSON.parse(b.function.arguments)}));
   if(!uses.length)throw Error('Selected model did not use the required finish tool. Select a model with tool calling and image support.');
   const replies:any[]=[];const images:any[]=[];
   for(const use of uses){
    if(++calls>(request.maxToolCalls??TOUCHUP_MAX_TOOL_CALLS))throw new ProviderLimitError({kind:'tool-calls',value:request.maxToolCalls??TOUCHUP_MAX_TOOL_CALLS});
    onProgress?.({seconds:Math.round((Date.now()-started)/1000),toolCalls:calls,activity:[{atMs:Date.now(),kind:'tool',text:publicTouchupText(String(use.name),options.env)}]});
    if(use.name==='finish')return {seconds:Math.round((Date.now()-started)/1000),toolCalls:calls,exitCode:0,stderrTail:'',resultEvent:{structured_output:use.args},worker:{model:access.model,tools:tools.map(t=>t.name),plugins:[],mcpServers:[...clients.keys()]}};
    let blocks:Block[];try{blocks=await invoke(use.name,use.args);}catch(e){signal.throwIfAborted();blocks=[textBlock(`Tool failed: ${e instanceof Error?e.message:'unknown error'}`)];}
    if(anthropic)replies.push({type:'tool_result',tool_use_id:use.id,content:blocks.map(b=>b.type==='image'?image(b):textBlock(b.text??''))});
    else {messages.push({role:'tool',tool_call_id:use.id,content:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'Image attached in the next user message.'});images.push(...blocks.filter(b=>b.type==='image').map(image));}
   }
   if(anthropic)messages.push({role:'user',content:replies});else if(images.length)messages.push({role:'user',content:[textBlock('Images returned by the preceding tools:'),...images]});
  }
 } finally {await Promise.all([...clients.values()].map(c=>c.close().catch(()=>undefined)));await rm(privateDir,{recursive:true,force:true});}
}
async function limitedBody(response:Response,limit:number):Promise<Buffer>{
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Model response exceeded the byte limit.');chunks.push(value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks);
}
