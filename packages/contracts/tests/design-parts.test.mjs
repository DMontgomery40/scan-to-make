// #691, #874 P3: a sealed design's parts are part of the contract every client decodes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as c from '../dist/counterpart.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/project-parts.json', import.meta.url), 'utf8'));

test('the shared fixture\'s sealed design, parts and all, is a design version', () => {
  const version = fixture.cases.find(item => item.name.startsWith('a sealed')).object.versions[0];
  const parsed = c.DesignVersionSchema.parse(version);
  assert.deepEqual(parsed.result.parts.map(part => [part.id, part.colour, part.mesh]), version.result.parts.map(part => [part.id, part.colour, part.mesh]));
  // Every case's parts (current's included) are parts as the schema reads them.
  for (const item of fixture.cases) for (const part of item.object.current.parts ?? []) assert.ok(c.DesignPartSchema.safeParse(part).success, `${item.name}: ${part.id}`);
});

test('parts are more than one, each a project path with a #RRGGBB colour or none', () => {
  const version = structuredClone(fixture.cases.find(item => item.name.startsWith('a sealed')).object.versions[0]);
  const withParts = parts => ({...version, result: {...version.result, parts}});
  assert.equal(c.DesignVersionSchema.safeParse(withParts(version.result.parts.slice(0, 1))).success, false, 'one part is drawn by the spool rule, not recorded');
  assert.equal(c.DesignVersionSchema.safeParse(withParts([{...version.result.parts[0], mesh: '../escape.stl'}, version.result.parts[1]])).success, false);
  assert.equal(c.DesignVersionSchema.safeParse(withParts([{...version.result.parts[0], colour: 'black'}, version.result.parts[1]])).success, false);
  assert.ok(c.DesignVersionSchema.safeParse(withParts([{id: '1/1', mesh: 'versions/x/parts/part-1.stl'}, {id: '1/2', mesh: 'versions/x/parts/part-2.stl'}])).success, 'no name or colour: neutral');
});
