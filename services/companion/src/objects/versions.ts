import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, readFile, readdir, rename, rm, stat} from 'node:fs/promises';
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

/** Copy a finished result into a sealed folder before publishing its record. No links to mutable current/. */
export async function sealVersion(object: StmObject, dir: string, result: NonNullable<StmObject['current']>, pass: {startedAtMs?: number; endedAtMs: number; note?: string}): Promise<DesignVersion> {
  const modelSha256 = await hash(join(dir, result.model));
  const previous = object.versions?.at(-1);
  if (previous?.modelSha256 === modelSha256) return previous;
  const id = randomUUID(), prefix = join('versions', id), temp = join(dir, `${prefix}.sealing`);
  await mkdir(temp, {recursive: true});
  const paths = new Map<string, string>();
  const copy = async (path: string, name: string) => {
    if (!inside(dir, join(dir, path))) throw new Error('A design file must belong to its project.');
    if (!await exists(join(dir, path))) return undefined;
    await mkdir(dirname(join(temp, name)), {recursive: true});
    await cp(join(dir, path), join(temp, name));
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
          if (inside(dir, join(dir, path))) { await cp(join(dir, path), join(temp, 'design', 'inputs'), {recursive: true}); saved[key] = join(prefix, 'design', 'inputs'); }
        }
      }
      design = saved as typeof design;
    }
    await rename(temp, join(dir, prefix));
    return {id, sealedAtMs: pass.endedAtMs, ...(pass.startedAtMs !== undefined ? {passStartedAtMs: pass.startedAtMs} : {}), ...(pass.note ? {note: pass.note} : {}), modelSha256,
      result: {...result, model: paths.get(result.model)!, renders, ...(design ? {design} : {})}};
  } catch (error) { await rm(temp, {recursive: true, force: true}); throw error; }
}

/** The mutable last-print view is mirrored into its own attempt, never over a previous attempt. */
export function retainAttempts(before: StmObject, next: StmObject): StmObject {
  const attempts = [...(next.prints ?? before.prints ?? [])];
  const keep = (print: StmObject['print'], at: number, fallback?: string) => {
    if (!print) return;
    const id = print.printId ?? print.bundleId;
    const index = attempts.findIndex(p => p.id === id);
    const old = index >= 0 ? attempts[index] : undefined;
    const attempt: PrintAttempt = {...old, ...print, id, startedAtMs: old?.startedAtMs ?? at,
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
  const versions: DesignVersion[] = [...(object.versions ?? [])];
  if (object.kind !== 'published') for (const pass of [...object.passes].sort((a,b) => a.startedAtMs - b.startedAtMs)) {
    if (!['done', 'unchanged'].includes(pass.status ?? '') || pass.endedAtMs === undefined || !pass.dir) continue;
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
    const sealed = await sealVersion({...object, versions}, dir, result, {startedAtMs: pass.startedAtMs, endedAtMs: pass.endedAtMs, ...(pass.note ? {note: pass.note} : {})});
    if (!versions.some(v => v.id === sealed.id)) {
      // Keep the merged STL and part files as well, unchanged, for later version actions.
      for (const name of await readdir(out)) if (name === 'touched.stl' || /^part_.*\.stl$/.test(name))
        await cp(join(out, name), join(dir, 'versions', sealed.id, name === 'touched.stl' ? 'model.stl' : name));
      versions.push(sealed);
    }
  }
  // Imported models and projects whose pass folders are gone still keep the one design that survives.
  if (!versions.length && object.kind !== 'published' && object.current && await exists(join(dir, object.current.model))) {
    versions.push(await sealVersion(object, dir, object.current, {endedAtMs: object.updatedAtMs}));
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
  attempts.sort((a,b) => a.startedAtMs - b.startedAtMs);
  for (let i = 0; i < versions.length; i++) {
    const version = versions[i]!;
    if (i === versions.length - 1 && object.outcome) version.outcome = object.outcome;
    else if (i < versions.length - 1) {
      const done = printedAt(version, attempts), nextStarted = versions[i+1]!.passStartedAtMs ?? versions[i+1]!.sealedAtMs;
      if (done !== undefined && (options.events ?? []).some(e => e.type === 'project.updated' && e.data?.keys?.includes('status') && time(e) > done && time(e) < nextStarted)) version.outcome = 'works';
    }
  }
  return {...migrated, versionsV1: true, ...(versions.length > 1 ? {historyRestored: restoredWords} : {})};
}
