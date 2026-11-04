import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CaptureCameraSchema, type CaptureCamera} from '@scan-to-make/contracts/reconstruction';

/** The capture-camera sidecar doesn't bind to this capture; the sentence says why. */
export class InvalidCaptureCameraError extends Error {
  constructor(message = "The camera information doesn't match these photos. Send the capture again from the phone that recorded it.") {
    super(message); this.name = 'InvalidCaptureCameraError';
  }
}

/** (width, height) from a JPEG SOF or PNG IHDR header, no decode. Mirrors schemas.py. */
export function imageDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && bytes.subarray(12, 16).toString('latin1') === 'IHDR')
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const length = bytes.readUInt16BE(i + 2);
      if (length < 2) break;
      i += 2 + length;
    }
  }
  return undefined;
}

/**
 * Strict capture-camera v1, bound to the exact saved capture photos: the frame
 * name set must equal the captured set, each SHA-256 must match the saved
 * bytes, each saved size must match, intrinsics must be plausible for that
 * saved size (the tool re-checks all of this). Returns the parsed document.
 */
export async function validateCaptureCamera(value: unknown, captureDir: string, captured: string[]): Promise<CaptureCamera> {
  const parsed = CaptureCameraSchema.safeParse(value);
  if (!parsed.success) throw new InvalidCaptureCameraError();
  const camera = parsed.data;
  const names = camera.frames.map(frame => frame.image);
  if (new Set(names).size !== names.length) throw new InvalidCaptureCameraError();
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...captured].sort()))
    throw new InvalidCaptureCameraError('The camera information is for different photos than the ones sent. Send the capture again from the phone that recorded it.');
  for (let offset = 0; offset < camera.frames.length; offset += 16) {
    await Promise.all(camera.frames.slice(offset, offset + 16).map(async frame => {
      const bytes = await readFile(join(captureDir, frame.image)).catch(() => undefined);
      if (!bytes || !bytes.length) throw new InvalidCaptureCameraError();
      if (createHash('sha256').update(bytes).digest('hex') !== frame.sha256)
        throw new InvalidCaptureCameraError('The camera information was recorded for different photo files. Send the capture again from the phone that recorded it.');
      const dimensions = imageDimensions(bytes);
      if (!dimensions || dimensions[0] !== frame.width || dimensions[1] !== frame.height)
        throw new InvalidCaptureCameraError('The camera information has the wrong photo size. Send the capture again from the phone that recorded it.');
      const diagonal = Math.hypot(frame.width, frame.height);
      if (!(frame.fx >= 0.05 * diagonal && frame.fx <= 20 * diagonal && frame.fy >= 0.05 * diagonal && frame.fy <= 20 * diagonal)
          || frame.cx < -0.25 * frame.width || frame.cx > 1.25 * frame.width
          || frame.cy < -0.25 * frame.height || frame.cy > 1.25 * frame.height
          || frame.center.some(c => Math.abs(c) > 1000))
        throw new InvalidCaptureCameraError();
    }));
  }
  return camera;
}

/** SHA-256 of the exact stored capture-camera.json bytes. */
export function captureCameraDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
