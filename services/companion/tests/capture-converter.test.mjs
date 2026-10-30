import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCaptureConverter} from '../dist/capture-converter.js';

async function fixture(t,body,options={}) {
 const root=await mkdtemp(join(tmpdir(),'capture-worker-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
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
