import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareScanDimensions,ScanProcessingRequestSchema,ScanProcessingJobSchema} from '../dist/scan-processing.js';
test('principal extents match reference by descending size, errors are measured minus reference',()=>{
 const comparison=compareScanDimensions([21.7,62.9,48.7],[45.2,21.7,60.6]);assert.equal(comparison.matching,'sorted-descending');assert.deepEqual(comparison.errorMm.map(x=>+x.toFixed(2)),[2.3,3.5,0]);
});
test('strict reference rejects nonfinite, nonpositive, wrong cardinality and executable configuration',()=>{
 for(const dimensionsMm of [[0,1,2],[1,2],[1,2,3,4],[Infinity,2,3]])assert(!ScanProcessingRequestSchema.safeParse({reference:{dimensionsMm}}).success);
 assert(!ScanProcessingRequestSchema.safeParse({blender:'/evil'}).success);assert(!ScanProcessingJobSchema.safeParse({previewOnly:false}).success);
});
test('repair params record Taubin smoothing; retained Laplacian jobs still load; amplifying pairs reject',()=>{
 // Same key order the companion records.
 const taubin={weldMm:.01,componentFraction:.01,componentMetric:'area',holeMaxEdges:0,voxelSizeMm:.3,forceVoxel:false,denoiseIterations:15,denoiseFactor:.5,denoiseMu:-.53,denoiseMaxMm:.35,sharpAngleDeg:30,deviationSamples:10000};
 const {denoiseMu:_,...legacy}={...taubin,denoiseIterations:1,denoiseFactor:.1,denoiseMaxMm:.05};
 const job=params=>({schema:'scan-to-make.scan-processing/0.1',jobId:'44444444-4444-4444-8444-444444444444',projectId:'one',captureId:'11111111-1111-4111-8111-111111111111',projectRevision:0,status:'queued',previewOnly:true,
  stages:[{kind:'repair',status:'queued',params},{kind:'measure',status:'queued',params:{units:'mm'}},{kind:'render',status:'queued',params:{units:'mm',resolution:512}}]});
 assert.deepEqual(Object.keys(ScanProcessingJobSchema.parse(job(taubin)).stages[0].params),Object.keys(taubin));
 assert(ScanProcessingJobSchema.safeParse(job(legacy)).success);
 // Lambda .1 with mu -.53 amplifies every frequency; the legacy record never carries a mu.
 for(const params of [{...taubin,denoiseFactor:.1,denoiseIterations:1},{...legacy,denoiseMu:-.53}])
  assert(!ScanProcessingJobSchema.safeParse(job(params)).success);
});

test('cleanup success requires final geometry, advice, box measurement and completed ordered stages',()=>{
 const params={weldMm:.01,componentFraction:.01,componentMetric:'area',holeMaxEdges:0,voxelSizeMm:.3,forceVoxel:false,denoiseIterations:15,denoiseFactor:.5,denoiseMu:-.53,denoiseMaxMm:.35,sharpAngleDeg:30,deviationSamples:10000};
 const kinds=['import','repair','advise','correct','measure','render'];
 const names=['repaired.stl','repaired.obj','report.json','corrected.stl','corrected.obj','correction.json','correction-calls.jsonl','advice.json','pos_x.png','pos_y.png','pos_z.png','neg_x.png','neg_y.png','neg_z.png','iso_pp.png','iso_np.png','iso_nn.png','iso_pn.png'];
 const job={schema:'scan-to-make.scan-processing/0.1',jobId:'44444444-4444-4444-8444-444444444444',projectId:'one',captureId:'11111111-1111-4111-8111-111111111111',projectRevision:0,status:'succeeded',previewOnly:true,
  stages:[{kind:'repair',status:'succeeded',params},{kind:'measure',status:'succeeded',params:{units:'mm'}},{kind:'render',status:'succeeded',params:{units:'mm',resolution:512}}],
  pipelineStages:kinds.map(kind=>({kind,status:'succeeded'})),measuredPrincipalExtentsMm:[63,42,21],measuredBoxExtentsMm:[60,40,20],
  artifacts:Object.fromEntries(names.map(name=>[name,{sha256:'a'.repeat(64),byteLength:1,mediaType:name.endsWith('.png')?'image/png':name.endsWith('.stl')?'model/stl':name.endsWith('.obj')?'model/obj':name.endsWith('.jsonl')?'application/x-ndjson':'application/json'}]))};
 assert(ScanProcessingJobSchema.safeParse(job).success);
 for(const mutate of [j=>delete j.measuredBoxExtentsMm,j=>delete j.artifacts['corrected.stl'],j=>delete j.artifacts['advice.json'],...['corrected.obj','correction.json','correction-calls.jsonl'].map(name=>j=>delete j.artifacts[name]),j=>j.pipelineStages[3].status='queued',j=>j.pipelineStages.reverse()]){
  const incomplete=structuredClone(job);mutate(incomplete);assert(!ScanProcessingJobSchema.safeParse(incomplete).success);
 }
 // On terminal failure, queued denotes work never started, not a retry scheduled by the server.
 const failed=structuredClone(job);failed.status='failed';failed.failure='processing-failed';failed.pipelineStages[3].status='failed';failed.pipelineStages[4].status='queued';failed.pipelineStages[5].status='queued';
 assert(ScanProcessingJobSchema.safeParse(failed).success);
});
