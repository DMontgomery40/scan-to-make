import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod,copyFile,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {JUDGE_PROMPT,pickAiTweak,vetoFor} from '../dist/ai-tweak-pick.js';
import {tempDir} from './support/temp.mjs';

const run=promisify(execFile);
const blender=process.env.BLENDER,python=process.env.CAPTURE_TEST_PYTHON??'python3';
const toolDir=fileURLToPath(new URL('../../../tools/ai-tweak-judge/',import.meta.url));

/** A closed 60 mm textured cube in mm; `transform` reshapes it and `colour` repaints its texture. */
async function cube(dir,{transform=p=>p,colour='red'}={}){
 await mkdir(dir,{recursive:true});
 const v=[[0,0,0],[60,0,0],[60,60,0],[0,60,0],[0,0,60],[60,0,60],[60,60,60],[0,60,60]].map(transform);
 const faces=[[1,3,2],[1,4,3],[5,6,7],[5,7,8],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,4,8],[3,8,7],[4,1,5],[4,5,8]];
 await writeFile(join(dir,'mesh.obj'),'mtllib mesh.mtl\n'+v.map(p=>`v ${p.join(' ')}`).join('\n')+'\nvt 0 0\nvt 1 0\nvt 1 1\nusemtl m\n'+faces.map(f=>`f ${f[0]}/1 ${f[1]}/2 ${f[2]}/3`).join('\n')+'\n');
 await writeFile(join(dir,'mesh.mtl'),'newmtl m\nmap_Kd mesh_basecolor_0.png\n');
 await run(python,['-c',`from PIL import Image\nImage.new('RGB',(16,16),'${colour}').save('${join(dir,'mesh_basecolor_0.png')}')`]);
}

async function fixture(t,attempts,{photos=1}={}){
 const root=await tempDir('ai-pick-test-');t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'tweak');await cube(join(dir,'inputs'));
 const inputs={'mesh.obj':{},'mesh.mtl':{},'mesh_basecolor_0.png':{}};
 if(photos){await run(python,['-c',`from PIL import Image\nImage.new('RGB',(32,24),'red').save('${join(dir,'inputs','still_00_0123abcd.jpg')}')`]);inputs['still_00_0123abcd.jpg']={};}
 const manifest={schema:'scan-to-make.ai-tweak/0.1',prompt:'x',access:{kind:'claude-code'},inputs,attempts:[]};
 for(const [i,shape] of attempts.entries()){
  const index=i+1;await cube(join(dir,`attempt-${index}`,'result'),shape);
  manifest.attempts.push({index,outcome:'changed',result:{dir:`attempt-${index}/result`,obj:'mesh.obj',sourcePath:'mesh.obj',files:{}},finalMessage:`attempt ${index} says it did great`});
 }
 await writeFile(join(dir,'ai-tweak.json'),JSON.stringify(manifest));
 return {root,dir,record:join(root,'judge-record.json')};
}

