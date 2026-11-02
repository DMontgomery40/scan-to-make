import {setTimeout as delay} from 'node:timers/promises';
import {routeArgs, toolResultJson, type PrinterSession} from '@scan-to-make/printer-handoff';

export const CAMERA_CACHE_MS = 3000;
export const CAMERA_TIMEOUT_MS = 8000;
export const CAMERA_CAP_MS = 10_000;

export interface CameraFrame { bytes: Buffer; capturedAt: string; stream?: boolean; seq?: number }
export type CameraSize = 'card' | 'full';
export class CameraUnavailableError extends Error {
  constructor(readonly reason: 'no-camera' | 'unreachable' | 'not-supported') { super(reason === 'not-supported' ? 'This printer MCP does not support watched camera streams yet.' : reason === 'no-camera' ? "This printer has no camera Counterpart can use." : "The printer's camera didn't answer. Try again in a moment."); this.name = 'CameraUnavailableError'; }
}

/** A frame up to this old is served at once while a fresh one is fetched, with its real `capturedAt`. */
export const CAMERA_STALE_MS = 120_000;
/** A viewer keeps the destination's session held this long after its last request, so it stays connected. */
export const CAMERA_HOLD_MS = 30_000;

/**
 * The printer camera through the destination's session (PRD §8.6): a refreshing
 * photo, never video. One shared 3 s cache per destination, so several viewers
 * (the phone, the Mac, a Live Activity) don't hit the camera more than once.
 * A view never waits on the camera when there is a recent frame: it gets that
 * frame (with when it was taken) while the next one is fetched.
 */
