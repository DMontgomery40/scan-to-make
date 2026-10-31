import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runMakePrintable} from '../dist/scan-printable.js';
import {readScanMaterials} from '../dist/scan-model-assets.js';
import {cube,png,sha} from './fixtures/scan-processing.mjs';
import {PrinterMcpClient} from '@scan-to-make/printer-handoff';
import {createScanCleanupRunner} from '../dist/scan-cleanup-runner.js';

test('real Blender preserves captured geometry and UVs while uniting shells', {skip:!process.env.BLENDER,timeout:120000},()=>{
 const result=spawnSync(process.env.BLENDER,['--background','--factory-startup','--python-exit-code','1','--threads','2','--python',
  fileURLToPath(new URL('../../../tools/scan-repair/tests/printable_geometry.py',import.meta.url))],{encoding:'utf8',timeout:110000,maxBuffer:2*1024*1024});
 assert.equal(result.status,0,result.stdout+result.stderr);
});

test('headless MCP cancellation stops its actual Blender child', {skip:!process.env.BLENDER,timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'printable-cancel-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const pidFile=join(root,'pid'),bridge=fileURLToPath(new URL('../python/headless_blender_mcp.py',import.meta.url));
 const client=new PrinterMcpClient({backend:'bambu-printer-mcp',process:{command:process.env.CAPTURE_TEST_PYTHON??'/usr/bin/python3',args:[bridge],env:{BLENDER_STM_EXECUTABLE:process.env.BLENDER}},timeouts:{toolMs:20000}});
 t.after(()=>client.close());await client.connect();
 const pending=client.callTool('execute_blender_code',{code:`import os,time\nopen(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\ntime.sleep(60)\n`}).catch(e=>e);
 let pid;
 for(let i=0;i<100;i++){try{pid=Number(await readFile(pidFile,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert(Number.isSafeInteger(pid)&&pid>0,'Blender wrote its real PID');
 await client.close();await pending;
 let alive=true;
 for(let i=0;i<100;i++){
  try{process.kill(pid,0);}catch{alive=false;break;}
  await new Promise(r=>setTimeout(r,50));
 }
 assert.equal(alive,false,'Blender must exit when the MCP session closes');
});

test('chosen PBR/normal material bytes survive, and unchecked maps fail closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'printable-material-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const obj=Buffer.from('mtllib mesh.mtl\n'+cube);
 const mtl=Buffer.from('newmtl picked\nKd .4 .2 .1\nPr .8\nmap_Kd mesh_basecolor_0.png\nmap_Bump -bm 1 mesh_normal_0.png\n');
 const files={'mesh.mtl':mtl,'mesh_basecolor_0.png':png,'mesh_normal_0.png':png};
 for(const [name,bytes] of Object.entries(files))await writeFile(join(root,name),bytes);
 const hashes=Object.fromEntries(Object.entries(files).map(([n,b])=>[n,sha(b)]));
 assert.deepEqual(await readScanMaterials(root,obj,hashes),files);
 await assert.rejects(readScanMaterials(root,Buffer.from('mtllib mesh.mtl\nusemtl lost_material\n'+cube),hashes));
 for(const separator of ['\r','\v','\f','\u001c','\u001d','\u001e','\u0085','\u2028','\u2029']){
  await assert.rejects(readScanMaterials(root,Buffer.from('#'+separator+'mtllib ../other.mtl\n'+cube),hashes));
  const hidden=Buffer.from('newmtl picked\n#'+separator+'map_Bump ../private.png');
  await writeFile(join(root,'mesh.mtl'),hidden);
  await assert.rejects(readScanMaterials(root,obj,{...hashes,'mesh.mtl':sha(hidden)}));
  await writeFile(join(root,'mesh.mtl'),mtl);
 }
 for(const bad of ['map_Bump ../private.png','map_Bump -bm NaN mesh_normal_0.png','refl mesh_normal_0.png','Pr texture.png']){
  const bytes=Buffer.from('newmtl picked\n'+bad);await writeFile(join(root,'mesh.mtl'),bytes);
  await assert.rejects(readScanMaterials(root,obj,{...hashes,'mesh.mtl':sha(bytes)}));
 }
});

test('make-printable commits only independently verified final bundles',async t=>{
 const root=await mkdtemp(join(tmpdir(),'printable-publish-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=join(root,'input');await mkdir(input);await writeFile(join(input,'corrected.obj'),cube);
 const repairTool=join(root,'external-tools','repair.py');
 const base={input,repairTool,hashes:{'corrected.obj':sha(cube)},blender:'/unused/blender',python:'/usr/bin/python3',signal:new AbortController().signal};
 for(const mode of ['ready','blocked','moved','stl-mismatch']){
  const output=join(root,mode),bambu={command:process.execPath,args:[fileURLToPath(new URL('./fixtures/printable-mcp.mjs',import.meta.url))],env:{PRINTABLE_FIXTURE:mode,PRINTABLE_EXPECT_REPAIR_DIR:join(root,'external-tools')}};
  if(['moved','stl-mismatch'].includes(mode)){
   await assert.rejects(runMakePrintable({...base,output,bambu}));
   await assert.rejects(readFile(join(output,'printable.json')));
  }else{
   const result=await runMakePrintable({...base,output,bambu});assert.equal(result.status,mode);
   if(mode==='ready')assert.equal(result.outputs['corrected.obj'],sha(cube));
   else {assert.deepEqual(result.outputs,{});await assert.rejects(readFile(join(output,'corrected.obj')));}
  }
 }
 await assert.rejects(runMakePrintable({...base,output:join(root,'forged'),hashes:{'corrected.obj':'f'.repeat(64)},bambu:{command:process.execPath}}),/identity mismatch/);
});

test('cleanup finalizes the selected correction before its publisher reads geometry',async t=>{
 const root=await mkdtemp(join(tmpdir(),'printable-cleanup-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx={source:join(root,'source'),imported:join(root,'imported'),repaired:join(root,'repaired'),advice:join(root,'advice'),corrected:join(root,'corrected'),stills:[],signal:new AbortController().signal};
 await mkdir(ctx.imported);
 const fake=join(root,'correct.py');
 await writeFile(fake,`import sys,json,hashlib,base64\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index('--out')+1]);p.mkdir()\na=base64.b64decode('${cube.toString('base64')}');b=b'original stl';log=b'{}\\n'\n(p/'corrected.obj').write_bytes(a);(p/'corrected.stl').write_bytes(b);(p/'tool-calls.jsonl').write_bytes(log)\n(p/'report.json').write_text(json.dumps({'status':'complete','outputs':{'corrected.obj':hashlib.sha256(a).hexdigest(),'corrected.stl':hashlib.sha256(b).hexdigest()},'toolLogSha256':hashlib.sha256(log).hexdigest()}))\n`);
 const runner=createScanCleanupRunner({blender:'/unused/blender',toolPath:fake,correctTool:fake,python:process.env.CAPTURE_TEST_PYTHON??'/usr/bin/python3',
  printable:{bambu:{command:process.execPath,args:[fileURLToPath(new URL('./fixtures/printable-mcp.mjs',import.meta.url))],env:{PRINTABLE_EXPECT_REPAIR_DIR:root}}}});
 await runner.cleanup.run('correct',ctx);
 assert.equal(ctx.corrected,join(root,'printable'));
 const r=JSON.parse(await readFile(join(ctx.corrected,'report.json'),'utf8'));
 assert.equal(r.makePrintable.status,'ready');assert.equal(r.outputs['corrected.stl'],sha(Buffer.from('synthetic-stl')));
 assert.equal(r.toolLogSha256,sha(await readFile(join(ctx.corrected,'tool-calls.jsonl'))));
});
