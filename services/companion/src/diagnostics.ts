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
  /** The companion's own environment: its secret-named values (the model key, the TLS key) are swept too. */
  ownEnv?: Record<string, string | undefined>;
  limits?: Partial<DiagnosticsLimits>;
}
/** The fields of a `printers.mcps` package the bundle keeps. */
export interface SoftwarePackage {
  package: string; label: string; installed: boolean; version?: string; latestVersion?: string; available?: string; upToDate?: true;
  installs: {kind: string; path?: string; version?: string}[];
  uses: {printer: string; kind: string; version?: string; managed: boolean; words: string}[];
  usedBy?: string[];
}

// Whether a key names a secret, by its words: `accessCode`, `BAMBU_ACCESS_CODE`, `X-Api-Key`, `SCAN_TO_MAKE_MODEL_KEY`,
// `session_key`, `PAIRING_PIN`, `password`. Short words (`key`, `pin`, `otp`, `auth`) count only as a whole word,
// so `mapping`, `keyboard` and "Failed to authenticate:" keep their values. Plain `keys` (settings.updated's list of
// changed setting names) isn't a secret; `apiKeys` is, by `apikey` inside it.
const SECRET_WORDS = new Set(['password', 'passwd', 'passcode', 'passphrase', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'key',
  'apikey', 'accesscode', 'accesskey', 'privatekey', 'authorization', 'auth', 'cookie', 'cookies', 'credential', 'credentials', 'signature',
  'ticket', 'login', 'email', 'userinfo', 'session', 'sessionid', 'sid', 'pin', 'otp', 'jwt', 'bearer', 'certificate']);
const SECRET_PAIRS = new Set(['access code', 'lan code', 'pair code', 'pairing code', 'user info', 'id token']);
// Long words that are secrets even inside one unbroken name (`accesstoken`, `CLIENTSECRET`).
const SECRET_INSIDE = /password|passwd|passcode|passphrase|secret|token|credential|cookie|authorization|signature|apikey|accesscode|privatekey/;

