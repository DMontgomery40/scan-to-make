import {copyFile, mkdir, readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ObjectStore, StmObject} from './store.js';

/** The generated caliper files the app ships (tools/caliper writes them here). */
export const CALIPER_ASSETS = fileURLToPath(new URL('../../src/objects/caliper/', import.meta.url));
export const CALIPER_NAME = 'Scan to Make caliper';
const SUMMARY = 'A 0-100 mm caliper that reads to 0.2 mm. The outside and inside jaws read the same scale. '
  + 'Hold it next to things in your photos and the touch-up reads it.';

export interface CaliperInfo {
  sizeMm: [number, number, number];
  pauseAtZ: number[];
  filamentSlots: {body: number; marking: number};
}

export async function caliperInfo(assets = CALIPER_ASSETS): Promise<CaliperInfo> {
  const meta = JSON.parse(await readFile(join(assets, 'caliper.json'), 'utf8')) as {
    assembled_size_mm?: number[]; pause_at_z?: number[]; filament_slots?: Record<string, string>;
  };
  const size = meta.assembled_size_mm;
  if (!Array.isArray(size) || size.length !== 3 || !size.every(v => typeof v === 'number')) throw new Error('caliper.json has no assembled size');
  const slot = (role: string) => Number(Object.entries(meta.filament_slots ?? {}).find(([, r]) => r === role)?.[0]);
  return {sizeMm: size as [number, number, number], pauseAtZ: meta.pause_at_z ?? [], filamentSlots: {body: slot('body'), marking: slot('marking')}};
}

/**
 * The caliper as a ready object: the shipped model, renders and size, so it prints like anything else.
 * Reuses the newest caliper object that isn't busy rather than filling the list with copies.
 */
export async function caliperObject(store: ObjectStore, assets = CALIPER_ASSETS): Promise<StmObject> {
  const existing = (await store.list()).find(o => o.kind === 'caliper' && o.state !== 'printing' && o.state !== 'touching-up');
  if (existing?.current) return existing;
  const info = await caliperInfo(assets);
  const object = existing ?? await store.create(CALIPER_NAME);
  const dir = store.dir(object.id), currentDir = join(dir, 'current'), rendersDir = join(currentDir, 'renders');
  await mkdir(rendersDir, {recursive: true});
  await copyFile(join(assets, 'caliper.stl'), join(currentDir, 'model.stl'));
  const renders: string[] = [];
  for (const name of (await readdir(join(assets, 'renders'))).filter(n => n.endsWith('.png')).sort()) {
    await copyFile(join(assets, 'renders', name), join(rendersDir, name));
    renders.push(join('current', 'renders', name));
  }
  return store.update(object.id, o => ({...o, kind: 'caliper', state: 'ready', failure: undefined,
    current: {model: join('current', 'model.stl'), renders, sizeMm: info.sizeMm, summary: SUMMARY}}));
}
