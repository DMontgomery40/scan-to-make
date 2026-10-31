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
  storedHandoffMemory,
  storedPrinterChoice,
} from '../printing/printerHandoff';
import {
  companionPrinterHandoff,
  type PrinterHandoffNative,
} from '../printing/companionPrinterHandoff';
import {
  SCAN_ADVICE_NAMES,
  type ScanArtifactName,
  type ScanProcessingJob,
} from '@scan-to-make/contracts';
import type { CaptureFile } from '../capture/retainedCaptures';
import { adviceJob, parseCloseupAdvice } from './closeupAdviceModel';
import {
  sessionJobMemory,
  unavailableScanServices,
  type CloseupAdvice,
  type ProjectAcknowledgment,
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
    PrinterHandoffBridge?: PrinterHandoffNative;
  } = NativeModules,
): ScanServices {
  const bridge = modules.StillsProcessingBridge;
  const captures = modules.RetainedCaptureBridge;
  if (!bridge || !captures) return unavailableScanServices();
  const sync = new CaptureClient(repository, captures);
  const client = new ScanProcessingClient(repository, bridge);
  const processing: ScanProcessing = client;
  const stills: DetailStills = new DetailStillsClient(repository, bridge);
  // A fast path within a session; after a relaunch, processing.listJobs
  // finds the jobs the companion kept.
  const jobs = sessionJobMemory();
  const readJson = bridge.readJson?.bind(bridge);
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
    jobs,
    // A sent print job outlives this screen and the app session.
    handoffs: storedHandoffMemory(captures),
    printerChoice: storedPrinterChoice(captures),
    // Present only in builds with the printer handoff transport.
    ...(modules.PrinterHandoffBridge
      ? { printing: companionPrinterHandoff(modules.PrinterHandoffBridge) }
      : {}),
    imageUri: file => client.imageUri(file),
    ...(readJson
      ? {
          advice: closeupAdviceLoader({
            listJobs: (p, c, a) => client.listJobs(p, c, a),
            downloadArtifact: (p, c, a, job, name) =>
              client.downloadArtifact(p, c, a, job, name),
            readJson,
            imageUri: file => client.imageUri(file),
            remembered: (p, c) => jobs.load(p, c),
          }),
        }
      : {}),
  };
}

type AdviceSource = {
  listJobs(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<ScanProcessingJob[]>;
  downloadArtifact(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
  ): Promise<CaptureFile>;
  readJson(file: CaptureFile): Promise<string>;
  imageUri(file: CaptureFile): Promise<string | null>;
  remembered(projectId: string, captureId: string): Promise<string | null>;
};

/**
 * Close-up advice from the companion's cleanup job: `advice.json`, plus
 * `advice-NN.png` showing the area for suggestion NN. A missing picture
 * leaves that suggestion without one.
 */
export function closeupAdviceLoader(source: AdviceSource): CloseupAdvice {
  return {
    async load(projectId, captureId, ack) {
      const jobs = await source.listJobs(projectId, captureId, ack);
      const job = adviceJob(
        jobs,
        await source.remembered(projectId, captureId),
      );
      if (!job) return null;
      const file = await source.downloadArtifact(
        projectId,
        captureId,
        ack,
        job,
        'advice.json',
      );
      const targets = parseCloseupAdvice(
        JSON.parse(await source.readJson(file)),
      );
      // Read inside the function: Metro's release inline requires.
      const names = SCAN_ADVICE_NAMES;
      // One picture at a time: the stills bridge serves a single request and
      // rejects overlapping ones as busy.
      for (const target of targets) {
        const name = names[target.rank];
        if (!name || !job.artifacts?.[name]) continue;
        try {
          const image = await source.downloadArtifact(
            projectId,
            captureId,
            ack,
            job,
            name,
          );
          const uri = await source.imageUri(image);
          if (uri) target.imageUri = uri;
        } catch {
          // The suggestion still shows without its picture.
        }
      }
      return targets;
    },
  };
}
