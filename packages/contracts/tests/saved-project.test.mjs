import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as api from '../dist/saved-project.js';
const cup = JSON.parse(readFileSync(new URL('../fixtures/tapered-holder.json', import.meta.url)));
const drawer = JSON.parse(readFileSync(new URL('../fixtures/drawer-tray.json', import.meta.url)));
const brief = () => ({object:'Kitchen drawer', context:'', addition:'An organizer'});
const input = (id='project-1', fit=null) => ({id, brief:brief(), fit:fit && {...structuredClone(fit),id}});
const record = (fit=null) => ({formatVersion:'0.1.0', revision:0, ...input('project-1',fit)});
const replace = text => ({kind:'replace-brief',brief:{...brief(),addition:text}});

// A real in-memory implementation of the storage protocol, not native persistence proof.
function storage() {
  const bytes = new Map();
  return {bytes, async listIds(){return [...bytes.keys()];}, async read(id){return bytes.get(id) ?? null;},
    async compareAndSwap(id,expected,next){
      if ((bytes.get(id) ?? null)!==expected) return false;
      bytes.set(id,next); return true;
    }};
}
function repository(raw=storage()) {
  assert.equal(typeof api.createSavedProjects,'function');
  return {raw, repo:api.createSavedProjects(raw)};
}
const ok = result => {assert.equal(result.status,'ok');return result.project;};

test('incomplete general brief round-trips across repository recreation without a fit',async()=>{
  const {raw,repo}=repository();
  const created=ok(await repo.create(input()));
  assert.deepEqual(created,record());
  assert.deepEqual(ok(await api.createSavedProjects(raw).load(created.id)),created);
  assert.equal(created.fit,null);
  assert.deepEqual(await repo.load('missing'),{status:'missing'});
});

test('saved records strictly validate identities, fields and independent revision bounds',()=>{
  assert.equal(typeof api.decodeSavedProject,'function');
  for(const fit of [cup,drawer]) assert.equal(api.decodeSavedProject(JSON.stringify(record(fit)),'project-1').status,'ok');
  for(const change of [
    x=>x.id='../escape',x=>x.id=' padded ',x=>x.extra=true,x=>x.brief.extra='unknown',
    x=>x.brief.object=42,x=>x.revision=-1,x=>x.revision=1.5,
    x=>x.fit.id='another-project',x=>x.fit.revision=1,
  ]){const x=record(cup);change(x);assert.equal(api.decodeSavedProject(JSON.stringify(x),'project-1').status,'corrupt');}
  assert.equal(api.decodeSavedProject(JSON.stringify(record()),'other-id').status,'corrupt');
});

test('future project and fit versions are reported distinctly from corrupt JSON',()=>{
  assert.equal(typeof api.decodeSavedProject,'function');
  assert.equal(api.decodeSavedProject('{bad').status,'corrupt');
  for(const value of [null,[],{},42]) assert.equal(api.decodeSavedProject(JSON.stringify(value)).status,'corrupt');
  const future=record();future.formatVersion='9.0.0';
  assert.deepEqual(api.decodeSavedProject(JSON.stringify(future)),{status:'unsupported-version',scope:'project',version:'9.0.0'});
  const futureFit=record(drawer);futureFit.fit.schemaVersion='9.0.0';
  assert.deepEqual(api.decodeSavedProject(JSON.stringify(futureFit)),{status:'unsupported-version',scope:'fit',version:'9.0.0'});
});

test('brief edits preserve fit revision and measurements; no-op retains saved revision',async()=>{
  const {repo}=repository();const created=ok(await repo.create(input('project-1',cup)));
  const changed=ok(await repo.change(created.id,0,replace('A removable insert')));
  assert.equal(changed.revision,1);assert.deepEqual(changed.fit,created.fit);
  assert.deepEqual(ok(await repo.change(created.id,1,replace('A removable insert'))),changed);
  const stale=await repo.change(created.id,0,replace('Old edit'));
  assert.equal(stale.status,'stale');assert.equal(stale.scope,'project');assert.deepEqual(stale.latest,changed);
});

test('first fit attachment is explicit, starts at zero and cannot replace an attached fit',async()=>{
  const {raw,repo}=repository();ok(await repo.create(input()));
  const fit=input('project-1',drawer).fit;
  for(const invalid of [{...fit,id:'fixed-seed'},{...fit,revision:1}]){
    assert.equal((await repo.change('project-1',0,{kind:'attach-fit',fit:invalid})).status,'invalid-change');
  }
  const attached=ok(await repo.change('project-1',0,{kind:'attach-fit',fit}));
  assert.equal(attached.revision,1);assert.equal(attached.fit.revision,0);
  const before=raw.bytes.get('project-1');
  assert.equal((await repo.change('project-1',1,{kind:'attach-fit',fit})).status,'invalid-change');
  assert.equal(raw.bytes.get('project-1'),before);
});

