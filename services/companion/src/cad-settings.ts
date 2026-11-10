import {randomUUID} from 'node:crypto';
import {PrinterMcpClient, PrinterMcpError, toolResultJson, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {toolErrorText} from './touchup/blender.js';
import {mcpPackageName} from './printing/print-settings.js';
import type {EventDraft} from './printing/monitor.js';

/**
 * Settings → the code design engine (PRD §5.9, §7.5, §8.9): the printer MCP's own `cad_status`, and Set Up, which runs
 * its `cad_setup {install: true}` on the printer MCP as the companion runs it. Every layout reads the same view.
 * The words are Counterpart's, from the MCP's structured fields; only a failed setup shows the MCP's own reason.
 */
export interface CadView {
  state: 'checking' | 'unavailable' | 'not-set-up' | 'setting-up' | 'ready';
  /** One plain sentence for the row. */
  message: string;
  /** The printer MCP whose engine this is. */
  server?: string;
  /** While setting up: seconds since Set Up started, from the MCP's progress. */
  seconds?: number;
  /**
   * What the engine takes on disk, from the MCP's `storage` fields: before Set Up the download and installed size it
   * expects, after it the size it measured. Absent when the MCP doesn't report them.
   */
  size?: string;
  /**
   * The last Set Up's outcome in the MCP's own words: its `message` when it finished; when it was refused, its
   * `message` and `suggestion`, with the structured refusal (`code` included) passed through as the MCP gave it.
   * Counterpart never chooses words or actions by the code.
   */
  result?: {ok: boolean; message: string; suggestion?: string; refusal?: Record<string, unknown>};
  /** Set Up is offered: the MCP has the engine and isn't setting it up now. */
  canSetUp: boolean;
}

/** Bytes as people see them in Finder (decimal units), for the sizes the MCP reports. */
export function diskSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const whole = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The row's size line from the MCP's `storage`: what Set Up takes while it isn't set up, what it uses once it is. */
export function storageWords(storage: unknown, installed: boolean): string | undefined {
  if (!storage || typeof storage !== 'object') return undefined;
  const {expected_download_bytes: download, expected_installed_bytes: expected, installed_bytes: measured} = storage as Record<string, unknown>;
  // Installed: only what the MCP measured counts (null is "not measured yet": say nothing rather than guess).
  if (installed) { const used = whole(measured); return used ? `Uses ${diskSize(used)} on this computer.` : undefined; }
  const fetch = whole(download), size = whole(expected);
  if (fetch && size) return `Set Up downloads about ${diskSize(fetch)} and uses about ${diskSize(size)} on this computer.`;
  if (size) return `Set Up uses about ${diskSize(size)} on this computer.`;
  return undefined;
}

/** A refused tool's structured result, as the MCP gave it (`status: "error"`), or undefined. */
function refusalOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && (value as {status?: unknown}).status === 'error' && typeof (value as {message?: unknown}).message === 'string'
    ? value as Record<string, unknown> : undefined;
}

type Client = Pick<PrinterMcpClient, 'connect' | 'hasTool' | 'callTool' | 'close'>;
export interface CadCalls {
  /** `cad_status` on the printer MCP as the companion runs it: its structured answer, or null when it has no such tool. */
  status(signal?: AbortSignal): Promise<{status: Record<string, unknown> | null; server: string; error?: string}>;
  /**
   * `cad_setup {install: true}`: its structured answer, or the MCP's error. A refusal's structured result is `refusal`,
   * as the MCP gave it. `onProgress` gets each progress notification.
   */
  setup(onProgress: () => void, signal?: AbortSignal): Promise<{setup: Record<string, unknown> | null; server: string; error?: string; refusal?: Record<string, unknown>}>;
}

