import { NativeModules } from 'react-native';

/**
 * The phone's pinned connection to the paired Mac for objects. Files go
 * straight from the capture folder or the photo picker to the Mac, so no file
 * paths reach JavaScript.
 */
export interface ObjectsNative {
  call(options: {
    method: 'GET' | 'POST';
    path: string;
    json?: unknown;
  }): Promise<{ status: number; body: string }>;
  /** Sends a finished capture's model and up to `maxPhotos` of its photos. */
  sendCapture(options: {
    objectId: string;
    runID: string;
    maxPhotos: number;
  }): Promise<{ scanSent: boolean; photosSent: number }>;
  /** The system photo picker; chosen photos go straight to the object. */
  pickPhotos(options: {
    objectId: string;
    limit: number;
  }): Promise<{ photosSent: number }>;
  /** The camera, for one close-up. */
  takePhoto(options: { objectId: string }): Promise<{ photosSent: number }>;
  /** Downloads `model.stl` or `renders/<name>.png` into the cache. */
  download(options: {
    objectId: string;
    name: string;
    version: number;
  }): Promise<{ uri: string }>;
  /** The current model, turnable in 3D. */
  showModel(options: { objectId: string; version: number }): Promise<void>;
}

export function objectsNative(): ObjectsNative | null {
  return NativeModules.ObjectsBridge ?? null;
}
