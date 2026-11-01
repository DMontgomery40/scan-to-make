import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DENY_MS,
  FORCED_REMINT_MIN_MS,
  IP_DAILY_LIMIT,
  PROVIDER_TOKEN_REFRESH_MS,
  TOKEN_DAILY_LIMIT,
  TOKEN_INTERVAL_MS,
  type AdmitInput,
  type RelayLimiter,
} from "../src/limiter";
import { DAY_MS, NOW_MS, decodeJwt, randomHex } from "./helpers";

function freshLimiter() {
  return env.LIMITER.get(env.LIMITER.newUniqueId());
}

function hash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function input(overrides: Partial<AdmitInput> = {}): AdmitInput {
  return { tokenHash: randomHex(32), ipKey: randomHex(32), nowMs: NOW_MS, globalDailyCap: 1_000_000, ...overrides };
}

const tomorrow = Math.floor(NOW_MS / DAY_MS) * DAY_MS + DAY_MS;

describe("per-token limit: one push every 10 s", () => {
  it("refuses a second push inside 10 s with a Retry-After of at most 10 s, then allows it", async () => {
    const limiter = freshLimiter();
    const first = input();
    expect((await limiter.admit(first)).ok).toBe(true);
    expect(await limiter.admit({ ...first, nowMs: NOW_MS + 1 })).toEqual({ ok: false, status: 429, reason: "token-interval", retryAfterSec: 10 });
    expect(await limiter.admit({ ...first, nowMs: NOW_MS + 6_500 })).toEqual({ ok: false, status: 429, reason: "token-interval", retryAfterSec: 4 });
    expect(await limiter.admit({ ...first, nowMs: NOW_MS + TOKEN_INTERVAL_MS - 1 })).toEqual({ ok: false, status: 429, reason: "token-interval", retryAfterSec: 1 });
    expect((await limiter.admit({ ...first, nowMs: NOW_MS + TOKEN_INTERVAL_MS })).ok).toBe(true);
  });

  it("applies to start, update and end alike but not across tokens", async () => {
    const limiter = freshLimiter();
    const shared = input();
    expect((await limiter.admit(shared)).ok).toBe(true);
    expect((await limiter.admit({ ...shared, tokenHash: randomHex(32) })).ok).toBe(true);
  });
});

describe("per-token limit: 2,000 a day", () => {
  it("allows 2,000 pushes in a UTC day, refuses the next until midnight, then resets", async () => {
    const limiter = freshLimiter();
    const tokenHash = randomHex(32);
    const results = await runInDurableObject(limiter, async (instance: RelayLimiter) => {
      let accepted = 0;
      for (let i = 0; i < TOKEN_DAILY_LIMIT; i += 1) {
        if ((await instance.admit(input({ tokenHash, nowMs: NOW_MS + i * TOKEN_INTERVAL_MS }))).ok) accepted += 1;
      }
      const lastMs = NOW_MS + TOKEN_DAILY_LIMIT * TOKEN_INTERVAL_MS;
      const refused = await instance.admit(input({ tokenHash, nowMs: lastMs }));
      return { accepted, refused, lastMs };
    });
    expect(results.accepted).toBe(TOKEN_DAILY_LIMIT);
    expect(results.refused).toEqual({ ok: false, status: 429, reason: "token-daily", retryAfterSec: Math.ceil((tomorrow - results.lastMs) / 1000) });
    expect((await limiter.admit(input({ tokenHash, nowMs: tomorrow }))).ok).toBe(true);
  });
});

describe("per-IP limit: 20,000 a day", () => {
  it("allows 20,000 pushes from one IP across tokens, refuses the next, and leaves other IPs alone", async () => {
    const limiter = freshLimiter();
    const ipKey = randomHex(32);
    const results = await runInDurableObject(limiter, async (instance: RelayLimiter) => {
      let accepted = 0;
      for (let i = 0; i < IP_DAILY_LIMIT; i += 1) {
        if ((await instance.admit(input({ ipKey, tokenHash: hash(i) }))).ok) accepted += 1;
      }
      return { accepted, refused: await instance.admit(input({ ipKey, tokenHash: hash(IP_DAILY_LIMIT) })) };
    });
    expect(results.accepted).toBe(IP_DAILY_LIMIT);
    expect(results.refused).toMatchObject({ ok: false, status: 429, reason: "ip-daily" });
    expect((await limiter.admit(input({ tokenHash: hash(IP_DAILY_LIMIT) }))).ok).toBe(true);
    expect((await limiter.admit(input({ ipKey, tokenHash: hash(IP_DAILY_LIMIT + 1), nowMs: tomorrow }))).ok).toBe(true);
  }, 60_000);
});

describe("global daily cap", () => {
  it("refuses everyone once the day's cap is reached, until the next UTC day", async () => {
    const limiter = freshLimiter();
    for (let i = 0; i < 3; i += 1) expect((await limiter.admit(input({ globalDailyCap: 3 }))).ok).toBe(true);
    expect(await limiter.admit(input({ globalDailyCap: 3 }))).toMatchObject({ ok: false, status: 429, reason: "global-daily" });
    expect((await limiter.admit(input({ globalDailyCap: 3, nowMs: tomorrow }))).ok).toBe(true);
  });

  it("doesn't count refused pushes", async () => {
    const limiter = freshLimiter();
    const first = input({ globalDailyCap: 2 });
    expect((await limiter.admit(first)).ok).toBe(true);
    for (let i = 0; i < 5; i += 1) expect((await limiter.admit({ ...first, nowMs: NOW_MS + 1 })).ok).toBe(false);
    expect((await limiter.admit(input({ globalDailyCap: 2 }))).ok).toBe(true);
  });
});

