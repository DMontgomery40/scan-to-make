import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, readdir, rename, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import type {StmObject} from './store.js';
import {seatMatrix} from './seats.js';

/**
 * A project's picture (PRD §5.1, §5.4; David, Nov 10: "of ALL THE OPTIONS, the scanned thing, the 3d thing, everything
 * else, this option, of the photograph including everything in it is by far the worst"). It is the project page's
 * first picture, drawn as the object alone on the apps' stage, once, here, so every client, notification and Live
 * Activity shows the same one: the result in the spool it prints in (or the neutral material before one is chosen);
 * before a result, the scanned object in its own colours; before a scan model exists, a photo's subject cut out of
 * its room. A multi-colour 3MF or a designer's plates keep their own pictures (the pass's render, the plate's).
 */
export interface PictureSpec {
  /** A project path: `current/model.stl` or `scan/scan.usdz`. */
  model?: string;
  zUp?: boolean;
  /** `#RRGGBB`: the spool a one-colour result prints in. */
  tint?: string;
  /** A project path: the scan drawn at each seat (Together). */
  object?: string;
  seats?: number[][];
  /** A project path: a photo whose subject is cut out, when there is no model yet. */
  photo?: string;
}

/** The pictures a project can have: its result, its scan, the two together, and a photo's subject before any model. */
export type PictureRole = 'part' | 'scan' | 'together' | 'photo';
export type ProjectPictureNames = Partial<Record<PictureRole, string>>;

/** Draws `spec` (project paths resolved against `dir`) to `output`. False when it can't (no subject, nothing to draw). */
export type DrawPicture = (dir: string, spec: PictureSpec, output: string) => Promise<boolean>;

const hex = (value: string | undefined) => {
  const match = value ? /^#?([0-9A-Fa-f]{6})/.exec(value.trim()) : null;
  return match ? `#${match[1]!.toUpperCase()}` : undefined;
};

/** The one spool a one-colour result prints in: the last print's spools, else the colour the printer reported printing it. */
export function spoolColour(object: Pick<StmObject, 'print'>): string | undefined {
  const spools = object.print?.spools;
  if (spools?.length) {
    const colours = new Set(spools.map(spool => hex(spool.colour)));
    return colours.size === 1 ? hex(spools[0]!.colour) : undefined;
  }
  return hex(object.print?.live?.activeFilament?.color);
}

const isModelScan = (name: string | undefined) => !!name && /\.(usdz|usdc|usda|stl)$/i.test(name);

/**
 * What each of the project's pictures draws (CounterpartKit `ProjectGallery`'s entries, for clients that show pictures).
 * A designer's plates and a multi-colour 3MF keep their own pictures, which carry their colours.
 */
export function pictureSpecs(object: StmObject): Partial<Record<PictureRole, PictureSpec>> {
  const specs: Partial<Record<PictureRole, PictureSpec>> = {};
  const current = object.current, published = object.kind === 'published' || !!current?.model.toLowerCase().endsWith('.3mf');
  const scan = isModelScan(object.scan) ? `scan/${object.scan}` : undefined;
  if (current && !published) {
    const tint = spoolColour(object);
    specs.part = {model: 'current/model.stl', zUp: true, ...(tint ? {tint} : {})};
    if (scan && /\.usdz$/i.test(scan) && current.seats?.length) specs.together = {...specs.part, object: scan, seats: current.seats.map(seat => seatMatrix(seat))};
  }
  if (scan && object.kind !== 'published') specs.scan = /\.stl$/i.test(scan) ? {model: scan, zUp: true} : {model: scan};
  // No model yet (photos still uploading, a rebuild still running): a photo's subject, cut out of its room.
  if (!current && !scan) {
    const photo = object.photos[0] ? `photos/${object.photos[0]}` : object.capture?.[0] ? `capture/${object.capture[0]}` : undefined;
    if (photo) specs.photo = {photo};
  }
  return specs;
}

/**
 * The project's picture (the gallery's first entry): its result, else its scan, else a photo's subject. A copy before
 * a spool is chosen leads with its scan in its own colours, the truest picture of it (the mockup's potato).
 */
export function leadPicture(names: ProjectPictureNames | undefined, object?: Pick<StmObject, 'kind' | 'print'>): string | undefined {
  if (object?.kind === 'copy' && !spoolColour(object) && names?.scan) return names.scan;
  return names?.part ?? names?.scan ?? names?.photo;
}

/** How the pictures are drawn (`mac-reconstruct picture`): raised when the drawing changes, so every picture is redrawn. 2: the light stage; 3: pale parts keep their shading. */
const PICTURE_VERSION = 3;

/** The picture's file name: changes whenever what it draws changes (a file, a spool, a seat), so client caches refresh. */
export async function pictureName(dir: string, role: PictureRole, spec: PictureSpec): Promise<string | undefined> {
  const sources = [spec.model, spec.object, spec.photo].filter((path): path is string => !!path);
  if (!sources.length) return undefined;
  const files = [];
  for (const source of sources) {
    const info = await stat(join(dir, source)).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    files.push([info.size, Math.round(info.mtimeMs)]);
  }
  const key = createHash('sha256').update(JSON.stringify({v: PICTURE_VERSION, spec, files})).digest('hex').slice(0, 16);
  return `pictures/${role}-${key}.png`;
}

