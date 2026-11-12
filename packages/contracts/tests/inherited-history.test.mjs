import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {InheritedHistorySchema} from '../dist/counterpart.js';
test('the shared inherited conversation has ordered, timed person and app words', async () => {
  const projects = JSON.parse(await readFile(new URL('../fixtures/inherited-history.json', import.meta.url)));
  const history = InheritedHistorySchema.parse(projects[1].inherited);
  assert.equal(history.from.id, projects[0].id);
  assert.deepEqual(history.items.map(i => i.who), ['you', 'app', 'you', 'app']);
  assert.deepEqual(history.items.map(i => i.at), [1794348000010, 1794348000020, 1794348000030, 1794348000040]);
  // An item the source itself inherited names where it was said; the source's fit travels as fields.
  assert.deepEqual(history.items.map(i => i.from?.title), ['Phone mount', undefined, undefined, undefined]);
  assert.deepEqual(history.fit, {sizeSource: 'measured', measured: [{id: 'width', label: 'Width', mm: 75.1}]});
  const swift = await readFile(new URL('../../CounterpartKit/Tests/CounterpartKitTests/Fixtures/inherited-history.json', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(swift), projects);
});
