import {routeArgs, toolResultJson, type PrinterSession} from '@scan-to-make/printer-handoff';

export const CAMERA_CACHE_MS = 3000;
export const CAMERA_TIMEOUT_MS = 8000;
export const CAMERA_CAP_MS = 10_000;

export interface CameraFrame { bytes: Buffer; capturedAt: string }
export class CameraUnavailableError extends Error {
  constructor(readonly reason: 'no-camera' | 'unreachable') { super(reason === 'no-camera' ? "This printer has no camera Counterpart can use." : "The printer's camera didn't answer. Try again in a moment."); this.name = 'CameraUnavailableError'; }
}

/** A frame up to this old is served at once while a fresh one is fetched, with its real `capturedAt`. */
export const CAMERA_STALE_MS = 120_000;
/** Opening a print or printer view fetches a frame ahead of the first request, at most this often. */
export const CAMERA_WARM_EVERY_MS = 60_000;
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
  readonly #warmedAt = new Map<string, number>();
  readonly #holds = new Map<string, {release: () => void; timer: ReturnType<typeof setTimeout>}>();
  readonly #now: () => number;
  constructor(options: {now?: () => number} = {}) { this.#now = options.now ?? Date.now; }

  /**
   * `fresh` skips the cache (Look Again: the person just cleared the plate) and refreshes it. `view` is a person
   * looking (a camera route): their session stays held while they keep looking.
   */
  async frame(destinationId: string, session: PrinterSession, options: {model?: string; fresh?: boolean; view?: boolean} = {}): Promise<CameraFrame> {
    if (options.view) this.#hold(destinationId, session);
    const last = this.#last.get(destinationId), age = last ? this.#now() - last.atMs : Infinity;
    if (!options.fresh && last && age < CAMERA_CACHE_MS) return last.frame;
    const next = (!options.fresh && this.#inflight.get(destinationId)) || this.#fetch(destinationId, session, options.model);
    // Only a person looking gets the older frame meanwhile; an event's frame is saved for good, so it waits for a new one.
    if (!options.fresh && options.view && last && age < CAMERA_STALE_MS) { next.catch(() => undefined); return last.frame; }
    try { return await next; }
    catch (error) { throw error instanceof CameraUnavailableError ? error : new CameraUnavailableError('unreachable'); }
  }

  /**
   * A print or printer view opened: hold and connect the session now, and fetch a frame unless one is recent,
   * so the view's first camera request is answered from the cache. Best effort.
   */
  warm(destinationId: string, session: PrinterSession, options: {model?: string} = {}): void {
    this.#hold(destinationId, session);
    const now = this.#now(), last = this.#last.get(destinationId);
    if (this.#inflight.has(destinationId) || (last && now - last.atMs < CAMERA_CACHE_MS) || now - (this.#warmedAt.get(destinationId) ?? -Infinity) < CAMERA_WARM_EVERY_MS) return;
    this.#warmedAt.set(destinationId, now);
    this.#fetch(destinationId, session, options.model).catch(() => undefined);
  }

  /** Lets every held session go (shutdown). */
  close(): void {
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

  #fetch(destinationId: string, session: PrinterSession, model?: string): Promise<CameraFrame> {
    const frame = (async () => {
      await session.connect({failFast: true});
      if (!session.hasTool('camera_snapshot')) throw new CameraUnavailableError('no-camera');
      const properties = (session.getTool('camera_snapshot').inputSchema as {properties?: Record<string, unknown>}).properties ?? {};
      // The destination's own route (host, type, port for mcp-3D-printer-server), as every other call sends it.
      const args: Record<string, unknown> = {...routeArgs(session.config), timeout_ms: CAMERA_TIMEOUT_MS};
      if (model && Object.hasOwn(properties, 'bambu_model')) args.bambu_model = model;
      const allowed = Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (!Object.keys(properties).length || Object.hasOwn(properties, key))));
      const result = await session.call('camera_snapshot', allowed,
        {failFast: true, timeoutMs: CAMERA_CAP_MS, signal: AbortSignal.timeout(CAMERA_CAP_MS)});
      const value = toolResultJson<{base64?: unknown; capturedAt?: unknown}>(result);
      if (typeof value.base64 !== 'string' || !value.base64) throw new CameraUnavailableError('unreachable');
      const bytes = Buffer.from(value.base64, 'base64');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CameraUnavailableError('unreachable');
      return {bytes, capturedAt: typeof value.capturedAt === 'string' && !Number.isNaN(Date.parse(value.capturedAt)) ? new Date(value.capturedAt).toISOString() : new Date(this.#now()).toISOString()};
    })();
    this.#inflight.set(destinationId, frame);
    // A failure isn't cached: the next viewer tries again, and the last good frame stays.
    frame.then(value => { this.#last.set(destinationId, {atMs: this.#now(), frame: value}); }, () => undefined)
      .finally(() => { if (this.#inflight.get(destinationId) === frame) this.#inflight.delete(destinationId); });
    return frame;
  }
}
