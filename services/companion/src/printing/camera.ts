import {routeArgs, toolResultJson, type PrinterSession} from '@scan-to-make/printer-handoff';

export const CAMERA_CACHE_MS = 3000;
export const CAMERA_TIMEOUT_MS = 8000;
export const CAMERA_CAP_MS = 10_000;

export interface CameraFrame { bytes: Buffer; capturedAt: string }
export class CameraUnavailableError extends Error {
  constructor(readonly reason: 'no-camera' | 'unreachable') { super(reason === 'no-camera' ? "This printer has no camera Counterpart can use." : "The printer's camera didn't answer. Try again in a moment."); this.name = 'CameraUnavailableError'; }
}

/**
 * The printer camera through the destination's session (PRD §8.6): a refreshing
 * photo, never video. One shared 3 s cache per destination, so several viewers
 * (the phone, the Mac, a Live Activity) don't hit the camera more than once.
 */
export class CameraFrames {
  readonly #cache = new Map<string, {atMs: number; frame: Promise<CameraFrame>}>();
  readonly #now: () => number;
  constructor(options: {now?: () => number} = {}) { this.#now = options.now ?? Date.now; }

  /** `fresh` skips the cache (Look Again: the person just cleared the plate) and refreshes it. */
  async frame(destinationId: string, session: PrinterSession, options: {model?: string; fresh?: boolean} = {}): Promise<CameraFrame> {
    const cached = this.#cache.get(destinationId);
    if (!options.fresh && cached && this.#now() - cached.atMs < CAMERA_CACHE_MS) return cached.frame;
    const frame = (async () => {
      await session.connect({failFast: true});
      if (!session.hasTool('camera_snapshot')) throw new CameraUnavailableError('no-camera');
      const properties = (session.getTool('camera_snapshot').inputSchema as {properties?: Record<string, unknown>}).properties ?? {};
      // The destination's own route (host, type, port for mcp-3D-printer-server), as every other call sends it.
      const args: Record<string, unknown> = {...routeArgs(session.config), timeout_ms: CAMERA_TIMEOUT_MS};
      if (options.model && Object.hasOwn(properties, 'bambu_model')) args.bambu_model = options.model;
      const allowed = Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (!Object.keys(properties).length || Object.hasOwn(properties, key))));
      const result = await session.call('camera_snapshot', allowed,
        {failFast: true, timeoutMs: CAMERA_CAP_MS, signal: AbortSignal.timeout(CAMERA_CAP_MS)});
      const value = toolResultJson<{base64?: unknown; capturedAt?: unknown}>(result);
      if (typeof value.base64 !== 'string' || !value.base64) throw new CameraUnavailableError('unreachable');
      const bytes = Buffer.from(value.base64, 'base64');
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CameraUnavailableError('unreachable');
      return {bytes, capturedAt: typeof value.capturedAt === 'string' && !Number.isNaN(Date.parse(value.capturedAt)) ? new Date(value.capturedAt).toISOString() : new Date(this.#now()).toISOString()};
    })();
    this.#cache.set(destinationId, {atMs: this.#now(), frame});
    // A failure isn't cached: the next viewer tries again.
    frame.catch(() => { if (this.#cache.get(destinationId)?.frame === frame) this.#cache.delete(destinationId); });
    try { return await frame; }
    catch (error) { throw error instanceof CameraUnavailableError ? error : new CameraUnavailableError('unreachable'); }
  }
}
