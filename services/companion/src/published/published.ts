import {writeFileSync, existsSync} from 'node:fs';
import {readdir, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, extname, join} from 'node:path';
import {isolatedClaudeEnv, type TouchupInvocation} from '../touchup/invocation.js';
import {prepareTouchupPass, type TouchupPass} from '../touchup/inputs.js';
import {runClaudeWorker, type TouchupProgress} from '../touchup/runner.js';

/**
 * PRD §8.11: print a published model. The worker gets the designer's own file with the person's own
 * logins and never models a look-alike; the companion picks the download up and keeps it as published.
 */

const SITES: {host: RegExp; site: string}[] = [
  {host: /(^|\.)makerworld\.com$/i, site: 'MakerWorld'},
  {host: /(^|\.)printables\.com$/i, site: 'Printables'},
  {host: /(^|\.)prusaprinters\.org$/i, site: 'Printables'},
  {host: /(^|\.)thingiverse\.com$/i, site: 'Thingiverse'},
  {host: /(^|\.)thangs\.com$/i, site: 'Thangs'},
  {host: /(^|\.)cults3d\.com$/i, site: 'Cults'},
  {host: /(^|\.)myminifactory\.com$/i, site: 'MyMiniFactory'},
  {host: /(^|\.)(grabcad\.com|makershop\.co|printables\.cz)$/i, site: 'Model library'},
  {host: /(^|\.)crealitycloud\.com$/i, site: 'Creality Cloud'},
];

/** The first link in a request to a published model's page, and the site's name. */
export function publishedLink(text: string | undefined): {url: string; site: string} | undefined {
  for (const match of (text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = match[0].replace(/[).,;:!?\]]+$/, '');
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const site = SITES.find(entry => entry.host.test(url.hostname));
    if ((site || /\.(3mf|stl)$/i.test(url.pathname)) && url.pathname.length > 1) return {url: url.toString(), site: site?.site ?? url.hostname};
  }
  return undefined;
}

/**
 * Claude in Chrome's native messaging host, which `claude --chrome` drives. Claude Code installs it for each Chromium
 * browser it finds; the extension may live in any of them (David's is in Brave, Nov 6).
 */
const HOST = 'com.anthropic.claude_code_browser_extension.json';
const SUPPORT = join(homedir(), 'Library', 'Application Support');
export const CHROME_HOSTS = [['Google', 'Chrome'], ['BraveSoftware', 'Brave-Browser'], ['Microsoft Edge'], ['Chromium']]
  .map(parts => join(SUPPORT, ...parts, 'NativeMessagingHosts', HOST));
export const CHROME_HOST = CHROME_HOSTS[0]!;
export function chromeAvailable(paths: string | string[] = CHROME_HOSTS): boolean { return (Array.isArray(paths) ? paths : [paths]).some(path => existsSync(path)); }

export const PUBLISHED_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'summary'],
  properties: {
    status: {enum: ['downloaded', 'needs_file', 'failed'], description: 'downloaded: the designer\'s file is in ~/Downloads (or the output folder); needs_file: you could not get it; failed: something else went wrong'},
    summary: {type: 'string', description: 'One or two plain sentences for the person: what you got, or why you could not'},
    reason: {enum: ['not_signed_in', 'download_not_saved', 'site_error', 'not_found', 'other'], description: 'When status is not downloaded, why: not_signed_in only when the site itself shows you are signed out or asks for a sign-in; download_not_saved when the site served the file but no file reached the folder; site_error when the site or its file server answered an error; not_found when the page or profile is not there'},
    model: {type: 'object', additionalProperties: false, required: ['title', 'site', 'url'], properties: {
      title: {type: 'string', description: 'The model\'s name as published'},
      designer: {type: 'string'}, site: {type: 'string'}, url: {type: 'string'}, licence: {type: 'string'},
    }},
    download: {type: 'object', additionalProperties: false, required: ['files'], properties: {
      files: {type: 'array', minItems: 1, maxItems: 8, items: {type: 'string'}, description: 'Each file the request needs, by its exact name in ~/Downloads (or the output folder)'},
      profile: {type: 'string', description: 'The print profile or variant you downloaded'},
    }},
  },
} as const;

