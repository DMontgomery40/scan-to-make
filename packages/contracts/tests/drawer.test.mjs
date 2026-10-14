import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as contracts from '../dist/index.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/drawer-tray.json', import.meta.url)));
const cup = JSON.parse(readFileSync(new URL('../fixtures/tapered-holder.json', import.meta.url)));
const fresh = () => structuredClone(fixture);
const patch = changes => ({template:'drawer-tray', expectedRevision:0, dimensions:{}, ...changes});
const exact = n => ({nominalMm:n, lowerMm:n, upperMm:n, source:'design', sourceId:'fixture-edit'});
function withEvidence() {
  const spec = fresh();
  spec.interfaces['drawer-cavity'].fitEvidence = [{
    id:'fixture-drawer-fit', assessedRevision:0, observedAt:'2026-10-14T10:00:00Z',
    observerSourceId:'synthetic-fixture', outcome:'reported-fit',
    contactRegion:'full-drawer-envelope', dimensions:structuredClone(spec.dimensions),
    scope:{printerId:'fixture-printer',printerModel:'fixture-model',nozzleDiameterMm:0.4,
      material:'PLA',orientation:[0,0,1],slicerSettingsSha256:'a'.repeat(64)},
    couponArtifact:{sha256:'b'.repeat(64),mediaType:'model/stl',byteLength:1024},
  }];
  return spec;
}

test('general contract round-trips distinct drawer and unchanged legacy cup records', () => {
  assert.equal(typeof contracts.validateProjectFitSpec, 'function');
  assert.deepEqual(contracts.validateProjectFitSpec(fresh()),fixture);
  assert.deepEqual(contracts.validateProjectFitSpec(cup),cup);
  assert.deepEqual(contracts.validateFitSpec(cup),cup);
  assert.throws(()=>contracts.validateFitSpec(fixture));
});

test('drawer contract rejects wrong template fields and impossible worst-case layouts', () => {
  for (const change of [
    s=>s.dimensions.cupOuterDiameter=exact(90),
    s=>delete s.dimensions.drawerInnerHeight,
    s=>s.frame.origin='holder-base-center',
    s=>s.schemaVersion='0.1.0',
    s=>s.parameters.dividersAcross=1.5,
    s=>s.parameters.dividersAlong=9,
    s=>s.parameters.cornerRadius=2,
    s=>s.dimensions.trayHeight=exact(60),
    s=>s.dimensions.floorThickness=exact(40),
    s=>s.dimensions.trayHeight=exact(4),
    s=>s.dimensions.peripheralClearance=exact(150),
    s=>s.dimensions.drawerInnerWidth=exact(20),
    s=>s.dimensions.wallThickness=exact(100),
  ]) {const spec=fresh();change(spec);assert.throws(()=>contracts.validateProjectFitSpec(spec));}
  const emptyTray=fresh(); emptyTray.parameters={dividersAcross:0,dividersAlong:0};
  emptyTray.dimensions.trayHeight=exact(3);
  assert.equal(contracts.validateProjectFitSpec(emptyTray).dimensions.trayHeight.nominalMm,3);
});

test('drawer layout edits preserve scoped outer fit evidence but increment the revision', () => {
  const before=withEvidence();
  const after=contracts.applyProjectFitSpecPatch(before,patch({parameters:{dividersAcross:3}}));
  assert.equal(after.revision,1);assert.equal(after.parameters.dividersAcross,3);
  assert.equal(after.parameters.dividersAlong,1);
  assert.deepEqual(after.interfaces,before.interfaces);
  assert.equal(before.parameters.dividersAcross,2);
});

test('every drawer dimension and its provenance require authorization and clear outer-fit evidence', () => {
  for (const key of Object.keys(fixture.dimensions)) {
    const before=withEvidence(); const value={...before.dimensions[key],sourceId:'new-measurement'};
    assert.throws(()=>contracts.applyProjectFitSpecPatch(before,patch({dimensions:{[key]:value}})));
    const after=contracts.applyProjectFitSpecPatch(before,patch({dimensions:{[key]:value},authorizedInterfaceIds:['drawer-cavity']}));
    assert.equal(after.revision,1); assert.deepEqual(after.interfaces['drawer-cavity'].fitEvidence,[]);
    assert.equal(before.interfaces['drawer-cavity'].fitEvidence.length,1);
  }
});

test('drawer evidence rejects another envelope, future revision and reduced contact screening', () => {
  assert.equal(contracts.validateProjectFitSpec(withEvidence()).interfaces['drawer-cavity'].fitEvidence.length,1);
  for (const change of [
    e=>e.dimensions.trayHeight=exact(30),e=>e.assessedRevision=1,
    e=>e.contactRegion='short-band',e=>delete e.contactRegion,
    e=>e.dimensions.drawerInnerWidth.sourceId='other-source',
    e=>e.couponArtifact.sha256='not-a-digest',e=>delete e.scope.material,
  ]) {const spec=withEvidence();change(spec.interfaces['drawer-cavity'].fitEvidence[0]);
    assert.throws(()=>contracts.validateProjectFitSpec(spec));}
});

test('template patches cannot cross variants, bypass authorization or inject evidence', () => {
  for (const input of [
    {expectedRevision:0, dimensions:{cupOuterDiameter:exact(90)}},
    patch({dimensions:{cupOuterDiameter:exact(90)}}),
    patch({dimensions:{trayHeight:exact(45)},authorizedInterfaceIds:['holder-insert']}),
    patch({interfaces:withEvidence().interfaces}),
    patch({template:'cup-holder-adapter'}),
    patch({parameters:{dividersAcross:100}}),
  ]) assert.throws(()=>contracts.applyProjectFitSpecPatch(fixture,input));
  assert.throws(()=>contracts.applyProjectFitSpecPatch(cup,patch({parameters:{dividersAcross:3}})));
});

test('drawer no-op, stale revision and exhaustion retain the revision guarantees', () => {
  const before=withEvidence();
  const same=contracts.applyProjectFitSpecPatch(before,patch({dimensions:before.dimensions,parameters:before.parameters}));
  assert.equal(same.revision,0);assert.deepEqual(same,before);assert.notEqual(same,before);
  assert.throws(()=>contracts.applyProjectFitSpecPatch(before,patch({expectedRevision:1})));
  before.revision=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>contracts.applyProjectFitSpecPatch(before,patch({expectedRevision:before.revision,parameters:{dividersAcross:3}})));
});
