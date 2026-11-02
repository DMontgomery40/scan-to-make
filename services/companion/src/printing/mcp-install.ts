import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {homedir, userInfo} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve, sep} from 'node:path';
import type {PrinterHandoffConfig} from '@scan-to-make/printer-handoff';

/**
 * PRD §8.10: how a printer MCP is installed, worked out from the process the
 * companion runs, so Update can update that installation where it is.
 */
export type McpInstall =
  | {type: 'npx'; pkg: string; spec: string; version?: string}
  | {type: 'global'; pkg: string; prefix: string; node?: string; entry?: string}
  | {type: 'app'; pkg: string; prefix: string; node?: string; entry?: string}
  | {type: 'checkout'; pkg: string; dir: string; node?: string}
  | {type: 'unresolved'; pkg: string; found: string};
/**
 * A wrapped install (`ssh … 127.0.0.1` running one of the above) says how it was reached, and the directory and
 * variables its command line sets (so a fresh copy can start the same way).
 */
export type ResolvedMcpInstall = McpInstall & {via?: {kind: 'ssh'; host: string; from: 'remote-command' | 'authorized-keys'; cwd?: string; env?: Record<string, string>}};

export interface InstallEnvironment {
  home: string;
  user: string;
  /** The app's own installs: `<data root>/printers`. */
  appPrinters: string;
  readFile(path: string): string | undefined;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  realpath(path: string): string;
}

export function hostEnvironment(dataRoot: string): InstallEnvironment {
  return {
    home: homedir(), user: userInfo().username, appPrinters: join(dataRoot, 'printers'),
    readFile: path => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
    exists: path => existsSync(path),
    isDirectory: path => { try { return statSync(path).isDirectory(); } catch { return false; } },
    realpath: path => { try { return realpathSync(path); } catch { return path; } },
  };
}

/** The npm package for a backend. */
export function packageName(backend: PrinterHandoffConfig['backend']): string { return backend; }

