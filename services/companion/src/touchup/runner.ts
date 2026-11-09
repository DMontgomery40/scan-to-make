import {spawn as nodeSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {inspectModelFile} from '@scan-to-make/printer-handoff';
import type {TouchupPass} from './inputs.js';
import type {TouchupInvocation} from './invocation.js';

export const TOUCHUP_TIMEOUT_MS = 2 * 60 * 60_000;
export const TOUCHUP_INACTIVITY_MS = 10 * 60_000;
export interface WorkerLimit {kind: 'inactivity' | 'absolute' | 'tool-calls'; value: number}
export function limitWords(limit: WorkerLimit): string {
  return limit.kind === 'tool-calls' ? `Stopped at the ${limit.value} tool-call limit`
    : limit.kind === 'inactivity' ? `Stopped after ${Math.round(limit.value / 1000)} seconds without worker activity`
    : `Stopped at the ${Math.round(limit.value / 1000)} second absolute time limit`;
}
export const TOUCHUP_MAX_TOOL_CALLS = 120;
const KILL_GRACE_MS = 5000;

export interface TouchupChange {tag: 'added' | 'changed' | 'assumed' | 'estimated'; text: string; toleranceMm?: number}
export interface TouchupAsk {question: string; photo?: string; region?: {x: number; y: number; width: number; height: number}}
/** The designer's supports choice, passed to the slicer as it is (slice_stl `enable_support` / `support_type`). */
export interface TouchupSupports {enabled: boolean; type?: 'tree(auto)' | 'normal(auto)'}
export interface TouchupResult {
  status: 'done' | 'unchanged' | 'needs_closeup' | 'capped' | 'failed';
  /** The worker's short name for the thing (PR 4). */
  title?: string;
  changes?: TouchupChange[];
  ask?: TouchupAsk;
  supports?: TouchupSupports;
  /** Fusion passes: the parametric design and its parameters, from fusion_mcp_export. */
  design?: {f3d: string; parameters?: string};
  reason?: string;
  limit?: WorkerLimit;
  sessionId?: string;
  sessionCwd?: string;
  /** Only a limit or a process exit without a final answer may continue. */
  resumable?: boolean;
  resume?: {sessionId: string; outcome: 'resumed' | 'cold-start' | 'attempted'; reason?: string};
  closeup?: string;
  summary?: string;
  model?: string;
  /** A request in several colours: the printer MCP's multi-part 3MF (counterpart_make_3mf), each part on its filament. */
  parts?: string;
  /** The colour (and material, when named) the worker declares for each of `parts`' filaments, in order. */
  partColours?: {name?: string; colour?: string; material?: string}[];
  renders: string[];
  checkpoints: string[];
  stats: {seconds: number; toolCalls: number; costUsd?: number};
  /** What the worker actually started with, from Claude Code's init event: proof of isolation. */
  worker?: {model?: string; apiKeySource?: string; tools: string[]; plugins: string[]; mcpServers: string[]};
}
export interface TouchupActivity {atMs: number; kind: 'message' | 'tool'; text: string}
export interface TouchupProgress {
  seconds: number;
  sessionId?: string;
  sessionCwd?: string;
  passDir?: string;
  toolCalls: number;
  lastText?: string;
  /** New public events only, in stream order. Never thinking, tool input or tool output. */
  activity?: TouchupActivity[];
}

/** Public progress must not echo configured credentials, even if the worker mentions one. */
export function publicTouchupText(text: string, env: NodeJS.ProcessEnv = {}): string {
  let safe = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 4 && /key|token|password|secret|credential|access.?code/i.test(name)) safe = safe.split(value).join('[redacted]');
  }
  return safe.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/\b((?:api[_ -]?key|access[_ -]?code|token|password|secret)\s*[:=]\s*)["']?[^\s,"';]+["']?/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000);
}

export interface ResultEvent {
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  structured_output?: {status?: string; closeup?: string; summary?: string; title?: string; changes?: unknown; ask?: unknown; parts?: unknown};
}

