import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

/**
 * Sliced files kept for reuse, so Print Again (and Print after an Estimate) prints the file already
 * sliced for this exact model and these exact slicing inputs instead of slicing it again.
 *
 * The key covers the model's bytes, every slice_stl argument
 * after merging, the backend, the MCP server's name and version, and the MCP's own configuration
 * (its process and its `.env`, where slicer defaults live), plus explicit preset file contents.
 * Preset inheritance and installed slicer resources are resolved by the MCP, not mirrored here.
 */
export interface SliceCacheEntry {
  bytes: Buffer;
  extension: string;
  /** Bambu Studio's warning on this slice, asked again on every print of it. */
  slicerWarning?: string;
  plateCount?: number;
}

/** At most this many slices per directory (one directory per project): the newest are kept. */
const KEEP = 8;

export function sliceCacheKey(parts: {model: Buffer; backend: string; server?: {name?: string; version?: string};
  config: unknown; env?: string; presets?: Record<string, string>; args: Record<string, unknown>}): string {
  const args = Object.fromEntries(Object.entries(parts.args).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({v: 1, model: createHash('sha256').update(parts.model).digest('hex'),
    backend: parts.backend, server: {name: parts.server?.name, version: parts.server?.version}, config: parts.config,
    env: parts.env === undefined ? undefined : createHash('sha256').update(parts.env).digest('hex'), presets: parts.presets, args})).digest('hex');
}

/** Explicit preset files can be edited without changing their path. If the MCP alone can read/resolve
 * an input (a remote path or named template), let it slice rather than reuse an unverified input. */
export async function presetDigests(args: Record<string, unknown>, cwd: string): Promise<Record<string, string> | undefined> {
  if (args.template_name) return undefined;
  const paths = [args.slicer_profile, args.filament_profile, args.load_filaments]
    .flatMap(value => typeof value === 'string' ? value.split(';').map(file => file.trim()).filter(Boolean) : []);
  try {
    return Object.fromEntries(await Promise.all(paths.map(async file =>
      [file, createHash('sha256').update(await readFile(resolve(cwd, file))).digest('hex')])));
  } catch { return undefined; }
}

export async function readSlice(directory: string, key: string): Promise<SliceCacheEntry | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8')) as {extension?: unknown; slicerWarning?: unknown; plateCount?: unknown};
    // Older entries did not record their format. Re-slice them instead of guessing from the cache filename.
    if (typeof meta.extension !== 'string' || !/^\.[a-z0-9]{1,16}$/i.test(meta.extension)) return undefined;
    const bytes = await readFile(join(directory, `${key}.3mf`));
    if (!bytes.length) return undefined;
    return {bytes, extension: meta.extension, ...(typeof meta.slicerWarning === 'string' ? {slicerWarning: meta.slicerWarning} : {}),
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
    await writeFile(meta, JSON.stringify({extension: entry.extension, ...(entry.slicerWarning ? {slicerWarning: entry.slicerWarning} : {}),
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
