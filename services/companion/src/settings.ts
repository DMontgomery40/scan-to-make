import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {z} from 'zod';
import {CompanionSettingsSchema, CompanionSettingsPatchSchema, type CompanionSettings, type CompanionSettingsPatch} from '@scan-to-make/contracts/counterpart';

// General values are supplied by the Mac, never guessed by the companion. Empty notification
// maps mean the documented platform defaults; stored false values always remain explicit.
export const DEFAULT_SETTINGS: CompanionSettings = {milestones: '50', notifications: {mac: {}, devices: {}}, general: {}};

/** Saved choices shared by the Mac and phone. Every partial update merges inside one write queue. */
export class CompanionSettingsStore {
  readonly #path: string;
  #cache?: CompanionSettings;
  #document: Record<string, unknown> = {};
  #loading?: Promise<void>;
  #writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = path; }

  async #read(): Promise<void> {
    let stored: Record<string, unknown> = {};
    try { stored = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(this.#path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Keep unknown sections on disk for a newer companion, without advertising unsupported APIs.
    const known = CompanionSettingsSchema.parse({milestones: stored.milestones ?? '50', notifications: stored.notifications ?? {mac: {}, devices: {}}, general: stored.general ?? {}});
    this.#document = stored;
    this.#cache = known;
  }
  async load(): Promise<CompanionSettings> {
    if (!this.#cache) {
      this.#loading ??= this.#read().finally(() => { this.#loading = undefined; });
      await this.#loading;
    }
    return structuredClone(this.#cache!);
  }
  /** Last successfully loaded values; used by the print monitor for its milestone schedule. */
  current(): CompanionSettings { return structuredClone(this.#cache ?? DEFAULT_SETTINGS); }

  async update(input: CompanionSettingsPatch): Promise<CompanionSettings> {
    const write = this.#writing.catch(() => undefined).then(async () => {
      const patch = CompanionSettingsPatchSchema.parse(input);
      if (patch.ai) throw new Error('AI choices belong to ModelAccessService');
      const previous = await this.load();
      const devices = structuredClone(previous.notifications?.devices ?? {});
      for (const [id, choices] of Object.entries(patch.notifications?.devices ?? {})) {
        devices[id] = {...devices[id], ...choices};
      }
      const next = CompanionSettingsSchema.parse({
        milestones: patch.milestones ?? previous.milestones,
        notifications: {mac: {...previous.notifications?.mac, ...patch.notifications?.mac}, devices},
        general: {...previous.general, ...patch.general},
      });
      const document = {...this.#document, ...next};
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(document) + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
      this.#document = document;
      this.#cache = next;
      return structuredClone(next);
    });
    this.#writing = write;
    return write;
  }
}
