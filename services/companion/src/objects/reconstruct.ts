import {spawn} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {lstat, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** What a handheld rebuild reports while it runs, already in the words the phone and the Mac show. */
export type ReconstructProgress = (words: string) => void;

export interface ReconstructInput {
  /** The handheld photos, in capture order by name. */
  photosDir: string;
  /**
   * The photos are an iPhone Object Capture session's own HEICs (a walk-around or a scan rig), rebuilt the way Apple
   * documents it: PhotogrammetrySession on the images folder (`mac-reconstruct <folder>`), which reads each photo's
   * camera, LiDAR depth and gravity itself, with Apple's own object masking always on and the capture box ignored.
   */
  objectCapture?: boolean;
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
  /**
   * The capture declared its rebuild unqualified by itself (Android): the
   * output may only be accepted after region/scale qualification, even when
   * camera metadata is present. On a Mac this runs Apple's rebuild first,
   * then qualifies it; an iPhone capture never sets this.
   */
  scaleQualificationRequired?: boolean;
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

/** What a Mac rebuild of an Object Capture folder used: photos, how many carry LiDAR depth (the size's source), Apple's warnings. */
export interface ReconstructInputs { images: number; depth: number; stitchingIncomplete?: boolean;
  /** Photos Apple's reconstruction couldn't use (`skippedSample`/`invalidSample`). */
  skipped?: number }

export type ReconstructOutcome =
  | {status: 'done'; inputs?: ReconstructInputs}
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
async function retainFailure(input: Pick<ReconstructInput, 'output'>, detail: {code: number | null; signal: string | null; error?: string; stderr: Buffer; truncated: boolean}): Promise<void> {
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

/**
 * The arguments for one rebuild. Both build at `.full`: Apple's high-quality preset, the highest that is processed
 * into a clean mesh. `.raw` is "unprocessed" and meant "only if you plan to export the model to a 3D software
 * package" (PhotogrammetrySession.Request.Detail), and an STL keeps none of the extra texture maps either way.
 */
export function macReconstructArgs(input: Pick<ReconstructInput, 'photosDir' | 'output' | 'masksDir' | 'objectCapture'>): string[] {
  return input.objectCapture
    ? [input.photosDir, input.output, 'full']
    : ['samples', input.photosDir, input.output, 'full', '--save-masks', input.masksDir];
}

/** Runs `mac-reconstruct … full` and resolves when the model is written. Errors are plain sentences. */
export function macReconstructRunner(binary: string | null = findMacReconstruct() ?? null): Reconstruct {
  return input => new Promise<ReconstructOutcome>((resolve, reject) => {
    if (!binary) { reject(new Error(NOT_INSTALLED)); return; }
    const child = spawn(binary, macReconstructArgs(input),
      {stdio: ['ignore', 'pipe', 'pipe'], ...(input.signal ? {signal: input.signal} : {})});
    let buffered = '', error: string | undefined, done = false, lastWords = '', spawnFailed = false;
    let inputs: ReconstructInputs | undefined;
    const skipped = new Set<string>();
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
        if (typeof line.images === 'number' && typeof line.depth === 'number') inputs = {images: line.images, depth: line.depth};
        if (line.warning === 'stitching-incomplete' && inputs) inputs.stitchingIncomplete = true;
        if (inputs && (typeof line.skipped === 'number' || typeof line.skipped === 'string')) inputs.skipped = skipped.add(String(line.skipped)).size;
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
      if (code === 0 && done) { resolve({status: 'done', ...(inputs ? {inputs} : {})}); return; }
      const failure = code === 3 || error === 'needs-macos-27' ? NEEDS_MACOS_27 : FAILED;
      // A diagnostic write failure must not replace the actionable public reconstruction error.
      void retainFailure(input, {code, signal, error, stderr, truncated: stderrTruncated})
        .catch(() => undefined).finally(() => reject(new Error(failure)));
    });
  });
}

/**
 * Turns a scan into the STL a project prints (millimetres, Z up, on the bed), without touching it up; with `render`,
 * also draws the project page's picture of it there (best effort: a scan that can't be drawn still gets its STL).
 */
export type ScanToStl = (scan: string, stl: string, options?: {render?: string; signal?: AbortSignal}) => Promise<void>;
export const SCAN_TO_STL_FAILED = "Your Mac couldn't turn this scan into a printable model.";

/** `mac-reconstruct stl <scan> <stl> [--render <png>]`: the scan's triangles in millimetres (PhotogrammetrySession writes metres). */
export function macScanToStl(binary: string | null = findMacReconstruct() ?? null): ScanToStl | undefined {
  if (!binary) return undefined;
  return (scan, stl, {render, signal} = {}) => new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['stl', scan, stl, ...(render ? ['--render', render] : [])], {stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? {signal} : {})});
    let out = '', failed = false, stderr = Buffer.alloc(0), stderrTruncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out = (out + chunk).slice(-16384); });
    // Kept like the rebuild's: a bounded private tail beside the output, never in the words the person sees.
    child.stderr.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk]);
      stderrTruncated ||= combined.length > STDERR_LIMIT;
      stderr = Buffer.from(combined.subarray(Math.max(0, combined.length - STDERR_LIMIT)));
    });
    child.on('error', failure => { failed = true; reject(failure.name === 'AbortError' ? failure : new Error(NOT_INSTALLED)); });
    child.on('close', (code, signalName) => {
      if (failed) return;
      const lines = out.trim().split('\n').flatMap(line => { try { return [JSON.parse(line) as {done?: unknown; error?: unknown}]; } catch { return []; } });
      if (code === 0 && lines.some(line => typeof line.done === 'string')) { resolve(); return; }
      const error = lines.map(line => line.error).find((value): value is string => typeof value === 'string');
      void retainFailure({output: stl}, {code, signal: signalName, error, stderr, truncated: stderrTruncated})
        .catch(() => undefined).finally(() => reject(new Error(SCAN_TO_STL_FAILED)));
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

/** One linux-reconstruct invocation; exit 5/4 resolve as needs-review, never success. */
function runLinuxTool(binary: string, args: string[], input: ReconstructInput): Promise<ReconstructOutcome> {
  return new Promise<ReconstructOutcome>((resolve, reject) => {
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

/** Runs `linux-reconstruct samples … full` (COLMAP/OpenMVS on a Linux host). */
export const OBJECT_CAPTURE_NEEDS_MAC = "This computer can't rebuild an iPhone walk-around scan from its photos; that needs Apple's reconstruction on a Mac.";

export function linuxReconstructRunner(binary: string | null = findLinuxReconstruct() ?? null): Reconstruct {
  return input => {
    // Apple's Object Capture HEICs carry what only PhotogrammetrySession reads (gravity, the capture box).
    if (input.objectCapture) return Promise.reject(new Error(OBJECT_CAPTURE_NEEDS_MAC));
    if (!binary) return Promise.reject(new Error(LINUX_NOT_INSTALLED));
    return runLinuxTool(binary, ['samples', input.photosDir, input.output, 'full', '--save-masks', input.masksDir,
      ...(input.cameraMetadata ? ['--camera-metadata', input.cameraMetadata] : []),
      ...(input.objectRegion ? ['--object-region', input.objectRegion] : []),
      ...(input.measurement ? ['--measurement', input.measurement] : []),
      ...(input.workDir ? ['--work-dir', input.workDir] : [])], input);
  };
}

export const QUALIFY_NOT_INSTALLED = "This Mac can't check the size of an Android scan yet. Update Counterpart on this Mac, or use a computer that can.";

/**
 * A Mac building an Android capture: Apple's own reconstruction first
 * (unchanged), then qualification of its output. Apple's result for plain
 * photos carries no trustworthy metric scale and this host gets no Apple
 * camera centres to fit ARCore poses against, so metadata presence alone
 * never qualifies it: the qualify step applies the same region gate and
 * requires an explicit measurement. An iPhone capture
 * (scaleQualificationRequired unset) takes the plain Mac path exactly.
 */
export function macQualifiedReconstructRunner(
  macBinary: string | null = findMacReconstruct() ?? null,
  qualifyBinary: string | null = findLinuxReconstruct() ?? null,
): Reconstruct {
  const mac = macReconstructRunner(macBinary);
  return async input => {
    if (!input.scaleQualificationRequired) return mac(input);
    if (!qualifyBinary || !input.workDir) throw new Error(QUALIFY_NOT_INSTALLED);
    const raw = join(input.workDir, 'apple-raw.usdz');
    await mkdir(input.workDir, {recursive: true});
    // Capture photos cannot change after start, so an existing Apple rebuild
    // is this capture's; answer resumes reuse it instead of rebuilding.
    if (!existsSync(raw)) {
      // Only a completed Apple rebuild is reusable. A cancelled process may
      // leave a partial file; never cache that file under the completed name.
      const building = join(input.workDir, `apple-raw-building-${randomUUID()}.usdz`);
      try {
        await mac({...input, output: building});
        input.signal?.throwIfAborted();
        await rename(building, raw);
      } finally { await rm(building, {force: true}).catch(() => undefined); }
    }
    input.signal?.throwIfAborted();
    return runLinuxTool(qualifyBinary, ['qualify', raw, input.output,
      ...(input.objectRegion ? ['--object-region', input.objectRegion] : []),
      ...(input.measurement ? ['--measurement', input.measurement] : []),
      '--work-dir', input.workDir], input);
  };
}

/**
 * Whether the tools for the qualified capture/review path are present.
 * Presence alone is not the capability: see reconstructionReadiness.
 */
export function reconstructionReviewSupported(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'linux') return !!findLinuxReconstruct(env);
  if (platform === 'darwin') return !!findMacReconstruct(env) && !!findLinuxReconstruct(env);
  return false;
}

export interface ReconstructionReadiness { ok: boolean; error?: string; versions?: Record<string, string> }

let readinessCache: {key: string; at: number; promise: Promise<ReconstructionReadiness>} | undefined;

/** Test seam: drop cached readiness evidence. */
export function resetReconstructionReadiness(): void { readinessCache = undefined; }

async function probeReadiness(platform: string, env: NodeJS.ProcessEnv): Promise<ReconstructionReadiness> {
  const binary = findLinuxReconstruct(env);
  if (!binary || (platform === 'darwin' && !findMacReconstruct(env)))
    return {ok: false, error: QUALIFY_NOT_INSTALLED};
  const mode = platform === 'linux' ? 'samples' : 'qualify';
  return new Promise(resolve => {
    // The supplied environment decides discovery AND the probe itself (the
    // packaged launcher reads SCAN_TO_MAKE_* from it); stderr is drained so
    // a verbose failing tool can never wedge on a full pipe.
    const child = spawn(binary, ['check', '--mode', mode], {stdio: ['ignore', 'pipe', 'pipe'], env});
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out = (out + chunk).slice(-16384); });
    child.stderr.on('data', (chunk: string) => { err = (err + chunk).slice(-4096); });
    child.on('error', () => { clearTimeout(timer); resolve({ok: false, error: QUALIFY_NOT_INSTALLED}); });
    child.on('close', code => {
      clearTimeout(timer);
      const tail = err.trim().split('\n').at(-1)?.slice(0, 200);
      try {
        const line = out.trim().split('\n').at(-1);
        const report = JSON.parse(line ?? '') as {ok?: unknown; error?: unknown; versions?: Record<string, string>};
        resolve(code === 0 && report.ok === true
          ? {ok: true, versions: report.versions}
          : {ok: false, error: typeof report.error === 'string' ? report.error : (tail || QUALIFY_NOT_INSTALLED)});
      } catch { resolve({ok: false, error: tail || QUALIFY_NOT_INSTALLED}); }
    });
  });
}

/**
 * The packaged BUILD-ID beside a launcher, when the launcher lives in a
 * payload: <payload>/bin/linux-reconstruct (Linux) or
 * Payload/source/tools/linux-reconstruct/linux-reconstruct (Mac).
 * Readiness evidence is bound to this identity, not a file timestamp.
 */
export function packagedBuildId(binary: string | undefined): string | undefined {
  if (!binary) return undefined;
  for (const candidate of [join(dirname(binary), '..', 'BUILD-ID'), join(dirname(binary), '..', '..', '..', 'BUILD-ID')]) {
    try {
      const text = readFileSync(candidate, 'utf8').trim().split('\n')[0]?.trim();
      if (text && text.length <= 256) return text;
    } catch { /* not packaged there */ }
  }
  return undefined;
}

/**
 * Verified-runnable evidence for capabilities.reconstructionReviewV1: the
 * tool's own bounded `check`, cached per packaged BUILD-ID (falling back
 * to launcher mtime for unpackaged checkouts) so health requests never
 * spawn probes repeatedly. A new payload build invalidates; a failure is
 * retried after 30 s, never cached as success.
 */
export function reconstructionReadiness(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<ReconstructionReadiness> {
  if (platform !== 'linux' && platform !== 'darwin') return Promise.resolve({ok: false, error: QUALIFY_NOT_INSTALLED});
  const binary = findLinuxReconstruct(env);
  const buildId = packagedBuildId(binary);
  let stamp = '';
  if (!buildId) { try { stamp = binary ? String(statSync(binary).mtimeMs) : ''; } catch { stamp = ''; } }
  const key = `${platform}|${binary ?? ''}|build:${buildId ?? ''}|mtime:${stamp}|${platform === 'darwin' ? findMacReconstruct(env) ?? '' : ''}`;
  const now = Date.now();
  if (readinessCache?.key === key && now - readinessCache.at < 30000) return readinessCache.promise;
  if (readinessCache?.key === key) {
    // Reuse a prior success indefinitely for the same binary; re-probe failures.
    const cached = readinessCache;
    return cached.promise.then(result => result.ok ? result : (readinessCache = {key, at: now, promise: probeReadiness(platform, env)}).promise);
  }
  readinessCache = {key, at: now, promise: probeReadiness(platform, env)};
  return readinessCache.promise;
}

/** The platform's own builder: Linux tool on Linux, Apple's (with qualification) on a Mac. */
export function defaultReconstructRunner(platform: string = process.platform): Reconstruct {
  return platform === 'linux' ? linuxReconstructRunner() : macQualifiedReconstructRunner();
}
