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

// #788: a draft design, on `current` and on its sealed design, with the MCP's reasons as given. Every layout reads this file.
test('the shared draft fixture is a valid wire project, its line and note are the contract\'s, and the Swift copy is the same file', async () => {
  const {DesignDraftSchema, DRAFT_LINE, DRAFT_PRINT_NOTE} = await import('../dist/counterpart.js');
  const text = await readFile(new URL('../fixtures/project-draft.json', import.meta.url), 'utf8');
  const doc = JSON.parse(text);
  assert.equal(doc.line, DRAFT_LINE);
  assert.equal(doc.printNote, DRAFT_PRINT_NOTE);
  for (const [name, {project, draft, reasons}] of Object.entries(doc.projects)) {
    const designs = ProjectDesignsSchema.parse(project);
    assert.equal(!!designs.versions.at(-1).result.draft, draft, name);
    assert.equal(!!project.current.draft, draft, name);
    if (draft) assert.deepEqual(DesignDraftSchema.parse(project.current.draft).reasons ?? [], reasons, name);
    assert.equal(project.status.text === DRAFT_LINE, draft, `${name}: the companion's line`);
  }
  assert.ok(doc.projects.round4.reasons.length > doc.collapseAfter, 'the round-4 draft has enough reasons to collapse');
  const swift = await readFile(new URL('../../CounterpartKit/Tests/CounterpartKitTests/Fixtures/project-draft.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(swift), doc);
});

test('a draft\'s reasons are short strings, at most twelve; an older Mac sends no draft at all', () => {
  const version = draft => ({id: 'a', sealedAtMs: 1, modelSha256: 'a'.repeat(64), result: {model: 'versions/a/model.stl', renders: [], ...(draft ? {draft} : {})}});
  assert.deepEqual(ProjectDesignsSchema.parse({versions: [version({reasons: ['Model the desk.']})]}).versions[0].result.draft, {reasons: ['Model the desk.']});
  assert.deepEqual(ProjectDesignsSchema.parse({versions: [version({})]}).versions[0].result.draft, {}, 'a draft from an MCP before round 4');
  assert.equal(ProjectDesignsSchema.parse({versions: [version()]}).versions[0].result.draft, undefined);
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version({reasons: Array(13).fill('x')})]}).success, false);
  assert.equal(ProjectDesignsSchema.safeParse({versions: [version({reasons: ['x'.repeat(301)]})]}).success, false);
});