/** The two calls, on the printer MCP as the companion runs it (`running()`, with any Update or Move override). */
export function cadCalls(running: () => PrinterHandoffConfig, client: (config: PrinterHandoffConfig) => Client = config => new PrinterMcpClient(config)): CadCalls {
  const call = async (tool: string, args: Record<string, unknown>, options: {timeoutMs: number; onProgress?: () => void; signal?: AbortSignal}) => {
    const config = running(), server = mcpPackageName(config.backend), mcp = client(config);
    const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs);
    try {
      await mcp.connect(signal);
      if (!mcp.hasTool(tool)) return {result: null, server};
      let reply;
      try { reply = await mcp.callTool(tool, args, {signal, timeoutMs: options.timeoutMs, ...(options.onProgress ? {onProgress: options.onProgress} : {})}); }
      catch (error) {
        // A tool's own error result is its answer; a call that didn't complete is not, and still throws.
        if (error instanceof PrinterMcpError && error.code === 'tool-failed' && !error.incomplete) {
          const refusal = refusalOf(error.structured);
          return {result: null, server, error: (refusal?.message as string | undefined) ?? error.detail ?? `${tool} failed.`, ...(refusal ? {refusal} : {})};
        }
        throw error;
      }
      if (reply.isError) {
        const refusal = refusalOf(reply.structuredContent);
        return {result: null, server, error: (refusal?.message as string | undefined) ?? toolErrorText(reply), ...(refusal ? {refusal} : {})};
      }
      return {result: toolResultJson<Record<string, unknown>>(reply), server};
    } finally { await mcp.close().catch(() => undefined); }
  };
  return {
    status: async signal => { const {result, ...rest} = await call('cad_status', {}, {timeoutMs: 30_000, ...(signal ? {signal} : {})}); return {status: result, ...rest}; },
    // The MCP reports progress every few seconds while it installs; each one restarts the wait, up to the companion's ceiling.
    // The companion's ceiling for one install is 20 minutes.
    setup: async (onProgress, signal) => { const {result, ...rest} = await call('cad_setup', {install: true}, {timeoutMs: 120_000, onProgress, signal: signal ?? AbortSignal.timeout(20 * 60_000)}); return {setup: result, ...rest}; },
  };
}

const STALE_MS = 30_000;

export class CadSettings {
  #status?: {status: Record<string, unknown> | null; server: string; at: number; error?: string};
  #setup?: {startedAt: number; seconds: number};
  #result?: {ok: boolean; message: string};
  #refreshing?: Promise<void>;
  readonly #now: () => number;
  constructor(private readonly deps: {calls: CadCalls; emit: (event: EventDraft) => Promise<void>; now?: () => number;
    /** Waits for the code engine's turn (passes hold it while they run); refuses after `waitMs`. */
    lock?: (waitMs: number) => Promise<() => Promise<void>>}) {
    this.#now = deps.now ?? Date.now;
  }

