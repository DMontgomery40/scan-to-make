import {writeFileSync, existsSync} from 'node:fs';
import {readdir, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {extname, join} from 'node:path';
import type {PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import {isolatedClaudeEnv, printerServer, type TouchupInvocation} from '../touchup/invocation.js';
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
  {host: /(^|\.)crealitycloud\.com$/i, site: 'Creality Cloud'},
];

/** The first link in a request to a published model's page, and the site's name. */
export function publishedLink(text: string | undefined): {url: string; site: string} | undefined {
  for (const match of (text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const raw = match[0].replace(/[).,;:!?\]]+$/, '');
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const site = SITES.find(entry => entry.host.test(url.hostname));
    if (site && url.pathname.length > 1) return {url: url.toString(), site: site.site};
  }
  return undefined;
}

/** Claude in Chrome's native messaging host, which `claude --chrome` drives. */
export const CHROME_HOST = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.anthropic.claude_code_browser_extension.json');
export function chromeAvailable(path = CHROME_HOST): boolean { return existsSync(path); }

/** Printer MCP tools that build or change geometry: never offered while getting a published file. */
export const DESIGN_TOOLS = ['blender_mcp_call', 'blender_mcp_edit_model', 'blender_mcp_status', 'fusion_mcp_status', 'fusion_mcp_new_design', 'fusion_mcp_call', 'fusion_mcp_export'];

export const PUBLISHED_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'summary'],
  properties: {
    status: {enum: ['downloaded', 'needs_file', 'failed'], description: 'downloaded: the designer\'s file is in ~/Downloads (or the output folder); needs_file: you could not get it; failed: something else went wrong'},
    summary: {type: 'string', description: 'One or two plain sentences for the person: what you got, or why you could not'},
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
- First look in ~/Downloads (Glob): the person may already have downloaded the designer's files. Match them to the request by name (the model's name, the variant, the size).
- If the printer MCP has a tool that downloads models from this site, use it next.
- Otherwise, when you have the browser tools (Claude in Chrome), open the page in the person's own Chrome, choose the print profile or file that matches their request (for MakerWorld, the print profile; its 3MF keeps the designer's plates and colours), and download it. It lands in ~/Downloads. Do not read cookies, keychains or app token stores.
- Prefer a 3MF; otherwise an STL. Report every file the request needs by its exact name (for example the model and its add-on part).
- If you can't get the file (not signed in, no browser, the site refuses), set status to needs_file. Never substitute another model.
- You may use WebFetch or WebSearch to read the page and the model's details: title, designer, licence and the list of profiles.`;

export interface PublishedInput {pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; request: string; link: {url: string; site: string};
  chrome: boolean; designTools?: string[]; sourceEnv?: NodeJS.ProcessEnv}

/** The `claude -p` call that gets the designer's file: no geometry tools, the browser when it's there. */
export function buildPublishedInvocation(input: PublishedInput): TouchupInvocation {
  const {pass} = input;
  const mcpConfig = {mcpServers: {printer: printerServer(input.printer)}};
  const mcpConfigPath = join(pass.dir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {mode: 0o600});
  const disallowed = [...new Set([...DESIGN_TOOLS, ...(input.designTools ?? [])])].map(name => `mcp__printer__${name}`);
  const args = [
    '-p', '--model', 'claude-opus-5-5', '--effort', 'high',
    '--mcp-config', mcpConfigPath, '--strict-mcp-config',
    ...(input.chrome ? ['--chrome'] : []),
    '--tools', 'Read,Glob,WebSearch,WebFetch',
    '--allowedTools', ['Read', 'Glob', 'WebSearch', 'WebFetch', 'mcp__printer', ...(input.chrome ? ['mcp__claude-in-chrome'] : [])].join(','),
    '--disallowedTools', disallowed.join(','),
    '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--append-system-prompt', RULES,
    '--json-schema', JSON.stringify(PUBLISHED_RESULT_SCHEMA),
    '--output-format', 'stream-json', '--verbose',
    `The person wants this published model printed: ${input.link.url} (${input.link.site}).\n\nTheir request: ${input.request.trim()}\n\nOutput folder: ${pass.outDir}`,
  ];
  return {command: input.claudePath, args, env: isolatedClaudeEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig};
}

export interface PublishedModel {title: string; designer?: string; site: string; url: string; licence?: string}
export type PublishedResult =
  | {status: 'downloaded'; files: string[]; profile?: string; model?: PublishedModel; summary?: string}
  | {status: 'needs_file'; model?: PublishedModel; summary?: string; candidate?: string}
  | {status: 'failed'; reason: string; model?: PublishedModel};