export function isSecretName(name: string): boolean {
  const decoded = name.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const words = decoded.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => SECRET_WORDS.has(word))) return true;
  if (words.some((word, i) => i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${word}`))) return true;
  return SECRET_INSIDE.test(words.join(''));
}

/** A value that is already safe after a secret's name, as a whole value: a "[set]" or "[redacted…]" marker, "", true/false/null. */
function safeValue(value: string): boolean {
  return /^(?:"(?:\[set\]|\[redacted[^"\]]*\])?"|\[set\]|\[redacted[^\]]*\]|true|false|null|'')$/.test(value);
}
const KEY_CHARS = String.raw`(?:[A-Za-z0-9_.\-]|\\u[0-9a-fA-F]{4})+`;
// A bare value: up to the next delimiter; a leading [marker] doesn't end it (`[set]hunter2` is one value).
const BARE = String.raw`(?:\[[^\]\s]*\])?[^\s,;&}\]"'<>]*`;
const NAMED: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // Escaped JSON inside a string: \"accessCode\":\"1234\".
  [new RegExp(String.raw`(\\"(${KEY_CHARS})\\"\s*:\s*)(\\"(?:[^"\\]|\\[^"])*\\")`, 'g'),
    (match, head, key, value) => isSecretName(key!) && value !== '\\"\\"' && value !== '\\"[set]\\"' ? `${head}\\"[redacted]\\"` : match],
  // JSON: "accessCode": "1234", a number, or a bare word.
  [new RegExp(String.raw`("(${KEY_CHARS})"\s*:\s*)("(?:[^"\\]|\\.)*"|${BARE})`, 'g'),
    (match, head, key, value) => isSecretName(key!) && value && !safeValue(value) ? `${head}"[redacted]"` : match],
  // key=value, key: value, ?key=value&, #key=value (on one line: `KEY=` with nothing after it stays empty).
  [new RegExp(String.raw`(^|[^A-Za-z0-9_.\\])([A-Za-z][A-Za-z0-9_.\-]*)([ \t]*[=:](?!\/\/)[ \t]*)("[^"\n]*"|'[^'\n]*'|${BARE})`, 'gm'),
    (match, before, key, sep, value) => isSecretName(key!) && value && !safeValue(value) ? `${before}${key}${sep}[redacted]` : match],
  // --key value.
  [/(--)([A-Za-z][A-Za-z0-9_.-]*)([ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    (match, dashes, key, space) => isSecretName(key!) ? `${dashes}${key}${space}[redacted]` : match],
];
const VALUES: [RegExp, string][] = [
  // PEM blocks of any type (private keys, certificates), whole.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[redacted PEM block]'],
  // scheme://user:password@host keeps its host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@"'<>]+(?::[^/\s@"'<>]*)?@/gi, '$1[redacted]@'],
  // Authorization schemes, in any case (`authorization: bearer …`, `Basic dXNl…`).
  [/\b(Bearer|Basic|Digest|Token)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1$2[redacted]'],
  // Cookie headers, whole line.
  [/^((?:Set-)?Cookie:).*$/gim, '$1 [redacted]'],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[redacted token]'],
  // Keys with a known prefix: OpenAI/Anthropic-style, GitHub, AWS, Google, Hugging Face, Slack.
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '[redacted key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted key]'],
  [/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted key]'],
  [/\b(?:hf_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '[redacted key]'],
  // Any long run of mixed case and digits (a pairing code, an unlabelled key). Serials (no lowercase) and hashes (no
  // uppercase) stay.
  [/\b(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{24,}\b/g, '[redacted token]'],
  // A long base64 run (a DER certificate, a key), digits or not.
  [/\b(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[a-z])[A-Za-z0-9+]{40,}={0,2}/g, '[redacted token]'],
  // A pairing code or PIN said in words: "The pairing code is 482913", "Enter PIN 482913".
  [/\b((?:pin|code)(?:\s+is)?\s+)\d{4,8}\b/gi, '$1[redacted]'],
  // Email addresses (an Apple Account, a Bambu account).
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[redacted email]'],
  // A pairing link carries its code.
  [/scantomake:\/\/pair\?[^\s"']+/g, 'scantomake://pair?[redacted]'],
];
// Someone else's home folder, plain or JSON-escaped (`\/Users\/name`), and `~name/`.
const HOMES: [RegExp, string][] = [
  [/(\\?\/)(Users|home)(\\?\/)(?!\[user\])([^/\\\s"'<>:]+)/g, '$1$2$3[user]'],
  [/\b([A-Za-z]:\\{1,2}Users\\{1,2})([^\\\s"'<>:]+)/g, '$1[user]'],
  [/(^|[\s"'=(])~(?!\[)([A-Za-z_][A-Za-z0-9_.-]*)(?=\/)/gm, '$1~[user]'],
];

/**
 * Every secret value the bundle must never carry: each printer's configured secrets (access codes, keys, passwords)
 * and the companion's own (its model key, its TLS key). Paths and short values aren't swept.
 */
export function configuredSecrets(sessions: readonly {session: PrinterSession}[], own: Record<string, string | undefined> = {}): string[] {
  const values = new Set<string>();
  const sweep = (env: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.length >= 6 && !value.startsWith('/') && !safeValue(value) && isSecretName(key)) values.add(value);
    }
  };
  for (const {session} of sessions) sweep(session.config.process.env ?? {});
  sweep(own);
  // Longest first, so one secret that contains another goes whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/** Text with every secret it recognises removed; the home folder reads `~`, anyone else's `[user]`. Serials and hosts stay. */
export function redact(text: string, secrets: readonly string[] = [], home?: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  for (const [pattern, replacement] of VALUES) out = out.replace(pattern, replacement);
  for (const [pattern, replace] of NAMED) out = out.replace(pattern, replace as (match: string, ...rest: string[]) => string);
  if (home && home.length > 1) out = out.split(home).join('~').split(home.replaceAll('/', '\\/')).join('~');
  for (const [pattern, replacement] of HOMES) out = out.replace(pattern, replacement);
  return out;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
/** What a string costs in the JSON reply, escapes included. */
const jsonBytes = (text: string) => bytes(JSON.stringify(text));
/** `{"name":…,"content":…,"truncated":false},` around a file's name and content. */
const FILE_OVERHEAD = 48;
const MAX_MCP_NOTES = 64;
/** A note as one printable line of at most 1000 characters (control characters would escape to six bytes each). */
const oneLine = (text: string) => { const line = text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim(); return line.length > 1000 ? `${line.slice(0, 999)}…` : line; };

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
  const secrets = configuredSecrets(sessions, source.ownEnv);
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
    // The destination id keeps two printers with the same name on the same MCP apart.
    const folder = `mcp/${slug(printer)}-${slug(label)}-${slug(destinationId)}`;
    const signal = AbortSignal.timeout(limits.mcpTimeoutMs);
    try {
      const answer = await withTimeout(readDiagnostics(session, maxBytes, {signal, failFast: true}), limits.mcpTimeoutMs + 1000, label);
      if ('unsupported' in answer) {
        return {notes: [`${label} ${answer.server.version} is too old to add its own diagnostics; update it in Settings → Printers.`], files: []};
      }
      const {diagnostics} = answer;
      const out: BundleFile[] = [], said: string[] = [];
      if (answer.infoUnread) said.push(`${label} for ${printer}: its printer info couldn't be read, so Counterpart asked for its diagnostics without it.`);
      // Names, contents and notes all count against the bundle's share, as JSON (escapes included).
      let budget = maxBytes;
      for (const note of diagnostics.notes.slice(0, MAX_MCP_NOTES)) {
        const line = oneLine(`${label} for ${printer}: ${note}`);
        if (jsonBytes(line) > budget) break;
        budget -= jsonBytes(line); said.push(line);
      }
      if (diagnostics.notes.length > said.length) said.push(`${label} for ${printer}: ${diagnostics.notes.length - said.length} more of its notes were left out to keep the export small.`);
      let left = 0;
      for (const file of diagnostics.files) {
        if (!safeName(file.name)) { said.push(`${label} for ${printer} named a file this export can't use; it was left out.`); continue; }
        const name = `${folder}/${file.name}`;
        const room = budget - jsonBytes(name) - FILE_OVERHEAD;
        if (room < 0) { left++; continue; }
        // The MCP keeps to max_bytes; a bundle that doesn't is cut here, keeping each file's newest lines.
        const kept = tail(file.content, Math.floor(room / 2));
        budget -= jsonBytes(name) + FILE_OVERHEAD + jsonBytes(kept.content);
        out.push({name, content: kept.content, truncated: file.truncated || kept.truncated});
      }
      if (left) said.push(`${label} for ${printer}: ${left} of its files were left out to keep the export small.`);
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

  const bundle: DiagnosticsBundle = {files, notes: notes.map(note => oneLine(clean(note)))};
  // The whole answer fits the reply (and so the control socket's 8 MiB): the largest file gives up its oldest half,
  // then whole files and notes go from the end, with one line saying so. Room is kept for that line.
  const target = limits.replyBytes - 512;
  let dropped = 0;
  while (bytes(JSON.stringify(bundle)) > target) {
    const largest = bundle.files.reduce<BundleFile | undefined>((a, b) => !a || bytes(b.content) > bytes(a.content) ? b : a, undefined);
    if (largest?.content) { const kept = tail(largest.content, Math.floor(bytes(largest.content) / 2)); largest.content = kept.content; largest.truncated = true; continue; }
    if (bundle.files.length) { bundle.files.pop(); dropped++; continue; }
    if (!bundle.notes.length) break;
    bundle.notes.pop(); dropped++;
  }
  if (dropped) bundle.notes.push(`${dropped} files or notes were left out to keep the export under ${Math.floor(limits.replyBytes / 1024 / 1024)} MiB.`);
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
