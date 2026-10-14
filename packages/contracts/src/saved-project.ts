import { z } from 'zod';
import {
  ProjectFitSpecSchema, ProjectFitSpecPatchSchema, ArtifactRefSchema, applyProjectFitSpecPatch,
} from './index.js';

const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Draft text is preserved verbatim, including empty and unfinished fields. */
export const ProjectBriefSchema = z.strictObject({
  object: z.string(), context: z.string(), addition: z.string(),
});
const savedFields = {
  id: projectId,
  revision,
  brief: ProjectBriefSchema,
  fit: ProjectFitSpecSchema.nullable(),
};
function validateFitOwner(project: z.infer<z.ZodObject<typeof savedFields>>, ctx: z.RefinementCtx): void {
  if (project.fit && (project.fit.id !== project.id || project.fit.revision > project.revision)) {
    ctx.addIssue({ code: 'custom', path: ['fit'],
      message: 'Fit must belong to this project and cannot be ahead of its saved revision' });
  }
}

/** Equality of validated JSON values, independent of object property order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
  }
  return false;
}

/** Metadata only: consumers must verify actual artifact bytes before using them. */
export const SavedArtifactBindingSchema = z.strictObject({
  sourceFit: ProjectFitSpecSchema,
  artifact: ArtifactRefSchema,
});
const legacySavedProjectSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'), ...savedFields,
}).superRefine(validateFitOwner);
export const SavedProjectSchema = z.strictObject({
  formatVersion: z.literal('0.2.0'), ...savedFields,
  preview: SavedArtifactBindingSchema.nullable(),
  acceptedArtifact: SavedArtifactBindingSchema.nullable(),
}).superRefine((project, ctx) => {
  validateFitOwner(project, ctx);
  if (project.preview && !sameValue(project.preview.sourceFit, project.fit)) {
    ctx.addIssue({ code: 'custom', path: ['preview'], message: 'Preview must bind the entire current fit' });
  }
  if (project.acceptedArtifact && !sameValue(project.acceptedArtifact, project.preview)) {
    ctx.addIssue({ code: 'custom', path: ['acceptedArtifact'], message: 'Acceptance must match the attached preview' });
  }
});
export const SavedProjectChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('replace-brief'), brief: ProjectBriefSchema }),
  z.strictObject({ kind: z.literal('attach-fit'), fit: ProjectFitSpecSchema }),
  z.strictObject({ kind: z.literal('patch-fit'), patch: ProjectFitSpecPatchSchema }),
  z.strictObject({ kind: z.literal('attach-preview'), ...SavedArtifactBindingSchema.shape }),
  z.strictObject({ kind: z.literal('accept-preview'), ...SavedArtifactBindingSchema.shape }),
]);
const createInput = z.strictObject({ id: projectId, brief: ProjectBriefSchema, fit: ProjectFitSpecSchema.nullable() });

export type SavedProject = z.infer<typeof SavedProjectSchema>;
export type SavedArtifactBinding = z.infer<typeof SavedArtifactBindingSchema>;
export type SavedProjectChange = z.infer<typeof SavedProjectChangeSchema>;
export type CreateSavedProjectInput = z.infer<typeof createInput>;
export type LoadProjectResult =
  | { status: 'ok'; project: SavedProject }
  | { status: 'missing' }
  | { status: 'corrupt' }
  | { status: 'unsupported-version'; scope: 'project' | 'fit'; version: string }
  | { status: 'storage-error' };
export type WriteProjectResult = LoadProjectResult
  | { status: 'exists'; latest: SavedProject }
  | { status: 'stale'; scope: 'project' | 'fit'; latest: SavedProject }
  | { status: 'invalid-change' };
export type ListProjectsResult =
  | { status: 'ok'; entries: Array<{ id: string; result: LoadProjectResult }> }
  | { status: 'storage-error' };

