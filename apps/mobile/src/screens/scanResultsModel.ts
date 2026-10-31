import {
  compareScanDimensions,
  type ScanProcessingJob,
  type ScanReference,
} from '@scan-to-make/contracts';
import type { Tone } from '../ui/components';

type Triple = [number, number, number];
export type ViewName = (typeof VIEW_ORDER)[number];

/** Shown hero first: angled views, then top, sides and bottom. */
export const VIEW_ORDER = [
  'iso_pp.png',
  'iso_np.png',
  'iso_nn.png',
  'iso_pn.png',
  'pos_z.png',
  'pos_x.png',
  'pos_y.png',
  'neg_x.png',
  'neg_y.png',
  'neg_z.png',
] as const;
// The measuring frame has no front or back, so sides are numbered.
export const VIEW_LABELS: Record<ViewName, string> = {
  'iso_pp.png': 'Angle 1',
  'iso_np.png': 'Angle 2',
  'iso_nn.png': 'Angle 3',
  'iso_pn.png': 'Angle 4',
  'pos_z.png': 'Top',
  'pos_x.png': 'Side 1',
  'pos_y.png': 'Side 2',
  'neg_x.png': 'Side 3',
  'neg_y.png': 'Side 4',
  'neg_z.png': 'Bottom',
};

/** Sizes are compared longest to shortest, as the companion does. */
export const SIDE_NAMES = ['Longest side', 'Middle side', 'Shortest side'];

export type Preset = { name: string; dimensionsMm: Triple; source: string };
// Published manufacturer sizes only; each is checked against its source.
export const PRESETS: Preset[] = [
  {
    name: 'AirPods Pro 2 case',
    dimensionsMm: [60.6, 45.2, 21.7],
    source: 'Apple published specifications',
  },
  {
    name: 'AirTag',
    dimensionsMm: [31.9, 31.9, 8.0],
    source: 'Apple published specifications',
  },
];

export type ReferenceDraft = {
  sizes: [string, string, string];
  name: string;
  source?: string;
};
export const emptyReference = (): ReferenceDraft => ({
  sizes: ['', '', ''],
  name: '',
});
export function referenceDraft(reference?: ScanReference): ReferenceDraft {
  if (!reference) return emptyReference();
  return {
    sizes: reference.dimensionsMm.map(trimmed) as [string, string, string],
    name: reference.productName ?? '',
    source: reference.source,
  };
}

const MAX_MM = 5000;
export function parseMm(text: string): number {
  const value = text.trim().replace(',', '.');
  return /^\d+(\.\d+)?$|^\.\d+$/.test(value) ? Number(value) : Number.NaN;
}
export type ParsedReference =
  | { state: 'empty' }
  | { state: 'invalid'; errors: (string | null)[] }
  | { state: 'valid'; reference: ScanReference };
export function parseReference(draft: ReferenceDraft): ParsedReference {
  if (draft.sizes.every(size => !size.trim()) && !draft.name.trim()) {
    return { state: 'empty' };
  }
  const values = draft.sizes.map(parseMm);
  const errors = draft.sizes.map((size, index) =>
    !size.trim()
      ? 'Enter a size'
      : !(values[index] > 0 && values[index] <= MAX_MM)
      ? 'Use a number of millimetres, like 45.2'
      : null,
  );
  if (errors.some(Boolean)) return { state: 'invalid', errors };
  const name = draft.name.trim().slice(0, 200);
  return {
    state: 'valid',
    reference: {
      dimensionsMm: values as Triple,
      ...(draft.source ? { source: draft.source } : {}),
      ...(name ? { productName: name } : {}),
    },
  };
}

function trimmed(value: number) {
  return String(Math.round(value * 100) / 100);
}
export function formatMm(value: number) {
  return `${value.toFixed(1)} mm`;
}
/** Differences under 0.05 mm round to zero at this precision. */
export function describeDifference(error: number) {
  const size = Math.abs(error);
  if (size < 0.05) return { short: '0.0 mm', words: 'matches' };
  return {
    short: `${error > 0 ? '+' : '−'}${size.toFixed(1)} mm`,
    words: `${size.toFixed(1)} mm ${error > 0 ? 'larger' : 'smaller'}`,
  };
}

export type Comparison = {
  measured: Triple;
  reference: Triple;
  errors: Triple;
};
export function compare(
  job: ScanProcessingJob,
  reference: ScanReference | null,
): Comparison | null {
  if (!reference || !job.measuredPrincipalExtentsMm) return null;
  const result = compareScanDimensions(
    [...job.measuredPrincipalExtentsMm],
    [...reference.dimensionsMm],
  );
  return {
    measured: result.measuredDimensionsMm as Triple,
    reference: result.referenceDimensionsMm as Triple,
    errors: result.errorMm as Triple,
  };
}

