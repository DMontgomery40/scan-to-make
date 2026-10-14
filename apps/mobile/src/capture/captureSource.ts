import { PermissionsAndroid, Platform } from 'react-native';
import {
  NativeScanCapture,
  type CaptureSampleEvent,
  type CaptureSessionInfo,
} from '@scan-to-make/scan-capture';

export type CaptureSample = CaptureSampleEvent;
export type { CaptureSessionInfo };

export interface CaptureHandlers {
  onSample(sample: CaptureSample): void;
  onError(message: string): void;
}

export interface CaptureSource {
  readonly kind: 'native' | 'mock';
  isSupported(): Promise<boolean>;
  start(sampleIntervalMs: number): Promise<CaptureSessionInfo>;
  stop(): Promise<void>;
  subscribe(handlers: CaptureHandlers): () => void;
}

/** Null when the native module is not linked into this build. */
export function nativeCaptureSource(): CaptureSource | null {
  const native = NativeScanCapture;
  if (!native) {
    return null;
  }
  return {
    kind: 'native',
    isSupported: () => native.isSupported(),
    async start(sampleIntervalMs) {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          throw new Error('Camera permission was not granted.');
        }
      }
      return native.startSession(sampleIntervalMs);
    },
    stop: () => native.stopSession(),
    subscribe({ onSample, onError }) {
      const samples = native.onSample(onSample);
      const errors = native.onError(onError);
      return () => {
        samples.remove();
        errors.remove();
      };
    },
  };
}

export interface MockCaptureOptions {
  fps?: number;
  thermal?: string;
  /** Emit simulated time faster than real time; 20 turns a 2-minute run into 6 s. */
  timeScale?: number;
}

/**
 * Synthetic samples for simulators, emulators without ARCore, and tests.
 * Reports built from it are always scored inconclusive.
 */
export function mockCaptureSource({
  fps = 60,
  thermal = 'nominal',
  timeScale = 20,
}: MockCaptureOptions = {}): CaptureSource {
  const listeners = new Set<CaptureHandlers>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    kind: 'mock',
    isSupported: async () => true,
    async start(sampleIntervalMs) {
      stopTimer();
      let tMs = 0;
      timer = setInterval(() => {
        tMs += sampleIntervalMs;
        const sample: CaptureSample = {
          tMs,
          intervalMs: sampleIntervalMs,
          frames: Math.round((fps * sampleIntervalMs) / 1000),
          thermal,
          tracking: 'normal',
        };
        listeners.forEach(l => l.onSample(sample));
      }, sampleIntervalMs / timeScale);
      return {
        framework: 'mock',
        deviceModel: 'mock',
        osVersion: `${Platform.OS} ${String(Platform.Version)}`,
        depthEnabled: false,
        meshEnabled: false,
      };
    },
    async stop() {
      stopTimer();
    },
    subscribe(handlers) {
      listeners.add(handlers);
      return () => listeners.delete(handlers);
    },
  };
}
