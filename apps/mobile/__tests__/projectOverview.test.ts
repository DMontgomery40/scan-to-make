import {
  featuredJob,
  mergeOverview,
  pickFinishedJob,
  projectChip,
  projectOverviewLoader,
  projectSize,
  spokenSize,
  type OverviewSource,
  type ProjectOverview,
} from '../src/screens/projectOverview';
import { syntheticJob } from '../src/screens/testing/fakeScanServices';

const job = (
  status: Parameters<typeof syntheticJob>[0],
  measured?: [number, number, number],
) => syntheticJob(status, measured ? { measured } : {});
const view = (over: Partial<ProjectOverview> = {}): ProjectOverview => ({
  scans: 1,
  jobs: [],
  prints: [],
  ...over,
});

test('each card shows exactly one status: the furthest along', () => {
  const cases: [ProjectOverview | null, string][] = [
    [null, 'Waiting for your Mac'],
    [view({ scans: null }), 'Waiting for your Mac'],
    [view({ scans: 0 }), 'Not scanned yet'],
    [view(), 'Not cleaned up yet'],
    [view({ partial: true }), 'Waiting for your Mac'],
    [view({ jobs: [job('failed')] }), 'Cleanup didn’t finish'],
    [view({ jobs: [job('failed'), job('succeeded')] }), 'Ready to print'],
    [view({ jobs: [job('succeeded'), job('running')] }), 'Cleaning up'],
    [view({ jobs: [job('queued')] }), 'Cleaning up'],
    [
      view({
        jobs: [job('succeeded')],
        prints: [{ id: 'p', status: 'printed' }],
      }),
      'Printed',
    ],
    [
      view({
        jobs: [job('running')],
        prints: [{ id: 'p', status: 'uncertain', printing: false }],
      }),
      'Check your printer',
    ],
    [
      view({
        jobs: [job('succeeded')],
        prints: [{ id: 'p', status: 'uncertain', printing: true }],
      }),
      'Printing',
    ],
    [
      view({ prints: [{ id: 'p', status: 'sliced', printing: true }] }),
      'Printing',
    ],
  ];
  for (const [overview, label] of cases) {
    expect(projectChip(overview).label).toBe(label);
  }
});

test('the size is the finished cleanup’s box, longest side first', () => {
  const finished = view({
    jobs: [job('running', [1, 2, 3]), job('succeeded', [46.6, 72.76, 59.02])],
  });
  expect(projectSize(finished)).toBe('72.8 × 59.0 × 46.6 mm');
  expect(spokenSize(finished)).toBe('72.8 by 59.0 by 46.6 millimetres');
  expect(projectSize(view())).toBeNull();
  expect(projectSize(null)).toBeNull();
});

const PROJECT = {
  formatVersion: '0.2.0',
  id: 'thing',
  revision: 0,
  brief: { object: 'Thing', context: '', addition: '' },
  fit: null,
  preview: null,
  acceptedArtifact: null,
} as const;
const capture = (captureId: string, projectRevision = 0) =>
  ({
    captureId,
    binding: { projectId: 'thing', projectRevision },
  } as never);

function source(over: Partial<OverviewSource> = {}) {
  const calls: string[] = [];
  const base: OverviewSource = {
    state: async () => ({
      etag: '"e"',
      snapshot: JSON.stringify(PROJECT),
      captures: [capture('a'), capture('b'), capture('c')],
    }),
    listJobs: async (_p, c) => {
      calls.push(`jobs ${c}`);
      return c === 'b'
        ? [{ ...job('succeeded', [10, 20, 30]), captureId: c }]
        : [];
    },
    handoff: async () => null,
    downloadArtifact: async (_p, c, _a, _j, name) => {
      calls.push(`download ${c} ${name}`);
      return { sha256: 'f'.repeat(64), byteLength: 1, mediaType: 'image/png' };
    },
    imageUri: async () => 'file:///iso.png',
    ...over,
  };
  return { source: base, calls };
}

test('the overview reads every scan of the current version and never sends the project', async () => {
  const { source: s, calls } = source();
  const overview = await projectOverviewLoader(s)(PROJECT as never);
  expect(overview).toMatchObject({ scans: 3, imageUri: 'file:///iso.png' });
  expect(projectChip(overview).label).toBe('Ready to print');
  expect(projectSize(overview)).toBe('30.0 × 20.0 × 10.0 mm');
  expect(calls).toEqual([
    'jobs a',
    'jobs b',
    'jobs c',
    'download b iso_pp.png',
  ]);
});