/** Every printer on the same MCP install shares one id. */
export function mcpIdFor(install: ResolvedMcpInstall, config: PrinterHandoffConfig): string {
  const key = install.type === 'unresolved'
    ? `unresolved:${config.backend}:${config.process.command}\0${(config.process.args ?? []).join('\0')}`
    // The package is part of the key: both MCPs can live under one global prefix.
    : install.type === 'npx' ? `npx:${install.pkg}`
    : install.type === 'checkout' ? `checkout:${install.pkg}:${install.dir}` : `${install.type}:${install.pkg}:${install.prefix}`;
  return `mcp-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** Splits a POSIX shell command line into segments of words (`a && b; c` → [[a], [b], [c]]). Quotes and escapes are honoured. */
export function shellSegments(line: string): string[][] {
  const segments: string[][] = [[]];
  let word: string | undefined, i = 0;
  const end = () => { if (word !== undefined) { segments.at(-1)!.push(word); word = undefined; } };
  while (i < line.length) {
    const c = line[i]!;
    if (c === '\'') {
      const close = line.indexOf('\'', i + 1);
      if (close < 0) throw new Error('unterminated quote');
      word = (word ?? '') + line.slice(i + 1, close); i = close + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, text = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) { text += line[j + 1]; j += 2; continue; }
        text += line[j]; j++;
      }
      if (j >= line.length) throw new Error('unterminated quote');
      word = (word ?? '') + text; i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < line.length) { word = (word ?? '') + line[i + 1]; i += 2; continue; }
    if (/\s/.test(c)) { end(); i++; continue; }
    if (c === ';' || c === '&' || c === '|') {
      end();
      if (segments.at(-1)!.length) segments.push([]);
      i += line[i + 1] === c ? 2 : 1; continue;
    }
    word = (word ?? '') + c; i++;
  }
  end();
  return segments.filter(segment => segment.length);
}

/** The command a segment runs, without leading `VAR=value`, `exec` and `env VAR=value`, and the variables it sets. */
function commandOf(words: string[]): {argv: string[]; env: Record<string, string>} {
  let rest = [...words];
  const env: Record<string, string> = {};
  for (;;) {
    const assignment = rest[0] && /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(rest[0]);
    if (assignment) { env[assignment[1]!] = assignment[2]!; rest = rest.slice(1); continue; }
    if (rest[0] === 'exec' || rest[0] === 'env' || rest[0] === 'command' || rest[0] === 'nohup') { rest = rest.slice(1); continue; }
    return {argv: rest, env};
  }
}

/** What a shell command line runs: its last command, the directory it `cd`s into first and the variables it sets. */
export function shellCommand(line: string): {argv: string[]; cwd?: string; env: Record<string, string>} | undefined {
  const segments = shellSegments(line);
  let cwd: string | undefined;
  for (const segment of segments.slice(0, -1)) if (segment[0] === 'cd' && segment[1]) cwd = segment[1];
  const {argv, env} = commandOf(segments.at(-1) ?? []);
  return argv.length ? {argv, env, ...(cwd ? {cwd} : {})} : undefined;
}

// ssh options that take a value (OpenSSH 9).
const SSH_VALUE = new Set(['-b', '-B', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w']);
function parseSsh(args: string[]): {destination?: string; identity?: string; user?: string; remote: string[]} {
  let identity: string | undefined, user: string | undefined, i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--') { i++; break; }
    if (!arg.startsWith('-') || arg === '-') break;
    if (SSH_VALUE.has(arg)) {
      const value = args[i + 1];
      if (arg === '-i') identity = value;
      if (arg === '-l') user = value;
      if (arg === '-o' && value && /^user=/i.test(value)) user = value.slice(5);
      i += 2; continue;
    }
    // Joined forms: -i/path, -luser.
    if (arg.startsWith('-i') && arg.length > 2) identity = arg.slice(2);
    else if (arg.startsWith('-l') && arg.length > 2) user = arg.slice(2);
    i++;
  }
  const destination = args[i];
  return {...(destination ? {destination} : {}), ...(identity ? {identity} : {}), ...(user ? {user} : {}), remote: args.slice(i + 1)};
}

function sshHost(destination: string): {user?: string; host: string} {
  const plain = destination.replace(/^ssh:\/\//, '').replace(/:\d+$/, '');
  const at = plain.lastIndexOf('@');
  return at >= 0 ? {user: plain.slice(0, at), host: plain.slice(at + 1).replace(/^\[|\]$/g, '')} : {host: plain.replace(/^\[|\]$/g, '')};
}

/** The forced `command="…"` on the authorized_keys line for this public key. */
export function forcedCommand(authorizedKeys: string, publicKey: string): string | undefined {
  const key = publicKey.trim().split(/\s+/)[1];
  if (!key) return undefined;
  for (const line of authorizedKeys.split('\n')) {
    if (!line.includes(key) || line.trimStart().startsWith('#')) continue;
    const options = line.slice(0, line.indexOf(key));
    const match = /(?:^|,)\s*command="((?:[^"\\]|\\.)*)"/.exec(options);
    if (match) return match[1]!.replace(/\\(.)/g, '$1');
  }
  return undefined;
}

const NODE = /(^|\/)node(\d+)?$/;
function under(path: string, root: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }

/** Resolves an unwrapped command line to its installation. */
function resolveDirect(pkg: string, argv: string[], cwd: string | undefined, env: InstallEnvironment): McpInstall {
  const [command, ...args] = argv;
  if (!command) return {type: 'unresolved', pkg, found: 'an empty command'};
  const absolute = (path: string) => isAbsolute(path) ? path : cwd ? resolve(cwd, path) : path;
  // npx <pkg>[@version], npm exec, or node …/npx-cli.js
  const npxAt = basename(command) === 'npx' ? 0 : args.findIndex(arg => /(^|\/)npx-cli\.js$/.test(arg)) + 1 || -1;
  if (npxAt >= 0) {
    const rest = basename(command) === 'npx' ? args : args.slice(npxAt);
    const spec = rest.find(arg => !arg.startsWith('-') && (arg === pkg || arg.startsWith(`${pkg}@`)));
    if (!spec) return {type: 'unresolved', pkg, found: `npx running something other than ${pkg}`};
    const version = spec.slice(pkg.length + 1) || undefined;
    return {type: 'npx', pkg, spec, ...(version ? {version} : {})};
  }
  // node <entry> or the package's bin link.
  const node = NODE.test(command) ? absolute(command) : undefined;
  const entryArg = node ? args.find(arg => !arg.startsWith('-')) : undefined;
  const target = env.realpath(absolute(entryArg ?? command));
  const modules = target.lastIndexOf(`${sep}lib${sep}node_modules${sep}${pkg}${sep}`);
  if (modules > 0) {
    const prefix = target.slice(0, modules);
    const inApp = under(prefix, env.appPrinters);
    return {type: inApp ? 'app' : 'global', pkg, prefix, ...(node ? {node} : {}), entry: target};
  }
  // A git checkout: <dir>/dist/index.js (or build/) with <dir>/.git.
  for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
    if (env.exists(join(dir, 'package.json'))) {
      const name = (() => { try { return (JSON.parse(env.readFile(join(dir, 'package.json')) ?? '{}') as {name?: unknown}).name; } catch { return undefined; } })();
      if (name === pkg && env.exists(join(dir, '.git'))) return {type: 'checkout', pkg, dir, ...(node ? {node} : {})};
      if (name === pkg) return {type: 'unresolved', pkg, found: `a copy of ${pkg} at ${dir} that isn't an npm install or a git checkout`};
      break;
    }
  }
  return {type: 'unresolved', pkg, found: `${entryArg ? `${basename(command)} running ${target}` : target}, which isn't an install of ${pkg} Counterpart recognises`};
}

