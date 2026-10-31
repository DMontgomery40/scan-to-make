import type {
  AiTweakRecord,
  ScanArtifactName,
  ScanProcessingJob,
} from '@scan-to-make/contracts/scan-processing';
import { VIEW_ORDER } from './scanResultsModel';

/**
 * Compare versions (journey §3.5 and P4): the scan as captured, each AI try,
 * and the one picked, in the words the phone uses. Nothing here names files,
 * models or measurements.
 */
export type VersionKey = 'captured' | `attempt-${number}`;

export type VersionRow = {
  key: VersionKey;
  title: string;
  picked: boolean;
  /** One plain sentence: what this version is, or why it wasn't used. */
  note: string;
  /** A rendered picture of this version, when your Mac made one. */
  preview?: ScanArtifactName;
  /** What "Open in 3D" shows: the model you print, or the scan as captured. */
  open: 'model' | 'captured' | null;
};

export type CompareVersions = {
  /** One sentence for the card: which version you have and why. */
  summary: string;
  /** The reason in the comparer's own words, when it made the choice. */
  reason?: string;
  rows: VersionRow[];
};

type Attempt = AiTweakRecord['attempts'][number];

const PICKED_NOTE = 'This is the model you print.';

function notUsed(attempt: Attempt, pick: AiTweakRecord['pick']): string {
  switch (attempt.veto) {
    case 'smoothed':
      return 'Not used: it smoothed away detail your scan caught.';
    case 'squashed-or-stretched':
      return 'Not used: it changed the shape’s proportions.';
    case 'reshaped':
      return 'Not used: it changed the shape.';
    case 'unreadable':
      return 'Not used: it couldn’t be checked.';
  }
  switch (attempt.outcome) {
    case 'changed':
      // Only what the record establishes: a better match exists only when the comparer chose a try.
      // A fallback covers both "no comparison ran" and "the chosen try couldn't be prepared".
      if (pick.decidedBy !== 'judge') return 'Not used this time.';
      return pick.choice === 'captured'
        ? 'Not used: it wasn’t clearly closer to your photos.'
        : 'Not used: another try matched your photos better.';
    case 'unchanged':
      return 'It left the scan as it was.';
    case 'other-format-only':
    case 'invalid-output':
      return 'Not used: it didn’t make a model that could be checked.';
    case 'auth-failed':
      return 'Not used: it couldn’t sign in to your AI account.';
    case 'needs-gui-session':
      return 'Not used: it needs you to be logged in on your Mac.';
    case 'timed-out':
      return 'Not used: it ran out of time.';
    case 'cancelled':
      return 'Not used: it was stopped.';
    default:
      return 'Not used: it didn’t finish.';
  }
}

function summaryOf(ai: AiTweakRecord): string {
  const { choice, decidedBy } = ai.pick;
  if (choice !== 'captured')
    return `AI try ${choice.slice(
      'attempt-'.length,
    )} was closest to your photos.`;
  if (decidedBy === 'judge')
    return 'No AI try was clearly closer to your photos, so the scan as captured is kept.';
  // Your Mac reports both "every change was rejected" and "nothing changed" as a veto.
  if (decidedBy === 'veto' && !ai.attempts.some(a => a.outcome === 'changed'))
    return 'The AI tries left your scan as it was, so the scan as captured is kept.';
  if (decidedBy === 'veto')
    return 'None of the AI tries kept your scan’s detail, so the scan as captured is kept.';
  return 'The AI tries couldn’t be used this time, so the scan as captured is kept.';
}

/** Null unless the job finished with the AI step. */
export function compareVersions(
  job: ScanProcessingJob,
): CompareVersions | null {
  const ai = job.aiTweak;
  if (!ai || job.status !== 'succeeded') return null;
  const has = (name: ScanArtifactName) => !!job.artifacts?.[name];
  const choice = ai.pick.choice;
  // The job's own renders show whichever version it kept.
  const resultView = VIEW_ORDER.find(has);
  const rows: VersionRow[] = [
    {
      key: 'captured',
      title: 'The scan as captured',
      picked: choice === 'captured',
      note:
        choice === 'captured'
          ? PICKED_NOTE
          : 'Exactly as your phone scanned it, before any AI changes.',
      preview: choice === 'captured' ? resultView : undefined,
      open: choice === 'captured' ? 'model' : 'captured',
    },
  ];
  for (const attempt of [...ai.attempts].sort((a, b) => a.index - b.index)) {
    const key = `attempt-${attempt.index}` as const;
    const own = `ai-attempt-${attempt.index}-preview.png` as ScanArtifactName;
    const picked = choice === key;
    rows.push({
      key,
      title: `AI try ${attempt.index}`,
      picked,
      note: picked ? PICKED_NOTE : notUsed(attempt, ai.pick),
      preview: has(own) ? own : picked ? resultView : undefined,
      open: picked ? 'model' : null,
    });
  }
  return {
    summary: summaryOf(ai),
    // Only the comparer's own words; fallback and veto reasons are internal.
    reason: ai.pick.decidedBy === 'judge' ? ai.pick.reason : undefined,
    rows,
  };
}