export class CameraFrames {
  /** The last frame each destination returned, and when it arrived. */
  readonly #last = new Map<string, {atMs: number; frame: CameraFrame}>();
  readonly #inflight = new Map<string, Promise<CameraFrame>>();
  readonly #holds = new Map<string, {release: () => void; timer: ReturnType<typeof setTimeout>}>();
  readonly #streams = new Map<string, {session: PrinterSession; startedAt: string}>();
  readonly #cursors = new Map<string, number>();
  readonly #viewers = new Map<string, {count: number; controller: AbortController; release: () => void}>();
  readonly #now: () => number;
  constructor(options: {now?: () => number} = {}) { this.#now = options.now ?? Date.now; }

  /**
   * `fresh` skips the cache (a person asked for a new picture) and refreshes it. `view` is a person
   * looking (a camera route): their session stays held while they keep looking.
   */
  async frame(destinationId: string, session: PrinterSession, options: {model?: string; fresh?: boolean; view?: boolean; size?: CameraSize; watch?: boolean; signal?: AbortSignal} = {}): Promise<CameraFrame> {
    if (options.view && !options.watch) this.#hold(destinationId, session);
    await session.connect({failFast: true}).catch(() => { throw new CameraUnavailableError('unreachable'); });
    const streaming = !!options.view && this.#supportsStream(session);
    const key = streaming ? `${destinationId}:${options.size ?? 'card'}` : destinationId;
    const last = this.#last.get(key), age = last ? this.#now() - last.atMs : Infinity;
    if (!options.fresh && last && age < (streaming ? 1500 : CAMERA_CACHE_MS)) return last.frame;
    const next = this.#inflight.get(key) || this.#fetch(key, destinationId, session, options.model, streaming ? options.size ?? 'card' : undefined, options.watch ? options.signal : undefined);
    // Only a person looking gets the older frame meanwhile; an event's frame is saved for good, so it waits for a new one.
    if (!streaming && !options.fresh && options.view && last && age < CAMERA_STALE_MS) { next.catch(() => undefined); return last.frame; }
    try { return await next; }
    catch (error) { throw error instanceof CameraUnavailableError ? error : new CameraUnavailableError('unreachable'); }
  }

  #supportsStream(session: PrinterSession): boolean {
    return ['camera_stream_start', 'camera_frame', 'camera_stream_stop'].every(name => session.hasTool(name))
      && Object.hasOwn(this.#properties(session, 'camera_frame'), 'max_bytes');
  }

  /** One authenticated HTTP viewer. MCP long polls are shared; each viewer owns only its lease. */
  async *watch(destinationId: string, session: PrinterSession, options: {model?: string; size?: CameraSize; signal: AbortSignal}): AsyncGenerator<CameraFrame> {
    options.signal.throwIfAborted();
    await session.connect({failFast: true});
    if (!this.#supportsStream(session)) throw new CameraUnavailableError('not-supported');
    let viewers = this.#viewers.get(destinationId);
    if (!viewers) {
      const release = session.hold();
      let released = false;
      viewers = {count: 0, controller: new AbortController(), release: () => { if (!released) { released = true; release(); } }};
      this.#viewers.set(destinationId, viewers);
    }
    viewers.count++;
    const signal = AbortSignal.any([options.signal, viewers.controller.signal]);
    let last: CameraFrame | undefined, deliveredAt = 0;
    const cadence = options.size === 'full' ? 2000 : 10000;
    try {
      for (;;) {
        signal.throwIfAborted();
        const pause = deliveredAt + cadence - Date.now();
        if (pause > 0) await delay(pause, undefined, {signal});
        const work = this.frame(destinationId, session, {...options, view: true, watch: true, fresh: !!last, signal: viewers.controller.signal});
        // Cancelling one viewer must not cancel the shared MCP request another viewer awaits.
        const frame = await new Promise<CameraFrame>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, {once: true});
          if (signal.aborted) abort();
          work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
        if (frame.bytes.length > (options.size === 'full' ? 42000 : 20000)) throw new CameraUnavailableError('unreachable');
        if (!last || !frame.bytes.equals(last.bytes)) { last = frame; deliveredAt = Date.now(); yield frame; }
      }
    } finally {
      if (--viewers.count === 0) {
        this.#viewers.delete(destinationId);
        viewers.controller.abort(); viewers.release();
        // The MCP's 30s idle close owns the shared source, including viewers outside this app.
      }
    }
  }

  /** Lets every held session go (shutdown). */
  close(): void {
    for (const viewer of this.#viewers.values()) { viewer.controller.abort(); viewer.release(); }
    this.#viewers.clear();
    for (const {release, timer} of this.#holds.values()) { clearTimeout(timer); release(); }
    this.#holds.clear();
  }

  #hold(destinationId: string, session: PrinterSession): void {
    const held = this.#holds.get(destinationId);
    if (held) clearTimeout(held.timer);
    const release = held?.release ?? session.hold();
    const timer = setTimeout(() => { if (this.#holds.get(destinationId)?.release === release) { this.#holds.delete(destinationId); release(); } }, CAMERA_HOLD_MS);
    timer.unref?.();
    this.#holds.set(destinationId, {release, timer});
  }

  #properties(session: PrinterSession, tool: string): Record<string, unknown> {
    return (session.getTool(tool).inputSchema as {properties?: Record<string, unknown>}).properties ?? {};
  }
  #args(session: PrinterSession, tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const properties = this.#properties(session, tool);
    return Object.fromEntries(Object.entries({...routeArgs(session.config), ...args}).filter(([key, value]) => value !== undefined && (!Object.keys(properties).length || Object.hasOwn(properties, key))));
  }
  async #stream(key: string, destinationId: string, session: PrinterSession, model: string | undefined, size: CameraSize, signal?: AbortSignal): Promise<CameraFrame> {
    const call = (name: string, args: Record<string, unknown>) => session.call(name, this.#args(session, name, args),
      {failFast: true, timeoutMs: CAMERA_CAP_MS, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CAMERA_CAP_MS)]) : AbortSignal.timeout(CAMERA_CAP_MS)});
    const started = toolResultJson<{startedAt?: string}>(await call('camera_stream_start', {bambu_model: model, fps: 1, idle_timeout_ms: CAMERA_HOLD_MS}));
    const previous = this.#streams.get(destinationId);
    if (!started.startedAt) throw new CameraUnavailableError('unreachable');
    if (previous?.session !== session || previous.startedAt !== started.startedAt) {
      for (const variant of ['card', 'full']) { this.#cursors.delete(`${destinationId}:${variant}`); this.#last.delete(`${destinationId}:${variant}`); }
      this.#streams.set(destinationId, {session, startedAt: started.startedAt});
    }
    const last = this.#last.get(key);
    const value = toolResultJson<{status?: string; seq?: number; base64?: unknown; capturedAt?: unknown}>(await call('camera_frame', {
      since_seq: this.#cursors.get(key) ?? 0, wait_ms: signal ? CAMERA_TIMEOUT_MS : last ? 0 : CAMERA_TIMEOUT_MS,
      max_width: size === 'full' ? 1200 : 300, max_bytes: size === 'full' ? 42000 : 20000, changed_only: true, min_change: 0.02,
    }));
    if (value.status === 'unchanged' && last) return last.frame;
    if (value.status !== 'frame' || !Number.isSafeInteger(value.seq) || value.seq! < 0) throw new CameraUnavailableError('unreachable');
    const frame = this.#decode(value);
    this.#cursors.set(key, value.seq!);
    return {...frame, stream: true, seq: value.seq};
  }
  #decode(value: {base64?: unknown; capturedAt?: unknown}): CameraFrame {
    if (typeof value.base64 !== 'string' || !value.base64) throw new CameraUnavailableError('unreachable');
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CameraUnavailableError('unreachable');
    return {bytes, capturedAt: typeof value.capturedAt === 'string' && !Number.isNaN(Date.parse(value.capturedAt)) ? new Date(value.capturedAt).toISOString() : new Date(this.#now()).toISOString()};
  }
  #fetch(key: string, destinationId: string, session: PrinterSession, model?: string, size?: CameraSize, signal?: AbortSignal): Promise<CameraFrame> {
    const frame = (async () => {
      if (size) return this.#stream(key, destinationId, session, model, size, signal);
      if (!session.hasTool('camera_snapshot')) throw new CameraUnavailableError('no-camera');
      const properties = (session.getTool('camera_snapshot').inputSchema as {properties?: Record<string, unknown>}).properties ?? {};
      // The destination's own route (host, type, port for mcp-3D-printer-server), as every other call sends it.
      const args: Record<string, unknown> = {...routeArgs(session.config), timeout_ms: CAMERA_TIMEOUT_MS};
      if (model && Object.hasOwn(properties, 'bambu_model')) args.bambu_model = model;
      const allowed = Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (!Object.keys(properties).length || Object.hasOwn(properties, key))));
      const result = await session.call('camera_snapshot', allowed,
        {failFast: true, timeoutMs: CAMERA_CAP_MS, signal: AbortSignal.timeout(CAMERA_CAP_MS)});
      const value = toolResultJson<{base64?: unknown; capturedAt?: unknown}>(result);
      return this.#decode(value);
    })();
    this.#inflight.set(key, frame);
    // A failure isn't cached: the next viewer tries again, and the last good frame stays.
    frame.then(value => { this.#last.set(key, {atMs: this.#now(), frame: value}); }, () => undefined)
      .finally(() => { if (this.#inflight.get(key) === frame) this.#inflight.delete(key); });
    return frame;
  }
}
