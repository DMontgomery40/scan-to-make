// POST /relay/v1/live-activity: validate, admit, push, answer. docs.md is the caller's contract.

import { APNS_MAX_BODY_BYTES, APNS_PRODUCTION, APNS_SANDBOX, apnsPush, byteLength, readApnsResponse } from "./apns";
import { validateRelayRequest } from "./contract";
import type { Env } from "./env";

export const RELAY_PATH = "/relay/v1/live-activity";
export const MAX_REQUEST_BYTES = 8 * 1024;
const DEFAULT_GLOBAL_DAILY_CAP = 14_000;
const APNS_TIMEOUT_MS = 15_000;
const LIMITER_NAME = "relay-v1";
const APPLE_ID = /^[A-Z0-9]{10}$/;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

export interface RelayDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}

type Body = Record<string, unknown>;

function json(status: number, body: Body, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function retryLater(status: number, body: Body, retryAfterSec: number): Response {
  return json(status, { ...body, retryAfterSec }, { "retry-after": String(retryAfterSec) });
}

/** Reads at most `limit` bytes; `undefined` when the body is larger. */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The rate-limit key for a client IP. IPv6 is keyed by its /64, the block one subscriber holds,
 * so rotating addresses inside it doesn't reset the limit.
 */
export function clientNetwork(ip: string | null): string {
  const address = (ip ?? "").trim().toLowerCase();
  if (address === "") return "unknown";
  if (!address.includes(":")) return address;
  const groups = expandIpv6(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
}

function expandIpv6(address: string): string[] | undefined {
  const halves = (address.split("%")[0] ?? "").split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => g.padStart(4, "0"));
}

const ipKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * A keyed hash of the client network, so the Durable Object never holds an IP address. The key
 * is derived from the APNs key secret, which keeps the hash unguessable without extra state.
 */
async function ipKey(secret: string, network: string): Promise<string> {
  let key = ipKeyCache.get(secret);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`counterpart-relay/ip/v1\n${secret}`));
      return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })();
    ipKeyCache.clear();
    ipKeyCache.set(secret, key);
  }
  return hex(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(network)));
}

function apnsOrigin(env: Env): string | undefined {
  const origin = (env.APNS_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (origin === "") return APNS_PRODUCTION;
  if (origin === APNS_PRODUCTION || origin === APNS_SANDBOX || LOOPBACK_ORIGIN.test(origin)) return origin;
  return undefined;
}

function globalDailyCap(env: Env): number {
  const cap = Number(env.GLOBAL_DAILY_CAP ?? DEFAULT_GLOBAL_DAILY_CAP);
  return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_GLOBAL_DAILY_CAP;
}

function log(event: Body): void {
  // Never the token, payload or IP: only what happened.
  console.log(JSON.stringify({ relay: "live-activity", ...event }));
}

export async function handleRelay(request: Request, env: Env, deps: RelayDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== RELAY_PATH) return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "application/json") return json(415, { error: "unsupported_media_type", detail: "send application/json" });

  let text: string | undefined;
  try {
    text = await readLimited(request, MAX_REQUEST_BYTES);
  } catch {
    return json(400, { error: "invalid_json", detail: "body is not UTF-8" });
  }
  if (text === undefined) return json(413, { error: "request_too_large", detail: `at most ${MAX_REQUEST_BYTES} bytes` });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const nowMs = deps.now();
  const nowSec = Math.floor(nowMs / 1000);
  const validation = validateRelayRequest(parsed, nowSec);
  if (!validation.ok) return json(400, { error: "invalid_request", problems: validation.problems.slice(0, 20) });
  const push = validation.value;

  const origin = apnsOrigin(env);
  if (!env.APNS_KEY_P8 || !APPLE_ID.test(env.APNS_KEY_ID ?? "") || !APPLE_ID.test(env.TEAM_ID ?? "") || !origin) {
    return retryLater(503, { error: "not_configured" }, 3600);
  }

  // Build once with a placeholder token to check the size before spending any limit.
  const probe = apnsPush(origin, push, "", nowSec);
  if (byteLength(probe.body) > APNS_MAX_BODY_BYTES) {
    return json(413, { error: "payload_too_large", detail: `the APNs body must be at most ${APNS_MAX_BODY_BYTES} bytes` });
  }

  const tokenHash = await sha256Hex(push.token);
  const limiter = env.LIMITER.get(env.LIMITER.idFromName(LIMITER_NAME));
  let admission;
  try {
    admission = await limiter.admit({
      tokenHash,
      ipKey: await ipKey(env.APNS_KEY_P8, clientNetwork(request.headers.get("cf-connecting-ip"))),
      nowMs,
      globalDailyCap: globalDailyCap(env),
    });
  } catch {
    log({ kind: push.kind, outcome: "limiter-error" });
    return retryLater(503, { error: "relay_unavailable" }, 60);
  }
  if (!admission.ok) {
    if (admission.status === 410) return json(410, { error: "token_inactive", reason: "denied" });
    if (admission.status === 429) return retryLater(429, { error: "rate_limited", scope: admission.reason }, admission.retryAfterSec);
    if (admission.status === 503) return retryLater(503, { error: "not_configured" }, 3600);
    log({ kind: push.kind, outcome: "limiter-refused-input" });
    return retryLater(503, { error: "relay_unavailable" }, 60);
  }

  const { url: apnsUrl, headers, body } = apnsPush(origin, push, admission.providerToken, nowSec);
  let response: Response;
  try {
    response = await deps.fetch(apnsUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(APNS_TIMEOUT_MS) });
  } catch {
    log({ kind: push.kind, outcome: "apns-unreachable" });
    return retryLater(503, { error: "apns_unreachable" }, 60);
  }

  const outcome = await readApnsResponse(response);
  log({ kind: push.kind, outcome: outcome.kind, status: response.status, reason: "reason" in outcome ? outcome.reason : "" });
  switch (outcome.kind) {
    case "delivered":
      return json(200, { ok: true, apnsId: outcome.apnsId });
    case "token-dead":
      try {
        await limiter.deny(tokenHash, nowMs);
      } catch {
        // The answer to the caller is the same; the next push learns it from APNs again.
      }
      return json(410, { error: "token_inactive", reason: outcome.reason || String(outcome.status) });
    case "provider-token":
      try {
        await limiter.invalidateProviderToken(admission.providerToken, nowMs);
      } catch {
        // Expires on its own within the hour.
      }
      return retryLater(503, { error: "apns_auth", reason: outcome.reason }, 60);
    case "retry":
      if (outcome.status === 429 && outcome.reason !== "TooManyProviderTokenUpdates") {
        return retryLater(429, { error: "rate_limited", scope: "apns", reason: outcome.reason }, outcome.retryAfterSec);
      }
      return retryLater(503, { error: "apns_unavailable", reason: outcome.reason }, outcome.retryAfterSec);
    case "rejected":
      return json(502, { error: "apns_rejected", status: outcome.status, reason: outcome.reason });
  }
}
