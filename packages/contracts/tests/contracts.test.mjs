import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFitSpec, applyFitSpecPatch, validateArtifactRef } from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/tapered-holder.json', import.meta.url)));
const fresh = () => structuredClone(fixture);

test('preserves all dimensions and their provenance through JSON round-trip', () => {
  const result = validateFitSpec(fresh());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), fixture);
  assert.equal(result.dimensions.holderInnerBottomDiameter.nominalMm, 58);
});

for (const [name, change] of [
  ['missing insertion depth', s => delete s.dimensions.insertionDepth],
  ['nonfinite diameter', s => s.dimensions.cupOuterDiameter.nominalMm = Infinity],
  ['reversed uncertainty interval', s => s.dimensions.holderInnerTopDiameter.lowerMm = 63],
  ['nominal outside uncertainty interval', s => s.dimensions.holderInnerTopDiameter.nominalMm = 65],
  ['missing provenance', s => s.dimensions.holderInnerTopDiameter.sourceId = ''],
  ['negative uncertainty endpoint', s => s.dimensions.radialClearance.lowerMm = -1],
  ['zero insertion depth', s => s.dimensions.insertionDepth = { ...s.dimensions.insertionDepth, lowerMm: 0, nominalMm: 0, upperMm: 0 }],
  ['foreign units', s => s.units = 'in'],
  ['unknown dimension', s => s.dimensions.guessedDiameter = s.dimensions.cupOuterDiameter],
  ['unknown schema version', s => s.schemaVersion = '99.0.0'],
  ['unsafe revision', s => s.revision = Number.MAX_SAFE_INTEGER + 1],
  ['missing protected interface', s => delete s.interfaces['holder-insert']]
]) {
  test(`rejects ${name} before geometry consumes it`, () => {
    const input = fresh(); change(input);
    assert.throws(() => validateFitSpec(input));
  });
}

const insertSnapshot = s => Object.fromEntries(
  ['holderInnerBottomDiameter', 'holderInnerTopDiameter', 'insertionDepth', 'wallThickness', 'radialClearance']
  .map(key => [key, structuredClone(s.dimensions[key])])
);
const withEvidence = () => {
  const spec = fresh();
  spec.interfaces['holder-insert'].fitEvidence = [{
    id: 'fixture-fit-report', assessedRevision: 0,
    observedAt: '2026-10-14T06:00:00Z', observerSourceId: 'synthetic-fixture',
    outcome: 'reported-fit', dimensions: insertSnapshot(spec),
    scope: { printerId: 'fixture-printer', printerModel: 'P1S', nozzleDiameterMm: 0.4,
      material: 'PLA', orientation: [0, 0, 1], slicerSettingsSha256: 'a'.repeat(64) },
    couponArtifact: { sha256: 'b'.repeat(64), mediaType: 'model/stl', byteLength: 1024 }
  }];
  return spec;
};

test('accepts scoped evidence tied to the exact lower-interface dimensions', () => {
  assert.equal(validateFitSpec(withEvidence()).interfaces['holder-insert'].fitEvidence.length, 1);
});

test('widening the top preserves the measured lower interface and its evidence', () => {
  const before = withEvidence();
  const after = applyFitSpecPatch(before, { expectedRevision: 0,
    dimensions: { cupOuterDiameter: { ...before.dimensions.cupOuterDiameter, nominalMm: 90, lowerMm: 89.8, upperMm: 90.2 } } });
  assert.equal(after.revision, 1);
  assert.equal(after.dimensions.cupOuterDiameter.nominalMm, 90);
  assert.deepEqual(insertSnapshot(after), insertSnapshot(before));
  assert.deepEqual(after.interfaces['holder-insert'].fitEvidence, before.interfaces['holder-insert'].fitEvidence);
  assert.equal(before.revision, 0);
  assert.equal(before.dimensions.cupOuterDiameter.nominalMm, 86);
});

test('blocks silent lower-interface edits', () => {
  const before = fresh();
  assert.throws(() => applyFitSpecPatch(before, { expectedRevision: 0,
    dimensions: { insertionDepth: { ...before.dimensions.insertionDepth, nominalMm: 30, lowerMm: 30, upperMm: 30 } } }));
});

test('an explicitly authorized lower edit invalidates earlier fit evidence', () => {
  const before = withEvidence();
  const after = applyFitSpecPatch(before, { expectedRevision: 0, authorizedInterfaceIds: ['holder-insert'],
    dimensions: { radialClearance: { ...before.dimensions.radialClearance, nominalMm: 0.4, lowerMm: 0.4, upperMm: 0.4 } } });
  assert.equal(after.revision, 1);
  assert.equal(after.dimensions.radialClearance.nominalMm, 0.4);
  assert.deepEqual(after.interfaces['holder-insert'].fitEvidence, []);
  assert.equal(before.interfaces['holder-insert'].fitEvidence.length, 1);
});

test('wall changes also require authorization because they change the insert', () => {
  const before = fresh();
  assert.throws(() => applyFitSpecPatch(before, { expectedRevision: 0,
    dimensions: { wallThickness: { ...before.dimensions.wallThickness, nominalMm: 3, lowerMm: 3, upperMm: 3 } } }));
});

test('rejects stale patches and prevents revision wraparound', () => {
  assert.throws(() => applyFitSpecPatch(fresh(), { expectedRevision: 1, dimensions: {} }));
  const before = fresh(); before.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => applyFitSpecPatch(before, { expectedRevision: Number.MAX_SAFE_INTEGER,
    dimensions: { cupSupportHeight: { ...before.dimensions.cupSupportHeight, nominalMm: 50, lowerMm: 50, upperMm: 50 } } }));
});

test('rejects malformed patch values and attempted evidence injection', () => {
  assert.throws(() => applyFitSpecPatch(fresh(), { expectedRevision: 0,
    dimensions: { cupOuterDiameter: { nominalMm: 90 } } }));
  assert.throws(() => applyFitSpecPatch(fresh(), { expectedRevision: 0, dimensions: {}, interfaces: withEvidence().interfaces }));
});

for (const [name, change] of [
  ['mismatched interface dimensions', s => s.interfaces['holder-insert'].fitEvidence[0].dimensions.radialClearance = { ...s.dimensions.radialClearance, nominalMm: 0.2, lowerMm: 0.2, upperMm: 0.2 }],
  ['future revision', s => s.interfaces['holder-insert'].fitEvidence[0].assessedRevision = 1],
  ['missing material scope', s => delete s.interfaces['holder-insert'].fitEvidence[0].scope.material],
  ['invalid orientation', s => s.interfaces['holder-insert'].fitEvidence[0].scope.orientation = [0, 0, 0]],
  ['missing artifact digest', s => delete s.interfaces['holder-insert'].fitEvidence[0].couponArtifact.sha256]
]) {
  test(`rejects fit evidence with ${name}`, () => {
    const spec = withEvidence(); change(spec); assert.throws(() => validateFitSpec(spec));
  });
}

test('artifact references are immutable content identities without writable URLs', () => {
  const input = { sha256: 'c'.repeat(64), mediaType: 'model/stl', byteLength: 42 };
  const ref = validateArtifactRef(input);
  input.sha256 = 'd'.repeat(64);
  assert.equal(ref.sha256, 'c'.repeat(64));
  assert.throws(() => { ref.byteLength = 100; });
  for (const bad of [
    { ...input, sha256: 'not-a-digest' }, { ...input, byteLength: 0 },
    { ...input, byteLength: 1.5 }, { ...input, url: 'mutable.stl' }
  ]) assert.throws(() => validateArtifactRef(bad));
});
