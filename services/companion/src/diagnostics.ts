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
  'ticket', 'login', 'email', 'userinfo', 'session', 'sessionid', 'sid', 'pin', 'otp', 'jwt', 'bearer', 'certificate', 'cert', 'sha256', 'fingerprint']);
const SECRET_PAIRS = new Set(['access code', 'lan code', 'pair code', 'pairing code', 'device code', 'unlock code', 'user info', 'id token']);
// Long words that are secrets even inside one unbroken name (`accesstoken`, `CLIENTSECRET`), read over the whole name
// lowercased and joined, so alternating case (`PaSsWoRd`, `AcCeSsCoDe`) can't split them apart.
const SECRET_INSIDE = /password|passwd|passcode|passphrase|secret|token|credential|cookie|authorization|signature|apikey|accesscode|privatekey|(?:lan|pair|pairing|device|unlock)code/;

/** Text with `\uXXXX`, `\xXX` and `%XX` escapes read, so `\x70assword` and `pass%77ord` read `password`. */
export function decodeEscapes(text: string): string {
  return text.replace(/\\{1,2}u\{([0-9a-fA-F]{1,6})\}|\\{1,2}u([0-9a-fA-F]{4})|\\{1,2}x([0-9a-fA-F]{2})|%([0-9a-fA-F]{2})|&#[xX]([0-9a-fA-F]{1,6});?|&#(\d{1,7});?|\\\//g,
    (match: string, brace?: string, u?: string, x?: string, p?: string, hexEntity?: string, decEntity?: string) => {
      if (match.startsWith('\\') && match.endsWith('/')) return '/';
      const code = decEntity !== undefined ? Number.parseInt(decEntity, 10) : Number.parseInt((brace ?? u ?? x ?? p ?? hexEntity)!, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

export function isSecretName(name: string): boolean {
  const decoded = decodeEscapes(name);
  if (SECRET_INSIDE.test(decoded.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true;
  const words = decoded.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => SECRET_WORDS.has(word))) return true;
  // `pass` names a secret as the name's last word (`pass`, `mqtt_pass`, `lanPass`), not as a count (`passIndex`).
  if (words.at(-1) === 'pass') return true;
  return words.some((word, i) => i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${word}`));
}

/** A value that is already safe after a secret's name, as a whole value: a "[set]" or "[redacted…]" marker, "", true/false/null. */
function safeValue(value: string): boolean {
  return /^(?:"(?:\[set\]|\[redacted[^"\]]*\])?"|\[set\]|\[redacted[^\]]*\]|true|false|null|'')$/.test(value);
}
/** A bare number under a measure's name (`tokenCount: 5`, `sessionTimeoutSec=30`) is not a secret. */
const measure = (key: string, value: string) => /^-?\d+(?:\.\d+)?$/.test(value) && MEASURE_NAME.test(key);
const KEY_CHARS = String.raw`(?:[A-Za-z0-9_.\-]|\\u[0-9a-fA-F]{4})+`;
// A bare value: up to the next delimiter; a leading [marker] doesn't end it (`[set]hunter2` is one value).
const BARE = String.raw`(?:\[[^\]\s]*\])?[^\s,;&}\]"'<>]*`;
const NAMED: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // Escaped JSON inside a string: \"accessCode\":\"1234\".
  [new RegExp(String.raw`(\\"(${KEY_CHARS})\\"\s*:\s*)(\\"(?:[^"\\]|\\[^"])*\\")`, 'g'),
    (match, head, key, value) => isSecretName(key!) && value !== '\\"\\"' && value !== '\\"[set]\\"' ? `${head}\\"[redacted]\\"` : match],
  // JSON: "accessCode": "1234", a number, or a bare word.
  [new RegExp(String.raw`("(${KEY_CHARS})"\s*:\s*)("(?:[^"\\]|\\.)*"|${BARE})`, 'g'),
    (match, head, key, value) => isSecretName(key!) && value && !safeValue(value) && !measure(key!, value) ? `${head}"[redacted]"` : match],
  // key=value, key: value, ?key=value&, #key=value (on one line: `KEY=` with nothing after it stays empty).
  [new RegExp(String.raw`(^|[^A-Za-z0-9_.\\])([A-Za-z][A-Za-z0-9_.\-]*)([ \t]*[=:](?!\/\/)[ \t]*)("[^"\n]*"|'[^'\n]*'|${BARE})`, 'gm'),
    (match, before, key, sep, value) => isSecretName(key!) && value && !safeValue(value) && !measure(key!, value) ? `${before}${key}${sep}[redacted]` : match],
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
  // A whole Authorization or Proxy-Authorization header line, whatever its scheme (a Digest header's username and
  // response are parameters, not one credential).
  [/(^|[^"\w-])((?:Proxy-)?Authorization[ \t]*:)[^\n]*/gim, '$1$2 [redacted]'],
  [/\b(Bearer|Basic|Digest|Negotiate|Token)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1$2[redacted]'],
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
  [/\b(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[0-9])[A-Za-z0-9_]{24,}\b(?!\.[A-Za-z][A-Za-z0-9]{1,5}\b)/g, '[redacted token]'],
  // A long base64 run (a DER certificate, a key), digits or not.
  [/\b(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[a-z])[A-Za-z0-9+]{40,}={0,2}/g, '[redacted token]'],
  // A pairing code or PIN said in words: "The pairing code is 482913", "Enter PIN 482913". Never a bare "code": a
  // printer's error code ("HMS code 05004043") is what these reports are read for.
  [/\b((?:pin|passcode|pairing\s+code|access\s+code)(?:\s+is)?\s+)\d{4,8}\b/gi, '$1[redacted]'],
  // A pin, fingerprint or certificate said in words, as hex or colon-hex ("pin is ab12…"). Bare hex elsewhere (the
  // event log's content hashes) stays readable.
  [/\b((?:pin|fingerprint|cert(?:ificate)?)(?:\s+(?:is|sha-?256))?[ \t]*[:=]?[ \t]*)((?:[0-9A-Fa-f]{2}:){15,}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{32,})\b/gi, '$1[redacted]'],
  // Email addresses (an Apple Account, a Bambu account).
  [/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[redacted email]'],
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
 * A secret-named key whose value is an object or array (`{"password":{"value":"…"}}`, `{"tokens":["…"]}`): the whole
 * value goes, to its matching close (strings and escapes respected). One that never closes goes to the end of its line.
 */
function redactNested(text: string): string {
  const opener = new RegExp(String.raw`"(${KEY_CHARS})"\s*:\s*(?=[{\[])`, 'g');
  let out = '', from = 0;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    if (match.index < from || !isSecretName(match[1]!)) continue;
    const start = match.index + match[0].length;
    let depth = 0, quoted = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) { end = i + 1; break; } }
      else if (c === '\n' && depth > 0 && i - start > 65536) break;
    }
    if (end < 0) { const line = text.indexOf('\n', start); end = line < 0 ? text.length : line; }
    out += text.slice(from, start) + '"[redacted]"';
    from = end; opener.lastIndex = end;
  }
  return out + text.slice(from);
}

/** `{"name":"BAMBU_ACCESS_CODE","value":"…"}`: a value whose sibling `name` or `key` is a secret's name goes. */
function redactPairs(text: string): string {
  return text.replace(/\{[^{}]{0,4096}\}/g, object => {
    const named = /"(?:name|key)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(object);
    if (!named || !isSecretName(named[1]!)) return object;
    return object.replace(/("value"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/g, (match, head: string, value: string) => safeValue(value) ? match : `${head}"[redacted]"`);
  });
}

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
  out = redactPairs(redactNested(out));
  for (const [pattern, replace] of NAMED) out = out.replace(pattern, replace as (match: string, ...rest: string[]) => string);
  if (home && home.length > 1) out = out.split(home).join('~').split(home.replaceAll('/', '\\/')).join('~');
  for (const [pattern, replacement] of HOMES) out = out.replace(pattern, replacement);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fail closed (#839). `redact` above is a denylist of named forms, and free text keeps finding spellings it misses.
// What the bundle carries goes through `cleanText`: known secrets in every encoded form, then JSON by its structure,
// then any free-text line that names a secret withheld whole. Format-agnostic: no file names, log shapes or printer
// codes of any MCP (AGENTS.md); an MCP withholds or keeps its own lines before they get here.

const MARK = '[redacted]';
export const WITHHELD = '[line withheld: may contain a secret]';

/** The forms a known secret takes in text: as written, URL-encoded, JSON-escaped, and base64 at any byte offset. */
function encodedForms(secret: string): string[] {
  const forms = new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  const raw = Buffer.from(secret, 'utf8');
  for (const before of [0, 1, 2]) {
    // The base64 characters only this secret's bytes decide, wherever it sits in an encoded run (`bblp:<code>`).
    const encoded = Buffer.concat([Buffer.alloc(before), raw]).toString('base64');
    const start = before ? 4 : 0, end = Math.floor((before + raw.length) / 3) * 4;
    if (end - start >= 4) forms.add(encoded.slice(start, end));
    if (!before) { forms.add(encoded); forms.add(encoded.replace(/=+$/, '')); forms.add(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')); }
  }
  return [...forms].filter(form => form.length >= 4);
}

/** Base64 characters around a removed core: the group before and after it mix the secret's bytes with its neighbours'. */
const B64_EDGE = /[A-Za-z0-9+/_-]{1,4}\[redacted\][A-Za-z0-9+/_-]{0,4}={0,2}|\[redacted\][A-Za-z0-9+/_-]{1,4}={0,2}/g;

/** Text with every known secret removed in each encoded form. Runs before any cut, so no part of one survives a cut. */
export function removeSecrets(text: string, secrets: readonly string[]): string {
  if (!secrets.length) return text;
  // Other encoders' spellings (form-url `+`, lowercase %-hex, Go's \u003c, a lone \u escape, \/, HTML entities): a copy
  // of each line is decoded, and a line whose decoded copy holds a known secret is withheld whole.
  let out = text.split('\n').map(line => {
    if (!/[%+\\&]/.test(line)) return line;
    const decoded = decodeEscapes(line), spaced = decodeEscapes(line.replace(/\+/g, ' '));
    return secrets.some(value => decoded.includes(value) || spaced.includes(value)) ? (LINE_PREFIX.exec(line)?.[0] ?? '') + WITHHELD : line;
  }).join('\n');
  const forms = [...new Set(secrets.flatMap(encodedForms))].sort((a, b) => b.length - a.length);
  for (const form of forms) out = out.split(form).join(MARK);
  // A base64 core leaves the mixed groups either side of it; they go too (a small over-redaction of innocent base64).
  return out.replace(B64_EDGE, MARK);
}

/**
 * Words that make a line suspect, read in the line lowercased, its escapes read and all but letters and digits removed
 * ("pass word", "Pa_Ss-WoRd", "\x70assword" all read "password"); LINE_WORDS only as a whole word ("mqtt pass=…").
 */
const LINE_SECRETS = /pass(?:word|wd|code|phrase|key)|secret|token|apikey|accesscode|accesskey|(?:lan|pair|pairing|device|unlock|auth|verification|security|otp)code|authoriz|authkey|cookie|session|credential|privatekey|signature|bearer|userinfo|ticket/;
const LINE_WORDS = new Set(['pass', 'passwd', 'pwd', 'pin', 'otp', 'auth', 'sid', 'key', 'keys', 'digest', 'negotiate', 'ntlm', 'jwt']);
/** A name whose bare number is a measure, not a secret: tokenCount, sessionTimeoutSec, passwordMinLength, passIndex. */
const MEASURE_NAME = /(?:count|counts|total|num|number|sec|secs|seconds|ms|millis|minutes|length|len|size|bytes|timeout|ttl|max|min|limit|retries|attempts|index|level|version)$/i;
/** Generic values that say nothing secret: a marker, empty, a boolean, a version string. Never a bare number (an access code is one). */
const SAFE = String.raw`\[set\]|\[redacted[^\]]*\]|true|false|null|""|''|v?\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][0-9A-Za-z.]+)?`;
const SAFE_PAIR = new RegExp(String.raw`^[\s"'{\[,]*([A-Za-z0-9_.\-]{1,96})["']?[ \t]*[:=][ \t]*(?:["']?(${SAFE})["']?|(-?\d+(?:\.\d+)?))?[\s,}\]]*$`);
/** A log line's leading time and level, kept on a withheld line. */
const LINE_PREFIX = /^(?:\[?\d{4}-\d\d-\d\d[T ][\d:.,]+(?:Z|[+-]\d\d:?\d\d)?\]?\s+(?:\[?(?:error|warn(?:ing)?|info|debug|trace|fatal|notice)\]?:?\s+)?|\[?(?:error|warn(?:ing)?|info|debug|trace|fatal|notice)\]?:?\s+)/i;

/** Whether a line may carry a secret: a secret word anywhere in it, in any spelling or encoding. */
export function suspectLine(line: string): boolean {
  const plain = decodeEscapes(line).toLowerCase();
  if (LINE_SECRETS.test(plain.replace(/[^a-z0-9]/g, ''))) return true;
  return plain.split(/[^a-z0-9]+/).some(word => LINE_WORDS.has(word));
}

/** Quotes and brackets left open so far, read on through a line. */
interface Open {depth: number; quote: string}
/**
 * The quotes and brackets a line leaves open. On a suspect line a single quote counts too, opening only where a value
 * starts (`password='…`), not inside a word (`don't`).
 */
function readOpen(state: Open, line: string, single = false): Open {
  let {depth, quote} = state;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"') quote = c;
    else if (single && c === "'" && !/[A-Za-z0-9]/.test(line[i - 1] ?? '')) quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1);
  }
  return {depth, quote};
}
const isOpen = (open: Open) => open.depth > 0 || open.quote !== '';

/** Whether a suspect line is only a name and a safe value, closing all it opens (`accessCodeSet: true`, `TOKEN=[set]`). */
function safeLine(line: string): boolean {
  const body = line.replace(LINE_PREFIX, '');
  const m = SAFE_PAIR.exec(body);
  return !!m && !isOpen(readOpen({depth: 0, quote: ''}, body, true)) && (m[3] === undefined || MEASURE_NAME.test(m[1]!));
}

/** Most lines a heuristic continuation (indented lines, a YAML block, a single quote) takes, so it stays bounded. */
const CONTINUATION_LIMIT = 200;
const indent = (line: string) => /^[ \t]*/.exec(line)![0].length;

/**
 * How many lines after lines[i] (a suspect line) continue it: while a double quote or a bracket it opened is verifiably
 * still open, however many; lines indented deeper than it, a YAML block scalar it starts (blank lines included), or a
 * single-quoted value, up to CONTINUATION_LIMIT; a multipart part named like a secret, to its next boundary; and an
 * Authorization or Bearer line that ends mid-token, its wrapped next line.
 */
function continuation(lines: string[], i: number): number {
  const line = lines[i]!;
  if (/^\s*content-disposition\s*:/i.test(line)) {
    let j = i + 1;
    while (j < lines.length && !/^--\S/.test(lines[j]!)) j++;
    return j - i - 1;
  }
  let open = readOpen({depth: 0, quote: ''}, line, true);
  const block = /[:=]\s*[>|][-+]?\d?\s*$/.test(line), base = indent(line);
  let taken = 0, heuristic = 0;
  while (i + taken + 1 < lines.length) {
    const next = lines[i + taken + 1]!;
    const verified = open.depth > 0 || open.quote === '"';
    if (!verified) {
      const deeper = /\S/.test(next) && indent(next) > base && !LINE_PREFIX.test(next.trimStart());
      const inBlock = block && (!/\S/.test(next) || indent(next) > base);
      if (!(open.quote === "'" || deeper || inBlock) || ++heuristic > CONTINUATION_LIMIT) break;
    }
    open = readOpen(open, next, true);
    taken++;
  }
  // A blank line closing a YAML block is not part of it.
  while (block && taken > 0 && !/\S/.test(lines[i + taken]!)) taken--;
  if (taken === 0 && /\b(?:authorization|bearer)\b/i.test(line) && /[A-Za-z0-9._~+/=-]$/.test(line)) {
    const next = lines[i + 1];
    if (next !== undefined && /^[A-Za-z0-9._~+/=-]/.test(next) && !LINE_PREFIX.test(next)) return 1;
  }
  return taken;
}

/**
 * Free text with each suspect line withheld whole, with the lines that continue it; its time and level stay. A suspect
 * line that is only a name and a safe value stays, but what continues it is withheld all the same.
 */
export function withholdLines(text: string): string {
  const lines = text.split('\n'), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!suspectLine(line)) { out.push(line); continue; }
    const taken = continuation(lines, i);
    if (safeLine(line)) { out.push(line); if (taken) out.push(WITHHELD); }
    else out.push((LINE_PREFIX.exec(line)?.[0] ?? '') + WITHHELD);
    i += taken;
  }
  return out.join('\n');
}

const PEM = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
/** Free text, failing closed: known secrets, PEM blocks (their bodies name nothing), suspect lines, then the named forms. */
function freeText(text: string, secrets: readonly string[], home?: string): string {
  return redact(withholdLines(removeSecrets(text, secrets).replace(PEM, '[redacted PEM block]')), [], home);
}

/** Fields that hold a setting's name, in the order one is chosen as an object's name: `{"name":"PRINTER_TOKEN"}`. */
const NAME_FIELDS = ['name', 'key', 'env', 'envname', 'env_name', 'variable', 'var', 'field', 'setting', 'setting_name', 'settingname', 'property', 'label', 'id'];
/** A name as people write one: an identifier, or a few words ("Access Code"). */
const LABEL = /^[A-Za-z_][\w.\-]*(?: [\w.\-]+){0,3}$/;
const IDENTIFIER = /^[A-Za-z_][\w.\-:]{0,95}$/;
const safeScalar = (v: unknown) => typeof v === 'boolean' || v === null || v === undefined || v === '' || v === '[set]';

/**
 * A value redacted by its structure: a secret-named key's value goes (a marker, a boolean or a measure stays); an object
 * whose name field names a secret loses its other values, nested ones too; a pair (`["PRINTER_TOKEN", "…"]`, the
 * Object.entries shape) loses its second item; a string holding JSON is read and walked; an identifier (an event type,
 * a setting's name) gets only the named forms; any other string is free text.
 */
export function redactValue(value: unknown, secrets: readonly string[] = [], home?: string, depth = 0): unknown {
  if (depth > 32) return WITHHELD;
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { return JSON.stringify(redactValue(JSON.parse(t), secrets, home, depth + 1)); } catch { /* not JSON */ }
    }
    return IDENTIFIER.test(value) ? redact(value, [], home) : freeText(value, secrets, home);
  }
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && value[0].length <= 96 && isSecretName(value[0])) {
      return [LABEL.test(value[0]) ? value[0] : redactValue(value[0], secrets, home, depth + 1), safeScalar(value[1]) ? value[1] : MARK];
    }
    return value.map(item => redactValue(item, secrets, home, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  // The one field naming this object: the first name field, in NAME_FIELDS' order, whose whole string names a secret.
  const chosen = entries.filter(([k, v]) => NAME_FIELDS.includes(k.toLowerCase()) && typeof v === 'string' && v.length <= 96 && isSecretName(v))
    .sort(([a], [b]) => NAME_FIELDS.indexOf(a.toLowerCase()) - NAME_FIELDS.indexOf(b.toLowerCase()))[0]?.[0];
  return Object.fromEntries(entries.map(([k, v]) => {
    if (k === chosen) return [k, LABEL.test(v as string) ? v : redactValue(v, secrets, home, depth + 1)];
    if (isSecretName(k)) return [k, safeScalar(v) || (typeof v === 'number' && MEASURE_NAME.test(k)) ? v : MARK];
    if (chosen !== undefined) return [k, safeScalar(v) ? v : MARK];
    return [k, redactValue(v, secrets, home, depth + 1)];
  }));
}

/**
 * Any text the bundle carries, failing closed and format-agnostic: a whole JSON document, or each line that is JSON
 * (an event log), is redacted by its structure and written back in its own layout; the rest is free text.
 */
export function cleanText(text: string, secrets: readonly string[] = [], home?: string): string {
  const swept = removeSecrets(text, secrets);
  const whole = swept.trim();
  if (whole.startsWith('{') || whole.startsWith('[')) {
    try {
      const pretty = /\n[ \t]+["{\[]/.test(swept) ? 2 : undefined;
      return JSON.stringify(redactValue(JSON.parse(whole), secrets, home), null, pretty) + (swept.endsWith('\n') ? '\n' : '');
    } catch { /* not one document */ }
  }
  const out: string[] = [], run: string[] = [];
  const flush = () => { if (run.length) { out.push(freeText(run.join('\n'), secrets, home)); run.length = 0; } };
  for (const line of swept.split('\n')) {
    const t = line.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { const parsed: unknown = JSON.parse(t); flush(); out.push(JSON.stringify(redactValue(parsed, secrets, home))); continue; } catch { /* free text */ }
    }
    run.push(line);
  }
  flush();
  return out.join('\n');
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
/** What a string costs in the JSON reply, escapes included. */
const jsonBytes = (text: string) => bytes(JSON.stringify(text));
/** `{"name":…,"content":…,"truncated":false},` around a file's name and content. */
const FILE_OVERHEAD = 48;
const MAX_MCP_NOTES = 64;
/** Room kept in each MCP's share for Counterpart's own lines about it. */
const SUMMARY_RESERVE = 1200;
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
  const clean = (text: string) => cleanText(text, secrets, source.home);
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
      // Names, contents and notes all count against the bundle's share, as JSON (escapes included). The few lines
      // Counterpart adds about this MCP (at most four, each well under 300 bytes) are reserved first.
      let budget = maxBytes - SUMMARY_RESERVE;
      let kept = 0;
      for (const note of diagnostics.notes.slice(0, MAX_MCP_NOTES)) {
        const line = oneLine(`${label} for ${printer}: ${removeSecrets(note, secrets)}`);
        if (jsonBytes(line) > budget) break;
        budget -= jsonBytes(line); said.push(line); kept++;
      }
      const summary: string[] = [];
      if (answer.infoUnread) summary.push(`${label} for ${printer}: its printer info couldn't be read, so Counterpart asked for its diagnostics without it.`);
      if (diagnostics.notes.length > kept) summary.push(`${label} for ${printer}: ${diagnostics.notes.length - kept} more of its notes were left out to keep the export small.`);
      let left = 0, unsafe = 0;
      for (const file of diagnostics.files) {
        if (!safeName(file.name)) { unsafe++; continue; }
        const name = `${folder}/${file.name}`;
        const room = budget - jsonBytes(name) - FILE_OVERHEAD;
        if (room < 0) { left++; continue; }
        // The MCP keeps to max_bytes; a bundle that doesn't is cut here, keeping each file's newest lines.
        // Known secrets go before the cut, and the cut drops its partial first line, so no part of one survives it.
        const kept = tail(removeSecrets(file.content, secrets), Math.floor(room / 2));
        budget -= jsonBytes(name) + FILE_OVERHEAD + jsonBytes(kept.content);
        out.push({name, content: kept.content, truncated: file.truncated || kept.truncated});
      }
      if (unsafe) summary.push(`${label} for ${printer} named ${unsafe === 1 ? 'a file' : `${unsafe} files`} this export can't use; ${unsafe === 1 ? 'it was' : 'they were'} left out.`);
      if (left) summary.push(`${label} for ${printer}: ${left} of its files were left out to keep the export small.`);
      return {files: out, notes: [...summary.map(oneLine), ...said]};
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
