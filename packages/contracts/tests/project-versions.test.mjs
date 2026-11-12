import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ProjectDesignsSchema} from '../dist/counterpart.js';

// #616: the one fixture every client derives its design history and list line from.
test('the shared design-history fixture is a valid wire project, and the Swift copy is the same file', async () => {
  const text = await readFile(new URL('../fixtures/project-versions.json', import.meta.url), 'utf8');
  const {project, expected} = JSON.parse(text);
  const designs = ProjectDesignsSchema.parse(project);
  assert.equal(designs.versions.length, 3);
  assert.deepEqual(designs.prints.map(p => p.versionId), [expected.have[0]]);
  assert.deepEqual(designs.versions.map(v => v.result.model.startsWith(`versions/${v.id}/`)), [true, true, true]);
  const swift = await readFile(new URL('../../CounterpartKit/Tests/CounterpartKitTests/Fixtures/project-versions.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(swift), JSON.parse(text));
});

test('a design history is refused when a print names no design, ids repeat, or designs are out of order', () => {
  const version = (id, at) => ({id, sealedAtMs: at, modelSha256: 'a'.repeat(64), result: {model: `versions/${id}/model.stl`, renders: []}});
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version('a', 1)], prints: [{id: 'p', bundleId: 'b', startedAtMs: 2, versionId: 'gone'}]}).success, false);
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version('a', 1), version('a', 2)]}).success, false);
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version('a', 2), version('b', 1)]}).success, false);
  assert.equal(ProjectDesignsSchema.safeParse({versions: [{...version('a', 1), result: {model: '../elsewhere.stl', renders: []}}]}).success, false);
  // A published file's prints have no design: its plates carry their history.
  assert.equal(ProjectDesignsSchema.safeParse({versions: [], prints: [{id: 'p', bundleId: 'b', startedAtMs: 2}]}).success, true);
});

// #769 (review of #770): a sealed multi-part design lists the merged mesh beside its 3MF only while it is there.
test('a sealed design may list its merged mesh, inside the project only', () => {
  const version = mergedMesh => ({id: 'a', sealedAtMs: 1, modelSha256: 'a'.repeat(64), result: {model: 'versions/a/touched.3mf', renders: [], ...(mergedMesh ? {mergedMesh} : {})}});
  assert.equal(ProjectDesignsSchema.parse({versions: [version('versions/a/model.stl')]}).versions[0].result.mergedMesh, 'versions/a/model.stl');
  assert.equal(ProjectDesignsSchema.parse({versions: [version()]}).versions[0].result.mergedMesh, undefined, 'an older Mac says nothing');
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version('../elsewhere.stl')]}).success, false);
});
