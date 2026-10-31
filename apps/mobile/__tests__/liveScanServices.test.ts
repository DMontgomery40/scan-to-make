import {
  bridgePhotoPicker,
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
