import { compareVersions } from '../src/screens/compareVersionsModel';
import { syntheticJob } from '../src/screens/testing/fakeScanServices';

const access = { kind: 'codex-cli' as const };
const words = (v: ReturnType<typeof compareVersions>) =>
  v ? [v.summary, ...v.rows.flatMap(r => [r.title, r.note])].join('\n') : '';
// Journey §9: nothing technical reaches David.
const TECHNICAL =
  /\b(mesh|obj|stl|veto|judge|attempt|median|job|companion|mm|fallback|captured surface)\b/i;

test('only a finished AI result has versions', () => {
  expect(compareVersions(syntheticJob('succeeded'))).toBeNull();
  expect(
    compareVersions(
      syntheticJob('running', {
        aiTweak: {
          access,
          attempts: [],
          pick: { choice: 'captured', decidedBy: 'fallback', reason: 'x' },
        },
      }),
    ),
  ).toBeNull();
});

test('a picked try is the model you print; the scan as captured stays one tap away', () => {
  const reason =
    'B gives the eyes more rounded relief and smooths the lumpy sign; both keep the stitches.';
  const v = compareVersions(
    syntheticJob('succeeded', {
      previews: [2],
      aiTweak: {
        access,
        attempts: [
          { index: 2, outcome: 'changed', wallMs: 1 },
          { index: 1, outcome: 'changed', wallMs: 1, veto: 'smoothed' },
        ],
        pick: { choice: 'attempt-2', decidedBy: 'judge', reason },
      },
    }),
  )!;
  expect(v.summary).toBe('AI try 2 was closest to your photos.');
  expect(v.reason).toBe(reason);
  expect(
    v.rows.map(r => [r.title, r.picked, r.open, r.preview ?? null]),
  ).toEqual([
    ['The scan as captured', false, 'captured', null],
    ['AI try 1', false, null, null],
    ['AI try 2', true, 'model', 'ai-attempt-2-preview.png'],
  ]);
  expect(v.rows[1]!.note).toBe(
    'Not used: it smoothed away detail your scan caught.',
  );
  expect(v.rows[2]!.note).toBe('This is the model you print.');
  expect(words(v)).not.toMatch(TECHNICAL);
});

test('when the scan as captured is kept, its own renders show it and internal reasons stay hidden', () => {
  const internal =
    'Every attempt was rejected: attempt-1 the captured surface moved a median 0.060 mm, as smoothing does.';
  const v = compareVersions(
    syntheticJob('succeeded', {
      aiTweak: {
        access,
        attempts: [
          {
            index: 1,
            outcome: 'changed',
            wallMs: 1,
            veto: 'squashed-or-stretched',
          },
          { index: 2, outcome: 'auth-failed', wallMs: 1 },
          { index: 3, outcome: 'timed-out', wallMs: 1 },
          { index: 4, outcome: 'unchanged', wallMs: 1 },
        ],
        pick: { choice: 'captured', decidedBy: 'veto', reason: internal },
      },
    }),
  )!;
  expect(v.summary).toBe(
    'None of the AI tries kept your scan’s detail, so the scan as captured is kept.',
  );
  expect(v.reason).toBeUndefined();
  expect(v.rows[0]).toMatchObject({
    picked: true,
    open: 'model',
    preview: 'iso_pp.png',
    note: 'This is the model you print.',
  });
  expect(v.rows.slice(1).map(r => r.note)).toEqual([
    'Not used: it changed the shape’s proportions.',
    'Not used: it couldn’t sign in to your AI account.',
    'Not used: it ran out of time.',
    'It left the scan as it was.',
  ]);
  expect(words(v)).not.toMatch(TECHNICAL);
});

test('a comparison that could not run says so plainly', () => {
  const v = compareVersions(
    syntheticJob('succeeded', {
      aiTweak: {
        access,
        attempts: [{ index: 1, outcome: 'changed', wallMs: 1 }],
        pick: {
          choice: 'captured',
          decidedBy: 'fallback',
          reason: 'The visual pick could not run.',
        },
      },
    }),
  )!;
  expect(v.summary).toBe(
    'The AI tries couldn’t be used this time, so the scan as captured is kept.',
  );
  expect(v.reason).toBeUndefined();
  expect(v.rows[1]!.note).toBe('Not used this time.');
});

test('tries that changed nothing are described as such, not as rejected', () => {
  const v = compareVersions(
    syntheticJob('succeeded', {
      aiTweak: {
        access,
        attempts: [
          { index: 1, outcome: 'unchanged', wallMs: 1 },
          { index: 2, outcome: 'unchanged', wallMs: 1 },
        ],
        pick: {
          choice: 'captured',
          decidedBy: 'veto',
          reason: 'No attempt changed the scan.',
        },
      },
    }),
  )!;
  expect(v.summary).toBe(
    'The AI tries left your scan as it was, so the scan as captured is kept.',
  );
  expect(v.rows.slice(1).map(r => r.note)).toEqual([
    'It left the scan as it was.',
    'It left the scan as it was.',
  ]);
});

test('when the comparer keeps the scan as captured, nothing claims a closer match', () => {
  const v = compareVersions(
    syntheticJob('succeeded', {
      aiTweak: {
        access,
        attempts: [
          { index: 1, outcome: 'changed', wallMs: 1 },
          { index: 2, outcome: 'changed', wallMs: 1 },
        ],
        pick: {
          choice: 'captured',
          decidedBy: 'judge',
          reason: 'No candidate is clearly closer.',
        },
      },
    }),
  )!;
  expect(v.summary).toBe(
    'No AI try was clearly closer to your photos, so the scan as captured is kept.',
  );
  expect(v.rows.slice(1).map(r => r.note)).toEqual([
    'Not used: it wasn’t clearly closer to your photos.',
    'Not used: it wasn’t clearly closer to your photos.',
  ]);
  expect(v.reason).toBe('No candidate is clearly closer.');
});

test('the other try is described against the picked one', () => {
  const v = compareVersions(
    syntheticJob('succeeded', {
      aiTweak: {
        access,
        attempts: [
          { index: 1, outcome: 'changed', wallMs: 1 },
          { index: 2, outcome: 'changed', wallMs: 1 },
        ],
        pick: {
          choice: 'attempt-1',
          decidedBy: 'judge',
          reason: 'A keeps the stitches.',
        },
      },
    }),
  )!;
  expect(v.rows[2]!.note).toBe(
    'Not used: another try matched your photos better.',
  );
});