/** Implementations must make comparison and replacement atomic across all writers. */
export interface SavedProjectStorage {
  listIds(): Promise<string[]>;
  read(id: string): Promise<string | null>;
  compareAndSwap(id: string, expected: string | null, next: string): Promise<boolean>;
}
export interface SavedProjects {
  list(): Promise<ListProjectsResult>;
  load(id: string): Promise<LoadProjectResult>;
  create(input: CreateSavedProjectInput): Promise<WriteProjectResult>;
  change(id: string, expectedRevision: number, change: SavedProjectChange): Promise<WriteProjectResult>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parsing never repairs or discards bytes. Future formats remain recoverable. */
export function decodeSavedProject(bytes: string, expectedId?: string): LoadProjectResult {
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { return { status: 'corrupt' }; }
  if (isObject(value)) {
    if (typeof value.formatVersion === 'string' && !['0.1.0', '0.2.0'].includes(value.formatVersion)) {
      return { status: 'unsupported-version', scope: 'project', version: value.formatVersion };
    }
    const fit = value.fit;
    if (isObject(fit) && typeof fit.schemaVersion === 'string' &&
        ((fit.template === 'cup-holder-adapter' && fit.schemaVersion !== '0.1.0') ||
         (fit.template === 'drawer-tray' && fit.schemaVersion !== '0.2.0'))) {
      return { status: 'unsupported-version', scope: 'fit', version: fit.schemaVersion };
    }
  }
  if (isObject(value) && value.formatVersion === '0.1.0') {
    const legacy = legacySavedProjectSchema.safeParse(value);
    if (!legacy.success) return { status: 'corrupt' };
    // Normalize only in memory; the repository retains original bytes for CAS.
    value = { ...legacy.data, formatVersion: '0.2.0', preview: null, acceptedArtifact: null };
  }
  const parsed = SavedProjectSchema.safeParse(value);
  if (!parsed.success || (expectedId !== undefined && parsed.data.id !== expectedId)) {
    return { status: 'corrupt' };
  }
  return { status: 'ok', project: parsed.data };
}

/** Pure transition; only the repository/storage adapter can persist the result. */
export function applySavedProjectChange(current: SavedProject, expectedRevision: number,
  input: SavedProjectChange): WriteProjectResult {
  const parsed = SavedProjectSchema.safeParse(current);
  if (!parsed.success) return { status: 'corrupt' };
  const project = parsed.data;
  const change = SavedProjectChangeSchema.safeParse(input);
  if (!revision.safeParse(expectedRevision).success || !change.success) return { status: 'invalid-change' };
  if (expectedRevision !== project.revision) return { status: 'stale', scope: 'project', latest: project };
  let brief = project.brief;
  let fit = project.fit;
  let preview = project.preview;
  let acceptedArtifact = project.acceptedArtifact;
  switch (change.data.kind) {
    case 'replace-brief':
      brief = change.data.brief;
      if (brief.object === project.brief.object && brief.context === project.brief.context &&
          brief.addition === project.brief.addition) return { status: 'ok', project };
      break;
    case 'attach-fit':
      if (fit !== null || change.data.fit.id !== project.id || change.data.fit.revision !== 0) {
        return { status: 'invalid-change' };
      }
      fit = change.data.fit;
      break;
    case 'patch-fit':
      if (!fit) return { status: 'invalid-change' };
      if (change.data.patch.expectedRevision !== fit.revision) return { status: 'stale', scope: 'fit', latest: project };
      try { fit = applyProjectFitSpecPatch(fit, change.data.patch); }
      catch { return { status: 'invalid-change' }; }
      if (fit.revision === project.fit!.revision) return { status: 'ok', project };
      preview = null;
      acceptedArtifact = null;
      break;
    case 'attach-preview':
    case 'accept-preview': {
      const binding = { sourceFit: change.data.sourceFit, artifact: change.data.artifact };
      if (!fit || !sameValue(binding.sourceFit, fit)) return { status: 'invalid-change' };
      if (change.data.kind === 'attach-preview') {
        if (sameValue(binding, preview)) return { status: 'ok', project };
        preview = binding;
        acceptedArtifact = null;
      } else {
        if (!sameValue(binding, preview)) return { status: 'invalid-change' };
        if (sameValue(binding, acceptedArtifact)) return { status: 'ok', project };
        acceptedArtifact = binding;
      }
      break;
    }
  }
  if (project.revision === Number.MAX_SAFE_INTEGER) return { status: 'invalid-change' };
  const next = SavedProjectSchema.safeParse({ ...project, revision: project.revision + 1, brief, fit, preview, acceptedArtifact });
  return next.success ? { status: 'ok', project: next.data } : { status: 'invalid-change' };
}

/** No Node imports, caching, implicit retries, or unguarded replacement writes. */
export function createSavedProjects(storage: SavedProjectStorage): SavedProjects {
  async function load(id: string): Promise<LoadProjectResult> {
    if (!projectId.safeParse(id).success) return { status: 'corrupt' };
    try {
      const bytes = await storage.read(id);
      return bytes === null ? { status: 'missing' } : decodeSavedProject(bytes, id);
    } catch { return { status: 'storage-error' }; }
  }
  return {
    load,
    async list(): Promise<ListProjectsResult> {
      try {
        const ids = z.array(z.string()).parse(await storage.listIds());
        const entries = await Promise.all([...new Set(ids)].sort().map(async id => ({ id, result: await load(id) })));
        return { status: 'ok', entries };
      } catch { return { status: 'storage-error' }; }
    },
    async create(input): Promise<WriteProjectResult> {
      // Snapshot caller data before the first await, so edits cannot change the write.
      const parsed = createInput.safeParse(input);
      if (!parsed.success) return { status: 'invalid-change' };
      const initial = SavedProjectSchema.safeParse({ ...parsed.data, formatVersion: '0.2.0', revision: 0,
        preview: null, acceptedArtifact: null });
      if (!initial.success) return { status: 'invalid-change' };
      const project = initial.data;
      try {
        if (await storage.compareAndSwap(project.id, null, JSON.stringify(project))) return { status: 'ok', project };
        const latest = await load(project.id);
        return latest.status === 'ok' ? { status: 'exists', latest: latest.project } : latest;
      } catch { return { status: 'storage-error' }; }
    },
    async change(id, expectedRevision, input): Promise<WriteProjectResult> {
      const change = SavedProjectChangeSchema.safeParse(input);
      if (!projectId.safeParse(id).success || !revision.safeParse(expectedRevision).success || !change.success) {
        return { status: 'invalid-change' };
      }
      try {
        const bytes = await storage.read(id);
        if (bytes === null) return { status: 'missing' };
        const loaded = decodeSavedProject(bytes, id);
        if (loaded.status !== 'ok') return loaded;
        const result = applySavedProjectChange(loaded.project, expectedRevision, change.data);
        if (result.status !== 'ok' || result.project.revision === loaded.project.revision) return result;
        if (await storage.compareAndSwap(id, bytes, JSON.stringify(result.project))) return result;
        const latest = await load(id);
        return latest.status === 'ok' ? { status: 'stale', scope: 'project', latest: latest.project } : latest;
      } catch { return { status: 'storage-error' }; }
    },
  };
}