/** The worker's title, what-changed list and Ask, checked and made safe to show. */
function structured(answer: ResultEvent['structured_output'], publicText: (text: string) => string): Pick<TouchupResult, 'title' | 'changes' | 'ask' | 'supports'> {
  const out: Pick<TouchupResult, 'title' | 'changes' | 'ask' | 'supports'> = {};
  const supports = (answer as {supports?: unknown} | undefined)?.supports as Record<string, unknown> | undefined;
  if (supports && typeof supports.enabled === 'boolean')
    out.supports = {enabled: supports.enabled, ...(supports.enabled && (supports.type === 'tree(auto)' || supports.type === 'normal(auto)') ? {type: supports.type} : {})};
  if (typeof answer?.title === 'string' && answer.title.trim()) out.title = publicText(answer.title).replace(/[.!]+$/, '').slice(0, 40);
  if (Array.isArray(answer?.changes)) {
    const changes = answer.changes.flatMap((item: unknown): TouchupChange[] => {
      const change = item as Record<string, unknown> | null;
      if (!change || !['added', 'changed', 'assumed', 'estimated'].includes(change.tag as string) || typeof change.text !== 'string' || !change.text.trim()) return [];
      const tolerance = typeof change.toleranceMm === 'number' && Number.isFinite(change.toleranceMm) && change.toleranceMm >= 0 ? {toleranceMm: change.toleranceMm} : {};
      return [{tag: change.tag as TouchupChange['tag'], text: publicText(change.text).slice(0, 300), ...tolerance}];
    }).slice(0, 12);
    if (changes.length) out.changes = changes;
  }
  const ask = answer?.ask as Record<string, unknown> | undefined;
  if (ask && typeof ask.question === 'string' && ask.question.trim()) {
    const region = ask.region as Record<string, unknown> | undefined;
    const unit = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    out.ask = {question: publicText(ask.question).slice(0, 300),
      ...(typeof ask.photo === 'string' && /^[A-Za-z0-9._ -]{1,128}$/.test(ask.photo.split('/').at(-1) ?? '') ? {photo: ask.photo.split('/').at(-1)!} : {}),
      ...(region && unit(region.x) && unit(region.y) && unit(region.width) && unit(region.height)
        ? {region: {x: region.x as number, y: region.y as number, width: region.width as number, height: region.height as number}} : {})};
  }
  return out;
}

/**
 * The worker's per-filament colours for a multi-colour pass. Positions are
 * filaments, so a garbled entry keeps its place with the garbled fields
 * dropped; shifting the list would put later colours on the wrong parts.
 */
function partColours(answer: ResultEvent['structured_output'], publicText: (text: string) => string): TouchupResult['partColours'] {
  if (!Array.isArray(answer?.parts)) return undefined;
  const entries = answer.parts.slice(0, 64).map((item: unknown) => {
    const part = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const colour = typeof part.colour === 'string' ? /^#([0-9a-fA-F]{6})$/.exec(part.colour.trim()) : null;
    const name = typeof part.name === 'string' && part.name.trim() ? publicText(part.name).slice(0, 256) : undefined;
    const material = typeof part.material === 'string' && part.material.trim() ? publicText(part.material).slice(0, 64) : undefined;
    return {...(name ? {name} : {}), ...(colour ? {colour: `#${colour[1]!.toUpperCase()}`} : {}), ...(material ? {material} : {})};
  });
  return entries.some(entry => entry.colour || entry.name || entry.material) ? entries : undefined;
}

/** A printable STL: every triangle complete and every vertex coordinate finite. Cut-off or corrupt exports fail. */
export async function isValidStl(path: string): Promise<boolean> {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch { return false; }
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80);
    if (triangles > 0 && bytes.length === 84 + 50 * triangles) {
      for (let t = 0; t < triangles; t++) {
        const base = 84 + 50 * t + 12;
        for (let k = 0; k < 9; k++) if (!Number.isFinite(bytes.readFloatLE(base + 4 * k))) return false;
      }
      return true;
    }
  }
  const text = bytes.toString('latin1');
  if (!text.trimStart().startsWith('solid') || !/\bendsolid\b/.test(text)) return false;
  const vertices = [...text.matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/g)];
  const facets = (text.match(/\bendfacet\b/g) ?? []).length;
  if (vertices.length < 3 || vertices.length !== facets * 3) return false;
  return vertices.every(match => [match[1], match[2], match[3]].every(value => Number.isFinite(Number(value))));
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
/** One `claude -p --output-format stream-json` worker, run to its end: limits, cancellation, activity and the result event. */
export interface WorkerRun {
  sessionId?: string;
  sessionCwd?: string; limit?: WorkerLimit; resultEvent?: ResultEvent; worker?: TouchupResult['worker']; toolCalls: number; stopReason?: string; stderrTail: string;
  exitCode: number | null; error?: NodeJS.ErrnoException; seconds: number; publicText: (text: string) => string;
}
export type ProjectWorker = ((inv: TouchupInvocation, opts: {timeoutMs?: number; inactivityMs?: number; maxToolCalls?: number; onProgress?: (progress: TouchupProgress) => void; signal?: AbortSignal}) => Promise<WorkerRun>)
  /** false when this worker can't drive the person's browser (`--chrome`): only Claude Code can. */
  & {browser?: boolean};

