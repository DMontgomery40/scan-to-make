import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export type ObjectState = 'new' | 'touching-up' | 'needs-closeup' | 'ready' | 'printing' | 'printed' | 'failed';

export interface ObjectPass {
  startedAtMs: number;
  endedAtMs?: number;
  note?: string;
  status?: string;
  summary?: string;
  seconds?: number;
  costUsd?: number;
  dir?: string;
}

/** One thing the user scanned or asked to have made, as the phone and the Mac app both show it. */
export interface StmObject {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  instructions?: string;
  state: ObjectState;
  /** File name under scan/. */
  scan?: string;
  /** File names under photos/, in upload order. */
  photos: string[];
  passes: ObjectPass[];
  current?: {model: string; renders: string[]; sizeMm?: [number, number, number]; summary?: string};
  question?: {closeup: string};
  plate?: {item: string};
  failure?: string;
  print?: {bundleId: string};
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

export class ObjectNotFoundError extends Error {
  constructor() { super('Object not found'); this.name = 'ObjectNotFoundError'; }
}

/** Objects on this Mac, one folder each: object.json plus scan/, photos/, current/ and passes/. */
export class ObjectStore {
  readonly #root: string;
  constructor(root: string) { this.#root = root; }

  dir(id: string): string {
    if (!ID.test(id)) throw new ObjectNotFoundError();
    return join(this.#root, id);
  }

  async create(instructions?: string): Promise<StmObject> {
    const now = Date.now();
    const object: StmObject = {id: randomUUID(), createdAtMs: now, updatedAtMs: now, state: 'new', photos: [], passes: [],
      ...(instructions?.trim() ? {instructions: instructions.trim()} : {})};
    await mkdir(this.dir(object.id), {recursive: true});
    await this.#write(object);
    return object;
  }

  async get(id: string): Promise<StmObject> {
    try { return JSON.parse(await readFile(join(this.dir(id), 'object.json'), 'utf8')) as StmObject; }
    catch { throw new ObjectNotFoundError(); }
  }

  async list(): Promise<StmObject[]> {
    let names: string[];
    try { names = await readdir(this.#root); } catch { return []; }
    const objects: StmObject[] = [];
    for (const name of names) if (ID.test(name)) objects.push(...await this.get(name).then(o => [o], () => []));
    return objects.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async update(id: string, change: (object: StmObject) => StmObject): Promise<StmObject> {
    const next = {...change(await this.get(id)), id, updatedAtMs: Date.now()};
    await this.#write(next);
    return next;
  }

  /** Stores an uploaded file under the object; the name must be a plain file name. */
  async addFile(id: string, kind: 'scan' | 'photos', name: string, bytes: Buffer): Promise<string> {
    if (!FILE_NAME.test(name) || name.includes('..')) throw new Error('Invalid file name');
    const folder = join(this.dir(id), kind);
    await mkdir(folder, {recursive: true});
    const path = join(folder, name);
    await writeFile(path, bytes);
    return path;
  }

  /** After a restart nothing is still running: mark interrupted work failed so it can be started again. */
  async recoverInterrupted(): Promise<void> {
    for (const object of await this.list()) {
      if (object.state === 'touching-up' || object.state === 'printing') {
        await this.update(object.id, o => ({...o, state: 'failed', failure: 'interrupted when your Mac restarted the app'}));
      }
    }
  }

  async #write(object: StmObject): Promise<void> {
    const path = join(this.dir(object.id), 'object.json'), temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(object, null, 2));
    await rename(temp, path);
  }
}
