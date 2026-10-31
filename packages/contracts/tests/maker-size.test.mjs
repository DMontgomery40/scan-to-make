import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MakerSizeProposalSchema} from '../dist/maker-size.js';
import {planModelSize} from '../dist/model-size.js';
const proposal={productName:'AirPods Pro 2 charging case (USB-C)',makerName:'Apple',dimensionsMm:{length:60.6,width:45.2,height:21.7},sourceUrl:'https://support.apple.com/en-us/111834',confidence:.91};
test('maker proposal maps to BE-3 only when the caller explicitly selects it',()=>{
 const p=MakerSizeProposalSchema.parse(proposal);
 const plan=planModelSize({length:62.081,width:46.719,height:21.734},{source:{kind:'maker',name:p.makerName,sourceUrl:p.sourceUrl},dimensionsMm:p.dimensionsMm});
 assert.deepEqual(plan.dimensionsMm,p.dimensionsMm);
 for(const factor of Object.values(plan.scaleFactors))assert(factor>=.95&&factor<=1.05);
});
test('rejects invalid, unordered, unbounded or executable proposal data',()=>{
 for(const patch of [{sourceUrl:'not a URL'},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://user:password@example.com'},
  {confidence:NaN},{confidence:1.1},{dimensionsMm:{length:20,width:30,height:10}},
  {dimensionsMm:{length:60,width:40,height:0}},{makerName:''},{productName:'x'.repeat(201)},{apply:true}])
  assert.equal(MakerSizeProposalSchema.safeParse({...proposal,...patch}).success,false,JSON.stringify(patch));
});
