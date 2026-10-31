#!/usr/bin/env node
import {accessSync,constants,realpathSync,statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {homedir,userInfo} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {ModelAccessEnvironment} from '@scan-to-make/contracts/model-access';
import {checkModelAccess,modelAccessFromEnv,runAiTweak,type AiTweakOptions} from './ai-tweak.js';
import {pickAiTweak,type PickResult} from './ai-tweak-pick.js';
import {exportPicked} from './ai-tweak-export.js';
import {lookupMakerSize} from './maker-size-lookup.js';

/** The user's own CLI: an explicit operator path, else the usual install locations. */
export function findExecutable(name:'claude'|'codex',env:NodeJS.ProcessEnv=process.env):string|undefined{
 const configured=env[name==='claude'?'SCAN_TO_MAKE_CLAUDE_PATH':'SCAN_TO_MAKE_CODEX_PATH'];
 if(configured)return isAbsolute(configured)?configured:undefined;
 const home=env.HOME||homedir();
 for(const dir of [...(env.PATH??'').split(':'),join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin']){
  if(!isAbsolute(dir))continue;
  const path=join(dir,name);
  try{if(statSync(path).isFile()){accessSync(path,constants.X_OK);return path;}}catch{/* keep looking */}
 }
 return undefined;
}

const PATH_MARK='__SCAN_TO_MAKE_PATH__';
/** One PATH read: the child's own output between markers. Nothing else from the shell is kept. */
function readPath(command:string,args:string[],env:NodeJS.ProcessEnv,timeoutMs:number){
 return new Promise<string|undefined>(done=>{
  let out='',settled=false;const child=spawn(command,args,{env,stdio:['ignore','pipe','ignore'],detached:true});
  const finish=(value:string|undefined)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdout.destroy();done(value);};
  // A profile can leave a background job holding stdout open, so the timer settles on its own.
  const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill('SIGKILL');}finish(undefined);},timeoutMs);
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{if(out.length<65536)out+=chunk;});
  child.on('error',()=>finish(undefined));
  const marked=()=>{const parts=out.split(PATH_MARK),inner=parts[1]?.trim();return parts.length>=3&&inner?inner:undefined;};
  child.on('exit',()=>{const path=marked();if(path)finish(path);});
  child.on('close',()=>finish(marked()));
 });
}

/**
 * The user's PATH as their login shell builds it, the way T3 Code hydrates a GUI process: $SHELL, the
 * account's shell, then /bin/zsh on macOS, then launchd's PATH. The first PATH that `accept`s wins, so a
 * shell whose PATH lacks the CLI doesn't hide the later candidates. Only used when the usual places miss.
 */
export async function loginShellPath(env:NodeJS.ProcessEnv=process.env,timeoutMs=8000,accept:(path:string)=>boolean=()=>true):Promise<string|undefined>{
 let account:{username:string;shell:string|null}|undefined;try{account=userInfo();}catch{/* no account record */}
 const home=env.HOME||homedir(),user=env.USER||account?.username||'';
 const shells=[env.SHELL,account?.shell??undefined,process.platform==='darwin'?'/bin/zsh':undefined].filter((s):s is string=>!!s&&isAbsolute(s));
 for(const shell of [...new Set(shells)]){
  // A minimal starting environment: the profile builds PATH; no inherited key is visible to it.
  // printf and printenv read the same in sh, zsh, bash and fish (fish has no ${PATH} syntax).
  const path=await readPath(shell,['-ilc',`printf '%s' ${PATH_MARK}; /usr/bin/printenv PATH; printf '%s' ${PATH_MARK}`],{HOME:home,USER:user,LOGNAME:user,SHELL:shell,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TERM:'dumb'},timeoutMs);
  if(path&&accept(path))return path;
 }
 if(process.platform==='darwin'){
  const path=await readPath('/bin/sh',['-c',`printf '%s' "${PATH_MARK}$(/bin/launchctl getenv PATH)${PATH_MARK}"`],{PATH:'/usr/bin:/bin'},timeoutMs);
  if(path&&accept(path))return path;
 }
 return undefined;
}

