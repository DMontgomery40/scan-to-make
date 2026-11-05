import test from 'node:test';
import assert from 'node:assert/strict';
import {slicedFacts} from '../dist/slice-estimate.js';

// The estimate, settings and plates of a sliced file come from the MCP's inspect_print_file `sliced`
// (bambu-printer-mcp 1.1.63+, mcp-3d-printer-server 1.2.36+); Counterpart never reads slicer files (PRD §8.0 item 9).
test('reads the plate estimate, slice settings and plate count the MCP reports for the exact file', () => {
  assert.deepEqual(slicedFacts({sliced: {plate_count: 2, estimate: {seconds: 3420, grams: 19.2},
    settings: {layer_height_mm: 0.12, sparse_infill_percent: 25, wall_loops: 4, layer_count: 183, future: 1}}}),
  {plateCount: 2, estimate: {seconds: 3420, grams: 19.2}, settings: {layerHeightMm: 0.12, infillPercent: 25, wallLoops: 4, layers: 183}});
  assert.deepEqual(slicedFacts({sliced: {estimate: {grams: 1}, settings: {}}}), {estimate: {grams: 1}, settings: {}});
});

test('an MCP without them, or with values that are not amounts, gives no estimate rather than a guess', () => {
  assert.deepEqual(slicedFacts(undefined), {settings: {}});
  assert.deepEqual(slicedFacts({artifact: {sha256: 'x'}}), {settings: {}}, 'an MCP from before `sliced`');
  assert.deepEqual(slicedFacts({sliced: {plate_count: 1.5, estimate: {seconds: -1, grams: 'lots'}, settings: {wall_loops: 2.5, layer_height_mm: Infinity}}}), {settings: {}});
});
