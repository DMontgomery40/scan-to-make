import {spawn as nodeSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import type {TouchupPass} from './inputs.js';
import type {TouchupInvocation} from './invocation.js';

export const TOUCHUP_TIMEOUT_MS = 900_000;
export const TOUCHUP_MAX_TOOL_CALLS = 120;
const KILL_GRACE_MS = 5000;

export interface TouchupResult {
  status: 'done' | 'unchanged' | 'needs_closeup' | 'capped' | 'failed';
  reason?: string;
  closeup?: string;
  summary?: string;
  model?: string;
  renders: string[];
  checkpoints: string[];
  stats: {seconds: number; toolCalls: number; costUsd?: number};
}
export interface TouchupProgress {seconds: number; toolCalls: number; lastText?: string}

interface ResultEvent {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  structured_output?: {status?: string; closeup?: string; summary?: string};
}

/** A printable STL: binary with at least one triangle and the exact size, or ASCII with at least one facet. */
export async function isValidStl(path: string): Promise<boolean> {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch { return false; }
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80);
    if (triangles > 0 && bytes.length === 84 + 50 * triangles) return true;
  }
  const head = bytes.subarray(0, 512).toString('latin1').trimStart();
  return head.startsWith('solid') && bytes.toString('latin1').includes('facet');
}
async function list(dir: string, extension: string): Promise<string[]> {
  try { return (await readdir(dir)).filter(name => name.toLowerCase().endsWith(extension)).sort().map(name => join(dir, name)); }
  catch { return []; }
}
const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

/**
 * Runs one touch-up pass and enforces the guard rails the model can't be trusted
 * to keep: a time cap, a tool-call cap, and never losing the last checkpoint.
 */
export async function runTouchupWorker(inv: TouchupInvocation, pass: TouchupPass, opts: {
  spawn?: typeof nodeSpawn; timeoutMs?: number; maxToolCalls?: number; inputStlSha256?: string;
  onProgress?: (progress: TouchupProgress) => void; signal?: AbortSignal;
} = {}): Promise<TouchupResult> {
  const spawn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? TOUCHUP_TIMEOUT_MS, maxToolCalls = opts.maxToolCalls ?? TOUCHUP_MAX_TOOL_CALLS;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const child = spawn(inv.command, inv.args, {cwd: inv.cwd, env: inv.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let toolCalls = 0, lastText: string | undefined, resultEvent: ResultEvent | undefined, stopReason: string | undefined, stderrTail = '';
  let killTimer: NodeJS.Timeout | undefined;

  const stop = (reason: string) => {
    if (stopReason !== undefined || !child.pid) return;
    stopReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
  };
  const timer = setTimeout(() => stop(`stopped at the ${Math.round(timeoutMs / 1000)} s time limit`), timeoutMs);
  const onAbort = () => stop('cancelled');
  opts.signal?.addEventListener('abort', onAbort, {once: true});
  child.stderr?.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });

  const lines = createInterface({input: child.stdout!});
  lines.on('line', line => {
    let event: {type?: string; message?: {content?: {type?: string; text?: string}[]}} & ResultEvent;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') toolCalls++;
        else if (block.type === 'text' && block.text?.trim()) lastText = block.text.trim();
      }
      opts.onProgress?.({seconds: seconds(), toolCalls, lastText});
      if (toolCalls > maxToolCalls) stop(`stopped at the ${maxToolCalls} tool calls limit`);
    } else if (event.type === 'result') {
      resultEvent = event;
    }
  });

  // Node may emit 'error' without 'close' when the executable can't start, so settle on whichever comes first.
  const ended = await new Promise<{code: number | null; error?: NodeJS.ErrnoException}>(resolve => {
    let settled = false;
    const settle = (value: {code: number | null; error?: NodeJS.ErrnoException}) => { if (!settled) { settled = true; resolve(value); } };
    child.once('error', error => settle({code: null, error}));
    child.once('close', code => settle({code}));
  });
  const exitCode = ended.code;
  clearTimeout(timer);
  clearTimeout(killTimer);
  opts.signal?.removeEventListener('abort', onAbort);

  const touched = join(pass.outDir, 'touched.stl');
  const checkpoints = await list(pass.checkpointsDir, '.stl');
  const renders = await list(pass.outDir, '.png');
  const validCheckpoints: string[] = [];
  for (const checkpoint of checkpoints) if (await isValidStl(checkpoint)) validCheckpoints.push(checkpoint);
  let model: string | undefined;
  if (await isValidStl(touched)) model = touched;
  else model = validCheckpoints.at(-1);

  const base = {renders, checkpoints, stats: {seconds: seconds(), toolCalls, ...(resultEvent?.total_cost_usd !== undefined ? {costUsd: resultEvent.total_cost_usd} : {})}};
  const withModel = model ? {model} : {};
  const answer = resultEvent?.structured_output;
  const summary = answer?.summary ? {summary: answer.summary} : {};

  if (ended.error) {
    const reason = ended.error.code === 'ENOENT' ? `Claude Code wasn't found at ${inv.command}. Install it or sign in.` : `Claude Code couldn't start: ${ended.error.message}`;
    return {status: 'failed', reason, ...base};
  }
  if (stopReason === 'cancelled') return {status: 'failed', reason: 'cancelled', ...withModel, ...base};
  if (stopReason !== undefined) return {status: 'capped', reason: stopReason, ...withModel, ...base};
  if (!resultEvent || resultEvent.is_error || !answer) {
    const reason = resultEvent?.result?.trim() || stderrTail.trim().split('\n').at(-1) || `the worker exited with code ${exitCode}`;
    return {status: 'failed', reason, ...withModel, ...base};
  }
  if (answer.status === 'failed') return {status: 'failed', reason: answer.summary?.trim() || 'the worker could not finish', ...withModel, ...base};
  if (answer.status === 'needs_closeup') return {status: 'needs_closeup', closeup: answer.closeup ?? 'a part of the object', ...summary, ...withModel, ...base};
  if (!model) return {status: 'failed', reason: 'no model was saved', ...summary, ...base};
  // The rules require a checkpoint after every fix: none saved means nothing was fixed.
  if (validCheckpoints.length === 0) return {status: 'unchanged', ...summary, model, ...base};
  if (opts.inputStlSha256 && await sha256(model) === opts.inputStlSha256) return {status: 'unchanged', ...summary, model, ...base};
  return {status: 'done', ...summary, model, ...base};
}
