// The relay's only state (PRD §8.8): rate-limit counters, the deny list, and the APNs provider token.
// One SQLite-backed Durable Object instance holds all of it, so each push costs one Durable Object
// request and the check-and-count runs atomically.
//
// Stored: SHA-256 token hashes, keyed HMACs of client IPs, counts and times, and the current
// provider token (a JWT that expires within the hour). Never push tokens, payloads or user data.

import { DurableObject } from "cloudflare:workers";
import { importApnsKey, signProviderToken } from "./apns";
import type { Env } from "./env";

export const TOKEN_INTERVAL_MS = 10_000;
export const TOKEN_DAILY_LIMIT = 2_000;
export const IP_DAILY_LIMIT = 20_000;
export const DENY_MS = 30 * 24 * 60 * 60 * 1000;
/** Apple: refresh no more than once every 20 minutes and no less than once every 60. */
export const PROVIDER_TOKEN_REFRESH_MS = 50 * 60 * 1000;
export const FORCED_REMINT_MIN_MS = 20 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_DELAY_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export type LimitScope = "token-interval" | "token-daily" | "ip-daily" | "global-daily";

export type Admission =
  | { ok: true; providerToken: string }
  | { ok: false; status: 410; reason: "token-denied" }
  | { ok: false; status: 429; reason: LimitScope; retryAfterSec: number }
  | { ok: false; status: 503; reason: "not-configured" }
  /** A caller bug: the hashes or clock weren't what admit expects. */
  | { ok: false; status: 400; reason: "bad-input" };

export interface AdmitInput {
  /** SHA-256 of the push token, lowercase hex. */
  tokenHash: string;
  /** Keyed hash of the client IP, lowercase hex. */
  ipKey: string;
  nowMs: number;
  globalDailyCap: number;
}

interface Usage {
  day: number;
  n: number;
  last_ms: number;
}

interface CachedProviderToken {
  jwt: string;
  iatMs: number;
  keyId: string;
  teamId: string;
}

const HASH = /^[0-9a-f]{64}$/;

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function secondsUntilNextUtcDay(ms: number): number {
  return Math.max(1, Math.ceil(((utcDay(ms) + 1) * DAY_MS - ms) / 1000));
}

