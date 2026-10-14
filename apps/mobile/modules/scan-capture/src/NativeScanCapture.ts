import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * One measurement window from the native AR session. Native emits these on a
 * fixed timer, including windows with zero frames, so stalls stay visible.
 */
export type CaptureSampleEvent = {
  /** Milliseconds since the session started, monotonic clock. */
  tMs: number;
  /** Measured length of this window; fps = frames / (intervalMs / 1000). */
  intervalMs: number;
  /** AR frames delivered to the session delegate during this window. */
  frames: number;
  /** Raw platform thermal state, e.g. iOS "serious" or Android "moderate". */
  thermal: string;
  /** Raw platform tracking state, e.g. iOS "normal" or Android "TRACKING". */
  tracking: string;
};

export type CaptureSessionInfo = {
  /** "arkit" or "arcore". */
  framework: string;
  deviceModel: string;
  osVersion: string;
  /** Whether the session runs the depth / mesh workload a real scan needs. */
  depthEnabled: boolean;
  meshEnabled: boolean;
};

export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;
  startSession(sampleIntervalMs: number): Promise<CaptureSessionInfo>;
  stopSession(): Promise<void>;

  readonly onSample: CodegenTypes.EventEmitter<CaptureSampleEvent>;
  readonly onError: CodegenTypes.EventEmitter<string>;
}

/** Null when the native module is not linked (Jest, web, or a stale build). */
export default TurboModuleRegistry.get<Spec>('ScanCapture');
