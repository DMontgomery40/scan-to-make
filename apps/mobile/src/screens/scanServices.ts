import type {
  DetailStill,
  ScanArtifactName,
  ScanProcessingJob,
  ScanReference,
} from '@scan-to-make/contracts';
import type { CaptureFile, RetainedCapture } from '../capture/retainedCaptures';
import type { CloseupTarget } from './closeupAdviceModel';

/**
 * What the scan results, close-up and make screens need from the data layer.
 * The method shapes match `ScanProcessingClient` and `DetailStillsClient`
 * (src/processing, src/stills), so the real clients can be passed directly.
 * Tests pass fakes.
 */
export type ProjectAcknowledgment = { etag: string; snapshot: string };

export interface ScanProcessing {
  start(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    reference?: ScanReference,
  ): Promise<ScanProcessingJob>;
  status(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
  ): Promise<ScanProcessingJob>;
  cancel(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
  ): Promise<ScanProcessingJob>;
  downloadArtifact(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
  ): Promise<CaptureFile>;
  openArtifact(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
    share: boolean,
  ): Promise<unknown>;
  /**
   * Every retained job for the capture, in job-id order (not start order).
   * Throws `code: 'not-available'` on companions without the listing route.
   */
  listJobs?(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<ScanProcessingJob[]>;
}

export interface DetailStills {
  list(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<DetailStill[]>;
  upload(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    source: CaptureFile,
    label?: string,
  ): Promise<DetailStill>;
  openFile(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    still: DetailStill,
    share: boolean,
  ): Promise<unknown>;
  remove(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    stillId: string,
  ): Promise<void>;
  /** Fetches and verifies a still's bytes so it can be displayed. */
  download?(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    still: DetailStill,
  ): Promise<CaptureFile>;
  /** A displayable URI for a still whose bytes are on this device, or null. */
  imageUri?(still: DetailStill): Promise<string | null>;
}

/** Suggested close-ups from the companion's scan check (scan-correct `advise`). */
export interface CloseupAdvice {
  /** Best first, or null when the companion has no suggestions for the scan yet. */
  load(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<CloseupTarget[] | null>;
}

/** A chosen photo kept by the app, identified by its exact bytes. */
export type PickedPhoto = CaptureFile & { uri?: string };
export type RejectedPhoto = {
  reason: 'too-large' | 'unsupported' | 'unreadable';
  byteLength?: number;
};
export interface PhotoPicker {
  /** Resolves with empty lists when the user cancels. */
  pick(
    limit: number,
  ): Promise<{ photos: PickedPhoto[]; rejected: RejectedPhoto[] }>;
  /** Removes local copies that are no longer needed. */
  discard(files: CaptureFile[]): Promise<void>;
}

/**
 * The companion has no job listing, so the started job ID must be kept by
 * the app to follow it.
 */
export interface ScanJobMemory {
  load(projectId: string, captureId: string): Promise<string | null>;
  save(
    projectId: string,
    captureId: string,
    jobId: string | null,
  ): Promise<void>;
}

export type ScanServices = {
  /** Syncs the saved project with the companion; see CaptureClient.sync. */
  acknowledge(projectId: string): Promise<ProjectAcknowledgment>;
  processing: ScanProcessing;
  stills: DetailStills;
  picker: PhotoPicker;
  jobs: ScanJobMemory;
  /** Absent until the companion returns its scan check's advice. */
  advice?: CloseupAdvice;
  /** A displayable URI for verified image bytes, when the platform has one. */
  imageUri?: (file: CaptureFile) => Promise<string | null>;
};

export type ScanTarget = { projectId: string; capture: RetainedCapture };

export type Failure = { message: string; code?: string; status?: number };
export function failureOf(error: unknown): Failure {
  const value = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
  };
  return {
    message:
      typeof value?.message === 'string' && value.message
        ? value.message
        : 'Something went wrong. Try again.',
    code: typeof value?.code === 'string' ? value.code : undefined,
    status: typeof value?.status === 'number' ? value.status : undefined,
  };
}

const CONNECTION_CODES = new Set([
  'pairing-required',
  'pairing-changed',
  'unauthorized',
  'forbidden',
  'not-paired',
]);
/** This build has no companion transport for the feature. */
export const notAvailable = (failure: Failure) =>
  failure.code === 'not-available';

/** The companion connection is missing, expired or lacks permission. */
export function needsConnection(failure: Failure) {
  return (
    failure.status === 401 ||
    failure.status === 403 ||
    (!!failure.code && CONNECTION_CODES.has(failure.code))
  );
}

/** Kept for the app session only. Survives navigation, not a relaunch. */
export function sessionJobMemory(): ScanJobMemory {
  const jobs = new Map<string, string>();
  const key = (projectId: string, captureId: string) =>
    JSON.stringify([projectId, captureId]);
  return {
    load: async (projectId, captureId) =>
      jobs.get(key(projectId, captureId)) ?? null,
    save: async (projectId, captureId, jobId) => {
      if (jobId) jobs.set(key(projectId, captureId), jobId);
      else jobs.delete(key(projectId, captureId));
    },
  };
}

function unavailable(): never {
  throw Object.assign(
    Error(
      'Scan checks and close-ups are available in the iPhone app. Your scan is kept with this project.',
    ),
    { code: 'not-available' },
  );
}

/** Used until the native transports are present. Never pretends to work. */
export function unavailableScanServices(): ScanServices {
  return {
    acknowledge: async () => unavailable(),
    processing: {
      start: async () => unavailable(),
      status: async () => unavailable(),
      cancel: async () => unavailable(),
      downloadArtifact: async () => unavailable(),
      openArtifact: async () => unavailable(),
    },
    stills: {
      list: async () => unavailable(),
      upload: async () => unavailable(),
      openFile: async () => unavailable(),
      remove: async () => unavailable(),
    },
    picker: { pick: async () => unavailable(), discard: async () => {} },
    jobs: sessionJobMemory(),
  };
}
