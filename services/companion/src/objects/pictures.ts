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
 * Keeps each project's pictures current: draws one once when what it shows changes, one at a time, and records the
 * names on the project (`pictures`, and `picture` for the lead one). An old picture stays until its new one is drawn.
 */
export class ProjectPictures {
  readonly #draw: DrawPicture | undefined;
  readonly #save: (id: string, names: ProjectPictureNames, object: StmObject) => Promise<void>;
  readonly #failed = new Set<string>();
  readonly #pending = new Set<string>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(draw: DrawPicture | undefined, save: (id: string, names: ProjectPictureNames, object: StmObject) => Promise<void>) {
    this.#draw = draw; this.#save = save;
  }

  /** Queues whatever of the project's pictures is missing or out of date. Never waits for the drawing. */
  ensure(object: StmObject, dir: string): void {
    const draw = this.#draw;
    if (!draw) return;
    void (async () => {
      const specs = pictureSpecs(object), wanted: ProjectPictureNames = {};
      for (const [role, spec] of Object.entries(specs) as [PictureRole, PictureSpec][]) {
        const name = await pictureName(dir, role, spec);
        if (name) wanted[role] = name;
      }
      const have = object.pictures ?? {};
      const same = (Object.keys(wanted) as PictureRole[]).every(role => have[role] === wanted[role])
        && (Object.keys(have) as PictureRole[]).every(role => wanted[role] !== undefined)
        && object.picture === leadPicture(wanted, object);
      if (same) return;
      const key = `${object.id}/${JSON.stringify(wanted)}`;
      if (this.#pending.has(key)) return;
      this.#pending.add(key);
      this.#queue = this.#queue.then(async () => {
        try {
          await mkdir(join(dir, 'pictures'), {recursive: true});
          const drawn: ProjectPictureNames = {};
          for (const [role, name] of Object.entries(wanted) as [PictureRole, string][]) {
            if (await stat(join(dir, name)).then(info => info.size > 0, () => false)) { drawn[role] = name; continue; }
            if (this.#failed.has(`${object.id}/${name}`)) continue;
            const temp = join(dir, `${name}.drawing.png`);
            if (await draw(dir, specs[role]!, temp).catch(() => false)) { await rename(temp, join(dir, name)); drawn[role] = name; }
            else { this.#failed.add(`${object.id}/${name}`); await rm(temp, {force: true}); }
          }
          // Only the current pictures are kept.
          const keep = new Set(Object.values(drawn));
          for (const file of await readdir(join(dir, 'pictures')).catch(() => [] as string[]))
            if (!keep.has(`pictures/${file}`)) await rm(join(dir, 'pictures', file), {force: true});
          await this.#save(object.id, drawn, object);
        } finally { this.#pending.delete(key); }
      }).catch(() => undefined);
    })().catch(() => undefined);
  }

  /** Waits for every queued drawing (tests, shutdown). */
  async idle(): Promise<void> { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await this.#queue; } }
}

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

