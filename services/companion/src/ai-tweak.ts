import {ModelAccessEnvironment as accessEnv} from '@scan-to-make/contracts/model-access';
import {execFile,spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream,type WriteStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,mkdtemp,open,readdir,readFile,realpath,rename,rm,rmdir,stat,writeFile} from 'node:fs/promises';
import {homedir,tmpdir,userInfo} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {materialLibrary,meshTextLines,textureMap} from './mesh-materials.js';

/** David's sentence (KAN-177). The only prompt text an attempt ever receives. */
export const AI_TWEAK_PROMPT='Look at the pictures of this, and then tweak the scan based on that.';
export const AI_TWEAK_SCHEMA='scan-to-make.ai-tweak/0.1';
const CHECK_PROMPT='Reply with the single word OK.';

/** The companion's one model setting (journey.md §3.6). Secrets are referenced by env-var name, never stored. */
export type ModelAccess=
 |{kind:'none'}
 |{kind:'claude-code';model?:string}
 |{kind:'codex-cli';model?:string;reasoningEffort?:string}
 |{kind:'api';provider:'anthropic'|'openai';model?:string;reasoningEffort?:string;keyEnv:string}
 /** Any server speaking the OpenAI Responses API (Codex 0.166 dropped chat completions), run through Codex. */
 |{kind:'endpoint';url:string;model:string;keyEnv?:string;reasoningEffort?:string};

export interface AiTweakInput {
 /** Absolute path to the textured OBJ; its MTL and texture files are copied with it. */
 mesh:string;
 /** Optional original capture, offered to the agent as original.usdz. */
 usdz?:string;
 /** Absolute paths to close-up photos (JPEG, PNG, WebP or HEIC). */
 stills:string[];
}

export interface AiTweakOptions {
 access:ModelAccess;
 attempts?:number;
 /** Per-attempt wall clock, at most 30 minutes. */
 timeoutMs?:number;
 concurrency?:number;
 claudePath?:string;
 codexPath?:string;
 /** The login shell's PATH when the CLI was found only there; appended so its runtime (nvm's node, say) resolves. */
 searchPath?:string;
 /** Blender binary exposed to the agent as `blender` on PATH. */
 blender?:string;
 /** Python with Pillow (and pillow-heif for HEIC); its bin directory is also on the agent's PATH. */
 python?:string;
 /** Source of HOME, USER and the env var named by keyEnv. Never copied wholesale into a child. */
 env?:NodeJS.ProcessEnv;
 codexAuthSource?:string;
 claudeProjectsDir?:string;
 /** Claude Code reads its login from the login keychain, which only a GUI (Aqua) session can open. */
 requireGuiSession?:boolean;
 signal?:AbortSignal;
 keepWorkspaces?:boolean;
 workspaceLimitBytes?:number;
 workspaceLimitFiles?:number;
 logLimitBytes?:number;
}

export type AttemptOutcome='changed'|'unchanged'|'other-format-only'|'invalid-output'|'failed'|'auth-failed'|'needs-gui-session'|'timed-out'|'cancelled';

export interface FileRef {sha256:string;bytes:number}
export interface AttemptResult {
 index:number; cli:'claude'|'codex'; cliVersion?:string; startedAt:string; wallMs:number;
 exitCode:number|null; signal:string|null; outcome:AttemptOutcome; reason?:string;
 inputsModified:string[];
 /** Present when a changed OBJ bundle was collected: paths are relative to the manifest directory. */
 result?:{dir:string;obj:string;sourcePath:string;files:Record<string,FileRef>};
 alternates:string[]; otherOutputs:string[];
 finalMessage?:string;
 usage?:Record<string,unknown>;
 seal:Record<string,unknown>;
 logs:Record<string,string>;
 auth?:{refreshed:boolean;writtenBack:boolean;conflict:boolean};
}
export interface AiTweakManifest {
 schema:typeof AI_TWEAK_SCHEMA; prompt:string; access:Record<string,unknown>; skipped?:'access-none';
 /** One tiny sealed call made before parallel Codex attempts, so a sign-in refresh happens once. */
 warmup?:{outcome:AttemptOutcome;auth?:AttemptResult['auth']};
 inputs:Record<string,FileRef>; attempts:AttemptResult[];
}

const run=promisify(execFile);
const MODEL=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EFFORT=/^(minimal|low|medium|high|xhigh|max)$/;
const ENV_NAME=/^[A-Z_][A-Z0-9_]{0,127}$/;
const SAFE_NAME=/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const MESH_EXT=/\.(glb|gltf|usdz|usd|usdc|usda|ply|stl|fbx|3mf)$/i;
const AUTH_FAILURE=/not logged in|please run \/login|invalid api key|invalid x-api-key|authentication_error|unauthorized|\b401\b|login required|please log in|no auth credentials|sign in again|token (?:is )?expired/i;
const DEFAULT_TIMEOUT=1800000;

const sha256File=(path:string)=>new Promise<string>((ok,fail)=>{
 const hash=createHash('sha256');createReadStream(path).on('error',fail).on('data',chunk=>hash.update(chunk)).on('end',()=>ok(hash.digest('hex')));
});
const fileRef=async(path:string):Promise<FileRef>=>({sha256:await sha256File(path),bytes:(await stat(path)).size});

/** Parse the operator/Mac-app environment contract; unknown or partial settings fail closed. */
export function modelAccessFromEnv(env:NodeJS.ProcessEnv=process.env):ModelAccess{
 const kind=env[accessEnv.kind]??'none',model=env[accessEnv.model]||undefined,effort=env[accessEnv.effort]||undefined;
 let access:ModelAccess;
 if(kind==='none')access={kind};
 else if(kind==='claude-code')access={kind,model};
 else if(kind==='codex-cli')access={kind,model,reasoningEffort:effort};
 else if(kind==='api')access={kind,provider:env[accessEnv.provider] as 'anthropic'|'openai',model,reasoningEffort:effort,keyEnv:env[accessEnv.keyName]??''};
 else if(kind==='endpoint')access={kind,url:env[accessEnv.endpoint]??'',model:model??'',keyEnv:env[accessEnv.keyName]||undefined,reasoningEffort:effort};
 else throw Error('Invalid SCAN_TO_MAKE_AI_ACCESS');
 validateAccess(access);return access;
}

