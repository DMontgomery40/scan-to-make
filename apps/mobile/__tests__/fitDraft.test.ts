import {
  applyFitSpecPatch,
  validateFitSpec,
  type FitSpec,
} from '@scan-to-make/contracts';
import {
  cupWidthPatch,
  canAdjustCupWidth,
  contractFixture,
  isUserMeasured,
  measurementError,
  planMeasurements,
  seedSpec,
  type MeasuredKey,
} from '../src/fit/fitDraft';

const applyPlan = (
  base: FitSpec,
  plan: { patch: Parameters<typeof applyFitSpecPatch>[1] },
) => applyFitSpecPatch(base, plan.patch);
import { contractsConsumerFailures } from '../src/spike/contractsProbe';

const ENTRIES: Record<MeasuredKey, number> = {
  holderInnerTopDiameter: 62,
  holderInnerBottomDiameter: 58,
  insertionDepth: 35,
  cupOuterDiameter: 86,
};

describe('fit draft over packages/contracts', () => {
  it('seeds from the contract fixture without claiming its measurements', () => {
    const seed = seedSpec();
    expect(seed.revision).toBe(0);
    expect(seed.id).toBe('draft-cup-adapter');
    expect(isUserMeasured(seed.dimensions.holderInnerTopDiameter)).toBe(false);
    expect(validateFitSpec(seed)).toEqual(seed);
  });

  it('first confirmation is one authorized expected-revision patch', () => {
    const seed = seedSpec();
    const plan = planMeasurements(seed, ENTRIES, 'ruler');
    expect(plan.patch.expectedRevision).toBe(0);
    expect(plan.patch.authorizedInterfaceIds).toEqual(['holder-insert']);
    expect(plan.clearsFitEvidence).toBe(false);
    const next = applyPlan(seed, plan);
    expect(next.revision).toBe(1);
    const top = next.dimensions.holderInnerTopDiameter;
    expect(top).toEqual({
      nominalMm: 62,
      lowerMm: 61.5,
      upperMm: 62.5,
      source: 'manual',
      sourceId: 'manual-entry-ruler-holderInnerTopDiameter-r1',
    });
    expect(next.dimensions.wallThickness).toEqual(
      seed.dimensions.wallThickness,
    );
  });

  it('re-confirming unchanged measurements is a no-op', () => {
    const first = applyPlan(
      seedSpec(),
      planMeasurements(seedSpec(), ENTRIES, 'ruler'),
    );
    const plan = planMeasurements(first, ENTRIES, 'ruler');
    expect(plan.touchesHolderInsert).toBe(false);
    expect(plan.patch.authorizedInterfaceIds).toBeUndefined();
    expect(applyPlan(first, plan).revision).toBe(1);
  });

  it('changing only the cup does not request holder-insert authorization', () => {
    const first = applyPlan(
      seedSpec(),
      planMeasurements(seedSpec(), ENTRIES, 'ruler'),
    );
    const plan = planMeasurements(
      first,
      { ...ENTRIES, cupOuterDiameter: 90 },
      'ruler',
    );
    expect(plan.touchesHolderInsert).toBe(false);
    expect(applyPlan(first, plan).revision).toBe(2);
  });

  it('switching tool changes intervals and so touches the holder fit', () => {
    const first = applyPlan(
      seedSpec(),
      planMeasurements(seedSpec(), ENTRIES, 'ruler'),
    );
    const plan = planMeasurements(first, ENTRIES, 'calipers');
    expect(plan.touchesHolderInsert).toBe(true);
    expect(applyPlan(first, plan).dimensions.insertionDepth.lowerMm).toBe(34.9);
  });

  it('cup width edits from the preview are design changes without authorization', () => {
    const first = applyPlan(
      seedSpec(),
      planMeasurements(seedSpec(), ENTRIES, 'ruler'),
    );
    const patch = cupWidthPatch(first, 1);
    expect(patch.expectedRevision).toBe(first.revision);
    expect(patch.authorizedInterfaceIds).toBeUndefined();
    const wider = applyFitSpecPatch(first, patch);
    expect(wider.revision).toBe(2);
    expect(wider.dimensions.cupOuterDiameter).toMatchObject({
      nominalMm: 87,
      lowerMm: 86.5,
      upperMm: 87.5,
      source: 'design',
    });
    expect(wider.dimensions.holderInnerTopDiameter).toEqual(
      first.dimensions.holderInnerTopDiameter,
    );
  });

  it('will not narrow the cup to a non-positive interval', () => {
    const fixture = contractFixture();
    expect(canAdjustCupWidth(fixture, -85.8)).toBe(false);
    expect(canAdjustCupWidth(fixture, -1)).toBe(true);
  });

  it('validates entries against the tool before the contract sees them', () => {
    expect(measurementError(Number.NaN, 'ruler')).not.toBeNull();
    expect(measurementError(0.4, 'ruler')).not.toBeNull();
    expect(measurementError(0.4, 'calipers')).toBeNull();
    expect(measurementError(301, 'calipers')).not.toBeNull();
  });
});

describe('contracts consumer probe', () => {
  it('passes every check on this engine', () => {
    expect(contractsConsumerFailures()).toEqual([]);
  });
});
