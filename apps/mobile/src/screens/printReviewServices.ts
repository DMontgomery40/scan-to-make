import type { CaptureFile } from '../capture/retainedCaptures';
import type { ProjectAcknowledgment } from './scanServices';

/**
 * What the print review screen needs from the companion. These mirror the
 * companion's prepared-job store (`prepareProduced`, `claimIntent`) and its
 * journal, as plain types: the app does not depend on the Node service.
 * The host pins printer, material and trays, and derives the approving actor
 * and expiry; the app supplies only the accepted design and the user's
 * confirmation of the exact job it reviewed.
 */
export type PrintabilityVerdict =
  | 'printable'
  | 'printable-with-supports'
  | 'not-printable';
/** `scan-to-make.printability/0.1.0` report fields the screen shows. */
export type PrintabilityReport = {
  verdict: PrintabilityVerdict;
  reasonCodes: string[];
  /** `"<code>: <message>"`, one per reason code. */
  reasons: string[];
  warnings: { code: string; message: string }[];
};
/** The slicer's G-code summary. Any field can be missing from the header. */
export type SliceSummary = {
  estimatedPrintSeconds: number | null;
  filamentWeightG: number | null;
  filamentLengthMm: number | null;
  layerCount: number | null;
  enableSupport: boolean | null;
};
export type PrinterProfile = {
  id: string;
  displayName: string;
  bambuModel: string;
  nozzleDiameterMm: number;
  nozzleType: string;
  bedType: string;
};
/** Mirrors the companion's `PrintSelectionSchema`. */
export type PrintSelection = {
  printerId: string;
  model: string;
  plateIndex: number;
  nozzleDiameters: number[];
  bedType: string;
  materials: { projectSlot: number; material: string; physicalTray: number }[];
  slicerSettingsSha256: string;
};
export type PreparedPrint = {
  jobId: string;
  jobSha256: string;
  printableArtifact: CaptureFile;
  selection: PrintSelection;
  printability: PrintabilityReport;
  slice: SliceSummary;
  profile: PrinterProfile;
};
export type PrintIntent = {
  intentId: string;
  jobId: string;
  jobSha256: string;
  atMs: number;
};
/** The intent now; journal outcome and resolution once the host reports them. */
export type PrintAttempt = {
  intent: PrintIntent | null;
  outcome?: 'started' | 'unconfirmed' | 'uncertain';
  resolution?: 'finished' | 'cancelled' | 'rejected';
};
/**
 * Codes the screen branches on, attached to thrown errors as `code`.
 * `printability-failed` and `supports-required` also carry `report`.
 */
export type PrintFailureCode =
  | 'printability-failed'
  | 'supports-required'
  | 'printer-offline'
  | 'printer-busy'
  | 'approval-expired'
  | 'already-sent'
  | 'project-changed'
  | 'ambiguous-send'
  | 'not-available';

/** Which job a design was prepared as, so a return visit reuses it. */
export type RememberedPrint = {
  jobId: string;
  allowSupports: boolean;
  prepared: boolean;
};
export interface PrintJobMemory {
  load(
    projectId: string,
    designSha256: string,
  ): Promise<RememberedPrint | null>;
  save(
    projectId: string,
    designSha256: string,
    value: RememberedPrint | null,
  ): Promise<void>;
}

export interface PrintReviewServices {
  acknowledge(projectId: string): Promise<ProjectAcknowledgment>;
  /**
   * Checks printability, slices and inspects on the companion. Retrying the
   * same `jobId` with the same request returns the persisted job without
   * slicing again; a changed request needs a new `jobId`.
   */
  prepare(
    projectId: string,
    ack: ProjectAcknowledgment,
    request: { jobId: string; design: CaptureFile; allowSupports: boolean },
  ): Promise<PreparedPrint>;
  /** Records the user's single-use approval of exactly this job. */
  claimIntent(
    projectId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
    approval: { jobSha256: string; confirmed: true },
  ): Promise<PrintIntent>;
  attempt(
    projectId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
  ): Promise<PrintAttempt>;
  jobs: PrintJobMemory;
}

/** Kept for the app session only. Survives navigation, not a relaunch. */
export function sessionPrintMemory(): PrintJobMemory {
  const jobs = new Map<string, RememberedPrint>();
  const key = (projectId: string, sha: string) =>
    JSON.stringify([projectId, sha]);
  return {
    load: async (projectId, sha) => jobs.get(key(projectId, sha)) ?? null,
    save: async (projectId, sha, value) => {
      if (value) jobs.set(key(projectId, sha), value);
      else jobs.delete(key(projectId, sha));
    },
  };
}

/** A version 4 UUID for a prepared job's idempotency key. */
export function newJobId(): string {
  const native = (
    globalThis as { crypto?: { randomUUID?: () => string } }
  ).crypto?.randomUUID?.();
  if (native) return native;
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
  hex[12] = '4';
  // RFC 4122 variant: the 17th hex digit is one of 8, 9, a or b.
  hex[16] = '89ab'[Math.floor(Math.random() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(
    16,
    20,
  )}-${s.slice(20)}`;
}

function unavailable(): never {
  throw Object.assign(
    Error(
      'Printing from the app arrives with the next companion update. Your design is saved and can still be exported as an STL.',
    ),
    { code: 'not-available' },
  );
}

/** Used until the companion's print routes ship. Never pretends to work. */
export function unavailablePrintReviewServices(): PrintReviewServices {
  return {
    acknowledge: async () => unavailable(),
    prepare: async () => unavailable(),
    claimIntent: async () => unavailable(),
    attempt: async () => unavailable(),
    jobs: sessionPrintMemory(),
  };
}
