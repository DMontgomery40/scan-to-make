import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScanRunner} from '../dist/scan-processing.js';
const toolPath=fileURLToPath(new URL('./fixtures/scan-runner.py',import.meta.url));
test('subprocess timeout kills descendants; log and disk overflow also fail closed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'scan-runner-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const prior=process.env.SCAN_RUNNER_FIXTURE;t.after(()=>{if(prior===undefined)delete process.env.SCAN_RUNNER_FIXTURE;else process.env.SCAN_RUNNER_FIXTURE=prior;});
 for(const mode of ['wait','logs','disk']){
  process.env.SCAN_RUNNER_FIXTURE=mode;
  const runner=createScanRunner({blender:'/unused/operator/blender',toolPath,timeoutMs:mode==='wait'?200:3000});
  const output=join(root,mode),start=Date.now();
  await assert.rejects(runner.run('repair',join(root,'input'),output,join(root,'units'),new AbortController().signal));
  assert(Date.now()-start<2500);
 }
 await new Promise(r=>setTimeout(r,700));
 await assert.rejects(access(join(root,'wait','descendant-survived')));
});
