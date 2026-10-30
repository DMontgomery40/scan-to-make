// Synthetic fakes for print review tests. Nothing in the app imports this file.
import { ackFor } from './fakeScanServices';
import {
  sessionPrintMemory,
  type PreparedPrint,
  type PrintabilityReport,
  type PrintabilityVerdict,
  type PrintIntent,
  type PrintReviewServices,
  type SliceSummary,
} from '../printReviewServices';

export const DESIGN = {
  sha256: 'd'.repeat(64),
  byteLength: 48_284,
  mediaType: 'model/stl',
};

export function failure(
  code: string,
  extra: { report?: PrintabilityReport; status?: number } = {},
) {
  return Object.assign(Error(`Synthetic failure: ${code}`), { code, ...extra });
}

export function syntheticReport(
  verdict: PrintabilityVerdict,
  codes: string[] = verdict === 'printable' ? ['all-checks-passed'] : [],
  warnings: { code: string; message: string }[] = [],
): PrintabilityReport {
  return {
    verdict,
    reasonCodes: codes,
    reasons: codes.map(code => `${code}: synthetic detail for ${code}`),
    warnings,
  };
}

export function syntheticPrint(
  options: {
    verdict?: PrintabilityVerdict;
    slice?: Partial<SliceSummary>;
    warnings?: { code: string; message: string }[];
    jobSha256?: string;
  } = {},
): PreparedPrint {
  const verdict = options.verdict ?? 'printable';
  return {
    jobId: '00000000-0000-4000-8000-000000000000',
    jobSha256: options.jobSha256 ?? 'a1'.repeat(32),
    printableArtifact: {
      sha256: 'b2'.repeat(32),
      byteLength: 1_204_331,
      mediaType: 'text/x.gcode',
    },
    selection: {
      printerId: 'synthetic-printer',
      model: 'p1s',
      plateIndex: 0,
      nozzleDiameters: [0.4],
      bedType: 'textured_plate',
      materials: [{ projectSlot: 0, material: 'PLA', physicalTray: 0 }],
      slicerSettingsSha256: 'c3'.repeat(32),
    },
    printability: syntheticReport(
      verdict,
      verdict === 'printable-with-supports'
        ? ['overhangs-require-supports']
        : undefined,
      options.warnings,
    ),
    slice: {
      estimatedPrintSeconds: 8040,
      filamentWeightG: 18.42,
      filamentLengthMm: 6118,
      layerCount: 112,
      enableSupport: verdict === 'printable-with-supports',
      ...options.slice,
    },
    profile: {
      id: 'p1s-0.4-hardened',
      displayName: 'Bambu Lab P1S (0.4 mm hardened steel)',
      bambuModel: 'p1s',
      nozzleDiameterMm: 0.4,
      nozzleType: 'hardened_steel',
      bedType: 'textured_plate',
    },
  };
}

/**
 * An in-memory companion. `prepared` is a queue of results or errors for
 * each prepare call (the last one repeats). A second claim is rejected the
 * way the companion rejects a replayed intent.
 */
export function fakePrintServices(
  options: { prepared?: (PreparedPrint | Error)[] } = {},
) {
  const calls: string[] = [];
  const queue = [...(options.prepared ?? [syntheticPrint()])];
  let intent: PrintIntent | null = null;
  const services: PrintReviewServices = {
    acknowledge: async () => {
      calls.push('acknowledge');
      return ackFor(0);
    },
    prepare: async (_p, _a, request) => {
      calls.push(
        `prepare ${request.allowSupports ? 'supports' : 'plain'} ${
          request.jobId
        }`,
      );
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return { ...next, jobId: request.jobId };
    },
    claimIntent: async (_p, _a, jobId, approval) => {
      calls.push(`claim ${approval.jobSha256}`);
      if (intent) throw failure('already-sent');
      intent = {
        intentId: '11111111-2222-4333-8444-555555555555',
        jobId,
        jobSha256: approval.jobSha256,
        atMs: 1_793_400_000_000,
      };
      return intent;
    },
    attempt: async (_p, _a, jobId) => {
      calls.push('attempt');
      return { intent: intent?.jobId === jobId ? intent : null };
    },
    jobs: sessionPrintMemory(),
  };
  return {
    services,
    calls,
    /** Records an intent as if a lost-reply send had reached the companion. */
    recordIntent(jobId: string, jobSha256: string) {
      intent = {
        intentId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
        jobId,
        jobSha256,
        atMs: 0,
      };
    },
  };
}