export async function runClaudeWorker(inv: TouchupInvocation, opts: {
  spawn?: typeof nodeSpawn; timeoutMs?: number; inactivityMs?: number; maxToolCalls?: number; onProgress?: (progress: TouchupProgress) => void; signal?: AbortSignal;
} = {}): Promise<WorkerRun> {
  if (opts.signal?.aborted) return {toolCalls: 0, stopReason: 'cancelled', stderrTail: '', exitCode: null, seconds: 0, publicText: text => text};
  const spawn = opts.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? TOUCHUP_TIMEOUT_MS, maxToolCalls = opts.maxToolCalls ?? TOUCHUP_MAX_TOOL_CALLS;
  const inactivityMs = opts.inactivityMs ?? TOUCHUP_INACTIVITY_MS;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const publicText = (text: string) => publicTouchupText(text, {...inv.env, ...inv.mcpConfig.mcpServers.printer?.env, ...inv.redactionEnv});
  const child = spawn(inv.command, inv.args, {cwd: inv.cwd, env: inv.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let toolCalls = 0, lastText: string | undefined, resultEvent: ResultEvent | undefined, stopReason: string | undefined, stderrTail = '';
  let worker: TouchupResult['worker'], sessionId: string | undefined, limit: WorkerLimit | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const stop = (reason: string) => {
    if (stopReason !== undefined || !child.pid) return;
    stopReason = reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
  };
  const atLimit = (kind: WorkerLimit['kind'], value: number) => {
    if (stopReason !== undefined) return;
    limit = {kind, value}; stop(limitWords(limit));
  };
  const timer = setTimeout(() => atLimit('absolute', timeoutMs), timeoutMs);
  let idleTimer = setTimeout(() => atLimit('inactivity', inactivityMs), inactivityMs);
  const onAbort = () => stop('cancelled');
  opts.signal?.addEventListener('abort', onAbort, {once: true});
  child.stderr?.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-2000); });

  const lines = createInterface({input: child.stdout!});
  lines.on('line', line => {
    let event: {type?: string; message?: {content?: {type?: string; text?: string; name?: string}[]}} & ResultEvent;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event.type !== 'string') return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => atLimit('inactivity', inactivityMs), inactivityMs);
    if (typeof event.session_id === 'string' && event.session_id.trim() && sessionId !== event.session_id) {
      sessionId = event.session_id;
      opts.onProgress?.({seconds: seconds(), toolCalls, sessionId});
    }
    if (event.type === 'system' && (event as {subtype?: string}).subtype === 'init') {
      const init = event as {model?: string; apiKeySource?: string; tools?: string[]; plugins?: {name?: string; source?: string}[]; mcp_servers?: {name?: string; status?: string}[]};
      worker = {
        ...(init.model ? {model: init.model} : {}), ...(init.apiKeySource ? {apiKeySource: init.apiKeySource} : {}),
        tools: init.tools ?? [], plugins: (init.plugins ?? []).map(plugin => plugin.source ?? plugin.name ?? '?'),
        mcpServers: (init.mcp_servers ?? []).map(server => `${server.name}:${server.status}`),
      };
    } else if (event.type === 'assistant') {
      const activity: TouchupActivity[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') {
          toolCalls++;
          if (typeof block.name === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(block.name))
            activity.push({atMs: Date.now(), kind: 'tool', text: publicText(block.name)});
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastText = publicText(block.text);
          activity.push({atMs: Date.now(), kind: 'message', text: lastText});
        }
      }
      opts.onProgress?.({seconds: seconds(), toolCalls, lastText, activity});
      if (toolCalls > maxToolCalls) atLimit('tool-calls', maxToolCalls);
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
  clearTimeout(timer);
  clearTimeout(idleTimer);
  clearTimeout(killTimer);
  // A stopped worker's helpers (MCP servers, Blender bridges) may ignore SIGTERM: leave nothing behind.
  if (stopReason !== undefined && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
  opts.signal?.removeEventListener('abort', onAbort);
  return {...(sessionId ? {sessionId} : {}), ...(limit ? {limit} : {}), ...(resultEvent ? {resultEvent} : {}), ...(worker ? {worker} : {}), toolCalls, ...(stopReason !== undefined ? {stopReason} : {}), stderrTail,
    exitCode: ended.code, ...(ended.error ? {error: ended.error} : {}), seconds: seconds(), publicText};
}

