import { z } from 'zod';

const id = z.string().trim().min(1);
const positiveMm = z.number().finite().positive();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const DimensionSchema = z.strictObject({
  nominalMm: z.number().finite().nonnegative(),
  lowerMm: z.number().finite().nonnegative(),
  upperMm: z.number().finite().nonnegative(),
  source: z.enum(['manual', 'scan', 'reference', 'design']),
  sourceId: id,
}).refine(d => d.lowerMm <= d.nominalMm && d.nominalMm <= d.upperMm, {
  message: 'Dimension requires lowerMm <= nominalMm <= upperMm',
});

const requiredDimension = DimensionSchema.refine(d => d.lowerMm > 0, {
  message: 'This dimension must be strictly positive over its interval',
});

export const DimensionsSchema = z.strictObject({
  holderInnerBottomDiameter: requiredDimension,
  holderInnerTopDiameter: requiredDimension,
  insertionDepth: requiredDimension,
  cupOuterDiameter: requiredDimension,
  cupSupportHeight: requiredDimension,
  wallThickness: requiredDimension,
  radialClearance: DimensionSchema,
});

export const ArtifactRefSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).readonly();

export const CalibrationScopeSchema = z.strictObject({
  printerId: id,
  printerModel: id,
  nozzleDiameterMm: positiveMm,
  material: id,
  orientation: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
    .refine(v => Math.abs(Math.hypot(...v) - 1) < 1e-6, {
      message: 'Orientation must be a unit vector in the declared frame',
    }),
  slicerSettingsSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const insertKeys = ['holderInnerBottomDiameter', 'holderInnerTopDiameter',
  'insertionDepth', 'wallThickness', 'radialClearance'] as const;
export const InsertDimensionsSchema = DimensionsSchema.pick({
  holderInnerBottomDiameter: true, holderInnerTopDiameter: true,
  insertionDepth: true, wallThickness: true, radialClearance: true,
});

export const FitEvidenceSchema = z.strictObject({
  id,
  assessedRevision: revision,
  observedAt: z.iso.datetime({ offset: true }),
  observerSourceId: id,
  outcome: z.enum(['reported-fit', 'reported-misfit']),
  dimensions: InsertDimensionsSchema,
  scope: CalibrationScopeSchema,
  couponArtifact: ArtifactRefSchema,
});

function sameDimension(a: Dimension, b: Dimension): boolean {
  return a.nominalMm === b.nominalMm && a.lowerMm === b.lowerMm &&
    a.upperMm === b.upperMm && a.source === b.source && a.sourceId === b.sourceId;
}

export const FitSpecSchema = z.strictObject({
  schemaVersion: z.literal('0.1.0'),
  id,
  revision,
  template: z.literal('cup-holder-adapter'),
  units: z.literal('mm'),
  frame: z.strictObject({
    handedness: z.literal('right'),
    upAxis: z.literal('z'),
    origin: z.literal('holder-base-center'),
  }),
  dimensions: DimensionsSchema,
  interfaces: z.strictObject({
    'holder-insert': z.strictObject({ fitEvidence: z.array(FitEvidenceSchema) }),
  }),
}).superRefine((spec, ctx) => {
  for (const [index, evidence] of spec.interfaces['holder-insert'].fitEvidence.entries()) {
    if (evidence.assessedRevision > spec.revision ||
        insertKeys.some(key => !sameDimension(evidence.dimensions[key], spec.dimensions[key]))) {
      ctx.addIssue({ code: 'custom', path: ['interfaces', 'holder-insert', 'fitEvidence', index],
        message: 'Fit evidence must reference an existing revision and the exact current interface dimensions' });
    }
  }
});

export const FitSpecPatchSchema = z.strictObject({
  expectedRevision: revision,
  dimensions: DimensionsSchema.partial(),
  authorizedInterfaceIds: z.array(z.literal('holder-insert')).optional(),
});

export type Dimension = z.infer<typeof DimensionSchema>;
export type FitSpec = z.infer<typeof FitSpecSchema>;
export type FitSpecPatch = z.infer<typeof FitSpecPatchSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type CalibrationScope = z.infer<typeof CalibrationScopeSchema>;
export type FitEvidence = z.infer<typeof FitEvidenceSchema>;

export function validateFitSpec(input: unknown): FitSpec { return FitSpecSchema.parse(input); }
export function validateArtifactRef(input: unknown): ArtifactRef { return ArtifactRefSchema.parse(input); }

export function applyFitSpecPatch(current: FitSpec, input: FitSpecPatch): FitSpec {
  const spec = validateFitSpec(current);
  const patch = FitSpecPatchSchema.parse(input);
  if (patch.expectedRevision !== spec.revision) throw new Error('Stale FitSpec revision');
  const changedKeys = (Object.keys(patch.dimensions) as (keyof FitSpec['dimensions'])[])
    .filter(key => !sameDimension(spec.dimensions[key], patch.dimensions[key]!));
  if (changedKeys.length === 0) return spec;
  if (spec.revision === Number.MAX_SAFE_INTEGER) throw new Error('FitSpec revision exhausted');
  const changesInsert = insertKeys.some(key => changedKeys.includes(key));
  if (changesInsert && !patch.authorizedInterfaceIds?.includes('holder-insert')) {
    throw new Error('Changing holder-insert requires explicit interface authorization');
  }
  return validateFitSpec({
    ...spec,
    revision: spec.revision + 1,
    dimensions: { ...spec.dimensions, ...patch.dimensions },
    interfaces: changesInsert ? { 'holder-insert': { fitEvidence: [] } } : spec.interfaces,
  });
}
