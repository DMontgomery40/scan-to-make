import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import {printerBackendSchema, printerSelectionSchema, type PrinterBackend, type PrinterSelection} from './config.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeBasename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/).refine(name => name !== '.' && name !== '..');
const artifactSchema = z.strictObject({
  file: safeBasename,
  sha256: digest,
  byteLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type HandoffArtifact = z.infer<typeof artifactSchema>;

export const handoffStatusSchema = z.enum(['ready', 'claimed', 'designed', 'sliced', 'printed', 'uncertain', 'failed']);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

export const handoffManifestSchema = z.strictObject({
  schema: z.literal('scan-to-make.printer-handoff/0.1'),
  id: z.uuid(),
  createdAtMs: z.number().int().nonnegative(),
  prompt: z.string().max(8000),
  backend: printerBackendSchema,
  selection: printerSelectionSchema.optional(),
  cleanStl: artifactSchema,
  designedStl: artifactSchema.optional(),
  artifacts: z.record(z.string(), artifactSchema),
  status: handoffStatusSchema,
  claimedBy: z.string().max(256).optional(),
  failure: z.string().max(2048).optional(),
});
export type HandoffManifest = z.infer<typeof handoffManifestSchema>;

const MAX_STL_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const bundleId = z.uuid();

function artifactFor(file: string, bytes: Buffer): HandoffArtifact {
  return {file, sha256: sha256(bytes), byteLength: bytes.length};
}
async function writeAtomically(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
  await rename(temporary, path);
}
async function verifyFile(path: string, artifact: HandoffArtifact): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.byteLength) throw new Error('Handoff artifact identity mismatch');
    const bytes = await handle.readFile();
    if (sha256(bytes) !== artifact.sha256) throw new Error('Handoff artifact identity mismatch');
  } finally { await handle.close(); }
}

/**
 * Filesystem handoff bundles: one directory per handoff holding the clean
 * STL, the user's prompt and the chosen backend, for a desktop agent session
 * to claim locally and for the companion to print from afterwards.
 */