test('a project changed since your Mac saw it, or an unreadable pairing, asks nothing', async () => {
  const changed = source({
    state: async () => ({
      etag: '"e"',
      snapshot: '{"older":true}',
      captures: [capture('a')],
    }),
  });
  const overview = await projectOverviewLoader(changed.source)(
    PROJECT as never,
  );
  expect(changed.calls).toEqual([]);
  expect(projectChip(overview).label).toBe('Not cleaned up yet');
  const unpaired = source({
    state: async () => {
      throw Error('Connect your companion');
    },
  });
  await expect(
    projectOverviewLoader(unpaired.source)(PROJECT as never),
  ).rejects.toThrow();
  // The grid then keeps its last status, or waits when it has none.
  expect(mergeOverview(null, null)).toBeNull();
  expect(projectChip(null).label).toBe('Waiting for your Mac');
});

test('scans of an earlier version are counted but not asked about', async () => {
  const { source: s, calls } = source({
    state: async () => ({
      etag: '"e"',
      snapshot: JSON.stringify(PROJECT),
      captures: [capture('older', 1 as never)],
    }),
  });
  const overview = await projectOverviewLoader(s)(PROJECT as never);
  expect(calls).toEqual([]);
  expect(overview.scans).toBe(1);
});

test('an unreachable Mac shows as waiting; a print your Mac no longer has is ignored', async () => {
  const unreachable = source({
    listJobs: async () => {
      throw Object.assign(Error('lost'), { code: 'network' });
    },
  });
  expect(
    projectChip(
      await projectOverviewLoader(unreachable.source)(PROJECT as never),
    ).label,
  ).toBe('Waiting for your Mac');
  const printed = source({
    handoff: async (_p, c) => (c === 'a' ? { handoffId: 'h-a' } : null),
    printStatus: async () => ({
      id: 'h-a',
      backend: 'bambu-printer-mcp',
      status: 'printed',
      printing: false,
    }),
  });
  expect(
    projectChip(await projectOverviewLoader(printed.source)(PROJECT as never))
      .label,
  ).toBe('Printed');
  const gone = source({
    handoff: async () => ({ handoffId: 'h' }),
    printStatus: async () => {
      throw Object.assign(Error('gone'), { status: 404 });
    },
  });
  const overview = await projectOverviewLoader(gone.source)(PROJECT as never);
  expect(overview.partial).toBeUndefined();
  expect(projectChip(overview).label).toBe('Ready to print');
});

test('a finished cleanup still counts after a later failed retry of the same scan', async () => {
  const { source: s } = source({
    listJobs: async (_p, c) =>
      c === 'a'
        ? [
            syntheticJob('succeeded', { measured: [1, 2, 3] }),
            syntheticJob('failed', {
              jobId: '6f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607',
            }),
          ]
        : [],
  });
  const overview = await projectOverviewLoader(s)(PROJECT as never);
  expect(projectChip(overview).label).toBe('Ready to print');
  expect(projectSize(overview)).toBe('3.0 × 2.0 × 1.0 mm');
  expect(overview.imageUri).toBe('file:///iso.png');
});

test('a send whose reply was lost shows as check your printer, not ready to print', async () => {
  const { source: s } = source({
    handoff: async (_p, c) =>
      c === 'b'
        ? {
            uncertain: {
              startedAtMs: 1,
              prompt: '',
              backend: null,
              model: 'a'.repeat(64),
            },
          }
        : null,
  });
  const overview = await projectOverviewLoader(s)(PROJECT as never);
  expect(projectChip(overview).label).toBe('Check your printer');
});

test('a partial read keeps only what it couldn’t read from last time', () => {
  const running = syntheticJob('running');
  const other = syntheticJob('running', {
    jobId: '6f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f608',
  });
  const previous = view({
    jobs: [running, other],
    prints: [{ id: 'h', status: 'sliced', printing: true }],
  });
  // One scan's cleanup finished; the other scan's reply was lost.
  const next = view({
    jobs: [{ ...running, status: 'succeeded' } as never],
    prints: [{ id: 'h', status: 'printed', printing: false }],
    partial: true,
  });
  const merged = mergeOverview(previous, {
    ...next,
    unread: { jobs: [other.captureId], prints: [] },
  })!;
  expect(merged.jobs.map(j => j.status).sort()).toEqual([
    'running',
    'succeeded',
  ]);
  // Only scans whose read failed keep their old state; a gone print stays gone.
  const gone = mergeOverview(previous, {
    ...view({ prints: [] }),
    partial: true,
    unread: { jobs: ['x'], prints: [] },
  })!;
  expect(gone.prints).toEqual([]);
  expect(merged.prints).toEqual([
    { id: 'h', status: 'printed', printing: false },
  ]);
  expect(mergeOverview(previous, null)).toBe(previous);
  const complete = view({ jobs: [] });
  expect(mergeOverview(previous, complete)).toBe(complete);
});

