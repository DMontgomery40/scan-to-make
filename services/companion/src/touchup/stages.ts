import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import type {DesignEngine} from './invocation.js';

export type StageId = 'building' | 'preparing' | 'working' | 'saving';
export type PassKind = 'fit' | 'copy';
export interface PassStage {id: StageId; words: string; startedAtMs: number; endedAtMs?: number; typicalSec: number}

/** Until this Mac has real timings for a stage, these stand in (PRD: estimates come from real timings). */
export const STAGE_DEFAULT_SEC: Record<PassKind, Record<StageId, number>> = {
  fit: {building: 300, preparing: 20, working: 420, saving: 10},
  copy: {building: 300, preparing: 20, working: 300, saving: 10},
};
const SAMPLES = 20;

export function stageWords(id: StageId, engine: DesignEngine, kind: PassKind): string {
  switch (id) {
    case 'building': return 'Building the model from your photos';
    case 'preparing': return engine === 'fusion' ? 'Getting Fusion ready' : 'Getting Blender ready';
    case 'working': return kind === 'fit' ? 'Designing it' : 'Fixing the scan';
    case 'saving': return 'Saving the result';
  }
}

/** The pass's time left: what's left of the current stage's typical time, plus the typical time of the stages after it. */
export function passEstimate(stages: PassStage[], plan: StageId[], typical: Record<StageId, number>, nowMs: number): {remainingSec: number; endsAtMs: number} {
  const current = stages.at(-1);
  const index = current ? plan.indexOf(current.id) : -1;
  const elapsed = current && current.endedAtMs === undefined ? (nowMs - current.startedAtMs) / 1000 : 0;
  // An overrunning stage still has a little left: never "0 min" while it works.
  const running = current && current.endedAtMs === undefined ? typical[current.id] - elapsed : 0;
  const left = current && current.endedAtMs === undefined ? (running > 0 ? running : Math.min(30, typical[current.id])) : 0;
  const rest = plan.slice(index + 1).reduce((sum, id) => sum + typical[id], 0);
  const remainingSec = Math.round(left + rest);
  return {remainingSec, endsAtMs: nowMs + remainingSec * 1000};
}

/** Real stage durations on this Mac, per kind of pass: the median of the last 20. */
export class PassTimings {
  readonly #path: string;
  #state?: Record<string, number[]>;
  #writing: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  async #load() {
    if (this.#state) return this.#state;
    try {
      const value = JSON.parse(await readFile(this.#path, 'utf8')) as Record<string, unknown>;
      this.#state = Object.fromEntries(Object.entries(value).filter(([, list]) => Array.isArray(list))
        .map(([key, list]) => [key, (list as unknown[]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).slice(-SAMPLES)]));
    } catch { this.#state = {}; }
    return this.#state;
  }
  async typical(kind: PassKind, engine: DesignEngine): Promise<Record<StageId, number>> {
    const state = await this.#load();
    const median = (list: number[] | undefined, fallback: number) => {
      if (!list?.length) return fallback;
      const sorted = [...list].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
      return Math.round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
    };
    const defaults = STAGE_DEFAULT_SEC[kind];
    return Object.fromEntries((Object.keys(defaults) as StageId[]).map(id => [id, median(state[`${kind}:${engine}:${id}`], defaults[id])])) as Record<StageId, number>;
  }
  async record(kind: PassKind, engine: DesignEngine, id: StageId, seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const state = await this.#load(), key = `${kind}:${engine}:${id}`;
    state[key] = [...(state[key] ?? []), Math.round(seconds)].slice(-SAMPLES);
    const snapshot = JSON.stringify(state);
    await (this.#writing = this.#writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), {recursive: true});
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot + '\n', {mode: 0o600});
      await rename(temporary, this.#path);
    }));
  }
}
