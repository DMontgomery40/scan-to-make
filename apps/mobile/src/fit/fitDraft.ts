import {
  applyFitSpecPatch,
  validateFitSpec,
  type Dimension,
  type FitSpec,
  type FitSpecPatch,
} from '@scan-to-make/contracts';
import taperedHolder from '../../../../packages/contracts/fixtures/tapered-holder.json';

export type DimensionKey = keyof FitSpec['dimensions'];

/** Mirrors the `holder-insert` interface documented in packages/contracts. */
export const HOLDER_INSERT_KEYS: readonly DimensionKey[] = [
  'holderInnerTopDiameter',
  'holderInnerBottomDiameter',
  'insertionDepth',
  'wallThickness',
  'radialClearance',
];

/** Dimensions the user measures on the capture screen, in display order. */
export const MEASURED_KEYS = [
  'holderInnerTopDiameter',
  'holderInnerBottomDiameter',
  'insertionDepth',
  'cupOuterDiameter',
] as const satisfies readonly DimensionKey[];

export type MeasuredKey = (typeof MEASURED_KEYS)[number];

export type MeasuringTool = 'ruler' | 'calipers';

export const TOOL_UNCERTAINTY_MM: Record<MeasuringTool, number> = {
  ruler: 0.5,
  calipers: 0.1,
};

const MAX_REASONABLE_MM = 300;
const USER_SOURCE_PREFIX = 'manual-entry-';
const PREVIEW_SOURCE_PREFIX = 'preview-';

/** Validated copy of the contract's synthetic tapered-holder fixture. */
export function contractFixture(): FitSpec {
  return validateFitSpec(taperedHolder);
}

/**
 * Starting spec for a new project. Until FIT-001 supplies template defaults,
 * the design dimensions come from the contract fixture; its measured values
 * are never presented as the user's (see `isUserMeasured`).
 */
export function seedSpec(): FitSpec {
  return { ...contractFixture(), id: 'draft-cup-adapter' };
}

export function isUserMeasured(d: Dimension): boolean {
  return d.source === 'manual' && d.sourceId.startsWith(USER_SOURCE_PREFIX);
}

export function isPreviewAdjusted(d: Dimension): boolean {
  return d.source === 'design' && d.sourceId.startsWith(PREVIEW_SOURCE_PREFIX);
}

export function toolForDimension(d: Dimension): MeasuringTool {
  const halfWidth = (d.upperMm - d.lowerMm) / 2;
  return halfWidth <= TOOL_UNCERTAINTY_MM.calipers + 1e-9
    ? 'calipers'
    : 'ruler';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function measurementError(
  valueMm: number,
  tool: MeasuringTool,
): string | null {
  if (!Number.isFinite(valueMm)) {
    return 'Enter a size in millimetres.';
  }
  if (valueMm <= TOOL_UNCERTAINTY_MM[tool]) {
    return 'That is smaller than this tool can measure.';
  }
  if (valueMm > MAX_REASONABLE_MM) {
    return 'That looks too large for a cup holder.';
  }
  return null;
}

function measuredDimension(
  key: MeasuredKey,
  valueMm: number,
  tool: MeasuringTool,
  revision: number,
): Dimension {
  const u = TOOL_UNCERTAINTY_MM[tool];
  return {
    nominalMm: valueMm,
    lowerMm: round3(valueMm - u),
    upperMm: round3(valueMm + u),
    source: 'manual',
    sourceId: `${USER_SOURCE_PREFIX}${tool}-${key}-r${revision}`,
  };
}

const sameInterval = (a: Dimension, b: Dimension) =>
  a.nominalMm === b.nominalMm &&
  a.lowerMm === b.lowerMm &&
  a.upperMm === b.upperMm &&
  a.source === b.source;

export interface MeasurementPlan {
  patch: FitSpecPatch;
  touchesHolderInsert: boolean;
  /** True when applying the patch will discard recorded fit evidence. */
  clearsFitEvidence: boolean;
}

/**
 * Builds an expected-revision patch from the user's entries. Re-confirming an
 * unchanged user measurement keeps its source record, so it stays a no-op.
 * The patch carries holder-insert authorization only because it is applied in
 * response to the user confirming these measurements.
 */
export function planMeasurements(
  base: FitSpec,
  entries: Record<MeasuredKey, number>,
  tool: MeasuringTool,
): MeasurementPlan {
  const dimensions: FitSpecPatch['dimensions'] = {};
  const changed = new Set<DimensionKey>();
  for (const key of MEASURED_KEYS) {
    const current = base.dimensions[key];
    const next = measuredDimension(key, entries[key], tool, base.revision + 1);
    if (isUserMeasured(current) && sameInterval(current, next)) {
      dimensions[key] = current;
    } else {
      dimensions[key] = next;
      changed.add(key);
    }
  }
  const touchesHolderInsert = HOLDER_INSERT_KEYS.some(k => changed.has(k));
  return {
    patch: {
      expectedRevision: base.revision,
      dimensions,
      ...(touchesHolderInsert
        ? { authorizedInterfaceIds: ['holder-insert' as const] }
        : {}),
    },
    touchesHolderInsert,
    clearsFitEvidence:
      touchesHolderInsert &&
      base.interfaces['holder-insert'].fitEvidence.length > 0,
  };
}

export function applyPlan(base: FitSpec, plan: MeasurementPlan): FitSpec {
  return applyFitSpecPatch(base, plan.patch);
}

export function canAdjustCupWidth(spec: FitSpec, deltaMm: number): boolean {
  const d = spec.dimensions.cupOuterDiameter;
  return d.lowerMm + deltaMm > 0 && d.upperMm + deltaMm <= MAX_REASONABLE_MM;
}

/**
 * Design edit from the preview. Cup width is outside the holder-insert
 * interface, so no authorization is sent and fit evidence is preserved.
 */
export function adjustCupWidth(spec: FitSpec, deltaMm: number): FitSpec {
  const d = spec.dimensions.cupOuterDiameter;
  return applyFitSpecPatch(spec, {
    expectedRevision: spec.revision,
    dimensions: {
      cupOuterDiameter: {
        nominalMm: round3(d.nominalMm + deltaMm),
        lowerMm: round3(d.lowerMm + deltaMm),
        upperMm: round3(d.upperMm + deltaMm),
        source: 'design',
        sourceId: `${PREVIEW_SOURCE_PREFIX}cup-width-r${spec.revision + 1}`,
      },
    },
  });
}
