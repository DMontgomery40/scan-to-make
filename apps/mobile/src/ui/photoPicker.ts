import { NativeModules } from 'react-native';
import type {
  PhotoPicker,
  PickedPhoto,
  RejectedPhoto,
} from '../screens/scanServices';

type Native = {
  pick(limit: number): Promise<{ photos: unknown[]; rejected: unknown[] }>;
  discard(files: unknown[]): Promise<void>;
};
const MEDIA = ['image/jpeg', 'image/heic', 'image/png'];
const REASONS = ['too-large', 'unsupported', 'unreadable'];

function photo(value: unknown): PickedPhoto | null {
  const v = value as Partial<PickedPhoto>;
  return typeof v?.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    Number.isSafeInteger(v.byteLength) &&
    (v.byteLength ?? 0) > 0 &&
    typeof v.mediaType === 'string' &&
    MEDIA.includes(v.mediaType) &&
    typeof v.uri === 'string' &&
    v.uri.startsWith('file://')
    ? {
        sha256: v.sha256,
        byteLength: v.byteLength!,
        mediaType: v.mediaType,
        uri: v.uri,
      }
    : null;
}

/**
 * The iOS system photo picker (STMPhotoPicker). Chosen photos are copied by
 * identity into Application Support/DetailStillFiles/<sha256>.<ext>, where a
 * detail-still upload can read the exact bytes. Returns null off iOS.
 */
export function nativePhotoPicker(
  native: Native | undefined = NativeModules.STMPhotoPicker,
): PhotoPicker | null {
  if (!native) return null;
  return {
    async pick(limit) {
      const result = await native.pick(limit);
      const photos: PickedPhoto[] = [];
      const rejected: RejectedPhoto[] = [];
      for (const item of result?.photos ?? []) {
        const parsed = photo(item);
        if (parsed) photos.push(parsed);
        else rejected.push({ reason: 'unreadable' });
      }
      for (const item of result?.rejected ?? []) {
        const r = item as Partial<RejectedPhoto>;
        rejected.push({
          reason: REASONS.includes(r?.reason as string)
            ? (r.reason as RejectedPhoto['reason'])
            : 'unreadable',
          ...(Number.isSafeInteger(r?.byteLength)
            ? { byteLength: r.byteLength }
            : {}),
        });
      }
      return { photos, rejected };
    },
    discard: files =>
      native.discard(
        files.map(({ sha256, byteLength, mediaType }) => ({
          sha256,
          byteLength,
          mediaType,
        })),
      ),
  };
}
