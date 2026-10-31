import {
  bridgePhotoPicker,
  closeupAdviceLoader,
  liveScanServices,
} from '../src/screens/liveScanServices';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';

const photo = {
  sha256: 'e'.repeat(64),
  byteLength: 4096,
  mediaType: 'image/jpeg',
  uri: 'file:///app/ScanMediaFiles/e.jpg',
};
const bridge = (extra: object) =>
  ({
    context: async () => 'host|device',
    request: async () => ({ status: 500, body: '', etag: '' }),
    present: async () => {},
    cancel: async () => {},
    ...extra,
  } as unknown as Parameters<typeof bridgePhotoPicker>[0]);

test('the camera-roll picker passes photos and per-photo rejections through', async () => {
  const pickImages = jest.fn(async () => ({
    photos: [photo],
    rejected: [
      { reason: 'unsupported' as const },
      { reason: 'mystery' as never, byteLength: 12 },
    ],
  }));
  const picker = bridgePhotoPicker(bridge({ pickImages }));
  expect(await picker.pick(7)).toEqual({
    photos: [photo],
    rejected: [
      { reason: 'unsupported' },
      { reason: 'unreadable', byteLength: 12 },
    ],
  });
  expect(pickImages).toHaveBeenCalledWith(7);
});

test('without the camera-roll picker, one photo at a time still works', async () => {
  const single = bridgePhotoPicker(
    bridge({ pickImage: async () => ({ ...photo, uri: undefined }) }),
  );
  expect((await single.pick(5)).photos).toHaveLength(1);
  const cancelled = bridgePhotoPicker(
    bridge({
      pickImage: async () => {
        throw Object.assign(Error('cancelled'), { code: 'cancelled' });
      },
    }),
  );
  expect(await cancelled.pick(5)).toEqual({ photos: [], rejected: [] });
});

test('live services expose verified render URIs only through the client', async () => {
  const repo = createSavedProjects({
    listIds: async () => [],
    read: async () => null,
    compareAndSwap: async () => false,
  });
  const imageUri = jest.fn(async () => 'file:///app/ScanMediaFiles/view.png');
  const services = liveScanServices(repo, {
    StillsProcessingBridge: bridge({ imageUri }),
    RetainedCaptureBridge: {} as never,
  });
  const png = { sha256: 'a'.repeat(64), byteLength: 9, mediaType: 'image/png' };
  expect(await services.imageUri!(png)).toBe(
    'file:///app/ScanMediaFiles/view.png',
  );
  // Non-PNG files are never shown as images.
  expect(
    await services.imageUri!({ ...png, mediaType: 'model/stl' }),
  ).toBeNull();
  expect(typeof services.processing.listJobs).toBe('function');
  expect(typeof services.stills.imageUri).toBe('function');
});

test('close-up advice is read from the cleanup job, with each suggestion picture', async () => {
  const { syntheticJob } = require('../src/screens/testing/fakeScanServices');
  const ref = (c: string, mediaType: string) => ({
    sha256: c.repeat(64),
    byteLength: 9,
    mediaType,
  });
  const job = {
    ...syntheticJob('succeeded'),
    jobId: 'cleanup',
    artifacts: {
      'advice.json': ref('a', 'application/json'),
      'advice-01.png': ref('b', 'image/png'),
      'advice-02.png': ref('c', 'image/png'),
    },
  };
  const target = (rank: number, label: string) => ({
    rank,
    label,
    side: 'neg_y',
    reasonCode: 'inferred_fill',
    reason: 'x',
    viewDirection: [0, 0, 1],
    targetMm: [0, 0, 0],
    distanceMm: 200,
    expectedBenefitScore: 50,
    regionBoundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
    evidence: { method: 'm', faces: 1, heuristic: true },
    render: {
      path: `renders/target-0${rank}.png`,
      sha256: 'e'.repeat(64),
      containsTexture: false,
    },
    labelSource: 'caller',
  });
  const advice = JSON.stringify({
    closeupAdvice: {
      schemaVersion: 1,
      targets: [target(1, 'Back'), target(2, 'Bottom'), target(3, 'Left end')],
    },
  });
  const downloads: string[] = [];
  const loader = closeupAdviceLoader({
    listJobs: async () => [{ ...syntheticJob('succeeded'), jobId: 'old' }, job],
    downloadArtifact: async (_p, _c, _a, _j, name) => {
      downloads.push(name);
      if (name === 'advice-02.png') throw Error('companion busy');
      return { ...ref(name === 'advice.json' ? 'a' : 'b', 'x'), name } as never;
    },
    readJson: async () => advice,
    imageUri: async () => 'file:///cache/advice-01.png',
    remembered: async () => null,
  });
  const ack = { etag: '"1"', snapshot: 's' };
  const targets = await loader.load('p', 'c', ack);
  expect(targets?.map(t => [t.label, t.imageUri ?? null])).toEqual([
    ['Back', 'file:///cache/advice-01.png'],
    ['Bottom', null],
    ['Left end', null],
  ]);
  expect(downloads).toEqual(['advice.json', 'advice-01.png', 'advice-02.png']);
  const none = closeupAdviceLoader({
    listJobs: async () => [syntheticJob('succeeded')],
    downloadArtifact: async () => {
      throw Error('unused');
    },
    readJson: async () => '',
    imageUri: async () => null,
    remembered: async () => null,
  });
  expect(await none.load('p', 'c', ack)).toBeNull();
});

test('an unreadable advice.json fails the load without fetching any picture', async () => {
  const { syntheticJob } = require('../src/screens/testing/fakeScanServices');
  const ref = (c: string, mediaType: string) => ({
    sha256: c.repeat(64),
    byteLength: 9,
    mediaType,
  });
  const job = {
    ...syntheticJob('succeeded'),
    jobId: 'cleanup',
    artifacts: {
      'advice.json': ref('a', 'application/json'),
      'advice-01.png': ref('b', 'image/png'),
    },
  };
  const ack = { etag: '"1"', snapshot: 's' };
  for (const text of [
    '{not json',
    JSON.stringify({ closeupAdvice: { schemaVersion: 1, targets: [{}] } }),
    JSON.stringify({ advice: [] }),
  ]) {
    const downloads: string[] = [];
    const loader = closeupAdviceLoader({
      listJobs: async () => [job],
      downloadArtifact: async (_p, _c, _a, _j, name) => {
        downloads.push(name);
        return { ...ref('a', 'x'), name } as never;
      },
      readJson: async () => text,
      imageUri: async () => 'file:///cache/advice-01.png',
      remembered: async () => 'cleanup',
    });
    await expect(loader.load('p', 'c', ack)).rejects.toThrow();
    expect(downloads).toEqual(['advice.json']);
  }
});
