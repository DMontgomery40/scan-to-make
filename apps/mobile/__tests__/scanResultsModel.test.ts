import {
  chooseJob,
  closeness,
  compare,
  describeDifference,
  parseMm,
  parseReference,
  snapshotRevision,
} from '../src/screens/scanResultsModel';
import { syntheticJob } from '../src/screens/testing/fakeScanServices';

const errors = (e: [number, number, number]) =>
  closeness({ measured: [1, 1, 1], reference: [1, 1, 1], errors: e });

test('closeness tiers follow the worst side and its direction', () => {
  expect(errors([0.5, -0.2, 0]).label).toBe('Very close');
  expect(errors([0.51, 1.5, 0]).label).toBe('Close');
  const loose = errors([0.1, 2.2, -0.3]);
  expect(loose).toMatchObject({ label: 'Somewhat off', tone: 'pending' });
  expect(loose.summary).toBe(
    'The middle side is 2.2 mm larger than the real size.',
  );
  expect(loose.advice).toContain('loosely');
  expect(errors([0, 0, -2.5]).advice).toContain('too tight');
  expect(errors([-3.01, 0, 0])).toMatchObject({
    label: 'Noticeably off',
    tone: 'fail',
    summary: 'The longest side is 3.0 mm smaller than the real size.',
  });
});

test('differences read plainly and round tiny ones to a match', () => {
  expect(describeDifference(2.32)).toEqual({
    short: '+2.3 mm',
    words: '2.3 mm larger',
  });
  expect(describeDifference(-0.46).words).toBe('0.5 mm smaller');
  expect(describeDifference(0.04)).toEqual({
    short: '0.0 mm',
    words: 'matches',
  });
});

test('real sizes accept commas and any order, and reject other text', () => {
  expect(parseMm(' 45,2 ')).toBe(45.2);
  expect(parseMm('.5')).toBe(0.5);
  for (const bad of ['', '-3', '1e3', '12mm', 'abc']) {
    expect(parseMm(bad)).toBeNaN();
  }
  expect(parseReference({ sizes: ['', '', ''], name: ' ' })).toEqual({
    state: 'empty',
  });
  expect(parseReference({ sizes: ['0', '45', ''], name: '' })).toMatchObject({
    state: 'invalid',
    errors: ['Use a number of millimetres, like 45.2', null, 'Enter a size'],
  });
  const valid = parseReference({
    sizes: ['21.7', '60.6', '45.2'],
    name: ' Case ',
    source: 'Apple published specifications',
  });
  expect(valid).toEqual({
    state: 'valid',
    reference: {
      dimensionsMm: [21.7, 60.6, 45.2],
      productName: 'Case',
      source: 'Apple published specifications',
    },
  });
  const job = syntheticJob('succeeded', { measured: [21.7, 62.9, 48.7] });
  const result = compare(
    job,
    valid.state === 'valid' ? valid.reference : null,
  )!;
  // Matched longest to shortest, as the companion does.
  expect(result.reference).toEqual([60.6, 45.2, 21.7]);
  expect(result.measured).toEqual([62.9, 48.7, 21.7]);
  expect(result.errors.map(e => Number(e.toFixed(1)))).toEqual([2.3, 3.5, 0]);
});

test('chooseJob shows the newest job by createdAtMs, so follow-ups win', () => {
  const ORIGINAL = '22222222-2222-4222-8222-222222222222';
  const FOLLOW_UP = '11111111-1111-4111-8111-111111111111';
  const at = (
    status: Parameters<typeof syntheticJob>[0],
    jobId: string,
    createdAtMs?: number,
  ) => ({ ...syntheticJob(status, { jobId }), createdAtMs });
  const original = at('succeeded', ORIGINAL, 1000);
  const followUp = at('succeeded', FOLLOW_UP, 2000);
  // The list is in ascending job-id order; listing order is not start order.
  const listed = [followUp, original].sort((a, b) =>
    a.jobId.localeCompare(b.jobId),
  );
  // A newer finished follow-up beats the remembered original on reopen.
  expect(chooseJob(listed, ORIGINAL)).toBe(followUp);
  // The newest active job wins while work is still running.
  const queuedFollowUp = at('queued', FOLLOW_UP, 2000);
  expect(chooseJob([original, queuedFollowUp], ORIGINAL)).toBe(
    queuedFollowUp,
  );
  // Without timestamps, the remembered job keeps its old preference.
  const legacyA = at('succeeded', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const legacyB = at('succeeded', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  expect(chooseJob([legacyB, legacyA], legacyA.jobId)).toBe(legacyA);
  expect(chooseJob([], null)).toBeNull();
});

test('snapshot revisions are read safely', () => {
  expect(snapshotRevision('{"revision":4}')).toBe(4);
  expect(snapshotRevision('{"revision":"4"}')).toBeNull();
  expect(snapshotRevision('not json')).toBeNull();
});
