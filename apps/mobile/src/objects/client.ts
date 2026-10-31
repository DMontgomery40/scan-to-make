import type { ObjectsNative } from './native';
import type { StmObject } from './types';

export const PHOTOS_PER_SCAN = 24;

export type ObjectsErrorKind =
  | 'pairing'
  | 'unreachable'
  | 'conflict'
  | 'not-found'
  | 'not-set-up'
  | 'nothing-sent'
  | 'cancelled'
  | 'failed';

const MESSAGES: Record<ObjectsErrorKind, string> = {
  pairing: 'Connect to your Mac again.',
  unreachable:
    "Your Mac isn't answering. Check it's on and awake, then try again.",
  conflict: 'Wait until the current step finishes.',
  'not-found': 'This is no longer on your Mac.',
  'not-set-up':
    "Your Mac isn't ready to make things yet. Open Scan to Make on your Mac.",
  'nothing-sent': "The scan didn't save any files to send. Scan it again.",
  cancelled: 'Cancelled.',
  failed: 'Something went wrong talking to your Mac. Try again.',
};

/** One sentence the screen can show as is. */
export class ObjectsError extends Error {
  constructor(readonly kind: ObjectsErrorKind, message = MESSAGES[kind]) {
    super(message);
    this.name = 'ObjectsError';
  }
}

function fromNative(error: unknown): ObjectsError {
  if (error instanceof ObjectsError) return error;
  const code = (error as { code?: unknown })?.code;
  if (
    code === 'pairing-required' ||
    code === 'pairing-changed' ||
    code === 'certificate-changed' ||
    code === 'scope-denied'
  )
    return new ObjectsError('pairing');
  if (code === 'cancelled') return new ObjectsError('cancelled');
  if (code === 'busy')
    return new ObjectsError(
      'conflict',
      'Wait until the current upload finishes.',
    );
  if (
    typeof code === 'string' &&
    /offline|timed-out|unreachable|network|cannot-connect|connection/.test(code)
  )
    return new ObjectsError('unreachable');
  const message = (error as { message?: unknown })?.message;
  return new ObjectsError(
    'failed',
    typeof message === 'string' && message ? message : undefined,
  );
}

export class ObjectsClient {
  constructor(private readonly native: ObjectsNative) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
  ): Promise<T> {
    let reply: { status: number; body: string };
    try {
      reply = await this.native.call(
        json === undefined ? { method, path } : { method, path, json },
      );
    } catch (error) {
      throw fromNative(error);
    }
    let body: { error?: { code?: string; message?: string } } & Record<
      string,
      unknown
    > = {};
    try {
      body = reply.body ? JSON.parse(reply.body) : {};
    } catch {
      throw new ObjectsError('failed');
    }
    if (reply.status >= 200 && reply.status < 300) return body as T;
    if (reply.status === 401 || reply.status === 403)
      throw new ObjectsError('pairing');
    if (reply.status === 404)
      throw new ObjectsError(
        path === '/v1/objects' ? 'not-set-up' : 'not-found',
      );
    if (reply.status === 409)
      throw new ObjectsError('conflict', body.error?.message || undefined);
    throw new ObjectsError('failed');
  }
  private async object(method: 'GET' | 'POST', path: string, json?: unknown) {
    return (await this.request<{ object: StmObject }>(method, path, json))
      .object;
  }

  async list() {
    return (await this.request<{ objects: StmObject[] }>('GET', '/v1/objects'))
      .objects;
  }
  get(id: string) {
    return this.object('GET', `/v1/objects/${id}`);
  }
  create(instructions: string) {
    const text = instructions.trim();
    return this.object('POST', '/v1/objects', text ? { instructions } : {});
  }
  start(id: string) {
    return this.object('POST', `/v1/objects/${id}/start`);
  }
  correct(id: string, note: string) {
    return this.object('POST', `/v1/objects/${id}/corrections`, { note });
  }
  bestGuess(id: string) {
    return this.object('POST', `/v1/objects/${id}/closeup`, {
      bestGuess: true,
    });
  }
  /** After close-ups were added: run the touch-up again with them. */
  sendCloseups(id: string) {
    return this.object('POST', `/v1/objects/${id}/closeup`, {
      bestGuess: false,
    });
  }
  print(id: string) {
    return this.object('POST', `/v1/objects/${id}/print`);
  }
  plateClear(id: string) {
    return this.object('POST', `/v1/objects/${id}/plate`, { clear: true });
  }

  /** Sends the finished scan and its own photos, then starts the touch-up. */
  async sendCapture(id: string, runID: string) {
    let sent: { scanSent: boolean; photosSent: number };
    try {
      sent = await this.native.sendCapture({
        objectId: id,
        runID,
        maxPhotos: PHOTOS_PER_SCAN,
      });
    } catch (error) {
      throw fromNative(error);
    }
    if (!sent.scanSent && sent.photosSent === 0)
      throw new ObjectsError('nothing-sent');
    return this.start(id);
  }
  async pickPhotos(id: string, limit: number) {
    try {
      return (await this.native.pickPhotos({ objectId: id, limit })).photosSent;
    } catch (error) {
      throw fromNative(error);
    }
  }
  async takePhoto(id: string) {
    try {
      return (await this.native.takePhoto({ objectId: id })).photosSent;
    } catch (error) {
      throw fromNative(error);
    }
  }
  async renderUri(object: StmObject, render: string) {
    const name = `renders/${render.split('/').pop()}`;
    try {
      return (
        await this.native.download({
          objectId: object.id,
          name,
          version: object.updatedAtMs,
        })
      ).uri;
    } catch (error) {
      throw fromNative(error);
    }
  }
  async showModel(object: StmObject) {
    try {
      await this.native.showModel({
        objectId: object.id,
        version: object.updatedAtMs,
      });
    } catch (error) {
      throw fromNative(error);
    }
  }
}
