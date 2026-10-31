import {createHash} from 'node:crypto';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {AI_ATTEMPT_PREVIEW_NAMES,AiTweakRecordSchema,type AiTweakRecord} from '@scan-to-make/contracts/scan-processing';
import {aiTweakInternals,type AiTweakManifest,type ModelAccess} from './ai-tweak.js';
import type {PickResult} from './ai-tweak-pick.js';
import {materialLibrary,meshTextLines,textureMap} from './mesh-materials.js';
import {readScanMaterials} from './scan-model-assets.js';

/**
 * The AI step's hand-off to the rest of cleanup (KAN-184 PR B). The picked result, an attempt or the
 * captured scan, becomes the same files scan-correct writes: corrected.obj (mm) and corrected.stl,
 * plus mesh.mtl, mesh_basecolor_N.png and mesh_normal_N.png in the final-result grammar that the
 * /model-assets publisher (KAN-141) and make-printable (KAN-185) check with readScanMaterials.
 */
export const AI_CLEANUP_SCHEMA='scan-to-make.ai-tweak-cleanup/0.1';
/** The pick's render that becomes an attempt's preview on the phone. */
export const PREVIEW_VIEW='textured_iso_front_left.png';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_MESH_BYTES=64*1024*1024,MAX_PREVIEW_BYTES=8*1024*1024,MAX_TRIANGLES=1200000;
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
/** Material values the final-result grammar accepts (scan-model-assets.ts readScanMaterials). */
const VECTOR_VALUES=new Set(['Kd','Ka','Ks','Ke','Tf']);
const SCALAR_VALUES=new Set(['Ns','Ni','d','Tr','illum','Pr','Pm','Ps','Pc','Pcr','aniso','anisor']);

/**
 * The judge writes its reason freely, so before it is public: known secret values, absolute paths and
 * anything shaped like a credential are replaced. The raw verdict stays in the private pick.json.
 */
export function publicReason(text:string,secrets:string[]=[]){
 let out=text;
 for(const secret of secrets)if(secret&&secret.length>=8)out=out.split(secret).join('[redacted]');
 return out
  .replace(/(?:~|\b[A-Za-z]:)?(?:\/[^\s/'"`<>|]+){2,}\/?/g,'[path]')
  .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abpr])[-_][A-Za-z0-9_-]{8,}\b/g,'[redacted]')
  .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g,'[redacted]')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ');
}

/** What the job may record about the route: its kind and model, never a key, host, transcript or path. */
export function aiTweakRecord(access:Exclude<ModelAccess,{kind:'none'}>,manifest:Pick<AiTweakManifest,'attempts'>|undefined,
 pick:Pick<PickResult,'choice'|'decidedBy'|'reason'>&{candidates?:PickResult['candidates']},secrets:string[]=[]):AiTweakRecord{
 const model='model' in access&&access.model?access.model:undefined;
 return AiTweakRecordSchema.parse({
  access:{kind:access.kind,...(model?{model}:{})},
  attempts:(manifest?.attempts??[]).map(a=>{
   const veto=pick.candidates?.find(c=>c.id===`attempt-${a.index}`)?.veto?.reason;
   return {index:a.index,outcome:a.outcome,wallMs:Math.min(7200000,Math.max(0,Math.round(a.wallMs))),...(veto?{veto}:{})};
  }),
  pick:{choice:pick.choice,decidedBy:pick.decidedBy,reason:publicReason(pick.reason,secrets).trim().slice(0,4000)||'The captured scan is kept.'},
 });
}

const number=(token:string|undefined)=>{const value=Number(token);if(token===undefined||!Number.isFinite(value))throw Error('Invalid OBJ number');return value;};
const fixed=(value:number)=>{const out=Number(value.toFixed(6));return Object.is(out,-0)?'0':String(out);};

/** A reference inside the bundle that was already validated (no escape, no symlink, no missing file). */
function resolver(bundle:Awaited<ReturnType<typeof aiTweakInternals.objBundle>>){
 return (from:string,name:string)=>{
  const target=bundle.absolute.find(ref=>ref.from===from&&ref.raw===name)?.target??resolve(dirname(from),name.replace(/\\/g,'/'));
  if(!bundle.files.includes(target))throw Error('Unresolved mesh bundle reference');
  return target;
 };
}