const RULES = `You get a published 3D model's own file for the person, on their Mac, as they would themselves.
- Never model, redraw or rebuild the object, and never make a look-alike from the page's pictures. Pictures are only for choosing a variant.
- First, when you have the browser tools (Claude in Chrome), open the page in the person's own browser (Chrome, or the Chromium browser their extension runs in), choose the print profile or file that matches their request (for MakerWorld, the print profile; its 3MF keeps the designer's plates and colours), and download it with the site's own Download button. It lands in ~/Downloads. Do not read cookies, keychains or app token stores.
- Click each file's Download once. Never start downloads from JavaScript (blob or link clicks): the browser holds them behind a "download multiple files" prompt you can't see. Don't click again to check: each click saves another copy. Counterpart checks ~/Downloads itself for every file that arrived while you worked, so report each file the site served, by the name it offered.
- Existing Downloads files are candidates for the person to confirm, never proof of origin from a name alone.
- When the site offers print profiles (MakerWorld does), download the chosen profile's 3MF with that profile selected (MakerWorld's Download 3MF), never the raw model files (an STL, or a zip of STLs): those lose the designer's plates and settings. Otherwise prefer a 3MF, then an STL. Report every file the request needs by its exact name (for example the model and its add-on part).
- If you can't get the file (not signed in, no browser, the site refuses), set status to needs_file with its reason. Never substitute another model.
- Say not_signed_in only when the site itself shows you are signed out or asks for a sign-in. Then leave that page open in Chrome at its sign-in, so the person can sign in once there; Chrome keeps the sign-in.
- Report status downloaded when the site served each file. If the site answered an error for the file itself (not its analytics or telemetry hosts), report site_error.
- You may use WebFetch or WebSearch to read the page and the model's details: title, designer, licence and the list of profiles.`;

export interface PublishedInput {pass: TouchupPass; claudePath: string; request: string; link: {url: string; site: string};
  chrome: boolean; sourceEnv?: NodeJS.ProcessEnv}

/** The `claude -p` call that gets the designer's file: no geometry tools, the browser when it's there. */
export function buildPublishedInvocation(input: PublishedInput): TouchupInvocation {
  const {pass} = input;
  // Published retrieval has no printer tools: neither configured MCP exposes a download API.
  const mcpConfig = {mcpServers: {}};
  const mcpConfigPath = join(pass.dir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {mode: 0o600});
  const args = [
    '-p', '--model', 'claude-opus-5-5', '--effort', 'high',
    '--mcp-config', mcpConfigPath, '--strict-mcp-config',
    ...(input.chrome ? ['--chrome'] : []),
    '--tools', 'Read,Glob,WebSearch,WebFetch',
    '--allowedTools', ['Read', 'Glob', 'WebSearch', 'WebFetch', ...(input.chrome ? ['mcp__claude-in-chrome'] : [])].join(','),
    '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--append-system-prompt', RULES,
    '--json-schema', JSON.stringify(PUBLISHED_RESULT_SCHEMA),
    '--output-format', 'stream-json', '--verbose',
    `The person wants this published model printed: ${input.link.url} (${input.link.site}).\n\nTheir request: ${input.request.trim()}\n\nOutput folder: ${pass.outDir}`,
  ];
  return {command: input.claudePath, args, env: isolatedClaudeEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig};
}

export interface PublishedModel {title: string; designer?: string; site: string; url: string; licence?: string}
/** Why the worker didn't get the file, in its own structured words (never read from its prose). */
export type PublishedMissReason = 'not_signed_in' | 'download_not_saved' | 'site_error' | 'not_found' | 'other';
/** How the worker run went, for the companion log: enough to find its transcript and see why it ended. */
export interface PublishedRunFacts {toolCalls: number; seconds: number; exitCode: number | null; stopReason?: string; sessionId?: string; chrome?: boolean}
export type PublishedResult =
  | {status: 'downloaded'; files: string[]; profile?: string; model?: PublishedModel; summary?: string; run?: PublishedRunFacts; arrived?: string[]}
  | {status: 'needs_file'; model?: PublishedModel; summary?: string; reason?: PublishedMissReason; candidate?: string; /** false when the pass had no browser to download with */ browser?: boolean; run?: PublishedRunFacts; arrived?: string[]; /** macOS privacy refused ~/Downloads */ downloadsDenied?: true}
  | {status: 'failed'; reason: string; model?: PublishedModel; run?: PublishedRunFacts; arrived?: string[]; downloadsDenied?: true};
const MISS_REASONS: readonly PublishedMissReason[] = ['not_signed_in', 'download_not_saved', 'site_error', 'not_found', 'other'];

