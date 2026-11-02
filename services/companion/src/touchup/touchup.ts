import {createHash} from 'node:crypto';
import {link, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PrinterMcpClient, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {defaultBlenderLaunch, ensureBlenderMcp, resetBlenderScene, stopOwnedBlender} from './blender.js';
import {prepareTouchupPass, type TouchupPass} from './inputs.js';
import {buildTouchupInvocation, type DesignEngine, type TouchupInvocation} from './invocation.js';
import {toolErrorText} from './blender.js';
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
  /** "fit" (make something that fits) may design in Fusion; "copy" always uses Blender (PRD §8.9). */
  kind?: 'fit' | 'copy';
  preferredEngine?: DesignEngine;
  /** The previous Fusion design, so a change starts from its parameters. */
  design?: {f3d: string; parameters?: string};
  /** Stage changes: getting the engine ready, then the worker. */
  onStage?: (stage: 'preparing' | 'working', engine: DesignEngine) => void;
}

/** Which engine ran, and why it isn't Fusion when Fusion was wanted. */
export interface EngineChoice {engine: DesignEngine; note?: string}
export interface TouchupDeps {
  ensureBlender?: () => Promise<unknown>;
  resetScene?: (client: ReturnType<NonNullable<TouchupDeps['client']>>, signal?: AbortSignal) => Promise<void>;
  stopBlender?: typeof stopOwnedBlender;
  client?: (handoff: PrinterHandoffConfig) => Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;
  prepare?: typeof prepareTouchupPass;
  run?: (inv: TouchupInvocation, pass: TouchupPass, opts: Parameters<typeof runTouchupWorker>[2]) => Promise<TouchupResult>;
  lockPath?: string;
  fusionLockPath?: string;
}

/** One Blender, one scene: touch-ups run strictly one at a time, within this process (queue) and across processes (lock file). */
let queue: Promise<unknown> = Promise.resolve();
let queuedPasses = 0;
let idleBlender: {input: TouchupInput; deps: TouchupDeps} | undefined;
export const BLENDER_LOCK_PATH = join(homedir(), 'Library', 'Caches', 'scan-to-make', 'blender.lock');
/** One open Fusion document: design passes take turns across companion processes too. */
export const FUSION_LOCK_PATH = join(homedir(), 'Library', 'Caches', 'scan-to-make', 'fusion.lock');

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

/**
 * PRD §8.9: a copy is cleaned up in Blender. A new design uses Fusion when the
 * printer MCP's bridge reports it connected (after `launch: true`) and a new
 * design opens; otherwise Blender, with the reason recorded.
 */
