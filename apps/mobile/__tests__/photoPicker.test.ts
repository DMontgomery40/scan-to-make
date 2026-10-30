import { nativePhotoPicker } from '../src/ui/photoPicker';

const sha = 'ab'.repeat(32);

test('picked photos are checked before the screen sees them', async () => {
  const discard = jest.fn(async () => {});
  const picker = nativePhotoPicker({
    pick: async () => ({
      photos: [
        {
          sha256: sha,
          byteLength: 2048,
          mediaType: 'image/heic',
          uri: 'file:///app/DetailStillFiles/x.heic',
        },
        { sha256: 'nope', byteLength: 1, mediaType: 'image/png', uri: 'x' },
        {
          sha256: sha,
          byteLength: 10,
          mediaType: 'image/gif',
          uri: 'file:///x.gif',
        },
      ],
      rejected: [
        { reason: 'too-large', byteLength: 30_000_000 },
        { reason: 'mystery' },
      ],
    }),
    discard,
  })!;
  const { photos, rejected } = await picker.pick(3);
  expect(photos).toEqual([
    {
      sha256: sha,
      byteLength: 2048,
      mediaType: 'image/heic',
      uri: 'file:///app/DetailStillFiles/x.heic',
    },
  ]);
  expect(rejected).toEqual([
    { reason: 'unreadable' },
    { reason: 'unreadable' },
    { reason: 'too-large', byteLength: 30_000_000 },
    { reason: 'unreadable' },
  ]);
  await picker.discard(photos);
  // Only the file identity crosses back to native code.
  expect(discard).toHaveBeenCalledWith([
    { sha256: sha, byteLength: 2048, mediaType: 'image/heic' },
  ]);
});

test('there is no picker without the native module', () => {
  expect(nativePhotoPicker(undefined)).toBeNull();
});
