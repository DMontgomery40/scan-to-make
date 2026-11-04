import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

/** The same immutable resources ship in the Swift package and companion payload. No user-data paths. */
export const STARTER_ASSETS = fileURLToPath(new URL('../../../../packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/', import.meta.url));
export interface StarterProject {
  id: string; title: string; summary: string; instructions: string; designer: string; site: string;
  url: string; licence: string; source: 'bundled' | 'makerworld'; model?: string;
}
export function starterProject(id: string): StarterProject | undefined {
  const catalog = JSON.parse(readFileSync(join(STARTER_ASSETS, 'catalog.json'), 'utf8')) as StarterProject[];
  return catalog.find(item => item.id === id);
}