/**
 * Rewrite one OBJ bundle into `out` in millimetres. Vertex positions are scaled; UVs, normals, faces and
 * material assignments are copied unchanged. Each material keeps its own values, base colour and normal
 * map (PNG bytes unchanged, as mesh_basecolor_N.png and mesh_normal_N.png) within the final-result
 * grammar; maps and values outside it are dropped. Fails on anything that would change the base colour
 * (texture offsets or scales, a non-PNG base colour), so the caller can keep the captured scan.
 */
export async function exportMeshBundle(obj:string,mmPerUnit:number,out:string):Promise<Record<string,string>>{
 if(!isAbsolute(obj)||!isAbsolute(out))throw Error('Export paths must be absolute');
 if(!(Number.isFinite(mmPerUnit)&&mmPerUnit>0&&mmPerUnit<=1e6))throw Error('Invalid export scale');
 const bundle=await aiTweakInternals.objBundle(dirname(obj),obj);
 if(bundle.escaped||bundle.missing.length)throw Error('Mesh bundle references missing, outside or oversized files');
 const target=resolver(bundle),objBytes=await readFile(obj);
 if(objBytes.length>MAX_MESH_BYTES)throw Error('Mesh too large');
 // Materials: the first definition of a name wins, and within one the last statement of each directive
 // wins, as OBJ readers do (in the position it first appeared). Limited to the final-result grammar the
 // publisher and make-printable check (KAN-185, #160). Image bytes are read only for maps that are kept.
 type Entry={line:string}|{map:'basecolor'|'normal';source:string;prefix:string};
 const materials=new Map<string,Map<string,Entry>>(),images=new Map<string,string>(),files:Record<string,Buffer>={};
 const counts={basecolor:0,normal:0};
 const image=async(kind:'basecolor'|'normal',source:string)=>{
  let name=images.get(`${kind}:${source}`);
  if(!name){
   const bytes=await readFile(source);
   if(!bytes.subarray(0,8).equals(PNG))return undefined;
   name=`mesh_${kind}_${counts[kind]++}.png`;images.set(`${kind}:${source}`,name);files[name]=bytes;
  }
  return name;
 };
 const libraries:string[]=[];
 for(const line of meshTextLines(objBytes)){const name=materialLibrary(line);if(name)libraries.push(target(obj,name));}
 for(const library of new Set(libraries)){
  let current:Map<string,Entry>|undefined;
  for(const line of meshTextLines(await readFile(library))){
   const [directive,...values]=line.split(/\s+/);
   if(directive==='newmtl'){
    const name=line.slice(6).trim();if(!name)throw Error('Unnamed material');
    current=materials.has(name)?undefined:new Map();if(current)materials.set(name,current);continue;
   }
   if(!current)continue;
   const finite=values.length>0&&values.every(v=>Number.isFinite(Number(v)));
   if(VECTOR_VALUES.has(directive!)){
    if(values.length===3&&finite)current.set(directive!,{line:`${directive} ${values.join(' ')}`});
    else if(directive==='Kd')throw Error('Unsupported Kd');
   }else if(SCALAR_VALUES.has(directive!)){
    if(values.length===1&&finite)current.set(directive!,{line:`${directive} ${values[0]}`});
   }else if(directive==='map_Kd'){
    const map=textureMap(line);if(!map)throw Error('Unreadable map_Kd');
    const clamp=map.options.length===2&&map.options[0]==='-clamp'&&/^(on|off)$/.test(map.options[1]!)?map.options[1]:undefined;
    if(map.options.length&&!clamp)throw Error('Unsupported map_Kd options');
    current.set('map_Kd',{map:'basecolor',source:target(library,map.file),prefix:clamp?`-clamp ${clamp} `:''});
   }else if(/^(map_bump|bump|norm)$/i.test(directive!)){
    // The attempt's own normal map, when the grammar can carry it. One it can't is dropped on its own,
    // since readers would use it over any earlier one.
    const map=textureMap(line),[option,value]=map?.options??[];
    const kept=map&&(map.options.length===0||map.options.length===2&&(option==='-bm'&&Number.isFinite(Number(value))||option==='-clamp'&&/^(on|off)$/.test(value!)));
    if(kept)current.set('map_Bump',{map:'normal',source:target(library,map.file),prefix:map.options.length?`${option} ${value} `:''});
    else current.delete('map_Bump');
   }
   // Anything else (roughness or metal maps, reflection, spectral values) has no place in the grammar.
  }
 }
 const mtl:string[]=[];
 for(const [name,entries] of materials){
  mtl.push(`newmtl ${name}`);
  for(const entry of entries.values()){
   if('line' in entry){mtl.push(entry.line);continue;}
   const file=await image(entry.map,entry.source);
   // `bump`, not `map_Bump`: the phone's SceneKit importer loads only the former as the normal map.
   if(file)mtl.push(`${entry.map==='basecolor'?'map_Kd':'bump'} ${entry.prefix}${file}`);
   else if(entry.map==='basecolor')throw Error('Base colour is not a PNG');
   // A normal map that isn't a PNG is dropped; the colour stays.
  }
 }
 if(mtl.length)files['mesh.mtl']=Buffer.from(mtl.join('\n')+'\n');
 // Geometry: scale positions, keep every other line. One mtllib, only when a material survived.
 const lines:string[]=[],vertices:number[]=[],triangles:number[]=[];let library=false;
 const index=(token:string)=>{
  const raw=Number.parseInt(token.split('/')[0]!,10),count=vertices.length/3,i=raw<0?count+raw:raw-1;
  if(!Number.isSafeInteger(raw)||raw===0||i<0||i>=count)throw Error('Invalid OBJ face index');
  return i;
 };
 for(const line of meshTextLines(objBytes)){
  if(materialLibrary(line)!==undefined){if(!library&&files['mesh.mtl'])lines.push('mtllib mesh.mtl');library=true;continue;}
  const tokens=line.split(/\s+/);
  // With no surviving material there is no library, so a binding would point at nothing.
  if(tokens[0]==='usemtl'&&!files['mesh.mtl'])continue;
  if(tokens[0]==='v'){
   const xyz=[number(tokens[1]),number(tokens[2]),number(tokens[3])].map(v=>v*mmPerUnit);
   vertices.push(...xyz);lines.push(['v',...xyz.map(fixed),...tokens.slice(4)].join(' '));continue;
  }
  if(tokens[0]==='f'){
   const corners=tokens.slice(1).map(index);if(corners.length<3)throw Error('Degenerate OBJ face');
   if(corners.length>3&&!convex(corners,vertices))throw Error('Concave OBJ polygon');
   for(let k=1;k+1<corners.length;k++)triangles.push(corners[0]!,corners[k]!,corners[k+1]!);
   if(triangles.length/3>MAX_TRIANGLES)throw Error('Mesh has too many triangles');
  }
  lines.push(line);
 }
 if(!triangles.length)throw Error('Mesh has no faces');
 files['corrected.obj']=Buffer.from(lines.join('\n')+'\n');
 files['corrected.stl']=binaryStl(vertices,triangles);
 const total=Object.values(files).reduce((sum,b)=>sum+b.length,0);
 if(total>MAX_MESH_BYTES*2)throw Error('Export too large');
 await mkdir(out,{mode:0o700});
 const outputs:Record<string,string>={};
 for(const [name,bytes] of Object.entries(files)){await writeFile(join(out,name),bytes,{flag:'wx',mode:0o600});outputs[name]=sha(bytes);}
 // The check the publisher (KAN-141) and make-printable (KAN-185) apply: material names, bindings and
 // identities. Failing here lets the caller keep the captured scan instead of failing the job later.
 await readScanMaterials(out,files['corrected.obj'],outputs);
 return outputs;
}

