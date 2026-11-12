import {createHash} from 'node:crypto';
import {cp, mkdir, readFile, readdir, rename, rm, stat, statfs} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve} from 'node:path';
import type {StmObject} from './store.js';

export interface DesignVersion {
  id: string;
  sealedAtMs: number;
  passStartedAtMs?: number;
  note?: string;
  modelSha256: string;
  result: NonNullable<StmObject['current']>;
  picture?: string;
  pictures?: StmObject['pictures'];
  pictureStates?: StmObject['pictureStates'];
  outcome?: StmObject['outcome'];
  printedAtMs?: number;
}
export type PrintAttempt = NonNullable<StmObject['print']> & {id: string; startedAtMs: number; versionId?: string};
export const restoredWords = "Earlier designs restored from this Mac's records, so what you printed stays printed.";
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const exists = async (file: string) => stat(file).then(s => s.isFile(), () => false);
const inside = (root: string, file: string) => { const path = relative(resolve(root), resolve(file)); return path !== '..' && !path.startsWith('../') && !path.startsWith('/'); };

/**
 * A design's id from what it is, not from when it was copied (#602 review, finding 2): the project, the pass that made it
 * (or `current` for a design with no pass) and its model bytes. A migration interrupted after some copies and run again
 * finds the same ids, reuses those folders and copies nothing twice. UUID-shaped, as clients and routes expect.
 */