export class RelayLimiter extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private cached: CachedProviderToken | undefined;
  private minting: Promise<CachedProviderToken> | undefined;
  private alarmChecked = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // WITHOUT ROWID keeps each table a single b-tree, so an upsert writes one row and no index rows.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS usage (k TEXT PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL, last_ms INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS deny (h TEXT PRIMARY KEY, until_ms INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL, at_ms INTEGER NOT NULL) WITHOUT ROWID;
    `);
  }

  /**
   * Checks the deny list and every limit, and counts the push only when all of them pass. The
   * check and the count run without an await between them, so concurrent calls can't both pass.
   */
  async admit(input: AdmitInput): Promise<Admission> {
    const { tokenHash, ipKey, nowMs } = input;
    if (!HASH.test(tokenHash) || !HASH.test(ipKey) || !Number.isFinite(nowMs)) return { ok: false, status: 400, reason: "bad-input" };
    const globalDailyCap = Math.max(0, Math.floor(input.globalDailyCap));

    // Mint (or reuse) the provider token first: it awaits, and nothing below may.
    let providerToken: string;
    try {
      providerToken = (await this.providerToken(nowMs)).jwt;
    } catch {
      return { ok: false, status: 503, reason: "not-configured" };
    }

    const denied = this.sql.exec<{ until_ms: number }>("SELECT until_ms FROM deny WHERE h = ?", tokenHash).toArray()[0];
    if (denied && denied.until_ms > nowMs) return { ok: false, status: 410, reason: "token-denied" };

    const day = utcDay(nowMs);
    const tokenKey = `t:${tokenHash}`;
    const ipKeyName = `i:${ipKey}`;
    const token = this.usage(tokenKey);
    if (token && nowMs - token.last_ms < TOKEN_INTERVAL_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((TOKEN_INTERVAL_MS - (nowMs - token.last_ms)) / 1000));
      return { ok: false, status: 429, reason: "token-interval", retryAfterSec };
    }
    const untilTomorrow = secondsUntilNextUtcDay(nowMs);
    if (this.countToday(token, day) >= TOKEN_DAILY_LIMIT) {
      return { ok: false, status: 429, reason: "token-daily", retryAfterSec: untilTomorrow };
    }
    if (this.countToday(this.usage(ipKeyName), day) >= IP_DAILY_LIMIT) {
      return { ok: false, status: 429, reason: "ip-daily", retryAfterSec: untilTomorrow };
    }
    if (this.countToday(this.usage("g"), day) >= globalDailyCap) {
      return { ok: false, status: 429, reason: "global-daily", retryAfterSec: untilTomorrow };
    }

    for (const key of [tokenKey, ipKeyName, "g"]) {
      this.sql.exec(
        `INSERT INTO usage (k, day, n, last_ms) VALUES (?, ?, 1, ?)
         ON CONFLICT (k) DO UPDATE SET n = CASE WHEN day = excluded.day THEN n + 1 ELSE 1 END,
                                       day = excluded.day, last_ms = excluded.last_ms`,
        key,
        day,
        nowMs,
      );
    }
    await this.scheduleCleanup(nowMs);
    return { ok: true, providerToken };
  }

  /** APNs said the token is gone (410, or 400 BadDeviceToken): refuse it for 30 days. */
  deny(tokenHash: string, nowMs: number): boolean {
    if (!HASH.test(tokenHash) || !Number.isFinite(nowMs)) return false;
    this.sql.exec(
      "INSERT INTO deny (h, until_ms) VALUES (?, ?) ON CONFLICT (h) DO UPDATE SET until_ms = excluded.until_ms",
      tokenHash,
      nowMs + DENY_MS,
    );
    return true;
  }

  /**
   * APNs refused `jwt` (403 ExpiredProviderToken or InvalidProviderToken). Drops it so the next
   * push mints a new one, at most once every 20 minutes so a wrong key can't loop into
   * TooManyProviderTokenUpdates. Returns whether it was dropped.
   */
  invalidateProviderToken(jwt: string, nowMs: number): boolean {
    const current = this.cached ?? this.storedProviderToken();
    if (!current || current.jwt !== jwt) return false;
    const last = this.sql.exec<{ at_ms: number }>("SELECT at_ms FROM meta WHERE k = 'forced-remint'").toArray()[0];
    if (last && nowMs - last.at_ms < FORCED_REMINT_MIN_MS) return false;
    this.sql.exec("DELETE FROM meta WHERE k = 'provider-token'");
    this.sql.exec(
      "INSERT INTO meta (k, v, at_ms) VALUES ('forced-remint', '', ?) ON CONFLICT (k) DO UPDATE SET at_ms = excluded.at_ms",
      nowMs,
    );
    this.cached = undefined;
    return true;
  }

  /** Daily cleanup: yesterday's counters and expired deny entries. */
  async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.sql.exec("DELETE FROM usage WHERE day < ?", utcDay(nowMs));
    this.sql.exec("DELETE FROM deny WHERE until_ms <= ?", nowMs);
    this.alarmChecked = false;
    const left = this.sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM usage) + (SELECT COUNT(*) FROM deny) AS n").one();
    if (left.n > 0) await this.scheduleCleanup(nowMs);
  }

  private usage(key: string): Usage | undefined {
    return this.sql.exec<Usage & Record<string, SqlStorageValue>>("SELECT day, n, last_ms FROM usage WHERE k = ?", key).toArray()[0];
  }

  private countToday(row: Usage | undefined, day: number): number {
    return row && row.day === day ? row.n : 0;
  }

  private async scheduleCleanup(nowMs: number): Promise<void> {
    if (this.alarmChecked) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm((utcDay(nowMs) + 1) * DAY_MS + CLEANUP_DELAY_MS);
    }
    this.alarmChecked = true;
  }

  private storedProviderToken(): CachedProviderToken | undefined {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'provider-token'").toArray()[0];
    if (!row) return undefined;
    try {
      return JSON.parse(row.v) as CachedProviderToken;
    } catch {
      return undefined;
    }
  }

  /** One provider token for every isolate, kept across restarts, refreshed every 50 minutes. */
  private async providerToken(nowMs: number): Promise<CachedProviderToken> {
    const keyId = this.env.APNS_KEY_ID ?? "";
    const teamId = this.env.TEAM_ID ?? "";
    const usable = (token: CachedProviderToken | undefined): token is CachedProviderToken =>
      token !== undefined &&
      token.keyId === keyId &&
      token.teamId === teamId &&
      // Callers' clocks may trail the one that minted the token by a little.
      nowMs - token.iatMs >= -CLOCK_SKEW_MS &&
      nowMs - token.iatMs < PROVIDER_TOKEN_REFRESH_MS;

    if (usable(this.cached)) return this.cached;
    const stored = this.storedProviderToken();
    if (usable(stored)) {
      this.cached = stored;
      return stored;
    }
    if (!this.minting) {
      this.minting = (async () => {
        const iatSec = Math.floor(nowMs / 1000);
        const key = await importApnsKey(this.env.APNS_KEY_P8 ?? "");
        const jwt = await signProviderToken(key, keyId, teamId, iatSec);
        const token: CachedProviderToken = { jwt, iatMs: iatSec * 1000, keyId, teamId };
        this.sql.exec(
          "INSERT INTO meta (k, v, at_ms) VALUES ('provider-token', ?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v, at_ms = excluded.at_ms",
          JSON.stringify(token),
          token.iatMs,
        );
        this.cached = token;
        return token;
      })().finally(() => {
        this.minting = undefined;
      });
    }
    return this.minting;
  }
}
