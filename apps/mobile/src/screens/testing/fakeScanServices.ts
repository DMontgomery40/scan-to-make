// Synthetic fakes for screen tests. Nothing in the app imports this file.
import {
  DETAIL_STILL_SCHEMA_ID,
  SCAN_PROCESSING_SCHEMA_ID,
  ScanProcessingJobSchema,
  type DetailStill,
  type ScanProcessingJob,
  type ScanReference,
} from '@scan-to-make/contracts';
import type { CaptureFile } from '../../capture/retainedCaptures';
import { parseCloseupAdvice, type CloseupTarget } from '../closeupAdviceModel';
import {
  sessionJobMemory,
  type PickedPhoto,
  type ProjectAcknowledgment,
  type RejectedPhoto,
  type ScanServices,
  type ScanTarget,
} from '../scanServices';
import {
  sessionHandoffMemory,
  sessionPrinterChoice,
} from '../../printing/printerHandoff';

export const PROJECT_ID = 'synthetic-project';
export const CAPTURE_ID = '6f0c1d52-9a4e-4b7a-8f3e-2d1c0b9a8e71';
export const JOB_ID = '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8';
const ref = (c: string, mediaType: string) => ({
  sha256: c.repeat(64),
  byteLength: 123,
  mediaType,
});

export function syntheticTarget(projectRevision = 0): ScanTarget {
  return {
    projectId: PROJECT_ID,
    capture: {
      captureId: CAPTURE_ID,
      binding: {
        projectId: PROJECT_ID,
        projectRevision,
        capture: {
          formatVersion: '0.1.0',
          original: ref('a', 'model/vnd.usdz+zip'),
          derived: ref('b', 'model/obj'),
          conversionReport: ref('c', 'application/json'),
          converter: { name: 'capture-mesh-convert', version: '0.1.0' },
          provenance: {
            metersPerUnit: 1,
            unitsAuthored: true,
            upAxis: 'Y',
            coordinates: 'world',
            transformPolicy: 'composed-once-native-unrescaled',
            contributingLayers: [
              {
                identifier: 'root.usdc',
                artifact: ref('d', 'application/octet-stream'),
              },
            ],
          },
          qualification: { status: 'qualified', reasons: [] },
          evidence: {
            metricAccuracy: 'unknown',
            surfaceCompleteness: 'unknown',
            physicalFit: 'unknown',
          },
        },
      },
    } as ScanTarget['capture'],
  };
}

export function ackFor(revision = 0): ProjectAcknowledgment {
  return {
    etag: `"${'e'.repeat(64)}"`,
    snapshot: JSON.stringify({ id: PROJECT_ID, revision }),
  };
}

type Status = ScanProcessingJob['status'];
const STAGE_STATUS: Record<Status, [Status, Status, Status]> = {
  queued: ['queued', 'queued', 'queued'],
  running: ['succeeded', 'running', 'queued'],
  succeeded: ['succeeded', 'succeeded', 'succeeded'],
  failed: ['failed', 'queued', 'queued'],
};
const NAMES = [
  'repaired.stl',
  'repaired.obj',
  'report.json',
  'pos_x.png',
  'pos_y.png',
  'pos_z.png',
  'neg_x.png',
  'neg_y.png',
  'neg_z.png',
  'iso_pp.png',
  'iso_np.png',
  'iso_nn.png',
  'iso_pn.png',
] as const;
const MEDIA = (name: string) =>
  name.endsWith('.png')
    ? 'image/png'
    : name.endsWith('.stl')
    ? 'model/stl'
    : name.endsWith('.obj')
    ? 'model/obj'
    : 'application/json';

