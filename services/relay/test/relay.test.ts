import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apnsBody } from "../src/apns";
import { validateRelayRequest } from "../src/contract";
import type { Env } from "../src/env";
import { clientNetwork, handleRelay } from "../src/relay";
import { NOW_MS, NOW_SEC, apnsError, decodeJwt, endRequest, mockApns, randomHex, relayRequest, startRequest, updateRequest } from "./helpers";

const relayEnv = env as unknown as Env;

async function send(body: unknown, apns = mockApns(), options: { nowMs?: number; env?: Env; ip?: string } = {}) {
  const response = await handleRelay(relayRequest(body, { ip: options.ip }), options.env ?? relayEnv, {
    fetch: apns.fetch,
    now: () => options.nowMs ?? NOW_MS,
  });
  return { response, json: (await response.json()) as Record<string, unknown>, apns };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a delivered push", () => {
  it("starts an activity: the APNs request carries a signed JWT, the PRD headers and the exact body", async () => {
    const body = startRequest();
    const { response, json, apns } = await send(body);
    expect(response.status).toBe(200);
    expect(json).toEqual({ ok: true, apnsId: "4b9a0cc0-2a4c-4bd5-9e0e-6d1f1b1c2d3e" });
    expect(apns.calls).toHaveLength(1);
    const [call] = apns.calls;
    expect(call!.url).toBe(`https://api.push.apple.com/3/device/${body.token}`);
    expect(call!.method).toBe("POST");
    const { authorization, ...headers } = call!.headers;
    expect(headers).toEqual({
      "apns-push-type": "liveactivity",
      "apns-topic": "com.scantomake.push-type.liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const jwt = await decodeJwt(authorization!.slice("bearer ".length), env.TEST_APNS_PUBLIC_KEY);
    expect(jwt.header).toEqual({ alg: "ES256", kid: "TESTKEY123" });
    expect(jwt.claims).toMatchObject({ iss: "X7F5F9LR24" });
    expect(jwt.verified).toBe(true);
    const validated = validateRelayRequest(body, NOW_SEC);
    if (!validated.ok) throw new Error("fixture is invalid");
    expect(call!.body).toStrictEqual(apnsBody(validated.value, NOW_SEC));
  });

  it("sends progress at priority 5 and an end with its dismissal date", async () => {
    const update = await send(updateRequest());
    expect(update.response.status).toBe(200);
    expect(update.apns.calls[0]!.headers["apns-priority"]).toBe("5");
    const end = await send(endRequest());
    expect(end.response.status).toBe(200);
    expect((end.apns.calls[0]!.body as { aps: Record<string, unknown> }).aps["dismissal-date"]).toBe(NOW_SEC + 4 * 3600);
  });

  it("uses the sandbox host only when APNS_ORIGIN says so", async () => {
    const body = updateRequest();
    const { apns } = await send(body, mockApns(), { env: { ...relayEnv, APNS_ORIGIN: "https://api.sandbox.push.apple.com" } });
    expect(apns.calls[0]!.url).toBe(`https://api.sandbox.push.apple.com/3/device/${body.token}`);
  });
});

describe("limits seen by the caller", () => {
  it("answers a push inside 10 s with 429 and Retry-After, and doesn't call APNs", async () => {
    const token = randomHex(32);
    expect((await send(updateRequest(NOW_SEC, token))).response.status).toBe(200);
    const again = await send(endRequest(NOW_SEC, token), mockApns(), { nowMs: NOW_MS + 3_000 });
    expect(again.response.status).toBe(429);
    expect(again.response.headers.get("retry-after")).toBe("7");
    expect(again.json).toEqual({ error: "rate_limited", scope: "token-interval", retryAfterSec: 7 });
    expect(again.apns.calls).toHaveLength(0);
    expect((await send(endRequest(NOW_SEC, token), mockApns(), { nowMs: NOW_MS + 10_000 })).response.status).toBe(200);
  });

  it("answers 429 global-daily when the cap is reached", async () => {
    const { response, json, apns } = await send(updateRequest(), mockApns(), { env: { ...relayEnv, GLOBAL_DAILY_CAP: 0 } });
    expect(response.status).toBe(429);
    expect(json).toMatchObject({ error: "rate_limited", scope: "global-daily" });
    expect(apns.calls).toHaveLength(0);
  });

  it("keys IPv4 by address and IPv6 by /64", () => {
    expect(clientNetwork("203.0.113.9")).toBe("203.0.113.9");
    expect(clientNetwork("2001:db8:abcd:12:1:2:3:4")).toBe("2001:0db8:abcd:0012::/64");
    expect(clientNetwork("2001:DB8:abcd:12::99")).toBe("2001:0db8:abcd:0012::/64");
    expect(clientNetwork("::1")).toBe("0000:0000:0000:0000::/64");
    expect(clientNetwork(null)).toBe("unknown");
    expect(clientNetwork("not:an:ip::address::")).toBe("not:an:ip::address::");
  });
});

describe("dead tokens", () => {
  for (const [status, reason] of [
    [410, "Unregistered"],
    [410, "ExpiredToken"],
    [400, "BadDeviceToken"],
  ] as const) {
    it(`denies the token after APNs ${status} ${reason}`, async () => {
      const token = randomHex(32);
      const first = await send(updateRequest(NOW_SEC, token), mockApns(() => apnsError(status, reason)));
      expect(first.response.status).toBe(410);
      expect(first.json).toEqual({ error: "token_inactive", reason });
      const later = await send(updateRequest(NOW_SEC, token), mockApns(), { nowMs: NOW_MS + 60_000 });
      expect(later.response.status).toBe(410);
      expect(later.json).toEqual({ error: "token_inactive", reason: "denied" });
      expect(later.apns.calls).toHaveLength(0);
    });
  }

  it("doesn't deny on other 4xx answers", async () => {
    const token = randomHex(32);
    const first = await send(updateRequest(NOW_SEC, token), mockApns(() => apnsError(400, "DeviceTokenNotForTopic")));
    expect(first.response.status).toBe(502);
    expect(first.json).toEqual({ error: "apns_rejected", status: 400, reason: "DeviceTokenNotForTopic" });
    const later = await send(updateRequest(NOW_SEC, token), mockApns(), { nowMs: NOW_MS + 10_000 });
    expect(later.response.status).toBe(200);
  });
});

describe("APNs failures", () => {
  it("mints a new provider token after 403 ExpiredProviderToken", async () => {
    const refused = await send(updateRequest(), mockApns(() => apnsError(403, "ExpiredProviderToken")));
    expect(refused.response.status).toBe(503);
    expect(refused.json).toMatchObject({ error: "apns_auth", reason: "ExpiredProviderToken" });
    const next = await send(updateRequest());
    expect(next.apns.calls[0]!.headers.authorization).not.toBe(refused.apns.calls[0]!.headers.authorization);
  });

  it("passes on APNs throttling and outages with Apple's retry times", async () => {
    const throttled = await send(updateRequest(), mockApns(() => apnsError(429, "TooManyRequests")));
    expect(throttled.response.status).toBe(429);
    expect(throttled.json).toMatchObject({ error: "rate_limited", scope: "apns" });
    const down = await send(updateRequest(), mockApns(() => apnsError(503, "ServiceUnavailable")));
    expect(down.response.status).toBe(503);
    expect(down.response.headers.get("retry-after")).toBe("900");
    const unreachable = await send(updateRequest(), mockApns(() => Promise.reject(new Error("connection reset"))));
    expect(unreachable.response.status).toBe(503);
    expect(unreachable.json).toMatchObject({ error: "apns_unreachable" });
  });
});

describe("refused before any limit or APNs call", () => {
  it("answers 503 not_configured until the secrets are set, or for a foreign APNS_ORIGIN", async () => {
    for (const broken of [
      { ...relayEnv, APNS_KEY_P8: undefined },
      { ...relayEnv, APNS_KEY_ID: "short" },
      { ...relayEnv, TEAM_ID: undefined },
      { ...relayEnv, APNS_ORIGIN: "https://collector.example.com" },
    ]) {
      const { response, json, apns } = await send(updateRequest(), mockApns(), { env: broken });
      expect(response.status).toBe(503);
      expect(json).toMatchObject({ error: "not_configured" });
      expect(apns.calls).toHaveLength(0);
    }
  });

  it("answers 400 with every problem for an invalid payload", async () => {
    const { response, json, apns } = await send({ ...updateRequest(), priority: 7, extra: true });
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "invalid_request", problems: ["extra: is not allowed", "priority: must be one of 5, 10"] });
    expect(apns.calls).toHaveLength(0);
  });

  it("answers 404, 405, 415, 413 and 400 for the wrong path, method, type, size or JSON", async () => {
    const deps = { fetch: mockApns().fetch, now: () => NOW_MS };
    const at = (path: string, init: RequestInit) => handleRelay(new Request(`https://counterpart.dtmont.com${path}`, init), relayEnv, deps);
    expect((await at("/relay/v1/other", { method: "POST" })).status).toBe(404);
    expect((await at("/relay/v1/live-activity/", { method: "POST" })).status).toBe(404);
    const get = await at("/relay/v1/live-activity", { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await at("/relay/v1/live-activity", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect((await at("/relay/v1/live-activity", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(9000) })).status).toBe(413);
    expect((await at("/relay/v1/live-activity", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: "{" })).status).toBe(400);
  });
});

describe("the deployed entry point", () => {
  it("routes requests through the default export and the real fetch", async () => {
    const realFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200, headers: { "apns-id": "x" } }));
    const body = { ...updateRequest(Math.floor(Date.now() / 1000)) };
    const response = await exports.default.fetch(relayRequest(body, { ip: "198.51.100.7" }));
    expect(response.status).toBe(200);
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(String(realFetch.mock.calls[0]![0])).toBe(`https://api.push.apple.com/3/device/${body.token}`);
    const rejected = await exports.default.fetch(relayRequest({ token: "nope" }));
    expect(rejected.status).toBe(400);
  });
});
