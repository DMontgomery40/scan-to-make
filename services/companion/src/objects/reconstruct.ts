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
  signal?: AbortSignal;
  onProgress?: ReconstructProgress;
}

export type Reconstruct = (input: ReconstructInput) => Promise<void>;

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
  return input => new Promise<void>((resolve, reject) => {
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
      if (code === 0 && done) { resolve(); return; }
      const failure = code === 3 || error === 'needs-macos-27' ? NEEDS_MACOS_27 : FAILED;
      // A diagnostic write failure must not replace the actionable public reconstruction error.
      void retainFailure(input, {code, signal, error, stderr, truncated: stderrTruncated})
        .catch(() => undefined).finally(() => reject(new Error(failure)));
    });
  });
}
