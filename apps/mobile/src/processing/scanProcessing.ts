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
import type {
  CaptureFile,
  ProjectAcknowledgment,
} from '../capture/retainedCaptures';

export type {
  ScanProcessingJob,
  ScanReference,
  ScanArtifactName,
  ProjectAcknowledgment,
};
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
  /**
   * Optional display seam: resolves a verified, app-private cached file URI
   * for already-downloaded image bytes, or null when unavailable.
   */
  imageUri?(file: CaptureFile): Promise<string | null>;
  /** Text of a verified, already-downloaded JSON artifact. */
  readJson?(file: CaptureFile): Promise<string>;
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
    return `${
      jobId ? `${collection}/${jobId.toLowerCase()}` : collection
    }?projectRevision=${revision}`;
  }
  private checkIds(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ) {
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
  private validate(
    job: ScanProcessingJob,
    projectId: string,
    captureId: string,
    jobId?: string,
  ): ScanProcessingJob {
    // `projectRevision` is the revision resolved when the job was enqueued,
    // so retained jobs legitimately differ from the current revision after
    // a project edit; only the project/capture/job identity is checked.
    if (
      job.projectId !== projectId ||
      job.captureId !== captureId.toLowerCase() ||
      (jobId !== undefined && job.jobId !== jobId.toLowerCase())
    )
      throw Error('Scan job belongs to a different project version.');
    return job;
  }
  private job(
    body: string,
    projectId: string,
    captureId: string,
    jobId?: string,
  ): ScanProcessingJob {
    const job = z
      .strictObject({ job: ScanProcessingJobSchema })
      .parse(JSON.parse(body)).job;
    return this.validate(job, projectId, captureId, jobId);
  }
  /**
   * Starts one preview-only repair/measure/render job, optionally with
   * known-product reference dimensions. The POST is not idempotent and is
   * never auto-retried: a lost or 5xx reply is reported as ambiguous.
   * Persist the returned `jobId` immediately so polling can resume; after a
   * relaunch, `listJobs` recovers every retained job for the capture.
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
    const job = this.job(r.body, projectId, captureId);
    if (JSON.stringify(job.reference) !== JSON.stringify(request.reference))
      throw Error('Scan job reference mismatch.');
    await this.settle(projectId, ack, context);
    return job;
  }
  /**
   * Every retained job for this capture, including jobs pinned at earlier
   * project revisions, in ascending job-id order (use `createdAtMs` for
   * start order). This is the relaunch recovery path: a finished
   * check can be reopened without the app having kept its job id.
   * Older companions without the listing route fail with
   * `code: 'not-available'` so callers can fall back to a kept id.
   */
  async listJobs(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<ScanProcessingJob[]> {
    this.checkIds(projectId, captureId, ack);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    let r: ProcessingResponse;
    try {
      r = await this.get({
        context,
        method: 'GET',
        path: this.base(projectId, captureId, project.revision),
        etag: ack.etag,
      });
    } catch (error) {
      if ((error as { status?: number })?.status === 405)
        throw Object.assign(
          Error('This companion cannot list earlier scan checks.'),
          { code: 'not-available', status: 405 },
        );
      throw error;
    }
    const jobs = z
      .strictObject({ jobs: z.array(ScanProcessingJobSchema) })
      .parse(JSON.parse(r.body)).jobs;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      this.validate(job, projectId, captureId);
      if (
        job.jobId !== job.jobId.toLowerCase() ||
        (i > 0 && jobs[i - 1]!.jobId >= job.jobId)
      )
        throw Error('The companion returned an invalid scan job list.');
    }
    await this.settle(projectId, ack, context);
    return jobs;
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
    const job = this.job(r.body, projectId, captureId, jobId);
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
    const job = this.job(r.body, projectId, captureId, jobId);
    await this.settle(projectId, ack, context);
    return job;
  }
  /**
   * Downloads an output listed in the current job's artifact manifest and
   * verifies its sealed identity. Advice can be available during correction
   * or after failure; final geometry is published only when the job succeeds.
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
    // Like status and listing: a retained job keeps the revision it was
    // enqueued at, so only its project/capture identity is checked here.
    if (job.projectId !== projectId || job.captureId !== captureId.toLowerCase())
      throw Error('Scan job belongs to a different project version.');
    const artifact = job.artifacts?.[name];
    if (!artifact) throw Error('That scan output is not available yet.');
    const context = await this.native.context();
    const r = await this.get({
      context,
      method: 'GET',
      path: this.base(
        projectId,
        captureId,
        project.revision,
        job.jobId,
      ).replace('?', `/artifacts/${name}?`),
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
  /**
   * Displayable URI for an already-downloaded PNG view, verified natively
   * against the file identity. Null when the transport cannot provide one
   * or the file is not a PNG view.
   */
  async imageUri(file: CaptureFile): Promise<string | null> {
    if (file.mediaType !== 'image/png' || !this.native.imageUri) return null;
    const uri = await this.native.imageUri(file);
    if (uri !== null && (typeof uri !== 'string' || !uri.startsWith('file://')))
      throw Error('Scan view display path is invalid.');
    return uri;
  }
}
