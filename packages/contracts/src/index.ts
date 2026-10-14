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

/** Drawer geometry has its own closed set of dimensions, never cup-field aliases. */
export const DrawerDimensionsSchema = z.strictObject({
  drawerInnerWidth: requiredDimension,
  drawerInnerDepth: requiredDimension,
  drawerInnerHeight: requiredDimension,
  wallThickness: requiredDimension,
  floorThickness: requiredDimension,
  peripheralClearance: DimensionSchema,
  trayHeight: requiredDimension,
});
export const DrawerParametersSchema = z.strictObject({
  dividersAcross: z.number().int().min(0).max(8),
  dividersAlong: z.number().int().min(0).max(8),
});
const drawerKeys = DrawerDimensionsSchema.keyof().options;
export const DrawerFitEvidenceSchema = FitEvidenceSchema.extend({
  dimensions: DrawerDimensionsSchema,
  // A declaration of what was tested; validation cannot establish physical truth.
  contactRegion: z.literal('full-drawer-envelope'),
});

export const DrawerFitSpecSchema = z.strictObject({
  schemaVersion: z.literal('0.2.0'),
  id,
  revision,
  template: z.literal('drawer-tray'),
  units: z.literal('mm'),
  frame: z.strictObject({
    handedness: z.literal('right'),
    upAxis: z.literal('z'),
    origin: z.literal('drawer-floor-center'),
  }),
  dimensions: DrawerDimensionsSchema,
  parameters: DrawerParametersSchema,
  interfaces: z.strictObject({
    'drawer-cavity': z.strictObject({ fitEvidence: z.array(DrawerFitEvidenceSchema) }),
  }),
}).superRefine((spec, ctx) => {
  const d = spec.dimensions;
  const p = spec.parameters;
  if (d.trayHeight.upperMm > d.drawerInnerHeight.lowerMm) {
    ctx.addIssue({ code: 'custom', path: ['dimensions', 'trayHeight'],
      message: 'Tray height must fit below the lowest drawer obstruction' });
  }
  if (d.floorThickness.upperMm >= d.trayHeight.lowerMm ||
      ((p.dividersAcross > 0 || p.dividersAlong > 0) &&
       d.floorThickness.upperMm + 2 >= d.trayHeight.lowerMm)) {
    ctx.addIssue({ code: 'custom', path: ['dimensions', 'trayHeight'],
      message: 'Tray needs space above its floor and dividers must extend above the floor with a 2 mm top setback' });
  }
  for (const [dimension, count] of [
    ['drawerInnerWidth', p.dividersAcross], ['drawerInnerDepth', p.dividersAlong],
  ] as const) {
    const cell = (d[dimension].lowerMm - 2 * d.peripheralClearance.upperMm -
      (count + 2) * d.wallThickness.upperMm) / (count + 1);
    if (!Number.isFinite(cell) || cell < 10) {
      ctx.addIssue({ code: 'custom', path: ['dimensions', dimension],
        message: 'Every cell must retain at least 10 mm clear span at interval extremes' });
    }
  }
  for (const [index, evidence] of spec.interfaces['drawer-cavity'].fitEvidence.entries()) {
    if (evidence.assessedRevision > spec.revision ||
        drawerKeys.some(key => !sameDimension(evidence.dimensions[key], d[key]))) {
      ctx.addIssue({ code: 'custom', path: ['interfaces', 'drawer-cavity', 'fitEvidence', index],
        message: 'Fit evidence must reference an existing revision and the exact current drawer envelope dimensions' });
    }
  }
});

export const DrawerFitSpecPatchSchema = z.strictObject({
  template: z.literal('drawer-tray'),
  expectedRevision: revision,
  dimensions: DrawerDimensionsSchema.partial(),
  parameters: DrawerParametersSchema.partial().optional(),
  authorizedInterfaceIds: z.array(z.literal('drawer-cavity')).optional(),
});

// Existing FitSpec APIs remain cup-specific so existing mobile consumers stay typed.
export const ProjectFitSpecSchema = z.discriminatedUnion('template', [FitSpecSchema, DrawerFitSpecSchema]);
export const ProjectFitSpecPatchSchema = z.union([FitSpecPatchSchema, DrawerFitSpecPatchSchema]);
export type DrawerFitSpec = z.infer<typeof DrawerFitSpecSchema>;
export type DrawerFitSpecPatch = z.infer<typeof DrawerFitSpecPatchSchema>;
export type ProjectFitSpec = z.infer<typeof ProjectFitSpecSchema>;
export type ProjectFitSpecPatch = z.infer<typeof ProjectFitSpecPatchSchema>;

export function validateProjectFitSpec(input: unknown): ProjectFitSpec {
  return ProjectFitSpecSchema.parse(input);
}

/** A patch is parsed against the loaded template; it cannot change templates. */
export function applyProjectFitSpecPatch(current: ProjectFitSpec, input: unknown): ProjectFitSpec {
  const spec = validateProjectFitSpec(current);
  if (spec.template === 'cup-holder-adapter') {
    return applyFitSpecPatch(spec, FitSpecPatchSchema.parse(input));
  }
  const patch = DrawerFitSpecPatchSchema.parse(input);
  if (patch.expectedRevision !== spec.revision) throw new Error('Stale FitSpec revision');
  const changesEnvelope = drawerKeys.some(key => patch.dimensions[key] !== undefined &&
    !sameDimension(spec.dimensions[key], patch.dimensions[key]));
  const parameters = { ...spec.parameters, ...patch.parameters };
  const changesLayout = parameters.dividersAcross !== spec.parameters.dividersAcross ||
    parameters.dividersAlong !== spec.parameters.dividersAlong;
  if (!changesEnvelope && !changesLayout) return spec;
  if (spec.revision === Number.MAX_SAFE_INTEGER) throw new Error('FitSpec revision exhausted');
  if (changesEnvelope && !patch.authorizedInterfaceIds?.includes('drawer-cavity')) {
    throw new Error('Changing drawer-cavity requires explicit interface authorization');
  }
  return DrawerFitSpecSchema.parse({
    ...spec,
    revision: spec.revision + 1,
    dimensions: { ...spec.dimensions, ...patch.dimensions },
    parameters,
    interfaces: changesEnvelope ? { 'drawer-cavity': { fitEvidence: [] } } : spec.interfaces,
  });
}
