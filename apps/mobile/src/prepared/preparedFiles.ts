import { NativeModules } from 'react-native';
import { z } from 'zod';
import { ArtifactRefSchema } from '@scan-to-make/contracts';
import type {
  SavedProject,
  SavedProjects,
} from '@scan-to-make/contracts/saved-project';
import type { CaptureFile } from '../capture/retainedCaptures';
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nozzles = z
  .array(z.literal([0.2, 0.4, 0.6, 0.8]))
  .min(1)
  .max(2);
const receiptSchema = z.strictObject({
  receipt_version: z.literal('1'),
  evidence: z.literal('file-only'),
  dispatch_authorized: z.literal(false),
  artifact: z.strictObject({
    sha256: digest,
    byte_length: integer,
    file_format: z.enum(['3mf', 'gcode']),
  }),
  selection: z.strictObject({
    bambu_model: z.string(),
    plate_index: integer,
    nozzle_diameters: nozzles,
    bed_type: z.string(),
  }),
  inspection: z.strictObject({
    model: z.string(),
    nozzleDiameters: nozzles,
    materials: z.array(z.string().min(1)).min(1).max(256),
    usedFilamentPositions: z.array(integer).min(1).max(256),
    plateInternalPath: z.string().optional(),
    sha256: digest,
    maxNozzleTemperature: z.number().nonnegative(),
    maxBedTemperature: z.number().nonnegative(),
    maxChamberTemperature: z.number().nonnegative(),
    bedType: z.string(),
    selectsAms: z.boolean(),
    nozzleTypes: z.array(z.string()).max(2).optional(),
    nozzleFlows: z.array(z.string()).max(2).optional(),
  }),
});
const PreparedInspectionSchema = z.strictObject({
  receipt: receiptSchema,
  catalogSha256: digest,
  server: z.strictObject({
    name: z.string().max(512),
    version: z.string().max(512),
  }),
});
const PrintSelectionSchema = z
  .strictObject({
    printerId: safeId,
    model: z.string().trim().min(1),
    plateIndex: integer,
    nozzleDiameters: z
      .array(z.literal([0.2, 0.4, 0.6, 0.8]))
      .min(1)
      .max(2),
    bedType: z.enum([
      'textured_plate',
      'cool_plate',
      'engineering_plate',
      'hot_plate',
      'supertack_plate',
    ]),
    materials: z
      .array(
        z.strictObject({
          projectSlot: integer,
          material: z.string().trim().min(1),
          physicalTray: integer,
        }),
      )
      .min(1),
    slicerSettingsSha256: digest,
  })
  .refine(
    s =>
      new Set(s.materials.map(m => m.projectSlot)).size === s.materials.length,
    { message: 'Project filament positions must be unique' },
  );

const productionRef = (mediaType: string, maximum: number) =>
  ArtifactRefSchema.refine(
    a =>
      a.mediaType === mediaType && a.byteLength > 0 && a.byteLength <= maximum,
  );
