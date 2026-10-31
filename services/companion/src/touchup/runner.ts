import {spawn as nodeSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir, readFile, stat} from 'node:fs/promises';
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

async function nonEmpty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch { return false; }
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

  const exitCode = await new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  clearTimeout(timer);
  clearTimeout(killTimer);
  opts.signal?.removeEventListener('abort', onAbort);

  const touched = join(pass.outDir, 'touched.stl');
  const checkpoints = await list(pass.checkpointsDir, '.stl');
  const renders = await list(pass.outDir, '.png');
  let model: string | undefined;
  if (await nonEmpty(touched)) model = touched;
  else for (const checkpoint of [...checkpoints].reverse()) if (await nonEmpty(checkpoint)) { model = checkpoint; break; }

  const base = {renders, checkpoints, stats: {seconds: seconds(), toolCalls, ...(resultEvent?.total_cost_usd !== undefined ? {costUsd: resultEvent.total_cost_usd} : {})}};
  const withModel = model ? {model} : {};
  const answer = resultEvent?.structured_output;
  const summary = answer?.summary ? {summary: answer.summary} : {};

  if (stopReason === 'cancelled') return {status: 'failed', reason: 'cancelled', ...withModel, ...base};
  if (stopReason !== undefined) return {status: 'capped', reason: stopReason, ...withModel, ...base};
  if (!resultEvent || resultEvent.is_error || !answer) {
    const reason = resultEvent?.result?.trim() || stderrTail.trim().split('\n').at(-1) || `the worker exited with code ${exitCode}`;
    return {status: 'failed', reason, ...withModel, ...base};
  }
  if (answer.status === 'needs_closeup') return {status: 'needs_closeup', closeup: answer.closeup ?? 'a part of the object', ...summary, ...withModel, ...base};
  if (!model) return {status: 'failed', reason: 'no model was saved', ...summary, ...base};
  if (opts.inputStlSha256 && await sha256(model) === opts.inputStlSha256) return {status: 'unchanged', ...summary, model, ...base};
  return {status: 'done', ...summary, model, ...base};
}