test('size and picture come from the newest scan’s finished cleanup', async () => {
  const { source: s2, calls } = source({
    listJobs: async (_p, c) =>
      c === 'a' || c === 'c'
        ? [
            {
              ...syntheticJob('succeeded', {
                measured: c === 'a' ? [1, 1, 1] : [9, 8, 7],
              }),
              captureId: c,
            },
          ]
        : [],
  });
  const overview = await projectOverviewLoader(s2)(PROJECT as never);
  expect(projectSize(overview)).toBe('9.0 × 8.0 × 7.0 mm');
  expect(calls).toContain('download c iso_pp.png');
});

test('a print record that can’t be read marks the status as incomplete', async () => {
  const { source: s2 } = source({
    handoff: async () => {
      throw Error('storage');
    },
  });
  const overview = await projectOverviewLoader(s2)(PROJECT as never);
  expect(overview.partial).toBe(true);
});

test('the picture is of the same cleanup the size comes from', async () => {
  const first = syntheticJob('succeeded', { measured: [1, 1, 1] });
  const second = syntheticJob('succeeded', {
    jobId: '6f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f609',
    measured: [9, 8, 7],
  });
  let pictured: string | null = null;
  const { source: s2 } = source({
    listJobs: async (_p, c) => (c === 'a' ? [first, second] : []),
    downloadArtifact: async (_p, _c, _a, featured) => {
      pictured = featured.jobId;
      return { sha256: 'f'.repeat(64), byteLength: 1, mediaType: 'image/png' };
    },
  });
  const overview = await projectOverviewLoader(s2)(PROJECT as never);
  expect(projectSize(overview)).toBe('1.0 × 1.0 × 1.0 mm');
  expect(pictured).toBe(first.jobId);
  // The cleanup this phone followed wins, for both.
  const followed = source({
    listJobs: async (_p, c) => (c === 'a' ? [first, second] : []),
    remembered: async () => second.jobId,
    downloadArtifact: async (_p, _c, _a, featured) => {
      pictured = featured.jobId;
      return { sha256: 'f'.repeat(64), byteLength: 1, mediaType: 'image/png' };
    },
  });
  const chosen = await projectOverviewLoader(followed.source)(PROJECT as never);
  expect(projectSize(chosen)).toBe('9.0 × 8.0 × 7.0 mm');
  expect(pictured).toBe(second.jobId);
});

test('a kept picture never goes with a different cleanup', () => {
  const a = syntheticJob('succeeded', { measured: [1, 1, 1] });
  const b = syntheticJob('succeeded', {
    jobId: '6f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f60a',
    measured: [9, 8, 7],
  });
  const previous = view({ jobs: [a], featured: a, imageUri: 'file:///a.png' });
  const switched = mergeOverview(previous, {
    ...view({ jobs: [a, b], featured: b }),
    partial: true,
    unread: { jobs: [], prints: ['x'] },
  })!;
  expect(switched.imageUri).toBeNull();
  const same = mergeOverview(previous, {
    ...view({ jobs: [a], featured: a }),
    partial: true,
    unread: { jobs: [], prints: ['x'] },
  })!;
  expect(same.imageUri).toBe('file:///a.png');
});

test('a scan card shows the newest finished cleanup, so a follow-up correction replaces the first result', () => {
  const at = (jobId: string, createdAtMs: number) => ({
    ...syntheticJob('succeeded', { jobId }),
    createdAtMs,
  });
  // Random job ids: the follow-up's id sorts before the first job's.
  const first = at('99999999-9999-4999-8999-999999999999', 1000);
  const followUp = at('11111111-1111-4111-8111-111111111111', 2000);
  expect(pickFinishedJob([first, followUp], null)?.jobId).toBe(followUp.jobId);
  // Even when the phone last followed the first job.
  expect(pickFinishedJob([first, followUp], first.jobId)?.jobId).toBe(followUp.jobId);
  // A followed job that is the newest stays.
  expect(pickFinishedJob([first, followUp], followUp.jobId)?.jobId).toBe(followUp.jobId);
  // Unfinished jobs are never picked.
  const running = { ...syntheticJob('running', { jobId: '22222222-2222-4222-8222-222222222222' }), createdAtMs: 3000 };
  expect(pickFinishedJob([first, running], null)?.jobId).toBe(first.jobId);
  expect(featuredJob(view({ jobs: [first, followUp] }))?.jobId).toBe(followUp.jobId);
});
