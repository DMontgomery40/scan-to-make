import {constants} from 'node:fs';
import {copyFile, mkdir, open, rename, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {join, sep} from 'node:path';
import type {ReconstructionReview} from '@scan-to-make/contracts/reconstruction';
import type {ReconstructReviewOutcome} from './reconstruct.js';

/**
 * Private reconstruction state under `<object>/reconstruction/`: the tool's
 * capture-bound work directory, the capture-camera sidecar, the person's
 * region/measurement answers, and the current review's preview STL. Nothing
 * here is part of the public object; the preview is served only by review id.
 */
export const RECONSTRUCTION_DIR = 'reconstruction';
const MAX_PREVIEW_STL = 64 * 1024 * 1024;

export function reconstructionPaths(dir: string) {
  const root = join(dir, RECONSTRUCTION_DIR);
  return {
    root,
    workDir: join(root, 'work'),
    cameraMetadata: join(root, 'capture-camera.json'),
    objectRegion: join(root, 'capture-object-region.json'),
    measurement: join(root, 'capture-measurement.json'),
    previewStl: (reviewId: string) => join(root, `preview-${reviewId}.stl`),
    previewStlRelative: (reviewId: string) => `${RECONSTRUCTION_DIR}/preview-${reviewId}.stl`,
  };
}

async function exists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Tool inputs already on disk for this object (answers resume from the tool's stage cache). */
export async function reconstructionInputs(dir: string): Promise<{
  workDir: string; cameraMetadata?: string; objectRegion?: string; measurement?: string;
}> {
  const paths = reconstructionPaths(dir);
  return {
    workDir: paths.workDir,
    ...(await exists(paths.cameraMetadata) ? {cameraMetadata: paths.cameraMetadata} : {}),
    ...(await exists(paths.objectRegion) ? {objectRegion: paths.objectRegion} : {}),
    ...(await exists(paths.measurement) ? {measurement: paths.measurement} : {}),
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), {recursive: true, mode: 0o700});
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await rename(temp, path);
}

export async function writeCaptureCamera(dir: string, value: unknown): Promise<void> {
  await writeJsonAtomic(reconstructionPaths(dir).cameraMetadata, value);
}
export async function writeObjectRegion(dir: string, value: unknown): Promise<void> {
  await writeJsonAtomic(reconstructionPaths(dir).objectRegion, value);
}
export async function writeMeasurement(dir: string, value: unknown): Promise<void> {
  await writeJsonAtomic(reconstructionPaths(dir).measurement, value);
}

/** A replaced capture invalidates its camera metadata and every answer bound to it. */
export async function clearReconstructionInputs(dir: string): Promise<void> {
  const paths = reconstructionPaths(dir);
  await rm(paths.cameraMetadata, {force: true});
  await rm(paths.objectRegion, {force: true});
  await rm(paths.measurement, {force: true});
  await rm(paths.workDir, {recursive: true, force: true});
}

/**
 * Copy the tool's preview STL into the object's private reconstruction folder.
 * The source must canonically live inside this object's tool work directory;
 * no other path the tool (or a caller) names is ever served.
 */
export async function saveReviewPreview(dir: string, reviewId: string, source: string): Promise<string> {
  const paths = reconstructionPaths(dir);
  const workRoot = await realpath(paths.workDir).catch(() => undefined);
  const canonical = await realpath(source).catch(() => undefined);
  if (!workRoot || !canonical || !canonical.startsWith(workRoot + sep))
    throw new Error('Reconstruction preview is outside its work directory');
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_STL)
      throw new Error('Reconstruction preview is missing or too large');
  } finally { await file.close(); }
  await mkdir(paths.root, {recursive: true, mode: 0o700});
  const target = paths.previewStl(reviewId), temp = `${target}.tmp`;
  await copyFile(canonical, temp);
  await rename(temp, target);
  return paths.previewStlRelative(reviewId);
}

/** The public review for one tool outcome; paths never leave the companion. */
export function publicReview(id: string, outcome: ReconstructReviewOutcome): ReconstructionReview {
  return {
    id,
    kind: outcome.kind,
    preview: `reconstruction-preview.stl?reviewId=${id}`,
    ...(outcome.previewMeshSha256 ? {previewMeshSha256: outcome.previewMeshSha256} : {}),
    ...(outcome.meshSha256 ? {meshSha256: outcome.meshSha256} : {}),
    boundsMin: outcome.boundsMin,
    boundsMax: outcome.boundsMax,
    extents: outcome.extents,
    scaleKnown: outcome.scaleKnown,
    ...(outcome.scaleMPerUnit ? {scaleMPerUnit: outcome.scaleMPerUnit} : {}),
    ...(outcome.suggestion ? {suggestion: outcome.suggestion} : {}),
    ...(outcome.components ? {components: outcome.components} : {}),
  };
}