  /** The row every layout shows. Reads `cad_status` again when the last answer is older than 30 s. */
  async view(): Promise<CadView> {
    if (!this.#setup && (!this.#status || this.#now() - this.#status.at > STALE_MS)) await this.refresh().catch(() => undefined);
    return this.current();
  }

  /**
   * The row as last read, for passive settings reads: it never starts the printer MCP (settings.md: a passive refresh
   * launches no MCP). The row itself reads fresh with `view()` (`cad.status`, `GET /v1/settings/cad`).
   */
  snapshot(): CadView { return this.current(); }

  current(): CadView {
    const server = this.#status?.server;
    const named = server ? {server} : {};
    const result = this.#result ? {result: this.#result} : {};
    const engine = this.#status?.status;
    const sized = storageWords(engine?.storage, engine?.configured === true);
    const size = sized ? {size: sized} : {};
    if (this.#setup) return {state: 'setting-up', message: `Setting up… ${this.#setup.seconds} s so far.`, seconds: this.#setup.seconds, canSetUp: false, ...named, ...size};
    if (!this.#status) return {state: 'checking', message: 'Checking…', canSetUp: false, ...result};
    const status = this.#status.status;
    if (!status) {
      // No cad_status at all: an older printer MCP (or one that can't be reached right now).
      return this.#status.error
        ? {state: 'unavailable', message: `Counterpart couldn't check ${server}. Check it in Settings → Printers.`, canSetUp: false, ...named}
        : {state: 'unavailable', message: `Update ${server} in Settings → Printers to use its code design engine.`, canSetUp: false, ...named};
    }
    if (status.ready === true) return {state: 'ready', message: 'Ready. New designs and scan cleanups use it.', canSetUp: true, ...named, ...size, ...result};
    return {state: 'not-set-up', message: status.configured === true ? 'Installed, but not checked since the last update. Set it up again.' : 'Not set up yet.', canSetUp: true, ...named, ...size, ...result};
  }

  /** Asks the printer MCP's `cad_status` now, and tells every client when the row changed. */
  refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      const before = JSON.stringify(this.current());
      try {
        const answer = await this.deps.calls.status();
        this.#status = {...answer, at: this.#now()};
      } catch (error) {
        this.#status = {status: null, server: this.#status?.server ?? 'your printer MCP', at: this.#now(), error: error instanceof Error ? error.message : String(error)};
      }
      if (JSON.stringify(this.current()) !== before) await this.#changed();
    })().finally(() => { this.#refreshing = undefined; });
    return this.#refreshing;
  }

  /**
   * Set Up: starts `cad_setup {install: true}` in the background and returns the row at once (an install can take
   * minutes, longer than any request). Never while a code pass runs: the MCP runs one engine job at a time.
   */
  async setUp(): Promise<CadView> {
    if (this.#setup) return this.current();
    const view = await this.view();
    if (view.state === 'unavailable' || view.state === 'checking') throw new CadSetupRefused(view.message);
    let release: (() => Promise<void>) | undefined;
    try { release = await this.deps.lock?.(2000); }
    catch { throw new CadSetupRefused('Wait until the design that is running finishes, then set it up.'); }
    const startedAt = this.#now();
    this.#setup = {startedAt, seconds: 0};
    this.#result = undefined;
    await this.#changed();
    void (async () => {
      try {
        const answer = await this.deps.calls.setup(() => {
          if (!this.#setup) return;
          this.#setup.seconds = Math.round((this.#now() - startedAt) / 1000);
          void this.#changed();
        });
        const message = typeof answer.setup?.message === 'string' ? answer.setup.message : undefined;
        const error = answer.error ?? (typeof answer.setup?.error === 'string' && answer.setup.ready !== true ? answer.setup.error : undefined);
        // A refusal is shown in the MCP's own sentence and suggestion; its code travels with it, unread here.
        const suggestion = typeof answer.refusal?.suggestion === 'string' ? {suggestion: answer.refusal.suggestion} : {};
        this.#result = answer.setup?.ready === true ? {ok: true, message: message ?? 'Set up.'}
          : {ok: false, message: error ?? (answer.setup ? 'Set up did not finish.' : `Update ${answer.server} in Settings → Printers to use its code design engine.`),
            ...suggestion, ...(answer.refusal ? {refusal: answer.refusal} : {})};
      } catch (error) {
        this.#result = {ok: false, message: error instanceof Error ? error.message : String(error)};
      } finally {
        this.#setup = undefined;
        await release?.().catch(() => undefined);
        this.#status = undefined;
        await this.refresh().catch(() => undefined);
        await this.#changed();
      }
    })();
    return this.current();
  }

  async #changed(): Promise<void> {
    await this.deps.emit({id: randomUUID(), type: 'settings.changed', data: {keys: ['cad']}}).catch(() => undefined);
  }
}

/** Set Up can't start now; the message says why, in plain words. */
export class CadSetupRefused extends Error {
  constructor(message: string) { super(message); this.name = 'CadSetupRefused'; }
}
