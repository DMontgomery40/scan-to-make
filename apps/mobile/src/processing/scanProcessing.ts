import { z } from 'zod';
import {
  ScanProcessingJobSchema,
  ScanProcessingRequestSchema,
  ScanArtifactNameSchema,
  SCAN_VIEW_NAMES,
  type ScanProcessingJob,
  type ScanReference,
  type ScanArtifactName,
} from '@scan-to-make/contracts/scan-processing';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import type { CaptureFile } from '../capture/retainedCaptures';
import type { ProjectAcknowledgment } from '../prepared/preparedFiles';

export type { ScanProcessingJob, ScanReference, ScanArtifactName, ProjectAcknowledgment };
export { SCAN_VIEW_NAMES };
export type ScanArtifact = CaptureFile;

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const uuid = z.uuid();
const etagSchema = z.string().regex(/^"[a-f0-9]{64}"$/);

type ProcessingRequest = {
  context: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  etag: string;
  body?: string;
  artifact?: CaptureFile;
};
type ProcessingResponse = {
  status: number;
  body: string;
  etag: string;
  file?: CaptureFile;
};

/**
 * Native transport for scan-processing requests, supplied by the app shell.
 * Mirrors the retained-capture bridge contract: the native side owns
 * pairing credentials, sends `If-Match` and the JSON `body`, and verifies
 * any `artifact` download against its declared SHA-256/length/media type
 * before resolving.
 */
export interface ScanProcessingNative {
  context(): Promise<string>;
  request(options: ProcessingRequest): Promise<ProcessingResponse>;
  present(file: CaptureFile, share: boolean): Promise<unknown>;
  cancel(): Promise<void>;
}

function failure(status: number, code?: string): never {
  const message =
    status === 401
      ? 'Your companion connection expired or was revoked. Connect again.'
      : status === 403
      ? 'This connection does not have capture permission. Connect with a capture invitation.'
      : status === 404
      ? 'That scan job is no longer available on the companion.'
      : status === 409 || status === 412
      ? 'The companion has a different version. Your local project is preserved.'
      : status === 422
      ? 'The scan results could not be verified. Your project is unchanged.'
      : status === 429
      ? 'The companion is busy. Try again shortly.'
      : `The companion could not complete this request (${status}).`;
  throw Object.assign(Error(message), { code: code ?? 'unavailable', status });
}
function serverCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error?.code === 'string'
      ? parsed.error.code
      : undefined;
  } catch {
    return undefined;
  }
}
const AMBIGUOUS_START =
  'The scan job may have started, but its reply was lost. It will not be retried automatically; wait for the companion to finish before starting another.';
const AMBIGUOUS_CANCEL =
  'The cancel may have been received, but its reply was lost. Check the job status to confirm.';

