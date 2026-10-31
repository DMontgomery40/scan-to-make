import { z } from 'zod';
import {
  DetailStillSchema,
  DetailStillListSchema,
  MAX_DETAIL_STILL_BYTES,
  type DetailStill,
} from '@scan-to-make/contracts/detail-still';
import type { SavedProjects } from '@scan-to-make/contracts/saved-project';
import type {
  CaptureFile,
  ProjectAcknowledgment,
} from '../capture/retainedCaptures';

export type { DetailStill, ProjectAcknowledgment };
export { MAX_DETAIL_STILL_BYTES };
export type DetailStillFile = CaptureFile;
/** A photo chosen in the system picker, kept locally by exact-byte identity. */
export type PickedStillPhoto = CaptureFile & { uri: string };
export type RejectedStillPhoto = {
  reason: 'too-large' | 'unsupported' | 'unreadable';
  byteLength?: number;
};
export type StillPickResult = {
  photos: PickedStillPhoto[];
  rejected: RejectedStillPhoto[];
};

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const uuid = z.uuid();
const etagSchema = z.string().regex(/^"[a-f0-9]{64}"$/);
const stillMedia = ['image/jpeg', 'image/heic', 'image/png'];

type StillRequest = {
  context: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  etag: string;
  source?: CaptureFile;
  artifact?: CaptureFile;
};
type StillResponse = {
  status: number;
  body: string;
  etag: string;
  file?: CaptureFile;
};

/**
 * Native transport for detail-still requests, supplied by the app shell.
 * Mirrors the retained-capture bridge contract: the native side owns
 * pairing credentials, sends `If-Match`, uploads the exact retained local
 * `source` bytes with its media type, and verifies any `artifact` download
 * against its declared SHA-256/length/media type before resolving.
 */
export interface DetailStillNative {
  context(): Promise<string>;
  request(options: StillRequest): Promise<StillResponse>;
  present(file: CaptureFile, share: boolean): Promise<unknown>;
  cancel(): Promise<void>;
  /**
   * Optional local photo picker mirroring the capture bridge: resolves the
   * retained local file identity to pass to `upload` as `source`.
   */
  pickImage?(): Promise<CaptureFile>;
  /**
   * Optional multi-select system photo picker. Chosen photos are retained
   * locally by identity for `upload`; each carries a displayable file URI.
   * Resolves with empty lists when the user cancels.
   */
  pickImages?(limit: number): Promise<StillPickResult>;
  /**
   * Optional display seam: resolves a verified, app-private cached file URI
   * for already-downloaded still bytes, or null when unavailable.
   */
  imageUri?(file: CaptureFile): Promise<string | null>;
}

