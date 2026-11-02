import type {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import type {PrinterHandoffConfig} from './config.js';
import type {ElicitationContext, ElicitationRelay} from './elicitation.js';
import {PrinterMcpClient, PrinterMcpError, type PrinterToolCatalog} from './mcp-client.js';

/** Time, injectable so the pool's lifetime and backoff are testable without real waits. */
export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.(); // An idle session never keeps the companion alive.
    return timer;
  },
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** PRD §8.3: the session closes this long after its last holder and call. */
export const SESSION_IDLE_CLOSE_MS = 120_000;
/** PRD §8.3: waits before reconnecting after the 1st, 2nd, … consecutive failure. */
export const SESSION_BACKOFF_MS = [1000, 2000, 5000, 15000, 30000] as const;

/**
 * Calls that change the printer, or that the printer MCP may answer with a
 * human confirmation, run one at a time per destination. bambu-printer-mcp's
 * questions carry no reference to the call that caused them, so the mutex
 * holder is the only call they can belong to. `slice_stl` is local CPU work
 * and only takes the mutex when the caller says it may ask (a missing model).
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'print_3mf', 'print_3mf_bambu_network', 'upload_gcode', 'upload_file', 'start_print', 'start_print_job',
  'pause_print', 'resume_print', 'cancel_print', 'clear_hms_errors', 'process_and_print_stl', 'delete_printer_file',
  'set_temperature', 'set_printer_temperature', 'set_fan_speed', 'set_print_speed', 'set_light', 'skip_objects',
]);

export interface SessionHealth {
  connected: boolean;
  /** When a call last returned a result. */
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  /** No reconnect attempt before this time (backoff). */
  retryAt?: number;
  lastError?: string;
  holders: number;
}

export type SessionClient = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool' | 'getTool' | 'catalog'>;
export type SessionClientFactory = (config: PrinterHandoffConfig, options: {relay?: ElicitationRelay; onStderr?: (chunk: string) => void; onClose: () => void}) => SessionClient;

export interface PrinterSessionOptions {
  relay?: ElicitationRelay;
  onStderr?: (chunk: string) => void;
  idleCloseMs?: number;
  backoffMs?: readonly number[];
  clock?: SessionClock;
  clientFactory?: SessionClientFactory;
  /** Called after every successful (re)connection, with the server's catalog. */
  onConnect?: (catalog: PrinterToolCatalog) => void;
}

export interface SessionCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatchSensitive?: boolean;
  beforeDispatch?: () => Promise<void>;
  /** Tags the questions this call causes. Implies the mutex. */
  elicitationContext?: ElicitationContext;
  /** Overrides MUTATING_TOOLS for this call. */
  exclusive?: boolean;
  /** During a reconnect backoff, fail at once with `printer-unreachable` instead of waiting it out. */
  failFast?: boolean;
  /** The caller already holds the mutex through exclusive(): don't take it again, but tag questions as its holder. */
  held?: boolean;
}

function sleep(clock: SessionClock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PrinterMcpError('cancelled')); return; }
    const timer = clock.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clock.clearTimeout(timer); reject(new PrinterMcpError('cancelled')); };
    signal?.addEventListener('abort', abort, {once: true});
  });
}

/**
 * One long-lived MCP connection to one destination (PRD §8.3), shared by every
 * call to that printer. Holders (the print monitor, open screens) keep it
 * open; it closes `idleCloseMs` after the last holder and call are gone. A
 * lost connection is reopened by the next call after the backoff.
 */
export class PrinterSession {
  readonly id: string;
  #config: PrinterHandoffConfig;
  readonly #options: PrinterSessionOptions;
  readonly #clock: SessionClock;
  readonly #backoff: readonly number[];
  #client?: SessionClient;
  #connecting?: Promise<SessionClient>;
  #holders = 0;
  #inflight = 0;
  #idleTimer?: unknown;
  #mutex: Promise<void> = Promise.resolve();
  #failures = 0;
  #retryAt = 0;
  #lastSuccessAt?: number;
  #lastFailureAt?: number;
  #lastError?: string;
  #closed = false;
  #lastCatalog?: PrinterToolCatalog;

  constructor(id: string, config: PrinterHandoffConfig, options: PrinterSessionOptions = {}) {
    this.id = id;
    this.#config = structuredClone(config);
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#backoff = options.backoffMs ?? SESSION_BACKOFF_MS;
  }

