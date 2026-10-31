import {execFile} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {runSealedTask,type AiTweakManifest,type AiTweakOptions,type ModelAccess} from './ai-tweak.js';

const run=promisify(execFile);
export const AI_TWEAK_PICK_SCHEMA='scan-to-make.ai-tweak-pick/0.1';

/**
 * The judge's instructions (KAN-184). Candidates are blind letters and include the scan as captured;
 * the judge sees only photos and renders, never an attempt's own account of what it did.
 */
export const JUDGE_PROMPT=`This folder holds pictures for one decision.
- photos/ are close-up photographs of a real object.
- candidates/<letter>/ are versions of a 3D scan of that object, each rendered from the same cameras. textured_* images show its colour, grey_* images show only its shape, and ring_* views sit between the main views. The bottom view shows the side the object rested on while it was scanned.
- compare/ puts the candidates side by side, view by view.

One candidate is the scan exactly as it was captured; the others were edited by an automatic tool. Compare every candidate with the photos and choose the one closest to the real object.

Scans like this usually have the same flaws: the side the object rested on is dark, smeared, coarse or flat because the scanner barely saw it; printed text comes out blurry; small raised parts such as beads or buttons are flattened into the surface; and thin fins or flaps stick out where the object met the table. An edit that fixes these toward what the photos show is an improvement, as long as everything the scanner did see keeps its shape and its texture.

Rules:
- Keep the captured scan unless an edited candidate is clearly closer to the photos.
- Reject a candidate that smooths away surface detail the photos show (stitches, fabric or knit relief, sharp edges) on surfaces the scanner saw. A surface that is flat in the photos, such as paper, may be flat.
- Reject a candidate that changes the object's overall shape or proportions, or adds parts the photos don't show.
- Reject washed-out, blotchy, patchy or colour-cast texture. The photos' lighting varies, so judge colour by whether it is even and true to the object across the photos, not by one photo's exposure.
- Judge only from these pictures.

When you have decided, write verdict.json in this folder, exactly:
{"choice": "<one candidate letter, or none>", "reason": "<two or three sentences on what you saw in the photos and the renders>", "notes": {"<letter>": "<one sentence for each candidate>"}}
Use "none" when no candidate is clearly closer than the others, or when you can't tell which one is the captured scan; the captured scan is then kept.
Don't change any other file.`;

export type CandidateId='captured'|`attempt-${number}`;
export type VetoReason='smoothed'|'squashed-or-stretched'|'reshaped'|'unreadable';
export interface PickCandidate {
 id:CandidateId; label?:string;
 veto?:{reason:VetoReason;detail:string};
 measure?:{p50Mm:number;p95Mm:number;shareOver0_1Mm:number;bboxMm:number[]};
}
export interface PickResult {
 schema:typeof AI_TWEAK_PICK_SCHEMA; choice:CandidateId; reason:string;
 decidedBy:'judge'|'veto'|'fallback'; candidates:PickCandidate[];
 /** Why a fallback happened, for diagnostics (never shown to the user). */
 error?:string;
 judge?:{outcome:string;reason?:string;cliVersion?:string;verdict?:unknown;logs?:Record<string,string>};
}
export interface PickOptions extends Omit<AiTweakOptions,'attempts'|'access'> {
 /** The judge's route; normally the same ModelAccess as the AI step. */
 access:ModelAccess;
 blender:string; python:string;
 /** Absolute path to tools/ai-tweak-judge. */
 toolDir:string;
 /** The imported capture is in metres. */
 mmPerUnit?:number;
 /** A median captured-point move above this vetoes an attempt (KAN-177: good runs ≤ 0.0003 mm, smoothing 0.06 mm). */
 vetoP50Mm?:number;
 /** Fixes the blind-label order (tests); random otherwise. */
 seed?:string;
 judgeTimeoutMs?:number; resolution?:number;
}

const LETTERS='ABCDEFGH';

/**
 * Geometry may reject an attempt, never choose one. The median move is taken both ways: captured points
 * to the attempt (smoothing, squashing) and the attempt's points back to the capture (an outward stretch
 * leaves captured points lying on the stretched faces). On KAN-177's runs both medians are ≤ 0.0005 mm
 * for every good attempt, 0.06 / 0.025 mm for the smoothed one and 1.7 / 1.5 mm for the squashed one.
 */
export function vetoFor(measure:{reference:{bboxMm:number[]};candidate:{bboxMm:number[]};capturedToCandidate:{p50Mm:number};candidateToCaptured?:{p50Mm:number}},limitMm=0.02):PickCandidate['veto']{
 const p50=Math.max(measure.capturedToCandidate.p50Mm,measure.candidateToCaptured?.p50Mm??0);
 if(!(p50>limitMm))return undefined;
 const ratios=measure.candidate.bboxMm.map((size,i)=>size/measure.reference.bboxMm[i]!);
 const box=ratios.map(r=>`${((r-1)*100).toFixed(1)}%`).join(' / ');
 if(p50>0.5&&ratios.some(r=>Math.abs(r-1)>0.01))
  return {reason:'squashed-or-stretched',detail:`the captured surface moved a median ${p50.toFixed(2)} mm and the box changed ${box}`};
 if(p50>0.5)return {reason:'reshaped',detail:`the captured surface moved a median ${p50.toFixed(2)} mm`};
 return {reason:'smoothed',detail:`the captured surface moved a median ${p50.toFixed(3)} mm, as smoothing does`};
}