function failure(status: number, code?: string): never {
  const message =
    status === 401
      ? 'Your companion connection expired or was revoked. Connect again.'
      : status === 403
      ? 'This connection does not have capture permission. Connect with a capture invitation.'
      : code === 'still-limit'
      ? 'This scan already has the maximum number of detail photos. Remove one before adding another.'
      : status === 409 || status === 412
      ? 'The companion has a different version. Your local project is preserved.'
      : status === 413
      ? 'That photo is too large to attach. Choose a smaller one.'
      : status === 415
      ? 'Only JPEG, HEIC or PNG photos can be attached.'
      : status === 422
      ? 'The detail photo could not be verified. Your project is unchanged.'
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
const AMBIGUOUS_UPLOAD =
  'The photo may have been added, but its reply was lost. It will not be retried automatically. Refresh the photo list before adding it again.';
const AMBIGUOUS_DELETE =
  'The photo may have been removed, but its reply was lost. Refresh the photo list to check.';

export class DetailStillsClient {
  constructor(
    private repo: SavedProjects,
    readonly native: DetailStillNative,
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
  ): string {
    return `/v1/saved-projects/${encodeURIComponent(
      projectId,
    )}/captures/${captureId.toLowerCase()}/detail-stills?projectRevision=${revision}`;
  }
  private checkIds(projectId: string, captureId: string, ack: ProjectAcknowledgment) {
    safeId.parse(projectId);
    uuid.parse(captureId);
    etagSchema.parse(ack.etag);
  }
  /** GETs retry an explicit busy response a bounded number of times. */
  private async get(options: StillRequest) {
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
  private binding(
    still: DetailStill,
    projectId: string,
    captureId: string,
    revision: number,
  ) {
    if (
      still.projectId !== projectId ||
      still.captureId !== captureId.toLowerCase() ||
      still.projectRevision !== revision
    )
      throw Error('Detail photo belongs to a different project version.');
  }
  async list(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
  ): Promise<DetailStill[]> {
    this.checkIds(projectId, captureId, ack);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    const r = await this.get({
      context,
      method: 'GET',
      path: this.base(projectId, captureId, project.revision),
      etag: ack.etag,
    });
    const data = z
      .strictObject({ captureId: uuid, stills: DetailStillListSchema })
      .parse(JSON.parse(r.body));
    if (data.captureId !== captureId.toLowerCase())
      throw Error('Detail photos belong to a different scan.');
    for (const still of data.stills)
      this.binding(still, projectId, captureId, project.revision);
    await this.settle(projectId, ack, context);
    return data.stills;
  }
  /**
   * Uploads one close-up photo. Publication on the companion is the commit
   * point, so a lost or 5xx reply is ambiguous: this never retries. List
   * the stills to learn whether the upload landed before trying again.
   */
  async upload(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    source: CaptureFile | PickedStillPhoto,
    label?: string,
  ): Promise<DetailStill> {
    this.checkIds(projectId, captureId, ack);
    // Picked photos may carry a display `uri`; the native upload transport
    // accepts exactly the 3-field exact-byte identity, nothing more.
    const identity: CaptureFile = {
      sha256: source.sha256,
      byteLength: source.byteLength,
      mediaType: source.mediaType,
    };
    if (!stillMedia.includes(identity.mediaType)) failure(415);
    if (identity.byteLength <= 0 || identity.byteLength > MAX_DETAIL_STILL_BYTES)
      failure(413);
    if (label !== undefined)
      DetailStillSchema.shape.label.parse(label);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    const path =
      this.base(projectId, captureId, project.revision) +
      (label !== undefined ? `&label=${encodeURIComponent(label)}` : '');
    let r: StillResponse;
    try {
      r = await this.native.request({
        context,
        method: 'POST',
        path,
        etag: ack.etag,
        source: identity,
      });
    } catch {
      throw Object.assign(Error(AMBIGUOUS_UPLOAD), {
        code: 'ambiguous-upload',
      });
    }
    if (r.status >= 500)
      throw Object.assign(Error(AMBIGUOUS_UPLOAD), {
        code: 'ambiguous-upload',
        status: r.status,
      });
    if (r.status !== 201 || r.etag !== ack.etag)
      failure(r.status, serverCode(r.body));
    const still = z
      .strictObject({ still: DetailStillSchema })
      .parse(JSON.parse(r.body)).still;
    this.binding(still, projectId, captureId, project.revision);
    if (
      still.sha256 !== identity.sha256 ||
      still.byteLength !== identity.byteLength ||
      still.mediaType !== identity.mediaType
    )
      throw Error('Uploaded photo identity mismatch.');
    await this.settle(projectId, ack, context);
    return still;
  }
  async download(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    still: DetailStill,
  ): Promise<CaptureFile> {
    this.checkIds(projectId, captureId, ack);
    const project = await this.current(projectId, ack);
    this.binding(still, projectId, captureId, project.revision);
    const context = await this.native.context();
    const artifact: CaptureFile = {
      sha256: still.sha256,
      byteLength: still.byteLength,
      mediaType: still.mediaType,
    };
    const r = await this.get({
      context,
      method: 'GET',
      path: this.base(projectId, captureId, project.revision).replace(
        '?',
        `/${still.id}?`,
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
      throw Error('Detail photo verification failed.');
    await this.settle(projectId, ack, context);
    return artifact;
  }
  async openFile(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    still: DetailStill,
    share: boolean,
  ) {
    const file = await this.download(projectId, captureId, ack, still);
    return this.native.present(file, share);
  }
  /**
   * Displayable URI for an already-downloaded still, verified natively
   * against the still's exact-byte identity. Null when the transport
   * cannot provide one. Download the still first.
   */
  async imageUri(still: DetailStill): Promise<string | null> {
    if (!this.native.imageUri) return null;
    const uri = await this.native.imageUri({
      sha256: still.sha256,
      byteLength: still.byteLength,
      mediaType: still.mediaType,
    });
    if (uri !== null && (typeof uri !== 'string' || !uri.startsWith('file://')))
      throw Error('Detail photo display path is invalid.');
    return uri;
  }
  /**
   * Deletes one still. Like upload this is never auto-retried; a lost reply
   * is reported as ambiguous and the caller should refresh the list.
   */
  async remove(
    projectId: string,
    captureId: string,
    ack: ProjectAcknowledgment,
    stillId: string,
  ): Promise<void> {
    this.checkIds(projectId, captureId, ack);
    uuid.parse(stillId);
    const project = await this.current(projectId, ack);
    const context = await this.native.context();
    let r: StillResponse;
    try {
      r = await this.native.request({
        context,
        method: 'DELETE',
        path: this.base(projectId, captureId, project.revision).replace(
          '?',
          `/${stillId.toLowerCase()}?`,
        ),
        etag: ack.etag,
      });
    } catch {
      throw Object.assign(Error(AMBIGUOUS_DELETE), {
        code: 'ambiguous-delete',
      });
    }
    if (r.status >= 500)
      throw Object.assign(Error(AMBIGUOUS_DELETE), {
        code: 'ambiguous-delete',
        status: r.status,
      });
    if (r.status !== 200 || r.etag !== ack.etag)
      failure(r.status, serverCode(r.body));
    const data = z
      .strictObject({
        captureId: uuid,
        stillId: uuid,
        deleted: z.literal(true),
      })
      .parse(JSON.parse(r.body));
    if (
      data.captureId !== captureId.toLowerCase() ||
      data.stillId !== stillId.toLowerCase()
    )
      throw Error('A different detail photo was removed.');
    await this.settle(projectId, ack, context);
  }
}
