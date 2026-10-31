import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ModelSizeStore} from '../dist/model-size.js';
import {sizeFixture,fakeSizeRunner,dimensionsMm} from './fixtures/model-size.mjs';
const signal=()=>new AbortController().signal,authorize=async()=>{};
test('choices survive restart, retain immutable artifacts, and always scale the original',async t=>{
 const inputs=[],f=await sizeFixture(t,async(...args)=>{inputs.push(args[0].sha256);return fakeSizeRunner(...args);});
 assert.equal(f.original.uncertaintyMm,2);assert.equal(f.original.artifact,null);
 const first=await f.sizes.apply(f.input,f.job.jobId,f.request,signal(),authorize);
 const reopened=new ModelSizeStore(f.storage,f.store,join(f.root,'captures'),fakeSizeRunner);
 assert.deepEqual(await reopened.get(f.input,f.job.jobId),first);
 const measured=await f.sizes.apply(f.input,f.job.jobId,{expectedModelSha256:first.baseModelSha256,expectedSizeRevision:1,source:{kind:'measured',edge:'width',mm:50}},signal(),authorize);
 assert.equal(measured.dimensionsMm.width,50);assert.equal(measured.dimensionsMm.length,dimensionsMm.length*50/dimensionsMm.width);
 const reset=await f.sizes.apply(f.input,f.job.jobId,{expectedModelSha256:first.baseModelSha256,expectedSizeRevision:2,source:{kind:'scanned'}},signal(),authorize);
 assert.deepEqual(reset.dimensionsMm,dimensionsMm);assert.equal(reset.uncertaintyMm,2);assert.equal(reset.revision,3);
 assert.deepEqual(inputs,[first.baseModelSha256,first.baseModelSha256,first.baseModelSha256]);
 assert.equal((await f.sizes.artifact(f.input,f.job.jobId,first.artifact.id)).ref.sha256,first.artifact.sha256);
 const folder=join(f.root,'captures',f.input.captureId,'scan-processing',f.job.jobId,'sizes');
 assert.deepEqual((await readdir(join(folder,first.artifact.id))).sort(),['model.stl','record.json']);
 assert(!(await readdir(folder)).some(n=>n.startsWith('.work')));
 const oldJob=await f.store.load(f.input,f.job.jobId);assert.equal(oldJob.job.status,'succeeded');assert(!('size' in oldJob.job));
});
test('bad maker sizes and stale clients fail before invoking mesh tools',async t=>{
 let calls=0;const f=await sizeFixture(t,async(...args)=>{calls++;return fakeSizeRunner(...args);});
 for(const value of [{...f.request,expectedSizeRevision:1},{...f.request,expectedModelSha256:'0'.repeat(64)},{...f.request,dimensionsMm:{...f.request.dimensionsMm,height:100}}])await assert.rejects(f.sizes.apply(f.input,f.job.jobId,value,signal(),authorize));
 assert.equal(calls,0);
});
test('two competing saves publish exactly one revision',async t=>{
 let count=0,release,entered;const both=new Promise(r=>release=r),firstEntered=new Promise(r=>entered=r);
 const run=async(...args)=>{if(++count===2)release();else entered();await both;return fakeSizeRunner(...args);};
 const f=await sizeFixture(t,run),other=new ModelSizeStore(f.storage,f.store,join(f.root,'captures'),run);
 const first=f.sizes.apply(f.input,f.job.jobId,f.request,signal(),authorize);await firstEntered;
 const results=await Promise.allSettled([first,other.apply(f.input,f.job.jobId,f.request,signal(),authorize)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 assert.equal((await f.sizes.get(f.input,f.job.jobId)).revision,1);
});
for(const cause of ['cancel','revoke'])test(`${cause} during scaling leaves the previous choice intact`,async t=>{
 const abort=new AbortController();let revoked=false;
 const f=await sizeFixture(t,async(...args)=>{if(cause==='cancel')abort.abort();else revoked=true;return fakeSizeRunner(...args);});
 await assert.rejects(f.sizes.apply(f.input,f.job.jobId,f.request,abort.signal,async()=>{if(revoked)throw Error('revoked');}));
 assert.equal((await f.sizes.get(f.input,f.job.jobId)).revision,0);
 const folder=join(f.root,'captures',f.input.captureId,'scan-processing',f.job.jobId,'sizes');assert.deepEqual(await readdir(folder),[]);
});
for(const name of ['model.stl','record.json'])test(`reopen rejects changed ${name}`,async t=>{
 const f=await sizeFixture(t),result=await f.sizes.apply(f.input,f.job.jobId,f.request,signal(),authorize);
 const file=join(f.root,'captures',f.input.captureId,'scan-processing',f.job.jobId,'sizes',result.artifact.id,name);
 const bytes=await readFile(file);bytes[0]^=1;await writeFile(file,bytes);
 await assert.rejects(f.sizes.get(f.input,f.job.jobId),e=>e.code==='size-unavailable');
 await assert.rejects(f.sizes.artifact(f.input,f.job.jobId,result.artifact.id),e=>e.code==='size-unavailable');
});
