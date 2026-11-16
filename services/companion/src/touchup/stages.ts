import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import type {DesignEngine} from './invocation.js';

export type StageId = 'building' | 'preparing' | 'working' | 'saving';
export type PassKind = 'fit' | 'copy' | 'published';
export interface PassStage {id: StageId; words: string; startedAtMs: number; endedAtMs?: number; typicalSec: number}

/** Until this Mac has real timings for a stage, these stand in (PRD: estimates come from real timings). */
export const STAGE_DEFAULT_SEC: Record<PassKind, Record<StageId, number>> = {
  fit: {building: 300, preparing: 20, working: 420, saving: 10},
  copy: {building: 300, preparing: 20, working: 300, saving: 10},
  published: {building: 0, preparing: 30, working: 120, saving: 10},
};
const SAMPLES = 20;

export function stageWords(id: StageId, engine: DesignEngine, kind: PassKind): string {
  switch (id) {
    case 'building': return 'Building the model from your photos';
    case 'preparing': return kind === 'published' ? 'Reading the model page' : engine === 'fusion' ? 'Getting Fusion ready' : engine === 'code' ? 'Getting the design engine ready' : 'Getting Blender ready';
    case 'working': return kind === 'published' ? "Getting the designer's file" : kind === 'fit' ? 'Designing it' : 'Fixing the scan';
    case 'saving': return 'Saving the result';
  }
}

const median = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * The pass's time left: what's left of the current stage's typical time, plus the typical time of the stages after it.
 * A stage past its typical time (#859: "about 4 min", then "about 1 min", through a 64-minute design) reads what the
 * passes on this Mac that ran at least this long went on to take: the median of their remaining time. Past every one of
 * them, or with none recorded, it reads half as long again as it has taken so far, never less than 30 seconds.
 */
export function passEstimate(stages: PassStage[], plan: StageId[], typical: Record<StageId, number>, nowMs: number,
  history: Partial<Record<StageId, number[]>> = {}): {remainingSec: number; endsAtMs: number} {
  const current = stages.at(-1);
  const index = current ? plan.indexOf(current.id) : -1;
  const running = current && current.endedAtMs === undefined;
  const elapsed = running ? (nowMs - current.startedAtMs) / 1000 : 0;
  let left = 0;
  if (running && typical[current.id] - elapsed > 0) left = typical[current.id] - elapsed;
  else if (running) {
    const longer = (history[current.id] ?? []).filter(seconds => seconds > elapsed);
    left = longer.length ? median(longer) - elapsed : Math.max(Math.min(30, typical[current.id]), elapsed / 2);
  }
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
    const samples = await this.samples(kind, engine), defaults = STAGE_DEFAULT_SEC[kind];
    return Object.fromEntries((Object.keys(defaults) as StageId[]).map(id => [id, samples[id].length ? Math.round(median(samples[id])) : defaults[id]])) as Record<StageId, number>;
  }
  /** The recorded durations behind `typical`, per stage, oldest first: what a stage past its typical time reads (#859). */
  async samples(kind: PassKind, engine: DesignEngine): Promise<Record<StageId, number[]>> {
    const state = await this.#load();
    return Object.fromEntries((Object.keys(STAGE_DEFAULT_SEC[kind]) as StageId[]).map(id => [id, [...(state[`${kind}:${engine}:${id}`] ?? [])]])) as Record<StageId, number[]>;
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
