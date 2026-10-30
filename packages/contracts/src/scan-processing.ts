import {z} from 'zod';

export const SCAN_PROCESSING_SCHEMA_ID='scan-to-make.scan-processing/0.1';
export const SCAN_VIEW_NAMES=['pos_x.png','pos_y.png','pos_z.png','neg_x.png','neg_y.png','neg_z.png','iso_pp.png','iso_np.png','iso_nn.png','iso_pn.png'] as const;
export const ScanArtifactNameSchema=z.enum(['repaired.stl','repaired.obj','report.json',...SCAN_VIEW_NAMES]);
export const DimensionsMmSchema=z.tuple([z.number().finite().positive(),z.number().finite().positive(),z.number().finite().positive()]);
export const ScanReferenceSchema=z.strictObject({dimensionsMm:DimensionsMmSchema,source:z.string().min(1).max(500).optional(),productName:z.string().min(1).max(200).optional()});
export const ScanProcessingRequestSchema=z.strictObject({reference:ScanReferenceSchema.optional()});
const status=z.enum(['queued','running','succeeded','failed']);
const artifact=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive().max(64*1024*1024),mediaType:z.enum(['model/stl','model/obj','application/json','image/png'])});
export const ScanProcessingJobSchema=z.strictObject({
 schema:z.literal(SCAN_PROCESSING_SCHEMA_ID),jobId:z.uuid(),projectId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),captureId:z.uuid(),projectRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),status,previewOnly:z.literal(true),
 stages:z.tuple([
  z.strictObject({kind:z.literal('repair'),status,params:z.strictObject({weldMm:z.literal(.01),componentFraction:z.literal(.01),componentMetric:z.literal('area'),holeMaxEdges:z.literal(0),voxelSizeMm:z.literal(.3),forceVoxel:z.literal(false),denoiseIterations:z.literal(1),denoiseFactor:z.literal(.1),denoiseMaxMm:z.literal(.05),sharpAngleDeg:z.literal(30),deviationSamples:z.literal(10000)})}),
  z.strictObject({kind:z.literal('measure'),status,params:z.strictObject({units:z.literal('mm')})}),
  z.strictObject({kind:z.literal('render'),status,params:z.strictObject({units:z.literal('mm'),resolution:z.literal(512)})})
 ]),reference:ScanReferenceSchema.optional(),measuredPrincipalExtentsMm:DimensionsMmSchema.optional(),
 comparison:z.strictObject({matching:z.literal('sorted-descending'),referenceDimensionsMm:DimensionsMmSchema,measuredDimensionsMm:DimensionsMmSchema,errorMm:z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])}).optional(),
 artifacts:z.record(ScanArtifactNameSchema,artifact).optional(),failure:z.enum(['processing-failed','cancelled','interrupted']).optional(),
}).superRefine((job,ctx)=>{
 if(job.status==='succeeded'&&(!job.artifacts||!job.measuredPrincipalExtentsMm||job.stages.some(s=>s.status!=='succeeded')||!!job.reference!==!!job.comparison))ctx.addIssue({code:'custom',message:'Successful job requires complete outputs'});
});
export type ScanProcessingJob=z.infer<typeof ScanProcessingJobSchema>;
export type ScanReference=z.infer<typeof ScanReferenceSchema>;
export type ScanArtifactName=z.infer<typeof ScanArtifactNameSchema>;
/** PCA axes have no semantic width/height/depth: compare both triples sorted descending. */
export function compareScanDimensions(measured:unknown,reference:unknown){
 const m=DimensionsMmSchema.parse(measured).sort((a,b)=>b-a),r=DimensionsMmSchema.parse(reference).sort((a,b)=>b-a);
 return {matching:'sorted-descending' as const,referenceDimensionsMm:r,measuredDimensionsMm:m,errorMm:m.map((v,i)=>v-r[i]!)};
}
