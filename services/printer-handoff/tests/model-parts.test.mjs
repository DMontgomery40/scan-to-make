// #691: the printer MCP's part meshes (counterpart/1 `counterpart_part_meshes`, schema on #691).
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {PART_MESHES_TOOL, modelPartsFrom} from '../dist/index.js';

const out = '/work/parts-out', folder = join(out, 'model-parts-1');
const part = (extra = {}) => ({id: '1/2', name: 'Letters and inscription', plate: 1, color: '#1a1a1a', filament: 2,
  stl_path: join(folder, '1-letters-and-inscription.stl'), triangles: 81234, size_mm: [150.2, 8, 62.5], ...extra});
// As the MCP answers it (#691 comment): contract, units, the call's own folder and one entry per printable part per copy.
const answer = (parts, extra = {}) => ({contract: 'counterpart/1', units: 'mm', folder, parts, ...extra});

test('the part-mesh answer becomes parts with their mesh, name, filament, colour and 0-based plate', () => {
  assert.equal(PART_MESHES_TOOL, 'counterpart_part_meshes');
  assert.deepEqual(modelPartsFrom(answer([part(), {id: '1/1', name: 'Bar', plate: 2, filament: 1, painted: true, stl_path: join(folder, '1-bar.stl')}, {id: '2/1', stl_path: join(folder, '2-bar.stl')}]), out), {
    parts: [
      {id: '1/2', name: 'Letters and inscription', filament: 2, colour: '#1A1A1A', plate: 0, stlPath: join(folder, '1-letters-and-inscription.stl')},
      {id: '1/1', name: 'Bar', filament: 1, plate: 1, painted: true, stlPath: join(folder, '1-bar.stl')},
      {id: '2/1', stlPath: join(folder, '2-bar.stl')},
    ],
    skipped: [],
  });
  // A garbled optional field is dropped, never the part: its mesh still draws, in the neutral material.
  assert.deepEqual(modelPartsFrom(answer([part({color: 'black', filament: 0, plate: 0, name: 7})]), out).parts, [{id: '1/2', stlPath: join(folder, '1-letters-and-inscription.stl')}]);
});

test('parts the MCP skipped are named, so the caller can draw the design whole or not at all', () => {
  assert.deepEqual(modelPartsFrom(answer([part()], {skipped: [{id: '3/1', name: 'Huge base', reason: 'over 64 MiB'}, {id: '4/1'}, 'junk']}), out).skipped,
    ['Huge base', '4/1', 'a part']);
});

test('an answer this version cannot trust is no parts at all', () => {
  for (const [why, value] of [
    ['no parts', answer(undefined)], ['empty', answer([])], ['too many', answer(Array.from({length: 257}, (_, n) => part({id: `${n}/1`})))],
    ['other units', answer([part()], {units: 'in'})], ['no folder', answer([part()], {folder: undefined})],
    ['a folder outside the output folder', answer([part({stl_path: '/elsewhere/a.stl'})], {folder: '/elsewhere'})],
    ['a mesh outside its folder', answer([part({stl_path: join(out, 'other', 'a.stl')})])],
    ['a path climbing out', answer([part({stl_path: join(folder, '..', '..', 'a.stl')})])],
    ['not an STL', answer([part({stl_path: join(folder, 'bar.obj')})])],
    ['no id', answer([part({id: undefined})])], ['duplicate ids', answer([part(), part()])],
  ]) assert.equal(modelPartsFrom(value, out), undefined, why);
});