export async function runTouchupWorker(inv: TouchupInvocation, pass: TouchupPass, opts: {
  spawn?: typeof nodeSpawn; timeoutMs?: number; inactivityMs?: number; maxToolCalls?: number; inputStlSha256?: string;
  onProgress?: (progress: TouchupProgress) => void; signal?: AbortSignal;
} = {}): Promise<TouchupResult> {
  const started0 = Date.now();
  if (opts.signal?.aborted) return {status: 'failed', reason: 'cancelled', renders: [], checkpoints: [], stats: {seconds: Math.round((Date.now() - started0) / 1000), toolCalls: 0}};
  const run = await (inv.worker ?? runClaudeWorker)(inv, opts);
  const {resultEvent, worker, toolCalls, stopReason, stderrTail, publicText} = run;
  const exitCode = run.exitCode, ended = run.error ? {error: run.error} : {} as {error?: NodeJS.ErrnoException};
  const seconds = () => run.seconds;

  const touched = join(pass.outDir, 'touched.stl');
  const checkpoints = await list(pass.checkpointsDir, '.stl');
  const renders = await list(pass.outDir, '.png');
  const validCheckpoints: string[] = [];
  for (const checkpoint of checkpoints) if (await isValidStl(checkpoint)) validCheckpoints.push(checkpoint);
  let model: string | undefined;
  if (await isValidStl(touched)) model = touched;
  else model = validCheckpoints.at(-1);

  const partsPath = join(pass.outDir, 'touched.3mf');
  // The 3MF becomes the model that prints, so it is validated like one: a truncated
  // archive or a stray zip falls back to the merged mesh instead of becoming the model.
  // It also only counts beside the final mesh it was exported with — never a checkpoint's.
  const parts = model === touched ? await readFile(partsPath).then(bytes => {
    try { inspectModelFile(bytes, '3mf'); return partsPath; } catch { return undefined; }
  }, () => undefined) : undefined;
  const base = {renders, checkpoints: validCheckpoints, ...(run.sessionId ? {sessionId: run.sessionId} : {}),
    resumable: !!run.sessionId && (run.limit !== undefined || (!resultEvent && stopReason !== 'cancelled')),
    ...(run.limit ? {limit: run.limit} : {}), ...(parts ? {parts} : {}), ...(worker ? {worker} : {}), stats: {seconds: seconds(), toolCalls, ...(resultEvent?.total_cost_usd !== undefined ? {costUsd: resultEvent.total_cost_usd} : {})}};
  const withModel = model ? {model} : {};
  const answer = resultEvent?.structured_output;
  const declared = parts ? partColours(answer, publicText) : undefined;
  if (declared) Object.assign(base, {partColours: declared});
  const summary = {...(answer?.summary ? {summary: publicText(answer.summary)} : {}), ...structured(answer, publicText)};
  const f3d = join(pass.outDir, 'touched.f3d'), parameters = join(pass.outDir, 'touched.parameters.json');
  const design = await stat(f3d).then(info => info.isFile(), () => false)
    ? {design: {f3d, ...(await stat(parameters).then(info => info.isFile(), () => false) ? {parameters} : {})}} : {};
  Object.assign(base, design);

  if (ended.error) {
    const reason = ended.error.code === 'ENOENT' ? `Claude Code wasn't found at ${inv.command}. Install it or sign in.` : `Claude Code couldn't start: ${ended.error.message}`;
    return {status: 'failed', reason: publicText(reason), ...withModel, ...base};
  }
  if (stopReason === 'cancelled') return {status: 'failed', reason: 'cancelled', ...withModel, ...base};
  if (stopReason !== undefined) return {status: 'capped', reason: stopReason, ...withModel, ...base};
  if (!resultEvent || resultEvent.is_error || !answer) {
    const reason = resultEvent?.result?.trim() || stderrTail.trim().split('\n').at(-1) || `the worker exited with code ${exitCode}`;
    return {status: 'failed', reason: publicText(reason), ...withModel, ...base};
  }
  if (answer.status === 'failed') return {status: 'failed', reason: publicText(answer.summary?.trim() || 'the worker could not finish'), ...withModel, ...base};
  if (answer.status === 'needs_closeup') return {status: 'needs_closeup', closeup: publicText(answer.closeup ?? 'a part of the object'), ...summary, ...withModel, ...base};
  if (!model) return {status: 'failed', reason: 'no model was saved', ...summary, ...base};
  // The rules require a checkpoint after every fix: a touch-up of a scan with none saved fixed nothing.
  // A make job (no scan) has nothing to be unchanged.
  if (pass.scanPaths.length > 0 && validCheckpoints.length === 0) return {status: 'unchanged', ...summary, model, ...base};
  if (opts.inputStlSha256 && await sha256(model) === opts.inputStlSha256) return {status: 'unchanged', ...summary, model, ...base};
  return {status: 'done', ...summary, model, ...base};
}
