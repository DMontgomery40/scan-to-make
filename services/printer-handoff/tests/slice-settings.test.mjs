import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync, strToU8} from 'fflate';
import {sliceSettings, dispatchIdentity} from '../dist/index.js';

test('a sliced Bambu 3MF says its layer height, infill, walls and layer count', async () => {
  const project = JSON.stringify({layer_height: '0.12', sparse_infill_density: '25%', wall_loops: '4', other: 'x'});
  const gcode = '; HEADER_BLOCK_START\n; total layer number: 183\n; HEADER_BLOCK_END\nG28\n';
  const bytes = Buffer.from(zipSync({'Metadata/project_settings.config': strToU8(project), 'Metadata/plate_1.gcode': strToU8(gcode)}));
  assert.deepEqual(await sliceSettings(bytes), {layerHeightMm: 0.12, infillPercent: 25, wallLoops: 4, layers: 183});
  assert.deepEqual(await sliceSettings(Buffer.from(zipSync({'other.txt': strToU8('x')}))), {});
});

test('G-code from PrusaSlicer or Orca reports its settings in its comments', async () => {
  const prusa = Buffer.from(';LAYER_COUNT:120\nG1 X0\n; layer_height = 0.2\n; fill_density = 15%\n; perimeters = 2\n');
  assert.deepEqual(await sliceSettings(prusa), {layerHeightMm: 0.2, infillPercent: 15, wallLoops: 2, layers: 120});
  assert.deepEqual(await sliceSettings(Buffer.from('G28\n')), {});
});

test('the dispatched job is recognised by task id, subtask name, uploaded path or file name', () => {
  assert.deepEqual(dispatchIdentity({taskId: '1730485800', subtaskName: 'checked-x-part'}, '/b/sliced.3mf'), {taskId: '1730485800', jobName: 'checked-x-part', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({taskId: '0', remoteProjectPath: 'cache/checked-x-part.3mf'}, '/b/sliced.3mf'), {jobName: 'checked-x-part', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({jobName: 'part.gcode'}, '/b/sliced.gcode'), {jobName: 'part.gcode', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({dispatch: 'started'}, '/b/sliced.gcode'), {jobName: 'sliced.gcode', fileBase: 'sliced'});
  // Nothing to go on but the file: a job named after it may be adopted (PRD §8.6 sent).
  assert.deepEqual(dispatchIdentity('ok', '/b/part_flat_sliced.gcode.3mf'), {fileBase: 'part_flat_sliced'});
  assert.deepEqual(dispatchIdentity({printerJobName: 'checked-x-part'}, '/b/sliced.3mf'), {jobName: 'checked-x-part', fileBase: 'sliced'}, 'bambu_network / bambu_native');
});
