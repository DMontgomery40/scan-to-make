import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile, mkdir} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);
const SIPS = '/usr/bin/sips';
/** Longest photo edge sent to the model. Larger photos only cost time. */
export const MAX_PHOTO_EDGE = 2048;

export interface TouchupPass {
  dir: string;
  scanDir: string;
  scanPaths: string[];
  photosDir: string;
  photoPaths: string[];
  outDir: string;
  checkpointsDir: string;
}

export class NoPhotosError extends Error {
  constructor() { super('A touch-up needs at least one photo of the object.'); this.name = 'NoPhotosError'; }
}

async function longestEdge(path: string): Promise<number> {
  const {stdout} = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', path]);
  return Math.max(...[...stdout.matchAll(/pixel(?:Width|Height): (\d+)/g)].map(match => Number(match[1])));
}

/** Converts any photo the phone sends (HEIC included) to a JPEG the model can read, never upscaling it. */
async function writePhoto(source: string, target: string): Promise<void> {
  const resize = await longestEdge(source) > MAX_PHOTO_EDGE ? ['-Z', String(MAX_PHOTO_EDGE)] : [];
  await run(SIPS, ['-s', 'format', 'jpeg', ...resize, source, '--out', target]);
}

/**
 * One folder per touch-up pass holding only that pass's scan and photos.
 * The model's Blender session can read any file on disk, so nothing else may
 * sit next to its inputs.
 */
export async function prepareTouchupPass(input: {root: string; objectId: string; scan: string[]; photos: string[]; requirePhotos?: boolean}): Promise<TouchupPass> {
  // Photos are optional only when the user's instructions say what to make.
  if (input.photos.length === 0 && input.requirePhotos !== false) throw new NoPhotosError();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The worker runs inside the pass folder, so every path it is given must be absolute.
  const dir = join(resolve(input.root), input.objectId, `${stamp}-${randomUUID().slice(0, 8)}`);
  const scanDir = join(dir, 'scan'), photosDir = join(dir, 'photos'), outDir = join(dir, 'out'), checkpointsDir = join(outDir, 'checkpoints');
  for (const folder of [scanDir, photosDir, checkpointsDir]) await mkdir(folder, {recursive: true});
  const scanPaths: string[] = [];
  for (const file of input.scan) {
    const target = join(scanDir, basename(file));
    await copyFile(file, target);
    scanPaths.push(target);
  }
  const photoPaths: string[] = [];
  for (const [index, file] of input.photos.entries()) {
    const target = join(photosDir, `photo-${String(index + 1).padStart(2, '0')}.jpg`);
    await writePhoto(file, target);
    photoPaths.push(target);
  }
  return {dir, scanDir, scanPaths, photosDir, photoPaths, outDir, checkpointsDir};
}
