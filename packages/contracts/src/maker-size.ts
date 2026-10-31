import {z} from 'zod';
import {BoxDimensionsMmSchema,SizeSourceSchema} from './model-size.js';

/** A suggestion, never an accepted size. Edges are longest, middle, shortest. */
export const MakerSizeProposalSchema=z.strictObject({
 productName:z.string().trim().min(1).max(200),
 makerName:z.string().trim().min(1).max(200),
 dimensionsMm:BoxDimensionsMmSchema.refine(d=>d.length>=d.width&&d.width>=d.height,'Use longest, middle, shortest edges'),
 sourceUrl:z.string().max(2048).refine(value=>SizeSourceSchema.safeParse({kind:'maker',name:'maker',sourceUrl:value}).success,'Use an HTTPS source URL without credentials'),
 // The model's estimate of product identification, not a calibrated probability.
 confidence:z.number().finite().min(0).max(1),
});
export type MakerSizeProposal=z.infer<typeof MakerSizeProposalSchema>;
export const MakerSizeResultSchema=z.strictObject({
 jobId:z.uuid(),baseModelSha256:z.string().regex(/^[a-f0-9]{64}$/),
 proposal:MakerSizeProposalSchema.nullable(),
});
export type MakerSizeResult=z.infer<typeof MakerSizeResultSchema>;
