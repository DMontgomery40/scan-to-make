// #691: the printer MCP's part meshes (counterpart/1 part-mesh tool; a stub until its schema is posted on #691).
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {MODEL_PARTS_TOOL, modelPartsFrom} from '../dist/index.js';

const out = '/work/parts-out';
const part = (extra = {}) => ({id: 'bar', name: 'bar', filament: 1, colour: '#b0855d', stl_path: join(out, 'bar.stl'), ...extra});

test('the part-mesh answer becomes parts with their mesh, name, filament, colour and plate', () => {
  assert.equal(MODEL_PARTS_TOOL, 'counterpart_model_parts');
  assert.deepEqual(modelPartsFrom({parts: [part({plate: 1}), {id: 'letters', stl_path: join(out, 'letters.stl')}]}, out), [
    {id: 'bar', name: 'bar', filament: 1, colour: '#B0855D', plate: 1, stlPath: join(out, 'bar.stl')},
    {id: 'letters', stlPath: join(out, 'letters.stl')},
  ]);
  // A garbled optional field is dropped, never the part: its mesh still draws, in the neutral material.
  assert.deepEqual(modelPartsFrom({parts: [part({colour: 'black', filament: 0, plate: -1, name: 7})]}, out), [{id: 'bar', stlPath: join(out, 'bar.stl')}]);
});

test('an answer this version cannot trust is no parts at all', () => {
  for (const [why, answer] of [
    ['no parts', {}], ['empty', {parts: []}], ['too many', {parts: Array.from({length: 65}, (_, n) => part({id: `p${n}`}))}],
    ['a mesh outside the output folder', {parts: [part({stl_path: '/etc/passwd.stl'})]}],
    ['a path climbing out', {parts: [part({stl_path: join(out, '..', 'elsewhere.stl')})]}],
    ['not an STL', {parts: [part({stl_path: join(out, 'bar.obj')})]}],
    ['an unsafe id', {parts: [part({id: '../bar'})]}], ['duplicate ids', {parts: [part(), part()]}],
  ]) assert.equal(modelPartsFrom(answer, out), undefined, why);
});