export async function chooseEngine(input: Pick<TouchupInput, 'handoff' | 'kind' | 'signal' | 'preferredEngine'>, deps: Pick<TouchupDeps, 'client'> = {}): Promise<EngineChoice> {
  if (input.kind !== 'fit' || input.preferredEngine === 'blender') return {engine: 'blender'};
  const client = (deps.client ?? (handoff => new PrinterMcpClient(handoff)))(input.handoff);
  try {
    await client.connect(input.signal);
    if (!client.hasTool('fusion_mcp_status')) return {engine: 'blender'};
    const status = await client.callTool('fusion_mcp_status', {launch: true, timeout_ms: 90_000}, {signal: input.signal, timeoutMs: 120_000});
    if (status.isError) return {engine: 'blender', note: `Fusion isn't reachable: ${toolErrorText(status).slice(0, 200)}`};
    const value = JSON.parse((status.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join('') || '{}') as {connected?: unknown; configured?: unknown; error?: unknown};
    if (value.configured === false) return {engine: 'blender'};
    if (value.connected !== true) return {engine: 'blender', note: `Fusion isn't connected${typeof value.error === 'string' && value.error ? `: ${value.error.slice(0, 200)}` : ''}.`};
    if (!client.hasTool('fusion_mcp_new_design')) return {engine: 'blender', note: "This printer MCP can't open a new Fusion design."};
    // faust-machines/fusion360-mcp-server#12: opening a design can fail with none open.
    const opened = await client.callTool('fusion_mcp_new_design', {}, {signal: input.signal, timeoutMs: 120_000});
    if (opened.isError) return {engine: 'blender', note: `Fusion couldn't open a new design: ${toolErrorText(opened).slice(0, 200)}`};
    return {engine: 'fusion'};
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {engine: 'blender', note: `Fusion isn't reachable: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`};
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function touchUp(input: TouchupInput, deps: TouchupDeps): Promise<TouchupResult & {passDir: string} & EngineChoice> {
  input.onStage?.('preparing', 'blender');
  // A design may open a new Fusion document: hold Fusion from that call to the end of the worker.
  const releaseFusion = input.kind === 'fit' && input.preferredEngine !== 'blender' ? await acquireBlenderLock(deps.fusionLockPath ?? FUSION_LOCK_PATH) : undefined;
  let choice: EngineChoice;
  try { choice = await chooseEngine(input, deps); }
  catch (error) { await releaseFusion?.(); throw error; }
  // Fusion passes don't touch Blender: no Blender lock, no launch, no scene reset.
  if (choice.engine === 'fusion') {
    try { return {...await touchUpLocked(input, deps, choice), ...choice}; }
    finally { await releaseFusion?.(); }
  }
  await releaseFusion?.();
  const release = await acquireBlenderLock(deps.lockPath);
  try { return {...await touchUpLocked(input, deps, choice), ...choice}; }
  finally { await release(); }
}

async function touchUpLocked(input: TouchupInput, deps: TouchupDeps, choice: EngineChoice): Promise<TouchupResult & {passDir: string}> {
  if (choice.engine === 'blender') {
    idleBlender = {input, deps};
    await (deps.ensureBlender ?? (() => ensureBlenderMcp({launch: defaultBlenderLaunch()})))();
    const client = (deps.client ?? (handoff => new PrinterMcpClient(handoff)))(input.handoff);
    await (deps.resetScene ?? resetBlenderScene)(client, input.signal);
  }
  const pass = await (deps.prepare ?? prepareTouchupPass)({root: input.root, objectId: input.objectId, scan: input.scan, photos: input.photos,
    requirePhotos: !(input.instructions?.trim() || input.note?.trim())});
  // Older CLI callers use a note plus a single STL for a revision. The object
  // service supplies the explicit flag, including false for failed first passes.
  const currentModel = input.currentModel ?? (input.note !== undefined && input.scan.length === 1 && input.scan[0]!.toLowerCase().endsWith('.stl'));
  input.onStage?.('working', choice.engine);
  const inv = buildTouchupInvocation({pass, printer: input.handoff.process, claudePath: input.claudePath, currentModel, engine: choice.engine,
    ...(choice.engine === 'fusion' && input.design ? {design: input.design} : {}),
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
export function runTouchup(input: TouchupInput, deps: TouchupDeps = {}): Promise<TouchupResult & {passDir: string} & Partial<EngineChoice>> {
  queuedPasses++;
  const next = queue.then(async () => {
    try { return await touchUp(input, deps); }
    finally {
      queuedPasses--;
      await closeIdleBlender();
    }
  });
  queue = next.catch(() => undefined);
  return next;
}

/** A batch may finish in Fusion after using Blender: retain the Blender route until the whole queue drains. */
async function closeIdleBlender(): Promise<void> {
  const idle = idleBlender;
  if (queuedPasses || !idle) return;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireBlenderLock(idle.deps.lockPath);
    // Another caller may have joined the queue while we waited for another companion's pass.
    if (queuedPasses) return;
    idleBlender = undefined;
    const client = (idle.deps.client ?? (handoff => new PrinterMcpClient(handoff)))(idle.input.handoff);
    await (idle.deps.stopBlender ?? stopOwnedBlender)(client);
  } catch {
    // The generated part remains usable even if the bridge disappeared during cleanup.
    console.error('Counterpart could not close its idle Blender. Check the Blender MCP connection.');
  } finally { await release?.(); }
}
