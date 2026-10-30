import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('every export condition map has a default matching its import target (Metro Release resolution)',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 for(const [subpath,conditions] of Object.entries(pkg.exports)){
  assert.equal(conditions.default,conditions.import,`${subpath} default must match import`);
  assert.match(conditions.types,/\.d\.ts$/,`${subpath} types`);
 }
});
