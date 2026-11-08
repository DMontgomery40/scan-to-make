import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModelSizeRunner,boxRotationDegrees} from '../dist/model-size-runner.js';
import {sha} from './fixtures/scan-processing.mjs';
import {tempDir} from './support/temp.mjs';
const identity=[[1,0,0],[0,1,0],[0,0,1]],quarter=[[0,-1,0],[1,0,0],[0,0,1]];
async function setup(t,mode='',rotate=false){
 const work=await tempDir('model-size-runner-');t.after(()=>rm(work,{recursive:true,force:true}));
 const log=join(work,'calls.jsonl'),bytes=Buffer.from(JSON.stringify({dim:rotate?[40,60,20]:[60,40,20],centre:[3,4,5]}));
 const input={bytes,sha256:sha(bytes),dimensionsMm:{length:60,width:40,height:20},rotation:rotate?quarter:identity};
 const run=createModelSizeRunner(async()=>({command:process.execPath,args:[fileURLToPath(new URL('./fixtures/model-size-mcp.mjs',import.meta.url))],env:{SIZE_LOG:log,SIZE_FIXTURE:mode}}));
 return {run,input,work,log};
}
test('MCP rotates into the recorded box and verifies a new scaled STL and viewer transform',async t=>{
 const f=await setup(t,'',true),factors={length:.96,width:1.02,height:1.01};
 const result=await f.run(f.input,factors,f.work,new AbortController().signal);
 assert.deepEqual(result.dimensionsMm,{length:57.599999999999994,width:40.8,height:20.2});
 assert.deepEqual(result.transform,{rotation:quarter,centreMm:[3,4,5],scaleFactors:factors});
 const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(c=>c.name),['get_stl_info','rotate_stl','get_stl_info','scale_stl','get_stl_info']);
 assert.equal(calls[3].scale_x,.96);assert.equal(calls[3].scale_y,1.02);assert.equal(calls[3].scale_z,1.01);
 assert.equal(sha(await readFile(calls[0].stl_path)),f.input.sha256);
});
for(const [mode,message] of [['mismatch',/dimensions disagree/],['escape',/outside operation/],['mutate',/changed the original/]])test(`MCP ${mode} cannot publish`,async t=>{
 const f=await setup(t,mode);await assert.rejects(f.run(f.input,{length:1,width:1,height:1},f.work,new AbortController().signal),message);
});
test('cancel closes a blocked MCP process',async t=>{
 const f=await setup(t,'hang'),abort=new AbortController();
 const result=f.run(f.input,{length:1,width:1,height:1},f.work,abort.signal);const rejected=assert.rejects(result);
 for(let i=0;;i++){const calls=await readFile(f.log,'utf8').catch(()=>'');if(calls.includes('scale_stl'))break;assert(i<100,'fixture did not reach scale');await new Promise(r=>setTimeout(r,20));}
 const pid=JSON.parse((await readFile(f.log,'utf8')).trim().split('\n').at(-1)).pid;
 abort.abort();await rejected;
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','runner must await the MCP child exit before its work directory can be removed');
});
test('XYZ conversion covers compound rotations and gimbal lock',()=>{
 const [x,y,z]=boxRotationDegrees([[0,0,1],[1,0,0],[0,1,0]]);assert.deepEqual([x,y,z],[90,90,0]);
 assert.deepEqual(boxRotationDegrees(identity),[-0,0,-0]);
});
