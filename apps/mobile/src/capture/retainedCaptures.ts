import { NativeModules } from 'react-native';
import {
  CaptureBindingSchema,
  type CaptureBinding,
} from '@scan-to-make/contracts/capture';
import {
  SavedProjectSchema,
  type SavedProjects,
} from '@scan-to-make/contracts/saved-project';
export type CaptureFile = {
  sha256: string;
  byteLength: number;
  mediaType: string;
};
export type CaptureDestination = {
  projectId: string;
  revision: number;
  snapshot: string;
  context: string | null;
};
export type RetainedCapture = { captureId: string; binding: CaptureBinding };
/** The companion's acknowledgment of the exact project bytes it holds. */
export type ProjectAcknowledgment = { etag: string; snapshot: string };
export type CaptureState = {
  etag?: string;
  snapshot?: string;
  captures: RetainedCapture[];
  pending?: { revision: number; source: CaptureFile };
  // Imports whose reply was lost and that the person chose to move past.
  // Their bytes may be on the companion, so sending them again needs a yes.
  unconfirmed?: { revision: number; source: CaptureFile }[];
};
type Request = {
  context: string;
  method: 'GET' | 'PUT' | 'POST';
  path: string;
  body?: string;
  etag?: string;
  create?: boolean;
  source?: CaptureFile;
  artifact?: CaptureFile;
};
type Response = {
  status: number;
  body: string;
  etag: string;
  file?: CaptureFile;
};
export interface CaptureNative {
  context(): Promise<string>;
  read(key: string): Promise<string | null>;
  write(key: string, body: string): Promise<void>;
  request(options: Request): Promise<Response>;
  pick(): Promise<CaptureFile>;
  adoptNativeOutput?(runID: string): Promise<CaptureFile>;
  present(file: CaptureFile, share: boolean): Promise<unknown>;
  cancel(): Promise<void>;
}
export function captureNative(): CaptureNative {
  const value = NativeModules.RetainedCaptureBridge;
  if (!value) throw Error('Capture files are available in the iOS app.');
  return value;
}
function failure(status: number): never {
  throw Error(
    status === 401
      ? 'Your companion connection expired or was revoked. Connect again.'
      : status === 403
      ? 'This connection does not have capture permission. Connect with a capture invitation.'
      : status === 409 || status === 412
      ? 'The companion has a different version. Your local project is preserved.'
      : status === 429
      ? 'The companion is busy. Try again shortly.'
      : status === 422
      ? 'The capture could not be verified. Your project is unchanged.'
      : `The companion could not complete this request (${status}).`,
  );
}
const sameFile = (a: CaptureFile, b: CaptureFile) =>
  a.sha256 === b.sha256 &&
  a.byteLength === b.byteLength &&
  a.mediaType === b.mediaType;
