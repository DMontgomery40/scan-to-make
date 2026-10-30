import { NativeModules } from 'react-native';
import {
  CaptureClient,
  type CaptureDestination,
  type CaptureFile,
} from './retainedCaptures';

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
export interface ObjectCaptureNative {
  status(): Promise<{ supported: boolean; activeRunID: string | null }>;
  drafts(): Promise<NativeCaptureDraft[]>;
  start(origin: CaptureDestination): Promise<NativeCaptureDraft>;
  stop(): Promise<void>;
}
export function objectCaptureNative(): ObjectCaptureNative | null {
  return NativeModules.NativeCaptureCoordinator ?? null;
}
export class NativeObjectCaptureClient {
  constructor(
    readonly captures: CaptureClient,
    readonly native: ObjectCaptureNative,
  ) {}
  async start(id: string) {
    return this.native.start(await this.captures.destination(id, true));
  }
  async drafts(id: string) {
    return (await this.native.drafts()).filter(
      draft => draft.origin.projectId === id,
    );
  }
  async add(
    id: string,
    draft: NativeCaptureDraft,
    selectedDestination?: CaptureDestination,
  ) {
    if (draft.status !== 'ready' || !draft.file)
      throw Error(
        'This scan has no completed model. Its original files are kept on this device.',
      );
    if (draft.origin.projectId !== id)
      throw Error('This scan belongs to another project.');
    if (draft.file.byteLength < 1 || draft.file.byteLength > 32 * 1024 * 1024) {
      throw Error(
        'This scan is larger than the 32 MB import limit. The original model is kept on this device.',
      );
    }
    const adopt = this.captures.native.adoptNativeOutput;
    if (!adopt)
      throw Error('Native scan import is unavailable in this app version.');
    const file = await adopt(draft.runID);
    if (
      file.sha256 !== draft.file.sha256 ||
      file.byteLength !== draft.file.byteLength ||
      file.mediaType !== draft.file.mediaType
    ) {
      throw Error(
        'The local scan identity changed. Its files are kept on this device.',
      );
    }
    const capture = await this.captures.import(
      id,
      file,
      selectedDestination ?? draft.origin,
    );
    await this.captures.reopen(id, capture);
    return capture;
  }
}
