import {join} from 'node:path';
import {fixture,fakeRunner} from './scan-processing.mjs';
import {ModelSizeStore} from '../../dist/model-size.js';
export const rotation=[[1,0,0],[0,1,0],[0,0,1]];
export const dimensionsMm={length:62.081,width:46.719,height:21.734};
export const fakeSizeRunner=async(input,factors)=>({bytes:Buffer.from(JSON.stringify({base:input.sha256,factors})),dimensionsMm:Object.fromEntries(Object.entries(input.dimensionsMm).map(([k,v])=>[k,v*factors[k]])),transform:{rotation:input.rotation,centreMm:[0,0,0],scaleFactors:factors}});
export async function sizeFixture(t,run=fakeSizeRunner){
 const f=await fixture(t,{async run(...args){await fakeRunner.run(...args);return Buffer.from(JSON.stringify({principalExtentsMm:Object.values(dimensionsMm),boxExtentsMm:Object.values(dimensionsMm),boxRotation:rotation}));}});
 const {job}=await f.store.start(f.input);await f.store.wait();
 const sizes=new ModelSizeStore(f.storage,f.store,join(f.root,'captures'),run);
 const original=await sizes.get(f.input,job.jobId);
 return {...f,sizes,job,original,request:{expectedModelSha256:original.baseModelSha256,expectedSizeRevision:0,source:{kind:'maker',name:'Apple',sourceUrl:'https://support.apple.com/en-us/111834'},dimensionsMm:{length:60.6,width:45.2,height:21.7}}};
}
