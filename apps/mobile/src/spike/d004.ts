import type {
  CaptureSample,
  CaptureSessionInfo,
} from '../capture/captureSource';

/**
 * D004 pass criteria (accepted in #decisions): AR capture holds >= 30 fps over
 * a 2-minute scan without thermal throttling; the AR preview stays anchored to
 * the captured interface; the TypeScript core runs unchanged on Hermes.
 *
 * The numeric interpretation below is UI-001's proposal. It is recorded in
 * every report so the team can re-score raw samples if it changes.
 */
export const D004_THRESHOLDS = {
  minRunSeconds: 120,
  /** Excluded from scoring while ARKit/ARCore initialise. */
  warmupSeconds: 5,
  minFps: 30,
  /** Absorbs +/-1 frame quantisation per window and camera clock drift. */
  fpsToleranceFps: 0.5,
  /** Native samples (1 s) are pooled into windows of this length. */
  windowSeconds: 5,
  /** Highest normalised thermal level that does not count as throttling. */
  maxThermal: 'fair' as KnownThermalLevel,
  maxAnchorDriftMm: 5,
};

export type D004Thresholds = typeof D004_THRESHOLDS;

export type Verdict = 'pass' | 'fail' | 'inconclusive';

export type CriterionId = 'fps' | 'thermal' | 'anchor' | 'hermes';

export interface CriterionResult {
  id: CriterionId;
  label: string;
  verdict: Verdict;
  detail: string;
}

export type KnownThermalLevel = 'nominal' | 'fair' | 'serious' | 'critical';
export type ThermalLevel = KnownThermalLevel | 'unknown';

const THERMAL_RANK: Record<KnownThermalLevel, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
};

/**
 * iOS reports ProcessInfo.ThermalState names directly. Android
 * PowerManager.THERMAL_STATUS_* maps onto the same scale; MODERATE and above
 * are documented as active throttling, so they count as serious or worse.
 */
export function normalizeThermal(raw: string): ThermalLevel {
  switch (raw) {
    case 'nominal':
    case 'none':
      return 'nominal';
    case 'fair':
    case 'light':
      return 'fair';
    case 'serious':
    case 'moderate':
      return 'serious';
    case 'critical':
    case 'severe':
    case 'emergency':
    case 'shutdown':
      return 'critical';
    default:
      return 'unknown';
  }
}

export function isTrackingNormal(raw: string): boolean {
  return raw === 'normal' || raw === 'TRACKING';
}

export interface FpsWindow {
  startS: number;
  durationS: number;
  frames: number;
  fps: number;
  held: boolean;
}

export function scoredSamples(
  samples: readonly CaptureSample[],
  thresholds: D004Thresholds = D004_THRESHOLDS,
): CaptureSample[] {
  const warmupMs = thresholds.warmupSeconds * 1000;
  return samples.filter(s => s.tMs - s.intervalMs >= warmupMs - 1);
}

export function fpsWindows(
  samples: readonly CaptureSample[],
  thresholds: D004Thresholds = D004_THRESHOLDS,
): FpsWindow[] {
  const windows: FpsWindow[] = [];
  const floor = thresholds.minFps - thresholds.fpsToleranceFps;
  let startMs = 0;
  let durationMs = 0;
  let frames = 0;
  for (const sample of scoredSamples(samples, thresholds)) {
    if (durationMs === 0) {
      startMs = sample.tMs - sample.intervalMs;
    }
    durationMs += sample.intervalMs;
    frames += sample.frames;
    if (durationMs >= thresholds.windowSeconds * 1000 - 1) {
      const fps = frames / (durationMs / 1000);
      windows.push({
        startS: startMs / 1000,
        durationS: durationMs / 1000,
        frames,
        fps,
        held: fps >= floor,
      });
      durationMs = 0;
      frames = 0;
    }
  }
  return windows;
}

export interface RunSummary {
  scoredSeconds: number;
  meanFps: number | null;
  lowestWindowFps: number | null;
  windowsHeld: number;
  windowsTotal: number;
  maxThermal: ThermalLevel | null;
  rawThermalSeen: string[];
  trackingNormalFraction: number | null;
}

