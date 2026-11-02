import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {z} from 'zod';
import type {LiveActivityTokens} from '@scan-to-make/contracts/counterpart';

export const ACTIVITY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVITIES_PER_DEVICE = 32;
const token = z.string().regex(/^[0-9a-fA-F]{16,512}$/);
const stateSchema = z.object({
  devices: z.record(z.uuid(), z.object({
    pushToStart: z.object({token, updatedAt: z.string()}).optional(),
    activities: z.record(z.uuid(), z.object({token, updatedAt: z.string()})).default({}),
  })).default({}),
});
type State = z.infer<typeof stateSchema>;

/**
 * Live Activity push tokens from the phones (PRD §8.8), kept only for the Mac
 * app to read (`liveActivity.tokens`). The companion never sends them anywhere.
 * `<data root>/live-activity-tokens.json`, mode 0600.
 */
export class LiveActivityTokenStore {
  readonly #path: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(path: string, options: {now?: () => number} = {}) { this.#path = path; this.#now = options.now ?? Date.now; }

  async #read(): Promise<State> {
    try { return stateSchema.parse(JSON.parse(await readFile(this.#path, 'utf8'))); } catch { return {devices: {}}; }
  }
  #mutate<T>(change: (state: State) => T): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(async () => {
      const state = await this.#read();
      const result = change(state);
      const cutoff = this.#now() - ACTIVITY_TOKEN_TTL_MS;
      for (const device of Object.values(state.devices))
        for (const [printId, activity] of Object.entries(device.activities)) if (Date.parse(activity.updatedAt) < cutoff) delete device.activities[printId];
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state) + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
      return result;
    });
    this.#queue = next;
    return next;
  }

  /** One phone's upload: its push-to-start token, and/or one activity's update token (null forgets it). */
  store(deviceId: string, upload: {pushToStart?: string; activity?: {printId: string; token: string | null}}): Promise<void> {
    return this.#mutate(state => {
      const at = new Date(this.#now()).toISOString();
      const device = state.devices[deviceId] ??= {activities: {}};
      if (upload.pushToStart) device.pushToStart = {token: upload.pushToStart.toLowerCase(), updatedAt: at};
      if (upload.activity) {
        if (upload.activity.token === null) delete device.activities[upload.activity.printId];
        else device.activities[upload.activity.printId] = {token: upload.activity.token.toLowerCase(), updatedAt: at};
        const entries = Object.entries(device.activities).sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
        for (const [printId] of entries.slice(MAX_ACTIVITIES_PER_DEVICE)) delete device.activities[printId];
      }
    });
  }

  /** A removed device's tokens go with it. */
  removeDevice(deviceId: string): Promise<void> { return this.#mutate(state => { delete state.devices[deviceId]; }); }

  async list(knownDevices?: ReadonlySet<string>): Promise<LiveActivityTokens> {
    const state = await this.#read();
    const cutoff = this.#now() - ACTIVITY_TOKEN_TTL_MS;
    const devices = Object.entries(state.devices).filter(([deviceId]) => !knownDevices || knownDevices.has(deviceId));
    return {
      pushToStart: devices.flatMap(([deviceId, device]) => device.pushToStart ? [{deviceId, token: device.pushToStart.token, updatedAt: device.pushToStart.updatedAt}] : []),
      activities: devices.flatMap(([deviceId, device]) => Object.entries(device.activities)
        .filter(([, activity]) => Date.parse(activity.updatedAt) >= cutoff)
        .map(([printId, activity]) => ({printId, deviceId, token: activity.token, updatedAt: activity.updatedAt}))),
    };
  }
}
