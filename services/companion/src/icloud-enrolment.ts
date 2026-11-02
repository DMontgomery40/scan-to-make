import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

/** PRD §5.10: an enrolment token lives 10 minutes and is replaced every 5, so a published one is always good for 5 more. */
export const ENROLMENT_TOKEN_LIFETIME_MS = 10 * 60_000;
export const ENROLMENT_TOKEN_REPLACE_MS = 5 * 60_000;

const digest = (token: string) => createHash('sha256').update(token).digest();

/**
 * The tokens the Mac app publishes to the owner's private CloudKit database so their phone can
 * enrol without a QR code. Single use; kept in memory only, so a restarted companion needs the
 * Mac app's next publish (at most 5 minutes) before a phone can enrol again.
 */
export class IcloudEnrolment {
  readonly #macIdPath: string;
  readonly #now: () => number;
  #macId?: Promise<string>;
  #current?: {token: string; issuedAt: number; expiresAt: number};
  readonly #live: {hash: Buffer; expiresAt: number}[] = [];
  constructor(macIdPath: string, options: {now?: () => number} = {}) { this.#macIdPath = macIdPath; this.#now = options.now ?? Date.now; }

  /** This Mac's id in the CloudKit record: made once, then kept in the auth directory. */
  macId(): Promise<string> {
    this.#macId ??= (async () => {
      const saved = (await readFile(this.#macIdPath, 'utf8').catch(() => '')).trim();
      if (/^[0-9a-f-]{36}$/.test(saved)) return saved;
      const id = randomUUID();
      await mkdir(dirname(this.#macIdPath), {recursive: true, mode: 0o700});
      const temporary = `${this.#macIdPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, id + '\n', {mode: 0o600});
      await rename(temporary, this.#macIdPath);
      return id;
    })();
    return this.#macId;
  }

  /** `pairing.icloudToken`: the current token, or a new one when it is 5 minutes old. Older ones stay good until they expire. */
  async token(): Promise<{token: string; expiresAt: number; macId: string}> {
    const now = this.#now();
    this.#prune(now);
    if (!this.#current || now - this.#current.issuedAt >= ENROLMENT_TOKEN_REPLACE_MS) {
      const token = randomBytes(32).toString('base64url');
      this.#current = {token, issuedAt: now, expiresAt: now + ENROLMENT_TOKEN_LIFETIME_MS};
      this.#live.push({hash: digest(token), expiresAt: this.#current.expiresAt});
    }
    return {token: this.#current.token, expiresAt: this.#current.expiresAt, macId: await this.macId()};
  }

  /** True once for a current token of this Mac; it can't be used again. */
  async redeem(macId: string, token: string): Promise<boolean> {
    const now = this.#now();
    this.#prune(now);
    if (macId !== await this.macId() || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const hash = digest(token);
    const index = this.#live.findIndex(entry => timingSafeEqual(entry.hash, hash));
    if (index < 0) return false;
    this.#live.splice(index, 1);
    if (this.#current && timingSafeEqual(digest(this.#current.token), hash)) this.#current = undefined;
    return true;
  }

  #prune(now: number): void {
    for (let i = this.#live.length - 1; i >= 0; i--) if (this.#live[i]!.expiresAt <= now) this.#live.splice(i, 1);
    if (this.#current && this.#current.expiresAt <= now) this.#current = undefined;
  }
}