const ProductionSchema = z.strictObject({
  requestSha256: digest,
  producerIdentity: digest,
  sourceArtifact: productionRef('model/stl', 32 * 1024 * 1024),
  settingsArtifact: productionRef('application/json', 8 * 1024 * 1024),
  manifestArtifact: productionRef('application/json', 1024 * 1024),
  slicer: z.strictObject({
    version: z.string().min(1).max(128),
    binarySha256: digest,
  }),
});
// Field order mirrors the sealed companion record used by its canonical digest.
const JobSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  id: z.uuid(),
  projectId: safeId,
  projectRevision: integer,
  designArtifact: ArtifactRefSchema,
  printableArtifact: ArtifactRefSchema,
  selection: PrintSelectionSchema,
  inspection: PreparedInspectionSchema,
  production: ProductionSchema.optional(),
  sha256: digest,
});
export type PreparedJob = z.infer<typeof JobSchema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export interface PreparedNative {
  context(): Promise<string>;
  hash(text: string): Promise<string>;
  request(options: {
    context: string;
    method: 'GET';
    path: string;
    etag: string;
    artifact?: CaptureFile;
  }): Promise<{
    status: number;
    body: string;
    etag: string;
    file?: CaptureFile;
  }>;
  export(
    file: CaptureFile,
  ): Promise<{ path: string; sha256: string; byteLength: number }>;
  cancel(): Promise<void>;
}
export function preparedNative(): PreparedNative {
  const value = NativeModules.PreparedFileBridge;
  if (!value) throw Error('Inspected files are available on iOS.');
  return value;
}
export async function validatePreparedResponse(
  input: unknown,
  project: SavedProject,
  id: string,
  hash: (text: string) => Promise<string>,
): Promise<PreparedJob> {
  const response = z
    .strictObject({
      jobId: z.uuid(),
      job: JobSchema,
      intent: z.unknown().optional(),
    })
    .parse(input);
  const job = response.job,
    { sha256, ...body } = job;
  if (
    response.jobId !== id ||
    job.id !== id ||
    job.projectId !== project.id ||
    job.projectRevision !== project.revision ||
    !project.acceptedArtifact ||
    !same(job.designArtifact, project.acceptedArtifact.artifact) ||
    (await hash(JSON.stringify(body))) !== sha256
  )
    throw Error('Inspected file does not match the current accepted project.');
  if (
    !['model/3mf', 'text/x.gcode'].includes(job.printableArtifact.mediaType) ||
    job.printableArtifact.byteLength > 64 * 1024 * 1024
  )
    throw Error('Unsupported inspected file.');
  if (
    job.production &&
    (!same(job.production.sourceArtifact, job.designArtifact) ||
      job.production.settingsArtifact.sha256 !==
        job.selection.slicerSettingsSha256 ||
      job.printableArtifact.mediaType !== 'text/x.gcode')
  )
    throw Error(
      'Production evidence does not match the accepted design and retained settings.',
    );
  const r = job.inspection.receipt,
    s = job.selection,
    a = r.inspection;
  const expected = {
    bambu_model: s.model,
    plate_index: s.plateIndex,
    nozzle_diameters: s.nozzleDiameters,
    bed_type: s.bedType,
  };
  const beds = {
    textured_plate: 'textured pei plate',
    cool_plate: 'cool plate',
    engineering_plate: 'engineering plate',
    hot_plate: 'smooth pei plate',
    supertack_plate: 'cool plate supertack',
  };
  if (
    r.artifact.sha256 !== job.printableArtifact.sha256 ||
    a.sha256 !== job.printableArtifact.sha256 ||
    r.artifact.byte_length !== job.printableArtifact.byteLength ||
    r.artifact.file_format !==
      (job.printableArtifact.mediaType === 'model/3mf' ? '3mf' : 'gcode') ||
    !same(r.selection, expected) ||
    a.model !== s.model ||
    a.bedType !== beds[s.bedType] ||
    (s.nozzleDiameters.length === 1
      ? a.nozzleDiameters.some(n => n !== s.nozzleDiameters[0])
      : !same(a.nozzleDiameters, s.nozzleDiameters))
  )
    throw Error('Inspection does not match the file selection.');
  if (
    r.artifact.file_format === '3mf'
      ? a.plateInternalPath !== `Metadata/plate_${s.plateIndex + 1}.gcode`
      : s.plateIndex !== 0 || a.plateInternalPath !== undefined
  )
    throw Error('Inspection plate mismatch.');
  const positions = a.usedFilamentPositions;
  if (
    new Set(positions).size !== positions.length ||
    positions.length !== s.materials.length ||
    positions.some(
      p =>
        !s.materials.some(
          m =>
            m.projectSlot === p &&
            m.material === a.materials[p] &&
            m.physicalTray <= 254 &&
            (m.physicalTray <= 15 || m.physicalTray >= 128),
        ),
    )
  )
    throw Error('Inspection material mismatch.');
  if (
    s.materials.some(m => m.physicalTray === 254) &&
    (s.materials.length !== 1 || a.selectsAms)
  )
    throw Error('Inspection material feed mismatch.');
  return job;
}
export const PreparedSummarySchema = z.strictObject({
  jobId: z.uuid(),
  jobSha256: digest,
  printableArtifact: ArtifactRefSchema,
  model: z.string().min(1).max(1024),
  plateIndex: integer,
});
export type PreparedSummary = z.infer<typeof PreparedSummarySchema>;
const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);
const PageSchema = z.strictObject({
  jobs: z.array(PreparedSummarySchema).max(20),
  nextCursor: CursorSchema.nullable(),
  unreadable: integer,
  requiresVerifiedGet: z.literal(true),
});
export type DiscoveryMode = 'production-v1' | 'legacy';
export type PreparedPage = z.infer<typeof PageSchema> & { mode: DiscoveryMode };
export type ProjectAcknowledgment = { etag: string; snapshot: string };
export function preparedError(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return 'The companion returned an unreadable file record. Try refreshing.';
  // The shared snapshot client predates prepared-file capabilities. Its 403
  // message is capture-specific, although this screen only synchronizes projects.
  if (
    error instanceof Error &&
    error.message ===
      'This connection does not have capture permission. Connect with a capture invitation.'
  )
    return 'This connection cannot synchronize saved projects. Connect with project access, then refresh.';
  const code = (error as { code?: string })?.code;
  if (code === 'cursor-stale')
    return 'The file list changed. Refresh to see the current files.';
  if (
    code === 'pairing-required' ||
    code === 'pairing-changed' ||
    code === 'scope-denied' ||
    code === 'unauthorized' ||
    code === 'forbidden'
  )
    return 'Connect to your companion with permission to read inspected files, then refresh.';
  if (code === 'precondition-failed')
    return 'This project changed. Return to your saved projects and reopen it.';
  if (code === 'busy') return 'Your companion is busy. Try again shortly.';
  if (code === 'discovery-unavailable')
    return 'The companion could not load the file list. Try refreshing shortly.';
  return error instanceof Error
    ? error.message
    : 'The files could not be loaded. Try refreshing.';
}
export class PreparedFilesClient {
  constructor(
    private repo: SavedProjects,
    readonly native: PreparedNative,
    private wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  ) {}
  private async current(id: string, snapshot: string) {
    const r = await this.repo.load(id);
    if (
      r.status !== 'ok' ||
      JSON.stringify(r.project) !== snapshot ||
      !r.project.acceptedArtifact
    )
      throw Error('Project changed. Reopen its current version.');
    return r.project;
  }
  private async get(options: Parameters<PreparedNative['request']>[0]) {
    for (let n = 0; ; n++) {
      const r = await this.native.request(options);
      if (r.status === 429 && n < 2) {
        await this.wait(150 * (n + 1));
        continue;
      }
      if (r.status !== 200 || r.etag !== options.etag) {
        let code =
          r.status === 401
            ? 'unauthorized'
            : r.status === 403
            ? 'forbidden'
            : r.status === 412
            ? 'precondition-failed'
            : r.status === 429
            ? 'busy'
            : 'unavailable';
        try {
          const parsed = JSON.parse(r.body);
          if (typeof parsed?.error?.code === 'string') code = parsed.error.code;
        } catch {
          /* Opaque response still fails closed. */
        }
        throw Object.assign(
          Error(`The inspected file could not be verified (${r.status}).`),
          { code, status: r.status },
        );
      }
      return r;
    }
  }
  async list(
    projectId: string,
    ack: ProjectAcknowledgment,
    cursor?: string,
    mode: DiscoveryMode = 'production-v1',
  ): Promise<PreparedPage> {
    safeId.parse(projectId);
    if (cursor !== undefined) CursorSchema.parse(cursor);
    z.enum(['production-v1', 'legacy']).parse(mode);
    z.string()
      .regex(/^"[a-f0-9]{64}"$/)
      .parse(ack.etag);
    const project = await this.current(projectId, ack.snapshot),
      context = await this.native.context();
    const path = (chosen: DiscoveryMode) =>
      `/v1/saved-projects/${projectId}/prepared-jobs?projectRevision=${
        project.revision
      }&limit=20${chosen === 'production-v1' ? '&productionVersion=1' : ''}${
        cursor ? '&cursor=' + cursor : ''
      }`;
    const request = (chosen: DiscoveryMode) =>
      this.get({ context, method: 'GET', path: path(chosen), etag: ack.etag });
    let response;
    try {
      response = await request(mode);
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      if (
        cursor !== undefined ||
        mode !== 'production-v1' ||
        failure.status !== 400 ||
        failure.code !== 'invalid-request'
      )
        throw error;
      // Older companions reject this exact new query. Downgrade only this first
      // page; the caller retains the resulting mode for every continuation.
      mode = 'legacy';
      response = await request(mode);
    }
    const page = PageSchema.parse(JSON.parse(response.body));
    if (page.nextCursor !== null && page.nextCursor === cursor)
      throw Error('The file list did not advance. Refresh to try again.');
    for (let i = 0; i < page.jobs.length; i++) {
      const item = page.jobs[i];
      if (
        item.jobId !== item.jobId.toLowerCase() ||
        (i > 0 && page.jobs[i - 1].jobId >= item.jobId) ||
        !['model/3mf', 'text/x.gcode'].includes(
          item.printableArtifact.mediaType,
        ) ||
        item.printableArtifact.byteLength > 64 * 1024 * 1024
      )
        throw Error('The companion returned an invalid file list.');
    }
    await this.current(projectId, ack.snapshot);
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
    return { ...page, mode };
  }
  async open(
    projectId: string,
    jobId: string,
    ack: ProjectAcknowledgment,
    expected?: PreparedSummary,
  ) {
    safeId.parse(projectId);
    z.uuid().parse(jobId);
    z.string()
      .regex(/^"[a-f0-9]{64}"$/)
      .parse(ack.etag);
    const project = await this.current(projectId, ack.snapshot),
      context = await this.native.context();
    const path = `/v1/saved-projects/${projectId}/prepared-jobs/${jobId}?projectRevision=${project.revision}`;
    const result = await this.get({
      context,
      method: 'GET',
      path,
      etag: ack.etag,
    });
    const job = await validatePreparedResponse(
      JSON.parse(result.body),
      project,
      jobId,
      text => this.native.hash(text),
    );
    if (
      expected &&
      (expected.jobId !== job.id ||
        expected.jobSha256 !== job.sha256 ||
        !same(expected.printableArtifact, job.printableArtifact) ||
        expected.model !== job.selection.model ||
        expected.plateIndex !== job.selection.plateIndex)
    )
      throw Error('This file changed. Refresh the list and choose it again.');
    await this.current(projectId, ack.snapshot);
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
    return { job, context, path };
  }
  async export(
    projectId: string,
    jobId: string,
    ack: ProjectAcknowledgment,
    expected?: PreparedSummary,
  ) {
    const opened = await this.open(projectId, jobId, ack, expected);
    const result = await this.get({
      context: opened.context,
      method: 'GET',
      path: opened.path.replace('?', '/artifacts/printable?'),
      etag: ack.etag,
      artifact: opened.job.printableArtifact,
    });
    if (!same(result.file, opened.job.printableArtifact))
      throw Error('Downloaded file identity mismatch.');
    await this.current(projectId, ack.snapshot);
    if ((await this.native.context()) !== opened.context)
      throw Error('Companion connection changed.');
    const saved = await this.native.export(opened.job.printableArtifact);
    if (
      saved.sha256 !== opened.job.printableArtifact.sha256 ||
      saved.byteLength !== opened.job.printableArtifact.byteLength
    )
      throw Error('Export identity mismatch.');
    return saved;
  }
}
