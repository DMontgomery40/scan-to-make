import { z } from 'zod';
import { ArtifactRefSchema } from './index.js';

const nonempty = z.string().trim().min(1).max(1024);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const artifact = ArtifactRefSchema.unwrap();
const layer = z.strictObject({ identifier: nonempty, artifact: ArtifactRefSchema });

/** Metadata describing retained bytes, not verification of those bytes or captured geometry. */
export const CaptureReceiptSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  original: ArtifactRefSchema,
  derived: artifact.extend({ mediaType: z.literal('model/obj') }),
  conversionReport: artifact.extend({ mediaType: z.literal('application/json') }),
  converter: z.strictObject({ name: z.literal('capture-mesh-convert'), version: nonempty }),
  provenance: z.strictObject({
    metersPerUnit: z.number().finite().positive(),
    unitsAuthored: z.boolean(),
    upAxis: z.enum(['Y', 'Z']),
    coordinates: z.literal('world'),
    // Exact transform details remain in the hash-bound converter report and original layers.
    transformPolicy: z.literal('composed-once-native-unrescaled'),
    contributingLayers: z.array(layer).min(1).max(1024),
  }),
  qualification: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('qualified'), reasons: z.array(nonempty).length(0) }),
    z.strictObject({ status: z.literal('unqualified'), reasons: z.array(nonempty).min(1).max(1024) }),
  ]),
  evidence: z.strictObject({
    metricAccuracy: z.literal('unknown'),
    surfaceCompleteness: z.literal('unknown'),
    physicalFit: z.literal('unknown'),
  }),
}).superRefine((receipt, ctx) => {
  if (receipt.qualification.status === 'qualified' && !receipt.provenance.unitsAuthored) {
    ctx.addIssue({code:'custom',path:['qualification'],message:'Qualified conversion requires authored units'});
  }
  const identifiers = receipt.provenance.contributingLayers.map(layer => layer.identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    ctx.addIssue({code:'custom',path:['provenance','contributingLayers'],message:'Layer identifiers must be unique'});
  }
});

const projectFields = {
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  projectRevision: revision,
};
export const CaptureBindingSchema = z.strictObject({ ...projectFields, capture: CaptureReceiptSchema });
export const CaptureBindingExpectationSchema = z.strictObject({
  ...projectFields,
  original: ArtifactRefSchema,
  derived: ArtifactRefSchema,
  conversionReport: ArtifactRefSchema,
});
export type CaptureReceipt = z.infer<typeof CaptureReceiptSchema>;
export type CaptureBinding = z.infer<typeof CaptureBindingSchema>;
export type CaptureBindingExpectation = z.infer<typeof CaptureBindingExpectationSchema>;

/** Caller supplies current project/revision and independently verified artifact identities.
 * Storage must compare the revision atomically when persisting; this is not a storage lock.
 */
export function validateCaptureBinding(input: unknown, expectedInput: unknown): CaptureBinding {
  const binding = CaptureBindingSchema.parse(input);
  const expected = CaptureBindingExpectationSchema.parse(expectedInput);
  if (binding.projectId !== expected.projectId || binding.projectRevision !== expected.projectRevision) {
    throw new Error('Capture binding does not match the current project revision');
  }
  for (const key of ['original', 'derived', 'conversionReport'] as const) {
    const actual = binding.capture[key];
    const wanted = expected[key];
    if (actual.sha256 !== wanted.sha256 || actual.byteLength !== wanted.byteLength || actual.mediaType !== wanted.mediaType) {
      throw new Error(`Capture ${key} identity mismatch`);
    }
  }
  return binding;
}

/** Eligibility for bounds/topology evaluation only; never physical fit or completeness. */
export function isCaptureEvaluationEligible(input: unknown): boolean {
  const parsed = CaptureReceiptSchema.safeParse(input);
  return parsed.success && parsed.data.qualification.status === 'qualified';
}
