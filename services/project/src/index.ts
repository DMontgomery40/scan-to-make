import { mkdir, open, readFile, rename, link, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ProjectFitSpecSchema, ArtifactRefSchema, ProjectFitSpecPatchSchema,
  validateProjectFitSpec, validateArtifactRef, applyProjectFitSpecPatch,
  type ArtifactRef,
} from '@scan-to-make/contracts';

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const revisionArtifact = z.strictObject({ specRevision: revision, artifact: ArtifactRefSchema });

function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.sha256 === b.sha256 && a.mediaType === b.mediaType && a.byteLength === b.byteLength;
}

export const ProjectRecordSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  spec: ProjectFitSpecSchema,
  preview: revisionArtifact.nullable(),
  acceptedArtifact: revisionArtifact.nullable(),
}).superRefine((record, ctx) => {
  for (const key of ['preview', 'acceptedArtifact'] as const) {
    if (record[key] && record[key].specRevision !== record.spec.revision) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Artifact references a stale spec revision' });
    }
  }
  if (record.acceptedArtifact && (!record.preview ||
      !sameArtifact(record.acceptedArtifact.artifact, record.preview.artifact))) {
    ctx.addIssue({ code: 'custom', path: ['acceptedArtifact'], message: 'Acceptance must match the current preview' });
  }
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

/** A local JSON boundary. Authentication and geometry/byte verification belong to callers. */
export class ProjectStore {
  constructor(private readonly directory: string) {}

  async create(input: unknown): Promise<ProjectRecord> {
    const spec = validateProjectFitSpec(input);
    const id = projectId.parse(spec.id);
    if (spec.revision !== 0) throw new Error('New projects must begin at revision zero');
    const record = ProjectRecordSchema.parse({ formatVersion: '0.1.0', spec, preview: null, acceptedArtifact: null });
    return this.withLock(id, async () => {
      await this.writeRecord(id, record, true);
      return record;
    });
  }

  async load(id: string): Promise<ProjectRecord> {
    return this.readRecord(projectId.parse(id));
  }

  async applyPatch(id: string, input: unknown): Promise<ProjectRecord> {
    id = projectId.parse(id);
    const patch = ProjectFitSpecPatchSchema.parse(input);
    return this.withLock(id, async () => {
      const record = await this.readRecord(id);
      const spec = applyProjectFitSpecPatch(record.spec, patch);
      if (spec.revision === record.spec.revision) return record;
      const next = ProjectRecordSchema.parse({ ...record, spec, preview: null, acceptedArtifact: null });
      await this.writeRecord(id, next, false);
      return next;
    });
  }

  async attachPreview(id: string, expectedRevision: number, input: unknown): Promise<ProjectRecord> {
    id = projectId.parse(id);
    expectedRevision = revision.parse(expectedRevision);
    const artifact = validateArtifactRef(input);
    return this.withLock(id, async () => {
      const record = await this.readRecord(id);
      this.checkRevision(record, expectedRevision);
      const next = ProjectRecordSchema.parse({
        ...record, preview: {specRevision: expectedRevision, artifact}, acceptedArtifact: null,
      });
      await this.writeRecord(id, next, false);
      return next;
    });
  }

  async acceptPreview(id: string, expectedRevision: number, input: unknown): Promise<ProjectRecord> {
    id = projectId.parse(id);
    expectedRevision = revision.parse(expectedRevision);
    const artifact = validateArtifactRef(input);
    return this.withLock(id, async () => {
      const record = await this.readRecord(id);
      this.checkRevision(record, expectedRevision);
      if (!record.preview || !sameArtifact(record.preview.artifact, artifact)) {
        throw new Error('Acceptance must name the exact current preview artifact');
      }
      const next = ProjectRecordSchema.parse({ ...record, acceptedArtifact: record.preview });
      await this.writeRecord(id, next, false);
      return next;
    });
  }

  private checkRevision(record: ProjectRecord, expected: number): void {
    if (record.spec.revision !== expected) throw new Error('Stale project revision');
  }

  private async readRecord(id: string): Promise<ProjectRecord> {
    const record = ProjectRecordSchema.parse(JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8')));
    if (record.spec.id !== id) throw new Error('Stored project identity does not match its file');
    return record;
  }

  private async withLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const lock = join(this.directory, `${id}.lock`);
    try { await mkdir(lock, {mode: 0o700}); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Project is busy or has an interrupted write; inspect the lock before recovery');
      }
      throw error;
    }
    try { return await operation(); }
    finally { await rmdir(lock); }
  }

  private async writeRecord(id: string, record: ProjectRecord, exclusive: boolean): Promise<void> {
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const destination = join(this.directory, `${id}.json`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); }
      finally { await file.close(); }
      if (exclusive) await link(temporary, destination);
      else await rename(temporary, destination);
    } finally {
      // Only this operation's unique temporary file is eligible for cleanup.
      await unlink(temporary).catch(() => undefined);
    }
  }
}