export type Closeness = {
  label: string;
  tone: Tone;
  summary: string;
  advice: string;
};
export function closeness({ errors }: Comparison): Closeness {
  let worst = 0;
  errors.forEach((error, index) => {
    if (Math.abs(error) > Math.abs(errors[worst])) worst = index;
  });
  const size = Math.abs(errors[worst]);
  const side = SIDE_NAMES[worst].toLowerCase();
  const larger = errors[worst] > 0;
  const off = `The ${side} is ${
    describeDifference(errors[worst]).words
  } than the real size.`;
  if (size <= 0.5) {
    return {
      label: 'Very close',
      tone: 'pass',
      summary: 'Every side is within 0.5 mm of the real size.',
      advice: 'A strong starting point for parts that need to fit snugly.',
    };
  }
  if (size <= 1.5) {
    return {
      label: 'Close',
      tone: 'pass',
      summary: 'Every side is within 1.5 mm of the real size.',
      advice:
        'Fine for stands and trays. Snug-fitting parts may need a closer scan.',
    };
  }
  if (size <= 3) {
    return {
      label: 'Somewhat off',
      tone: 'pending',
      summary: off,
      advice: larger
        ? 'Parts made from this scan may fit loosely.'
        : 'Parts made from this scan may be too tight.',
    };
  }
  return {
    label: 'Noticeably off',
    tone: 'fail',
    summary: off,
    advice:
      'Check the real size you entered. If it’s right, try scanning again with the whole object in view.',
  };
}

export function isActive(job: ScanProcessingJob) {
  return job.status === 'queued' || job.status === 'running';
}

export const STAGE_LABELS = {
  repair: 'Clean up the scan',
  measure: 'Measure it',
  render: 'Render 10 views',
} as const;
export function stageState(status: ScanProcessingJob['status']) {
  return {
    queued: { label: 'Waiting', tone: 'neutral' as Tone },
    running: { label: 'In progress', tone: 'accent' as Tone },
    succeeded: { label: 'Done', tone: 'pass' as Tone },
    failed: { label: 'Stopped', tone: 'fail' as Tone },
  }[status];
}

export function failureCopy(job: ScanProcessingJob) {
  switch (job.failure) {
    case 'cancelled':
      return {
        title: 'You stopped this check',
        body: 'Nothing from it was kept. Start again whenever you’re ready.',
      };
    case 'interrupted':
      return {
        title: 'Your companion restarted',
        body: 'The check stopped before it finished, and nothing from it was kept. Start it again to retry.',
      };
    default:
      return {
        title: 'This scan couldn’t be checked',
        body: 'The clean-up step couldn’t finish. Scans with big gaps, or with the table or background included, often cause this. Try again, or take a new scan.',
      };
  }
}

/** Revision recorded in an acknowledged project snapshot. */
export function snapshotRevision(snapshot: string): number | null {
  try {
    const revision = JSON.parse(snapshot)?.revision;
    return Number.isSafeInteger(revision) ? revision : null;
  } catch {
    return null;
  }
}

/** Start order for a job: `createdAtMs`, falling back to `enqueuedAt`. */
export function jobCreatedOrder(job: ScanProcessingJob): number {
  return (
    job.createdAtMs ??
    (job.enqueuedAt ? Date.parse(job.enqueuedAt) : 0)
  );
}
function newestJob(
  jobs: ScanProcessingJob[],
): ScanProcessingJob | null {
  let best: ScanProcessingJob | null = null;
  for (const job of jobs) {
    if (!best || jobCreatedOrder(job) > jobCreatedOrder(best)) best = job;
  }
  return best;
}

/**
 * Which listed job to show. Job IDs are random, so start order comes from
 * `createdAtMs`: prefer the newest active job, then the newest finished
 * check when it is newer than the remembered one (a follow-up correction
 * supersedes the job it followed), then the remembered job. Without any
 * timestamps the remembered job keeps its old preference. The rest stay
 * available as other checks.
 */
export function chooseJob(
  jobs: ScanProcessingJob[],
  rememberedId: string | null,
): ScanProcessingJob | null {
  const active = newestJob(jobs.filter(isActive));
  if (active) return active;
  const remembered = jobs.find(job => job.jobId === rememberedId) ?? null;
  const finished = newestJob(
    jobs.filter(job => job.status === 'succeeded'),
  );
  if (
    finished &&
    (!remembered || jobCreatedOrder(finished) > jobCreatedOrder(remembered))
  ) {
    return finished;
  }
  return remembered ?? finished ?? newestJob(jobs);
}

export function jobLabel(job: ScanProcessingJob): {
  title: string;
  detail: string;
  badge: string;
  tone: Tone;
} {
  const id = `Check ${job.jobId.slice(0, 8)}`;
  if (isActive(job)) {
    return {
      title: 'Check in progress',
      detail: id,
      badge: 'Working',
      tone: 'accent',
    };
  }
  if (job.status === 'succeeded') {
    const compared = job.reference?.productName
      ? `Compared with ${job.reference.productName}`
      : job.reference
      ? 'Compared with a real size'
      : 'No real size';
    return {
      title: 'Finished check',
      detail: `${compared} · ${id}`,
      badge: 'Ready',
      tone: 'pass',
    };
  }
  const title =
    job.failure === 'cancelled'
      ? 'Stopped check'
      : job.failure === 'interrupted'
      ? 'Interrupted check'
      : 'Check that didn’t finish';
  return { title, detail: id, badge: 'Not finished', tone: 'fail' };
}