/** A stand-in judge CLI: records what it was shown, then writes `verdict` (or fails). */
async function judge(f,{verdict,exitCode=0,isError=exitCode!==0,sleepMs=0}={}){
 const path=join(f.root,'claude');
 await writeFile(path,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]==='--version'){console.log('fake');process.exit(0);}
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)).map(n=>e.name+'/'+n):[e.name]);
fs.writeFileSync(${JSON.stringify(f.record)},JSON.stringify({prompt:process.argv[3],files:walk('.').sort()}));
if(${sleepMs})Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${sleepMs});
if(${JSON.stringify(verdict)}!==undefined)fs.writeFileSync('verdict.json',JSON.stringify(${JSON.stringify(verdict)}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:${isError?'true':'false'},result:'done'}));
process.exitCode=${exitCode};
`);await chmod(path,0o755);return path;
}

const options=(f,extra)=>({access:{kind:'claude-code'},blender,python,toolDir,mmPerUnit:1,resolution:96,requireGuiSession:false,
 env:{HOME:f.root,PATH:'/usr/bin:/bin'},seed:'fixed',...extra});

test('the geometry veto names smoothing and uniform squashes, and passes texture-only and unseen-side edits',()=>{
 const m=(p50,box,back=p50)=>({reference:{bboxMm:[60,75,50]},candidate:{bboxMm:box},capturedToCandidate:{p50Mm:p50},candidateToCaptured:{p50Mm:back}});
 // KAN-177 runs: Claude 2 squashed the whole object; B1 smoothed it; Codex 1 trimmed only the unseen underside.
 assert.equal(vetoFor(m(1.697,[60,75,46.78])).reason,'squashed-or-stretched');
 assert.equal(vetoFor(m(0.0605,[59.66,74.76,47.68])).reason,'smoothed');
 assert.equal(vetoFor(m(0,[60,75,46.58])),undefined);
 assert.equal(vetoFor(m(0.0003,[60,75,49.18])),undefined);
 assert.equal(vetoFor(m(0.9,[60,75,50])).reason,'reshaped');
 // An outward stretch leaves captured points on the stretched faces: only the reverse median sees it.
 assert.equal(vetoFor(m(0,[66,75,50],6)).reason,'squashed-or-stretched');
});

test('pick: vetoes, blind shuffled labels, photos and renders only, and the judge decides',{skip:!blender&&'needs BLENDER'},async t=>{
 const f=await fixture(t,[
  {transform:([x,y,z])=>[x,y,z*0.93]},               // uniform squash: vetoed
  {colour:'blue'},                                    // texture-only edit: judged
  {transform:([x,y,z])=>[x+0.3,y-0.3,z+0.3]}]);       // every captured point moved: vetoed
 const first=await pickAiTweak(f.dir,options(f,{claudePath:await judge(f,{verdict:{choice:'A',reason:'A matches the photos.'}})}));
 const byId=Object.fromEntries(first.candidates.map(c=>[c.id,c]));
 assert.equal(byId['attempt-1'].veto.reason,'squashed-or-stretched');
 assert.ok(byId['attempt-3'].veto);assert.equal(byId['attempt-2'].veto,undefined);
 assert.deepEqual(first.candidates.filter(c=>c.label).map(c=>c.label).sort(),['A','B']);
 assert.equal(first.choice,first.candidates.find(c=>c.label==='A').id,JSON.stringify({reason:first.reason,error:first.error,judge:first.judge}));assert.equal(first.decidedBy,'judge');
 const seen=JSON.parse(await readFile(f.record,'utf8'));
 assert.equal(seen.prompt,JUDGE_PROMPT);
 // Only photos and renders: no manifest, transcripts, meshes or an attempt's own account of itself.
 assert.ok(seen.files.every(n=>/^(photos\/still_\d{2}_[0-9a-f]{8}\.jpg|candidates\/[AB]\/(textured|grey)_\w+\.png|compare\/compare_(textured|grey)_\w+\.png|verdict\.json)$/.test(n)),seen.files.join());
 assert.ok(seen.files.includes('candidates/A/grey_ring_00.png'));
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'pick.json'),'utf8')),JSON.parse(JSON.stringify(first)));
 // The label order depends on the seed, and the verdict always maps back through it.
 const orders=new Set();
 for(const seed of ['s1','s2','s3','s4','s5','s6']){
  await rm(join(f.dir,'pick'),{recursive:true});
  const r=await pickAiTweak(f.dir,options(f,{seed,claudePath:await judge(f,{verdict:{choice:'B',reason:'B is closer.'}})}));
  orders.add(r.candidates.filter(c=>c.label).map(c=>c.id+c.label).join());assert.equal(r.choice,r.candidates.find(c=>c.label==='B').id);
 }
 assert.equal(orders.size,2);
});

test('pick keeps the captured scan when the judge fails, answers badly, or every attempt is vetoed',{skip:!blender&&'needs BLENDER'},async t=>{
 const f=await fixture(t,[{colour:'blue'}]);
 const again=async extra=>{await rm(join(f.dir,'pick'),{recursive:true,force:true});return pickAiTweak(f.dir,options(f,extra));};
 let r=await again({claudePath:await judge(f,{verdict:{choice:'A',reason:'x'},exitCode:1})});
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);
 r=await again({claudePath:await judge(f,{verdict:{choice:'Z',reason:'no such letter'}})});
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);
 r=await again({claudePath:await judge(f,{})});
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);
 // A CLI that reports an error but exits 0 isn't a usable judgement, even with a verdict on disk.
 r=await again({claudePath:await judge(f,{verdict:{choice:'A',reason:'x'},isError:true})});
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);
 // "none" is the judge's own way to keep the captured scan (a tie, or the capture can't be told apart).
 r=await again({claudePath:await judge(f,{verdict:{choice:'none',reason:'No candidate is clearly closer.'}})});
 assert.deepEqual([r.choice,r.decidedBy,r.reason],['captured','judge','No candidate is clearly closer.']);
 r=await again({access:{kind:'none'}});
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);assert.match(r.reason,/No model/,JSON.stringify({error:r.error}));
 const g=await fixture(t,[{transform:([x,y,z])=>[x*1.1,y,z]}]);
 await rm(g.record,{force:true});
 r=await pickAiTweak(g.dir,options(g,{claudePath:await judge(g,{verdict:{choice:'A',reason:'x'}})}));
 assert.deepEqual([r.choice,r.decidedBy],['captured','veto']);assert.match(r.reason,/Every attempt was rejected/);
 await assert.rejects(readFile(g.record));
});

test('the shared frame fits a long object, and a textured part keeps texture next to an untextured one',{skip:!blender&&'needs BLENDER'},async t=>{
 const root=await tempDir('ai-render-test-');t.after(()=>rm(root,{recursive:true,force:true}));
 await cube(join(root,'long'),{transform:([x,y,z])=>[x/6,y/6,z*100/60]});   // 10 x 10 x 100 mm
 await run(blender,['-b','--factory-startup','-P',join(toolDir,'render.py'),'--','--mesh',join(root,'long','mesh.obj'),'--cams',join(root,'cams.json'),'--out',join(root,'r1'),'--resolution','64','--make-cams','--ring']);
 const cams=JSON.parse(await readFile(join(root,'cams.json'),'utf8'));
 assert.ok(cams.orthoScale>=100,`frame ${cams.orthoScale} mm clips a 100 mm object`);
 await cube(join(root,'mixed'));
 await writeFile(join(root,'mixed','mesh.obj'),(await readFile(join(root,'mixed','mesh.obj'),'utf8'))+'o patch\nv 0 0 70\nv 10 0 70\nv 0 10 70\nf 9 10 11\n');
 await run(blender,['-b','--factory-startup','-P',join(toolDir,'render.py'),'--','--mesh',join(root,'mixed','mesh.obj'),'--cams',join(root,'cams2.json'),'--out',join(root,'r2'),'--resolution','64','--make-cams']);
 assert.equal(JSON.parse(await readFile(join(root,'r2','render.json'),'utf8')).textured,true);
});

test('pick: incomplete renders, cancellation, no photos and reruns',{skip:!blender&&'needs BLENDER'},async t=>{
 const f=await fixture(t,[{colour:'blue'}]);
 // A rerun works without clearing pick/ first.
 const verdict={verdict:{choice:'A',reason:'A is closer.'}};
 await pickAiTweak(f.dir,options(f,{claudePath:await judge(f,verdict)}));
 const again=await pickAiTweak(f.dir,options(f,{claudePath:await judge(f,verdict)}));assert.equal(again.decidedBy,'judge');
 // A render script that writes a partial set and then raises fails the run (--python-exit-code), and the captured scan is kept.
 const broken=join(f.root,'broken-tool');await mkdir(broken);
 for(const name of ['measure.py','sheet.py'])await copyFile(join(toolDir,name),join(broken,name));
 await writeFile(join(broken,'render.py'),"import os,sys,json\nargv=sys.argv[sys.argv.index('--')+1:]\nout=argv[argv.index('--out')+1]\nos.makedirs(out,exist_ok=True)\nopen(os.path.join(out,'textured_front.png'),'wb').write(b'x')\njson.dump({'images':['textured_front.png']},open(os.path.join(out,'render.json'),'w'))\nraise RuntimeError('render failed half way')\n");
 let r=await pickAiTweak(f.dir,options(f,{toolDir:broken,claudePath:await judge(f,verdict)}));
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);assert.match(r.reason,/could not be rendered/);
 // Cancelling while the judge runs rejects; it is never reported as a pick.
 await rm(f.record,{force:true});
 const controller=new AbortController();
 const pending=pickAiTweak(f.dir,options(f,{signal:controller.signal,claudePath:await judge(f,{...verdict,sleepMs:60000})}));
 for(let i=0;i<600;i++){try{await stat(f.record);break;}catch{await new Promise(ok=>setTimeout(ok,100));}}
 controller.abort();
 await assert.rejects(pending);
 // No photos: nothing to compare against, so the judge is never asked.
 const g=await fixture(t,[{colour:'blue'}],{photos:0});
 r=await pickAiTweak(g.dir,options(g,{claudePath:await judge(g,verdict)}));
 assert.deepEqual([r.choice,r.decidedBy],['captured','fallback']);assert.match(r.reason,/no close-up photos/);
 await assert.rejects(readFile(g.record));
});
