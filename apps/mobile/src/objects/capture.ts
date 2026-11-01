import {
  objectCaptureNative,
  type NativeCaptureDraft,
  type ObjectCaptureNative,
} from '../capture/nativeObjectCapture';

/**
 * The LiDAR capture for one object. The capture keeps the object's id as its
 * origin, so a scan that finished but wasn't sent (the app was closed) is
 * found again and sent.
 */
export interface ObjectCapture {
  /** True when this device can scan (LiDAR). */
  available(): Promise<boolean>;
  /** Opens the capture; resolves when it closes, with the run if a model was made. */
  scan(objectId: string): Promise<string | null>;
  /** A finished run for this object that may not have been sent yet. */
  finished(objectId: string): Promise<string | null>;
}

export function objectCapture(
  native: ObjectCaptureNative | null = objectCaptureNative(),
): ObjectCapture {
  const ready = (draft: NativeCaptureDraft | null | undefined) =>
    draft?.status === 'ready' ? draft.runID : null;
  return {
    async available() {
      if (!native) return false;
      const status = await native.status().catch(() => null);
      return !!status?.supported && status.lidar !== false;
    },
    async scan(objectId) {
      if (!native) return null;
      return ready(
        await native.start({
          projectId: objectId,
          revision: 0,
          snapshot: '{}',
          context: null,
        }),
      );
    },
    async finished(objectId) {
      if (!native) return null;
      const drafts = await native.drafts().catch(() => []);
      return ready(drafts.find(draft => draft.origin.projectId === objectId));
    },
  };
}