export function validateAccess(access:ModelAccess){
 const fail=()=>{throw Error('Invalid model access');};
 if('model' in access&&access.model!==undefined&&!MODEL.test(access.model))fail();
 if('reasoningEffort' in access&&access.reasoningEffort!==undefined&&!EFFORT.test(access.reasoningEffort))fail();
 if(access.kind==='api'){if(!['anthropic','openai'].includes(access.provider)||!ENV_NAME.test(access.keyEnv))fail();}
 else if(access.kind==='endpoint'){
  let url:URL;try{url=new URL(access.url);}catch{return fail();}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!MODEL.test(access.model))fail();
  if(access.keyEnv!==undefined&&!ENV_NAME.test(access.keyEnv))fail();
 }else if(!['none','claude-code','codex-cli'].includes(access.kind))fail();
}

/** What the manifest may record about access: kind, provider, model, endpoint host; never a key. */
function describeAccess(access:ModelAccess):Record<string,unknown>{
 if(access.kind==='endpoint')return {kind:access.kind,host:new URL(access.url).host,model:access.model,keyEnv:access.keyEnv};
 return {...access};
}

const cliFor=(access:ModelAccess)=>access.kind==='claude-code'||access.kind==='api'&&access.provider==='anthropic'?'claude':'codex';

interface Plan {cli:'claude'|'codex';executable:string;args(lastMessage:string,prompt:string):string[];env:Record<string,string>;codexConfig?:string;codexAuth?:string}

