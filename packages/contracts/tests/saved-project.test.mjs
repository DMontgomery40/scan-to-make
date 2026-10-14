import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as api from '../dist/saved-project.js';
const cup = JSON.parse(readFileSync(new URL('../fixtures/tapered-holder.json', import.meta.url)));
const drawer = JSON.parse(readFileSync(new URL('../fixtures/drawer-tray.json', import.meta.url)));
const brief = () => ({object:'Kitchen drawer', context:'', addition:'An organizer'});
const input = (id='project-1', fit=null) => ({id, brief:brief(), fit:fit && {...structuredClone(fit),id}});
const record = (fit=null) => ({formatVersion:'0.2.0', revision:0, ...input('project-1',fit),preview:null,acceptedArtifact:null});
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

const artifact = () => ({sha256:'a'.repeat(64),mediaType:'model/stl',byteLength:1234});
const binding = project => ({sourceFit:structuredClone(project.fit),artifact:artifact()});
const legacy = fit => {const value=record(fit);delete value.preview;delete value.acceptedArtifact;return {...value,formatVersion:'0.1.0'};};
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value==='object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverseKeys(item)])) : value;

test('preview and explicit acceptance persist exact source/artifact for both templates',async()=>{
  for(const fit of [cup,drawer]){
    const {raw,repo}=repository();const created=ok(await repo.create(input('project-1',fit)));
    const review=binding(created);
    const preview=ok(await repo.change(created.id,0,{kind:'attach-preview',...review}));
    assert.equal(preview.revision,1);assert.equal(preview.fit.revision,0);
    assert.deepEqual(preview.preview,review);assert.equal(preview.acceptedArtifact,null);
    const accepted=ok(await repo.change(created.id,1,{kind:'accept-preview',...reverseKeys(review)}));
    assert.equal(accepted.revision,2);assert.equal(accepted.fit.revision,0);
    assert.deepEqual(accepted.acceptedArtifact,review);
    assert.deepEqual(ok(await api.createSavedProjects(raw).load(created.id)),accepted);
  }
});

test('review rejects missing fit, changed source at same revision and unseen artifacts without writing',async()=>{
  const {raw,repo}=repository();const created=ok(await repo.create(input('project-1',drawer)));
  const review=binding(created);const before=raw.bytes.get(created.id);
  const altered=structuredClone(review);altered.sourceFit.parameters.dividersAcross=3;
  for(const change of [{kind:'accept-preview',...review},{kind:'attach-preview',...altered},
    {kind:'attach-preview',...review,sourceFit:{...review.sourceFit,id:'other'}},
    {kind:'attach-preview',...review,artifact:{...artifact(),byteLength:0}}]){
    assert.equal((await repo.change(created.id,0,change)).status,'invalid-change');
    assert.equal(raw.bytes.get(created.id),before);
  }
  const draft=ok(await repo.create(input('draft')));
  assert.equal((await repo.change(draft.id,0,{kind:'attach-preview',...review})).status,'invalid-change');
  ok(await repo.change(created.id,0,{kind:'attach-preview',...review}));
  const attachedBytes=raw.bytes.get(created.id);
  for(const alteredArtifact of [{...artifact(),sha256:'b'.repeat(64)},{...artifact(),byteLength:1235},{...artifact(),mediaType:'application/octet-stream'}]){
    assert.equal((await repo.change(created.id,1,{kind:'accept-preview',sourceFit:review.sourceFit,artifact:alteredArtifact})).status,'invalid-change');
    assert.equal(raw.bytes.get(created.id),attachedBytes);
  }
});

test('brief edits and exact no-ops preserve acceptance while replacement preview clears it',async()=>{
  const {raw,repo}=repository();const created=ok(await repo.create(input('project-1',drawer)));const review=binding(created);
  ok(await repo.change(created.id,0,{kind:'attach-preview',...review}));
  const accepted=ok(await repo.change(created.id,1,{kind:'accept-preview',...review}));
  const bytes=raw.bytes.get(created.id);
  for(const change of [{kind:'attach-preview',...reverseKeys(review)},{kind:'accept-preview',...review},
    {kind:'patch-fit',patch:{template:'drawer-tray',expectedRevision:0,dimensions:{},parameters:{dividersAcross:2}}}]){
    assert.deepEqual(ok(await repo.change(created.id,2,change)),accepted);assert.equal(raw.bytes.get(created.id),bytes);
  }
  const edited=ok(await repo.change(created.id,2,replace('A wider description')));
  assert.equal(edited.revision,3);assert.deepEqual(edited.acceptedArtifact,review);
  const replaced=ok(await repo.change(created.id,3,{kind:'attach-preview',...review,artifact:{...artifact(),sha256:'b'.repeat(64)}}));
  assert.equal(replaced.revision,4);assert.equal(replaced.fit.revision,0);assert.equal(replaced.acceptedArtifact,null);
});

