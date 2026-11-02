import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

/**
 * PRD §9.6: Blender runs only while a pass needs it. A pass starts it (or reuses one already answering on the
 * MCP port), and when the pass ends with nothing queued, Counterpart quits the Blender it started itself, by
 * pid. A Blender the person opened is never closed. Between jobs only the menu-bar app and the companion run.
 */

const APP_SCRIPT = ['Contents', 'Resources', 'Payload', 'source', 'services', 'companion', 'blender', 'start_blender_mcp.py'];

/** The installed app's own startup script: never a worktree or a dev checkout. */
export function bundledBlenderScript(options: {exists?: (path: string) => boolean; home?: string; moduleUrl?: string} = {}): string | undefined {
  const exists = options.exists ?? existsSync;
  const candidates = [
    join('/Applications', 'Scan to Make.app', ...APP_SCRIPT),
    join(options.home ?? homedir(), 'Applications', 'Scan to Make.app', ...APP_SCRIPT),
  ];
  // The companion running from inside an installed app bundle may use its own copy.
  const own = fileURLToPath(new URL('../../blender/start_blender_mcp.py', options.moduleUrl ?? import.meta.url));
  if (/\.app\/Contents\//.test(own)) candidates.unshift(own);
  return candidates.find(path => exists(path));
}

export class BlenderScriptMissingError extends Error {
  constructor() { super("Counterpart's Blender helper isn't installed. Reinstall Counterpart, or open Blender with the Blender MCP add-on yourself."); this.name = 'BlenderScriptMissingError'; }
}

export interface BlenderHostDeps {
  /** Something answers on the Blender MCP port. */
  listening(): Promise<boolean>;
  /** Opens Blender in the background with the startup script. */
  launch(script: string): Promise<void>;
  /** Pids of Blenders running this startup script. */
  pidsRunning(script: string): Promise<number[]>;
  alive(pid: number): boolean;
  /** The pid listening on the Blender MCP port, if it can be told. */
  listenerPid(): Promise<number | undefined>;
  terminate(pid: number): void;
  script(): string | undefined;
  /** Where the pid of the Blender Counterpart started is kept, so a restarted companion still knows it. */
  statePath: string;
  sleep?: (ms: number) => Promise<void>;
  readyTimeoutMs?: number;
  quitTimeoutMs?: number;
}

export class BlenderHost {
  readonly #deps: BlenderHostDeps;
  #owned?: {pid: number; script: string};
  #loaded = false;
  constructor(deps: BlenderHostDeps) { this.#deps = deps; }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const saved = JSON.parse(await readFile(this.#deps.statePath, 'utf8')) as {pid?: unknown; script?: unknown};
      if (typeof saved.pid === 'number' && typeof saved.script === 'string') this.#owned = {pid: saved.pid, script: saved.script};
    } catch { /* nothing recorded */ }
  }
  async #save(): Promise<void> {
    if (!this.#owned) { await rm(this.#deps.statePath, {force: true}).catch(() => undefined); return; }
    await mkdir(dirname(this.#deps.statePath), {recursive: true, mode: 0o700});
    const temporary = `${this.#deps.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#owned) + '\n', {mode: 0o600});
    await rename(temporary, this.#deps.statePath);
  }
  /** The recorded Blender is still ours: alive and still running our script (a reused pid is someone else's). */
  async #ours(): Promise<boolean> {
    const owned = this.#owned;
    return !!owned && this.#deps.alive(owned.pid) && (await this.#deps.pidsRunning(owned.script).catch(() => [])).includes(owned.pid);
  }

  /** The pid Counterpart started, if it is still running. */
  async owned(): Promise<number | undefined> { await this.#load(); return await this.#ours() ? this.#owned!.pid : undefined; }

  /** A pass starts: reuse whatever answers on the port (the person's own Blender included), else start one. */
  async begin(): Promise<'reused' | 'launched'> {
    await this.#load();
    if (await this.#deps.listening()) return 'reused';
    // At most one Blender of Counterpart's own: one that started but doesn't answer is replaced.
    if (await this.#ours()) await this.#stop();
    else if (this.#owned) { this.#owned = undefined; await this.#save(); }
    const script = this.#deps.script();
    if (!script) throw new BlenderScriptMissingError();
    const before = new Set(await this.#deps.pidsRunning(script).catch(() => []));
    await this.#deps.launch(script);
    const sleep = this.#deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.#deps.readyTimeoutMs ?? 60_000);
    let pid: number | undefined;
    while (Date.now() < deadline) {
      pid ??= (await this.#deps.pidsRunning(script).catch(() => [])).find(item => !before.has(item));
      if (pid !== undefined && !this.#owned) { this.#owned = {pid, script}; await this.#save(); }
      if (await this.#deps.listening()) return 'launched';
      await sleep(250);
    }
    throw new Error(`Blender didn't start its MCP connection within ${Math.round((this.#deps.readyTimeoutMs ?? 60_000) / 1000)} seconds. Make sure the Blender MCP addon is installed and enabled in Blender.`);
  }

  /**
   * A pass ended. With another queued, Blender carries straight on; otherwise the one Counterpart started quits now.
   * `quit` asks the Blender on the port to quit itself (bpy.ops.wm.quit_blender through the printer MCP's bridge).
   */
  async end(queued: boolean, quit?: () => Promise<void>): Promise<void> {
    await this.#load();
    if (queued) return;
    if (!await this.#ours()) { if (this.#owned) { this.#owned = undefined; await this.#save(); } return; }
    await this.#stop(quit);
  }

  /** At start: a Blender a previous run started (and left behind by a crash) is quit. */
  async recover(quit?: () => Promise<void>): Promise<void> { await this.end(false, quit); }

  async #stop(quit?: () => Promise<void>): Promise<void> {
    const owned = this.#owned!;
    const sleep = this.#deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    // Gracefully through the bridge, only when the Blender answering the port is the one Counterpart started; then the pid.
    if (quit && await this.#deps.listenerPid().catch(() => undefined) === owned.pid) await quit().catch(() => undefined);
    const deadline = Date.now() + (this.#deps.quitTimeoutMs ?? 10_000);
    while (this.#deps.alive(owned.pid) && Date.now() < deadline) await sleep(200);
    if (this.#deps.alive(owned.pid)) this.#deps.terminate(owned.pid);
    this.#owned = undefined;
    await this.#save();
  }
}

/** Pids whose command line runs Blender with this script. */
export async function blenderPidsRunning(script: string): Promise<number[]> {
  const {stdout} = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,command=']);
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && /Blender/.test(match[2]!) && match[2]!.includes(`--python ${script}`) ? [Number(match[1])] : [];
  });
}

/** The pid listening on 127.0.0.1:<port>. */
export async function blenderListenerPid(port: number): Promise<number | undefined> {
  try {
    const {stdout} = await promisify(execFile)('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The production host: the app's bundled script, opened in the background; its pid recorded under the data root. */
export function defaultBlenderHost(statePath: string, options: {port: number; listening: () => Promise<boolean>; launch: (script: string) => Promise<void>}): BlenderHost {
  return new BlenderHost({listening: options.listening, launch: options.launch, pidsRunning: blenderPidsRunning, alive,
    listenerPid: () => blenderListenerPid(options.port), terminate: pid => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } },
    script: () => bundledBlenderScript(), statePath});
}
