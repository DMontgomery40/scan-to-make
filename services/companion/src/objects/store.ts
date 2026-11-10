import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Fit} from '@scan-to-make/contracts/counterpart';
import {withPassEnded, type PassStatus} from './pass-end.js';
import type {TouchupActivity, TouchupChange, WorkerLimit} from '../touchup/runner.js';
import type {PassStage} from '../touchup/stages.js';
import type {DesignEngine} from '../touchup/invocation.js';
import type {Ask} from '@scan-to-make/contracts/counterpart';
import type {ReconstructionReview} from '@scan-to-make/contracts/reconstruction';
import type {PrintLive, PrintMonitor, PrintSettings, ProjectPreferences} from '@scan-to-make/contracts/counterpart';

/** `sent`: the printer accepted the print, but Counterpart can't follow it to the end (no evidence it printed). */
export type ObjectState = 'new' | 'touching-up' | 'needs-closeup' | 'ready' | 'printing' | 'printed' | 'failed' | 'sent' | 'confirmed';

export interface ObjectPrintConfirmation {
  id: string;
  message: string;
  expiresAtMs: number;
  /**
   * One per property of the MCP's schema. `type` is absent for booleans (older
   * clients read only name/title/description/required).
   */
  fields: {name: string; title: string; description?: string; required: boolean;
    type?: 'string' | 'number' | 'integer'; enum?: string[]; enumNames?: string[]; default?: string | number | boolean;
    minimum?: number; maximum?: number; minLength?: number; maxLength?: number; format?: 'email' | 'uri' | 'date' | 'date-time'}[];
  supported: boolean;
}

export interface CheckedSize { label: string; mm: number; certainty: 'confirmed' | 'measured' }
export interface ObjectMessage { id: string; text: string; atMs: number; photos: string[];
  /** The sending client's own id for this message. A second request carrying it is the same message arriving again,
   *  never a new one (Nov 10: a note whose reply was lost was sent again and started a second design pass). */
  clientId?: string }

/**
 * What a locate pass found on the project when it started (docs/protocols/seats.md): it changes nothing, so it gives all
 * of this back when it ends, however it ends, a restart included.
 */
export interface LocateSnapshot {
  state: StmObject['state'];
  question?: StmObject['question'];
  failure?: string;
  failedPass?: number;
  pendingFollowup?: string;
  pendingMessageId?: string;
  completion?: StmObject['completion'];
}

export interface ObjectPass {
  /** A locate pass only: the project as it was before it, restored when it ends. */
  before?: LocateSnapshot;
  messageId?: string;
  /** Photos explicitly sent with this message, never inferred from old project files. */
  photos?: string[];
  startedAtMs: number;
  endedAtMs?: number;
  note?: string;
  /** How it ended (`PassEnd`); absent while it runs. Closed only by `endPass`. */
  status?: PassStatus;
  summary?: string;
  seconds?: number;
  costUsd?: number;
  toolCalls?: number;
  limit?: WorkerLimit;
  /** Local worker recovery; never sent to clients. */
  sessionId?: string;
  sessionCwd?: string;
  resumable?: boolean;
  checkpoints?: string[];
  resume?: {sessionId: string; outcome: 'resumed' | 'cold-start' | 'attempted'; reason?: string};
  dir?: string;
  /** The most recent public worker messages and tool names, in stream order. */
  activity?: TouchupActivity[];
  /** What started it: a new project, Ask for changes, a late photo, an answered Ask. */
  trigger?: 'new' | 'changes' | 'late-photos' | 'ask-answer' | 'locate';
  /** Stages with real start and end times and this Mac's typical duration for each (PRD §4). */
  stages?: PassStage[];
  /** While it runs: time left from the stages' typical durations. */
  estimate?: {remainingSec: number; endsAtMs: number};
  engine?: DesignEngine;
  /** Why a design pass used Blender when Fusion or the code engine was wanted. */
  engineNote?: string;
}

