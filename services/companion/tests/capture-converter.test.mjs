import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readdir,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createCaptureConverter} from '../dist/capture-converter.js';
import {tempDir} from './support/temp.mjs';

async function fixture(t,body,options={}) {
 const root=await tempDir('capture-worker-test-');t.after(()=>rm(root,{recursive:true,force:true}));
 const jobs=join(root,'jobs');await mkdir(jobs);
 const script=join(root,'worker.mjs');
 await writeFile(script,`import fs from 'node:fs';\nconst args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:[...a,[v,all[i+1]]],[]));\n${body}`);
 return {root,jobs,worker:createCaptureConverter({executable:process.execPath,adapterPath:script,temporaryRoot:jobs,...options})};
}
async function waitForFile(path){
 for(let i=0;i<200;i++){try{return await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,10));}
 throw new Error('Fixture worker did not start');
}

test('timeout and cancellation kill the worker before removing its temporary directory',async t=>{
 const f=await fixture(t,"fs.writeFileSync(new URL('pid',import.meta.url),String(process.pid));setInterval(()=>{},1000);",{timeoutMs:2000});
 await assert.rejects(f.worker.convert(Buffer.from('source')),/timed out/);
 const pid=Number(await readFile(join(f.root,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.deepEqual(await readdir(f.jobs),[]);
 await rm(join(f.root,'pid'));
 const controller=new AbortController();const running=f.worker.convert(Buffer.from('source'),controller.signal);
 const nextPid=Number(await waitForFile(join(f.root,'pid')));controller.abort();
 await assert.rejects(running,/aborted/);assert.throws(()=>process.kill(nextPid,0),{code:'ESRCH'});
 assert.deepEqual(await readdir(f.jobs),[]);
});

test('excess diagnostics, worker exit failure and spawn failure fail closed and clean up',async t=>{
 for(const body of ["process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);","process.exit(2);"]){
  const f=await fixture(t,body);await assert.rejects(f.worker.convert(Buffer.from('source')),/failed/);assert.deepEqual(await readdir(f.jobs),[]);
 }
 const f=await fixture(t,'',{executable:'/missing-capture-test-executable'});
 await assert.rejects(f.worker.convert(Buffer.from('source')),/failed/);assert.deepEqual(await readdir(f.jobs),[]);
});

test('successful exit cannot authorize malformed, missing or symlinked output',async t=>{
 for(const body of [
  "fs.writeFileSync(args['--out'],'mesh');fs.writeFileSync(args['--report'],'{}');",
  "fs.symlinkSync(args['--source'],args['--out']);fs.writeFileSync(args['--report'],'{}');",
  "fs.writeFileSync(args['--out'],'mesh');",
 ]){
  const f=await fixture(t,body);await assert.rejects(f.worker.convert(Buffer.from('source')));assert.deepEqual(await readdir(f.jobs),[]);
 }
});

test('pre-aborted work creates no worker files',async t=>{
 const f=await fixture(t,"throw new Error('must not run');");const controller=new AbortController();controller.abort();
 await assert.rejects(f.worker.convert(Buffer.from('source'),controller.signal),/aborted/);assert.deepEqual(await readdir(f.jobs),[]);
});

// #852, review of #853: a big scan is read for its mesh alone, one at a time, and a converter stopped by the system says so.
test('geometry-only conversions run one at a time, a touch-up\'s and a seat check\'s alike (review of #853, P1-1)',async t=>{
 const {convertScanMesh,localConversionsPending}=await import('../dist/capture-converter.js');
 const {truncate}=await import('node:fs/promises');
 const root=await tempDir('capture-one-at-a-time-');t.after(()=>rm(root,{recursive:true,force:true}));
 const big=join(root,'scan.usdz');await writeFile(big,'');await truncate(big,33*1024*1024);   // sparse: only its size matters here
 let running=0,most=0;
 const converter={convert:async()=>{throw new Error('small path not expected');},
  convertLocalScan:async()=>{running++;most=Math.max(most,running);await new Promise(r=>setTimeout(r,20));running--;return {derived:Buffer.from('v 0 0 0\n'),report:Buffer.from('{}'),assets:{}};}};
 const results=await Promise.all([convertScanMesh(converter,big),convertScanMesh(converter,big),convertScanMesh(converter,big)]);
 assert.equal(most,1,'never two at once');
 assert.ok(results.every(r=>r.geometryOnly));
 assert.equal(localConversionsPending(),0);
 // One that fails lets the next one run.
 let calls=0;
 const flaky={convert:converter.convert,convertLocalScan:async()=>{if(++calls===1)throw new Error('first fails');return {derived:Buffer.from(''),report:Buffer.from('{}'),assets:{}};}};
 const [first,second]=await Promise.allSettled([convertScanMesh(flaky,big),convertScanMesh(flaky,big)]);
 assert.equal(first.status,'rejected');assert.equal(second.status,'fulfilled');
});

test('a converter stopped by the system names the signal, never an empty reason (review of #853, P3-3)',async t=>{
 const f=await fixture(t,"process.kill(process.pid,'SIGKILL');");
 const {truncate}=await import('node:fs/promises');
 const big=join(f.root,'scan.usdz');await writeFile(big,'');await truncate(big,40*1024*1024);
 await assert.rejects(f.worker.convertLocalScan(big),{message:/stopped by SIGKILL/});
});
