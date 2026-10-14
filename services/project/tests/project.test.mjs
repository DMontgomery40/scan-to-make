import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../dist/index.js';

const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json', import.meta.url), 'utf8'));
const artifact = {sha256: 'a'.repeat(64), mediaType: 'model/gltf-binary', byteLength: 100};
const changedCup = {nominalMm: 90, lowerMm: 89.8, upperMm: 90.2, source: 'manual', sourceId: 'cup-2'};
let directory, store;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'scan-project-test-')); store = new ProjectStore(directory); });
afterEach(async () => { await rm(directory, {recursive:true, force:true}); });

test('a new store instance reloads the exact accepted revision and artifact', async () => {
  await store.create(fixture);
  await store.attachPreview(fixture.id, 0, artifact);
  await store.acceptPreview(fixture.id, 0, artifact);
  const loaded = await new ProjectStore(directory).load(fixture.id);
  assert.deepEqual(loaded.spec, fixture);
  assert.deepEqual(loaded.acceptedArtifact, {specRevision:0, artifact});
  assert.equal((await stat(join(directory, fixture.id + '.json'))).mode & 0o777, 0o600);
});

test('editing the spec clears preview and acceptance without altering prior returned data', async () => {
  await store.create(fixture); await store.attachPreview(fixture.id,0,artifact);
  const old = await store.acceptPreview(fixture.id,0,artifact);
  const next = await store.applyPatch(fixture.id, {expectedRevision:0, dimensions:{cupOuterDiameter:changedCup}});
  assert.equal(next.spec.revision,1); assert.equal(next.spec.dimensions.cupOuterDiameter.nominalMm,90);
  assert.equal(next.preview,null); assert.equal(next.acceptedArtifact,null);
  assert.equal(old.spec.revision,0); assert.deepEqual(old.acceptedArtifact,{specRevision:0,artifact});
});

test('stale preview receipts and stale acceptance reject after an edit', async () => {
  await store.create(fixture); await store.attachPreview(fixture.id,0,artifact);
  await store.applyPatch(fixture.id,{expectedRevision:0,dimensions:{cupOuterDiameter:changedCup}});
  await assert.rejects(store.attachPreview(fixture.id,0,artifact));
  await assert.rejects(store.acceptPreview(fixture.id,0,artifact));
  assert.equal((await store.load(fixture.id)).spec.revision,1);
});

test('acceptance binds the exact artifact digest, type and byte length', async () => {
  await store.create(fixture); await store.attachPreview(fixture.id,0,artifact);
  for (const wrong of [ {...artifact,sha256:'b'.repeat(64)}, {...artifact,byteLength:101}, {...artifact,mediaType:'model/stl'} ])
    await assert.rejects(store.acceptPreview(fixture.id,0,wrong));
  assert.equal((await store.load(fixture.id)).acceptedArtifact,null);
  await store.acceptPreview(fixture.id,0,artifact);
  await store.attachPreview(fixture.id,0,{...artifact,sha256:'b'.repeat(64)});
  assert.equal((await store.load(fixture.id)).acceptedArtifact,null);
});

test('two store instances cannot commit two edits against the same revision', async () => {
  await store.create(fixture);
  const patch={expectedRevision:0,dimensions:{cupOuterDiameter:changedCup}};
  const results=await Promise.allSettled([store.applyPatch(fixture.id,patch),new ProjectStore(directory).applyPatch(fixture.id,patch)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal((await store.load(fixture.id)).spec.revision,1);
});

test('a no-op keeps the matching preview and acceptance', async () => {
  await store.create(fixture); await store.attachPreview(fixture.id,0,artifact);
  await store.acceptPreview(fixture.id,0,artifact);
  const result=await store.applyPatch(fixture.id,{expectedRevision:0,dimensions:{cupOuterDiameter:fixture.dimensions.cupOuterDiameter}});
  assert.equal(result.spec.revision,0); assert.deepEqual(result.acceptedArtifact,{specRevision:0,artifact});
});

test('duplicate creation cannot erase an existing edited project', async () => {
  await store.create(fixture); await store.applyPatch(fixture.id,{expectedRevision:0,dimensions:{cupOuterDiameter:changedCup}});
  await assert.rejects(store.create(fixture));
  assert.equal((await store.load(fixture.id)).spec.revision,1);
});

test('invalid edits leave the saved project unchanged', async () => {
  await store.create(fixture);
  await assert.rejects(store.applyPatch(fixture.id,{expectedRevision:0,dimensions:{insertionDepth:{...fixture.dimensions.insertionDepth,nominalMm:30,lowerMm:30,upperMm:30}}}));
  await assert.rejects(store.attachPreview(fixture.id,0,{...artifact,sha256:'bad'}));
  assert.deepEqual((await store.load(fixture.id)).spec,fixture);
});

test('corrupt stored records fail without silently replacing data', async () => {
  await store.create(fixture);
  const file=join(directory,fixture.id+'.json'); const data=JSON.parse(await readFile(file,'utf8'));
  data.preview={specRevision:1,artifact}; await writeFile(file,JSON.stringify(data));
  await assert.rejects(store.load(fixture.id));
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).preview,{specRevision:1,artifact});
});

test('untrusted project ids cannot escape the store directory', async () => {
  for (const id of ['../escaped','/tmp/escaped','a/b','.','']) {
    await assert.rejects(store.create({...fixture,id}));
    await assert.rejects(store.load(id));
  }
});
