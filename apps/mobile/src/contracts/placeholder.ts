/**
 * PLACEHOLDER: replace with `packages/contracts` when CORE-001 (owned by
 * Codex) publishes FitSpec, dimensional provenance/uncertainty and artifact
 * refs. Exists only so the UI-001 capture and preview stubs have something to
 * render. Do not extend it or depend on it outside apps/mobile.
 */

export type PlaceholderDimensionSource = 'captured' | 'user-confirmed';

export interface PlaceholderDimension {
  valueMm: number;
  /** Plus/minus, in millimetres. */
  uncertaintyMm: number;
  source: PlaceholderDimensionSource;
}

export interface PlaceholderCupHolderFitSpec {
  kind: 'cup-holder-adapter';
  holderOpening: PlaceholderDimension;
  holderDepth: PlaceholderDimension;
  cupBase: PlaceholderDimension;
}

export type PlaceholderDimensionKey =
  | 'holderOpening'
  | 'holderDepth'
  | 'cupBase';

export const PLACEHOLDER_DIMENSION_KEYS: readonly PlaceholderDimensionKey[] = [
  'holderOpening',
  'holderDepth',
  'cupBase',
];

export function userConfirmed(valueMm: number): PlaceholderDimension {
  return { valueMm, uncertaintyMm: 0.5, source: 'user-confirmed' };
}

export function validatePlaceholderFitSpec(
  spec: PlaceholderCupHolderFitSpec,
): Partial<Record<PlaceholderDimensionKey, string>> {
  const errors: Partial<Record<PlaceholderDimensionKey, string>> = {};
  for (const key of PLACEHOLDER_DIMENSION_KEYS) {
    const { valueMm } = spec[key];
    if (!Number.isFinite(valueMm) || valueMm <= 0) {
      errors[key] = 'Enter a size in millimetres.';
    } else if (valueMm > 300) {
      errors[key] = 'That looks too large for a cup holder.';
    }
  }
  return errors;
}
