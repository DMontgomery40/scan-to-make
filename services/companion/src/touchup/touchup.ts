import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
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
  onProgress?: (progress: TouchupProgress) => void;
  signal?: AbortSignal;
}
export interface TouchupDeps {
  ensureBlender?: () => Promise<unknown>;
  resetScene?: (client: ReturnType<NonNullable<TouchupDeps['client']>>, signal?: AbortSignal) => Promise<void>;
  client?: (handoff: PrinterHandoffConfig) => Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;
  prepare?: typeof prepareTouchupPass;
  run?: (inv: TouchupInvocation, pass: TouchupPass, opts: Parameters<typeof runTouchupWorker>[2]) => Promise<TouchupResult>;
}

/** One Blender, one scene: touch-ups on this Mac run strictly one at a time. */
let queue: Promise<unknown> = Promise.resolve();

async function stlSha256(scan: string[]): Promise<string | undefined> {
  if (scan.length !== 1 || !scan[0]!.toLowerCase().endsWith('.stl')) return undefined;
  return createHash('sha256').update(await readFile(scan[0]!)).digest('hex');
}

async function touchUp(input: TouchupInput, deps: TouchupDeps): Promise<TouchupResult & {passDir: string}> {
  await (deps.ensureBlender ?? (() => ensureBlenderMcp({launch: defaultBlenderLaunch()})))();
  const client = (deps.client ?? (handoff => new PrinterMcpClient(handoff)))(input.handoff);
  await (deps.resetScene ?? resetBlenderScene)(client, input.signal);
  const pass = await (deps.prepare ?? prepareTouchupPass)({root: input.root, objectId: input.objectId, scan: input.scan, photos: input.photos,
    requirePhotos: !input.instructions?.trim()});
  const inv = buildTouchupInvocation({pass, printer: input.handoff.process, claudePath: input.claudePath,
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
