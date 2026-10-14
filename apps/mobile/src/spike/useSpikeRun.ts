import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type {
  CaptureSample,
  CaptureSessionInfo,
  CaptureSource,
} from '../capture/captureSource';
import {
  buildReport,
  D004_THRESHOLDS,
  type SpikeReport,
  type AnchorObservation,
} from './d004';
import { runCoreProbes } from './runtimeProbes';

export const SAMPLE_INTERVAL_MS = 1000;

/** Warm-up plus the scored run, plus one sample of slack. */
export const RUN_TARGET_MS =
  (D004_THRESHOLDS.warmupSeconds + D004_THRESHOLDS.minRunSeconds + 1) * 1000;

export type SpikePhase = 'idle' | 'starting' | 'running' | 'done';

export interface SpikeRunState {
  phase: SpikePhase;
  latest: CaptureSample | null;
  session: CaptureSessionInfo | null;
  report: SpikeReport | null;
  errors: string[];
}

const INITIAL: SpikeRunState = {
  phase: 'idle',
  latest: null,
  session: null,
  report: null,
  errors: [],
};

export function useSpikeRun(source: CaptureSource) {
  const [state, setState] = useState<SpikeRunState>(INITIAL);
  const samples = useRef<CaptureSample[]>([]);
  const errors = useRef<string[]>([]);
  const session = useRef<CaptureSessionInfo | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const active = useRef(false);

  const finish = useCallback(async () => {
    if (!active.current) {
      return;
    }
    active.current = false;
    unsubscribe.current?.();
    unsubscribe.current = null;
    try {
      await source.stop();
    } catch (error) {
      errors.current.push(`stop: ${String(error)}`);
    }
    const report = buildReport({
      source: source.kind,
      samples: samples.current,
      runtime: runCoreProbes(),
      anchor: null,
      session: session.current,
      errors: errors.current,
      createdAt: new Date(),
    });
    setState(s => ({
      ...s,
      phase: 'done',
      report,
      errors: [...errors.current],
    }));
  }, [source]);

  const start = useCallback(async () => {
    if (active.current) {
      return;
    }
    active.current = true;
    samples.current = [];
    errors.current = [];
    session.current = null;
    setState({ ...INITIAL, phase: 'starting' });

    unsubscribe.current = source.subscribe({
      onSample(sample) {
        if (
          !active.current ||
          (session.current?.runId && sample.runId !== session.current.runId)
        ) {
          return;
        }
        samples.current.push(sample);
        setState(s => ({ ...s, latest: sample }));
        if (sample.tMs >= RUN_TARGET_MS) {
          finish();
        }
      },
      onError(message) {
        if (!active.current) {
          return;
        }
        errors.current.push(message);
        setState(s => ({ ...s, errors: [...errors.current] }));
        finish();
      },
    });

    try {
      session.current = await source.start(SAMPLE_INTERVAL_MS);
      if (active.current) {
        setState(s => ({ ...s, phase: 'running', session: session.current }));
      } else {
        await source.stop();
      }
    } catch (error) {
      errors.current.push(
        `start: ${error instanceof Error ? error.message : String(error)}`,
      );
      await finish();
    }
  }, [finish, source]);

  // A backgrounded app loses the camera; stop and score what was captured.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active' && active.current) {
        errors.current.push('App left the foreground during the run.');
        finish();
      }
    });
    return () => sub.remove();
  }, [finish]);

  useEffect(
    () => () => {
      if (active.current) {
        active.current = false;
        unsubscribe.current?.();
        source.stop().catch(() => {});
      }
    },
    [source],
  );

  const observe = useCallback((anchor: AnchorObservation) => {
    setState(current => {
      if (current.phase !== 'done' || !current.report) {
        return current;
      }
      const report = current.report;
      return {
        ...current,
        report: buildReport({
          ...report,
          anchor,
          createdAt: new Date(report.createdAt),
        }),
      };
    });
  }, []);
  return { state, start, stop: finish, observe };
}