/** A job record that passes the shared contract schema. */
export function syntheticJob(
  status: Status,
  options: {
    measured?: [number, number, number];
    reference?: ScanReference;
    failure?: ScanProcessingJob['failure'];
    jobId?: string;
    /** A result that went through the AI step, with previews for these tries. */
    aiTweak?: ScanProcessingJob['aiTweak'];
    previews?: number[];
  } = {},
): ScanProcessingJob {
  const [repair, measure, render] = STAGE_STATUS[status];
  const measured = options.measured ?? [61.4, 46.0, 21.7];
  const job = {
    schema: SCAN_PROCESSING_SCHEMA_ID,
    jobId: options.jobId ?? JOB_ID,
    projectId: PROJECT_ID,
    captureId: CAPTURE_ID,
    projectRevision: 0,
    status,
    previewOnly: true,
    stages: [
      {
        kind: 'repair',
        status: repair,
        params: {
          weldMm: 0.01,
          componentFraction: 0.01,
          componentMetric: 'area',
          holeMaxEdges: 0,
          voxelSizeMm: 0.3,
          forceVoxel: false,
          denoiseIterations: 1,
          denoiseFactor: 0.1,
          denoiseMaxMm: 0.05,
          sharpAngleDeg: 30,
          deviationSamples: 10000,
        },
      },
      { kind: 'measure', status: measure, params: { units: 'mm' } },
      {
        kind: 'render',
        status: render,
        params: { units: 'mm', resolution: 512 },
      },
    ],
    ...(options.reference ? { reference: options.reference } : {}),
    ...(status === 'succeeded'
      ? {
          measuredPrincipalExtentsMm: measured,
          artifacts: Object.fromEntries(
            NAMES.map((name, i) => [
              name,
              {
                sha256: i.toString(16).padStart(2, '0').repeat(32),
                byteLength: 1000 + i,
                mediaType: MEDIA(name),
              },
            ]),
          ),
          ...(options.reference
            ? {
                comparison: {
                  matching: 'sorted-descending',
                  referenceDimensionsMm: [
                    ...options.reference.dimensionsMm,
                  ].sort((a, b) => b - a),
                  measuredDimensionsMm: [...measured].sort((a, b) => b - a),
                  errorMm: [0, 0, 0],
                },
              }
            : {}),
        }
      : {}),
    ...(status === 'failed'
      ? { failure: options.failure ?? 'processing-failed' }
      : {}),
    ...(options.aiTweak
      ? { correctionAdapter: 'ai-tweak', aiTweak: options.aiTweak }
      : {}),
  };
  if (status === 'succeeded')
    for (const n of options.previews ?? [])
      (job as { artifacts: Record<string, unknown> }).artifacts[
        `ai-attempt-${n}-preview.png`
      ] = {
        sha256: `${n}`.repeat(64),
        byteLength: 2000 + n,
        mediaType: 'image/png',
      };
  return ScanProcessingJobSchema.parse(job);
}

let counter = 0;
export function syntheticPhoto(
  overrides: Partial<PickedPhoto> = {},
): PickedPhoto {
  counter++;
  return {
    sha256: counter.toString(16).padStart(64, '0'),
    byteLength: 2_400_000,
    mediaType: 'image/heic',
    uri: `file:///synthetic/photo-${counter}.heic`,
    ...overrides,
  };
}

export function stillFrom(
  photo: CaptureFile,
  ordinal: number,
  label?: string,
): DetailStill {
  return {
    schema: DETAIL_STILL_SCHEMA_ID,
    id: `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, '0')}`,
    projectId: PROJECT_ID,
    captureId: CAPTURE_ID,
    projectRevision: 0,
    mediaType: photo.mediaType as DetailStill['mediaType'],
    byteLength: photo.byteLength,
    sha256: photo.sha256,
    ordinal,
    ...(label ? { label } : {}),
  };
}

/**
 * An in-memory companion. `calls` records each request; tests replace any
 * method to script failures.
 */
