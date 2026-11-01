import test from 'node:test';
import assert from 'node:assert/strict';
import {zipSync, strToU8} from 'fflate';
import {sliceEstimate} from '../dist/slice-estimate.js';

test('reads the selected plate time and filament weight from a sliced Bambu 3MF', async () => {
  const files = {};
  files['Metadata/slice_info.config'] = strToU8('<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="2575"/><metadata key="weight" value="16.74"/></plate><plate><metadata key="index" value="2"/><metadata key="prediction" value="300"/><metadata key="weight" value="3"/></plate></config>');
  const bytes = Buffer.from(zipSync(files));
  assert.deepEqual(await sliceEstimate(bytes, 0), {seconds:2575, grams:16.74});
  assert.deepEqual(await sliceEstimate(bytes, 1), {seconds:300, grams:3});
});

test('does not invent an estimate when the selected plate has none', async () => {
  const files = {}; files['Metadata/slice_info.config'] = strToU8('<config><plate><metadata key="index" value="1"/></plate></config>');
  assert.equal(await sliceEstimate(Buffer.from(zipSync(files)), 0), undefined);
});