function launch(inner: {cwd?: string; env: Record<string, string>}): {cwd?: string; env?: Record<string, string>} {
  return {...(inner.cwd ? {cwd: inner.cwd} : {}), ...(Object.keys(inner.env).length ? {env: inner.env} : {})};
}

/** PRD §8.10's table, in order: npx, global npm prefix, the app's own install, git checkout, or wrapped in ssh. */
export function resolveMcpInstall(config: PrinterHandoffConfig, env: InstallEnvironment): ResolvedMcpInstall {
  const pkg = packageName(config.backend);
  const command = config.process.command, args = config.process.args ?? [];
  if (basename(command) !== 'ssh') return resolveDirect(pkg, [command, ...args], config.process.cwd, env);
  const ssh = parseSsh(args);
  if (!ssh.destination) return {type: 'unresolved', pkg, found: 'an ssh command without a host'};
  const {host, user: hostUser} = sshHost(ssh.destination);
  const user = hostUser ?? ssh.user ?? env.user;
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
  if (!local) return {type: 'unresolved', pkg, found: `${pkg} on ${host} over ssh. Counterpart can only update a copy on this Mac`};
  if (ssh.remote.length) {
    const inner = shellCommand(ssh.remote.join(' '));
    if (!inner) return {type: 'unresolved', pkg, found: 'an ssh command whose remote command is empty'};
    return {...resolveDirect(pkg, inner.argv, inner.cwd, env), via: {kind: 'ssh', host, from: 'remote-command', ...launch(inner)}};
  }
  if (user !== env.user) return {type: 'unresolved', pkg, found: `ssh to ${user}@${host}, another account on this Mac whose keys Counterpart can't read`};
  const identity = ssh.identity?.replace(/^~(?=\/)/, env.home);
  const publicKey = identity ? env.readFile(`${identity}.pub`) : undefined;
  if (!publicKey) return {type: 'unresolved', pkg, found: `ssh to ${host} with ${identity ? `the key ${identity}, whose .pub file isn't there` : 'no -i key'}, so Counterpart can't find the command it runs`};
  const authorized = env.readFile(join(env.home, '.ssh', 'authorized_keys'));
  const forced = authorized ? forcedCommand(authorized, publicKey) : undefined;
  if (!forced) return {type: 'unresolved', pkg, found: `ssh to ${host} with ${identity}, but ~/.ssh/authorized_keys has no command="…" for that key`};
  let inner;
  try { inner = shellCommand(forced); } catch { inner = undefined; }
  if (!inner) return {type: 'unresolved', pkg, found: `a forced command for ${identity} that Counterpart can't read`};
  return {...resolveDirect(pkg, inner.argv, inner.cwd, env), via: {kind: 'ssh', host, from: 'authorized-keys', ...launch(inner)}};
}

/** The version an install has on disk, when it says. */
export function installedVersion(install: McpInstall, env: InstallEnvironment): string | undefined {
  const file = install.type === 'global' || install.type === 'app' ? join(install.prefix, 'lib', 'node_modules', install.pkg, 'package.json')
    : install.type === 'checkout' ? join(install.dir, 'package.json') : undefined;
  if (!file) return install.type === 'npx' ? install.version : undefined;
  try { const version = (JSON.parse(env.readFile(file) ?? '{}') as {version?: unknown}).version; return typeof version === 'string' ? version : undefined; }
  catch { return undefined; }
}

/** npm for an installation: the one beside its node, else the usual places, newest nvm last. */
export function findNpm(node: string | undefined, env: InstallEnvironment, path = process.env.PATH ?? ''): string | undefined {
  const candidates = [
    ...(node ? [join(dirname(node), 'npm')] : []),
    ...path.split(':').filter(Boolean).map(dir => join(dir, 'npm')),
    '/opt/homebrew/bin/npm', '/usr/local/bin/npm',
    ...(() => {
      const nvm = join(env.home, '.nvm', 'versions', 'node');
      try { return readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, {numeric: true})).map(version => join(nvm, version, 'bin', 'npm')); } catch { return []; }
    })(),
  ];
  return candidates.find(candidate => env.exists(candidate));
}
