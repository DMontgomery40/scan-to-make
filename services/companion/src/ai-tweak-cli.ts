#!/usr/bin/env node
import {accessSync,constants,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {parseArgs} from 'node:util';
import {checkModelAccess,modelAccessFromEnv,runAiTweak,type AiTweakOptions} from './ai-tweak.js';
import {pickAiTweak} from './ai-tweak-pick.js';

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
  const result=await checkModelAccess({...optionsFromEnv(),signal:controller.signal});
  process.stdout.write(JSON.stringify(result)+'\n');return result.ok?0:1;
 }
 if(command==='pick'){
  // Visual pick over a runAiTweak output folder; the judge uses the same SCAN_TO_MAKE_AI_* access.
  const {values}=parseArgs({args:rest,strict:true,options:{dir:{type:'string'},seed:{type:'string'}}});
  const options=optionsFromEnv(),tool=process.env.SCAN_TO_MAKE_AI_JUDGE_TOOL;
  if(!values.dir||!tool||!options.blender||!options.python)throw Error('pick needs --dir, SCAN_TO_MAKE_AI_JUDGE_TOOL, SCAN_TO_MAKE_SCAN_BLENDER and SCAN_TO_MAKE_CAPTURE_PYTHON');
  // Same cancellation as `run`: the judge is a detached sealed run that must not outlive the CLI.
  const controller=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>controller.abort());
  const result=await pickAiTweak(values.dir,{...options,blender:options.blender,python:options.python,toolDir:tool,seed:values.seed,signal:controller.signal});
  process.stdout.write(JSON.stringify({choice:result.choice,decidedBy:result.decidedBy,reason:result.reason,candidates:result.candidates.map(c=>({id:c.id,label:c.label,veto:c.veto?.reason}))})+'\n');
  return 0;
 }
 if(command!=='run')throw Error('usage: ai-tweak-cli run --mesh <obj> [--usdz <path>] [--still <path>]... --out <dir> [--attempts N] | pick --dir <dir> [--seed s] | check');
 const {values}=parseArgs({args:rest,strict:true,options:{mesh:{type:'string'},usdz:{type:'string'},still:{type:'string',multiple:true},out:{type:'string'},
  attempts:{type:'string'},'timeout-ms':{type:'string'},'keep-workspaces':{type:'boolean'}}});
 if(!values.mesh||!values.out)throw Error('--mesh and --out are required');
 const options=optionsFromEnv();
 if(values.attempts)options.attempts=Number(values.attempts);
 if(values['timeout-ms'])options.timeoutMs=Number(values['timeout-ms']);
 if(values['keep-workspaces'])options.keepWorkspaces=true;
 const controller=new AbortController();
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>controller.abort());
 options.signal=controller.signal;
 const manifest=await runAiTweak({mesh:values.mesh,usdz:values.usdz,stills:values.still??[]},values.out,options);
 process.stdout.write(JSON.stringify({skipped:manifest.skipped,attempts:manifest.attempts.map(a=>({index:a.index,outcome:a.outcome,reason:a.reason,wallMs:a.wallMs,result:a.result?.dir}))})+'\n');
 return 0;
}

main(process.argv.slice(2)).then(code=>{process.exitCode=code;},error=>{process.stderr.write(`${(error as Error).message}\n`);process.exitCode=2;});
