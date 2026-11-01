import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {TouchupActivity} from '../touchup/runner.js';

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
  /** The most recent public worker messages and tool names, in stream order. */
  activity?: TouchupActivity[];
}

/** One thing the user scanned or asked to have made, as the phone and the Mac app both show it. */
export interface StmObject {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  instructions?: string;
  /** A configured destination id; process settings and credentials stay in the companion. */
  printerDestinationId?: string;
  state: ObjectState;
  /** File name under scan/. */
  scan?: string;
  /** File names under photos/, in upload order. */
  photos: string[];
  /** A handheld scan: its photos under capture/ (with depth), rebuilt into scan/scan.usdz on this Mac. */
  capture?: string[];
  /** What the Mac is doing right now, in words, while it is longer than a moment (building a handheld scan). */
  progress?: string;
  passes: ObjectPass[];
  current?: {model: string; renders: string[]; sizeMm?: [number, number, number]; summary?: string};
  question?: {closeup: string};
  /** Set while a print waits for the user: something is on the plate, or the printer has no camera. */
  plate?: {item?: string; noCamera?: boolean; photo?: boolean};
  failure?: string;
  /** The last print; `uncertain` when it may have reached the printer and must not be sent again by itself. */
  print?: {bundleId: string; uncertain?: boolean; destination?: {id: string; name: string}};
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

export class ObjectNotFoundError extends Error {
  constructor() { super('Object not found'); this.name = 'ObjectNotFoundError'; }
}

/** Objects on this Mac, one folder each: object.json plus scan/, photos/, current/ and passes/. */
export class ObjectStore {
  readonly #root: string;
  /** Read-modify-write of one object is serialized, so simultaneous changes never overwrite each other. */
  readonly #queues = new Map<string, Promise<unknown>>();
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

  update(id: string, change: (object: StmObject) => StmObject): Promise<StmObject> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const updated = {...change(await this.get(id)), id, updatedAtMs: Date.now()};
      await this.#write(updated);
      return updated;
    });
    this.#queues.set(id, next);
    void next.finally(() => { if (this.#queues.get(id) === next) this.#queues.delete(id); }).catch(() => undefined);
    return next;
  }

  /** Stores an uploaded file under the object; the name must be a plain file name. */
  async addFile(id: string, kind: 'scan' | 'photos' | 'capture', name: string, bytes: Buffer): Promise<string> {
    if (!FILE_NAME.test(name) || name.includes('..')) throw new Error('Invalid file name');
    const folder = join(this.dir(id), kind);
    await mkdir(folder, {recursive: true});
    const path = join(folder, name);
    await writeFile(path, bytes);
    return path;
  }

  /** Removes the object and every file it has. */
  async remove(id: string): Promise<void> {
    await this.get(id);
    await rm(this.dir(id), {recursive: true, force: true});
  }

  /** After a restart nothing is still running: record interruption, never successful completion. */
  async recoverInterrupted(): Promise<void> {
    for (const object of await this.list()) {
      if (object.state === 'touching-up' || object.state === 'printing') {
        const atMs = Date.now(), failure = 'interrupted when your Mac restarted the app';
        await this.update(object.id, o => ({...o, state: 'failed', failure, progress: undefined,
          passes: o.state !== 'touching-up' ? o.passes : o.passes.map((pass, index) => index !== o.passes.length - 1 || pass.endedAtMs !== undefined ? pass : {
            ...pass, endedAtMs: atMs, status: 'interrupted',
            activity: [...(pass.activity ?? []), {atMs, kind: 'message' as const, text: failure}].slice(-200),
          }),
        }));
      }
    }
  }

  async #write(object: StmObject): Promise<void> {
    const path = join(this.dir(object.id), 'object.json'), temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(object, null, 2));
    await rename(temp, path);
  }
}