const MODEL_FILE = /\.(3mf|stl)$/i;
/** The files the worker named, in ~/Downloads or the pass output, whenever downloaded (the person may have fetched them already). All or nothing. */
export async function findNamed(fileNames: string[], folders: string[]): Promise<{found: string[]; missing: string[]}> {
  const found: string[] = [], missing: string[] = [];
  for (const fileName of fileNames) {
    const name = fileName;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) { missing.push(name); continue; }
    let path: string | undefined;
    if (MODEL_FILE.test(name)) for (const folder of folders) {
      const candidate = join(folder, name), info = await lstat(candidate).catch(() => undefined);
      if (info?.isFile() && info.size > 0) { path = candidate; break; }
    }
    if (path) { if (!found.includes(path)) found.push(path); } else missing.push(name);
  }
  return {found, missing};
}
/**
 * Whether the companion can list a folder. macOS privacy refuses ~/Downloads (EPERM) to an app the person hasn't
 * allowed; that must never read as an empty folder, or a starter would download again instead of saying so.
 */
export async function folderAccess(path: string): Promise<'ok' | 'denied' | 'missing'> {
  try { await readdir(path); return 'ok'; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'missing';
  }
}
/**
 * Every model file that arrived in the folders while the pass ran: born (or, where the file system keeps no birth
 * time, written) between its start and its end. Hidden files are a browser's unfinished downloads, never counted.
 * Nov 6: the worker's own check of ~/Downloads missed files its clicks had saved there; the companion looks itself.
 */
/** What each folder held before the worker ran. A folder that couldn't be listed has no entry: the time window decides. */
export type FolderSnapshot = ReadonlyMap<string, ReadonlySet<string>>;
export async function snapshotFolders(folders: string[]): Promise<FolderSnapshot> {
  const snapshot = new Map<string, Set<string>>();
  for (const folder of folders) {
    const names = await readdir(folder).catch(() => undefined);
    if (names) snapshot.set(folder, new Set(names.map(name => join(folder, name))));
  }
  return snapshot;
}
export async function arrivedDuring(folders: string[], sinceMs: number, untilMs: number, before?: FolderSnapshot): Promise<string[]> {
  if (untilMs < sinceMs) return [];
  const arrived: {path: string; atMs: number}[] = [];
  for (const folder of folders) {
    const seen = before?.get(folder);
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (name.startsWith('.') || !MODEL_FILE.test(name)) continue;
      const path = join(folder, name), info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.size === 0) continue;
      const atMs = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      // Filesystem clocks may lag Date.now() by a tick. A pre-worker directory
      // snapshot establishes arrival without assuming the clocks agree.
      if (seen ? !seen.has(path) : atMs >= sinceMs && atMs <= untilMs) arrived.push({path, atMs});
    }
  }
  return arrived.sort((a, b) => a.atMs - b.atMs).map(file => file.path);
}
/** The newest model file downloaded since the pass began: only ever offered as a candidate, never taken. */
export async function newestDownload(folders: string[], sinceMs: number): Promise<string | undefined> {
  const recent: {path: string; mtimeMs: number}[] = [];
  for (const folder of folders) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!MODEL_FILE.test(name)) continue;
      const path = join(folder, name), info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.size > 0 && info.mtimeMs >= sinceMs) recent.push({path, mtimeMs: info.mtimeMs});
    }
  }
  return recent.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

const clean = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : undefined;
function model(answer: unknown, link: {url: string; site: string}): PublishedModel | undefined {
  const value = (answer as {model?: Record<string, unknown>} | undefined)?.model;
  const title = clean(value?.title, 120);
  if (!title) return undefined;
  const designer = clean(value?.designer, 80), licence = clean(value?.licence, 80);
  // The page the person linked is the credit; the worker can't move it elsewhere.
  return {title, site: link.site, url: link.url, ...(designer ? {designer} : {}), ...(licence ? {licence} : {})};
}

