import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {downloadArtifact} from '../dist/dependencies-download.js';

const bytes=Buffer.from('a verified dependency archive');
const integrity='sha256-'+createHash('sha256').update(bytes).digest('base64');
async function fixture(t,handle){
 const dir=await mkdtemp(join(tmpdir(),'stm-download-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const server=createServer(handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 return {path:join(dir,'archive'),artifact:{url:`http://127.0.0.1:${server.address().port}/file`,integrity,maxBytes:1024}};
}
test('resumes retained bytes with Range and verifies the combined archive before publishing',async t=>{
 const ranges=[],progress=[];
 const f=await fixture(t,(req,res)=>{ranges.push(req.headers.range);res.writeHead(206,{'Content-Range':`bytes 8-${bytes.length-1}/${bytes.length}`});res.end(bytes.subarray(8));});
 await writeFile(f.path+'.part',bytes.subarray(0,8));
 await downloadArtifact(f.artifact,f.path,{onProgress:(done,total)=>progress.push([done,total])});
 assert.deepEqual(ranges,['bytes=8-']);assert.deepEqual(await readFile(f.path),bytes);
 assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);
 await assert.rejects(stat(f.path+'.part'),{code:'ENOENT'});
});
test('a server ignoring Range replaces the partial instead of appending corrupt bytes',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(bytes));await writeFile(f.path+'.part',bytes.subarray(0,8));
 await downloadArtifact(f.artifact,f.path);assert.deepEqual(await readFile(f.path),bytes);
});
test('interruption retains a resumable partial, and a later request completes it',async t=>{
 let requests=0;
 const f=await fixture(t,(req,res)=>{
  if(requests++===0){res.writeHead(200,{'Content-Length':bytes.length});res.write(bytes.subarray(0,8));setTimeout(()=>res.destroy(),20);}
  else {assert.equal(req.headers.range,'bytes=8-');res.writeHead(206,{'Content-Range':`bytes 8-${bytes.length-1}/${bytes.length}`});res.end(bytes.subarray(8));}
 });
 await assert.rejects(downloadArtifact(f.artifact,f.path));assert.equal((await stat(f.path+'.part')).size,8);
 await downloadArtifact(f.artifact,f.path);assert.deepEqual(await readFile(f.path),bytes);
});
test('hash mismatch removes poisoned partial so Try again can download clean bytes',async t=>{
 let bad=true;const f=await fixture(t,(_req,res)=>res.end(bad?Buffer.from('bad'):bytes));
 await assert.rejects(downloadArtifact(f.artifact,f.path),/integrity/);await assert.rejects(stat(f.path+'.part'),{code:'ENOENT'});
 bad=false;await downloadArtifact(f.artifact,f.path);assert.deepEqual(await readFile(f.path),bytes);
});
test('wrong resume range is refused without losing verified prefix',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(206,{'Content-Range':`bytes 0-${bytes.length-1}/${bytes.length}`});res.end(bytes);});
 await writeFile(f.path+'.part',bytes.subarray(0,8));
 await assert.rejects(downloadArtifact(f.artifact,f.path),/range/);assert.equal((await stat(f.path+'.part')).size,8);
});
test('complete partial is verified locally even if server would return 416',async t=>{
 let requests=0;const f=await fixture(t,(_req,res)=>{requests++;res.writeHead(416);res.end();});
 await writeFile(f.path+'.part',bytes);await downloadArtifact(f.artifact,f.path);
 assert.equal(requests,0);assert.deepEqual(await readFile(f.path),bytes);
});
test('oversized streamed response fails and cannot become an active artifact',async t=>{
 const f=await fixture(t,(_req,res)=>res.end(Buffer.alloc(2048)));
 await assert.rejects(downloadArtifact(f.artifact,f.path),/size/);await assert.rejects(stat(f.path),{code:'ENOENT'});
 await assert.rejects(stat(f.path+'.part'),{code:'ENOENT'});
});
