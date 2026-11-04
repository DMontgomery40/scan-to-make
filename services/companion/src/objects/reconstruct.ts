import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {lstat, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** What a handheld rebuild reports while it runs, already in the words the phone and the Mac show. */
export type ReconstructProgress = (words: string) => void;

export interface ReconstructInput {
  /** The handheld photos, in capture order by name. */
  photosDir: string;
  /** Where the rebuilt model goes (USDZ, metres). */
  output: string;
  /** Where the object masks are kept, so a rebuild can be checked afterwards. */
  masksDir: string;
  /** capture-camera v1 sidecar (Android), when the capture supplied one. The Mac tool ignores it. */
  cameraMetadata?: string;
  /** capture-object-region v1 answer file, when the person has confirmed one. */
  objectRegion?: string;
  /** capture-measurement v1 answer file, when the person has measured. */
  measurement?: string;
  /** Private, capture-bound tool work directory (stage cache; resumes answers without rebuilding). */
  workDir?: string;
  signal?: AbortSignal;
  onProgress?: ReconstructProgress;
}

/** A rebuild that stopped for the person, in the tool's own (private-path) terms. */
export interface ReconstructReviewOutcome {
  kind: 'region' | 'scale';
  /** Private preview STL path emitted by the tool; the service copies and serves it by review id. */
  previewStl: string;
  previewMeshSha256?: string;
  meshSha256?: string;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  extents: {x: number; y: number; z: number};
  scaleKnown: boolean;
  scaleMPerUnit?: number;
  suggestion?: {type: 'anchor-region' | 'component'; reason: string;
    extents: {x: number; y: number; z: number}; extentsM?: {x: number; y: number; z: number}};
  components?: {index: number; vertices: number; faces: number; share: number;
    boundsMin: [number, number, number]; boundsMax: [number, number, number];
    extents: {x: number; y: number; z: number}}[];
}

export type ReconstructOutcome =
  | {status: 'done'}
  | {status: 'needs-review'; review: ReconstructReviewOutcome};

/** Older stubs resolving void are treated as done by the service. */
export type Reconstruct = (input: ReconstructInput) => Promise<ReconstructOutcome | void>;

/** Thrown by the service's build step so the pass ends as an Ask, never a failure. */
export class ReconstructionReviewNeeded extends Error {
  constructor(readonly review: ReconstructReviewOutcome, readonly reviewId: string) { super('reconstruction review needed'); this.name = 'ReconstructionReviewNeeded'; }
}

export const NEEDS_MACOS_27 = 'Holding it up to scan needs macOS 27 on your Mac. Scanning by walking around it still works.';
const NOT_INSTALLED = "Counterpart's model builder is missing on this Mac. Reinstall Counterpart.";
export const RECONSTRUCTION_FAILED = "Your Mac couldn't build a model from this capture. Your photos are saved in Inputs.";
const FAILED = RECONSTRUCTION_FAILED;
const STDERR_LIMIT = 64 * 1024;

/** Last failed attempt only, never part of public object data or the HTTP artifact allowlist. */
async function retainFailure(input: ReconstructInput, detail: {code: number | null; signal: string | null; error?: string; stderr: Buffer; truncated: boolean}): Promise<void> {
  const directory = join(dirname(input.output), '.reconstruction-diagnostics');
  await mkdir(directory, {recursive: true, mode: 0o700});
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid diagnostic directory');
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const header = JSON.stringify({recordedAt: new Date().toISOString(), exitCode: detail.code, signal: detail.signal,
    error: detail.error?.slice(0, 512), stderrTruncated: detail.truncated}) + '\n';
  try {
    await writeFile(temporary, Buffer.concat([Buffer.from(header), detail.stderr]), {flag: 'wx', mode: 0o600});
    await rename(temporary, join(directory, 'last-failure.log'));
  } finally { await rm(temporary, {force: true}).catch(() => undefined); }
}

/**
 * The bundled `mac-reconstruct` (tools/mac-reconstruct): next to the app's payload when installed,
 * the package build in a checkout, or SCAN_TO_MAKE_MAC_RECONSTRUCT.
 */
export function findMacReconstruct(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SCAN_TO_MAKE_MAC_RECONSTRUCT) return env.SCAN_TO_MAKE_MAC_RECONSTRUCT;
  // dist/objects/reconstruct.js → services/companion → the source root (Payload/source when installed).
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  for (const candidate of [join(source, '../bin/mac-reconstruct'), join(source, 'tools/mac-reconstruct/.build/release/mac-reconstruct')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Words for one line of `mac-reconstruct samples` output, or undefined when it says nothing new. */
export function progressWords(line: Record<string, unknown>): string | undefined {
  if (line.stage === 'downloading') return 'Getting your Mac ready to build from photos. This happens once.';
  if (line.stage === 'masking' && typeof line.done === 'number' && typeof line.total === 'number')
    return `Finding the object in your photos (${line.done} of ${line.total}).`;
  if (line.stage === 'reconstructing') return 'Building the model from your photos.';
  if (typeof line.progress === 'number') return `Building the model from your photos (${Math.round(line.progress * 100)}%).`;
  return undefined;
}

/** Runs `mac-reconstruct samples … full` and resolves when the model is written. Errors are plain sentences. */
export function macReconstructRunner(binary: string | null = findMacReconstruct() ?? null): Reconstruct {
  return input => new Promise<ReconstructOutcome>((resolve, reject) => {
    if (!binary) { reject(new Error(NOT_INSTALLED)); return; }
    const child = spawn(binary, ['samples', input.photosDir, input.output, 'full', '--save-masks', input.masksDir],
      {stdio: ['ignore', 'pipe', 'pipe'], ...(input.signal ? {signal: input.signal} : {})});
    let buffered = '', error: string | undefined, done = false, lastWords = '', spawnFailed = false;
    let stderr = Buffer.alloc(0), stderrTruncated = false;
    child.stderr.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk]);
      stderrTruncated ||= combined.length > STDERR_LIMIT;
      stderr = Buffer.from(combined.subarray(Math.max(0, combined.length - STDERR_LIMIT)));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      // Helper diagnostics must not make a newline-free output grow without a bound.
      if (buffered.length > STDERR_LIMIT) buffered = buffered.slice(-STDERR_LIMIT);
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        let line: Record<string, unknown>;
        try { line = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
        if (typeof line.error === 'string') error = line.error;
        if (typeof line.done === 'string') done = true;
        const words = progressWords(line);
        if (words && words !== lastWords) { lastWords = words; input.onProgress?.(words); }
      }
    });
    child.on('error', failure => {
      spawnFailed = true;
      reject(failure.name === 'AbortError' ? failure : new Error(NOT_INSTALLED));
    });
    child.on('close', (code, signal) => {
      if (spawnFailed) return; // Cancellation and launch failures already have their own actionable result.
      if (code === 0 && done) { resolve({status: 'done'}); return; }
      const failure = code === 3 || error === 'needs-macos-27' ? NEEDS_MACOS_27 : FAILED;
      // A diagnostic write failure must not replace the actionable public reconstruction error.
      void retainFailure(input, {code, signal, error, stderr, truncated: stderrTruncated})
        .catch(() => undefined).finally(() => reject(new Error(failure)));
    });
  });
}

