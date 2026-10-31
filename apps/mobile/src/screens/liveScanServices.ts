import { NativeModules } from 'react-native';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import { CaptureClient, type CaptureNative } from '../capture/retainedCaptures';
import {
  ScanProcessingClient,
  type ScanProcessingNative,
} from '../processing/scanProcessing';
import {
  DetailStillsClient,
  type DetailStillNative,
} from '../stills/detailStills';
import {
  sessionJobMemory,
  unavailableScanServices,
  type DetailStills,
  type PhotoPicker,
  type ScanProcessing,
  type ScanServices,
} from './scanServices';

type StillsBridge = ScanProcessingNative & DetailStillNative;
const REASONS = ['too-large', 'unsupported', 'unreadable'] as const;

/**
 * The bridge's photo picker. Chosen bytes stay in native storage, identified
 * by hash, where the upload reads them; each photo also has a display URI.
 * Prefers the multi-select camera-roll picker, else one photo at a time.
 */
export function bridgePhotoPicker(bridge: StillsBridge): PhotoPicker {
  return {
    async pick(limit) {
      if (bridge.pickImages) {
        const result = await bridge.pickImages(limit);
        return {
          photos: result.photos,
          rejected: result.rejected.map(r => ({
            reason: REASONS.includes(r.reason) ? r.reason : 'unreadable',
            ...(r.byteLength !== undefined ? { byteLength: r.byteLength } : {}),
          })),
        };
      }
      if (!bridge.pickImage) {
        throw Error('Choosing photos isn’t available on this device.');
      }
      try {
        return { photos: [await bridge.pickImage()], rejected: [] };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code === 'cancelled') return { photos: [], rejected: [] };
        if (code === 'invalid-source') {
          return { photos: [], rejected: [{ reason: 'unreadable' }] };
        }
        throw error;
      }
    },
    // Native storage is content-addressed and shared with uploads.
    discard: async () => {},
  };
}

/**
 * The real companion path: CaptureClient acknowledges the saved project, and
 * the processing and close-up clients share the stills bridge. Without the
 * native modules (Android, tests) the screens say the feature is unavailable.
 */
export function liveScanServices(
  repository: SavedProjects,
  modules: {
    StillsProcessingBridge?: StillsBridge;
    RetainedCaptureBridge?: CaptureNative;
  } = NativeModules,
): ScanServices {
  const bridge = modules.StillsProcessingBridge;
  const captures = modules.RetainedCaptureBridge;
  if (!bridge || !captures) return unavailableScanServices();
  const sync = new CaptureClient(repository, captures);
  const client = new ScanProcessingClient(repository, bridge);
  const processing: ScanProcessing = client;
  const stills: DetailStills = new DetailStillsClient(repository, bridge);
  return {
    async acknowledge(projectId) {
      const state = await sync.sync(projectId);
      if (!state.etag || !state.snapshot) {
        throw Error('The saved project could not be synchronized.');
      }
      return { etag: state.etag, snapshot: state.snapshot };
    },
    processing,
    stills,
    picker: bridgePhotoPicker(bridge),
    // A fast path within a session; after a relaunch, processing.listJobs
    // finds the jobs the companion kept.
    jobs: sessionJobMemory(),
    imageUri: file => client.imageUri(file),
  };
}