/** optionsFromEnv, plus the login shell's PATH when the selected CLI isn't in the usual places. */
export async function resolveOptions(env:NodeJS.ProcessEnv=process.env,
 shellPath:(env:NodeJS.ProcessEnv,timeoutMs:number,accept:(path:string)=>boolean)=>Promise<string|undefined>=loginShellPath):Promise<AiTweakOptions>{
 const options=optionsFromEnv(env),access=options.access;
 if(access.kind==='none')return options;
 const cli=access.kind==='claude-code'||access.kind==='api'&&access.provider==='anthropic'?'claude':'codex';
 // An explicit operator path is never second-guessed.
 if(env[cli==='claude'?'SCAN_TO_MAKE_CLAUDE_PATH':'SCAN_TO_MAKE_CODEX_PATH']||options[cli==='claude'?'claudePath':'codexPath'])return options;
 const found=(path:string)=>findExecutable(cli,{HOME:env.HOME,PATH:path});
 const path=await shellPath(env,8000,path=>!!found(path));
 if(path){options[cli==='claude'?'claudePath':'codexPath']=found(path);options.searchPath=path;}
 return options;
}

export function optionsFromEnv(env:NodeJS.ProcessEnv=process.env):AiTweakOptions{
 const number=(value:string|undefined)=>value===undefined||value===''?undefined:Number(value);
 return {access:modelAccessFromEnv(env),attempts:number(env.SCAN_TO_MAKE_AI_ATTEMPTS),timeoutMs:number(env.SCAN_TO_MAKE_AI_TIMEOUT_MS),
  claudePath:findExecutable('claude',env),codexPath:findExecutable('codex',env),blender:env.SCAN_TO_MAKE_SCAN_BLENDER||undefined,
  python:env.SCAN_TO_MAKE_CAPTURE_PYTHON||undefined,env};
}

