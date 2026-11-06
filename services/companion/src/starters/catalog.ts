import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

/** The same immutable resources ship in the Swift package and companion payload. No user-data paths. */
export const STARTER_ASSETS = fileURLToPath(new URL('../../../../packages/CounterpartKit/Sources/CounterpartKit/Resources/Starters/', import.meta.url));
export interface StarterProject {
  id: string; title: string; summary: string; instructions: string; designer: string; site: string;
  url: string; licence: string; source: 'makerworld';
  /** How many distinct designer files make the project ready: the caliper and its depth gauge are two. */
  files: number;
  /** How many plates the kit has in all, when the catalog says (the rig's full kit is six), so part of it never counts. */
  plates?: number;
  /** The designer's files as published, when known: a file already in ~/Downloads is used only when it is one of these. */
  sha256?: string[];
}
/** The site's own id for the model (MakerWorld's /models/<id>-<slug>), which names its files' cache folder. */
export function starterModelId(starter: Pick<StarterProject, 'url' | 'id'>): string {
  const parts = new URL(starter.url).pathname.split('/').filter(Boolean);
  const after = parts[parts.indexOf('models') + 1] ?? '';
  const digits = after.split('-')[0] ?? '';
  return /^\d+$/.test(digits) ? `makerworld-${digits}` : `starter-${starter.id}`;
}
export function starterProject(id: string): StarterProject | undefined {
  const catalog = JSON.parse(readFileSync(join(STARTER_ASSETS, 'catalog.json'), 'utf8')) as StarterProject[];
  return catalog.find(item => item.id === id);
}
