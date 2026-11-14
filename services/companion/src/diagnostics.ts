import {open} from 'node:fs/promises';
import {packageLabel, readDiagnostics, type PrinterBackend, type PrinterSession} from '@scan-to-make/printer-handoff';

/**
 * Export Diagnostics' companion part (#799): what the app itself knows, redacted, and each printer MCP's own bundle
 * (`counterpart_diagnostics`), in the same `{files, notes}` shape the MCPs use. The Mac adds it to its ZIP as the
 * `companion/` folder; Linux saves it as its ZIP. The app names no MCP file or path (PRD §8.0): an MCP's files are
 * added under `mcp/<printer>-<package>/` exactly as the MCP named them, and an MCP without the tool gets one line.
 */
export interface BundleFile {name: string; content: string; truncated: boolean}
export interface DiagnosticsBundle {files: BundleFile[]; notes: string[]}

export const DIAGNOSTICS_LIMITS = {
  /** The newest part of events.ndjson. */
  eventsBytes: 1024 * 1024,
  /** What all the MCPs' bundles may add together, shared equally between the printers. */
  mcpBytes: 3 * 1024 * 1024,
  /** One MCP's bundle at most (its result comes back twice, as JSON and as text, inside the 8 MiB result limit). */
  mcpEachBytes: 1536 * 1024,
  mcpMinBytes: 128 * 1024,
  /** How many printers' MCPs are asked. */
  printers: 8,
  /** The whole answer, as JSON, inside the control socket's 8 MiB reply. */
  replyBytes: 6 * 1024 * 1024,
  /** Starting an MCP, reading its printer info and its bundle, inside the method's 45 s. */
  mcpTimeoutMs: 30_000,
  /** The printer software list, inside the same 45 s. */
  softwareTimeoutMs: 15_000,
};
export type DiagnosticsLimits = typeof DIAGNOSTICS_LIMITS;

/** One printer, as the bundle lists it: only these fields, never a config or its environment. */
export interface DiagnosticsPrinter {
  id: string; name: string; model?: string; address?: string; state?: string;
  /** The MCP it runs, as people know it, and that MCP's version. */
  mcp: string; mcpVersion?: string; contract?: string;
}

export interface DiagnosticsSource {
  /** `<data root>/events.ndjson`. */
  eventsPath?: string;
  printers?(): DiagnosticsPrinter[];
  /** `printers.mcps`' packages (Settings → Printers' printer software). */
  software?(): Promise<readonly SoftwarePackage[]>;
  /** Each printer's own MCP session, as the companion runs it. */
  sessions?(): {destinationId: string; printer: string; session: PrinterSession}[];
  /** The home folder, shown as `~`. */
  home?: string;
  limits?: Partial<DiagnosticsLimits>;
}
/** The fields of a `printers.mcps` package the bundle keeps. */
export interface SoftwarePackage {
  package: string; label: string; installed: boolean; version?: string; latestVersion?: string; available?: string; upToDate?: true;
  installs: {kind: string; path?: string; version?: string}[];
  uses: {printer: string; kind: string; version?: string; managed: boolean; words: string}[];
  usedBy?: string[];
}