export function fakeScanServices(
  options: {
    revision?: number;
    jobs?: ScanProcessingJob[];
    stills?: DetailStill[];
    picks?: { photos: PickedPhoto[]; rejected: RejectedPhoto[] }[];
    /** Jobs the companion lists for the capture, or 'not-available'. */
    listed?: ScanProcessingJob[] | 'not-available';
    /** Stills whose bytes are already on the device (by sha256). */
    cachedStills?: string[];
    /** The companion's suggested close-ups; an Error makes loading fail. */
    advice?: CloseupTarget[] | null | Error;
  } = {},
) {
  const cached = new Set(options.cachedStills ?? []);
  const calls: string[] = [];
  const stills = [...(options.stills ?? [])];
  const queue = [...(options.jobs ?? [])];
  const picks = [...(options.picks ?? [])];
  let current: ScanProcessingJob | null = null;
  let ordinal = stills.reduce((n, s) => Math.max(n, s.ordinal + 1), 0);
  const next = () => {
    if (queue.length) current = queue.shift()!;
    if (!current) throw Object.assign(Error('Not found'), { status: 404 });
    return current;
  };
  const services: ScanServices = {
    acknowledge: async () => {
      calls.push('acknowledge');
      return ackFor(options.revision ?? 0);
    },
    processing: {
      start: async (_p, _c, _a, reference) => {
        calls.push(`start${reference ? ' with reference' : ''}`);
        return next();
      },
      status: async (_p, _c, _a, jobId) => {
        calls.push(`status ${jobId}`);
        return next();
      },
      cancel: async () => {
        calls.push('cancel');
        current = syntheticJob('failed', { failure: 'cancelled' });
        return current;
      },
      downloadArtifact: async (_p, _c, _a, job, name) => {
        calls.push(`download ${name}`);
        return job.artifacts![name]!;
      },
      openArtifact: async (_p, _c, _a, _j, name, share) => {
        calls.push(`${share ? 'share' : 'open'} ${name}`);
      },
      ...(options.listed
        ? {
            listJobs: async () => {
              calls.push('list jobs');
              if (options.listed === 'not-available') {
                throw Object.assign(Error('Not available'), {
                  code: 'not-available',
                  status: 405,
                });
              }
              return [...options.listed!];
            },
          }
        : {}),
    },
    stills: {
      list: async () => {
        calls.push('list');
        return [...stills];
      },
      upload: async (_p, _c, _a, source, label) => {
        calls.push(
          `upload ${source.sha256.slice(-4)}${label ? ` "${label}"` : ''}`,
        );
        const still = stillFrom(source, ordinal++, label);
        stills.push(still);
        return still;
      },
      openFile: async (_p, _c, _a, still) => {
        calls.push(`view ${still.id}`);
      },
      remove: async (_p, _c, _a, stillId) => {
        calls.push(`remove ${stillId}`);
        stills.splice(
          stills.findIndex(s => s.id === stillId),
          1,
        );
      },
      download: async (_p, _c, _a, still) => {
        calls.push(`download still ${still.ordinal}`);
        cached.add(still.sha256);
        return {
          sha256: still.sha256,
          byteLength: still.byteLength,
          mediaType: still.mediaType,
        };
      },
      imageUri: async still => {
        calls.push(`still uri ${still.ordinal}`);
        // Like the iOS bridge: a cache miss rejects rather than resolving null.
        if (!cached.has(still.sha256)) {
          throw Object.assign(
            Error('The detail photo is not on this device.'),
            {
              code: 'verification-failed',
            },
          );
        }
        return `file:///synthetic/still-${still.sha256.slice(-6)}.jpg`;
      },
    },
    picker: {
      pick: async limit => {
        calls.push(`pick ${limit}`);
        return picks.shift() ?? { photos: [], rejected: [] };
      },
      discard: async files => {
        calls.push(`discard ${files.length}`);
      },
    },
    jobs: sessionJobMemory(),
    handoffs: sessionHandoffMemory(),
    printerChoice: sessionPrinterChoice(),
    imageUri: async file => `file:///synthetic/${file.sha256.slice(0, 8)}.png`,
    openCapturedScan: async () => {
      calls.push('open captured scan');
    },
  };
  const advice = options.advice;
  if (advice !== undefined) {
    services.advice = {
      load: async () => {
        calls.push('advice');
        if (advice instanceof Error) throw advice;
        return advice;
      },
    };
  }
  return { services, calls, stills };
}

/**
 * Suggestions shaped like scan-correct's advice.json for a small case, with
 * the fields the app ignores left in.
 */
export function syntheticAdvice(): CloseupTarget[] {
  const target = (
    rank: number,
    label: string,
    side: string,
    reasonCode: string,
    distanceMm: number,
  ) => ({
    rank,
    label,
    side,
    reasonCode,
    reason: 'not shown',
    viewDirection: [0, 0, 1],
    targetMm: [0, 0, 0],
    distanceMm,
    expectedBenefitScore: 90 - rank * 10,
    regionBoundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    evidence: { method: 'synthetic', faces: 12, heuristic: true },
    render: {
      path: `target-${rank}.png`,
      sha256: 'c'.repeat(64),
      containsTexture: false,
    },
    labelSource: 'caller',
  });
  return parseCloseupAdvice({
    closeupAdvice: {
      schemaVersion: 1,
      coordinateFrame: 'input',
      targets: [
        target(2, 'Bottom (USB-C port)', 'neg_z', 'fine_feature', 130),
        target(1, 'Back (hinge side)', 'neg_y', 'inferred_fill', 250),
      ],
      warnings: [],
      limitations: [],
      previewOnly: true,
      provesPhysicalAccuracy: false,
      inputs: {},
      boxExtentsMm: [62, 47, 22],
    },
  });
}