/** A fan triangulates a polygon faithfully only when every turn goes the same way around its normal. */
function convex(corners:number[],vertices:number[]){
 const p=corners.map(i=>[vertices[3*i]!,vertices[3*i+1]!,vertices[3*i+2]!]);
 const sub=(a:number[],b:number[])=>a.map((v,k)=>v-b[k]!),cross=(a:number[],b:number[])=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!];
 const turns=p.map((v,i)=>cross(sub(v,p[(i+p.length-1)%p.length]!),sub(p[(i+1)%p.length]!,v)));
 // Newell normal: robust for any simple polygon.
 const n=[0,1,2].map(k=>p.reduce((sum,v,i)=>{const w=p[(i+1)%p.length]!,a=(k+1)%3,b=(k+2)%3;return sum+(v[a]!-w[a]!)*(v[b]!+w[b]!);},0));
 const dots=turns.map(t=>t[0]!*n[0]!+t[1]!*n[1]!+t[2]!*n[2]!),scale=Math.max(1e-30,...dots.map(Math.abs));
 return dots.every(d=>d>=-1e-9*scale);
}

function binaryStl(vertices:number[],triangles:number[]){
 const count=triangles.length/3,buffer=Buffer.alloc(84+50*count);
 buffer.write('scan-to-make ai-tweak export (mm)',0,'ascii');buffer.writeUInt32LE(count,80);
 for(let t=0;t<count;t++){
  const p=[0,1,2].map(k=>{const i=triangles[3*t+k]!*3;return [vertices[i]!,vertices[i+1]!,vertices[i+2]!];});
  const u=[0,1,2].map(k=>p[1]![k]!-p[0]![k]!),v=[0,1,2].map(k=>p[2]![k]!-p[0]![k]!);
  let n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];
  const length=Math.hypot(...n);n=length>0?n.map(c=>c/length):[0,0,0];
  let offset=84+50*t;
  for(const value of [...n,...p.flat()]){buffer.writeFloatLE(value,offset);offset+=4;}
 }
 return buffer;
}

