import {
  userConfirmed,
  validatePlaceholderFitSpec,
  type PlaceholderCupHolderFitSpec,
} from '../contracts/placeholder';
import {
  buildReport,
  type JsEngine,
  type ProbeResult,
  type RuntimeCheck,
} from './d004';
import type { CaptureSample } from '../capture/captureSource';

declare const HermesInternal: object | null | undefined;

export function detectEngine(): JsEngine {
  if (typeof HermesInternal === 'object' && HermesInternal !== null) {
    return 'hermes';
  }
  const proc = (globalThis as { process?: { versions?: { node?: string } } })
    .process;
  if (proc?.versions?.node) {
    return 'node';
  }
  return 'unknown';
}

interface Probe {
  name: string;
  run(): string | null;
}

/**
 * Each probe returns null on success or a failure description. Add
 * packages/contracts (CORE-001) and fit geometry (FIT-001) probes here once
 * they publish; the placeholder probe goes away with the placeholder.
 */
export const CORE_PROBES: readonly Probe[] = [
  {
    name: 'placeholder-contract',
    run() {
      const spec: PlaceholderCupHolderFitSpec = {
        kind: 'cup-holder-adapter',
        holderOpening: userConfirmed(82),
        holderDepth: userConfirmed(60),
        cupBase: userConfirmed(66.5),
      };
      const roundTrip = JSON.parse(
        JSON.stringify(spec),
      ) as PlaceholderCupHolderFitSpec;
      if (Object.keys(validatePlaceholderFitSpec(roundTrip)).length > 0) {
        return 'valid spec rejected';
      }
      const bad = { ...roundTrip, cupBase: userConfirmed(Number.NaN) };
      if (!validatePlaceholderFitSpec(bad).cupBase) {
        return 'invalid spec accepted';
      }
      return null;
    },
  },
  {
    name: 'numeric-determinism',
    run() {
      const checks: [string, string][] = [
        [String(0.1 + 0.2), '0.30000000000000004'],
        [String(Math.fround(1.1)), '1.100000023841858'],
        [String(Math.hypot(3, 4)), '5'],
        [(66.5 * Math.PI).toFixed(6), '208.915911'],
        [
          String(new Float64Array([1.5, 2.25]).reduce((a, b) => a + b, 0)),
          '3.75',
        ],
        [String(Math.round(-0.5)), '0'],
      ];
      const mismatch = checks.find(([got, want]) => got !== want);
      return mismatch ? `got ${mismatch[0]}, want ${mismatch[1]}` : null;
    },
  },
  {
    name: 'd004-scoring',
    run() {
      const samples: CaptureSample[] = [];
      for (let i = 1; i <= 130; i += 1) {
        samples.push({
          tMs: i * 1000,
          intervalMs: 1000,
          frames: 60,
          thermal: 'nominal',
          tracking: 'normal',
        });
      }
      const report = buildReport({
        source: 'native',
        samples,
        runtime: { engine: 'hermes', probes: [] },
        anchor: null,
        session: null,
        errors: [],
        createdAt: new Date(0),
      });
      const [fps, thermal] = report.criteria;
      if (fps.verdict !== 'pass' || thermal.verdict !== 'pass') {
        return `fixture scored ${fps.verdict}/${thermal.verdict}`;
      }
      return report.summary.meanFps === 60
        ? null
        : `mean fps ${report.summary.meanFps}`;
    },
  },
];

export function runCoreProbes(
  probes: readonly Probe[] = CORE_PROBES,
): RuntimeCheck {
  const results: ProbeResult[] = probes.map(probe => {
    try {
      const failure = probe.run();
      return {
        name: probe.name,
        passed: failure === null,
        detail: failure ?? 'ok',
      };
    } catch (error) {
      return { name: probe.name, passed: false, detail: String(error) };
    }
  });
  return { engine: detectEngine(), probes: results };
}