function plan(access:Exclude<ModelAccess,{kind:'none'}>,options:AiTweakOptions,binDir:string,tmp:string,codexHome:string,privateHome:string):Plan{
 const source=options.env??process.env,home=source.HOME||homedir();
 const cli=cliFor(access),executable=cli==='claude'?options.claudePath:options.codexPath;
 if(!executable||!isAbsolute(executable))throw Error(`No absolute ${cli} executable configured`);
 const path=[binDir,dirname(executable),...(options.python&&isAbsolute(options.python)?[dirname(options.python)]:[]),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin',
  ...(options.searchPath??'').split(':').filter(dir=>isAbsolute(dir))];
 // Built from scratch: an inherited ANTHROPIC_API_KEY would silently move a subscription run onto API billing.
 const env:Record<string,string>={HOME:home,PATH:[...new Set(path)].join(':'),TMPDIR:tmp+sep,LANG:source.LANG||'en_US.UTF-8',SHELL:source.SHELL||'/bin/zsh'};
 // The user's own sign-in location; a custom Claude config dir also names its keychain entry.
 for(const name of ['USER','LOGNAME','CLAUDE_CONFIG_DIR'] as const)if(source[name])env[name]=source[name]!;
 // Claude Code finds its keychain login by account name. A launchd agent's environment has no USER
 // (KAN-199: "Not logged in" while David was signed in), so take it from the account database.
 const account=accountName();
 if(account){env.USER??=account;env.LOGNAME??=account;}
 const key=(name:string)=>{const value=source[name];if(!value)throw new AccessFailure(`Key variable ${name} is empty`);return value;};
 if(cli==='claude'){
  Object.assign(env,{CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'});
  if(access.kind==='api')env.ANTHROPIC_API_KEY=key(access.keyEnv);
  const model=('model' in access&&access.model)||'claude-opus-5-5';
  const settings=JSON.stringify({disableAllHooks:true,autoMemoryEnabled:false,enabledPlugins:{}});
  return {cli,executable,env,args:(_last,prompt)=>['-p',prompt,'--model',model,'--dangerously-skip-permissions','--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--output-format','stream-json','--verbose']};
 }
 env.CODEX_HOME=codexHome;
 // Codex also finds user skills and shell profiles through HOME (~/.agents/skills, ~/.zprofile); its sign-in is copied, so HOME can be private.
 env.HOME=privateHome;
 const toml=(value:string)=>JSON.stringify(value);
 const lines:string[]=[];
 const model=('model' in access&&access.model)||'gpt-6-astra',effort=('reasoningEffort' in access&&access.reasoningEffort)||(access.kind==='endpoint'?undefined:'xhigh');
 lines.push(`model = ${toml(model)}`);if(effort)lines.push(`model_reasoning_effort = ${toml(effort)}`);
 let codexAuth:string|undefined;
 if(access.kind==='codex-cli')codexAuth=options.codexAuthSource??join(source.CODEX_HOME||join(home,'.codex'),'auth.json');
 else if(access.kind==='api')env.CODEX_API_KEY=key(access.keyEnv);
 else if(access.kind==='endpoint'){
  lines.push('model_provider = "scan-to-make"');
  if(access.keyEnv)env.SCAN_TO_MAKE_AI_KEY=key(access.keyEnv);
  lines.push('','[model_providers.scan-to-make]','name = "Scan to Make endpoint"',`base_url = ${toml(access.url)}`,'wire_api = "responses"');
  if(access.keyEnv)lines.push('env_key = "SCAN_TO_MAKE_AI_KEY"');
 }
 // Off: the user's ChatGPT connectors, plugins and memories. Codex's built-in system skills remain.
 lines.push('','[features]','apps = false','plugins = false','remote_plugin = false','plugin_discovery_prefetch = false','memories = false','');
 return {cli,executable,env,codexConfig:lines.join('\n'),codexAuth,
  args:(last,prompt)=>['exec',prompt,'--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--json','-o',last]};
}
class AccessFailure extends Error {}

function accountName(){try{return userInfo().username||undefined;}catch{return undefined;}}

/**
 * T3 Code's rule for Claude's init capabilities, applied to `claude auth status`: signed in through
 * another provider, a token, a key, an email or a subscription. Only an explicit "no" counts as signed out.
 */
export function claudeSignedIn(stdout:string):boolean|undefined{
 let status:Record<string,unknown>;
 try{const value:unknown=JSON.parse(stdout.trim());if(!value||typeof value!=='object'||Array.isArray(value))return undefined;status=value as Record<string,unknown>;}
 catch{return undefined;}
 const set=(name:string)=>typeof status[name]==='string'&&status[name]!==''&&status[name]!=='none';
 if(set('apiProvider')&&status.apiProvider!=='firstParty')return true;
 if(status.loggedIn===true||set('authMethod')||set('tokenSource')||set('apiKeySource')||set('email')||set('subscriptionType'))return true;
 return status.loggedIn===false?false:undefined;
}

/** The subscription CLI's own sign-in report, read with the sealed run's environment before any prompt. */
async function signedIn(p:Plan,access:Exclude<ModelAccess,{kind:'none'}>,cwd:string):Promise<boolean|undefined>{
 if(access.kind==='claude-code'){
  const out=await run(p.executable,['auth','status'],{cwd,env:p.env,timeout:20000,maxBuffer:64*1024}).then(r=>r.stdout,(e:{stdout?:string})=>e.stdout??'');
  return claudeSignedIn(out);
 }
 if(access.kind==='codex-cli'){
  return run(p.executable,['login','status'],{cwd,env:p.env,timeout:20000,maxBuffer:64*1024}).then(()=>true,
   (e:{code?:unknown;stdout?:string;stderr?:string})=>e.code===1&&/not logged in/i.test(`${e.stdout??''}${e.stderr??''}`)?false:undefined);
 }
 return undefined;
}

/** Claude Code's keychain login is unreadable from SSH/background sessions (KAN-177). */
export async function inGuiSession():Promise<boolean>{
 if(process.platform!=='darwin')return true;
 try{return (await run('launchctl',['managername'],{timeout:5000})).stdout.trim()==='Aqua';}catch{return false;}
}

// ---- inputs ---------------------------------------------------------------------------------

interface ObjBundle {obj:string;files:string[];missing:string[];escaped:boolean;absolute:{from:string;raw:string;target:string}[]}

/**
 * Resolve an OBJ's mtllib and texture references. Every path must stay inside `root` with no symlink in
 * any component. Absolute references are recorded so a copied bundle can be made relative.
 */
async function objBundle(root:string,obj:string,limit=64):Promise<ObjBundle>{
 const files=[obj],missing:string[]=[],absolute:ObjBundle['absolute']=[];let escaped=false;
 const rootReal=await realpath(root);
 const inside=(path:string)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
 // The real path must equal the lexical one: a symlinked directory anywhere on the way would escape.
 const unlinked=async(path:string)=>{try{return (await realpath(path))===join(rootReal,relative(root,path));}catch{return false;}};
 if(!inside(obj)||!(await unlinked(obj)))return {obj,files,missing,escaped:true,absolute};
 // An agent's absolute paths come from its real cwd (macOS: /private/var/... for /var/...).
 const lexical=(path:string)=>path===rootReal||path.startsWith(rootReal+sep)?join(root,relative(rootReal,path)):path;
 const reference=async(from:string,name:string)=>{
  const raw=name.replace(/\\/g,'/'),target=lexical(resolve(dirname(from),raw));
  if(!inside(target)){escaped=true;return undefined;}
  try{const info=await lstat(target);if(!info.isFile()){missing.push(relative(root,target));return undefined;}}
  catch{missing.push(relative(root,target));return undefined;}
  if(!(await unlinked(target))){escaped=true;return undefined;}
  if(isAbsolute(raw))absolute.push({from,raw:name,target});
  if(!files.includes(target)){if(files.length>=limit){escaped=true;return undefined;}files.push(target);}
  return target;
 };
 // A file too large to read for references is an invalid bundle, never a texture-less valid one.
 if((await stat(obj)).size>256*1024*1024)return {obj,files,missing,escaped:true,absolute};
 // Same line and name rules as the converter check in capture-import (mesh-materials.ts).
 for(const line of meshTextLines(await readFile(obj))){
  const name=materialLibrary(line);if(name===undefined)continue;
  if(!name){escaped=true;continue;}
  const mtl=await reference(obj,name);if(!mtl)continue;
  if((await stat(mtl)).size>4*1024*1024){escaped=true;continue;}
  for(const entry of meshTextLines(await readFile(mtl))){
   if(!/^(map_\w+|bump|disp|decal|refl|norm)\s/i.test(entry))continue;
   // Options such as `-clamp off` or `-bm 1.0` precede a filename that may contain spaces.
   const map=textureMap(entry);if(!map){escaped=true;continue;}
   await reference(mtl,map.file);
  }
 }
 return {obj,files,missing,escaped,absolute};
}

/** Copy a bundle under `dest`, keeping layout relative to `base` and rewriting absolute references. */
async function copyBundle(bundle:ObjBundle,base:string,dest:string){
 const target=(path:string)=>join(dest,relative(base,path));
 for(const path of bundle.files){
  await mkdir(dirname(target(path)),{recursive:true,mode:0o700});await copyFile(path,target(path));
  const refs=bundle.absolute.filter(ref=>ref.from===path);
  if(!refs.length)continue;
  let text=await readFile(target(path),'utf8');
  for(const ref of refs)text=text.split(ref.raw).join(relative(dirname(target(path)),target(ref.target)).split(sep).join('/'));
  await writeFile(target(path),text);
 }
}

/** Pristine inputs: the mesh bundle by its own names, the capture, and upright full-resolution JPEG stills. */
async function prepareInputs(input:AiTweakInput,dir:string,python:string,home:string,signal?:AbortSignal){
 if(!isAbsolute(input.mesh)||!input.mesh.toLowerCase().endsWith('.obj'))throw Error('Mesh must be an absolute OBJ path');
 if(input.usdz!==undefined&&!isAbsolute(input.usdz))throw Error('USDZ must be absolute');
 if(input.stills.length>64||input.stills.some(path=>!isAbsolute(path)))throw Error('Stills must be absolute paths (at most 64)');
 await mkdir(dir,{mode:0o700});
 const meshRoot=dirname(input.mesh),bundle=await objBundle(meshRoot,input.mesh);
 if(bundle.escaped||bundle.missing.length)throw Error('Mesh bundle references missing, outside or oversized files');
 for(const file of bundle.files)if(!relative(meshRoot,file).split(sep).every(part=>SAFE_NAME.test(part)))throw Error('Unsupported mesh bundle filename');
 await copyBundle(bundle,meshRoot,dir);
 if(input.usdz)await copyFile(input.usdz,join(dir,'original.usdz'));
 if(input.stills.length){
  const helper=fileURLToPath(new URL('../python/ai_tweak_stills.py',import.meta.url));
  // Not -I: it implies -s, and a Pillow installed with `pip install --user` lives in the user site.
  // -E ignores PYTHON* variables and -P keeps the script directory off sys.path; the real HOME locates the user site.
  const args=['-E','-P',helper,'--out',dir];
  for(const [index,path] of input.stills.entries()){
   const name=`still_${String(index).padStart(2,'0')}_${(await sha256File(path)).slice(0,8)}.jpg`;args.push('--still',path,name);
  }
  await run(python,args,{timeout:300000,signal,maxBuffer:1024*1024,env:{PATH:'/usr/bin:/bin',HOME:home}});
 }
 const inputs:Record<string,FileRef>={};
 for(const name of await listFiles(dir))inputs[name]=await fileRef(join(dir,name));
 return {inputs,obj:relative(meshRoot,input.mesh)};
}

async function listFiles(root:string,prefix=''):Promise<string[]>{
 const out:string[]=[];
 for(const entry of (await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const rel=prefix?join(prefix,entry.name):entry.name;
  if(entry.isDirectory())out.push(...await listFiles(root,rel));else if(entry.isFile())out.push(rel);
 }
 return out;
}

// ---- process supervision ---------------------------------------------------------------------

interface ProcessRow {pid:number;ppid:number;pgid:number}
async function processTable():Promise<ProcessRow[]>{
 const {stdout}=await run('ps',['-A','-o','pid=,ppid=,pgid='],{timeout:5000,maxBuffer:8*1024*1024});
 return stdout.split('\n').map(line=>line.trim().split(/\s+/).map(Number)).filter(r=>r.length===3&&r.every(Number.isSafeInteger)).map(([pid,ppid,pgid])=>({pid:pid!,ppid:ppid!,pgid:pgid!}));
}

/** Processes still carrying this attempt's environment marker, even after reparenting to launchd/init. */
async function markedProcesses(marker:string):Promise<Set<number>>{
 const found=new Set<number>();
 if(process.platform==='linux'){
  let entries:string[]=[];try{entries=await readdir('/proc');}catch{return found;}
  for(const entry of entries){
   if(!/^\d+$/.test(entry))continue;
   try{if((await readFile(`/proc/${entry}/environ`)).includes(marker))found.add(Number(entry));}catch{/* exited or not ours */}
  }
 }else{
  try{
   // `ps -E` appends the environment of the caller's own processes to the command column.
   const {stdout}=await run('ps',['-A','-E','-ww','-o','pid=,command='],{timeout:10000,maxBuffer:128*1024*1024});
   for(const line of stdout.split('\n'))if(line.includes(marker)){const pid=Number(line.trim().split(/\s+/,1)[0]);if(Number.isSafeInteger(pid))found.add(pid);}
  }catch{/* fall back to the process tree */}
 }
 found.delete(process.pid);return found;
}

/**
 * Tracks every descendant of a detached CLI, including workers that call setsid (Codex shells,
 * Blender), so none outlive the attempt: by parent links while it runs, and by an environment
 * marker every descendant inherits. Tree pids are killed only if their process group is unchanged.
 */
class Descendants {
 private seen=new Map<number,number>();
 constructor(private root:number,private marker:string){this.seen.set(root,root);}
 async poll(){
  let rows:ProcessRow[];try{rows=await processTable();}catch{return;}
  const children=new Map<number,ProcessRow[]>();for(const row of rows){const list=children.get(row.ppid)??[];list.push(row);children.set(row.ppid,list);}
  const queue=[...this.seen.keys()];
  while(queue.length){
   const pid=queue.pop()!;
   for(const child of children.get(pid)??[])if(!this.seen.has(child.pid)&&child.pid!==process.pid){this.seen.set(child.pid,child.pgid);queue.push(child.pid);}
  }
  // A worker whose parent exited is reparented; its group still identifies it.
  for(const row of rows)if(!this.seen.has(row.pid)&&row.pid!==process.pid&&[...this.seen.values()].includes(row.pgid)&&row.pgid!==process.pid)this.seen.set(row.pid,row.pgid);
 }
 async kill(signal:NodeJS.Signals){
  await this.poll();
  let rows:ProcessRow[]=[];try{rows=await processTable();}catch{/* fall back to the group signal below */}
  const live=new Map(rows.map(row=>[row.pid,row.pgid]));
  try{process.kill(-this.root,signal);}catch{/* group gone */}
  for(const [pid,pgid] of this.seen){
   if(pid<=1||pid===process.pid||live.get(pid)!==pgid)continue;
   try{process.kill(pid,signal);}catch{/* gone */}
  }
  for(const pid of await markedProcesses(this.marker))if(pid>1){try{process.kill(pid,signal);}catch{/* gone */}}
 }
 async alive(){
  let rows:ProcessRow[];try{rows=await processTable();}catch{return false;}
  return rows.some(row=>this.seen.get(row.pid)===row.pgid)||(await markedProcesses(this.marker)).size>0;
 }
}

async function workspaceUsage(root:string,limitFiles:number){
 let bytes=0,files=0;
 const walk=async(path:string):Promise<void>=>{
  let entries;try{entries=await readdir(path,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   if(++files>limitFiles)return;
   const full=join(path,entry.name);
   if(entry.isDirectory())await walk(full);
   else if(entry.isFile()){try{bytes+=(await lstat(full)).size;}catch{/* removed meanwhile */}}
  }
 };
 await walk(root);return {bytes,files};
}

// ---- collection ------------------------------------------------------------------------------

async function walkWorkspace(root:string,limitFiles:number){
 const files:string[]=[];
 const walk=async(dir:string):Promise<void>=>{
  for(const entry of await readdir(dir,{withFileTypes:true})){
   // Hidden folders hold agents' scratch work (.work, .scan_work); symlinks are never followed.
   if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
   const full=join(dir,entry.name);
   if(entry.isDirectory())await walk(full);else if(entry.isFile()){files.push(full);if(files.length>limitFiles)throw Error('Workspace file limit');}
  }
 };
 await walk(root);return files;
}

async function collect(workspace:string,inputs:Record<string,FileRef>,inputObj:string,resultDir:string,limitFiles:number){
 const files=await walkWorkspace(workspace,limitFiles);
 const inputShas=new Map(Object.entries(inputs).map(([name,ref])=>[name,ref.sha256]));
 const inputSignature=[...new Set([inputObj,...Object.keys(inputs).filter(name=>!name.startsWith('still_')&&name!=='original.usdz')])].map(name=>inputShas.get(name)).sort().join();
 const inputsModified:string[]=[];
 for(const [name,sha] of inputShas){
  try{if(await sha256File(join(workspace,name))!==sha)inputsModified.push(name);}catch{inputsModified.push(name);}
 }
 const candidates:{bundle:ObjBundle;mtime:number}[]=[],alternates:string[]=[];let invalid=false;
 for(const file of files.filter(path=>path.toLowerCase().endsWith('.obj'))){
  const bundle=await objBundle(workspace,file);
  if(bundle.escaped||bundle.missing.length){invalid=true;continue;}
  const shas=await Promise.all(bundle.files.map(sha256File));
  if(shas.sort().join()===inputSignature)continue;
  let mtime=0;for(const path of bundle.files)mtime=Math.max(mtime,(await stat(path)).mtimeMs);
  candidates.push({bundle,mtime});
 }
 candidates.sort((a,b)=>b.mtime-a.mtime||a.bundle.obj.length-b.bundle.obj.length);
 const otherOutputs:string[]=[];
 for(const file of files)if(MESH_EXT.test(file)){
  // A copied-but-unchanged input (a backup the agent made) is not an output.
  const digest=await sha256File(file);if([...inputShas.values()].includes(digest))continue;otherOutputs.push(relative(workspace,file));
 }
 const chosen=candidates[0];
 for(const other of candidates.slice(1))alternates.push(relative(workspace,other.bundle.obj));
 if(!chosen)return {inputsModified,alternates,otherOutputs,outcome:(otherOutputs.length?'other-format-only':invalid?'invalid-output':'unchanged') as AttemptOutcome};
 // Preserve relative references by copying from the bundle's common ancestor.
 let common=dirname(chosen.bundle.obj);
 while(!chosen.bundle.files.every(path=>!relative(common,path).startsWith('..')))common=dirname(common);
 const copied:Record<string,FileRef>={};let total=0;
 for(const path of chosen.bundle.files){total+=(await stat(path)).size;if(total>512*1024*1024)throw Error('Result bundle too large');}
 await copyBundle(chosen.bundle,common,resultDir);
 for(const path of chosen.bundle.files){const rel=relative(common,path);copied[rel]=await fileRef(join(resultDir,rel));}
 return {inputsModified,alternates,otherOutputs,outcome:'changed' as AttemptOutcome,
  result:{obj:relative(common,chosen.bundle.obj),sourcePath:relative(workspace,chosen.bundle.obj),files:copied}};
}

// ---- logs and seal evidence ------------------------------------------------------------------

function jsonLines(text:string){const out:Record<string,any>[]=[];for(const line of text.split('\n')){if(!line.trim())continue;try{out.push(JSON.parse(line));}catch{/* partial line */}}return out;}
const clip=(value:unknown,limit=8000)=>typeof value==='string'?value.slice(0,limit):undefined;

function claudeEvidence(transcript:string){
 const events=jsonLines(transcript);
 const init=events.find(e=>e.type==='system'&&e.subtype==='init'),result=[...events].reverse().find(e=>e.type==='result');
 const seal:Record<string,unknown>={sessionId:init?.session_id,model:init?.model,apiKeySource:init?.apiKeySource,
  mcpServers:(init?.mcp_servers??[]).map((s:any)=>s?.name),plugins:(init?.plugins??[]).map((p:any)=>p?.source??p?.name),
  skills:(init?.skills??[]).length,hookEvents:events.filter(e=>e.type==='system'&&String(e.subtype??'').startsWith('hook')).length};
 const usage=result?{durationMs:result.duration_ms,turns:result.num_turns,isError:result.is_error,subtype:result.subtype,usage:result.usage}:undefined;
 return {seal,usage,final:clip(result?.result),failed:Boolean(result?.is_error),text:String(result?.result??'')};
}

async function claudeSession(projects:string,sessionId:unknown,logs:string,seal:Record<string,unknown>,prompt:string){
 if(typeof sessionId!=='string'||!/^[0-9a-f-]{36}$/.test(sessionId))return undefined;
 let dirs:string[];try{dirs=await readdir(projects);}catch{return undefined;}
 for(const dir of dirs){
  const file=join(projects,dir,`${sessionId}.jsonl`);
  try{await lstat(file);}catch{continue;}
  const target=join(logs,'claude-session.jsonl');await copyFile(file,target);
  const events=jsonLines(await readFile(target,'utf8'));
  const attachments=events.filter(e=>e.type==='attachment').map(e=>String(e.attachment?.type));
  const firstUser=events.find(e=>e.type==='user')?.message?.content;
  seal.attachmentTypes=[...new Set(attachments)].sort();
  seal.memoryAttachments=attachments.filter(type=>/memory|claude_?md|nested|rules/i.test(type));
  seal.firstUserMessageIsPrompt=(typeof firstUser==='string'?firstUser:firstUser?.[0]?.text)===prompt;
  // The sealed run's session belongs to Scan to Make's logs, not the user's Claude Code history.
  await rm(file,{force:true});await rmdir(join(projects,dir)).catch(()=>undefined);
  return target;
 }
 return undefined;
}

async function codexEvidence(codexHome:string,stdout:string,logs:string,prompt:string){
 const events=jsonLines(stdout);
 const threadId=events.find(e=>e.type==='thread.started')?.thread_id;
 const usage=[...events].reverse().find(e=>e.type==='turn.completed')?.usage;
 const errors=events.filter(e=>e.type==='error'||e.type==='turn.failed'||e.item?.type==='error').map(e=>JSON.stringify(e).slice(0,500));
 const seal:Record<string,unknown>={threadId};let rollout:string|undefined;
 const find=async(dir:string):Promise<string|undefined>=>{
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return undefined;}
  for(const entry of entries){
   const full=join(dir,entry.name);
   if(entry.isDirectory()){const hit=await find(full);if(hit)return hit;}
   else if(entry.name.endsWith('.jsonl')&&(typeof threadId!=='string'||entry.name.includes(threadId)))return full;
  }
  return undefined;
 };
 const source=await find(join(codexHome,'sessions'));
 if(source){
  rollout=join(logs,'codex-rollout.jsonl');await copyFile(source,rollout);
  const items=jsonLines(await readFile(rollout,'utf8'));
  const context=items.find(e=>e.type==='turn_context')?.payload;
  const messages=items.filter(e=>e.type==='response_item'&&e.payload?.type==='message');
  const texts=(role:string)=>messages.filter(e=>e.payload.role===role).flatMap(e=>(e.payload.content??[]).map((c:any)=>String(c.text??'')));
  Object.assign(seal,{model:context?.model,effort:context?.effort,
   developerMessages:texts('developer').map(t=>t.replace(/\s+/g,' ').slice(0,48)),
   userMessagesArePrompt:texts('user').filter(t=>!t.startsWith('<environment_context>')).every(t=>t===prompt)});
 }
 return {seal,usage,rollout,errors};
}

/** Bounded, ordered write of a child stream to a log file. */
function sink(path:string,limit:number,onOverflow:()=>void,onError:()=>void){
 const stream:WriteStream=createWriteStream(path,{flags:'wx',mode:0o600});let bytes=0,overflow=false,failed=false;
 // An unhandled stream error would end the companion and orphan the detached agent: stop the attempt instead.
 stream.on('error',()=>{if(!failed){failed=true;onError();}});
 return {write(chunk:Buffer){bytes+=chunk.length;if(failed)return;if(bytes>limit){if(!overflow){overflow=true;onOverflow();}return;}stream.write(chunk);},
  close:()=>new Promise<void>(ok=>{if(failed||stream.destroyed)return ok();stream.end(()=>ok());stream.once('error',()=>ok());})};
}

/**
 * The evidence lives at a log's ends (init and hook events first, the result last). Transcripts
 * that inline images reach tens of MB, so read the head and tail rather than holding the whole log.
 */
async function logEnds(path:string,head=4*1024*1024,tail=16*1024*1024){
 const file=await open(path,'r');
 try{
  const size=(await file.stat()).size;
  if(size<=head+tail){const buffer=Buffer.alloc(size);await file.read(buffer,0,size,0);return buffer.toString('utf8');}
  const first=Buffer.alloc(head),last=Buffer.alloc(tail);
  await file.read(first,0,head,0);await file.read(last,0,tail,size-tail);
  // Partial lines at the cut are dropped by the JSON-lines parser.
  return `${first.toString('utf8')}\n${last.toString('utf8')}`;
 }finally{await file.close();}
}

// ---- one attempt -----------------------------------------------------------------------------

interface AttemptContext {index:number;access:Exclude<ModelAccess,{kind:'none'}>;options:AiTweakOptions;inputsDir:string;inputs:Record<string,FileRef>;inputObj:string;out:string;prompt:string;collectResult:boolean;
 /** Reads the sealed folder after the run, before it is deleted (the visual pick's verdict file). */
 onFinished?:(workspace:string)=>Promise<void>}

async function attempt(ctx:AttemptContext):Promise<AttemptResult>{
 const {index,access,options,out}=ctx,started=Date.now(),cli=cliFor(access);
 const attemptDir=join(out,`attempt-${index}`),logs=join(attemptDir,'logs');await mkdir(logs,{recursive:true,mode:0o700});
 const base:AttemptResult={index,cli,startedAt:new Date(started).toISOString(),wallMs:0,exitCode:null,signal:null,outcome:'failed',inputsModified:[],alternates:[],otherOutputs:[],seal:{},logs:{}};
 const finish=(patch:Partial<AttemptResult>)=>({...base,...patch,wallMs:Date.now()-started});
 // Sealed folder: a fresh temp directory whose only child is the workspace. Logs live elsewhere.
 const sealedParent=await mkdtemp(join(tmpdir(),'stm-ai-')),workspace=join(sealedParent,'scan');
 const privateDir=await mkdtemp(join(tmpdir(),'stm-ai-run-')),binDir=join(privateDir,'bin'),tmp=join(privateDir,'tmp'),codexHome=join(privateDir,'codex-home'),privateHome=join(privateDir,'home');
 const lastMessage=join(privateDir,'last-message.txt');
 let authCopy:{source:string;sourceSha:string;copySha:string}|undefined;
 try{
  await mkdir(workspace,{mode:0o700});await mkdir(binDir,{mode:0o700});await mkdir(tmp,{mode:0o700});await mkdir(privateHome,{mode:0o700});
  for(const name of Object.keys(ctx.inputs)){
   const target=join(workspace,name);await mkdir(dirname(target),{recursive:true,mode:0o700});
   await copyFile(join(ctx.inputsDir,name),target);await chmod(target,0o444);
  }
  if(options.blender){
   if(!isAbsolute(options.blender))throw Error('Blender must be absolute');
   await writeFile(join(binDir,'blender'),`#!/bin/sh\nexec ${JSON.stringify(options.blender)} "$@"\n`,{mode:0o700});
  }
  let p:Plan;
  try{p=plan(access,options,binDir,tmp,codexHome,privateHome);}catch(e){
   return finish({outcome:e instanceof AccessFailure?'auth-failed':'failed',reason:(e as Error).message});
  }
  try{if(!(await stat(p.executable)).isFile())throw Error();}catch{return finish({outcome:'failed',reason:`${p.cli==='claude'?'Claude Code':'Codex'} isn't installed at the configured path`});}
  if(access.kind==='claude-code'&&(options.requireGuiSession??process.platform==='darwin')&&!(await inGuiSession()))
   return finish({outcome:'needs-gui-session',reason:'Claude Code needs the Mac login (GUI) session for its keychain sign-in'});
  if(p.cli==='codex'){
   await mkdir(codexHome,{mode:0o700});await writeFile(join(codexHome,'config.toml'),p.codexConfig!,{mode:0o600});
   if(p.codexAuth){
    let bytes:Buffer;try{bytes=await readFile(p.codexAuth);}catch{return finish({outcome:'auth-failed',reason:'Codex sign-in file not found'});}
    const digest=createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(codexHome,'auth.json'),bytes,{mode:0o600});authCopy={source:p.codexAuth,sourceSha:digest,copySha:digest};
   }
  }
  base.cliVersion=await run(p.executable,['--version'],{timeout:20000,env:p.env}).then(r=>r.stdout.trim().slice(0,200),()=>undefined);
  if(await signedIn(p,access,workspace)===false)
   return finish({outcome:'auth-failed',reason:`${p.cli==='claude'?'Claude Code':'Codex'} reports that it isn't signed in for this user`});
  const result=await supervise(p,workspace,lastMessage,logs,options,ctx.prompt);
  base.exitCode=result.code;base.signal=result.signal;
  base.logs={transcript:relative(out,join(logs,'transcript.jsonl')),stderr:relative(out,join(logs,'stderr.log'))};
  let failedText=result.stderr;let modelReportedError=false;
  if(p.cli==='claude'){
   const ev=claudeEvidence(result.stdout);base.seal=ev.seal;base.usage=ev.usage;base.finalMessage=ev.final;failedText+='\n'+ev.text;modelReportedError=ev.failed;
   const session=await claudeSession(options.claudeProjectsDir??join(p.env.CLAUDE_CONFIG_DIR??join(p.env.HOME!,'.claude'),'projects'),ev.seal.sessionId,logs,base.seal,ctx.prompt);
   if(session)base.logs.session=relative(out,session);
  }else{
   const ev=await codexEvidence(codexHome,result.stdout,logs,ctx.prompt);base.seal=ev.seal;base.usage=ev.usage as Record<string,unknown>|undefined;failedText+='\n'+ev.errors.join('\n');
   if(ev.rollout)base.logs.rollout=relative(out,ev.rollout);
   try{base.finalMessage=clip(await readFile(lastMessage,'utf8'));await copyFile(lastMessage,join(logs,'last-message.txt'));base.logs.lastMessage=relative(out,join(logs,'last-message.txt'));}catch{/* no final message */}
   if(authCopy)base.auth=await returnCodexAuth(authCopy,join(codexHome,'auth.json'));
  }
  const failed=result.code!==0||modelReportedError;
  let collected:Awaited<ReturnType<typeof collect>>|undefined;
  if(ctx.collectResult){
   try{collected=await collect(workspace,ctx.inputs,ctx.inputObj,join(attemptDir,'result'),options.workspaceLimitFiles??20000);}
   catch(e){return finish({outcome:'invalid-output',reason:(e as Error).message});}
   Object.assign(base,{inputsModified:collected.inputsModified,alternates:collected.alternates,otherOutputs:collected.otherOutputs});
   if(collected.result)base.result={dir:relative(out,join(attemptDir,'result')),...collected.result};
  }
  if(ctx.onFinished&&!result.cancelled&&!result.timedOut)await ctx.onFinished(workspace);
  if(result.cancelled)return finish({outcome:'cancelled'});
  if(result.timedOut)return finish({outcome:'timed-out',reason:'Attempt reached its time limit'});
  if(result.limit)return finish({outcome:'failed',reason:result.limit});
  if(failed)return finish({outcome:AUTH_FAILURE.test(failedText)?'auth-failed':'failed',reason:AUTH_FAILURE.test(failedText)?'The CLI is not signed in or the key was rejected':'The CLI exited with an error'});
  return finish({outcome:collected?.outcome??'unchanged'});
 }finally{
  if(authCopy)await rm(join(codexHome,'auth.json'),{force:true});
  await rm(privateDir,{recursive:true,force:true});
  if(!options.keepWorkspaces)await rm(sealedParent,{recursive:true,force:true});
 }
}

const authLocks=new Map<string,Promise<unknown>>();
/** Parallel attempts share one sign-in file: compare and replace it one attempt at a time. */
function returnCodexAuth(copy:{source:string;sourceSha:string;copySha:string},sealed:string){
 const previous=authLocks.get(copy.source)??Promise.resolve();
 const next=previous.then(()=>returnCodexAuthNow(copy,sealed));
 authLocks.set(copy.source,next.catch(()=>undefined));
 return next;
}

/** Codex may refresh its sign-in mid-run; keep the user's login valid without clobbering a newer one. */
async function returnCodexAuthNow(copy:{source:string;sourceSha:string;copySha:string},sealed:string){
 let after:Buffer;try{after=await readFile(sealed);}catch{return {refreshed:false,writtenBack:false,conflict:false};}
 const afterSha=createHash('sha256').update(after).digest('hex');
 if(afterSha===copy.copySha)return {refreshed:false,writtenBack:false,conflict:false};
 let current='';try{current=createHash('sha256').update(await readFile(copy.source)).digest('hex');}catch{/* removed */}
 if(current!==copy.sourceSha)return {refreshed:true,writtenBack:false,conflict:true};
 const temp=join(dirname(copy.source),`.auth-${process.pid}-${Date.now()}.tmp`);
 try{await writeFile(temp,after,{mode:0o600,flag:'wx'});await rename(temp,copy.source);}finally{await rm(temp,{force:true});}
 return {refreshed:true,writtenBack:true,conflict:false};
}

async function supervise(p:Plan,workspace:string,lastMessage:string,logs:string,options:AiTweakOptions,prompt:string){
 const timeout=options.timeoutMs??DEFAULT_TIMEOUT,limitBytes=options.workspaceLimitBytes??4*1024*1024*1024,limitFiles=options.workspaceLimitFiles??20000;
 let timedOut=false,cancelled=false,limit:string|undefined;
 const marker=randomBytes(16).toString('hex');
 const child=spawn(p.executable,p.args(lastMessage,prompt),{cwd:workspace,env:{...p.env,SCAN_TO_MAKE_ATTEMPT:marker},detached:true,stdio:['ignore','pipe','pipe'],windowsHide:true});
 const tracker=child.pid?new Descendants(child.pid,`SCAN_TO_MAKE_ATTEMPT=${marker}`):undefined;
 let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{await tracker?.kill('SIGTERM');await new Promise(r=>setTimeout(r,3000));await tracker?.kill('SIGKILL');})();
 const logFailed=()=>{limit??='Log write failed';void stop();};
 const out=sink(join(logs,'transcript.jsonl'),options.logLimitBytes??256*1024*1024,()=>{limit??='Transcript limit';void stop();},logFailed);
 const err=sink(join(logs,'stderr.log'),16*1024*1024,()=>{limit??='Error log limit';void stop();},logFailed);
 child.stdout.on('data',(b:Buffer)=>out.write(b));child.stderr.on('data',(b:Buffer)=>err.write(b));
 const timer=setTimeout(()=>{timedOut=true;void stop();},timeout);
 const abort=()=>{cancelled=true;void stop();};
 options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 let polling=false,ticks=0;
 const poller=setInterval(()=>{if(polling)return;polling=true;void (async()=>{
  await tracker?.poll();
  if(++ticks%5)return;
  const usage=await workspaceUsage(workspace,limitFiles);
  if(usage.bytes>limitBytes||usage.files>limitFiles){limit??='Workspace limit';await stop();}
 })().finally(()=>polling=false);},1000);
 const closed=new Promise<void>(ok=>child.once('close',()=>ok()));
 // `exit`, not `close`: a worker left holding the CLI's stdout would otherwise keep the attempt open until its timeout.
 const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(ok=>{
  child.once('error',()=>ok({code:null,signal:null}));child.once('exit',(code,signal)=>ok({code,signal}));
 });
 clearTimeout(timer);clearInterval(poller);options.signal?.removeEventListener('abort',abort);
 // Background processes an agent left behind never outlive its attempt.
 await tracker?.kill('SIGKILL');await stopping;
 await Promise.race([closed,new Promise(ok=>setTimeout(ok,5000))]);
 child.stdout.destroy();child.stderr.destroy();
 for(let i=0;i<40&&tracker&&await tracker.alive();i++){await new Promise(r=>setTimeout(r,50));await tracker.kill('SIGKILL');}
 await out.close();await err.close();
 const ends=(path:string,head?:number,tail?:number)=>logEnds(path,head,tail).catch(()=>'');
 return {...exit,timedOut,cancelled,limit,stdout:await ends(join(logs,'transcript.jsonl')),stderr:await ends(join(logs,'stderr.log'),1024*1024,1024*1024)};
}

// ---- public entry points ---------------------------------------------------------------------

/**
 * Run N sealed attempts of David's sentence on one scan. Each attempt gets a fresh folder holding only
 * the textured scan and the photos; pristine copies stay outside it. Never throws for an attempt's
 * failure: outcomes are recorded in `<out>/ai-tweak.json` for the visual pick (KAN-184).
 */
export async function runAiTweak(input:AiTweakInput,out:string,options:AiTweakOptions):Promise<AiTweakManifest>{
 validateAccess(options.access);
 if(!isAbsolute(out))throw Error('Output directory must be absolute');
 const attempts=options.attempts??2,timeout=options.timeoutMs??DEFAULT_TIMEOUT;
 if(!Number.isSafeInteger(attempts)||attempts<1||attempts>4)throw Error('Attempts must be 1 to 4');
 if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>DEFAULT_TIMEOUT)throw Error('Timeout must be at most 30 minutes');
 await mkdir(out,{mode:0o700});
 const manifest:AiTweakManifest={schema:AI_TWEAK_SCHEMA,prompt:AI_TWEAK_PROMPT,access:describeAccess(options.access),inputs:{},attempts:[]};
 const write=()=>writeFile(join(out,'ai-tweak.json'),JSON.stringify(manifest,null,1)+'\n',{mode:0o600});
 if(options.access.kind==='none'){manifest.skipped='access-none';await write();return manifest;}
 const access=options.access,inputsDir=join(out,'inputs');
 const prepared=await prepareInputs(input,inputsDir,options.python??'python3',(options.env??process.env).HOME||homedir(),options.signal);
 manifest.inputs=prepared.inputs;
 const concurrency=Math.min(attempts,Math.max(1,options.concurrency??attempts));
 if(access.kind==='codex-cli'&&concurrency>1){
  // ChatGPT refresh tokens rotate: two attempts refreshing the same copied token leave only one valid
  // lineage. A single tiny call first refreshes (and writes back) if needed; the attempts then start fresh.
  const warm=await mkdtemp(join(tmpdir(),'stm-ai-warm-'));
  try{
   const result=await attempt({index:0,access,options:{...options,timeoutMs:Math.min(timeout,300000)},inputsDir:warm,inputs:{},inputObj:'',out:warm,prompt:CHECK_PROMPT,collectResult:false});
   manifest.warmup={outcome:result.outcome,auth:result.auth};
  }catch{manifest.warmup={outcome:'failed'};}
  finally{await rm(warm,{recursive:true,force:true});}
 }
 const queue=Array.from({length:attempts},(_,i)=>i+1),results:AttemptResult[]=[];
 const workers=Array.from({length:concurrency},async()=>{
  for(let next=queue.shift();next!==undefined;next=queue.shift()){
   const index=next;
   results.push(await attempt({index,access,options,inputsDir,inputs:prepared.inputs,inputObj:prepared.obj,out,prompt:AI_TWEAK_PROMPT,collectResult:true}).catch(e=>({
    index,cli:cliFor(access),startedAt:new Date().toISOString(),wallMs:0,exitCode:null,signal:null,outcome:'failed' as const,
    reason:`Attempt could not run: ${(e as Error).message}`.slice(0,500),inputsModified:[],alternates:[],otherOutputs:[],seal:{},logs:{}})));
  }
 });
 await Promise.all(workers);
 manifest.attempts=results.sort((a,b)=>a.index-b.index);await write();return manifest;
}

