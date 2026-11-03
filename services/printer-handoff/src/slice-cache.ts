import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Sliced files kept for reuse, so Print Again (and Print after an Estimate) prints the file already
 * sliced for this exact model and these exact slicing inputs instead of slicing it again.
 *
 * The key covers everything that can change the slice: the model's bytes, every slice_stl argument
 * after merging, the backend, the MCP server's name and version, and the MCP's own configuration
 * (its process and its `.env`, where slicer defaults live). Any change is a new key.
 */
export interface SliceCacheEntry {
  bytes: Buffer;
  /** Bambu Studio's warning on this slice, asked again on every print of it. */
  slicerWarning?: string;
  plateCount?: number;
}

/** At most this many slices per directory (one directory per project): the newest are kept. */
const KEEP = 8;

export function sliceCacheKey(parts: {model: Buffer; backend: string; server?: {name?: string; version?: string};
  config: unknown; env?: string; args: Record<string, unknown>}): string {
  const args = Object.fromEntries(Object.entries(parts.args).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({v: 1, model: createHash('sha256').update(parts.model).digest('hex'),
    backend: parts.backend, server: {name: parts.server?.name, version: parts.server?.version}, config: parts.config,
    env: parts.env === undefined ? undefined : createHash('sha256').update(parts.env).digest('hex'), args})).digest('hex');
}

export async function readSlice(directory: string, key: string): Promise<SliceCacheEntry | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as {slicerWarning?: unknown; plateCount?: unknown};
    const bytes = await readFile(join(directory, `${key}.3mf`));
    if (!bytes.length) return undefined;
    return {bytes, ...(typeof meta.slicerWarning === 'string' ? {slicerWarning: meta.slicerWarning} : {}),
      ...(typeof meta.plateCount === 'number' ? {plateCount: meta.plateCount} : {})};
  } catch { return undefined; }
}

/** Written whole or not at all (a temporary file, then a rename); a failure to keep it never fails the print. */
export async function keepSlice(directory: string, key: string, entry: SliceCacheEntry): Promise<void> {
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, entry.bytes, {mode: 0o600});
    await rename(temporary, join(directory, `${key}.3mf`));
    const meta = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(meta, JSON.stringify({...(entry.slicerWarning ? {slicerWarning: entry.slicerWarning} : {}),
      ...(entry.plateCount !== undefined ? {plateCount: entry.plateCount} : {})}), {mode: 0o600});
    await rename(meta, join(directory, `${key}.json`));
    const kept = await Promise.all((await readdir(directory)).filter(name => /^[0-9a-f]{64}\.3mf$/.test(name))
      .map(async name => ({name, at: (await stat(join(directory, name))).mtimeMs})));
    for (const old of kept.sort((a, b) => b.at - a.at).slice(KEEP)) {
      const stem = old.name.slice(0, -4);
      await rm(join(directory, `${stem}.3mf`), {force: true});
      await rm(join(directory, `${stem}.json`), {force: true});
    }
  } catch { /* reuse is an optimisation: the print already has its slice */ }
}
