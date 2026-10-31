import {z} from 'zod';
import {DetailStillSchema} from './detail-still.js';

export const SCAN_PROCESSING_SCHEMA_ID='scan-to-make.scan-processing/0.1';
export const SCAN_VIEW_NAMES=['pos_x.png','pos_y.png','pos_z.png','neg_x.png','neg_y.png','neg_z.png','iso_pp.png','iso_np.png','iso_nn.png','iso_pn.png'] as const;
export const SCAN_ADVICE_NAMES=['advice.json','advice-01.png','advice-02.png','advice-03.png','advice-04.png'] as const;
export const SCAN_CLEANUP_STAGES=['import','repair','advise','correct','measure','render'] as const;
/** Phone wording for each pipeline stage (journey §3.5). The correct label is
 * hidden when AI is off, even though the scripted stage still runs.
 */
export const SCAN_CLEANUP_STAGE_LABELS={
 import:'Getting your scan',repair:'Filling holes',advise:'Looking for weak spots',
 correct:'Fixing details from your close-ups',measure:'Measuring',render:'Almost done',
} as const satisfies Record<(typeof SCAN_CLEANUP_STAGES)[number],string>;
export const ScanArtifactNameSchema=z.enum(['repaired.stl','repaired.obj','report.json','corrected.stl','corrected.obj','correction.json','correction-calls.jsonl',...SCAN_ADVICE_NAMES,...SCAN_VIEW_NAMES]);
export const DimensionsMmSchema=z.tuple([z.number().finite().positive(),z.number().finite().positive(),z.number().finite().positive()]);
export const ScanReferenceSchema=z.strictObject({dimensionsMm:DimensionsMmSchema,source:z.string().min(1).max(500).optional(),productName:z.string().min(1).max(200).optional()});
export const ScanProcessingRequestSchema=z.strictObject({reference:ScanReferenceSchema.optional(),stillIds:z.array(z.uuid()).max(4).refine(ids=>new Set(ids).size===ids.length,'Duplicate still IDs').optional()});
const status=z.enum(['queued','running','succeeded','failed']);
// Taubin smoothing params. The Laplacian record stays valid so jobs retained before the change still load.
const repairParams=z.union([
 z.strictObject({weldMm:z.literal(.01),componentFraction:z.literal(.01),componentMetric:z.literal('area'),holeMaxEdges:z.literal(0),voxelSizeMm:z.literal(.3),forceVoxel:z.literal(false),denoiseIterations:z.literal(15),denoiseFactor:z.literal(.5),denoiseMu:z.literal(-.53),denoiseMaxMm:z.literal(.35),sharpAngleDeg:z.literal(30),deviationSamples:z.literal(10000)}),
 z.strictObject({weldMm:z.literal(.01),componentFraction:z.literal(.01),componentMetric:z.literal('area'),holeMaxEdges:z.literal(0),voxelSizeMm:z.literal(.3),forceVoxel:z.literal(false),denoiseIterations:z.literal(1),denoiseFactor:z.literal(.1),denoiseMaxMm:z.literal(.05),sharpAngleDeg:z.literal(30),deviationSamples:z.literal(10000)}),
]);
const artifact=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),byteLength:z.number().int().positive().max(64*1024*1024),mediaType:z.enum(['model/stl','model/obj','application/json','application/x-ndjson','image/png'])});
// Optional on every stage and on the job so records retained before BE-2 still load.
const stageTimes={startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional()};
export const ScanProcessingJobSchema=z.strictObject({
 schema:z.literal(SCAN_PROCESSING_SCHEMA_ID),jobId:z.uuid(),projectId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),captureId:z.uuid(),projectRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),status,previewOnly:z.literal(true),
 // The retained capture's original-byte identity; the server queue dedupes on it.
 captureSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
 // Epoch milliseconds at enqueue: job ids are random, so this is how clients
 // order jobs (newest finished wins). Same instant as enqueuedAt.
 createdAtMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
 trigger:z.enum(['request','capture-import','detail-still']).optional(),
 enqueuedAt:z.iso.datetime().optional(),startedAt:z.iso.datetime().optional(),finishedAt:z.iso.datetime().optional(),
 stages:z.tuple([
  z.strictObject({kind:z.literal('repair'),status,params:repairParams,...stageTimes}),
  z.strictObject({kind:z.literal('measure'),status,params:z.strictObject({units:z.literal('mm')}),...stageTimes}),
  z.strictObject({kind:z.literal('render'),status,params:z.strictObject({units:z.literal('mm'),resolution:z.literal(512)}),...stageTimes})
 ]),reference:ScanReferenceSchema.optional(),measuredPrincipalExtentsMm:DimensionsMmSchema.optional(),measuredBoxExtentsMm:DimensionsMmSchema.optional(),
 pipelineStages:z.array(z.strictObject({kind:z.enum(SCAN_CLEANUP_STAGES),status,...stageTimes})).length(6).refine(stages=>stages.every((s,i)=>s.kind===SCAN_CLEANUP_STAGES[i]),'Invalid cleanup stage order').optional(),
 wallClockLimitMs:z.number().int().positive().max(1800000).optional(),
 failureStage:z.enum([...SCAN_CLEANUP_STAGES,'publish']).optional(),
 correctionAdapter:z.enum(['scripted','anthropic','openai']).optional(),detailStills:z.array(DetailStillSchema).max(4).optional(),
 comparison:z.strictObject({matching:z.literal('sorted-descending'),referenceDimensionsMm:DimensionsMmSchema,measuredDimensionsMm:DimensionsMmSchema,errorMm:z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])}).optional(),
 artifacts:z.partialRecord(ScanArtifactNameSchema,artifact).optional(),failure:z.enum(['processing-failed','cancelled','interrupted','deadline-exceeded']).optional(),
}).superRefine((job,ctx)=>{
 if(job.status==='succeeded'&&(!job.artifacts||!job.measuredPrincipalExtentsMm||['repaired.obj','repaired.stl','report.json',...SCAN_VIEW_NAMES].some(name=>!job.artifacts?.[name as ScanArtifactName])||job.stages.some(s=>s.status!=='succeeded')||!!job.reference!==!!job.comparison))ctx.addIssue({code:'custom',message:'Successful job requires complete outputs'});
 if(job.status==='succeeded'&&job.pipelineStages&&(!job.measuredBoxExtentsMm||job.pipelineStages.some(s=>s.status!=='succeeded')||['corrected.stl','corrected.obj','correction.json','correction-calls.jsonl','advice.json'].some(name=>!job.artifacts?.[name as ScanArtifactName])))ctx.addIssue({code:'custom',message:'Successful cleanup requires all stages and corrected/advice outputs'});
});
export type ScanProcessingJob=z.infer<typeof ScanProcessingJobSchema>;
export type ScanReference=z.infer<typeof ScanReferenceSchema>;
export type ScanArtifactName=z.infer<typeof ScanArtifactNameSchema>;
/** Compare measured minimum-volume box extents and the reference sorted descending. */
export function compareScanDimensions(measured:unknown,reference:unknown){
 const m=DimensionsMmSchema.parse(measured).sort((a,b)=>b-a),r=DimensionsMmSchema.parse(reference).sort((a,b)=>b-a);
 return {matching:'sorted-descending' as const,referenceDimensionsMm:r,measuredDimensionsMm:m,errorMm:m.map((v,i)=>v-r[i]!)};
}
