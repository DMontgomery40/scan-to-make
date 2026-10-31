import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createScanRunner} from '../dist/scan-processing.js';
import {fixture} from './fixtures/scan-processing.mjs';
const blender=process.env.BLENDER??'/Applications/Blender.app/Contents/MacOS/Blender';
let available=true;try{await access(blender);}catch{available=false;}
test('actual Blender 5.0.1: retained synthetic metric box, repair, measure, ten canonical PNGs',{skip:available?false:'Blender absent; set BLENDER to an absolute Blender 5.0.1 executable',timeout:600000},async t=>{
 assert.match(execFileSync(blender,['--version'],{encoding:'utf8'}),/^Blender 5\.0\.1/);
 const runner=createScanRunner({blender,toolPath:fileURLToPath(new URL('../../../tools/scan-repair/repair.py',import.meta.url))});
 const f=await fixture(t,runner);const {job}=await f.store.start({...f.input,request:{reference:{dimensionsMm:[60,40,20]}}});await f.store.wait();const saved=(await f.store.load(f.input,job.jobId)).job;
 assert.equal(saved.status,'succeeded',JSON.stringify(saved));assert.equal(Object.keys(saved.artifacts).length,13);for(const x of saved.comparison.errorMm)assert(Math.abs(x)<.01);
 for(const name of Object.keys(saved.artifacts))await f.store.artifact(f.input,job.jobId,name);
 // The recorded params must be what scan-repair actually ran.
 const {repair}=JSON.parse((await f.store.artifact(f.input,job.jobId,'report.json')).bytes.toString('utf8'));
 const denoise=repair.operations.find(o=>o.name==='denoise'),params=saved.stages[0].params;
 assert.deepEqual([denoise.iterations,denoise.factor,denoise.mu,denoise.maxDisplacementMm],[params.denoiseIterations,params.denoiseFactor,params.denoiseMu,params.denoiseMaxMm]);
});