test('effective fit edits invalidate both review states and reject old source after reopen',async()=>{
  for(const fit of [cup,drawer]){
    const {raw,repo}=repository();const created=ok(await repo.create(input('project-1',fit)));const review=binding(created);
    ok(await repo.change(created.id,0,{kind:'attach-preview',...review}));
    ok(await repo.change(created.id,1,{kind:'accept-preview',...review}));
    const patch=fit.template==='drawer-tray' ? {template:'drawer-tray',expectedRevision:0,dimensions:{},parameters:{dividersAcross:3}}
      : {expectedRevision:0,dimensions:{cupOuterDiameter:{...fit.dimensions.cupOuterDiameter,sourceId:'new-source'}}};
    const edited=ok(await repo.change(created.id,2,{kind:'patch-fit',patch}));
    assert.equal(edited.revision,3);assert.equal(edited.fit.revision,1);
    assert.equal(edited.preview,null);assert.equal(edited.acceptedArtifact,null);
    const reopened=api.createSavedProjects(raw);assert.deepEqual(ok(await reopened.load(created.id)),edited);
    assert.equal((await reopened.change(created.id,3,{kind:'attach-preview',...review})).status,'invalid-change');
    assert.equal((await reopened.change(created.id,3,{kind:'accept-preview',...review})).status,'invalid-change');
  }
});

test('legacy reads and no-ops preserve original bytes; mutation migrates using exact original CAS',async()=>{
  const {raw,repo}=repository();const old=legacy(drawer);const bytes=JSON.stringify(old,null,3)+'\n';raw.bytes.set(old.id,bytes);
  const loaded=ok(await repo.load(old.id));assert.deepEqual(loaded,record(drawer));assert.equal(raw.bytes.get(old.id),bytes);
  assert.deepEqual(ok(await repo.change(old.id,0,{kind:'replace-brief',brief:old.brief})),loaded);
  assert.equal(raw.bytes.get(old.id),bytes);
  const checks=[];const migrating=api.createSavedProjects({...raw,async compareAndSwap(id,expected,next){checks.push(expected);return raw.compareAndSwap(id,expected,next);}});
  const changed=ok(await migrating.change(old.id,0,{kind:'attach-preview',...binding(loaded)}));
  assert.deepEqual(checks,[bytes]);assert.equal(changed.formatVersion,'0.2.0');assert.equal(changed.revision,1);
  assert.equal(JSON.parse(raw.bytes.get(old.id)).formatVersion,'0.2.0');
});

test('failed migration and conflicting migration preserve old bytes or the winning edit',async()=>{
  const {raw,repo}=repository();const old=legacy(cup);const bytes=JSON.stringify(old);raw.bytes.set(old.id,bytes);
  const failing=api.createSavedProjects({...raw,async compareAndSwap(){throw Error('unavailable');}});
  assert.equal((await failing.change(old.id,0,replace('new'))).status,'storage-error');assert.equal(raw.bytes.get(old.id),bytes);
  const writes=await Promise.all([repo.change(old.id,0,replace('one')),api.createSavedProjects(raw).change(old.id,0,replace('two'))]);
  assert.deepEqual(writes.map(x=>x.status).sort(),['ok','stale']);
  assert.deepEqual(ok(await repo.load(old.id)),writes.find(x=>x.status==='ok').project);
  assert.equal(writes.find(x=>x.status==='stale').latest.formatVersion,'0.2.0');
});

test('stored review data must match current fit and accepted data must equal preview',()=>{
  const valid=record(drawer);valid.preview=binding(valid);valid.acceptedArtifact=structuredClone(valid.preview);
  assert.equal(api.decodeSavedProject(JSON.stringify(reverseKeys(valid))).status,'ok');
  for(const mutate of [x=>x.fit=null,x=>x.preview=null,x=>x.preview.sourceFit.parameters.dividersAcross=3,
    x=>x.acceptedArtifact.artifact.byteLength++,x=>x.acceptedArtifact.sourceFit.dimensions.drawerInnerWidth.sourceId='other',
    x=>x.preview.artifact.extra=true,x=>delete x.preview]){
    const bad=structuredClone(valid);mutate(bad);assert.equal(api.decodeSavedProject(JSON.stringify(bad)).status,'corrupt');
  }
  const injected=legacy(drawer);injected.preview=valid.preview;
  assert.equal(api.decodeSavedProject(JSON.stringify(injected)).status,'corrupt');
});

test('review changes snapshot caller input, enforce saved revision and preserve max-revision no-ops',async()=>{
  const {raw,repo}=repository();const created=ok(await repo.create(input('project-1',drawer)));const review=binding(created);
  const change={kind:'attach-preview',...structuredClone(review)};const pending=repo.change(created.id,0,change);
  change.sourceFit.parameters.dividersAcross=4;change.artifact.byteLength=50;
  const attached=ok(await pending);assert.deepEqual(attached.preview,review);
  const stale=await repo.change(created.id,0,{kind:'accept-preview',...review});assert.equal(stale.status,'stale');assert.equal(stale.scope,'project');
  const max={...attached,revision:Number.MAX_SAFE_INTEGER};raw.bytes.set(max.id,JSON.stringify(max));
  assert.deepEqual(ok(await repo.change(max.id,max.revision,{kind:'attach-preview',...review})),max);
  assert.equal((await repo.change(max.id,max.revision,{kind:'accept-preview',...review})).status,'invalid-change');
});