/** Runs the worker and finds its download. */
export async function runPublishedWorker(inv: TouchupInvocation, pass: TouchupPass, link: {url: string; site: string}, opts: {
  downloads?: string; spawn?: typeof import('node:child_process').spawn;
  onProgress?: (progress: TouchupProgress) => void; signal?: AbortSignal; startedAtMs?: number;
} = {}): Promise<PublishedResult> {
  const startedAtMs = opts.startedAtMs ?? Date.now();
  const folders = [opts.downloads ?? join(homedir(), 'Downloads'), pass.outDir];
  const before = await snapshotFolders(folders);
  const run = await (inv.worker ?? runClaudeWorker)(inv, {...(opts.spawn ? {spawn: opts.spawn} : {}), ...(opts.onProgress ? {onProgress: opts.onProgress} : {}), ...(opts.signal ? {signal: opts.signal} : {})});
  const endedAtMs = Date.now();
  const answer = run.resultEvent?.structured_output as Record<string, unknown> | undefined;
  const credit = model(answer, link);
  const landed = await arrivedDuring(folders, startedAtMs, endedAtMs, before);
  const denied = await folderAccess(folders[0]!) === 'denied';
  const arrived = {...(landed.length ? {arrived: landed} : {}), ...(denied ? {downloadsDenied: true as const} : {})};
  const sessionId = typeof run.resultEvent?.session_id === 'string' ? run.resultEvent.session_id : undefined;
  const facts: PublishedRunFacts = {toolCalls: run.toolCalls, seconds: run.seconds, exitCode: run.exitCode,
    ...(run.stopReason !== undefined ? {stopReason: run.stopReason} : {}), ...(sessionId ? {sessionId} : {})};
  const withModel = {...(credit ? {model: credit} : {}), run: facts, ...arrived};
  if (run.error) return {status: 'failed', reason: run.error.code === 'ENOENT' ? `Claude Code wasn't found at ${inv.command}.` : `Claude Code couldn't start: ${run.error.message}`, ...withModel};
  if (run.stopReason) return {status: 'failed', reason: run.stopReason, ...withModel};
  if (!answer || run.exitCode !== 0 || run.resultEvent?.is_error) return {status: 'failed', reason: run.resultEvent?.result?.trim() || run.stderrTail.trim().split('\n').at(-1) || 'the worker stopped', ...withModel};
  const summary = clean(answer.summary, 500);
  if (answer.status === 'failed') return {status: 'failed', reason: summary ?? 'the worker could not finish', ...withModel};
  const download = answer.download as {files?: unknown; profile?: unknown} | undefined;
  const names = Array.isArray(download?.files) ? download.files.map(name => clean(name, 255)).filter((name): name is string => !!name) : [];
  // Only files that really exist count, whatever the worker says, and every one it named must.
  const named = answer.status === 'downloaded' && names.length ? await findNamed(names, folders) : {found: [], missing: names};
  // New since the snapshot, or rewritten since the pass began (the same name downloaded again).
  const fresh = await Promise.all(named.found.map(async path =>
    before.get(dirname(path))?.has(path) === false || (await lstat(path)).mtimeMs >= startedAtMs));
  if (named.found.length && !named.missing.length && fresh.every(Boolean)) {
    const profile = clean(download?.profile, 120);
    return {status: 'downloaded', files: named.found, ...(profile ? {profile} : {}), ...withModel, ...(summary ? {summary} : {})};
  }
  // A model file that arrived since the pass began, though not one it named: offered, never assumed.
  const candidate = named.found[0] ?? await newestDownload(folders.slice(0, 1), startedAtMs - 60_000);
  // The worker said it downloaded files that aren't there: the download wasn't saved, whatever it thought.
  const said = MISS_REASONS.find(value => value === answer.reason);
  const reason: PublishedMissReason = answer.status === 'downloaded' ? 'download_not_saved' : said ?? 'other';
  return {status: 'needs_file', reason, ...withModel, ...(summary ? {summary} : {}), ...(candidate ? {candidate} : {})};
}

export interface PublishedPassInput {
  worker?: import('../touchup/runner.js').ProjectWorker;
  root: string; photos: string[]; request: string; link: {url: string; site: string};
  claudePath: string; designTools?: string[];
  startedAtMs: number; signal?: AbortSignal; onProgress?: (progress: TouchupProgress) => void; onStage?: (id: 'working') => void;
}

/** The production pass: a sealed pass folder, then the worker (with Chrome when it's set up). */
export async function defaultRunPublished(input: PublishedPassInput, deps: {chrome?: () => boolean; downloads?: string; spawn?: typeof import('node:child_process').spawn} = {}): Promise<PublishedResult> {
  const pass = await prepareTouchupPass({root: input.root, objectId: 'pass', scan: [], photos: input.photos, requirePhotos: false});
  input.onStage?.('working');
  // The browser only when Chrome's extension is set up and the selected worker can drive it (Claude Code).
  const chrome = (deps.chrome ?? chromeAvailable)() && input.worker?.browser !== false;
  const inv = buildPublishedInvocation({pass, claudePath: input.claudePath, request: input.request, link: input.link, chrome});
  inv.worker = input.worker;
  const result = await runPublishedWorker(inv, pass, input.link, {startedAtMs: input.startedAtMs, ...(deps.downloads ? {downloads: deps.downloads} : {}),
    ...(deps.spawn ? {spawn: deps.spawn} : {}), ...(input.onProgress ? {onProgress: input.onProgress} : {}), ...(input.signal ? {signal: input.signal} : {})});
  // Without the browser (Linux, or Chrome's extension not set up) a sign-in can't help: the person adds the files.
  const run = result.run ? {...result.run, chrome} : undefined;
  return result.status === 'needs_file' ? {...result, browser: chrome, ...(run ? {run} : {})} : {...result, ...(run ? {run} : {})};
}