async function main(argv:string[]){
 const [command,...rest]=argv;
 if(command==='check'){
  const controller=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>controller.abort());
  const result=await checkModelAccess({...await resolveOptions(),signal:controller.signal});
  process.stdout.write(JSON.stringify(result)+'\n');return result.ok?0:1;
 }
 if(command==='pick'){
  // Visual pick over a runAiTweak output folder; the judge uses the same SCAN_TO_MAKE_AI_* access.
  const {values}=parseArgs({args:rest,strict:true,options:{dir:{type:'string'},seed:{type:'string'}}});
  const options=await resolveOptions(),tool=process.env[ModelAccessEnvironment.judgeTool];
  if(!values.dir||!tool||!options.blender||!options.python)throw Error('pick needs --dir, SCAN_TO_MAKE_AI_JUDGE_TOOL, SCAN_TO_MAKE_SCAN_BLENDER and SCAN_TO_MAKE_CAPTURE_PYTHON');
  // Same cancellation as `run`: the judge is a detached sealed run that must not outlive the CLI.
  const controller=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort());
  const result=await pickAiTweak(values.dir,{...options,blender:options.blender,python:options.python,toolDir:tool,seed:values.seed,signal:controller.signal});
  process.stdout.write(JSON.stringify({choice:result.choice,decidedBy:result.decidedBy,reason:result.reason,candidates:result.candidates.map(c=>({id:c.id,label:c.label,veto:c.veto?.reason}))})+'\n');
  return 0;
 }
 if(command!=='run')throw Error('usage: ai-tweak-cli run --mesh <obj> [--usdz <path>] [--still <path>]... --out <dir> [--attempts N] [--pick --export <dir> --mm-per-unit <n>] | pick --dir <dir> [--seed s] | check');
 const {values}=parseArgs({args:rest,strict:true,options:{mesh:{type:'string'},usdz:{type:'string'},still:{type:'string',multiple:true},out:{type:'string'},
  attempts:{type:'string'},'timeout-ms':{type:'string'},'keep-workspaces':{type:'boolean'},
  // The cleanup job's whole AI step in one worker (KAN-184): attempts, the visual pick and the mm export.
  // The judge's scripts run inside a worker that may hold a model key, so their folder is never an
  // argument: it comes from SCAN_TO_MAKE_AI_JUDGE_TOOL, set by whoever owns the installation.
  pick:{type:'boolean'},'judge-timeout-ms':{type:'string'},export:{type:'string'},'mm-per-unit':{type:'string'}}});
 const judgeTool=process.env[ModelAccessEnvironment.judgeTool];
 if(!values.mesh||!values.out)throw Error('--mesh and --out are required');
 const mmPerUnit=Number(values['mm-per-unit']??1000);
 if(values.export&&(!values.pick||!isAbsolute(values.export)||!(mmPerUnit>0)))throw Error('--export needs --pick and an absolute --export');
 const options=await resolveOptions();
 if(values.attempts)options.attempts=Number(values.attempts);
 if(values['timeout-ms'])options.timeoutMs=Number(values['timeout-ms']);
 if(values['keep-workspaces'])options.keepWorkspaces=true;
 const controller=new AbortController();
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>controller.abort());
 options.signal=controller.signal;
 const manifest=await runAiTweak({mesh:values.mesh,usdz:values.usdz,stills:values.still??[]},values.out,options);
 const summary={skipped:manifest.skipped,attempts:manifest.attempts.map(a=>({index:a.index,outcome:a.outcome,reason:a.reason,wallMs:a.wallMs,result:a.result?.dir}))};
 if(!values.pick||options.access.kind==='none'){process.stdout.write(JSON.stringify(summary)+'\n');return 0;}
 let pick:PickResult;
 try{
  if(!options.blender||!options.python||!judgeTool)throw Error('pick needs SCAN_TO_MAKE_SCAN_BLENDER, SCAN_TO_MAKE_CAPTURE_PYTHON and SCAN_TO_MAKE_AI_JUDGE_TOOL');
  pick=await pickAiTweak(values.out,{...options,blender:options.blender,python:options.python,toolDir:judgeTool,mmPerUnit,
   judgeTimeoutMs:values['judge-timeout-ms']?Number(values['judge-timeout-ms']):undefined});
 }catch(error){
  if(controller.signal.aborted)throw error;
  // Any failure of the pick itself keeps the captured scan; the job still finishes.
  pick={schema:'scan-to-make.ai-tweak-pick/0.1',choice:'captured',decidedBy:'fallback',reason:'The visual pick could not run, so the captured scan is kept.',candidates:[{id:'captured'}],error:String((error as Error).message).slice(0,2000)};
 }
 if(!values.export){process.stdout.write(JSON.stringify({...summary,pick:{choice:pick.choice,decidedBy:pick.decidedBy,reason:pick.reason}})+'\n');return 0;}
 controller.signal.throwIfAborted();
 const report=await exportPicked(values.out,manifest,pick,options.access,mmPerUnit,values.export);
 // A separate lookup uses pristine inputs and the same model access, never the tweak's prompt.
 // Failure is optional metadata loss; cancellation still terminates the whole job.
 const makerSize=await lookupMakerSize(values.out,manifest,options);
 controller.signal.throwIfAborted();
 if(makerSize)await writeFile(join(values.export,'report.json'),JSON.stringify({...report,makerSize})+'\n',{mode:0o600});
 process.stdout.write(JSON.stringify({aiTweak:report.aiTweak})+'\n');
 return 0;
}

// Importable for tests: only the script itself runs main.
const entry=process.argv[1];
if(entry&&realpathSync(entry)===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{process.stderr.write(`${(error as Error).message}\n`);process.exitCode=2;});
