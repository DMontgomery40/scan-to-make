import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScanProcessingJobSchema,AI_ATTEMPT_PREVIEW_NAMES} from '@scan-to-make/contracts/scan-processing';
import {aiTweakRecord,exportMeshBundle,exportPicked,publicReason,writeAiCorrection} from '../dist/ai-tweak-export.js';
import {aiStageBudget,checkCleanupDisk,AI_AFTER_MS,AI_CLEANUP_JOB_MS} from '../dist/scan-cleanup-runner.js';
import {open} from 'node:fs/promises';
import {snapshotCaptureMaterials} from '../dist/capture-import.js';

const PNG=[137,80,78,71,13,10,26,10];
const png=n=>Buffer.from([...PNG,n,n,n]);

async function dir(t){const root=await mkdtemp(join(tmpdir(),'ai-export-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
/** Run the exported bundle through the same check the /model-assets publisher (KAN-141) applies. */
async function publisherCheck(out,outputs){
 const assets={},manifest=[];
 for(const [name,sha256] of Object.entries(outputs))if(/^mesh(?:\.mtl|_basecolor_[0-9]+\.png)$/.test(name)){
  const bytes=await readFile(join(out,name));assets[name]=bytes;manifest.push({path:name,bytes:bytes.length,sha256});
 }
 return snapshotCaptureMaterials(await readFile(join(out,'corrected.obj')),Buffer.from(JSON.stringify({outputs:manifest})),assets);
}

test('an attempt bundle exports in mm with base-colour materials only, UVs and image bytes unchanged',async t=>{
 const root=await dir(t),bundle=join(root,'attempt'),out=join(root,'out');await mkdir(join(bundle,'tex'),{recursive:true});
 // Two libraries (one by absolute path), a normal map, a clamp option, an untextured material, vertex colours, quads and negative indices.
 const uv=['vt 0.125 0.25','vt 0.5 0.75','vt 1 0','vt 0.0001 0.9999'];
 await writeFile(join(bundle,'mesh.obj'),[`mtllib body.mtl`,`mtllib ${join(bundle,'eyes.mtl')}`,'o thing',
  'v 0.001 0.002 0.003 0.5 0.5 0.5','v 0.01 0 0','v 0 0.01 0','v 0.01 0.01 0',...uv,'vn 0 0 1',
  'usemtl body','f 1/1/1 2/2/1 4/4/1 3/3/1','usemtl eye','f -4//1 -3//1 -1//1','usemtl eye','f 2 3 4',''].join('\n'));
 await writeFile(join(bundle,'body.mtl'),'newmtl body\nNs 250\nKa 1 1 1\nKd 0.8 0.7 0.6\nmap_Kd -clamp on tex/body color.png\nmap_Bump -bm 1.0 tex/normal.png\nmap_Ns rough.png\n');
 await writeFile(join(bundle,'eyes.mtl'),'newmtl eye\nKd 0.05 0.05 0.05\nd 1\nnewmtl body\nKd 1 0 0\n');
 await writeFile(join(bundle,'tex','body color.png'),png(1));await writeFile(join(bundle,'tex','normal.png'),png(2));await writeFile(join(bundle,'rough.png'),png(3));
 const outputs=await exportMeshBundle(join(bundle,'mesh.obj'),1000,out);
 assert.deepEqual(Object.keys(outputs).sort(),['corrected.obj','corrected.stl','mesh.mtl','mesh_basecolor_0.png']);
 assert.equal(await readFile(join(out,'mesh.mtl'),'utf8'),'newmtl body\nKd 0.8 0.7 0.6\nmap_Kd -clamp on mesh_basecolor_0.png\nnewmtl eye\nKd 0.05 0.05 0.05\n');
 assert.deepEqual(await readFile(join(out,'mesh_basecolor_0.png')),png(1));
 const obj=(await readFile(join(out,'corrected.obj'),'utf8')).split('\n');
 assert.equal(obj.filter(l=>l.startsWith('mtllib')).join(),'mtllib mesh.mtl');
 assert.deepEqual(obj.filter(l=>l.startsWith('vt ')),uv);
 assert.deepEqual(obj.filter(l=>l.startsWith('v ')),['v 1 2 3 0.5 0.5 0.5','v 10 0 0','v 0 10 0','v 10 10 0']);
 assert.deepEqual(obj.filter(l=>/^(f|usemtl|vn|o) /.test(l)),['o thing','vn 0 0 1','usemtl body','f 1/1/1 2/2/1 4/4/1 3/3/1','usemtl eye','f -4//1 -3//1 -1//1','usemtl eye','f 2 3 4']);
 const stl=await readFile(join(out,'corrected.stl'));
 assert.equal(stl.readUInt32LE(80),4);assert.equal(stl.length,84+50*4);
 // Third triangle is the face `-4 -3 -1` = vertices 1, 2, 4.
 assert.deepEqual([0,1,2].map(k=>stl.readFloatLE(84+100+12+4*k)),[1,2,3].map(v=>Math.fround(v)));
 assert.ok(await publisherCheck(out,outputs));
});

test('the captured converter bundle round-trips through export and the publisher check',async t=>{
 const root=await dir(t),bundle=join(root,'imported'),out=join(root,'out');await mkdir(bundle);
 await writeFile(join(bundle,'mesh.obj'),'mtllib mesh.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl material_0\nf 1/1 2/2 3/3\n');
 await writeFile(join(bundle,'mesh.mtl'),'newmtl material_0\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n');
 await writeFile(join(bundle,'mesh_basecolor_0.png'),png(9));
 const outputs=await exportMeshBundle(join(bundle,'mesh.obj'),1000,out);
 assert.equal(await readFile(join(out,'mesh.mtl'),'utf8'),'newmtl material_0\nKd 1 1 1\nmap_Kd mesh_basecolor_0.png\n');
 assert.ok(await publisherCheck(out,outputs));
});

test('export fails on what the base-colour grammar cannot carry, and drops an empty library',async t=>{
 const root=await dir(t);let n=0;
 const attempt=async(mtl,files={})=>{
  const bundle=join(root,`b${++n}`);await mkdir(bundle);
  await writeFile(join(bundle,'mesh.obj'),'mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nusemtl a\nf 1/1 2/1 3/1\n');await writeFile(join(bundle,'m.mtl'),mtl);
  for(const [name,bytes] of Object.entries(files))await writeFile(join(bundle,name),bytes);
  return exportMeshBundle(join(bundle,'mesh.obj'),1000,join(root,`out${n}`));
 };
 await assert.rejects(attempt('newmtl a\nmap_Kd -s 2 2 1 c.png\n',{'c.png':png(1)}),/options/);
 await assert.rejects(attempt('newmtl a\nmap_Kd c.jpg\n',{'c.jpg':Buffer.from([0xff,0xd8,0xff,0xe0])}),/PNG/);
 await assert.rejects(attempt('newmtl a\nmap_Kd ../outside.png\n'),/outside|missing/);
 // A concave polygon can't be fan-triangulated into the STL faithfully; a convex one can.
 const polygon=async(xy)=>{const b=join(root,`p${++n}`);await mkdir(b);
  await writeFile(join(b,'mesh.obj'),xy.map(([x,y])=>`v ${x} ${y} 0`).join('\n')+`\nf ${xy.map((_,i)=>i+1).join(' ')}\n`);
  return exportMeshBundle(join(b,'mesh.obj'),1,join(root,`out${n}`));};
 await assert.rejects(polygon([[0,0],[3,0],[3,3],[2,3],[2,1],[1,1],[1,3],[0,3]]),/Concave/);
 assert.ok((await polygon([[0,0],[2,0],[3,1],[2,2],[0,2]]))['corrected.stl']);
 // What the publisher and make-printable would reject never leaves the export.
 await assert.rejects(attempt('newmtl my material\nKd 1 1 1\n'),/material/i);
 const dangling=join(root,`b${++n}`);await mkdir(dangling);
 await writeFile(join(dangling,'mesh.obj'),'mtllib m.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl a\nf 1 2 3\nusemtl ghost\nf 1 2 3\n');await writeFile(join(dangling,'m.mtl'),'newmtl a\nKd 1 1 1\n');
 await assert.rejects(exportMeshBundle(join(dangling,'mesh.obj'),1000,join(root,`out${n}`)),/material/i);
 const outputs=await attempt('# only comments\n');
 assert.deepEqual(Object.keys(outputs).sort(),['corrected.obj','corrected.stl']);
 assert(!/mtllib|usemtl/.test(await readFile(join(root,`out${n}`,'corrected.obj'),'utf8')));
});

test('a chosen attempt that cannot be exported falls back to the captured scan, and says so',async t=>{
 const root=await dir(t),run=join(root,'run');
 await mkdir(join(run,'inputs'),{recursive:true});await mkdir(join(run,'attempt-1','result'),{recursive:true});
 await writeFile(join(run,'inputs','mesh.obj'),'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
 await writeFile(join(run,'attempt-1','result','t.obj'),'mtllib t.mtl\nv 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n');
 await writeFile(join(run,'attempt-1','result','t.mtl'),'newmtl a\nmap_Kd c.jpg\n');await writeFile(join(run,'attempt-1','result','c.jpg'),'jpeg');
 await mkdir(join(run,'pick','renders','attempt-1'),{recursive:true});await writeFile(join(run,'pick','renders','attempt-1','textured_iso_front_left.png'),png(4));
 const manifest={inputs:{'mesh.obj':{}},attempts:[{index:1,outcome:'changed',wallMs:61234.4,result:{dir:'attempt-1/result',obj:'t.obj'},finalMessage:'secret words',logs:{transcript:'/private/log'}},{index:2,outcome:'auth-failed',wallMs:900}]};
 const pick={choice:'attempt-1',decidedBy:'judge',reason:'The knit relief matches the photos.',candidates:[{id:'captured'},{id:'attempt-1',label:'A'}]};
 const report=await exportPicked(run,manifest,pick,{kind:'claude-code',model:'claude-opus-5-5'},1000,join(root,'out'));
 assert.deepEqual(report.aiTweak.pick.choice,'captured');assert.equal(report.aiTweak.pick.decidedBy,'fallback');assert.match(report.aiTweak.pick.reason,/attempt-1.*captured scan is kept/);
 assert.deepEqual(report.aiTweak.attempts,[{index:1,outcome:'changed',wallMs:61234},{index:2,outcome:'auth-failed',wallMs:900}]);
 assert.deepEqual(report.aiTweak.access,{kind:'claude-code',model:'claude-opus-5-5'});
 assert.equal((await readFile(join(root,'out','corrected.obj'),'utf8')).split('\n')[1],'v 1000 0 0');
 // The rendered attempt still gets its preview for "see other attempts".
 assert.deepEqual(await readFile(join(root,'out','ai-attempt-1-preview.png')),png(4));
 const text=JSON.stringify(report)+await readFile(join(root,'out','tool-calls.jsonl'),'utf8');
 assert(!text.includes(root)&&!text.includes('secret words')&&!text.includes('/private/log'));
});

test('AI budgets fit inside the job deadline and leave time for measure, render and publication',()=>{
 for(const kind of ['claude-code','codex-cli','api','endpoint'])for(const used of [0,3,9,15,20,30]){
  const remaining=AI_CLEANUP_JOB_MS-used*60000,b=aiStageBudget(remaining,kind);
  // Only a job that is already late skips the AI step.
  if(!b){assert(remaining-AI_AFTER_MS<25*60000,`${kind} ${used}`);continue;}
  assert(b.stageMs+AI_AFTER_MS<=remaining,`${kind} ${used}`);
  assert(b.warmupMs+b.attemptMs+b.pickMs+b.judgeMs<b.stageMs,`${kind} ${used}`);
  assert(b.attemptMs>=5*60000&&b.attemptMs<=30*60000&&b.judgeMs<=12*60000);
 }
 assert.equal(aiStageBudget(AI_AFTER_MS+5*60000,'claude-code'),undefined);
 assert.equal(aiStageBudget(AI_CLEANUP_JOB_MS-60000,'claude-code').stageMs,45*60000);
});

test('a worst-case AI job record fits the job record read',()=>{
 const sha='a'.repeat(64),art={sha256:sha,byteLength:1,mediaType:'image/png'};
 const reason='"Quoted"\n\\ and   newlines '.repeat(200).slice(0,4000);
 const job={schema:'scan-to-make.scan-processing/0.1',jobId:'00000000-0000-4000-8000-000000000001',projectId:'p',projectRevision:1,captureId:'00000000-0000-4000-8000-000000000002',status:'succeeded',previewOnly:true,
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
  aiTweak:aiTweakRecord({kind:'endpoint',url:'https://models.example/v1',model:'some/model-name:latest',keyEnv:'SCAN_TO_MAKE_MODEL_KEY'},
   {attempts:[1,2,3,4].map(index=>({index,outcome:'changed',wallMs:1799999}))},{choice:'attempt-3',decidedBy:'judge',reason,candidates:[1,2].map(n=>({id:`attempt-${n}`,veto:{reason:'squashed-or-stretched'}}))})};
 assert.deepEqual(job.aiTweak.access,{kind:'endpoint',model:'some/model-name:latest'});
 assert(!JSON.stringify(job.aiTweak).includes('example'));
 const names=['repaired.stl','repaired.obj','report.json','corrected.stl','corrected.obj','correction.json','correction-calls.jsonl','advice.json','advice-01.png','advice-02.png','advice-03.png','advice-04.png',...AI_ATTEMPT_PREVIEW_NAMES];
 const parsed=ScanProcessingJobSchema.shape.aiTweak.parse(job.aiTweak);
 const stills=Array.from({length:24},(_,i)=>({id:`00000000-0000-4000-8000-0000000000${String(i).padStart(2,'0')}`,sha256:sha,byteLength:30*1024*1024,mediaType:'image/jpeg',label:'\ud800'.repeat(200),capturedAt:new Date().toISOString(),ordinal:i}));
 const size=Buffer.byteLength(JSON.stringify({...job,aiTweak:parsed,detailStills:stills,artifacts:Object.fromEntries(names.map(n=>[n,art])),
  stages:Array(3).fill({kind:'repair',status:'succeeded',params:{},startedAt:job.createdAt,finishedAt:job.createdAt}),
  pipelineStages:Array(6).fill({kind:'import',status:'succeeded',startedAt:job.createdAt,finishedAt:job.createdAt})}));
 assert(size<256*1024,`${size} bytes`);
});

test('the judge reason is scrubbed of paths, credentials and the key before it is public',()=>{
 const reason='Candidate A at /private/var/folders/xy/stm-ai-judge-1/candidates/A and ~/Desktop/x.png keeps 3/4 of the knit; key sk-ant-api03-abcdefgh12345678 or MYSECRETVALUE123 \u0007bell.';
 const out=publicReason(reason,['MYSECRETVALUE123']);
 assert.equal(out,'Candidate A at [path] and [path] keeps 3/4 of the knit; key [redacted] or [redacted]  bell.');
 const record=aiTweakRecord({kind:'api',provider:'anthropic',keyEnv:'K'},undefined,{choice:'captured',decidedBy:'judge',reason},['MYSECRETVALUE123']);
 assert(!/private|sk-ant|MYSECRET/.test(record.pick.reason));
});

test('close-ups count against their own allowance, not the worker output budget',async t=>{
 const root=await dir(t),big=await open(join(root,'still.img'),'w');await big.truncate(513*1024*1024);await big.close();
 await assert.rejects(checkCleanupDisk(root),/budget/);
 await checkCleanupDisk(root,2*1024*1024);
});