export class HandoffBundleStore {
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }

  directory(id: string): string { return join(this.#root, bundleId.parse(id)); }
  private manifestPath(id: string): string { return join(this.directory(id), 'handoff.json'); }

  async create(input: {stl: Buffer; prompt: string; backend: PrinterBackend; selection?: PrinterSelection}): Promise<HandoffManifest> {
    if (!Buffer.isBuffer(input.stl) || input.stl.length < 84 || input.stl.length > MAX_STL_BYTES) {
      throw new Error('Clean STL byte limit exceeded');
    }
    z.string().max(8000).parse(input.prompt);
    printerBackendSchema.parse(input.backend);
    if (input.selection !== undefined) printerSelectionSchema.parse(input.selection);
    const id = randomUUID();
    const stl = Buffer.from(input.stl);
    const manifest = handoffManifestSchema.parse({
      schema: 'scan-to-make.printer-handoff/0.1', id, createdAtMs: Date.now(),
      prompt: input.prompt, backend: input.backend,
      ...(input.selection === undefined ? {} : {selection: input.selection}),
      cleanStl: artifactFor('clean.stl', stl), artifacts: {}, status: 'ready',
    });
    await mkdir(this.#root, {recursive: true, mode: 0o700});
    const staging = join(this.#root, `.tmp-${id}`);
    await mkdir(staging, {mode: 0o700});
    try {
      await writeFile(join(staging, 'clean.stl'), stl, {flag: 'wx', mode: 0o600});
      await writeFile(join(staging, 'handoff.json'), JSON.stringify(manifest) + '\n', {flag: 'wx', mode: 0o600});
      await rename(staging, this.directory(id));
    } catch (error) {
      await rm(staging, {recursive: true, force: true}).catch(() => undefined);
      throw error;
    }
    return structuredClone(manifest);
  }

  async read(id: string): Promise<HandoffManifest> {
    const manifest = handoffManifestSchema.parse(JSON.parse(await readFile(this.manifestPath(id), 'utf8')));
    if (manifest.id !== bundleId.parse(id)) throw new Error('Handoff bundle identity mismatch');
    await verifyFile(join(this.directory(id), manifest.cleanStl.file), manifest.cleanStl);
    if (manifest.designedStl) await verifyFile(join(this.directory(id), manifest.designedStl.file), manifest.designedStl);
    for (const artifact of Object.values(manifest.artifacts)) {
      await verifyFile(join(this.directory(id), artifact.file), artifact);
    }
    return manifest;
  }

  async list(): Promise<HandoffManifest[]> {
    const entries = await readdir(this.#root).catch(() => []);
    const manifests: HandoffManifest[] = [];
    for (const entry of entries) {
      if (!bundleId.safeParse(entry).success) continue;
      manifests.push(await this.read(entry));
    }
    return manifests.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  private async writeManifest(manifest: HandoffManifest): Promise<void> {
    await writeAtomically(this.manifestPath(manifest.id), Buffer.from(JSON.stringify(manifest) + '\n'));
  }
  private async update(id: string, patch: Partial<HandoffManifest>): Promise<HandoffManifest> {
    const current = await this.read(id);
    const next = handoffManifestSchema.parse({...current, ...patch, id: current.id});
    await this.writeManifest(next);
    return next;
  }
  // Publishes replacement bytes under a digest-versioned name first, so the
  // manifest never points at bytes that fail its previous digest mid-swap.
  // A name already owned by another manifest entry is versioned the same
  // way, so a new artifact key can never overwrite a sibling's file.
  private async publishReplacement(
    id: string, fileName: string, copy: Buffer, existing: HandoffArtifact | undefined, ownedFiles: ReadonlySet<string>,
  ): Promise<HandoffArtifact> {
    const digest = sha256(copy);
    if (existing?.sha256 === digest && existing.byteLength === copy.length) return existing;
    let target = fileName;
    if (existing || ownedFiles.has(target)) {
      const dot = fileName.lastIndexOf('.');
      target = dot > 0 ? `${fileName.slice(0, dot)}-${digest.slice(0, 12)}${fileName.slice(dot)}` : `${fileName}-${digest.slice(0, 12)}`;
      safeBasename.parse(target);
      if (ownedFiles.has(target)) throw new Error('Artifact file already in use');
    }
    await writeAtomically(join(this.directory(id), target), copy);
    return artifactFor(target, copy);
  }

  async claim(id: string, claimedBy: string): Promise<HandoffManifest> {
    const current = await this.read(id);
    if (current.status !== 'ready') throw new Error(`Handoff bundle is not ready to claim: ${current.status}`);
    const next = handoffManifestSchema.parse({...current, status: 'claimed', claimedBy: z.string().max(256).parse(claimedBy)});
    await this.writeManifest(next);
    return next;
  }
  setStatus(id: string, status: HandoffStatus, failure?: string): Promise<HandoffManifest> {
    return this.update(id, {status, failure: failure?.slice(0, 2048)});
  }

  async writeDesignedStl(id: string, bytes: Buffer): Promise<HandoffManifest> {
    if (!Buffer.isBuffer(bytes) || bytes.length < 84 || bytes.length > MAX_STL_BYTES) throw new Error('Designed STL byte limit exceeded');
    const current = await this.read(id);
    const copy = Buffer.from(bytes);
    const owned = new Set([current.cleanStl.file, ...Object.values(current.artifacts).map(artifact => artifact.file)]);
    const designedStl = await this.publishReplacement(id, 'designed.stl', copy, current.designedStl, owned);
    const next = handoffManifestSchema.parse({...current, designedStl, status: 'designed'});
    await this.writeManifest(next);
    return next;
  }

  async recordArtifact(id: string, name: string, fileName: string, bytes: Buffer): Promise<HandoffManifest> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid artifact name');
    safeBasename.parse(fileName);
    if (fileName === 'handoff.json') throw new Error('Invalid artifact file');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_STL_BYTES) throw new Error('Artifact byte limit exceeded');
    const current = await this.read(id);
    const copy = Buffer.from(bytes);
    const owned = new Set([
      current.cleanStl.file,
      ...(current.designedStl ? [current.designedStl.file] : []),
      ...Object.entries(current.artifacts).filter(([key]) => key !== name).map(([, artifact]) => artifact.file),
    ]);
    const artifact = await this.publishReplacement(id, fileName, copy, current.artifacts[name], owned);
    const next = handoffManifestSchema.parse({...current, artifacts: {...current.artifacts, [name]: artifact}});
    await this.writeManifest(next);
    return next;
  }

  stlPath(manifest: HandoffManifest): string {
    return join(this.directory(manifest.id), (manifest.designedStl ?? manifest.cleanStl).file);
  }
}
