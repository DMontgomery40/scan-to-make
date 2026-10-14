import type { CaptureSample } from '../src/capture/captureSource';
import {
  buildReport,
  D004_THRESHOLDS,
  fpsWindows,
  normalizeThermal,
  type AnchorObservation,
  type RuntimeCheck,
} from '../src/spike/d004';

const HERMES_OK: RuntimeCheck = {
  engine: 'hermes',
  probes: [{ name: 'p', passed: true, detail: 'ok' }],
};
const ANCHOR_OK: AnchorObservation = { observerConfirmed: true, maxDriftMm: 2 };

function run(
  seconds: number,
  sample: (second: number) => Partial<CaptureSample> = () => ({}),
): CaptureSample[] {
  return Array.from({ length: seconds }, (_, i) => ({
    tMs: (i + 1) * 1000,
    intervalMs: 1000,
    frames: 60,
    thermal: 'nominal',
    tracking: 'normal',
    ...sample(i + 1),
  }));
}

function score(
  samples: CaptureSample[],
  overrides: Partial<Parameters<typeof buildReport>[0]> = {},
) {
  return buildReport({
    source: 'native',
    samples,
    runtime: HERMES_OK,
    anchor: ANCHOR_OK,
    session: null,
    errors: [],
    createdAt: new Date(0),
    ...overrides,
  });
}

const verdicts = (r: ReturnType<typeof score>) =>
  Object.fromEntries(r.criteria.map(c => [c.id, c.verdict]));

describe('normalizeThermal', () => {
  it.each([
    ['nominal', 'nominal'],
    ['fair', 'fair'],
    ['serious', 'serious'],
    ['critical', 'critical'],
    ['none', 'nominal'],
    ['light', 'fair'],
    ['moderate', 'serious'],
    ['severe', 'critical'],
    ['shutdown', 'critical'],
    ['unavailable', 'unknown'],
  ])('%s -> %s', (raw, level) => {
    expect(normalizeThermal(raw)).toBe(level);
  });
});

describe('D004 scoring', () => {
  it('passes a full 60 fps nominal run on Hermes with a confirmed anchor', () => {
    const report = score(run(126));
    expect(verdicts(report)).toEqual({
      fps: 'pass',
      thermal: 'pass',
      anchor: 'pass',
      hermes: 'pass',
    });
    expect(report.verdict).toBe('pass');
    expect(report.summary.meanFps).toBe(60);
    expect(report.summary.scoredSeconds).toBe(121);
  });

  it('excludes warm-up from fps scoring', () => {
    const report = score(
      run(126, s => ({ frames: s <= D004_THRESHOLDS.warmupSeconds ? 0 : 60 })),
    );
    expect(verdicts(report).fps).toBe('pass');
  });

  it('tolerates frame-count quantisation at exactly 30 fps', () => {
    // A 30 fps camera sampled on a 1 s timer reads 29, 30 or 31 frames.
    const report = score(run(126, s => ({ frames: [29, 30, 31, 30][s % 4] })));
    expect(verdicts(report).fps).toBe('pass');
  });

  it('fails when any 5 s window drops below 30 fps', () => {
    const report = score(
      run(126, s => ({ frames: s > 60 && s <= 65 ? 20 : 60 })),
    );
    expect(verdicts(report).fps).toBe('fail');
    expect(report.verdict).toBe('fail');
    const lowest = Math.min(...fpsWindows(report.samples).map(w => w.fps));
    expect(lowest).toBe(20);
  });

  it('fails fps even on a short run once a window has dropped', () => {
    const report = score(run(30, () => ({ frames: 10 })));
    expect(verdicts(report).fps).toBe('fail');
  });

  it('is inconclusive for a short run that was otherwise fine', () => {
    const report = score(run(60));
    expect(verdicts(report)).toMatchObject({
      fps: 'inconclusive',
      thermal: 'inconclusive',
    });
    expect(report.verdict).toBe('inconclusive');
  });

  it('fails thermal on iOS serious', () => {
    const report = score(
      run(126, s => ({ thermal: s >= 90 ? 'serious' : 'fair' })),
    );
    const thermal = report.criteria.find(c => c.id === 'thermal')!;
    expect(thermal.verdict).toBe('fail');
    expect(thermal.detail).toContain('90 s');
  });

  it('fails thermal on Android moderate, passes on Android light', () => {
    expect(
      verdicts(score(run(126, () => ({ thermal: 'moderate' })))).thermal,
    ).toBe('fail');
    expect(
      verdicts(score(run(126, () => ({ thermal: 'light' })))).thermal,
    ).toBe('pass');
  });

  it('is inconclusive when thermal state is unavailable', () => {
    expect(
      verdicts(score(run(126, () => ({ thermal: 'unavailable' })))).thermal,
    ).toBe('inconclusive');
  });

  it('never passes mock samples', () => {
    const report = score(run(126), { source: 'mock' });
    expect(verdicts(report)).toMatchObject({
      fps: 'inconclusive',
      thermal: 'inconclusive',
    });
    expect(report.verdict).toBe('inconclusive');
  });

  it('scores anchoring from the observer and drift', () => {
    expect(verdicts(score(run(126), { anchor: null })).anchor).toBe(
      'inconclusive',
    );
    expect(
      verdicts(
        score(run(126), {
          anchor: { observerConfirmed: false, maxDriftMm: null },
        }),
      ).anchor,
    ).toBe('fail');
    expect(
      verdicts(
        score(run(126), { anchor: { observerConfirmed: true, maxDriftMm: 9 } }),
      ).anchor,
    ).toBe('fail');
    expect(
      verdicts(
        score(run(126), {
          anchor: { observerConfirmed: true, maxDriftMm: null },
        }),
      ).anchor,
    ).toBe('pass');
  });

  it('requires Hermes for the runtime criterion', () => {
    expect(
      verdicts(score(run(126), { runtime: { ...HERMES_OK, engine: 'node' } }))
        .hermes,
    ).toBe('inconclusive');
    expect(
      verdicts(
        score(run(126), {
          runtime: {
            engine: 'hermes',
            probes: [{ name: 'x', passed: false, detail: 'boom' }],
          },
        }),
      ).hermes,
    ).toBe('fail');
    expect(
      verdicts(score(run(126), { runtime: { engine: 'hermes', probes: [] } }))
        .hermes,
    ).toBe('inconclusive');
  });

  it('downgrades an otherwise passing run that reported native errors', () => {
    expect(score(run(126), { errors: ['Camera not available'] }).verdict).toBe(
      'inconclusive',
    );
  });

  it('records thresholds and raw samples for re-scoring', () => {
    const report = score(run(126));
    expect(report.schema).toBe('scan-to-make.d004-spike-report.v0');
    expect(report.thresholds).toEqual(D004_THRESHOLDS);
    expect(report.samples).toHaveLength(126);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