  get config(): PrinterHandoffConfig { return structuredClone(this.#config); }
  get backend(): PrinterHandoffConfig['backend'] { return this.#config.backend; }
  /** The catalog of the live connection, or of the last one (tools rarely change between restarts). */
  get catalog(): PrinterToolCatalog | undefined { return this.#client?.catalog ?? this.#lastCatalog; }
  get closed(): boolean { return this.#closed; }

  health(): SessionHealth {
    return {connected: !!this.#client, consecutiveFailures: this.#failures, holders: this.#holders,
      ...(this.#lastSuccessAt !== undefined ? {lastSuccessAt: this.#lastSuccessAt} : {}),
      ...(this.#lastFailureAt !== undefined ? {lastFailureAt: this.#lastFailureAt} : {}),
      ...(this.#retryAt > this.#clock.now() ? {retryAt: this.#retryAt} : {}),
      ...(this.#lastError ? {lastError: this.#lastError} : {})};
  }

  /** Keeps the session open until the returned release is called (once; later calls do nothing). */
  hold(): () => void {
    this.#holders++;
    this.#cancelIdle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holders--;
      this.#scheduleIdle();
    };
  }

  hasTool(name: string): boolean { return this.catalog?.tools.some(tool => tool.name === name) ?? false; }
  getTool(name: string): Tool {
    const tool = this.catalog?.tools.find(candidate => candidate.name === name);
    if (!tool) throw new PrinterMcpError('missing-tool');
    return tool;
  }

  /** Connects if needed and returns the server's catalog. */
  async connect(options: {signal?: AbortSignal; failFast?: boolean} = {}): Promise<PrinterToolCatalog> {
    this.#inflight++;
    this.#cancelIdle();
    try { return (await this.#ensure(options)).catalog!; }
    finally { this.#inflight--; this.#scheduleIdle(); }
  }

  async call(name: string, args: Record<string, unknown> = {}, options: SessionCallOptions = {}): Promise<CallToolResult> {
    this.#inflight++;
    this.#cancelIdle();
    let unlock: (() => void) | undefined;
    try {
      const exclusive = options.held === true || (options.exclusive ?? (MUTATING_TOOLS.has(name) || options.elicitationContext !== undefined));
      if (exclusive && !options.held) unlock = await this.#lock(options.signal);
      const client = await this.#ensure(options);
      const result = await client.callTool(name, args, {
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
        ...(options.dispatchSensitive ? {dispatchSensitive: true} : {}),
        ...(options.beforeDispatch ? {beforeDispatch: options.beforeDispatch} : {}),
        // Only the mutex holder tags questions; any other question goes untagged.
        ...(exclusive ? {elicitationContext: options.elicitationContext ?? {}} : {}),
      });
      this.#failures = 0;
      this.#lastSuccessAt = this.#clock.now();
      this.#lastError = undefined;
      return result;
    } catch (error) {
      // MCP cancellation doesn't stop a server handler that is already running: an
      // abandoned printer call could still ask its question and be answered under
      // the next call's tag. End that connection before anyone else takes the mutex.
      if ((unlock || options.held) && (error as PrinterMcpError).incomplete) await this.#quarantine();
      throw error;
    } finally {
      unlock?.();
      this.#inflight--;
      this.#scheduleIdle();
    }
  }

  /** Runs `work` holding the destination's mutex: no mutating call starts meanwhile. */
  async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const unlock = await this.#lock(signal);
    try { return await work(); } finally { unlock(); }
  }

  /**
   * PRD §8.10: after an update, the next call starts the MCP afresh (optionally with a new process config).
   * Waits for the mutex, so no mutating call is cut off; the session stays usable and keeps its holders.
   */
  async restart(config?: PrinterHandoffConfig): Promise<void> {
    if (this.#closed) throw new PrinterMcpError('session-closed');
    const unlock = await this.#lock();
    try {
      await this.#connecting?.catch(() => undefined);
      if (config) this.#config = structuredClone(config);
      const client = this.#client;
      this.#client = undefined;
      this.#failures = 0;
      this.#retryAt = 0;
      await client?.close().catch(() => undefined);
    } finally { unlock(); }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cancelIdle();
    const client = this.#client;
    this.#client = undefined;
    await client?.close().catch(() => undefined);
    // A connection still opening sees `closed` and closes itself.
    await this.#connecting?.catch(() => undefined);
  }

  async #lock(signal?: AbortSignal): Promise<() => void> {
    let release!: () => void;
    const previous = this.#mutex;
    const mine = new Promise<void>(resolve => { release = resolve; });
    this.#mutex = previous.then(() => mine);
    if (signal) {
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new PrinterMcpError('cancelled'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true});
      });
      try { await Promise.race([previous, aborted]); }
      catch (error) { void previous.then(release); throw error; }
      finally { signal.removeEventListener('abort', onAbort); }
    } else await previous;
    return release;
  }

  async #quarantine(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    await client?.close().catch(() => undefined);
  }

  /** Each caller stops waiting on its own signal; the shared connection attempt has its own lifetime. */
  async #ensure(options: {signal?: AbortSignal; failFast?: boolean}): Promise<SessionClient> {
    const waitFor = <T>(promise: Promise<T>): Promise<T> => {
      const signal = options.signal;
      if (!signal) return promise;
      if (signal.aborted) return Promise.reject(new PrinterMcpError('cancelled'));
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new PrinterMcpError('cancelled'));
        signal.addEventListener('abort', abort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    };
    if (this.#closed) throw new PrinterMcpError('session-closed');
    if (this.#client) return this.#client;
    if (this.#connecting) return waitFor(this.#connecting);
    const wait = this.#retryAt - this.#clock.now();
    if (wait > 0) {
      if (options.failFast) throw new PrinterMcpError('printer-unreachable');
      await sleep(this.#clock, wait, options.signal);
      if (this.#client) return this.#client;
      if (this.#connecting) return waitFor(this.#connecting);
    }
    const attempt = (async () => {
      let client!: SessionClient;
      const factory: SessionClientFactory = this.#options.clientFactory ?? ((config, opts) => new PrinterMcpClient(config, opts));
      client = factory(this.#config, {relay: this.#options.relay, onStderr: this.#options.onStderr, onClose: () => this.#lost(client)});
      try {
        const catalog = await client.connect();
        if (this.#closed) { await client.close().catch(() => undefined); throw new PrinterMcpError('session-closed'); }
        this.#client = client;
        this.#lastCatalog = catalog;
        this.#options.onConnect?.(catalog);
        // Every caller may have given up while it opened: the idle close still applies.
        queueMicrotask(() => this.#scheduleIdle());
        return client;
      } catch (error) {
        if (!this.#closed) this.#failed((error as {code?: string}).code ?? 'connection-failed');
        throw error;
      }
    })();
    this.#connecting = attempt;
    void attempt.catch(() => undefined).finally(() => { if (this.#connecting === attempt) this.#connecting = undefined; });
    return waitFor(attempt);
  }

  #failed(code: string): void {
    this.#failures++;
    const now = this.#clock.now();
    this.#lastFailureAt = now;
    this.#lastError = code;
    this.#retryAt = now + this.#backoff[Math.min(this.#failures - 1, this.#backoff.length - 1)]!;
  }

  #lost(client: SessionClient): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    if (!this.#closed) this.#failed('connection-lost');
  }

  #cancelIdle(): void {
    if (this.#idleTimer !== undefined) this.#clock.clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #scheduleIdle(): void {
    if (this.#holders > 0 || this.#inflight > 0 || !this.#client || this.#closed) return;
    this.#cancelIdle();
    const ms = this.#options.idleCloseMs ?? SESSION_IDLE_CLOSE_MS;
    this.#idleTimer = this.#clock.setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#holders > 0 || this.#inflight > 0) return;
      const client = this.#client;
      this.#client = undefined;
      void client?.close().catch(() => undefined);
    }, ms);
  }
}

/** One session per destination id, created on first use (PRD §8.3). */
export class PrinterSessionPool {
  readonly #sessions = new Map<string, PrinterSession>();
  readonly #options: Omit<PrinterSessionOptions, 'relay' | 'onStderr' | 'onConnect'>;
  #closed = false;
  constructor(options: Omit<PrinterSessionOptions, 'relay' | 'onStderr' | 'onConnect'> = {}) { this.#options = options; }

  /** The destination's session; the first call for an id fixes its config and relay. */
  session(id: string, config: PrinterHandoffConfig, options: Pick<PrinterSessionOptions, 'relay' | 'onStderr' | 'onConnect'> = {}): PrinterSession {
    if (this.#closed) throw new PrinterMcpError('session-closed');
    let session = this.#sessions.get(id);
    if (!session) {
      session = new PrinterSession(id, config, {...this.#options, ...options});
      this.#sessions.set(id, session);
    }
    return session;
  }
  get(id: string): PrinterSession | undefined { return this.#sessions.get(id); }
  sessions(): PrinterSession[] { return [...this.#sessions.values()]; }

  /** Closes every session and its MCP process (companion shutdown). */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#sessions.values()].map(session => session.close()));
  }
}