/** The capture already holding these bytes for this project version, if any. */
export function retainedIndex(
  state: CaptureState,
  revision: number,
  file: CaptureFile,
) {
  return state.captures.findIndex(
    c =>
      c.binding.projectRevision === revision &&
      sameFile(c.binding.capture.original, file),
  );
}
function etag(value: string) {
  if (!/^"[a-f0-9]{64}"$/.test(value))
    throw Error('Invalid project acknowledgment.');
  return value;
}
function retained(body: string, id: string, revision: number): RetainedCapture {
  const data = JSON.parse(body);
  const binding = CaptureBindingSchema.parse(data.binding);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.captureId) ||
    binding.projectId !== id ||
    binding.projectRevision !== revision
  )
    throw Error('Capture belongs to a different project version.');
  return { captureId: data.captureId, binding };
}
// The capture record is one value per pairing, so every client on the same
// bridge takes turns changing it, and only one import runs at a time.
const turns = new WeakMap<object, Promise<unknown>>();
const importing = new WeakSet<object>();
function inTurn<T>(native: object, task: () => Promise<T>): Promise<T> {
  const run = (turns.get(native) ?? Promise.resolve()).then(task);
  turns.set(
    native,
    run.catch(() => {}),
  );
  return run;
}
export class CaptureClient {
  constructor(
    private repo: SavedProjects,
    readonly native: CaptureNative,
    private wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  ) {}
  private async load(id: string) {
    const r = await this.repo.load(id);
    if (r.status !== 'ok')
      throw Error('The saved project could not be opened.');
    return r.project;
  }
  private key(context: string, id: string) {
    return JSON.stringify([context.split('|')[0], id]);
  }
  private async read(context: string, id: string): Promise<CaptureState> {
    const bytes =
      (await this.native.read(this.key(context, id))) ??
      (await this.native.read(JSON.stringify([context, id])));
    if (bytes == null) return { captures: [] };
    const s = JSON.parse(bytes) as CaptureState;
    if (
      !Array.isArray(s.captures) ||
      s.captures.length > 1000 ||
      (s.unconfirmed !== undefined && !Array.isArray(s.unconfirmed))
    )
      throw Error('Saved capture history could not be read.');
    for (const c of s.captures)
      retained(JSON.stringify(c), id, c.binding.projectRevision);
    if (s.etag) etag(s.etag);
    if (s.snapshot) SavedProjectSchema.parse(JSON.parse(s.snapshot));
    return s;
  }
  private async save(context: string, id: string, state: CaptureState) {
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
    await this.native.write(this.key(context, id), JSON.stringify(state));
  }
  async state(id: string) {
    return this.read(await this.native.context(), id);
  }
  private async request(options: Request) {
    for (let n = 0; ; n++) {
      const r = await this.native.request(options);
      if (r.status !== 429 || options.method !== 'GET' || n === 2) return r;
      await this.wait(150 * (n + 1));
    }
  }
  async sync(id: string, expected?: CaptureDestination) {
    return inTurn(this.native, () => this.syncNow(id, expected));
  }
  private async syncNow(id: string, expected?: CaptureDestination) {
    const context = await this.native.context();
    const project = await this.load(id);
    const snapshot = JSON.stringify(project);
    if (expected)
      this.assertDestination(
        { projectId: id, revision: project.revision, snapshot, context },
        expected,
      );
    const state = await this.read(context, id);
    const path = `/v1/saved-projects/${encodeURIComponent(id)}`;
    if (!state.etag) {
      const existing = await this.request({ context, method: 'GET', path });
      if (existing.status === 200) {
        if (existing.body !== snapshot) failure(409);
        state.etag = etag(existing.etag);
        state.snapshot = existing.body;
        await this.save(context, id, state);
        return state;
      }
      if (existing.status !== 404) failure(existing.status);
    }
    const response = await this.request({
      context,
      method: 'PUT',
      path,
      body: snapshot,
      etag: state.etag,
      create: !state.etag,
    });
    if (response.status !== 200 && response.status !== 201)
      failure(response.status);
    if (response.body !== snapshot)
      throw Error('Companion acknowledged different project bytes.');
    state.etag = etag(response.etag);
    state.snapshot = snapshot;
    await this.save(context, id, state);
    return state;
  }
  async destination(
    id: string,
    allowUnpaired = false,
  ): Promise<CaptureDestination> {
    const project = await this.load(id);
    const context = await this.native.context().catch(error => {
      if (allowUnpaired) return null;
      throw error;
    });
    return {
      projectId: id,
      revision: project.revision,
      snapshot: JSON.stringify(project),
      context,
    };
  }
  private async checkDestination(id: string, expected: CaptureDestination) {
    this.assertDestination(await this.destination(id), expected);
  }
  private assertDestination(
    current: CaptureDestination,
    expected: CaptureDestination,
  ) {
    if (
      current.projectId !== expected.projectId ||
      current.revision !== expected.revision ||
      current.snapshot !== expected.snapshot ||
      current.context !== expected.context
    ) {
      throw Error(
        'The capture destination changed. Your local scan is kept. Choose the current destination explicitly before adding it.',
      );
    }
  }
  /**
   * Each import creates a new capture on the companion, so one runs at a time
   * and bytes it already holds for this project version are never re-sent.
   * `again` sends bytes whose earlier upload went unconfirmed.
   */
  async import(
    id: string,
    source: CaptureFile,
    expected?: CaptureDestination,
    again = false,
  ) {
    if (importing.has(this.native))
      throw Error('An import is already running. Wait for it to finish.');
    importing.add(this.native);
    try {
      return await inTurn(this.native, () =>
        this.importOnce(id, source, expected, again),
      );
    } finally {
      importing.delete(this.native);
    }
  }
  private async importOnce(
    id: string,
    source: CaptureFile,
    expected: CaptureDestination | undefined,
    again: boolean,
  ) {
    if (expected) await this.checkDestination(id, expected);
    const context = await this.native.context();
    const before = await this.read(context, id);
    const revision = (await this.load(id)).revision;
    const held = retainedIndex(before, revision, source);
    if (held >= 0) return before.captures[held];
    if (before.pending)
      throw Error(
        'An earlier import is unconfirmed. Review it before starting another.',
      );
    if (
      !again &&
      before.unconfirmed?.some(
        u => u.revision === revision && sameFile(u.source, source),
      )
    )
      throw Object.assign(
        Error(
          'An earlier upload of this scan may already be on your companion. Adding it again could make a second copy.',
        ),
        { code: 'maybe-imported' },
      );
    const state = await this.syncNow(id, expected);
    if (expected) await this.checkDestination(id, expected);
    const project = await this.load(id);
    if (state.snapshot !== JSON.stringify(project))
      throw Error(
        'Your project changed during sync. Sync the latest version first.',
      );
    state.pending = { revision: project.revision, source };
    await this.save(context, id, state);
    if (expected) {
      try {
        await this.checkDestination(id, expected);
      } catch (error) {
        // No POST has started. Clear only against the same pairing; otherwise retain uncertainty.
        delete state.pending;
        await this.save(context, id, state).catch(() => {});
        throw error;
      }
    }
    let response: Response;
    try {
      response = await this.request({
        context,
        method: 'POST',
        path: `/v1/saved-projects/${id}/captures?projectRevision=${project.revision}`,
        etag: state.etag,
        source,
      });
    } catch {
      throw Error(
        'The import may have finished, but its reply was lost. It will not be retried automatically.',
      );
    }
    if (response.status !== 201) {
      // Explicit rejection is safe to clear; server errors can follow publication.
      if (
        [400, 401, 403, 404, 409, 412, 413, 415, 422, 428, 429].includes(
          response.status,
        )
      ) {
        delete state.pending;
        await this.save(context, id, state);
      }
      failure(response.status);
    }
    const capture = retained(response.body, id, project.revision);
    if (
      JSON.stringify(capture.binding.capture.original) !==
      JSON.stringify(source)
    ) {
      const a = capture.binding.capture.original;
      if (
        a.sha256 !== source.sha256 ||
        a.byteLength !== source.byteLength ||
        a.mediaType !== source.mediaType
      )
        throw Error('Imported source identity mismatch.');
    }
    state.captures.push(capture);
    delete state.pending;
    // These bytes are now held, so their unconfirmed upload needs no question.
    state.unconfirmed = state.unconfirmed?.filter(
      u => !(u.revision === project.revision && sameFile(u.source, source)),
    );
    if (!state.unconfirmed?.length) delete state.unconfirmed;
    await this.save(context, id, state);
    return capture;
  }
  async acknowledgeUnknown(id: string) {
    return inTurn(this.native, async () => {
      const context = await this.native.context();
      const s = await this.read(context, id);
      const p = s.pending;
      // Kept until those bytes are held as a capture; each file once.
      if (
        p &&
        !s.unconfirmed?.some(
          u => u.revision === p.revision && sameFile(u.source, p.source),
        )
      )
        s.unconfirmed = [...(s.unconfirmed ?? []), p];
      delete s.pending;
      await this.save(context, id, s);
    });
  }
  async reopen(id: string, capture: RetainedCapture) {
    const context = await this.native.context();
    const s = await this.read(context, id);
    const p = await this.load(id);
    if (
      s.snapshot !== JSON.stringify(p) ||
      capture.binding.projectRevision !== p.revision
    )
      throw Error(
        'This capture belongs to an earlier project version. Your local changes are preserved.',
      );
    const path = `/v1/saved-projects/${id}/captures/${capture.captureId}?projectRevision=${p.revision}`;
    const r = await this.request({
      context,
      method: 'GET',
      path,
      etag: s.etag,
    });
    if (r.status !== 200) failure(r.status);
    const current = retained(r.body, id, p.revision);
    if (JSON.stringify(current) !== JSON.stringify(capture))
      throw Error('Retained capture metadata changed.');
    return current;
  }
  async openFile(
    id: string,
    capture: RetainedCapture,
    kind: 'original' | 'derived' | 'report',
    share: boolean,
  ) {
    await this.reopen(id, capture);
    const context = await this.native.context();
    const s = await this.read(context, id);
    const artifact =
      capture.binding.capture[kind === 'report' ? 'conversionReport' : kind];
    const r = await this.request({
      context,
      method: 'GET',
      path: `/v1/saved-projects/${id}/captures/${capture.captureId}/artifacts/${kind}?projectRevision=${capture.binding.projectRevision}`,
      etag: s.etag,
      artifact,
    });
    if (r.status !== 200) failure(r.status);
    if (
      !r.file ||
      r.file.sha256 !== artifact.sha256 ||
      r.file.byteLength !== artifact.byteLength ||
      r.file.mediaType !== artifact.mediaType
    )
      throw Error('Capture file verification failed.');
    const latest = await this.load(id);
    if (JSON.stringify(latest) !== s.snapshot)
      throw Error('Your project changed. Reopen its current version.');
    if ((await this.native.context()) !== context)
      throw Error('Companion connection changed.');
    return this.native.present(artifact, share);
  }
}
