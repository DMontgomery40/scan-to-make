import { detectEngine, runCoreProbes } from '../src/spike/runtimeProbes';

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