describe("deny list", () => {
  it("refuses a token for 30 days after APNs reports it dead", async () => {
    const limiter = freshLimiter();
    const dead = input();
    await limiter.deny(dead.tokenHash, NOW_MS);
    expect(await limiter.admit({ ...dead, nowMs: NOW_MS + 60_000 })).toEqual({ ok: false, status: 410, reason: "token-denied" });
    expect(await limiter.admit({ ...dead, nowMs: NOW_MS + DENY_MS - 1 })).toEqual({ ok: false, status: 410, reason: "token-denied" });
    expect((await limiter.admit({ ...dead, nowMs: NOW_MS + DENY_MS })).ok).toBe(true);
    expect((await limiter.admit(input())).ok).toBe(true);
  });

  it("refuses anything but hashes rather than storing it", async () => {
    const limiter = freshLimiter();
    expect(await limiter.deny("a-raw-push-token", NOW_MS)).toBe(false);
    expect(await limiter.admit(input({ tokenHash: "ABC" }))).toEqual({ ok: false, status: 400, reason: "bad-input" });
    expect(await limiter.admit(input({ ipKey: "203.0.113.9" }))).toEqual({ ok: false, status: 400, reason: "bad-input" });
  });
});

describe("provider token", () => {
  async function jwtAt(limiter: ReturnType<typeof freshLimiter>, nowMs: number): Promise<string> {
    const admission = await limiter.admit(input({ nowMs }));
    if (!admission.ok) throw new Error(JSON.stringify(admission));
    return admission.providerToken;
  }

  it("is a valid ES256 JWT for the configured key and team", async () => {
    const decoded = await decodeJwt(await jwtAt(freshLimiter(), NOW_MS), env.TEST_APNS_PUBLIC_KEY);
    expect(decoded.header).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(decoded.claims).toEqual({ iss: "X7F5F9LR24", iat: Math.floor(NOW_MS / 1000) });
    expect(decoded.verified).toBe(true);
  });

  it("is reused for 50 minutes, survives a restart, and is refreshed before 60 minutes", async () => {
    const limiter = freshLimiter();
    const first = await jwtAt(limiter, NOW_MS);
    expect(await jwtAt(limiter, NOW_MS + PROVIDER_TOKEN_REFRESH_MS - 1)).toBe(first);
    await evictDurableObject(limiter);
    expect(await jwtAt(limiter, NOW_MS + PROVIDER_TOKEN_REFRESH_MS - 1)).toBe(first);
    const second = await jwtAt(limiter, NOW_MS + PROVIDER_TOKEN_REFRESH_MS);
    expect(second).not.toBe(first);
    expect((await decodeJwt(second, env.TEST_APNS_PUBLIC_KEY)).claims).toEqual({ iss: "X7F5F9LR24", iat: Math.floor((NOW_MS + PROVIDER_TOKEN_REFRESH_MS) / 1000) });
  });

  it("can be dropped after a 403 at most once every 20 minutes", async () => {
    const limiter = freshLimiter();
    const first = await jwtAt(limiter, NOW_MS);
    expect(await limiter.invalidateProviderToken("someone-else's", NOW_MS)).toBe(false);
    expect(await limiter.invalidateProviderToken(first, NOW_MS)).toBe(true);
    const second = await jwtAt(limiter, NOW_MS + 1_000);
    expect(second).not.toBe(first);
    expect(await limiter.invalidateProviderToken(second, NOW_MS + FORCED_REMINT_MIN_MS - 1)).toBe(false);
    expect(await jwtAt(limiter, NOW_MS + 2_000)).toBe(second);
    expect(await limiter.invalidateProviderToken(second, NOW_MS + FORCED_REMINT_MIN_MS + 1_000)).toBe(true);
  });
});

describe("storage", () => {
  it("holds only hashes, counts and times, and the daily alarm deletes what has expired", async () => {
    const limiter = freshLimiter();
    const old = NOW_MS - 3 * DAY_MS;
    expect((await limiter.admit(input({ nowMs: old }))).ok).toBe(true);
    await limiter.deny(hash(1), Date.now() - DENY_MS - DAY_MS);
    await limiter.deny(hash(2), NOW_MS);
    const today = input();
    expect((await limiter.admit(today)).ok).toBe(true);
    await runDurableObjectAlarm(limiter);

    const tables = await runInDurableObject(limiter, (_instance: RelayLimiter, state) => ({
      usage: state.storage.sql.exec<{ k: string; day: number }>("SELECT k, day FROM usage ORDER BY k").toArray(),
      deny: state.storage.sql.exec<{ h: string }>("SELECT h FROM deny").toArray().map((r) => r.h),
      meta: state.storage.sql.exec<{ k: string }>("SELECT k FROM meta").toArray().map((r) => r.k),
    }));
    expect(tables.usage.map((r) => r.k).sort()).toEqual(["g", `i:${today.ipKey}`, `t:${today.tokenHash}`].sort());
    expect(tables.usage.every((r) => r.day === Math.floor(NOW_MS / DAY_MS))).toBe(true);
    expect(tables.deny).toEqual([hash(2)]);
    expect(tables.meta).toEqual(["provider-token"]);
  });
});