export function summarizeRun(
  samples: readonly CaptureSample[],
  thresholds: D004Thresholds = D004_THRESHOLDS,
): RunSummary {
  const scored = scoredSamples(samples, thresholds);
  const windows = fpsWindows(samples, thresholds);
  const scoredMs = scored.reduce((sum, s) => sum + s.intervalMs, 0);
  const frames = scored.reduce((sum, s) => sum + s.frames, 0);

  let maxThermal: ThermalLevel | null = null;
  const rawThermal = new Set<string>();
  for (const sample of samples) {
    rawThermal.add(sample.thermal);
    const level = normalizeThermal(sample.thermal);
    if (maxThermal === null || worseThermal(level, maxThermal)) {
      maxThermal = level;
    }
  }

  return {
    scoredSeconds: scoredMs / 1000,
    meanFps: scoredMs > 0 ? frames / (scoredMs / 1000) : null,
    lowestWindowFps: windows.length
      ? Math.min(...windows.map(w => w.fps))
      : null,
    windowsHeld: windows.filter(w => w.held).length,
    windowsTotal: windows.length,
    maxThermal,
    rawThermalSeen: [...rawThermal],
    trackingNormalFraction: scored.length
      ? scored.filter(s => isTrackingNormal(s.tracking)).length / scored.length
      : null,
  };
}

/** `unknown` ranks above every known level so it is never hidden by one. */
function worseThermal(a: ThermalLevel, b: ThermalLevel): boolean {
  if (a === 'unknown') {
    return b !== 'unknown';
  }
  if (b === 'unknown') {
    return false;
  }
  return THERMAL_RANK[a] > THERMAL_RANK[b];
}

export interface AnchorObservation {
  /** Observer's on-device judgment that the preview stayed on the interface. */
  observerConfirmed: boolean | null;
  maxDriftMm: number | null;
}

export type JsEngine = 'hermes' | 'node' | 'unknown';

export interface ProbeResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RuntimeCheck {
  engine: JsEngine;
  probes: ProbeResult[];
}

export interface ScoreInput {
  source: 'native' | 'mock';
  samples: readonly CaptureSample[];
  runtime: RuntimeCheck;
  anchor: AnchorObservation | null;
  thresholds?: D004Thresholds;
}

const fmt = (n: number, digits = 1) => n.toFixed(digits);

export function scoreFps(
  input: ScoreInput,
  summary: RunSummary,
): CriterionResult {
  const t = input.thresholds ?? D004_THRESHOLDS;
  const base = {
    id: 'fps' as const,
    label: `AR capture holds ${t.minFps} fps for ${t.minRunSeconds / 60} min`,
  };
  if (input.source === 'mock') {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: 'Mock samples. Run on a device with the native module.',
    };
  }
  if (
    summary.windowsTotal === 0 ||
    summary.meanFps === null ||
    summary.lowestWindowFps === null
  ) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: 'No frames were scored after warm-up.',
    };
  }
  const measured = `mean ${fmt(summary.meanFps)} fps, lowest ${
    t.windowSeconds
  }-s window ${fmt(summary.lowestWindowFps)} fps over ${fmt(
    summary.scoredSeconds,
    0,
  )} s`;
  if (summary.windowsHeld < summary.windowsTotal) {
    const dropped = summary.windowsTotal - summary.windowsHeld;
    return {
      ...base,
      verdict: 'fail',
      detail: `${dropped} of ${summary.windowsTotal} windows fell below ${t.minFps} fps; ${measured}.`,
    };
  }
  if (summary.scoredSeconds < t.minRunSeconds) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: `Run too short to score (${measured}).`,
    };
  }
  return { ...base, verdict: 'pass', detail: `${measured}.` };
}

export function scoreThermal(
  input: ScoreInput,
  summary: RunSummary,
): CriterionResult {
  const t = input.thresholds ?? D004_THRESHOLDS;
  const base = {
    id: 'thermal' as const,
    label: 'No thermal throttling during the run',
  };
  if (input.source === 'mock') {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: 'Mock samples. Run on a device with the native module.',
    };
  }
  const limit = THERMAL_RANK[t.maxThermal];
  let knownCount = 0;
  const firstHot = input.samples.find(s => {
    const level = normalizeThermal(s.thermal);
    if (level === 'unknown') {
      return false;
    }
    knownCount += 1;
    return THERMAL_RANK[level] > limit;
  });
  if (firstHot) {
    return {
      ...base,
      verdict: 'fail',
      detail: `Reached "${firstHot.thermal}" at ${fmt(
        firstHot.tMs / 1000,
        0,
      )} s (limit: ${t.maxThermal}).`,
    };
  }
  if (knownCount === 0 || knownCount < input.samples.length) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: `Thermal state unavailable for some samples (${
        summary.rawThermalSeen.join(', ') || 'none'
      }).`,
    };
  }
  if (summary.scoredSeconds < t.minRunSeconds) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: `Run too short to score (max ${summary.maxThermal}).`,
    };
  }
  return {
    ...base,
    verdict: 'pass',
    detail: `Max thermal state: ${summary.maxThermal}.`,
  };
}