function shuffled<T>(items:T[],seed:string):T[]{
 const out=[...items];let state=createHash('sha256').update(seed).digest();
 for(let i=out.length-1;i>0;i--){
  state=createHash('sha256').update(state).digest();
  const j=state.readUInt32BE(0)%(i+1);[out[i],out[j]]=[out[j]!,out[i]!];
 }
 return out;
}

async function blender(options:PickOptions,script:string,args:string[],signal?:AbortSignal){
 // Without --python-exit-code Blender exits 0 when the script raises (as every Blender call in this repo passes).
 await run(options.blender,['-b','--factory-startup','--python-exit-code','1','-P',join(options.toolDir,script),'--',...args],
  {timeout:600000,maxBuffer:16*1024*1024,signal,env:{PATH:'/usr/bin:/bin',HOME:tmpdir()}});
}

/**
 * Choose between the captured scan and the AI attempts in `manifestDir` (written by runAiTweak):
 * - veto attempts that moved the captured surface;
 * - render the rest with the captured scan from shared cameras;
 * - let a sealed judge compare them with the photos under blind labels.
 *
 * Any uncertainty keeps the captured scan. Writes `<manifestDir>/pick.json`.
 */
export async function pickAiTweak(manifestDir:string,options:PickOptions):Promise<PickResult>{
 for(const path of [manifestDir,options.blender,options.python,options.toolDir])if(!isAbsolute(path))throw Error('Pick paths must be absolute');
 const manifest=JSON.parse(await readFile(join(manifestDir,'ai-tweak.json'),'utf8')) as AiTweakManifest;
 const inputObj=Object.keys(manifest.inputs).find(name=>name.toLowerCase().endsWith('.obj'));
 if(!inputObj)throw Error('Manifest has no captured OBJ');
 // pick/ is derived output: a rerun (after a fallback, say) starts it afresh.
 const work=join(manifestDir,'pick');await rm(work,{recursive:true,force:true});await mkdir(work,{mode:0o700});
 const captured:PickCandidate={id:'captured'};const candidates:PickCandidate[]=[captured];
 const meshes=new Map<CandidateId,string>([['captured',join(manifestDir,'inputs',inputObj)]]);
 const result:PickResult={schema:AI_TWEAK_PICK_SCHEMA,choice:'captured',reason:'',decidedBy:'fallback',candidates};
 const finish=async(patch:Partial<PickResult>)=>{
  Object.assign(result,patch);await writeFile(join(manifestDir,'pick.json'),JSON.stringify(result,null,1)+'\n',{mode:0o600});return result;
 };
 // 1. Veto attempts that moved what the scanner captured.
 await mkdir(join(work,'measure'),{mode:0o700});
 for(const attempt of manifest.attempts){
  if(attempt.outcome!=='changed'||!attempt.result)continue;
  const id=`attempt-${attempt.index}` as CandidateId,mesh=join(manifestDir,attempt.result.dir,attempt.result.obj),entry:PickCandidate={id};
  candidates.push(entry);meshes.set(id,mesh);
  try{
   const out=join(work,'measure',`${id}.json`);
   await blender(options,'measure.py',['--reference',meshes.get('captured')!,'--candidate',mesh,'--out',out,'--mm-per-unit',String(options.mmPerUnit??1000)],options.signal);
   const measure=JSON.parse(await readFile(out,'utf8'));
   entry.measure={p50Mm:Math.max(measure.capturedToCandidate.p50Mm,measure.candidateToCaptured.p50Mm),p95Mm:measure.capturedToCandidate.p95Mm,shareOver0_1Mm:measure.capturedToCandidate.shareOver0_1Mm,bboxMm:measure.candidate.bboxMm};
   entry.veto=vetoFor(measure,options.vetoP50Mm??0.02);
  }catch(e){
   // Cancellation is not a verdict on the attempt.
   if(options.signal?.aborted)throw e;
   entry.veto={reason:'unreadable',detail:'the attempt could not be measured'};
  }
 }
 const contenders=candidates.filter(c=>!c.veto);
 const photos=Object.keys(manifest.inputs).filter(n=>/^still_\d{2}_[0-9a-f]{8}\.jpg$/.test(n));
 if(candidates.length===1){
  // Nothing to compare. Say whether the attempts ran and left the scan alone, or never finished.
  const unfinished=manifest.attempts.filter(a=>!['changed','unchanged','other-format-only'].includes(a.outcome)).map(a=>a.outcome);
  return finish(unfinished.length&&unfinished.length===manifest.attempts.length
   ?{decidedBy:'fallback',reason:`The AI attempts didn't finish (${[...new Set(unfinished)].join(', ')}), so the captured scan is kept.`}
   :{decidedBy:'veto',reason:'No attempt changed the scan.'});
 }
 if(contenders.length===1)return finish({decidedBy:'veto',reason:'Every attempt was rejected: '+candidates.filter(c=>c.veto).map(c=>`${c.id} ${c.veto!.detail}`).join('; ')+'.'});
 if(!photos.length)return finish({reason:'There are no close-up photos to compare against, so the captured scan is kept.'});
 // 2. Render every contender from the captured scan's cameras.
 const cams=join(work,'cams.json'),resolution=String(options.resolution??1600);
 try{
  for(const [index,candidate] of contenders.entries())
   await blender(options,'render.py',['--mesh',meshes.get(candidate.id)!,'--cams',cams,'--out',join(work,'renders',candidate.id),'--resolution',resolution,...(index===0?['--make-cams','--ring']:[])],options.signal);
  // Every candidate must have the full, identical set of views: a missing view could hide the damage the judge looks for.
  const expected=JSON.parse(await readFile(join(work,'renders','captured','render.json'),'utf8')).images as string[];
  for(const candidate of contenders){
   const report=JSON.parse(await readFile(join(work,'renders',candidate.id,'render.json'),'utf8'));
   const present=new Set(await readdir(join(work,'renders',candidate.id)));
   if(report.images.join()!==expected.join()||!expected.every(name=>present.has(name)))throw Error(`incomplete renders for ${candidate.id}`);
  }
 }catch(e){
  if(options.signal?.aborted)throw e;
  return finish({reason:'The candidates could not be rendered, so the captured scan is kept.',error:String((e as Error).message).slice(0,2000)});
 }
 // 3. Blind, shuffled labels; the judge folder holds only photos and renders.
 const order=shuffled(contenders,options.seed??randomBytes(16).toString('hex'));
 order.forEach((candidate,i)=>{candidate.label=LETTERS[i];});
 const judgeInputs=await mkdtemp(join(tmpdir(),'stm-ai-judge-'));
 try{
  await mkdir(join(judgeInputs,'photos'));await mkdir(join(judgeInputs,'candidates'));
  for(const name of photos)await copyFile(join(manifestDir,'inputs',name),join(judgeInputs,'photos',name));
  for(const candidate of order){
   const from=join(work,'renders',candidate.id),to=join(judgeInputs,'candidates',candidate.label!);await mkdir(to);
   // Pictures only: render.json would name the source mesh.
   for(const name of (await readdir(from)).filter(n=>n.endsWith('.png')))await copyFile(join(from,name),join(to,name));
  }
  await run(options.python,['-E','-P',join(options.toolDir,'sheet.py'),'--out',join(judgeInputs,'compare'),'--cell','800',
   ...order.map(c=>`${c.label}=${join(judgeInputs,'candidates',c.label!)}`)],{timeout:300000,maxBuffer:4*1024*1024,signal:options.signal,env:{PATH:'/usr/bin:/bin',HOME:(options.env??process.env).HOME||homedir()}});
  // 4. The sealed judge.
  let verdict:unknown;
  const attempt=await runSealedTask({access:options.access,prompt:JUDGE_PROMPT,inputsDir:judgeInputs,out:join(work,'judge'),
   onFinished:async workspace=>{try{verdict=JSON.parse(await readFile(join(workspace,'verdict.json'),'utf8'));}catch{verdict=undefined;}}},
   {...options,timeoutMs:Math.min(options.judgeTimeoutMs??900000,1800000)});
  if(!attempt)return finish({reason:'No model is set up to judge, so the captured scan is kept.'});
  if(options.signal?.aborted||attempt.outcome==='cancelled')throw options.signal?.reason??Error('Pick cancelled');
  result.judge={outcome:attempt.outcome,reason:attempt.reason,cliVersion:attempt.cliVersion,verdict,logs:attempt.logs};
  const v=verdict as {choice?:unknown;reason?:unknown}|undefined;
  // 'unchanged' is a clean sealed run; a CLI that reported an error can still have exited 0.
  const usable=attempt.exitCode===0&&attempt.outcome==='unchanged'&&typeof v?.reason==='string'&&v.reason.trim();
  const chosen=v?.choice==='none'?captured:order.find(c=>c.label===v?.choice);
  if(!usable||!chosen)return finish({reason:'The judge did not give a usable verdict, so the captured scan is kept.'});
  // A tie or an unclear capture is the judge's own call to keep the captured scan.
  return finish({choice:chosen.id,decidedBy:'judge',reason:String(v!.reason).trim().slice(0,4000)});
 }catch(e){
  if(options.signal?.aborted)throw e;
  return finish({reason:'The judge could not run, so the captured scan is kept.',error:String((e as Error).message).slice(0,2000)});
 }finally{await rm(judgeInputs,{recursive:true,force:true});}
}