const MODEL_FILE = /\.(3mf|stl)$/i;
/** The files the worker named, in ~/Downloads or the pass output, whenever downloaded (the person may have fetched them already). All or nothing. */
export async function findNamed(fileNames: string[], folders: string[]): Promise<{found: string[]; missing: string[]}> {
  const found: string[] = [], missing: string[] = [];
  for (const fileName of fileNames) {
    const name = fileName.split('/').at(-1)!;
    let path: string | undefined;
    if (MODEL_FILE.test(name)) for (const folder of folders) {
      const candidate = join(folder, name), info = await stat(candidate).catch(() => undefined);
      if (info?.isFile() && info.size > 0) { path = candidate; break; }
    }
    if (path) { if (!found.includes(path)) found.push(path); } else missing.push(name);
  }
  return {found, missing};
}
/** The newest model file downloaded since the pass began: only ever offered as a candidate, never taken. */
export async function newestDownload(folders: string[], sinceMs: number): Promise<string | undefined> {
  const recent: {path: string; mtimeMs: number}[] = [];
  for (const folder of folders) {
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      if (!MODEL_FILE.test(name)) continue;
      const path = join(folder, name), info = await stat(path).catch(() => undefined);
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
  const run = await runClaudeWorker(inv, {...(opts.spawn ? {spawn: opts.spawn} : {}), ...(opts.onProgress ? {onProgress: opts.onProgress} : {}), ...(opts.signal ? {signal: opts.signal} : {})});
  const answer = run.resultEvent?.structured_output as Record<string, unknown> | undefined;
  const credit = model(answer, link);
  const withModel = credit ? {model: credit} : {};
  if (run.error) return {status: 'failed', reason: run.error.code === 'ENOENT' ? `Claude Code wasn't found at ${inv.command}.` : `Claude Code couldn't start: ${run.error.message}`, ...withModel};
  if (run.stopReason) return {status: 'failed', reason: run.stopReason, ...withModel};
  if (!answer || run.resultEvent?.is_error) return {status: 'failed', reason: run.resultEvent?.result?.trim() || run.stderrTail.trim().split('\n').at(-1) || 'the worker stopped', ...withModel};
  const summary = clean(answer.summary, 500);
  if (answer.status === 'failed') return {status: 'failed', reason: summary ?? 'the worker could not finish', ...withModel};
  const download = answer.download as {files?: unknown; profile?: unknown} | undefined;
  const names = Array.isArray(download?.files) ? download.files.map(name => clean(name, 255)).filter((name): name is string => !!name) : [];
  // Only files that really exist count, whatever the worker says, and every one it named must.
  const folders = [opts.downloads ?? join(homedir(), 'Downloads'), pass.outDir];
  const named = answer.status === 'downloaded' && names.length ? await findNamed(names, folders) : {found: [], missing: names};
  if (named.found.length && !named.missing.length) {
    const profile = clean(download?.profile, 120);
    return {status: 'downloaded', files: named.found, ...(profile ? {profile} : {}), ...withModel, ...(summary ? {summary} : {})};
  }
  // A model file that arrived since the pass began, though not one it named: offered, never assumed.
  const candidate = named.found[0] ?? await newestDownload(folders.slice(0, 1), startedAtMs - 60_000);
  return {status: 'needs_file', ...withModel, ...(summary ? {summary} : {}), ...(candidate ? {candidate} : {})};
}

export interface PublishedPassInput {
  root: string; photos: string[]; request: string; link: {url: string; site: string};
  handoff: {process: PrinterMcpProcess}; claudePath: string; designTools?: string[];
  startedAtMs: number; signal?: AbortSignal; onProgress?: (progress: TouchupProgress) => void; onStage?: (id: 'working') => void;
}

/** The production pass: a sealed pass folder, then the worker (with Chrome when it's set up). */
export async function defaultRunPublished(input: PublishedPassInput, deps: {chrome?: () => boolean; downloads?: string; spawn?: typeof import('node:child_process').spawn} = {}): Promise<PublishedResult> {
  const pass = await prepareTouchupPass({root: input.root, objectId: 'pass', scan: [], photos: input.photos, requirePhotos: false});
  input.onStage?.('working');
  const inv = buildPublishedInvocation({pass, printer: input.handoff.process, claudePath: input.claudePath, request: input.request, link: input.link,
    chrome: (deps.chrome ?? chromeAvailable)(), ...(input.designTools ? {designTools: input.designTools} : {})});
  return runPublishedWorker(inv, pass, input.link, {startedAtMs: input.startedAtMs, ...(deps.downloads ? {downloads: deps.downloads} : {}),
    ...(deps.spawn ? {spawn: deps.spawn} : {}), ...(input.onProgress ? {onProgress: input.onProgress} : {}), ...(input.signal ? {signal: input.signal} : {})});
}