/**
 * Write the correction directory the cleanup job reads: the exported bundle, attempt previews, a
 * one-line-per-step log and report.json with every file's hash and the job's AI record.
 */
export async function writeAiCorrection(options:{obj:string;mmPerUnit:number;out:string;record:AiTweakRecord;previews?:Partial<Record<(typeof AI_ATTEMPT_PREVIEW_NAMES)[number],string>>}){
 const record=AiTweakRecordSchema.parse(options.record);
 const outputs=await exportMeshBundle(options.obj,options.mmPerUnit,options.out);
 for(const [name,path] of Object.entries(options.previews??{})){
  if(!(AI_ATTEMPT_PREVIEW_NAMES as readonly string[]).includes(name)||!path)continue;
  let bytes:Buffer;try{bytes=await readFile(path);}catch{continue;}
  if(bytes.length>MAX_PREVIEW_BYTES||!bytes.subarray(0,8).equals(PNG))continue;
  await writeFile(join(options.out,name),bytes,{flag:'wx',mode:0o600});outputs[name]=sha(bytes);
 }
 const log=[...record.attempts.map(a=>JSON.stringify({step:'attempt',...a})),JSON.stringify({step:'pick',...record.pick})].join('\n')+'\n';
 await writeFile(join(options.out,'tool-calls.jsonl'),log,{flag:'wx',mode:0o600});
 const report={schema:AI_CLEANUP_SCHEMA,status:'complete',adapter:'ai-tweak',units:'mm',mmPerSourceUnit:options.mmPerUnit,outputs,toolLogSha256:sha(log),aiTweak:record};
 await writeFile(join(options.out,'report.json'),JSON.stringify(report,null,1)+'\n',{flag:'wx',mode:0o600});
 return report;
}

/**
 * After runAiTweak and pickAiTweak in `dir`: export the picked result into `out`. If the chosen attempt
 * can't be carried faithfully, the captured scan is exported instead and the record says so.
 */
export async function exportPicked(dir:string,manifest:AiTweakManifest,pick:PickResult,access:Exclude<ModelAccess,{kind:'none'}>,mmPerUnit:number,out:string,env:NodeJS.ProcessEnv=process.env){
 const secrets='keyEnv' in access&&access.keyEnv?[env[access.keyEnv]??'']:[];
 const inputObj=Object.keys(manifest.inputs).find(name=>name.toLowerCase().endsWith('.obj'));
 if(!inputObj)throw Error('Manifest has no captured OBJ');
 const captured=join(dir,'inputs',inputObj);
 const previews:Record<string,string>={};
 for(const candidate of pick.candidates)if(candidate.id!=='captured'&&!candidate.veto){
  const n=Number(candidate.id.slice('attempt-'.length));
  if(n>=1&&n<=4)previews[`ai-attempt-${n}-preview.png`]=join(dir,'pick','renders',candidate.id,PREVIEW_VIEW);
 }
 const chosen=pick.choice==='captured'?undefined:manifest.attempts.find(a=>`attempt-${a.index}`===pick.choice&&a.result);
 if(chosen){
  try{return await writeAiCorrection({obj:join(dir,chosen.result!.dir,chosen.result!.obj),mmPerUnit,out,record:aiTweakRecord(access,manifest,pick,secrets),previews});}
  catch{await rm(out,{recursive:true,force:true});}
  pick={...pick,choice:'captured',decidedBy:'fallback',reason:`The judge chose ${pick.choice}, but it couldn't be prepared for printing, so the captured scan is kept.`};
 }else if(pick.choice!=='captured')pick={...pick,choice:'captured',decidedBy:'fallback',reason:'The chosen attempt has no result, so the captured scan is kept.'};
 return writeAiCorrection({obj:captured,mmPerUnit,out,record:aiTweakRecord(access,manifest,pick,secrets),previews});
}
