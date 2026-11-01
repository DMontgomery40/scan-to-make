import {createHash} from 'node:crypto';
import {link, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PrinterMcpClient, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {defaultBlenderLaunch, ensureBlenderMcp, resetBlenderScene} from './blender.js';
import {prepareTouchupPass, type TouchupPass} from './inputs.js';
import {buildTouchupInvocation, type TouchupInvocation} from './invocation.js';
import {runTouchupWorker, type TouchupProgress, type TouchupResult} from './runner.js';

export interface TouchupInput {
  root: string;
  objectId: string;
  /** The scan as captured (model plus sidecars), or the current model for a correction pass. */
  scan: string[];
  photos: string[];
  /** The user's own printer MCP config, unchanged (bambu-printer-mcp or mcp-3D-printer-server). */
  handoff: PrinterHandoffConfig;
  claudePath: string;
  /** The user's own words, used as the prompt exactly as written. Without them the pass is a touch-up. */
  instructions?: string;
  note?: string;
  summary?: string;
  /** The supplied scan is the previously generated STL, already in millimetres. */
  currentModel?: boolean;
  onProgress?: (progress: TouchupProgress) => void;
  signal?: AbortSignal;
}
export interface TouchupDeps {
  ensureBlender?: () => Promise<unknown>;
  resetScene?: (client: ReturnType<NonNullable<TouchupDeps['client']>>, signal?: AbortSignal) => Promise<void>;
  client?: (handoff: PrinterHandoffConfig) => Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;
  prepare?: typeof prepareTouchupPass;
  run?: (inv: TouchupInvocation, pass: TouchupPass, opts: Parameters<typeof runTouchupWorker>[2]) => Promise<TouchupResult>;
  lockPath?: string;
}

/** One Blender, one scene: touch-ups run strictly one at a time, within this process (queue) and across processes (lock file). */
let queue: Promise<unknown> = Promise.resolve();
export const BLENDER_LOCK_PATH = join(homedir(), 'Library', 'Caches', 'scan-to-make', 'blender.lock');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Holds the Mac's Blender for one touch-up. The lock file appears atomically with its owner's pid in it
 * (written aside, then hard-linked into place), so a contender never sees it half-written. A lock left by a
 * dead process is moved aside and checked before it's dropped, so a fresh lock is never taken over.
 */
export async function acquireBlenderLock(lockPath = BLENDER_LOCK_PATH, opts: {pollMs?: number} = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), {recursive: true});
  const mine = String(process.pid);
  for (;;) {
    const staged = `${lockPath}.${mine}.${randomUUID()}`;
    await writeFile(staged, mine);
    try {
      await link(staged, lockPath);
      await unlink(staged).catch(() => undefined);
      return async () => {
        if ((await readFile(lockPath, 'utf8').catch(() => '')) === mine) await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      await unlink(staged).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = Number(await readFile(lockPath, 'utf8').catch(() => ''));
    if (holder && !alive(holder)) {
      const aside = `${lockPath}.stale.${mine}.${randomUUID()}`;
      try {
        await rename(lockPath, aside);
        if (Number(await readFile(aside, 'utf8').catch(() => '')) === holder) await unlink(aside).catch(() => undefined);
        else await link(aside, lockPath).catch(() => undefined).finally(() => unlink(aside).catch(() => undefined));
      } catch { /* someone else moved it first */ }
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, opts.pollMs ?? 1000));
  }
}

async function stlSha256(scan: string[]): Promise<string | undefined> {
  if (scan.length !== 1 || !scan[0]!.toLowerCase().endsWith('.stl')) return undefined;
  return createHash('sha256').update(await readFile(scan[0]!)).digest('hex');
}

async function touchUp(input: TouchupInput, deps: TouchupDeps): Promise<TouchupResult & {passDir: string}> {
  const release = await acquireBlenderLock(deps.lockPath);
  try { return await touchUpLocked(input, deps); }
  finally { await release(); }
}

async function touchUpLocked(input: TouchupInput, deps: TouchupDeps): Promise<TouchupResult & {passDir: string}> {
  await (deps.ensureBlender ?? (() => ensureBlenderMcp({launch: defaultBlenderLaunch()})))();
  const client = (deps.client ?? (handoff => new PrinterMcpClient(handoff)))(input.handoff);
  await (deps.resetScene ?? resetBlenderScene)(client, input.signal);
  const pass = await (deps.prepare ?? prepareTouchupPass)({root: input.root, objectId: input.objectId, scan: input.scan, photos: input.photos,
    requirePhotos: !(input.instructions?.trim() || input.note?.trim())});
  // Older CLI callers use a note plus a single STL for a revision. The object
  // service supplies the explicit flag, including false for failed first passes.
  const currentModel = input.currentModel ?? (input.note !== undefined && input.scan.length === 1 && input.scan[0]!.toLowerCase().endsWith('.stl'));
  const inv = buildTouchupInvocation({pass, printer: input.handoff.process, claudePath: input.claudePath, currentModel,
    ...(input.instructions !== undefined ? {instructions: input.instructions} : {}),
    ...(input.note !== undefined ? {note: input.note} : {}), ...(input.summary !== undefined ? {summary: input.summary} : {})});
  const inputStlSha256 = await stlSha256(input.scan);
  const result = await (deps.run ?? runTouchupWorker)(inv, pass, {
    ...(inputStlSha256 ? {inputStlSha256} : {}),
    ...(input.onProgress ? {onProgress: input.onProgress} : {}),
    ...(input.signal ? {signal: input.signal} : {}),
  });
  return {...result, passDir: pass.dir};
}

/** Touches up one scan pass through the user's printer MCP's Blender bridge. */
export function runTouchup(input: TouchupInput, deps: TouchupDeps = {}): Promise<TouchupResult & {passDir: string}> {
  const next = queue.then(() => touchUp(input, deps));
  queue = next.catch(() => undefined);
  return next;
}
