import { NativeModules } from 'react-native';

/** Where a capture belongs; the objects app uses the object's id as `projectId`. */
export type CaptureDestination = {
  projectId: string;
  revision: number;
  snapshot: string;
  context: string | null;
};
export type CaptureFile = {
  sha256: string;
  byteLength: number;
  mediaType: string;
};
export type NativeCaptureDraft = {
  formatVersion: 1;
  runID: string;
  origin: CaptureDestination;
  createdAt: string;
  status:
    | 'capturing'
    | 'stopping'
    | 'interrupted'
    | 'stopped'
    | 'failed'
    | 'ready';
  file?: CaptureFile;
  message?: string;
  addRequested?: boolean;
};
/** The native LiDAR Object Capture module (kept from the first app). */
export interface ObjectCaptureNative {
  status(): Promise<{
    supported: boolean;
    // False when the device has no LiDAR scanner. Missing from older builds.
    lidar?: boolean;
    activeRunID: string | null;
  }>;
  drafts(): Promise<NativeCaptureDraft[]>;
  start(origin: CaptureDestination): Promise<NativeCaptureDraft>;
  stop(): Promise<void>;
}
export function objectCaptureNative(): ObjectCaptureNative | null {
  return NativeModules.NativeCaptureCoordinator ?? null;
}