/**
 * A sealed run with a caller-written prompt and files, for the visual pick's judge (KAN-184). It is a
 * separate entry point on purpose: runAiTweak can only ever send David's sentence.
 */
export async function runSealedTask(task:{access:ModelAccess;prompt:string;inputsDir:string;out:string;
 onFinished:(workspace:string)=>Promise<void>},options:Omit<AiTweakOptions,'access'>):Promise<AttemptResult|undefined>{
 validateAccess(task.access);
 if(task.access.kind==='none')return undefined;
 if(!task.prompt.trim()||task.prompt===AI_TWEAK_PROMPT)throw Error('A sealed task needs its own prompt');
 const inputs:Record<string,FileRef>={};
 for(const name of await listFiles(task.inputsDir))inputs[name]=await fileRef(join(task.inputsDir,name));
 await mkdir(task.out,{recursive:true,mode:0o700});
 return attempt({index:1,access:task.access,options:{...options,access:task.access},inputsDir:task.inputsDir,inputs,inputObj:'',out:task.out,
  prompt:task.prompt,collectResult:false,onFinished:task.onFinished});
}

/** The Mac app's "Connected" check: one tiny sealed call through the same route, no scan involved. */
export async function checkModelAccess(options:AiTweakOptions):Promise<{ok:boolean;outcome:AttemptOutcome|'skipped';reason?:string;cliVersion?:string;seal?:Record<string,unknown>}>{
 validateAccess(options.access);
 if(options.access.kind==='none')return {ok:false,outcome:'skipped'};
 const out=await mkdtemp(join(tmpdir(),'stm-ai-check-'));
 try{
  const result=await attempt({index:1,access:options.access,options:{...options,timeoutMs:Math.min(options.timeoutMs??120000,300000)},inputsDir:out,inputs:{},inputObj:'',out,prompt:CHECK_PROMPT,collectResult:false});
  const ok=result.exitCode===0&&/\bOK\b/i.test(result.finalMessage??'')&&!['auth-failed','needs-gui-session','timed-out','cancelled','failed'].includes(result.outcome);
  return {ok,outcome:result.outcome,reason:result.reason,cliVersion:result.cliVersion,seal:result.seal};
 }finally{await rm(out,{recursive:true,force:true});}
}

export const aiTweakInternals={objBundle,collect,plan,returnCodexAuth,sink};
