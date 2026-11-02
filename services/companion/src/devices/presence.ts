import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';

const MODEL = /^[A-Za-z0-9,._ -]{1,64}$/;
const FLUSH_EVERY_MS = 5 * 60 * 1000;

/**
 * When each paired device was last seen, and its hardware model from the
 * optional `X-Scan-Device-Model` header (PRD §4 Device, §7.5). Kept apart from
 * auth.json so its strict schema and older companions never see these fields.
 * In memory per request; written at most every five minutes per device.
 */
export class DevicePresence {
  readonly #path: string;
  readonly #now: () => number;
  #state?: Record<string, {lastSeenAt: number; model?: string}>;
  #loading?: Promise<Record<string, {lastSeenAt: number; model?: string}>>;
  readonly #flushedAt = new Map<string, number>();
  #writing: Promise<unknown> = Promise.resolve();
  constructor(path: string, options: {now?: () => number} = {}) { this.#path = path; this.#now = options.now ?? Date.now; }

  /** Every caller shares one load, so concurrent first requests update the same state. */
  #load() {
    this.#loading ??= this.#read();
    return this.#loading;
  }
  async #read() {
    if (this.#state) return this.#state;
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8')) as Record<string, {lastSeenAt?: unknown; model?: unknown}>;
      this.#state = Object.fromEntries(Object.entries(value).flatMap(([id, entry]) => typeof entry?.lastSeenAt === 'number'
        ? [[id, {lastSeenAt: entry.lastSeenAt, ...(typeof entry.model === 'string' && MODEL.test(entry.model) ? {model: entry.model} : {})}]] : []));
    } catch { this.#state = {}; }
    return this.#state;
  }

  /** Called after each successful authorization. */
  async seen(deviceId: string, model?: string): Promise<void> {
    const state = await this.#load(), now = this.#now();
    const previous = state[deviceId];
    const cleanModel = model && MODEL.test(model) ? model : previous?.model;
    state[deviceId] = {lastSeenAt: now, ...(cleanModel ? {model: cleanModel} : {})};
    if (previous?.model === cleanModel && now - (this.#flushedAt.get(deviceId) ?? 0) < FLUSH_EVERY_MS) return;
    this.#flushedAt.set(deviceId, now);
    await this.#flush();
  }

  async forget(deviceId: string): Promise<void> { const state = await this.#load(); delete state[deviceId]; await this.#flush(); }

  async get(deviceId: string): Promise<{lastSeenAt?: number; model?: string}> { return {...(await this.#load())[deviceId]}; }

  async #flush() {
    const snapshot = JSON.stringify(this.#state ?? {});
    await (this.#writing = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
    }));
  }
}
