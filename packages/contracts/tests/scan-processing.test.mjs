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
