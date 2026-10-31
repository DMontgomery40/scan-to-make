import type {
  ScanArtifactName,
  ScanProcessingJob,
} from '@scan-to-make/contracts';
import type { SavedProject } from '@scan-to-make/contracts/saved-project';
import type { CaptureFile, CaptureState } from '../capture/retainedCaptures';
import type {
  Handoff,
  HandoffRecord,
  HandoffStatus,
} from '../printing/printerHandoff';
import type { Tone } from '../ui/components';
import { failureOf } from './scanServices';
import { jobCreatedOrder } from './scanResultsModel';

/**
 * What the Projects grid knows about one project. It is read without changing
 * anything on the phone or the Mac, so opening the app never sends a project.
 */
export type ProjectOverview = {
  /** Scans your Mac holds for this project, or null when they can't be read. */
  scans: number | null;
  /** Every cleanup job your Mac kept for this version's scans. */
  jobs: ScanProcessingJob[];
  /** Print jobs sent from this phone, as your Mac last reported them. */
  prints: { id: string; status: HandoffStatus; printing?: boolean }[];
  /** True when part of the status couldn't be read from your Mac. */
  partial?: boolean;
  /** Scans whose cleanup jobs or print couldn't be read this time. */
  unread?: { jobs: string[]; prints: string[] };
  /** A picture of the cleaned-up model, when there is one on this phone. */
  imageUri?: string | null;
  /** The cleanup the card's size and picture come from. */
  featured?: ScanProcessingJob;
};

export type ChipKind =
  | 'printing'
  | 'check-printer'
  | 'cleaning'
  | 'printed'
  | 'ready'
  | 'cleanup-failed'
  | 'not-cleaned'
  | 'not-scanned'
  | 'waiting';

export type Chip = { kind: ChipKind; label: string; tone: Tone };

const CHIPS: Record<ChipKind, Omit<Chip, 'kind'>> = {
  printing: { label: 'Printing', tone: 'accent' },
  'check-printer': { label: 'Check your printer', tone: 'accent' },
  cleaning: { label: 'Cleaning up', tone: 'pending' },
  printed: { label: 'Printed', tone: 'pass' },
  ready: { label: 'Ready to print', tone: 'pass' },
  'cleanup-failed': { label: 'Cleanup didn’t finish', tone: 'fail' },
  'not-cleaned': { label: 'Not cleaned up yet', tone: 'neutral' },
  'not-scanned': { label: 'Not scanned yet', tone: 'neutral' },
  waiting: { label: 'Waiting for your Mac', tone: 'neutral' },
};

const chip = (kind: ChipKind): Chip => ({ kind, ...CHIPS[kind] });

/** Statuses that change on your Mac by themselves, so the grid looks again. */
export const ACTIVE: ChipKind[] = ['cleaning', 'printing'];

/**
 * The one status a project card shows: the furthest along of everything the
 * phone can read today. Printing beats cleanup, a finished cleanup beats a
 * failed one, and an unknown status says it's waiting for your Mac.
 */
export function projectChip(overview: ProjectOverview | null): Chip {
  if (!overview || overview.scans === null) return chip('waiting');
  const { jobs, prints } = overview;
  if (prints.some(p => p.printing)) return chip('printing');
  if (prints.some(p => p.status === 'uncertain' && !p.printing)) {
    return chip('check-printer');
  }
  if (jobs.some(j => j.status === 'queued' || j.status === 'running')) {
    return chip('cleaning');
  }
  if (prints.some(p => p.status === 'printed')) return chip('printed');
  if (jobs.some(j => j.status === 'succeeded')) return chip('ready');
  if (jobs.some(j => j.status === 'failed')) return chip('cleanup-failed');
  if (overview.scans > 0) {
    // A scan whose cleanup status couldn't be read isn't "not cleaned up".
    return chip(overview.partial ? 'waiting' : 'not-cleaned');
  }
  return chip('not-scanned');
}

/**
 * A fresh read, with anything it couldn't read kept from the last one: jobs
 * by job id and prints by job, so what did load still shows.
 */
export function mergeOverview(
  previous: ProjectOverview | null,
  next: ProjectOverview | null,
): ProjectOverview | null {
  if (!next) return previous;
  if (!next.partial || !previous) return next;
  const lost = next.unread ?? { jobs: [], prints: [] };
  const jobIds = new Set(next.jobs.map(job => job.jobId));
  const printIds = new Set(next.prints.map(print => print.id));
  return {
    ...next,
    jobs: [
      ...next.jobs,
      ...previous.jobs.filter(
        job => lost.jobs.includes(job.captureId) && !jobIds.has(job.jobId),
      ),
    ],
    prints: [
      ...next.prints,
      ...previous.prints.filter(
        print => lost.prints.includes(print.id) && !printIds.has(print.id),
      ),
    ],
    // The old picture only while it's still of the featured cleanup.
    imageUri:
      next.imageUri ??
      (!next.featured || next.featured.jobId === previous.featured?.jobId
        ? previous.imageUri ?? null
        : null),
    ...(next.featured ?? previous.featured
      ? { featured: next.featured ?? previous.featured }
      : {}),
  };
}

/** The newest of these jobs by enqueue time (`createdAtMs`), as the results screen orders them. */
function newestOf(jobs: ScanProcessingJob[]): ScanProcessingJob | null {
  let best: ScanProcessingJob | null = null;
  for (const job of jobs)
    if (!best || jobCreatedOrder(job) > jobCreatedOrder(best)) best = job;
  return best;
}

/**
 * The finished cleanup a scan's card shows, matching the results screen: the
 * newest finished job, unless the one this phone followed is at least as new.
 * A follow-up correction (late close-ups) therefore replaces the first result.
 */
