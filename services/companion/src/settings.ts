import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {CompanionSettingsSchema, type CompanionSettings} from '@scan-to-make/contracts/counterpart';

export const DEFAULT_SETTINGS: CompanionSettings = {milestones: '50'};

/** Companion-wide choices that change what it emits (PRD §8.6 milestones). One small private JSON file. */
export class CompanionSettingsStore {
  readonly #path: string;
  #cache?: CompanionSettings;
  #writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = path; }

  async load(): Promise<CompanionSettings> {
    if (this.#cache) return structuredClone(this.#cache);
    try { this.#cache = CompanionSettingsSchema.parse({...DEFAULT_SETTINGS, ...JSON.parse(await readFile(this.#path, 'utf8'))}); }
    catch { this.#cache = {...DEFAULT_SETTINGS}; }
    return structuredClone(this.#cache);
  }
  /** The last loaded value, for hot paths (the monitor reads it at every report). */
  current(): CompanionSettings { return structuredClone(this.#cache ?? DEFAULT_SETTINGS); }

  async update(patch: Partial<CompanionSettings>): Promise<CompanionSettings> {
    const next = CompanionSettingsSchema.parse({...await this.load(), ...patch});
    const write = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), {recursive: true, mode: 0o700});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next) + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
    });
    this.#writing = write;
    await write;
    this.#cache = next;
    return structuredClone(next);
  }
}