// ---------------------------------------------------------------- Linux (tools/linux-reconstruct)

const LINUX_NOT_INSTALLED = "Counterpart's model builder is missing on this computer. Reinstall Counterpart.";
export const LINUX_RECONSTRUCTION_FAILED = "This computer couldn't build a model from this capture. Your photos are saved in Inputs.";

/** The bundled `linux-reconstruct`: SCAN_TO_MAKE_LINUX_RECONSTRUCT, payload bin, or the checkout tool. */
export function findLinuxReconstruct(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SCAN_TO_MAKE_LINUX_RECONSTRUCT) return env.SCAN_TO_MAKE_LINUX_RECONSTRUCT;
  const source = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  for (const candidate of [join(source, '../bin/linux-reconstruct'), join(source, 'tools/linux-reconstruct/linux-reconstruct')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Words for one line of `linux-reconstruct samples` output. */
export function linuxProgressWords(line: Record<string, unknown>): string | undefined {
  switch (line.stage) {
    case 'inventory': case 'features': case 'matching': case 'mapping':
      return 'Finding the object in your photos.';
    case 'undistorting': case 'interfacing': case 'densifying': case 'meshing': case 'exporting':
      return 'Building the model from your photos.';
    default:
      return typeof line.progress === 'number' ? 'Building the model from your photos.' : undefined;
  }
}

function finiteVec(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v))
    ? [value[0] as number, value[1] as number, value[2] as number] : undefined;
}
function finiteExtents(value: unknown): {x: number; y: number; z: number} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const e = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every(k => typeof e[k] === 'number' && Number.isFinite(e[k]))
    ? {x: e.x as number, y: e.y as number, z: e.z as number} : undefined;
}
function sha256Hex(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

/** Parse a needsObjectRegion NDJSON payload into a review outcome, or undefined if malformed. */
export function parseRegionOutcome(raw: unknown): ReconstructReviewOutcome | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const previewMeshSha256 = sha256Hex(r.previewMeshSha256);
  const boundsMin = finiteVec(r.boundsMin), boundsMax = finiteVec(r.boundsMax);
  const s = (r.suggestion && typeof r.suggestion === 'object' ? r.suggestion : {}) as Record<string, unknown>;
  const suggExtents = finiteExtents(s.extents);
  if (!previewMeshSha256 || !boundsMin || !boundsMax || typeof r.previewStl !== 'string' || !suggExtents) return undefined;
  if (s.type !== 'anchor-region' && s.type !== 'component') return undefined;
  const components = (Array.isArray(r.components) ? r.components : []).flatMap(c => {
    if (!c || typeof c !== 'object') return [];
    const item = c as Record<string, unknown>;
    const lo = finiteVec(item.boundsMin), hi = finiteVec(item.boundsMax), ext = finiteExtents(item.extents);
    if (!lo || !hi || !ext || typeof item.index !== 'number' || typeof item.vertices !== 'number'
      || typeof item.faces !== 'number' || typeof item.share !== 'number') return [];
    return [{index: item.index, vertices: item.vertices, faces: item.faces, share: item.share, boundsMin: lo, boundsMax: hi, extents: ext}];
  }).slice(0, 512);
  const extentsM = finiteExtents(s.extentsM);
  return {
    kind: 'region', previewStl: r.previewStl, previewMeshSha256, boundsMin, boundsMax,
    extents: {x: boundsMax[0] - boundsMin[0], y: boundsMax[1] - boundsMin[1], z: boundsMax[2] - boundsMin[2]},
    scaleKnown: r.scaleKnown === true,
    ...(typeof r.scaleMPerUnit === 'number' && Number.isFinite(r.scaleMPerUnit) && r.scaleMPerUnit > 0 ? {scaleMPerUnit: r.scaleMPerUnit} : {}),
    suggestion: {type: s.type, reason: typeof s.reason === 'string' ? s.reason.slice(0, 512) : 'The largest piece found.', extents: suggExtents, ...(extentsM ? {extentsM} : {})},
    components,
  };
}

