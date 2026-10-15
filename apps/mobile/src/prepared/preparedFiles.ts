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

const JobSchema = z.strictObject({
  formatVersion: z.literal('0.1.0'),
  id: z.uuid(),
  projectId: safeId,
  projectRevision: integer,
  designArtifact: ArtifactRefSchema,
  printableArtifact: ArtifactRefSchema,
  selection: PrintSelectionSchema,
  inspection: PreparedInspectionSchema,
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
      if (r.status !== 200 || r.etag !== options.etag)
        throw Error(`Inspected file unavailable (${r.status}).`);
      return r;
    }
  }
  async open(
    projectId: string,
    jobId: string,
    ack: { etag: string; snapshot: string },
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
    await this.current(projectId, ack.snapshot);
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
    return { job, context, path };
  }
  async export(
    projectId: string,
    jobId: string,
    ack: { etag: string; snapshot: string },
  ) {
    const opened = await this.open(projectId, jobId, ack);
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
