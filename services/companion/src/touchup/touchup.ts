import {createHash} from 'node:crypto';
import {link, lstat, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PrinterMcpClient, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {defaultBlenderLaunch, ensureBlenderMcp, resetBlenderScene, stopOwnedBlender} from './blender.js';
import {prepareTouchupPass, type TouchupPass} from './inputs.js';
import {buildTouchupInvocation, type DesignEngine, type DesignGuidance, type TouchupInvocation} from './invocation.js';
import {toolErrorText} from './blender.js';
import {runTouchupWorker, type TouchupProgress, type TouchupResult} from './runner.js';
import {DESIGNER_FILE_REBUILT, designerEditProblem} from './designer-file.js';
import {mcpPackageName} from '../printing/print-settings.js';

export interface TouchupInput {
  worker?: import('./runner.js').ProjectWorker;
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
  /**
   * A copy of a designer's 3MF: `scan` is the working 3MF and then, when it differs, the designer's own file.
   * The pass edits the working 3MF in place; one that rebuilds it is refused (see designerEditProblem).
   */
  designerCopy?: boolean;
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
export interface EngineChoice {engine: DesignEngine; note?: string; documentId?: string}
export interface TouchupDeps {
  ensureBlender?: () => Promise<unknown>;
  resetScene?: (client: ReturnType<NonNullable<TouchupDeps['client']>>, signal?: AbortSignal) => Promise<void>;
  stopBlender?: typeof stopOwnedBlender;
  client?: (handoff: PrinterHandoffConfig) => Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool' | 'getTool'>;
  prepare?: typeof prepareTouchupPass;
  /** The printer MCP's own design and slicing guidance for this pass (its `fdm_design` and `fdm_slicing` prompts), if it serves them. */
  guidance?: (handoff: PrinterHandoffConfig, signal?: AbortSignal) => Promise<DesignGuidance | undefined>;
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
export async function acquireBlenderLock(lockPath = BLENDER_LOCK_PATH, opts: {pollMs?: number; signal?: AbortSignal} = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), {recursive: true});
  const mine = String(process.pid);
  for (;;) {
    opts.signal?.throwIfAborted();
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

/** The pass's refusal when the installed MCP serves no fdm_slicing prompt. */
export function slicingGuidanceUnavailable(backend: string): string {
  return `Update ${mcpPackageName(backend)} in Settings → Printers so Counterpart can plan how this prints. Nothing was changed.`;
}

/** The pass's refusal when the printer MCP couldn't be reached for its guidance: a connection problem, not an old MCP. */
export function slicingGuidanceUnreachable(backend: string): string {
  return `Counterpart couldn't reach ${mcpPackageName(backend)} to plan how this prints. Check it in Settings → Printers, then try again. Nothing was changed.`;
}

/**
 * The printer MCP's manufacturing and slicing guidance. Undefined when the MCP couldn't be reached; an MCP that
 * answers without fdm_slicing is refused by the pass (slicingGuidanceUnavailable).
 */
export async function printerDesignGuidance(handoff: PrinterHandoffConfig, signal?: AbortSignal): Promise<DesignGuidance | undefined> {
  const client = new PrinterMcpClient(handoff);
  try {
    await client.connect(signal);
    const options = signal ? {signal} : {};
    const design = await client.prompt('fdm_design', options);
    const slicing = await client.prompt('fdm_slicing', options);
    return {...(design ? {design} : {}), ...(slicing ? {slicing} : {})};
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  } finally {
    await client.close().catch(() => undefined);
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
export async function chooseEngine(input: Pick<TouchupInput, 'handoff' | 'kind' | 'signal' | 'preferredEngine' | 'design'>, deps: Pick<TouchupDeps, 'client'> = {}): Promise<EngineChoice> {
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
    if (!client.getTool('fusion_mcp_new_design').inputSchema.properties?.bind_document)
      return {engine: 'blender', note: "The Fusion bridge needs an update for document binding."};
    const opened = await client.callTool('fusion_mcp_new_design', {bind_document: true, ...(input.design ? {source_f3d: input.design.f3d} : {})}, {signal: input.signal, timeoutMs: 120_000});
    if (opened.isError) return {engine: 'blender', note: `Fusion couldn't open a new design: ${toolErrorText(opened).slice(0, 200)}`};
    const created = JSON.parse((opened.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join('') || '{}') as {document_id?: unknown; document_binding?: unknown};
    if (created.document_binding !== 1 || typeof created.document_id !== 'string' || !created.document_id.trim())
      return {engine: 'blender', note: "Fusion did not confirm document binding. Update its bridge and add-in before using it."};
    return {engine: 'fusion', documentId: created.document_id};
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {engine: 'blender', note: `Fusion isn't reachable: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`};
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Reopen the saved archive with Fusion before discarding the original recovery document.
 * Native import understands Fusion's archive compression and validates the editable design. */
async function closeCompletedFusionDocument(input: TouchupInput, deps: TouchupDeps, documentId: string, archive: string): Promise<{valid: boolean; note?: string}> {
  const client = (deps.client ?? (handoff => new PrinterMcpClient(handoff)))(input.handoff);
  const signal = AbortSignal.timeout(120_000);
  let valid = false, verificationId: string | undefined;
  const close = async (id: string) => {
    const reply = await client.callTool('fusion_mcp_call', {tool_name: 'close_document', arguments: {}, document_id: id}, {signal, timeoutMs: 10_000});
    if (reply.isError) throw new Error('close refused');
  };
  try {
    const file = await lstat(archive);
    if (!file.isFile() || file.size === 0) throw new Error('missing archive');
    await client.connect(signal);
    const imported = await client.callTool('fusion_mcp_new_design', {bind_document: true, source_f3d: archive}, {signal, timeoutMs: 120_000});
    if (imported.isError) throw new Error('archive import refused');
    const receipt = JSON.parse((imported.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join('') || '{}') as {document_binding?: unknown; document_id?: unknown};
    if (receipt.document_binding !== 1 || typeof receipt.document_id !== 'string' || !receipt.document_id.trim() || receipt.document_id === documentId)
      throw new Error('archive import did not confirm a separate owned document');
    verificationId = receipt.document_id;
    valid = true;
    await close(verificationId);
    verificationId = undefined;
    await close(documentId);
    return {valid};
  } catch {
    const note = !valid
      ? 'The editable Fusion archive could not be reopened. The original Fusion document remains open for recovery.'
      : verificationId
        ? 'The design files were verified. The original Fusion document remains open because closing the verification document could not be confirmed.'
        : 'The design files were verified. The original Fusion document may still be open because closing it could not be confirmed.';
    process.stderr.write(`Counterpart: ${note}\n`);
    return {valid, note};
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
    try {
      const result = await touchUpLocked(input, deps, choice);
      if ((result.status === 'done' || result.status === 'unchanged') && result.model && result.design?.f3d && choice.documentId) {
        const checked = await closeCompletedFusionDocument(input, deps, choice.documentId, result.design.f3d);
        if (!checked.valid) {
          const {design: _invalidArchive, ...savedMesh} = result;
          return {...savedMesh, ...choice, status: 'failed', reason: checked.note};
        }
        return {...result, ...choice, ...(checked.note ? {note: checked.note} : {})};
      }
      return {...result, ...choice};
    }
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
  // A designer copy whose last edit already lost the designer's settings (one made before they were checked,
  // like the Nov 4 caliper card) starts again from the designer's own file rather than building on it.
  if (input.designerCopy && pass.scanPaths.length > 1
      && await designerEditProblem(input.handoff, pass.scanPaths.at(-1)!, pass.scanPaths[0], {...(deps.client ? {client: deps.client} : {}), ...(input.signal ? {signal: input.signal} : {})}) === DESIGNER_FILE_REBUILT)
    pass.scanPaths = [pass.scanPaths.at(-1)!];
  // Older CLI callers use a note plus a single STL for a revision. The object
  // service supplies the explicit flag, including false for failed first passes.
  const currentModel = input.currentModel ?? (input.note !== undefined && input.scan.length === 1 && input.scan[0]!.toLowerCase().endsWith('.stl'));
  const fetchGuidance = deps.guidance ?? printerDesignGuidance;
  // A connection blip gets one more try; the pass never starts without the MCP's guidance.
  const guidance = await fetchGuidance(input.handoff, input.signal) ?? await fetchGuidance(input.handoff, input.signal);
  // PRD §8.0 #10: how the slicer orients, supports and checks a slice comes only from the MCP. An MCP that couldn't
  // be reached, or that answers without fdm_slicing (it predates it), means the pass doesn't start.
  if (!guidance) {
    return {status: 'failed', reason: slicingGuidanceUnreachable(input.handoff.backend), renders: [], checkpoints: [], stats: {seconds: 0, toolCalls: 0}, passDir: pass.dir};
  }
  if (!guidance.slicing?.trim()) {
    return {status: 'failed', reason: slicingGuidanceUnavailable(input.handoff.backend), renders: [], checkpoints: [], stats: {seconds: 0, toolCalls: 0}, passDir: pass.dir};
  }
  input.onStage?.('working', choice.engine);
  const inv = buildTouchupInvocation({pass, printer: input.handoff.process, claudePath: input.claudePath, currentModel, engine: choice.engine, documentId: choice.documentId, handoff: input.handoff,
    ...(input.kind ? {kind: input.kind} : {}),
    ...(input.designerCopy ? {designerCopy: true} : {}),
    ...(choice.engine === 'fusion' && input.design ? {design: input.design} : {}), ...(guidance ? {guidance} : {}),
    ...(input.instructions !== undefined ? {instructions: input.instructions} : {}),
    ...(input.note !== undefined ? {note: input.note} : {}), ...(input.summary !== undefined ? {summary: input.summary} : {})});
  inv.worker = input.worker;
  const inputStlSha256 = await stlSha256(input.scan);
  const result = await (deps.run ?? runTouchupWorker)(inv, pass, {
    ...(inputStlSha256 ? {inputStlSha256} : {}),
    ...(input.onProgress ? {onProgress: input.onProgress} : {}),
    ...(input.signal ? {signal: input.signal} : {}),
  });
  // Whatever the pass's status: a model a capped, failed or close-up pass saved still becomes the current model.
  if (input.designerCopy && (result.model || result.parts)) {
    const problem = await designerEditProblem(input.handoff, pass.scanPaths.at(-1)!, result.parts,
      {...(deps.client ? {client: deps.client} : {}), ...(input.signal ? {signal: input.signal} : {})});
    if (problem) {
      // Nothing from this pass becomes the model. A pass that failed or asks for a close-up keeps its own ending.
      const {parts: _rebuilt, partColours: _colours, model: _mesh, ...rest} = result;
      return {...rest, ...(rest.status === 'failed' || rest.status === 'needs_closeup' ? {} : {status: 'failed', reason: problem}), passDir: pass.dir};
    }
  }
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
