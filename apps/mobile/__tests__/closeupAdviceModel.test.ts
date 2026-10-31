import type { DetailStill } from '@scan-to-make/contracts';
import {
  adviceJob,
  distanceText,
  matchAdvice,
  parseCloseupAdvice,
  reasonText,
} from '../src/screens/closeupAdviceModel';
import {
  stillFrom,
  syntheticAdvice,
  syntheticJob,
  syntheticPhoto,
} from '../src/screens/testing/fakeScanServices';

const labelled = (label: string | undefined, ordinal: number): DetailStill => ({
  ...stillFrom(syntheticPhoto(), ordinal),
  ...(label ? { label } : {}),
});

test('advice.json targets are read best first, ignoring fields the app does not use', () => {
  const [first, second] = syntheticAdvice();
  expect(first).toEqual({
    rank: 1,
    label: 'Back (hinge side)',
    side: 'neg_y',
    reasonCode: 'inferred_fill',
    distanceMm: 250,
  });
  expect(second?.rank).toBe(2);
  expect(reasonText(first!)).toBe(
    'This side looks sparse in the scan. A close-up helps fill it in accurately.',
  );
  expect(distanceText(first!)).toBe('Start about 25 cm away');
  expect(distanceText({ ...first!, distanceMm: 4 })).toBe(
    'Start about 1 cm away',
  );
});

test('anything that is not version 1 advice is refused', () => {
  expect(() => parseCloseupAdvice({})).toThrow();
  expect(() =>
    parseCloseupAdvice({ closeupAdvice: { schemaVersion: 2, targets: [] } }),
  ).toThrow();
  expect(() =>
    parseCloseupAdvice({
      closeupAdvice: {
        schemaVersion: 1,
        targets: [{ rank: 1, label: 'Top', side: 'up', reasonCode: 'x' }],
      },
    }),
  ).toThrow();
});

test('close-ups match suggestions by label, each used once', () => {
  const [back, bottom] = syntheticAdvice();
  const stills = [
    labelled('  back  (HINGE side) ', 0),
    labelled('Back (hinge side)', 1),
    labelled('USB-C port', 2),
    labelled(undefined, 3),
  ];
  const matches = matchAdvice([back!, bottom!], stills);
  expect(matches.map(m => m.still?.ordinal)).toEqual([0, undefined]);
  expect(matches.map(m => m.chosen)).toEqual([false, false]);
});

test('a chosen photo not yet added marks its suggestion, an added one wins', () => {
  const [back, bottom] = syntheticAdvice();
  const matches = matchAdvice(
    [back!, bottom!],
    [labelled('Back (hinge side)', 0)],
    ['Back (hinge side)', 'Bottom (USB-C port)', ''],
  );
  expect(matches.map(m => [!!m.still, m.chosen])).toEqual([
    [true, false],
    [false, true],
  ]);
});

test('suggestions re-ranked by a new check keep their close-ups', () => {
  const [back, bottom] = syntheticAdvice();
  const stills = [labelled('Back (hinge side)', 0)];
  const rerun = [
    { ...bottom!, rank: 1 },
    { ...back!, rank: 2 },
  ];
  expect(matchAdvice(rerun, stills).map(m => m.still?.ordinal)).toEqual([
    undefined,
    0,
  ]);
});

test('advice comes from the remembered job when it has some, else any job with advice', () => {
  const file = {
    sha256: 'd'.repeat(64),
    byteLength: 10,
    mediaType: 'application/json' as const,
  };
  const withAdvice = (jobId: string, status: 'succeeded' | 'failed') => ({
    ...syntheticJob(status === 'succeeded' ? 'succeeded' : 'failed'),
    jobId,
    artifacts: { 'advice.json': file },
  });
  const plain = { ...syntheticJob('succeeded'), jobId: 'plain' };
  const failedWithAdvice = withAdvice('failed-advice', 'failed');
  const remembered = withAdvice('remembered', 'succeeded');
  expect(adviceJob([plain, failedWithAdvice, remembered], 'remembered')).toBe(
    remembered,
  );
  expect(adviceJob([plain, failedWithAdvice], 'plain')).toBe(failedWithAdvice);
  expect(adviceJob([plain], null)).toBeNull();
});

test('adviceJob shows the newest job with advice by createdAtMs', () => {
  const file = {
    sha256: 'd'.repeat(64),
    byteLength: 10,
    mediaType: 'application/json' as const,
  };
  const withAdvice = (jobId: string, createdAtMs: number) => ({
    ...syntheticJob('succeeded'),
    jobId,
    createdAtMs,
    artifacts: { 'advice.json': file },
  });
  const older = withAdvice('remembered', 1000);
  const newer = withAdvice('follow-up', 2000);
  expect(adviceJob([newer, older], 'remembered')).toBe(newer);
  expect(adviceJob([older, newer], 'remembered')).toBe(newer);
});