/** Parse a needsScale NDJSON payload into a review outcome, or undefined if malformed. */
export function parseScaleOutcome(raw: unknown): ReconstructReviewOutcome | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const meshSha256 = sha256Hex(r.meshSha256);
  const boundsMin = finiteVec(r.boundsMin), boundsMax = finiteVec(r.boundsMax), extents = finiteExtents(r.extents);
  if (!meshSha256 || !boundsMin || !boundsMax || !extents || typeof r.previewStl !== 'string') return undefined;
  return {kind: 'scale', previewStl: r.previewStl, meshSha256, boundsMin, boundsMax, extents, scaleKnown: false};
}

/**
 * Runs `linux-reconstruct samples … full`. Exit 5/4 resolve as needs-review
 * (never a failure, never a success); cancellation and bounded diagnostics
 * behave exactly like the Mac runner.
 */
export function linuxReconstructRunner(binary: string | null = findLinuxReconstruct() ?? null): Reconstruct {
  return input => new Promise<ReconstructOutcome>((resolve, reject) => {
    if (!binary) { reject(new Error(LINUX_NOT_INSTALLED)); return; }
    const args = ['samples', input.photosDir, input.output, 'full', '--save-masks', input.masksDir,
      ...(input.cameraMetadata ? ['--camera-metadata', input.cameraMetadata] : []),
      ...(input.objectRegion ? ['--object-region', input.objectRegion] : []),
      ...(input.measurement ? ['--measurement', input.measurement] : []),
      ...(input.workDir ? ['--work-dir', input.workDir] : [])];
    const child = spawn(binary, args, {stdio: ['ignore', 'pipe', 'pipe'], ...(input.signal ? {signal: input.signal} : {})});
    let buffered = '', error: string | undefined, done = false, lastWords = '', spawnFailed = false;
    let region: ReconstructReviewOutcome | undefined, scale: ReconstructReviewOutcome | undefined;
    let stderr = Buffer.alloc(0), stderrTruncated = false;
    child.stderr.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk]);
      stderrTruncated ||= combined.length > STDERR_LIMIT;
      stderr = Buffer.from(combined.subarray(Math.max(0, combined.length - STDERR_LIMIT)));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      // A needsObjectRegion line carries component stats; allow one bounded large line.
      if (buffered.length > 4 * 1024 * 1024) buffered = buffered.slice(-4 * 1024 * 1024);
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        let line: Record<string, unknown>;
        try { line = JSON.parse(text) as Record<string, unknown>; } catch { continue; }
        if (typeof line.error === 'string') error = line.error;
        if (typeof line.done === 'string') done = true;
        if (line.needsObjectRegion) region = parseRegionOutcome(line.needsObjectRegion);
        if (line.needsScale) scale = parseScaleOutcome(line.needsScale);
        const words = linuxProgressWords(line);
        if (words && words !== lastWords) { lastWords = words; input.onProgress?.(words); }
      }
    });
    child.on('error', failure => {
      spawnFailed = true;
      reject(failure.name === 'AbortError' ? failure : new Error(LINUX_NOT_INSTALLED));
    });
    child.on('close', (code, signal) => {
      if (spawnFailed) return;
      if (code === 0 && done) { resolve({status: 'done'}); return; }
      if (code === 5 && region) { resolve({status: 'needs-review', review: region}); return; }
      if (code === 4 && scale) { resolve({status: 'needs-review', review: scale}); return; }
      void retainFailure(input, {code, signal, error, stderr, truncated: stderrTruncated})
        .catch(() => undefined).finally(() => reject(new Error(LINUX_RECONSTRUCTION_FAILED)));
    });
  });
}

/** The platform's own builder: Linux tool on Linux, the Mac tool elsewhere (unchanged). */
export function defaultReconstructRunner(platform: string = process.platform): Reconstruct {
  return platform === 'linux' ? linuxReconstructRunner() : macReconstructRunner();
}