test('fit patch enforces both revisions and protected edit authorization',async()=>{
  const {raw,repo}=repository();ok(await repo.create(input('project-1',cup)));
  const dimension={...cup.dimensions.holderInnerTopDiameter,sourceId:'replacement-measurement'};
  const patch={expectedRevision:0,dimensions:{holderInnerTopDiameter:dimension}};
  const before=raw.bytes.get('project-1');
  assert.equal((await repo.change('project-1',0,{kind:'patch-fit',patch})).status,'invalid-change');
  assert.equal(raw.bytes.get('project-1'),before);
  patch.authorizedInterfaceIds=['holder-insert'];
  const changed=ok(await repo.change('project-1',0,{kind:'patch-fit',patch}));
  assert.equal(changed.revision,1);assert.equal(changed.fit.revision,1);
  assert.deepEqual(changed.brief,brief());assert.deepEqual(changed.fit.interfaces['holder-insert'].fitEvidence,[]);
  const stale=await repo.change('project-1',1,{kind:'patch-fit',patch});
  assert.equal(stale.status,'stale');assert.equal(stale.scope,'fit');assert.deepEqual(stale.latest,changed);
});

test('drawer layout uses the same shared patch rules and advances both revisions',async()=>{
  const {repo}=repository();ok(await repo.create(input('project-1',drawer)));
  const result=ok(await repo.change('project-1',0,{kind:'patch-fit',patch:{template:'drawer-tray',expectedRevision:0,dimensions:{},parameters:{dividersAcross:3}}}));
  assert.equal(result.revision,1);assert.equal(result.fit.revision,1);assert.equal(result.fit.parameters.dividersAcross,3);
});

test('invalid changes, revision exhaustion and missing fit cannot modify storage',async()=>{
  const {raw,repo}=repository();ok(await repo.create(input()));const before=raw.bytes.get('project-1');
  for(const change of [{kind:'put',project:record()},{...replace('x'),extra:true},{kind:'patch-fit',patch:{expectedRevision:0,dimensions:{}}}]){
    assert.equal((await repo.change('project-1',0,change)).status,'invalid-change');
    assert.equal(raw.bytes.get('project-1'),before);
  }
  assert.equal((await repo.change('project-1',-1,replace('x'))).status,'invalid-change');
  const max=record();max.revision=Number.MAX_SAFE_INTEGER;raw.bytes.set(max.id,JSON.stringify(max));
  assert.equal((await repo.change(max.id,max.revision,replace('changed'))).status,'invalid-change');
  assert.equal(ok(await repo.change(max.id,max.revision,{kind:'replace-brief',brief:max.brief})).revision,max.revision);
});

test('exclusive create and concurrent stale writes preserve the winner across repositories',async()=>{
  const {raw,repo}=repository();const other=api.createSavedProjects(raw);
  const creates=await Promise.all([repo.create(input()),other.create(input())]);
  assert.deepEqual(creates.map(x=>x.status).sort(),['exists','ok']);
  const writes=await Promise.all([repo.change('project-1',0,replace('A')),other.change('project-1',0,replace('B'))]);
  assert.deepEqual(writes.map(x=>x.status).sort(),['ok','stale']);
  assert.deepEqual(writes.find(x=>x.status==='stale').latest,writes.find(x=>x.status==='ok').project);
  assert.equal(ok(await other.load('project-1')).revision,1);
});

test('corrupt and unsupported records remain byte-for-byte intact through writes',async()=>{
  const {raw,repo}=repository();
  for(const bytes of ['{bad',JSON.stringify({...record(),formatVersion:'9.0.0'})]){
    raw.bytes.set('project-1',bytes);
    for(const result of [await repo.create(input()),await repo.change('project-1',0,replace('x'))]){
      assert.ok(['corrupt','unsupported-version'].includes(result.status));
      assert.equal(raw.bytes.get('project-1'),bytes);
    }
  }
});

test('list exposes unhealthy entries while healthy projects remain readable',async()=>{
  const {raw,repo}=repository();ok(await repo.create(input()));raw.bytes.set('broken','{bad');
  raw.bytes.set('future',JSON.stringify({...record(),id:'future',formatVersion:'9.0.0'}));
  const listing=await repo.list();assert.equal(listing.status,'ok');
  assert.deepEqual(listing.entries.map(x=>[x.id,x.result.status]),[['broken','corrupt'],['future','unsupported-version'],['project-1','ok']]);
});

test('storage failures never report saved or overwrite readable bytes',async()=>{
  const {raw,repo}=repository();ok(await repo.create(input()));const before=raw.bytes.get('project-1');
  const fail=()=>{throw Error('fixture I/O failure');};
  assert.equal((await api.createSavedProjects({...raw,read:fail}).load('project-1')).status,'storage-error');
  assert.equal((await api.createSavedProjects({...raw,listIds:fail}).list()).status,'storage-error');
  assert.equal((await api.createSavedProjects({...raw,compareAndSwap:fail}).change('project-1',0,replace('new'))).status,'storage-error');
  assert.equal(raw.bytes.get('project-1'),before);
});

test('create and change snapshot caller-owned input before asynchronous storage',async()=>{
  const {raw,repo}=repository();const draft=input();const pending=repo.create(draft);
  draft.brief.object='mutated';assert.equal(ok(await pending).brief.object,'Kitchen drawer');
  const change=replace('original edit');const writing=repo.change('project-1',0,change);
  change.brief.addition='mutated edit';assert.equal(ok(await writing).brief.addition,'original edit');
  const loaded=ok(await repo.load('project-1'));loaded.brief.object='mutated output';
  assert.equal(ok(await api.createSavedProjects(raw).load('project-1')).brief.object,'Kitchen drawer');
});
