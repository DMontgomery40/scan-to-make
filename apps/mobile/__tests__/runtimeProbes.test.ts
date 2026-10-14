import { detectEngine, runCoreProbes } from '../src/spike/runtimeProbes';
import {
  userConfirmed,
  validatePlaceholderFitSpec,
} from '../src/contracts/placeholder';

describe('core probes', () => {
  it('all pass under Jest, reported as node rather than Hermes', () => {
    const check = runCoreProbes();
    expect(check.engine).toBe('node');
    expect(check.probes.length).toBeGreaterThan(0);
    expect(check.probes.filter(p => !p.passed)).toEqual([]);
  });

  it('reports a throwing probe as failed instead of crashing', () => {
    const check = runCoreProbes([
      {
        name: 'throws',
        run() {
          throw new Error('nope');
        },
      },
    ]);
    expect(check.probes).toEqual([
      { name: 'throws', passed: false, detail: 'Error: nope' },
    ]);
  });

  it('detects Hermes from HermesInternal', () => {
    const g = globalThis as { HermesInternal?: object };
    g.HermesInternal = {};
    try {
      expect(detectEngine()).toBe('hermes');
    } finally {
      delete g.HermesInternal;
    }
  });
});

describe('placeholder contract', () => {
  const spec = (opening: number) => ({
    kind: 'cup-holder-adapter' as const,
    holderOpening: userConfirmed(opening),
    holderDepth: userConfirmed(60),
    cupBase: userConfirmed(66),
  });

  it('accepts plausible sizes', () => {
    expect(validatePlaceholderFitSpec(spec(82))).toEqual({});
  });

  it('rejects missing, non-positive and implausible sizes', () => {
    expect(
      validatePlaceholderFitSpec(spec(Number.NaN)).holderOpening,
    ).toBeDefined();
    expect(validatePlaceholderFitSpec(spec(0)).holderOpening).toBeDefined();
    expect(validatePlaceholderFitSpec(spec(1000)).holderOpening).toBeDefined();
  });
});
