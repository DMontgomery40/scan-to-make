import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileSavedProjectStorage} from '../dist/saved-project-storage.js';
import {SavedProjectSync} from '../dist/saved-project-sync.js';
import {createSavedProjects} from '@scan-to-make/contracts/saved-project';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'project-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const local=new FileSavedProjectStorage(join(root,'local'));const repository=createSavedProjects(local);
 await repository.create({id:'phone',brief:{object:'Bottle',context:'Drawer',addition:'Holder'}});
 await repository.change('phone',0,{kind:'replace-brief',brief:{object:'Bottle',context:'Drawer',addition:'Open holder'}});
 const remote=new FileSavedProjectStorage(join(root,'remote'));
 return {local,repository,remote,sync:new SavedProjectSync(remote),bytes:await local.read('phone')};
}
const errorCode=code=>error=>error.code===code;

test('nonzero native snapshot bootstraps exact portable bytes and survives fresh reopen',async t=>{
 const f=await fixture(t);const saved=await f.sync.put('phone',f.bytes,{ifNoneMatch:'*'});
 assert.equal(saved.project.revision,1);assert.equal(saved.bytes,f.bytes);assert.match(saved.etag,/^"[a-f0-9]{64}"$/);
 assert.deepEqual(await new SavedProjectSync(f.remote).get('phone'),saved);
});

test('create-only and exact ETag conditions reject missing or stale authority',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.sync.put('phone',f.bytes,{}),errorCode('precondition-required'));
 await assert.rejects(f.sync.put('phone',f.bytes,{ifMatch:'*'}),errorCode('invalid-precondition'));
 const saved=await f.sync.put('phone',f.bytes,{ifNoneMatch:'*'});
 await assert.rejects(f.sync.put('phone',f.bytes,{ifNoneMatch:'*'}),errorCode('precondition-failed'));
 await assert.rejects(f.sync.put('phone',f.bytes,{ifMatch:'"'+'0'.repeat(64)+'"'}),errorCode('precondition-failed'));
 assert.deepEqual(await f.sync.put('phone',f.bytes,{ifMatch:saved.etag}),saved);
});

test('current ETag cannot authorize backward revisions or conflicting content at same revision',async t=>{
 const f=await fixture(t);const saved=await f.sync.put('phone',f.bytes,{ifNoneMatch:'*'});
 const changed=JSON.parse(f.bytes);changed.brief.addition='Different content';
 await assert.rejects(f.sync.put('phone',JSON.stringify(changed),{ifMatch:saved.etag}),errorCode('revision-conflict'));
 changed.revision=0;
 await assert.rejects(f.sync.put('phone',JSON.stringify(changed),{ifMatch:saved.etag}),errorCode('revision-conflict'));
 assert.equal((await f.sync.get('phone')).bytes,f.bytes);
 changed.revision=4;
 const updated=await f.sync.put('phone',JSON.stringify(changed),{ifMatch:saved.etag});
 assert.equal(updated.project.revision,4);assert.notEqual(updated.etag,saved.etag);
});

test('concurrent sync writers have exactly one successful CAS and retain one complete snapshot',async t=>{
 const f=await fixture(t);const initial=await f.sync.put('phone',f.bytes,{ifNoneMatch:'*'});
 const candidates=['A','B'].map(addition=>JSON.stringify({...initial.project,revision:2,brief:{...initial.project.brief,addition}}));
 const result=await Promise.allSettled(candidates.map(bytes=>new SavedProjectSync(f.remote).put('phone',bytes,{ifMatch:initial.etag})));
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.ok(candidates.includes((await f.sync.get('phone')).bytes));
});

test('wrong identity, invalid format, oversize input and corrupt retained project fail closed',async t=>{
 const f=await fixture(t);
 for(const bytes of ['{}',JSON.stringify({...JSON.parse(f.bytes),id:'other'}),' '.repeat(4*1024*1024+1)])await assert.rejects(f.sync.put('phone',bytes,{ifNoneMatch:'*'}),errorCode('invalid-snapshot'));
 await assert.rejects(f.sync.get('phone'),errorCode('not-found'));
 await f.remote.compareAndSwap('phone',null,'broken');
 await assert.rejects(f.sync.get('phone'),errorCode('storage-unavailable'));
 await assert.rejects(f.sync.put('phone',f.bytes,{ifNoneMatch:'*'}),errorCode('storage-unavailable'));
});

test('fit-template data saved by earlier app versions replicates unchanged without granting artifact verification',async t=>{
 const f=await fixture(t);const fit={schemaVersion:'0.2.0',template:'drawer-tray',id:'phone',revision:0,parameters:{dividersAcross:2}};
 const binding={sourceFit:fit,artifact:{sha256:'a'.repeat(64),mediaType:'model/stl',byteLength:1234}};
 const bytes=JSON.stringify({...JSON.parse(f.bytes),revision:3,fit,preview:binding,acceptedArtifact:binding});
 await f.local.compareAndSwap('phone',f.bytes,bytes);
 const synced=await f.sync.put('phone',bytes,{ifNoneMatch:'*'});
 assert.deepEqual(synced.project.acceptedArtifact,binding);assert.deepEqual(synced.project.fit,fit);assert.equal(synced.bytes,bytes);
});
