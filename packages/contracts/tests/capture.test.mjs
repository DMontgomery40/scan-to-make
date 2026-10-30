import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from '../dist/capture.js';
const ref = (c, mediaType='model/obj') => ({sha256:c.repeat(64),byteLength:123,mediaType});
const receipt = () => ({formatVersion:'0.1.0', original:ref('a','model/vnd.usdz+zip'), derived:ref('b'), conversionReport:ref('c','application/json'), converter:{name:'capture-mesh-convert',version:'0.1.0'}, provenance:{metersPerUnit:0.01,unitsAuthored:true,upAxis:'Y',coordinates:'world',transformPolicy:'composed-once-native-unrescaled',contributingLayers:[{identifier:'root.usdc',artifact:ref('d','application/octet-stream')}]}, qualification:{status:'qualified',reasons:[]}, evidence:{metricAccuracy:'unknown',surfaceCompleteness:'unknown',physicalFit:'unknown'}});
const binding = () => ({projectId:'drawer',projectRevision:3,capture:receipt()});
const expected = () => ({projectId:'drawer',projectRevision:3,original:ref('a','model/vnd.usdz+zip'),derived:ref('b'),conversionReport:ref('c','application/json')});
test('retains exact source, output, report and native provenance without fit promotion',()=>{
 const r=api.validateCaptureBinding(binding(),expected());
 assert.deepEqual(r,binding()); assert.equal(r.capture.evidence.physicalFit,'unknown');
});
test('unqualified conversion is retainable but never eligible for downstream evaluation',()=>{
 const r=receipt();r.qualification={status:'unqualified',reasons:['unauthored units']};r.provenance.unitsAuthored=false;
 assert.equal(api.CaptureReceiptSchema.safeParse(r).success,true);
 assert.equal(api.isCaptureEvaluationEligible(r),false);
 assert.equal(api.isCaptureEvaluationEligible(receipt()),true);
});
test('rejects stale revision and substitution of source, derived or report identity',()=>{
 for(const mutate of [e=>e.projectRevision++,e=>e.projectId='other',e=>e.original.sha256='f'.repeat(64),e=>e.derived.byteLength++,e=>e.conversionReport.sha256='e'.repeat(64)]){
 const e=expected();mutate(e);assert.throws(()=>api.validateCaptureBinding(binding(),e));
 }
});
test('rejects invalid provenance and unsupported evidence promotion',()=>{
 for(const mutate of [r=>r.provenance.metersPerUnit=0,r=>r.provenance.metersPerUnit=NaN,r=>r.provenance.unitsAuthored=false,r=>r.provenance.coordinates='local',r=>r.provenance.transformPolicy='rescaled',r=>r.provenance.contributingLayers=[],r=>r.provenance.contributingLayers.push(r.provenance.contributingLayers[0]),r=>r.original.sha256='bad',r=>r.derived.mediaType='model/stl',r=>r.qualification.reasons=['unsupported mesh'],r=>r.evidence.surfaceCompleteness='complete',r=>r.provenance.extra=true]){
 const r=receipt();mutate(r);assert.equal(api.CaptureReceiptSchema.safeParse(r).success,false);
 }
 const r=receipt();r.qualification={status:'unqualified',reasons:[]};assert.equal(api.CaptureReceiptSchema.safeParse(r).success,false);
});
test('parsed binding is detached from caller mutations and metadata is not byte verification',()=>{
 const b=binding();const r=api.validateCaptureBinding(b,expected());b.capture.provenance.contributingLayers[0].artifact.sha256='f'.repeat(64);
 assert.equal(r.capture.provenance.contributingLayers[0].artifact.sha256,'d'.repeat(64));
});
