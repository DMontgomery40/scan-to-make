import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
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
const FAILED = "Your Mac couldn't build a model from these photos. Try again with the object filling more of the frame, turning it slowly.";

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
      {stdio: ['ignore', 'pipe', 'ignore'], ...(input.signal ? {signal: input.signal} : {})});
    let buffered = '', error: string | undefined, done = false, lastWords = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
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
    child.on('error', failure => reject(failure.name === 'AbortError' ? failure : new Error(NOT_INSTALLED)));
    child.on('close', code => {
      if (code === 0 && done) resolve();
      else if (code === 3 || error === 'needs-macos-27') reject(new Error(NEEDS_MACOS_27));
      else reject(new Error(FAILED));
    });
  });
}
