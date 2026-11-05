import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchIdentity} from '../dist/index.js';

test('the dispatched job is recognised by task id, subtask name, uploaded path or file name', () => {
  assert.deepEqual(dispatchIdentity({taskId: '1730485800', subtaskName: 'checked-x-part'}, '/b/sliced.3mf'), {taskId: '1730485800', jobName: 'checked-x-part', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({taskId: '0', remoteProjectPath: 'cache/checked-x-part.3mf'}, '/b/sliced.3mf'), {jobName: 'checked-x-part', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({jobName: 'part.gcode'}, '/b/sliced.gcode'), {jobName: 'part.gcode', fileBase: 'sliced'});
  assert.deepEqual(dispatchIdentity({dispatch: 'started'}, '/b/sliced.gcode'), {jobName: 'sliced.gcode', fileBase: 'sliced'});
  // Nothing to go on but the file: a job named after it may be adopted (PRD §8.6 sent).
  assert.deepEqual(dispatchIdentity('ok', '/b/part_flat_sliced.gcode.3mf'), {fileBase: 'part_flat_sliced'});
  assert.deepEqual(dispatchIdentity({printerJobName: 'checked-x-part'}, '/b/sliced.3mf'), {jobName: 'checked-x-part', fileBase: 'sliced'}, 'bambu_network / bambu_native');
});