export function scoreAnchor(input: ScoreInput): CriterionResult {
  const t = input.thresholds ?? D004_THRESHOLDS;
  const base = {
    id: 'anchor' as const,
    label: 'AR preview stays anchored to the captured interface',
  };
  const anchor = input.anchor;
  if (!anchor || anchor.observerConfirmed === null) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail:
        'Needs the native AR preview view and an on-device observer check.',
    };
  }
  if (anchor.maxDriftMm !== null && anchor.maxDriftMm > t.maxAnchorDriftMm) {
    return {
      ...base,
      verdict: 'fail',
      detail: `Drift ${fmt(anchor.maxDriftMm)} mm exceeds ${
        t.maxAnchorDriftMm
      } mm.`,
    };
  }
  if (!anchor.observerConfirmed) {
    return {
      ...base,
      verdict: 'fail',
      detail: 'Observer saw the preview drift off the interface.',
    };
  }
  const drift =
    anchor.maxDriftMm === null
      ? 'drift not measured'
      : `max drift ${fmt(anchor.maxDriftMm)} mm`;
  return { ...base, verdict: 'pass', detail: `Observer confirmed; ${drift}.` };
}

export function scoreHermes(input: ScoreInput): CriterionResult {
  const base = {
    id: 'hermes' as const,
    label: 'TypeScript core runs unchanged on Hermes',
  };
  const { engine, probes } = input.runtime;
  const failed = probes.filter(p => !p.passed);
  if (failed.length > 0) {
    return {
      ...base,
      verdict: 'fail',
      detail: `Failed on ${engine}: ${failed
        .map(p => `${p.name} (${p.detail})`)
        .join('; ')}.`,
    };
  }
  if (engine !== 'hermes') {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: `Probes ran on ${engine}, not Hermes.`,
    };
  }
  if (probes.length === 0) {
    return {
      ...base,
      verdict: 'inconclusive',
      detail: 'No core probes registered.',
    };
  }
  return {
    ...base,
    verdict: 'pass',
    detail: `${probes.length} core probes passed on Hermes.`,
  };
}

export function overallVerdict(criteria: readonly CriterionResult[]): Verdict {
  if (criteria.some(c => c.verdict === 'fail')) {
    return 'fail';
  }
  return criteria.every(c => c.verdict === 'pass') ? 'pass' : 'inconclusive';
}

export const REPORT_SCHEMA = 'scan-to-make.d004-spike-report.v0';

export interface SpikeReport {
  schema: typeof REPORT_SCHEMA;
  createdAt: string;
  source: 'native' | 'mock';
  session: CaptureSessionInfo | null;
  thresholds: D004Thresholds;
  summary: RunSummary;
  runtime: RuntimeCheck;
  anchor: AnchorObservation | null;
  errors: string[];
  criteria: CriterionResult[];
  verdict: Verdict;
  /** Raw 1-s native samples, so the run can be re-scored later. */
  samples: CaptureSample[];
}

export function buildReport(
  input: ScoreInput & {
    session: CaptureSessionInfo | null;
    errors: readonly string[];
    createdAt: Date;
  },
): SpikeReport {
  const thresholds = input.thresholds ?? D004_THRESHOLDS;
  const summary = summarizeRun(input.samples, thresholds);
  const criteria = [
    scoreFps(input, summary),
    scoreThermal(input, summary),
    scoreAnchor(input),
    scoreHermes(input),
  ];
  let verdict = overallVerdict(criteria);
  if (verdict === 'pass' && input.errors.length > 0) {
    verdict = 'inconclusive';
  }
  return {
    schema: REPORT_SCHEMA,
    createdAt: input.createdAt.toISOString(),
    source: input.source,
    session: input.session,
    thresholds,
    summary,
    runtime: input.runtime,
    anchor: input.anchor,
    errors: [...input.errors],
    criteria,
    verdict,
    samples: [...input.samples],
  };
}