export function designId(projectId: string, source: string | number, modelSha256: string): string {
  const h = createHash('sha256').update(`${projectId}\n${source}\n${modelSha256}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const isFolder = (path: string) => stat(path).then(s => s.isDirectory(), () => false);

/**
 * Copy a finished result into a sealed folder before publishing its record. No links to mutable current/. The copy is
 * made in `versions/<id>.sealing` and renamed into place whole; a folder already sealed under the same id is reused.
 * `created` collects the ids this call sealed anew, so a caller that fails later can remove exactly those.
 */
export async function sealVersion(object: StmObject, dir: string, result: NonNullable<StmObject['current']>, pass: {startedAtMs?: number; endedAtMs: number; note?: string; created?: Set<string>}): Promise<DesignVersion> {
  const modelSha256 = await hash(join(dir, result.model));
  const previous = object.versions?.at(-1);
  if (previous?.modelSha256 === modelSha256) return previous;
  const id = designId(object.id, pass.startedAtMs ?? 'current', modelSha256), prefix = join('versions', id), temp = join(dir, `${prefix}.sealing`);
  const reused = await isFolder(join(dir, prefix));
  // A temp folder left by an interrupted copy is never trusted: start it again.
  await rm(temp, {recursive: true, force: true});
  if (!reused) await mkdir(temp, {recursive: true});
  const paths = new Map<string, string>();
  const copy = async (path: string, name: string) => {
    if (!inside(dir, join(dir, path))) throw new Error('A design file must belong to its project.');
    if (!await exists(join(dir, path))) return undefined;
    if (!reused) { await mkdir(dirname(join(temp, name)), {recursive: true}); await cp(join(dir, path), join(temp, name)); }
    const target = join(prefix, name); paths.set(path, target); return target;
  };
  try {
    await copy(result.model, basename(result.model));
    // Multipart designs keep the merged mesh as well as the printable 3MF.
    const mesh = join(dirname(result.model), 'model.stl');
    if (mesh !== result.model) await copy(mesh, 'model.stl');
    const renders: string[] = [];
    for (const [index, path] of result.renders.entries()) { const saved = await copy(path, join('renders', `${index}-${basename(path)}`)); if (saved) renders.push(saved); }
    let design = result.design;
    if (design) {
      const saved: Record<string, string> = {};
      for (const [key, path] of Object.entries(design)) {
        const file = await copy(path, join('design', basename(path))); if (file) saved[key] = file;
        else if (key === 'inputs') {
          // Code input snapshots are directories; copy the full tree, independently.
          if (inside(dir, join(dir, path)) && await isFolder(join(dir, path))) {
            if (!reused) await cp(join(dir, path), join(temp, 'design', 'inputs'), {recursive: true});
            saved[key] = join(prefix, 'design', 'inputs');
          }
        }
      }
      design = saved as typeof design;
    }
    if (!reused) { await rename(temp, join(dir, prefix)); pass.created?.add(id); }
    return {id, sealedAtMs: pass.endedAtMs, ...(pass.startedAtMs !== undefined ? {passStartedAtMs: pass.startedAtMs} : {}), ...(pass.note ? {note: pass.note} : {}), modelSha256,
      result: {...result, model: paths.get(result.model)!, renders, ...(design ? {design} : {})}};
  } catch (error) { await rm(temp, {recursive: true, force: true}); throw error; }
}

/** The mutable last-print view is mirrored into its own attempt, never over a previous attempt. */
export function retainAttempts(before: StmObject, next: StmObject): StmObject {
  const attempts = [...(next.prints ?? before.prints ?? [])];
  const keep = (print: StmObject['print'], at: number, fallback?: string) => {
    if (!print) return;
    let id = print.printId ?? print.bundleId;
    let index = attempts.findIndex(p => p.id === id);
    // Two older prints of one bundle (no printId) are two attempts: a different send time is a new one (review minor 6).
    if (index >= 0 && !print.printId && attempts[index]!.dispatchedAt && print.dispatchedAt && attempts[index]!.dispatchedAt !== print.dispatchedAt) {
      id = `${id}@${print.dispatchedAt}`; index = attempts.findIndex(p => p.id === id);
    }
    const old = index >= 0 ? attempts[index] : undefined;
    // When it was sent, not when the project last changed: a record rewritten later must not move its start.
    const dispatched = print.dispatchedAt ? Date.parse(print.dispatchedAt) : NaN;
    const attempt: PrintAttempt = {...old, ...print, id, startedAtMs: old?.startedAtMs ?? (Number.isFinite(dispatched) ? dispatched : at),
      ...(old?.versionId || print.versionId || fallback ? {versionId: old?.versionId ?? print.versionId ?? fallback} : {})};
    if (index >= 0) attempts[index] = attempt; else attempts.push(attempt);
  };
  keep(before.print, before.updatedAtMs, before.versions?.at(-1)?.id);
  keep(next.print, next.updatedAtMs, next.versions?.at(-1)?.id);
  return attempts.length ? {...next, prints: attempts} : next;
}

export function printedAt(version: DesignVersion, prints: readonly PrintAttempt[] = []): number | undefined {
  const times = prints.filter(p => p.versionId === version.id && p.monitor?.endState === 'done')
    .map(p => p.monitor?.endedAt ? Date.parse(p.monitor.endedAt) : p.startedAtMs).filter(Number.isFinite);
  return version.printedAtMs ?? (times.length ? Math.max(...times) : undefined);
}

interface HistoryEvent {type: string; printId?: string; at?: string; atMs?: number; destinationId?: string; data?: {keys?: string[]; estimateSec?: number; grams?: number}}
const time = (event: HistoryEvent) => event.atMs ?? Date.parse(event.at ?? '');

/** One non-destructive migration, called before startup recovery. All source folders remain intact. */
export async function migrateProjectVersions(object: StmObject, dir: string, options: {events?: HistoryEvent[]; stlInfo?: (path: string) => Promise<[number, number, number] | undefined>} = {}): Promise<StmObject> {
  if (object.versionsV1) return object;
  // Copies sealed by this run. If anything fails before the record is written, exactly these go again, so the project is
  // left as it was (finding 1); folders from an earlier interrupted run are reused by id, never copied twice (finding 2).
  const created = new Set<string>();
  try {
    const migrated = await migrateOnce(object, dir, options, created);
    // Nothing under versions/ that the record doesn't name survives: an interrupted run's copies, or temp folders.
    const keep = new Set(migrated.versions?.map(v => v.id));
    for (const name of await readdir(join(dir, 'versions')).catch(() => [] as string[]))
      if (!keep.has(name) && /^[0-9a-f-]{36}(\.sealing)?$/.test(name)) await rm(join(dir, 'versions', name), {recursive: true, force: true});
    return migrated;
  } catch (error) {
    for (const id of created) await rm(join(dir, 'versions', id), {recursive: true, force: true}).catch(() => undefined);
    for (const name of await readdir(join(dir, 'versions')).catch(() => [] as string[]))
      if (name.endsWith('.sealing')) await rm(join(dir, 'versions', name), {recursive: true, force: true}).catch(() => undefined);
    throw error;
  }
}

/** An upper bound on what migrating a project copies: every finished pass's output and code runs, and its kept model. */
export async function migrationBytes(object: StmObject, dir: string): Promise<number> {
  const size = async (path: string): Promise<number> => {
    const info = await stat(path).catch(() => undefined);
    if (!info) return 0;
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of await readdir(path).catch(() => [] as string[])) total += await size(join(path, name));
    return total;
  };
  if (object.versionsV1 || object.kind === 'published') return 0;
  let total = 0;
  for (const pass of object.passes) {
    if (!['done', 'unchanged'].includes(pass.status ?? '') || !pass.dir) continue;
    const folder = resolve(dir, pass.dir);
    if (!inside(dir, folder)) continue;
    total += await size(join(folder, 'out')) + await size(join(folder, 'cad'));
  }
  if (object.current) total += await size(join(dir, 'current'));
  return total;
}

/** Free bytes on the volume holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

/** Whether `model` (in the project) is the design `version` already keeps: its model file or, for a multipart design, its merged mesh. */
async function sameDesign(dir: string, version: DesignVersion, model: string): Promise<boolean> {
  const page = await hash(join(dir, model)).catch(() => undefined);
  if (!page) return true;
  const kept = [join(dir, version.result.model), join(dir, 'versions', version.id, 'model.stl')];
  for (const file of kept) if (await hash(file).catch(() => undefined) === page) return true;
  return false;
}

async function migrateOnce(object: StmObject, dir: string, options: {events?: HistoryEvent[]; stlInfo?: (path: string) => Promise<[number, number, number] | undefined>}, created: Set<string>): Promise<StmObject> {
  const versions: DesignVersion[] = [...(object.versions ?? [])];
  if (object.kind !== 'published') for (const pass of [...object.passes].sort((a,b) => a.startedAtMs - b.startedAtMs)) {
    if (!['done', 'unchanged'].includes(pass.status ?? '') || pass.endedAtMs === undefined || !pass.dir) continue;
    // A pass that said it changed nothing is the same design, even when its file was written again.
    if (pass.status === 'unchanged' && versions.length) continue;
    const folder = resolve(dir, pass.dir);
    if (!inside(dir, folder)) continue;
    const out = join(folder, 'out');
    const three = await exists(join(out, 'touched.3mf'));
    const model = join(out, three ? 'touched.3mf' : 'touched.stl');
    if (!await exists(model)) continue;
    const renders = (await readdir(out)).filter(n => /\.png$/i.test(n)).sort().map(n => relative(dir, join(out, n)));
    const sizeMm = await options.stlInfo?.(join(out, 'touched.stl')).catch(() => undefined);
    let design = pass === object.passes.at(-1) ? object.current?.design : undefined;
    // Code passes keep their exact script/STEP alongside the STL they made. Match bytes, never a folder's name.
    if (pass.engine === 'code') {
      const target = await hash(join(out, 'touched.stl')).catch(() => undefined);
      const cad = join(folder, 'cad');
      for (const entry of await readdir(cad, {withFileTypes: true}).catch(() => [])) if (entry.isDirectory()) {
        const candidate = join(cad, entry.name), names = await readdir(candidate);
        const stl = names.find(n => n.endsWith('.stl'));
        if (!stl || !target || await hash(join(candidate, stl)) !== target) continue;
        const script = names.find(n => n.endsWith('.py')), parameters = names.find(n => /parameters.*\.json$/.test(n));
        if (script && parameters) design = {script: relative(dir, join(candidate, script)), parameters: relative(dir, join(candidate, parameters)),
          ...(names.find(n => n.endsWith('.step')) ? {step: relative(dir, join(candidate, names.find(n => n.endsWith('.step'))!))} : {})};
        break;
      }
    }
    const result = {model: relative(dir, model), renders, ...(pass.summary ? {summary: pass.summary} : {}), ...(sizeMm ? {sizeMm} : {}), ...(pass.engine ? {engine: pass.engine} : {}), ...(design ? {design} : {})};
    const sealed = await sealVersion({...object, versions}, dir, result, {startedAtMs: pass.startedAtMs, endedAtMs: pass.endedAtMs, ...(pass.note ? {note: pass.note} : {}), created});
    if (!versions.some(v => v.id === sealed.id)) {
      // Keep the merged STL and part files as well, unchanged, for later version actions.
      for (const name of await readdir(out)) if (name === 'touched.stl' || /^part_.*\.stl$/.test(name))
        await cp(join(out, name), join(dir, 'versions', sealed.id, name === 'touched.stl' ? 'model.stl' : name));
      versions.push(sealed);
    }
  }
  // Imported models and projects whose pass folders are gone (or whose passes all failed: the unicorn) still keep the one
  // design that survives. Every print the project has on record printed that design, so each restored attempt names it
  // (#602 review, finding 3): it is dated by its model file, never after the prints that used it.
  let fallback: string | undefined;
  if (!versions.length && object.kind !== 'published' && object.current && await exists(join(dir, object.current.model))) {
    const written = await stat(join(dir, object.current.model)).then(s => s.mtimeMs, () => object.updatedAtMs);
    const sealed = await sealVersion(object, dir, object.current, {endedAtMs: Math.min(written, object.updatedAtMs), created});
    versions.push(sealed); fallback = sealed.id;
  } else if (versions.length && object.kind !== 'published' && object.current && await exists(join(dir, object.current.model))
    && !(await sameDesign(dir, versions.at(-1)!, object.current.model))) {
    // An older pass survived but the newest pass's folder is gone: the model on the page is newer than every restored
    // design. It is kept as the newest design, so the project's answer and its later prints never land on older geometry
    // (train 11-12b review, Codex P2).
    const written = await stat(join(dir, object.current.model)).then(s => s.mtimeMs, () => object.updatedAtMs);
    const sealed = await sealVersion({...object, versions}, dir, object.current,
      {endedAtMs: Math.max(versions.at(-1)!.sealedAtMs + 1, Math.min(written, object.updatedAtMs)), created});
    if (!versions.some(v => v.id === sealed.id)) versions.push(sealed);
  }
  const versionAt = (at: number) => versions.filter(v => v.sealedAtMs <= at).at(-1)?.id;
  let migrated: StmObject = {...object, versions, prints: [...(object.prints ?? [])]};
  if (object.print) {
    const start = object.print.dispatchedAt ? Date.parse(object.print.dispatchedAt) : object.updatedAtMs;
    migrated = retainAttempts({...migrated, print: undefined}, {...migrated, print: {...object.print, versionId: versionAt(start)}});
  }
  const attempts = migrated.prints!;
  for (const event of [...(options.events ?? [])].sort((a,b) => time(a) - time(b))) {
    if (!event.printId || !event.type.startsWith('print.')) continue;
    let attempt = attempts.find(p => p.id === event.printId);
    if (!attempt) {
      const start = time(event); if (!Number.isFinite(start)) continue;
      attempt = {id: event.printId, printId: event.printId, bundleId: event.printId, startedAtMs: start, versionId: versionAt(start),
        ...(event.destinationId ? {destinationId: event.destinationId} : {}),
        ...(event.data?.estimateSec !== undefined || event.data?.grams !== undefined ? {estimate: {seconds: event.data.estimateSec, grams: event.data.grams}} : {})}; attempts.push(attempt);
    }
    const end = ({'print.done': 'done', 'print.failed': 'failed', 'print.cancelled': 'cancelled', 'print.not-started': 'not-started', 'print.sent': 'sent'} as const)[event.type as 'print.done'];
    if (end && !attempt.monitor?.endState) attempt.monitor = {...attempt.monitor, phase: 'ended', endState: end, endedAt: new Date(time(event)).toISOString()} as NonNullable<PrintAttempt['monitor']>;
  }
  for (const name of await readdir(join(dir, 'prints')).catch(() => [] as string[])) {
    if (attempts.some(p => p.id === name)) continue;
    const frames = join(dir, 'prints', name, 'frames');
    const times = (await Promise.all((await readdir(frames).catch(() => [] as string[])).map(n => stat(join(frames, n)).then(s => s.mtimeMs, () => NaN)))).filter(Number.isFinite).sort((a,b) => a-b);
    if (times.length) attempts.push({id: name, printId: name, bundleId: name, startedAtMs: times[0]!, versionId: versionAt(times[0]!)});
  }
  if (fallback) for (const attempt of attempts) attempt.versionId ??= fallback;
  attempts.sort((a,b) => a.startedAtMs - b.startedAtMs);
  // The person's answer stays exactly where it is today: on the newest design. Earlier answers are not guessed back from
  // when a status changed: events record that it changed, not to what, and on the hanger (Nov 11) a status set four
  // minutes after a print David called half printed was not "It works". An earlier printed design keeps its own quiet
  // "Did it fit?" instead (#616, DESIGN.md §5 rule 3: "The app can be asked; it must not guess").
  const latest = versions.at(-1);
  const answer = object.outcome ?? (object.state === 'confirmed' ? 'works' : undefined);
  if (latest && answer && !latest.outcome) latest.outcome = answer;
  return {...migrated, versionsV1: true, ...(versions.length > 1 ? {historyRestored: restoredWords} : {})};
}
