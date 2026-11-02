import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, readFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

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
  /** Numbered, uncropped sheets covering every photo, in the same order. */
  photoOverviewPaths: string[];
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

/** macOS converts photos with sips; elsewhere (a Linux companion) JPEG and PNG are used as they are. */
export type PhotoTool = 'sips' | 'copy';
const DEFAULT_PHOTO_TOOL: PhotoTool = existsSync(SIPS) ? 'sips' : 'copy';

function photoKind(bytes: Buffer): 'jpg' | 'png' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return undefined;
}

/**
 * Converts any photo the phone sends (HEIC included) to a JPEG the model can read, never upscaling it.
 * Returns the path written; without sips the photo keeps its own format and size.
 */
async function writePhoto(source: string, targetBase: string, tool: PhotoTool): Promise<string> {
  if (tool === 'copy') {
    const kind = photoKind(await readFile(source));
    if (!kind) throw new Error('This photo needs a Mac to convert (HEIC or another format). Send it as a JPEG or PNG instead.');
    await copyFile(source, `${targetBase}.${kind}`);
    return `${targetBase}.${kind}`;
  }
  const resize = await longestEdge(source) > MAX_PHOTO_EDGE ? ['-Z', String(MAX_PHOTO_EDGE)] : [];
  await run(SIPS, ['-s', 'format', 'jpeg', ...resize, source, '--out', `${targetBase}.jpg`]);
  return `${targetBase}.jpg`;
}

/**
 * One folder per touch-up pass holding only that pass's scan and photos.
 * The model's Blender session can read any file on disk, so nothing else may
 * sit next to its inputs.
 */
export async function prepareTouchupPass(input: {root: string; objectId: string; scan: string[]; photos: string[]; requirePhotos?: boolean; photoTool?: PhotoTool}): Promise<TouchupPass> {
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
    photoPaths.push(await writePhoto(file, join(photosDir, `photo-${String(index + 1).padStart(2, '0')}`), input.photoTool ?? DEFAULT_PHOTO_TOOL));
  }
  const photoOverviewPaths: string[] = [];
  if (photoPaths.length) {
    const helper = fileURLToPath(new URL('../../python/photo_overview.py', import.meta.url));
    const {stdout} = await run(process.env.SCAN_TO_MAKE_CAPTURE_PYTHON || 'python3',
      ['-E', '-P', helper, '--out', photosDir, ...photoPaths], {timeout: 300_000, maxBuffer: 1024 * 1024});
    const names: unknown = JSON.parse(stdout);
    if (!Array.isArray(names) || names.length !== Math.ceil(photoPaths.length / 24)
      || names.some((name, index) => name !== `overview-${String(index + 1).padStart(2, '0')}.jpg`)) {
      throw new Error('The photo overview could not be prepared.');
    }
    photoOverviewPaths.push(...names.map(name => join(photosDir, name as string)));
  }
  return {dir, scanDir, scanPaths, photosDir, photoPaths, photoOverviewPaths, outDir, checkpointsDir};
}