/** One thing the user scanned or asked to have made, as the phone and the Mac app both show it. */
export interface StmObject {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** What the person typed. A project saved before `fit` was a field may still end with the "Fit brief:" block a client appended (`fitRequest`). */
  instructions?: string;
  /** How a fit's exact size is settled, as New sent it (contracts `FitSchema`). */
  fit?: Fit;
  /** Sizes the person confirmed or corrected in answer to a size question, by the question's own label. Kept on any
   *  project, for every later pass (`checkedSizesBrief`). Not `fit.measured`, which is the overall size from New. */
  checkedSizes?: CheckedSize[];
  preferences?: ProjectPreferences;
  /** A configured destination id; process settings and credentials stay in the companion. */
  printerDestinationId?: string;
  state: ObjectState;
  /** PRD §5.4 Status set by hand: `works` (state `confirmed`), `needs-changes`, `archived` (hidden, everything kept). */
  outcome?: 'works' | 'needs-changes';
  /** A message held for retry when intent classification was unavailable or uncertain. */
  pendingFollowup?: string;
  pendingMessageId?: string;
  messages?: ObjectMessage[];
  requestPhotos?: string[];
  pendingPhotos?: string[];
  /** The success report that marked this project Done without a design pass. */
  completion?: {messageId?: string; note: string; atMs: number; previousStatus: import('@scan-to-make/contracts/counterpart').ProjectStatus; undone?: boolean};
  archived?: boolean;
  /** The short generated title ("Mic mount"). */
  title?: string;
  /** Curated starter identity; never inherited by Duplicate. */
  starterId?: string;
  /** Make something that fits, or copy an object (PRD §1). */
  kind?: 'fit' | 'copy' | 'published';
  /** PRD §8.11: the published model this project prints, credited on the project page (`thumbnail` relative to its folder). */
  credit?: {url: string; designer?: string; site?: string; title?: string; licence?: string; thumbnail?: string};
  /** PRD §8.11: the designer's files as published, and the one that prints. Relative to the project's folder. */
  files?: {original: string[]; current: string; receipts?: (import('@scan-to-make/printer-handoff').ModelFileInfo & {path: string; name: string; credit?: NonNullable<StmObject['credit']>;
    /** false: a 3MF kept before a printer MCP could list its plates (list_3mf_plates); they are listed when one can. */
    platesListed?: false})[]};
  plateProgress?: Record<string, import('./plates.js').PlateProgress>;
  publishedSelection?: {fileIndex: number; plateIndex: number; sliced: boolean};
  /** The Mac's open (or last) question, with its picture and allowed answers (PRD §4 Ask). */
  ask?: Ask;
  /** File name under scan/. */
  scan?: string;
  /**
   * The project's picture (PRD §5.1): the object alone on the stage, drawn by the companion (`pictures/…png`), and
   * each of its gallery pictures for clients that show pictures (`part`, `scan`, `together`, `photo`).
   */
  picture?: string;
  pictures?: import('./pictures.js').ProjectPictureNames;
  /**
   * Where `scan` came from when the phone sent an Object Capture session's photos with it: `phone-preview` is the
   * phone's own quick model, kept until this Mac rebuilds from the photos (and kept as the scan, said in words, when
   * it can't); `mac` is that rebuild, with the phone's preview kept as scan/phone-preview.usdz.
   */
  scanSource?: 'phone-preview' | 'mac';
  /** File names under photos/, in upload order. */
  photos: string[];
  /**
   * Photos for a rebuild on this Mac, under capture/: a handheld scan's (with depth), or every image of an iPhone
   * Object Capture session (`captureCompletion.source`), rebuilt into scan/scan.usdz.
   */
  capture?: string[];
  /** Lossless depth/calibration companions under capture/, separate from viewable images. */
  captureDepth?: string[];
  /** The source phone confirmed the entire finished capture; the digest binds its retained file names. */
  /** A walk-around's images, declared by the phone before it sends any; cleared when its start completes the capture. */
  captureDeclared?: {source: 'object-capture'; images: string[]};
  captureCompletion?: {version: 1; depthRequired: boolean; cameraMetadataRequired?: boolean; scaleQualificationRequired?: boolean; source?: 'object-capture'; frameCount: number; sha256: string; completedAtMs: number};
  /** capture-camera v1 was supplied and bound to the saved photos; only its digest is public. */
  captureCamera?: {sha256: string; frameCount: number};
  /** A rebuild waiting on the person (which part is the object, or how big it is). Public, path-free. */
  reconstructionReview?: ReconstructionReview;
  /** What the Mac is doing right now, in words, while it is longer than a moment (building a handheld scan). */
  progress?: string;
  passes: ObjectPass[];
  current?: {model: string; renders: string[]; sizeMm?: [number, number, number]; summary?: string;
    /** A design in several colours: the colour (and material, when named) each of the 3MF's filaments
     * belongs in, in filament order, as the pass declared them. The 3MF itself carries none. */
    filaments?: {name?: string; colour?: string; material?: string}[];

    /** What changed, each tagged (PRD §4 Result). */
    changes?: TouchupChange[];
    /**
     * A fit's places for the scanned object: each a rigid placement of the scan in this model's frame, as the pass that
     * made it said (docs/protocols/seats.md). Absent for a model with no scan to fit, or one whose pass didn't say.
     */
    seats?: import('./seats.js').Seat[];
    /** The designer's supports choice for this model, sent to the slicer as it is. */
    supports?: import('../touchup/runner.js').TouchupSupports;
    engine?: DesignEngine;
    /**
     * The design source a pass keeps for the next "Ask for changes" (PRD §8.9), relative paths: Fusion's
     * `design.f3d` and `parameters.json`, or a code design's script, parameters, input snapshots and STEP.
     */
    design?: {f3d: string; parameters?: string} | {script: string; parameters: string; inputs?: string; step?: string; result?: string};
    /**
     * This 3MF prints with the settings it carries (a designer's project), as the project's printer MCP says
     * (get_slice_settings own_process): the print sheet starts at the file's own settings and sends no quality or
     * strength the person didn't choose. Absent until the MCP has been asked, or when it doesn't say.
     */
    ownSettings?: boolean;
    /** Whose answer `ownSettings` is: the destination and its MCP's version (`current@1.1.65`); another printer or an updated MCP asks again. */
    ownSettingsFor?: string};
  question?: {closeup: string};
  /** The printer MCP's original question. Only an explicit answer to this ID can approve it. */
  printConfirmation?: ObjectPrintConfirmation;
  failure?: string;
  /** The pass (its `startedAtMs`) whose ending is `failure`. Dropped by `update` when anything else changes the failure. */
  failedPass?: number;
  /** The last print; `uncertain` when it may have reached the printer and must not be sent again by itself. */
  print?: {plate?: import('./plates.js').PlateIdentity; bundleId: string; uncertain?: boolean; destination?: {id: string; name: string}; printerStatus?: {state: string; job?: string; checkedAtMs: number; percent?: number; remainingMinutes?: number}; sliced?: boolean; estimate?: {seconds?: number; grams?: number}; events?: {atMs: number; message: string}[];
    /** PRD §8.5: one uuid per print, from Print. */
    printId?: string;
    destinationId?: string;
    /** When the printer MCP accepted it (ISO). */
    dispatchedAt?: string;
    jobName?: string;
    taskId?: string;
    /** Without a job identity: the sliced file's base name, to adopt a job named after it. */
    fileBase?: string;
    /** The print was handed to Bambu Connect: the person finishes it there. */
    sentVia?: 'bambu-connect';
    settings?: PrintSettings;
    /**
     * The spools this print uses, as the printer MCP reported them when it was sent (colour `#RRGGBB`, material, name):
     * one for a one-spool print, one per model filament (`index`) for a multi-part model. The result is drawn in them.
     */
    spools?: import('./service.js').PrintSpool[];
    /** The latest report of this print's job (PRD §8.6). */
    live?: PrintLive;
    monitor?: PrintMonitor;
  };
}

