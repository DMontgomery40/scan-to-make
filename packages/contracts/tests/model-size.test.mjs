import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ModelSizeRequestSchema,SizeSourceSchema,planModelSize,SizePlanError} from '../dist/model-size.js';
const scanned={length:62.081,width:46.719,height:21.734};
const maker={kind:'maker',name:'Apple',sourceUrl:'https://support.apple.com/en-us/111851'};
test('maker maps original box edges independently; measured scales every edge evenly',()=>{
 const target={length:60.6,width:45.2,height:21.7};
 const p=planModelSize(scanned,{source:maker,dimensionsMm:target});
 for(const edge of ['length','width','height']){
  assert.equal(p.scaleFactors[edge],target[edge]/scanned[edge]);
  assert(p.scaleFactors[edge]>=.95&&p.scaleFactors[edge]<=1.05);
 }
 const measured=planModelSize(scanned,{source:{kind:'measured',edge:'width',mm:45.2}});
 assert.equal(measured.scaleFactors.length,measured.scaleFactors.height);
 assert.equal(measured.dimensionsMm.length,scanned.length*45.2/scanned.width);
 assert.equal(measured.uncertaintyMm,null);
 const reset=planModelSize(scanned,{source:{kind:'scanned'}});
 assert.deepEqual(reset.dimensionsMm,scanned);assert.equal(reset.uncertaintyMm,2);
 assert.deepEqual(reset.scaleFactors,{length:1,width:1,height:1});
});
test('maker accepts inclusive five percent and refuses larger changes with the spec copy',()=>{
 const base={length:100,width:80,height:60};
 for(const f of [.95,1.05])assert.equal(planModelSize(base,{source:maker,dimensionsMm:{length:100*f,width:80*f,height:60*f}}).scaleFactors.length,f);
 assert.throws(()=>planModelSize(base,{source:maker,dimensionsMm:{length:105.001,width:80,height:60}}),e=>e instanceof SizePlanError&&e.code==='maker-size-out-of-range'&&e.message==="Your scan is too far from Apple's size to fix safely. Scan again, or keep the scanned size.");
 assert.throws(()=>planModelSize({length:40,width:60,height:20},{source:{kind:'scanned'}}));
});
test('strict requests reject mismatched provenance, invalid dimensions and silent extra fields',()=>{
 const base={expectedModelSha256:'a'.repeat(64),expectedSizeRevision:0};
 for(const selection of [
  {source:maker},{source:{kind:'scanned'},dimensionsMm:scanned},
  {source:{kind:'measured',edge:'x',mm:12}},
  {source:{kind:'measured',edge:'length',mm:0}},
  {source:{...maker,sourceUrl:'file:///private'},dimensionsMm:scanned},
  {source:{kind:'scanned'},scale_x:2},
 ])assert.equal(ModelSizeRequestSchema.safeParse({...base,...selection}).success,false);
 assert(ModelSizeRequestSchema.safeParse({...base,source:{kind:'measured',edge:'length',mm:1000}}).success);
});

test('malformed maker URLs return validation errors from safeParse',()=>{
 for(const sourceUrl of ['apple.com','Apple website','https://','']){
  const source={...maker,sourceUrl};
  assert.equal(SizeSourceSchema.safeParse(source).success,false);
  assert.equal(ModelSizeRequestSchema.safeParse({expectedModelSha256:'a'.repeat(64),expectedSizeRevision:0,source,dimensionsMm:scanned}).success,false);
 }
});