export function pickFinishedJob(
  jobs: ScanProcessingJob[],
  followed: string | null,
): ScanProcessingJob | null {
  const finished = jobs.filter(j => j.status === 'succeeded');
  const newest = newestOf(finished);
  const remembered = finished.find(j => j.jobId === followed) ?? null;
  if (newest && (!remembered || jobCreatedOrder(newest) > jobCreatedOrder(remembered))) return newest;
  return remembered ?? newest;
}

/**
 * The job whose size and picture a card shows: the one the loader chose,
 * else the newest finished cleanup, else the newest job that was measured.
 */
export function featuredJob(overview: ProjectOverview) {
  const { jobs } = overview;
  return (
    overview.featured ??
    pickFinishedJob(jobs, null) ??
    newestOf(jobs.filter(j => j.measuredBoxExtentsMm || j.measuredPrincipalExtentsMm)) ??
    null
  );
}

function extents(overview: ProjectOverview) {
  const job = featuredJob(overview);
  const mm = job?.measuredBoxExtentsMm ?? job?.measuredPrincipalExtentsMm;
  return mm ? [...mm].sort((a, b) => b - a).map(v => v.toFixed(1)) : null;
}

/** "72.8 × 59.0 × 46.6 mm", longest side first, or null before a cleanup. */
export function projectSize(overview: ProjectOverview | null) {
  const sides = overview ? extents(overview) : null;
  return sides ? `${sides.join(' × ')} mm` : null;
}

/** The size as VoiceOver reads it. */
export function spokenSize(overview: ProjectOverview | null) {
  const sides = overview ? extents(overview) : null;
  return sides ? `${sides.join(' by ')} millimetres` : null;
}

type Acknowledgment = { etag: string; snapshot: string };

/** Where the overview comes from. Every call here only reads. */
export type OverviewSource = {
  /** The scans this phone knows your Mac holds (CaptureClient.state). */
  state(projectId: string): Promise<CaptureState>;
  listJobs(
    projectId: string,
    captureId: string,
    ack: Acknowledgment,
  ): Promise<ScanProcessingJob[]>;
  /** The job this phone last followed for a scan, if any. */
  remembered?(projectId: string, captureId: string): Promise<string | null>;
  handoff(projectId: string, captureId: string): Promise<HandoffRecord | null>;
  printStatus?(
    projectId: string,
    captureId: string,
    ack: Acknowledgment,
    handoffId: string,
  ): Promise<Handoff>;
  downloadArtifact(
    projectId: string,
    captureId: string,
    ack: Acknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
  ): Promise<CaptureFile>;
  imageUri(file: CaptureFile): Promise<string | null>;
};

function unread(
  overview: ProjectOverview,
  part: 'jobs' | 'prints',
  captureId: string,
) {
  overview.partial = true;
  overview.unread ??= { jobs: [], prints: [] };
  overview.unread[part].push(captureId);
}

// The corner view the cleanup renders, used as the card's picture.
const PICTURE: ScanArtifactName = 'iso_pp.png';

/**
 * Reads one project's status without sending anything: it asks your Mac
 * only about project bytes your Mac already acknowledged, so looking at the
 * grid never uploads a project.
 */
export function projectOverviewLoader(source: OverviewSource) {
  return async (project: SavedProject): Promise<ProjectOverview> => {
    // If the scans can't be read at all (not paired, storage busy) this
    // rejects, and the grid keeps whatever it showed before.
    const state: CaptureState = await source.state(project.id);
    const overview: ProjectOverview = {
      scans: state.captures.length,
      jobs: [],
      prints: [],
    };
    const snapshot = JSON.stringify(project);
    if (!state.etag || state.snapshot !== snapshot) return overview;
    const ack = { etag: state.etag, snapshot };
    for (const capture of state.captures) {
      if (capture.binding.projectRevision !== project.revision) continue;
      const id = capture.captureId;
      try {
        // All of them: a finished cleanup still counts after a failed retry.
        const listed = await source.listJobs(project.id, id, ack);
        overview.jobs.push(...listed);
        // The cleanup the results screen shows (newest finished, see
        // pickFinishedJob). Scans are kept oldest first, so the newest scan's
        // choice is the one left at the end.
        const followed =
          (await source.remembered?.(project.id, id).catch(() => null)) ?? null;
        const pick = pickFinishedJob(listed, followed);
        if (pick) overview.featured = pick;
      } catch {
        unread(overview, 'jobs', id);
      }
      const record = await source.handoff(project.id, id).catch(() => {
        unread(overview, 'prints', id);
        return null;
      });
      // Prints are kept per scan: one send per scan at a time.
      if (record && 'uncertain' in record) {
        // A send whose reply was lost may already be printing; Print sorts it out.
        overview.prints.push({ id, status: 'uncertain', printing: false });
      } else if (record && 'handoffId' in record && source.printStatus) {
        try {
          const sent = await source.printStatus(
            project.id,
            id,
            ack,
            record.handoffId,
          );
          overview.prints.push({
            id,
            status: sent.status,
            ...(sent.printing !== undefined ? { printing: sent.printing } : {}),
          });
        } catch (error) {
          // A job your Mac no longer has isn't a print in progress.
          if (failureOf(error).status !== 404) unread(overview, 'prints', id);
        }
      }
    }
    // The picture is of the same cleanup the card's size comes from.
    const picture = featuredJob(overview);
    if (picture?.status === 'succeeded' && picture.artifacts?.[PICTURE]) {
      try {
        const file = await source.downloadArtifact(
          project.id,
          picture.captureId,
          ack,
          picture,
          PICTURE,
        );
        overview.imageUri = await source.imageUri(file);
      } catch {
        // The card keeps its plain stage.
      }
    }
    return overview;
  };
}
