import { z } from 'zod';
import type { DetailStill, ScanProcessingJob } from '@scan-to-make/contracts';

/**
 * The part of the companion's `closeupAdvice` (closeup-advice.schema.json)
 * that the Close-ups screen shows. Other fields are accepted and ignored.
 */
const TargetSchema = z.object({
  rank: z.number().int().min(1).max(6),
  label: z.string().min(1).max(80),
  side: z.enum(['pos_x', 'neg_x', 'pos_y', 'neg_y', 'pos_z', 'neg_z']),
  reasonCode: z.enum([
    'inferred_fill',
    'surface_lumpy',
    'fine_feature',
    'dark_texture',
    'size_check',
  ]),
  distanceMm: z.number().finite().positive(),
});
const AdviceSchema = z.object({
  closeupAdvice: z.object({
    schemaVersion: z.literal(1),
    targets: z.array(TargetSchema).max(6),
  }),
});
export type CloseupTarget = z.infer<typeof TargetSchema> & {
  /** The companion's render of the area to photograph, when it has one. */
  imageUri?: string;
};

/** Targets from an `advice.json` wrapper, best first. Throws if it isn't one. */
export function parseCloseupAdvice(json: unknown): CloseupTarget[] {
  return [...AdviceSchema.parse(json).closeupAdvice.targets].sort(
    (a, b) => a.rank - b.rank,
  );
}

// What the scan shows there, and what a photo helps with.
/**
 * The job whose advice to show: the one this app last followed if it has
 * advice, else any the companion kept. Advice survives a failed correction.
 */
export function adviceJob(
  jobs: ScanProcessingJob[],
  rememberedId: string | null,
): ScanProcessingJob | null {
  const hasAdvice = (job: ScanProcessingJob) =>
    !!job.artifacts?.['advice.json'];
  return (
    jobs.find(job => job.jobId === rememberedId && hasAdvice(job)) ??
    jobs.find(hasAdvice) ??
    null
  );
}

const REASONS: Record<CloseupTarget['reasonCode'], string> = {
  inferred_fill:
    'This side looks sparse in the scan. A close-up helps fill it in accurately.',
  surface_lumpy:
    'The surface looks lumpy here. A close-up shows its real shape.',
  fine_feature: 'Small detail here. A close-up captures it.',
  dark_texture:
    'This area looks dark in the scan. A close-up shows what’s there.',
  size_check: 'Include a ruler in this close-up to check the real size.',
};
export const reasonText = (target: CloseupTarget) => REASONS[target.reasonCode];

/** A starting distance from the scan's geometry, not a camera calibration. */
export const distanceText = (target: CloseupTarget) =>
  `Start about ${Math.max(1, Math.round(target.distanceMm / 10))} cm away`;

// Photos added from a suggestion carry its label, so labels identify them.
const key = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();

export type TargetMatch = {
  target: CloseupTarget;
  /** The added close-up for this suggestion, if there is one. */
  still?: DetailStill;
  /** A chosen photo for this suggestion that hasn't been added yet. */
  chosen: boolean;
};

/**
 * Pairs each suggestion with the first added close-up whose label matches it.
 * A close-up is used for at most one suggestion. Close-ups that match none
 * stay in the screen's own list.
 */
export function matchAdvice(
  targets: CloseupTarget[],
  stills: DetailStill[],
  chosenLabels: string[] = [],
): TargetMatch[] {
  const used = new Set<string>();
  const chosen = new Set(chosenLabels.map(key));
  return targets.map(target => {
    const still = stills.find(
      s => !used.has(s.id) && !!s.label && key(s.label) === key(target.label),
    );
    if (still) used.add(still.id);
    return { target, still, chosen: !still && chosen.has(key(target.label)) };
  });
}