/**
 * Keeps each project's pictures current: draws one once when what it shows changes, one project at a time, and records
 * the names on the project (`pictures`, and `picture` for the lead one).
 * - An old picture stays until its new one is drawn: a redraw that fails keeps the old file and name for that role.
 * - What was tried is remembered: a drawing that failed (a photo whose subject can't be cut out) is not tried again,
 *   and nothing is written, until what the picture would show changes.
 * - Nothing is saved, and no event goes out, when the names didn't change.
 * Each project's work runs in one queue and reads the project afresh there, so two quick changes never save out of order.
 */
export class ProjectPictures {
  readonly #draw: DrawPicture | undefined;
  readonly #save: (id: string, names: ProjectPictureNames, object: StmObject) => Promise<void>;
  readonly #read: (id: string) => Promise<StmObject>;
  /** Per project: the inputs last tried (role → name wanted), so `ensure` does nothing until they change. */
  readonly #attempted = new Map<string, string>();
  readonly #pending = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(draw: DrawPicture | undefined, save: (id: string, names: ProjectPictureNames, object: StmObject) => Promise<void>,
      read?: (id: string) => Promise<StmObject>) {
    this.#draw = draw; this.#save = save; this.#read = read ?? (async () => { throw new Error('no store'); });
  }

  /** Queues whatever of the project's pictures is missing or out of date. Never waits for the drawing. */
  ensure(object: StmObject, dir: string): void {
    const draw = this.#draw;
    if (!draw || this.#pending.has(object.id)) return;
    this.#pending.add(object.id);
    this.#queue = this.#queue.then(async () => {
      try {
        const fresh = await this.#read(object.id).catch(() => object);
        const specs = pictureSpecs(fresh), wanted: ProjectPictureNames = {};
        for (const [role, spec] of Object.entries(specs) as [PictureRole, PictureSpec][]) {
          const name = await pictureName(dir, role, spec);
          if (name) wanted[role] = name;
        }
        const have = fresh.pictures ?? {};
        const key = JSON.stringify(wanted);
        const same = sameNames(have, wanted) && fresh.picture === leadPicture(wanted, fresh);
        if (same) { this.#attempted.set(object.id, key); return; }
        // Tried with these very inputs already (and a drawing failed): nothing to do until they change.
        if (this.#attempted.get(object.id) === key) return;
        this.#attempted.set(object.id, key);
        await mkdir(join(dir, 'pictures'), {recursive: true});
        const drawn: ProjectPictureNames = {};
        for (const [role, name] of Object.entries(wanted) as [PictureRole, string][]) {
          const exists = async (file: string) => stat(join(dir, file)).then(info => info.size > 0, () => false);
          if (await exists(name)) { drawn[role] = name; continue; }
          const temp = join(dir, `${name}.drawing.png`);
          if (await draw(dir, specs[role]!, temp).catch(() => false)) { await rename(temp, join(dir, name)); drawn[role] = name; continue; }
          await rm(temp, {force: true});
          // The redraw failed: the role keeps the picture it had, if it had one.
          if (have[role] && await exists(have[role]!)) drawn[role] = have[role];
        }
        // Only the pictures in use are kept.
        const keep = new Set(Object.values(drawn));
        for (const file of await readdir(join(dir, 'pictures')).catch(() => [] as string[]))
          if (!keep.has(`pictures/${file}`) && !file.endsWith('.drawing.png')) await rm(join(dir, 'pictures', file), {force: true});
        if (sameNames(have, drawn) && fresh.picture === leadPicture(drawn, fresh)) return;
        await this.#save(object.id, drawn, fresh);
      } finally { this.#pending.delete(object.id); }
    }).catch(() => undefined);
  }

  /** Waits for every queued drawing (tests, shutdown). */
  async idle(): Promise<void> { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await this.#queue; } }
}

const sameNames = (a: ProjectPictureNames, b: ProjectPictureNames) =>
  (Object.keys(a) as PictureRole[]).every(role => a[role] === b[role]) && (Object.keys(b) as PictureRole[]).every(role => a[role] === b[role]);

/** The Mac's drawing: `mac-reconstruct picture` (SceneKit and Vision on this Mac). */
export function macDrawPicture(binary: string): DrawPicture {
  const run = promisify(execFile);
  return async (dir, spec, output) => {
    const args = ['picture', output, '--pixels', '720'];
    if (spec.model) args.push('--model', join(dir, spec.model), ...(spec.zUp ? ['--z-up'] : []), ...(spec.tint ? ['--tint', spec.tint.slice(1)] : []));
    if (spec.object && spec.seats?.length) args.push('--object', join(dir, spec.object), ...spec.seats.flatMap(matrix => ['--seat', matrix.map(value => Number(value.toFixed(6))).join(',')]));
    else if (spec.photo) args.push('--photo', join(dir, spec.photo));
    try { await run(binary, args, {timeout: 120_000}); return (await stat(output)).size > 0; }
    catch { return false; }
  };
}

