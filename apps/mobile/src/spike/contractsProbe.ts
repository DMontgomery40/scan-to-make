import {
  applyFitSpecPatch,
  validateArtifactRef,
  validateFitSpec,
  type FitSpec,
} from '@scan-to-make/contracts';
import taperedHolder from '../../../../packages/contracts/fixtures/tapered-holder.json';
import { HOLDER_INSERT_KEYS, planMeasurements } from '../fit/fitDraft';

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function withSyntheticEvidence(spec: FitSpec): FitSpec {
  const dimensions = Object.fromEntries(
    HOLDER_INSERT_KEYS.map(k => [k, { ...spec.dimensions[k] }]),
  );
  return validateFitSpec({
    ...spec,
    interfaces: {
      'holder-insert': {
        fitEvidence: [
          {
            id: 'probe-fit-report',
            assessedRevision: spec.revision,
            observedAt: '2026-10-14T06:00:00Z',
            observerSourceId: 'synthetic-probe',
            outcome: 'reported-fit',
            dimensions,
            scope: {
              printerId: 'probe-printer',
              printerModel: 'P1S',
              nozzleDiameterMm: 0.4,
              material: 'PLA',
              orientation: [0, 0, 1],
              slicerSettingsSha256: 'a'.repeat(64),
            },
            couponArtifact: {
              sha256: 'b'.repeat(64),
              mediaType: 'model/stl',
              byteLength: 1024,
            },
          },
        ],
      },
    },
  });
}

/**
 * Consumer check of packages/contracts on the current JS engine, using the
 * supplied tapered-holder fixture. Returns the failed checks, or [] on success.
 */
export function contractsConsumerFailures(): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: () => boolean) => {
    try {
      if (!ok()) {
        failures.push(name);
      }
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  };

  const fixture = validateFitSpec(taperedHolder);
  const withEvidence = withSyntheticEvidence(fixture);
  const cup = fixture.dimensions.cupOuterDiameter;
  const widen = {
    expectedRevision: 0,
    dimensions: {
      cupOuterDiameter: { ...cup, nominalMm: 90, lowerMm: 89.8, upperMm: 90.2 },
    },
  };

  check(
    'fixture round-trips unchanged',
    () => stableJson(fixture) === stableJson(taperedHolder),
  );
  check(
    'fixture with scoped evidence validates',
    () => withEvidence.interfaces['holder-insert'].fitEvidence.length === 1,
  );
  check('top widening bumps revision once and keeps evidence', () => {
    const after = applyFitSpecPatch(withEvidence, widen);
    return (
      after.revision === 1 &&
      after.dimensions.cupOuterDiameter.nominalMm === 90 &&
      stableJson(after.interfaces) === stableJson(withEvidence.interfaces) &&
      withEvidence.dimensions.cupOuterDiameter.nominalMm === 86
    );
  });
  check(
    'no-op patch keeps the revision',
    () =>
      applyFitSpecPatch(fixture, {
        expectedRevision: 0,
        dimensions: { cupOuterDiameter: cup },
      }).revision === 0,
  );
  check('stale revision rejects', () =>
    throws(() => applyFitSpecPatch(fixture, { ...widen, expectedRevision: 1 })),
  );
  const deeper = {
    expectedRevision: 0,
    dimensions: {
      insertionDepth: {
        ...fixture.dimensions.insertionDepth,
        nominalMm: 30,
        lowerMm: 29.8,
        upperMm: 30.2,
      },
    },
  };
  check('unauthorized insert change rejects', () =>
    throws(() => applyFitSpecPatch(withEvidence, deeper)),
  );
  check('authorized insert change clears evidence', () => {
    const after = applyFitSpecPatch(withEvidence, {
      ...deeper,
      authorizedInterfaceIds: ['holder-insert'],
    });
    return (
      after.interfaces['holder-insert'].fitEvidence.length === 0 &&
      after.revision === 1
    );
  });
  check('invalid interval rejects', () =>
    throws(() =>
      validateFitSpec({
        ...taperedHolder,
        dimensions: {
          ...taperedHolder.dimensions,
          holderInnerTopDiameter: { ...cup, lowerMm: 99 },
        },
      }),
    ),
  );
  check('artifact ref is frozen and URL-free', () => {
    const ref = validateArtifactRef({
      sha256: 'c'.repeat(64),
      mediaType: 'model/stl',
      byteLength: 42,
    });
    return (
      Object.isFrozen(ref) &&
      throws(() => validateArtifactRef({ ...ref, url: 'mutable.stl' }))
    );
  });
  check('app measurement plan applies to the fixture', () => {
    const plan = planMeasurements(
      withEvidence,
      {
        holderInnerTopDiameter: 62.5,
        holderInnerBottomDiameter: 58,
        insertionDepth: 35,
        cupOuterDiameter: 86,
      },
      'calipers',
    );
    const after = applyFitSpecPatch(withEvidence, plan.patch);
    return (
      plan.clearsFitEvidence &&
      after.revision === 1 &&
      after.interfaces['holder-insert'].fitEvidence.length === 0 &&
      after.dimensions.holderInnerTopDiameter.lowerMm === 62.4
    );
  });
  return failures;
}
