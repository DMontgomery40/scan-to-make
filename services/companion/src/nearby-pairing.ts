import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PHONE_SCOPES } from '@scan-to-make/contracts/device-auth';
import {
  NEARBY_MAX_SESSIONS,
  NEARBY_PICKUP_MS,
  NEARBY_RESULT_WAIT_MS,
  NEARBY_SESSION_MS,
  NearbyKeyRequestSchema,
  NearbyStartRequestSchema,
  nearbyCodeFromDigest,
  nearbyCodeInput,
  nearbyCommitInput,
  type NearbyRequest,
  type NearbyResultResponse,
  type NearbyStartResponse,
} from '@scan-to-make/contracts/nearby-pairing';
import { RemoteAuthFailure, type RemoteAuthStore } from './remote-auth.js';

/** A request body that does not match the contract (HTTP 400). */
export class NearbyInputError extends Error {}

interface Session {
  id: string;
  deviceName: string;
  commit: Buffer;
  nonce: Buffer;
  expiresAt: number;
  key?: Buffer;
  code?: string;
  answering?: boolean;
  outcome?: { status: 'denied' } | { status: 'allowed'; link: string };
  waiters: Set<() => void>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/**
 * Nearby pairing sessions (MAC-5; the protocol is in @scan-to-make/contracts/nearby-pairing).
 * Sessions live in memory only: each lasts two minutes, and a restart simply ends them.
 *
 * Allow mints an ordinary one-time pairing code through the auth store and hands its v2
 * link to the phone that revealed the session's key, so a nearby phone ends at the same
 * `/v1/pair` exchange, limits and credential as one that scanned the QR.
 */
export class NearbyPairing {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  private readonly now: () => number;
  private readonly publicKey: Buffer;

  constructor(
    private readonly options: {
      auth: RemoteAuthStore;
      login: string;
      /** SHA-256 of this server's TLS SubjectPublicKeyInfo, hex: S in the code, `k=` in the link. */
      publicKeySha256: string;
      /** The live v2 address list and the Mac's name, read at Allow. */
      link: () => { addresses: string[]; name?: string };
      now?: () => number;
    }
  ) {
    if (!/^[a-f0-9]{64}$/.test(options.publicKeySha256)) throw new Error('Nearby pairing requires the public-key pin');
    this.publicKey = Buffer.from(options.publicKeySha256, 'hex');
    this.now = options.now ?? Date.now;
  }

  private wake(session: Session) {
    for (const waiter of [...session.waiters]) waiter();
  }

  private sweep() {
    const now = this.now();
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        this.wake(session);
      }
  }

  private open(input: unknown, revealed: boolean) {
    const parsed = NearbyKeyRequestSchema.safeParse(input);
    if (!parsed.success) throw new NearbyInputError();
    this.sweep();
    const session = this.sessions.get(parsed.data.session);
    if (!session || this.closed || Boolean(session.key) !== revealed) throw new RemoteAuthFailure('unauthorized');
    return { session, key: Buffer.from(parsed.data.key, 'base64url') };
  }

  /** Step 1: the phone's commit. The nonce is made here, after the commit has arrived. */
  start(input: unknown): NearbyStartResponse {
    const parsed = NearbyStartRequestSchema.safeParse(input);
    if (!parsed.success) throw new NearbyInputError();
    this.sweep();
    if (this.closed || this.sessions.size >= NEARBY_MAX_SESSIONS) throw new RemoteAuthFailure('rate-limited');
    const session: Session = {
      id: randomUUID(),
      deviceName: parsed.data.deviceName,
      commit: Buffer.from(parsed.data.commit, 'base64url'),
      nonce: randomBytes(32),
      expiresAt: this.now() + NEARBY_SESSION_MS,
      waiters: new Set(),
    };
    this.sessions.set(session.id, session);
    return { session: session.id, nonce: session.nonce.toString('base64url'), expiresAt: session.expiresAt };
  }

  /** Step 2: the phone reveals its key. A key that does not open the commit ends the session. */
  reveal(input: unknown) {
    const { session, key } = this.open(input, false);
    if (!same(sha256(nearbyCommitInput(key)), session.commit)) {
      this.sessions.delete(session.id);
      throw new RemoteAuthFailure('unauthorized');
    }
    session.key = key;
    session.code = nearbyCodeFromDigest(sha256(nearbyCodeInput(this.publicKey, key, session.nonce)));
    return { status: 'waiting' as const, expiresAt: session.expiresAt };
  }

  /**
   * Step 3: the phone waits for the Mac's answer, at most NEARBY_RESULT_WAIT_MS per request.
   * The answer goes only to the holder of the key, and stays there for NEARBY_PICKUP_MS:
   * a wait the phone has already given up on (a dropped connection, a retry) must not
   * take it away from the request that is still listening. Allow itself happens once.
   */
  async result(input: unknown, signal?: AbortSignal): Promise<NearbyResultResponse> {
    const { session, key } = this.open(input, true);
    if (!same(key, session.key!)) {
      this.sessions.delete(session.id);
      throw new RemoteAuthFailure('unauthorized');
    }
    if (!session.outcome) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          session.waiters.delete(done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Math.min(NEARBY_RESULT_WAIT_MS, session.expiresAt - this.now())));
        session.waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
      this.sweep();
    }
    if (this.sessions.get(session.id) !== session || this.closed) throw new RemoteAuthFailure('unauthorized');
    if (!session.outcome) return { status: 'waiting', expiresAt: session.expiresAt };
    return session.outcome;
  }

  /** The requests waiting for Allow on the Mac: revealed, unanswered and unexpired. */
  pending(): NearbyRequest[] {
    this.sweep();
    return [...this.sessions.values()]
      .filter((s) => s.code && !s.outcome && !s.answering)
      .map((s) => ({ id: s.id, deviceName: s.deviceName, code: s.code!, expiresAt: s.expiresAt }));
  }

  /**
   * Allow or deny one request. Allow binds only that session: it mints one pairing code,
   * whose link only that session's key can collect. False when the request is no longer pending.
   */
  async answer(id: string, allow: boolean) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session || !session.code || session.outcome || session.answering || this.closed) return false;
    let outcome: Session['outcome'] = { status: 'denied' };
    if (allow) {
      session.answering = true;
      try {
        const { addresses, name } = this.options.link();
        const invitation = await this.options.auth.createPairing(this.options.login, PHONE_SCOPES, {
          addresses,
          publicKeySha256: this.options.publicKeySha256,
          ...(name ? { name } : {}),
        });
        outcome = { status: 'allowed', link: invitation.qrPayload };
      } finally {
        session.answering = false;
      }
    }
    if (this.sessions.get(id) !== session || this.closed) return false;
    session.outcome = outcome;
    session.expiresAt = this.now() + NEARBY_PICKUP_MS;
    this.wake(session);
    return true;
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) this.wake(session);
    this.sessions.clear();
  }
}