/** The project as a locate pass found it: every field it would otherwise disturb, exactly as it was. */
export function restoreLocate(o: StmObject, before: LocateSnapshot): StmObject {
  const {question: _q, failure: _f, failedPass: _p, pendingFollowup: _pf, pendingMessageId: _pm, completion: _c, ...rest} = o;
  return {...rest, state: before.state, ...(before.question ? {question: before.question} : {}), ...(before.failure !== undefined ? {failure: before.failure} : {}),
    ...(before.failedPass !== undefined ? {failedPass: before.failedPass} : {}), ...(before.pendingFollowup !== undefined ? {pendingFollowup: before.pendingFollowup} : {}),
    ...(before.pendingMessageId !== undefined ? {pendingMessageId: before.pendingMessageId} : {}), ...(before.completion ? {completion: before.completion} : {})};
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
  /** The folder that holds every project's folder. */
  get root(): string { return this.#root; }

  dir(id: string): string {
    if (!ID.test(id)) throw new ObjectNotFoundError();
    return join(this.#root, id);
  }

  async create(instructions?: string, kind?: 'fit' | 'copy' | 'published', fit?: Fit): Promise<StmObject> {
    const now = Date.now();
    const object: StmObject = {id: randomUUID(), createdAtMs: now, updatedAtMs: now, state: 'new', photos: [], requestPhotos: [], pendingPhotos: [], messages: [], passes: [],
      ...(instructions?.trim() ? {instructions: instructions.trim()} : {}), ...(kind ? {kind} : {}), ...(fit ? {fit} : {})};
    await mkdir(this.dir(object.id), {recursive: true});
    await this.#write(object);
    return object;
  }

  async get(id: string): Promise<StmObject> {
    try {
      const object = JSON.parse(await readFile(join(this.dir(id), 'object.json'), 'utf8')) as StmObject & {plate?: unknown};
      // PRD §5.6: there is no bed check. A plate observation saved by an older companion is dropped, never shown again.
      if ('plate' in object) delete object.plate;
      return object;
    }
    catch { throw new ObjectNotFoundError(); }
  }

  async list(): Promise<StmObject[]> {
    let names: string[];
    try { names = await readdir(this.#root); } catch { return []; }
    const objects: StmObject[] = [];
    for (const name of names) if (ID.test(name)) objects.push(...await this.get(name).then(o => [o], () => []));
    return objects.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** `keepUpdatedAt`: a change that isn't the project's news (its picture redrawn) keeps its place in recency order. */
  update(id: string, change: (object: StmObject) => StmObject, options: {keepUpdatedAt?: boolean} = {}): Promise<StmObject> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const before = await this.get(id);
      const updated = {...change(before), id, updatedAtMs: options.keepUpdatedAt ? before.updatedAtMs : Date.now()};
      // A failure belongs to the pass that set it only until something else sets one: a change that carries
      // `failedPass` over while the project stops being failed, or fails for another reason, loses it.
      if (updated.failedPass !== undefined && updated.failedPass === before.failedPass && (updated.state !== 'failed' || updated.failure !== before.failure)) delete updated.failedPass;
      if (updated.failedPass !== undefined && updated.state !== 'failed') delete updated.failedPass;
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
  async recoverInterrupted(options: {keepPrinting?: boolean} = {}): Promise<void> {
    for (const object of await this.list()) {
      // A dispatched print keeps going on the printer: its monitor resumes (PRD §8.6).
      if (object.state === 'printing' && (options.keepPrinting || object.print?.monitor?.phase === 'starting' || object.print?.monitor?.phase === 'watching')) continue;
      if (object.state === 'touching-up' || object.state === 'printing') {
        const atMs = Date.now(), failure = 'interrupted when your Mac restarted the app';
        await this.update(object.id, o => {
          const open = o.state === 'touching-up' ? o.passes.at(-1) : undefined;
          // A locate pass changes nothing, a restart included: the project is given back as it was.
          if (open?.trigger === 'locate' && open.endedAtMs === undefined && open.before) return {...restoreLocate(o, open.before), progress: undefined,
            passes: withPassEnded(o.passes, open.startedAtMs, {status: 'interrupted', resumable: false}, atMs,
              pass => ({activity: [...(pass.activity ?? []), {atMs, kind: 'message' as const, text: failure}].slice(-200)}))};
          if (!open || open.endedAtMs !== undefined) return {...o, state: 'failed', failure, progress: undefined, printConfirmation: undefined};
          // Only a pass whose worker had a live session when the app stopped may continue it.
          return {...o, state: 'failed', failure, failedPass: open.startedAtMs, progress: undefined, printConfirmation: undefined,
            passes: withPassEnded(o.passes, open.startedAtMs, {status: 'interrupted', resumable: open.resumable === true}, atMs,
              pass => ({activity: [...(pass.activity ?? []), {atMs, kind: 'message' as const, text: failure}].slice(-200)}))};
        });
      }
    }
  }

  async #write(object: StmObject): Promise<void> {
    const path = join(this.dir(object.id), 'object.json'), temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(object, null, 2));
    await rename(temp, path);
  }
}