// Names that say a value is a secret: in `key=value`, `key: value` and JSON, whatever the case or joining
// (`accessCode`, `BAMBU_ACCESS_CODE`, `refresh_token`, `X-Api-Key`).
const SECRET_WORD = String.raw`(?:password|passwd|passcode|pwd|secret|token|api[_-]?key|apikey|access[_-]?code|accesscode|access[_-]?key|authorization|auth|cookie|credential|private[_-]?key|signature|ticket|login|email|user[_-]?info)`;
const SECRET_KEY = String.raw`[A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*`;
const SECRET_NAME = new RegExp(SECRET_WORD, 'i');
const RULES: [RegExp, string][] = [
  // PEM private keys, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  // scheme://user:password@host keeps its host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"'<>]+(?::[^/\s@"'<>]*)?@/gi, '$1[redacted]@'],
  // Escaped JSON inside a string: \"accessCode\":\"1234\".
  [new RegExp(String.raw`(\\"${SECRET_KEY}\\"\s*:\s*)\\"(?:[^"\\]|\\[^"])*\\"`, 'gi'), '$1\\"[redacted]\\"'],
  // JSON: "accessCode": "1234" (a number or bare word too).
  [new RegExp(String.raw`("${SECRET_KEY}"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^\s,}\]]+)`, 'gi'), '$1"[redacted]"'],
  // key=value, key: value, ?key=value&, --key value.
  [new RegExp(String.raw`(\b${SECRET_KEY}\s*[=:]\s*|--${SECRET_KEY}\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]"']+)`, 'gi'), '$1[redacted]'],
  // Authorization schemes.
  [/\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 [redacted]'],
  // Cookie headers, whole line.
  [/^((?:Set-)?Cookie:).*$/gim, '$1 [redacted]'],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[redacted token]'],
  // API keys with a known prefix.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  // Email addresses (an Apple Account, a Bambu account).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[redacted email]'],
  // A pairing link carries its code.
  [/scantomake:\/\/pair\?[^\s"']+/g, 'scantomake://pair?[redacted]'],
];

/** Every secret the bundle must never carry: the printers' configured secret values (access codes, keys, passwords). */
export function configuredSecrets(sessions: readonly {session: PrinterSession}[]): string[] {
  const values = new Set<string>();
  for (const {session} of sessions) {
    for (const [key, value] of Object.entries(session.config.process.env ?? {})) {
      if (typeof value === 'string' && value.length >= 4 && SECRET_NAME.test(key)) values.add(value);
    }
  }
  // Longest first, so one secret that contains another goes whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/** Text with every secret removed; the home folder reads `~`. Serials, hosts and versions stay. */
export function redact(text: string, secrets: readonly string[] = [], home?: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** The newest `max` bytes of text, starting at a whole line (a cut line could hold half a secret's label). */
export function tail(text: string, max: number): {content: string; truncated: boolean} {
  if (bytes(text) <= max) return {content: text, truncated: false};
  const buffer = Buffer.from(text, 'utf8');
  const cut = buffer.subarray(buffer.length - max).toString('utf8');
  const newline = cut.indexOf('\n');
  return {content: newline >= 0 ? cut.slice(newline + 1) : '', truncated: true};
}

/** The newest `max` bytes of a file, from a whole line; undefined when there is no file. */
async function tailFile(path: string, max: number): Promise<{content: string; truncated: boolean} | undefined> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return undefined; }
  try {
    const {size} = await handle.stat();
    const length = Math.min(size, max + 1);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    if (size <= max) return {content: text, truncated: false};
    const newline = text.indexOf('\n');
    return {content: newline >= 0 ? text.slice(newline + 1) : '', truncated: true};
  } finally { await handle.close(); }
}

/** A safe relative name: no absolute path, `..`, `.` or empty segment, nothing but printable characters. */
export function safeName(name: string): boolean {
  if (!name || name.length > 512 || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) return false;
  return name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

const slug = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 64) || 'printer';

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't answer within ${Math.round(ms / 1000)} s.`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function reason(error: unknown): string {
  const {code, message} = (error ?? {}) as {code?: unknown; message?: unknown};
  const text = typeof message === 'string' && message ? message : typeof code === 'string' ? code : 'unknown error';
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function softwareView(packages: readonly SoftwarePackage[], home?: string) {
  const local = (path?: string) => path && home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return packages.map(item => ({
    package: item.label, installed: item.installed,
    ...(item.version ? {version: item.version} : {}), ...(item.latestVersion ? {latestVersion: item.latestVersion} : {}),
    ...(item.available ? {updateAvailable: item.available} : {}), ...(item.upToDate ? {upToDate: true} : {}),
    installs: item.installs.map(install => ({kind: install.kind, ...(install.path ? {path: local(install.path)} : {}), ...(install.version ? {version: install.version} : {})})),
    usedBy: item.usedBy ?? [],
    uses: item.uses.map(use => ({printer: use.printer, kind: use.kind, ...(use.version ? {version: use.version} : {}), managed: use.managed, words: use.words})),
  }));
}

/** Gathers the bundle. Never throws: whatever can't be read becomes a note. */
export async function diagnosticsBundle(source: DiagnosticsSource): Promise<DiagnosticsBundle> {
  const limits = {...DIAGNOSTICS_LIMITS, ...source.limits};
  const files: BundleFile[] = [], notes: string[] = [];
  const sessions = (() => { try { return source.sessions?.() ?? []; } catch { return []; } })();
  const secrets = configuredSecrets(sessions);
  const clean = (text: string) => redact(text, secrets, source.home);
  const add = (name: string, content: string, truncated = false) => files.push({name, content: clean(content), truncated});
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  // The event log's newest part: what the lead reads first.
  if (source.eventsPath) {
    const events = await tailFile(source.eventsPath, limits.eventsBytes).catch(() => undefined);
    if (events) add('events-tail.ndjson', events.content, events.truncated);
    else notes.push('There is no event log yet.');
  }
  // The printers, by these fields only.
  try {
    const printers = source.printers?.();
    if (printers) add('printers.json', json(printers.map(printer => ({
      id: printer.id, name: printer.name, ...(printer.model ? {model: printer.model} : {}), ...(printer.address ? {address: printer.address} : {}),
      ...(printer.state ? {state: printer.state} : {}), mcp: printer.mcp, ...(printer.mcpVersion ? {mcpVersion: printer.mcpVersion} : {}),
      ...(printer.contract ? {contract: printer.contract} : {}),
      // Only the printer reports its firmware, through its MCP's own bundle; the app never asks the printer here.
    }))));
  } catch (error) { notes.push(`The printer list couldn't be read (${reason(error)}).`); }

  // Each printer's MCP, at once: its own bundle, or one line saying why not.
  const asked = sessions.slice(0, limits.printers);
  if (sessions.length > asked.length) notes.push(`Only the first ${asked.length} of ${sessions.length} printers' printer software was asked for its diagnostics.`);
  const share = Math.floor(limits.mcpBytes / Math.max(1, asked.length));
  const maxBytes = Math.min(limits.mcpEachBytes, Math.max(limits.mcpMinBytes, share));
  const mcpWork = Promise.all(asked.map(async ({destinationId, printer, session}) => {
    const label = packageLabel(session.backend as PrinterBackend);
    const folder = `mcp/${slug(printer)}-${slug(label)}`;
    const signal = AbortSignal.timeout(limits.mcpTimeoutMs);
    try {
      const answer = await withTimeout(readDiagnostics(session, maxBytes, {signal, failFast: true}), limits.mcpTimeoutMs + 1000, label);
      if ('unsupported' in answer) {
        return {notes: [`${label} ${answer.server.version} is too old to add its own diagnostics; update it in Settings → Printers.`], files: []};
      }
      const {diagnostics} = answer;
      const out: BundleFile[] = [], said: string[] = [];
      let budget = maxBytes;
      for (const file of diagnostics.files) {
        if (!safeName(file.name)) { said.push(`${label} for ${printer} named a file this export can't use; it was left out.`); continue; }
        const name = `${folder}/${file.name}`;
        // The MCP keeps to max_bytes; a bundle that doesn't is cut here, keeping each file's newest lines.
        const kept = tail(file.content, Math.max(0, budget - bytes(file.name)));
        budget -= bytes(file.name) + bytes(kept.content);
        out.push({name, content: kept.content, truncated: file.truncated || kept.truncated});
      }
      said.push(...diagnostics.notes.slice(0, 64).map(note => `${label} for ${printer}: ${note}`));
      return {files: out, notes: said};
    } catch (error) {
      return {files: [], notes: [`${label} for ${printer} (${destinationId}) didn't give its diagnostics: ${reason(error)}`]};
    }
  }));
  // Settings → Printers' printer software: versions, available updates, and who uses which.
  const softwareWork = source.software ? withTimeout(source.software(), limits.softwareTimeoutMs, 'The printer software list')
    .then(packages => { add('printer-software.json', json(softwareView(packages, source.home))); },
      error => { notes.push(`The printer software list couldn't be read (${reason(error)}).`); }) : Promise.resolve();
  const [mcps] = await Promise.all([mcpWork, softwareWork]);
  for (const result of mcps) {
    for (const file of result.files) add(file.name, file.content, file.truncated);
    notes.push(...result.notes);
  }

  const bundle: DiagnosticsBundle = {files, notes: notes.map(clean)};
  // The whole answer fits the control socket's reply: the largest file gives up its oldest half until it does.
  while (bytes(JSON.stringify(bundle)) > limits.replyBytes) {
    const largest = bundle.files.reduce((a, b) => bytes(b.content) > bytes(a.content) ? b : a, bundle.files[0]!);
    if (!largest || !largest.content) break;
    const kept = tail(largest.content, Math.floor(bytes(largest.content) / 2));
    largest.content = kept.content; largest.truncated = true;
  }
  return bundle;
}

/** The pieces of the printer directory the bundle reads; reading them asks nothing of any printer. */
export interface DirectoryView {
  catalog: {destinations: readonly {id: string; name: string; backend: PrinterBackend; model?: string; address?: string}[]};
  nameOf(id: string): string | undefined;
  lastState(id: string): string | undefined;
  capabilities(id: string): {server: {version: string}; contract?: string} | undefined;
  session(id: string): PrinterSession | undefined;
}

/** The printers and their sessions, as the bundle lists and asks them. */
export function directorySource(directory: DirectoryView, version?: (id: string) => string | undefined): Pick<DiagnosticsSource, 'printers' | 'sessions'> {
  return {
    printers: () => directory.catalog.destinations.map(destination => {
      const capabilities = directory.capabilities(destination.id), state = directory.lastState(destination.id);
      const mcpVersion = capabilities?.server.version ?? version?.(destination.id);
      return {id: destination.id, name: directory.nameOf(destination.id) ?? destination.name, ...(destination.model ? {model: destination.model} : {}),
        ...(destination.address ? {address: destination.address} : {}), ...(state ? {state} : {}), mcp: packageLabel(destination.backend),
        ...(mcpVersion ? {mcpVersion} : {}), ...(capabilities?.contract ? {contract: capabilities.contract} : {})};
    }),
    sessions: () => directory.catalog.destinations.flatMap(destination => {
      const session = directory.session(destination.id);
      return session ? [{destinationId: destination.id, printer: directory.nameOf(destination.id) ?? destination.name, session}] : [];
    }),
  };
}
