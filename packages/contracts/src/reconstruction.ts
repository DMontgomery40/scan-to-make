import {z} from 'zod';

/**
 * Linux photo reconstruction (tools/linux-reconstruct): capture-camera v1 from
 * the phone, the public reconstruction review on an object, and the answers
 * that resume it. Kept in exact agreement with tools/linux-reconstruct/README.md
 * and schemas.py; the tool re-validates everything it is handed.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const extents = z.strictObject({x: z.number().finite(), y: z.number().finite(), z: z.number().finite()});
export type ReconstructionExtents = z.infer<typeof extents>;

// ---------------------------------------------------------------- capture-camera v1

export const CaptureCameraFrameSchema = z.strictObject({
  image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sha256,
  width: z.number().int().min(16).max(32768),
  height: z.number().int().min(16).max(32768),
  fx: z.number().finite().positive(),
  fy: z.number().finite().positive(),
  cx: z.number().finite(),
  cy: z.number().finite(),
  timestampMs: z.number().int().nonnegative(),
  tracking: z.enum(['tracking', 'limited', 'not-tracking']),
  center: vec3,
});
export type CaptureCameraFrame = z.infer<typeof CaptureCameraFrameSchema>;

export const CaptureCameraObjectAnchorSchema = z.strictObject({
  center: vec3,
  radiusM: z.number().finite().min(0.01).max(5),
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(['arcore-anchor', 'user-tap', 'depth-centroid']),
});
export type CaptureCameraObjectAnchor = z.infer<typeof CaptureCameraObjectAnchorSchema>;

export const CaptureCameraSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('capture-camera'),
  frames: z.array(CaptureCameraFrameSchema).min(1).max(10000),
  objectAnchor: CaptureCameraObjectAnchorSchema.nullable().optional(),
});
export type CaptureCamera = z.infer<typeof CaptureCameraSchema>;

// ---------------------------------------------------------------- public review

export const ReconstructionSuggestionSchema = z.strictObject({
  type: z.enum(['anchor-region', 'component']),
  reason: z.string().min(1).max(512),
  extents,
  extentsM: extents.optional(),
});
export type ReconstructionSuggestion = z.infer<typeof ReconstructionSuggestionSchema>;

export const ReconstructionComponentSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  vertices: z.number().int().nonnegative(),
  faces: z.number().int().nonnegative(),
  share: z.number().finite().min(0).max(1),
  boundsMin: vec3,
  boundsMax: vec3,
  extents,
});
export type ReconstructionComponent = z.infer<typeof ReconstructionComponentSchema>;

/**
 * What the apps see while a rebuild waits for the person. `preview` is the
 * reconstruction-preview.stl route for this review id, never a file path.
 * Bounds/extents are in reconstruction units until `scaleKnown`; crop answers
 * use these same preview coordinates.
 */
export const ReconstructionReviewSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['region', 'scale']),
  preview: z.string().regex(/^reconstruction-preview\.stl\?reviewId=[0-9a-f-]{36}$/),
  /** `region`: hash of the full preview mesh the answer binds to. */
  previewMeshSha256: sha256.optional(),
  /** `scale`: hash of the confirmed unscaled mesh a measurement binds to. */
  meshSha256: sha256.optional(),
  boundsMin: vec3,
  boundsMax: vec3,
  extents,
  scaleKnown: z.boolean(),
  scaleMPerUnit: z.number().finite().positive().optional(),
  suggestion: ReconstructionSuggestionSchema.optional(),
  components: z.array(ReconstructionComponentSchema).max(512).optional(),
});
export type ReconstructionReview = z.infer<typeof ReconstructionReviewSchema>;

// ---------------------------------------------------------------- answers

export const ReconstructionSelectionSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('suggested')}),
  z.strictObject({type: z.literal('component'), index: z.number().int().nonnegative()}),
  z.strictObject({type: z.literal('crop'), min: vec3, max: vec3}),
]);
export type ReconstructionSelection = z.infer<typeof ReconstructionSelectionSchema>;

export const ReconstructionAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({type: z.literal('region'), previewMeshSha256: sha256, selection: ReconstructionSelectionSchema}),
  z.strictObject({type: z.literal('scale'), meshSha256: sha256, axis: z.enum(['x', 'y', 'z']), extentMm: z.number().finite().min(1).max(10000)}),
]);
export type ReconstructionAnswer = z.infer<typeof ReconstructionAnswerSchema>;

// ---------------------------------------------------------------- tool sidecars (files the companion writes for the tool)

export const CaptureObjectRegionSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('capture-object-region'),
  previewMeshSha256: sha256,
  selection: ReconstructionSelectionSchema,
});
export type CaptureObjectRegion = z.infer<typeof CaptureObjectRegionSchema>;

export const CaptureMeasurementSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('capture-measurement'),
  meshSha256: sha256,
  axis: z.enum(['x', 'y', 'z']),
  extentMm: z.number().finite().min(1).max(10000),
});
export type CaptureMeasurement = z.infer<typeof CaptureMeasurementSchema>;