export class ScanProcessingClient {
  constructor(
    private repo: SavedProjects,
    readonly native: ScanProcessingNative,
    private wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  ) {}
  private async current(projectId: string, ack: ProjectAcknowledgment) {
    const r = await this.repo.load(projectId);
    if (r.status !== 'ok' || JSON.stringify(r.project) !== ack.snapshot)
      throw Error('Project changed. Reopen its current version.');
    return r.project;
  }
  private base(
    projectId: string,
    captureId: string,
    revision: number,
    jobId?: string,
  ): string {
    const collection = `/v1/saved-projects/${encodeURIComponent(
      projectId,
    )}/captures/${captureId.toLowerCase()}/scan-processing`;
    return `${jobId ? `${collection}/${jobId.toLowerCase()}` : collection}?projectRevision=${revision}`;
  }
  private checkIds(projectId: string, captureId: string, ack: ProjectAcknowledgment) {
    safeId.parse(projectId);
    uuid.parse(captureId);
    etagSchema.parse(ack.etag);
  }
  /** GETs retry an explicit busy response a bounded number of times. */
  private async get(options: ProcessingRequest) {
    for (let n = 0; ; n++) {
      const r = await this.native.request(options);
      if (r.status === 429 && n < 2) {
        await this.wait(150 * (n + 1));
        continue;
      }
      if (r.status !== 200 || r.etag !== options.etag)
        failure(r.status, serverCode(r.body));
      return r;
    }
  }
  private async settle(
    projectId: string,
    ack: ProjectAcknowledgment,
    context: string,
  ) {
    await this.current(projectId, ack);
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
  }
  private job(
    body: string,
    projectId: string,
    captureId: string,
    revision: number,
    jobId?: string,
  ): ScanProcessingJob {
    const job = z
      .strictObject({ job: ScanProcessingJobSchema })
      .parse(JSON.parse(body)).job;
    if (
      job.projectId !== projectId ||
      job.captureId !== captureId.toLowerCase() ||
      job.projectRevision !== revision ||
      (jobId !== undefined && job.jobId !== jobId.toLowerCase())
    )
      throw Error('Scan job belongs to a different project version.');
    return job;
  }
  /**
   * Starts one preview-only repair/measure/render job, optionally with
   * known-product reference dimensions. The POST is not idempotent and is
   * never auto-retried: a lost or 5xx reply is reported as ambiguous.
   * Persist the returned `jobId` immediately; there is no list endpoint.
   */
  async start(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    reference?: ScanReference,
  ): Promise<ScanProcessingJob> {
    this.checkIds(projectId, captureId, ack);
    const request = ScanProcessingRequestSchema.parse(
      reference === undefined ? {} : { reference },
    );
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    let r: ProcessingResponse;
    try {
      r = await this.native.request({
        context,
        method: 'POST',
        path: this.base(projectId, captureId, project.revision),
        etag: ack.etag,
        body: JSON.stringify(request),
      });
    } catch {
      throw Object.assign(Error(AMBIGUOUS_START), { code: 'ambiguous-start' });
    }
    if (r.status >= 500)
      throw Object.assign(Error(AMBIGUOUS_START), {
        code: 'ambiguous-start',
        status: r.status,
      });
    if (r.status !== 202 || r.etag !== ack.etag)
      failure(r.status, serverCode(r.body));
    const job = this.job(r.body, projectId, captureId, project.revision);
    if (JSON.stringify(job.reference) !== JSON.stringify(request.reference))
      throw Error('Scan job reference mismatch.');
    await this.settle(projectId, ack, context);
    return job;
  }
  /** One status read. Callers poll on their own timer while non-terminal. */
  async status(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
  ): Promise<ScanProcessingJob> {
    this.checkIds(projectId, captureId, ack);
    uuid.parse(jobId);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    const r = await this.get({
      context,
      method: 'GET',
      path: this.base(projectId, captureId, project.revision, jobId),
      etag: ack.etag,
    });
    const job = this.job(r.body, projectId, captureId, project.revision, jobId);
    await this.settle(projectId, ack, context);
    return job;
  }
  async cancel(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    jobId: string,
  ): Promise<ScanProcessingJob> {
    this.checkIds(projectId, captureId, ack);
    uuid.parse(jobId);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    let r: ProcessingResponse;
    try {
      r = await this.native.request({
        context,
        method: 'DELETE',
        path: this.base(projectId, captureId, project.revision, jobId),
        etag: ack.etag,
      });
    } catch {
      throw Object.assign(Error(AMBIGUOUS_CANCEL), {
        code: 'ambiguous-cancel',
      });
    }
    if (r.status >= 500)
      throw Object.assign(Error(AMBIGUOUS_CANCEL), {
        code: 'ambiguous-cancel',
        status: r.status,
      });
    if (r.status !== 200 || r.etag !== ack.etag)
      failure(r.status, serverCode(r.body));
    const job = this.job(r.body, projectId, captureId, project.revision, jobId);
    await this.settle(projectId, ack, context);
    return job;
  }
  /**
   * Downloads one retained output of a succeeded job (`repaired.stl`,
   * `repaired.obj`, `report.json`, or one of `SCAN_VIEW_NAMES`) and
   * verifies it against the identity sealed in the job record.
   */
  async downloadArtifact(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
  ): Promise<CaptureFile> {
    this.checkIds(projectId, captureId, ack);
    ScanArtifactNameSchema.parse(name);
    const project = await this.current(projectId, ack);
    if (
      job.projectId !== projectId ||
      job.captureId !== captureId.toLowerCase() ||
      job.projectRevision !== project.revision
    )
      throw Error('Scan job belongs to a different project version.');
    const artifact = job.artifacts?.[name];
    if (!artifact) throw Error('That scan output is not available yet.');
    const context = await this.native.context();
    const r = await this.get({
      context,
      method: 'GET',
      path: this.base(projectId, captureId, project.revision, job.jobId).replace(
        '?',
        `/artifacts/${name}?`,
      ),
      etag: ack.etag,
      artifact,
    });
    if (
      !r.file ||
      r.file.sha256 !== artifact.sha256 ||
      r.file.byteLength !== artifact.byteLength ||
      r.file.mediaType !== artifact.mediaType
    )
      throw Error('Scan output verification failed.');
    await this.settle(projectId, ack, context);
    return artifact;
  }
  async openArtifact(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    job: ScanProcessingJob,
    name: ScanArtifactName,
    share: boolean,
  ) {
    const file = await this.downloadArtifact(
      projectId,
      captureId,
      ack,
      job,
      name,
    );
    return this.native.present(file, share);
  }
}
