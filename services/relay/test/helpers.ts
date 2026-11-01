import { REFERENCE_DATE_OFFSET } from "../src/contract";
import type { RelayDeps } from "../src/relay";

export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 01:00 UTC today. Every test passes this clock explicitly; it stays on today's UTC day (the
 * Durable Object's cleanup alarm runs on the real clock and only deletes earlier days).
 */
export const NOW_MS = Math.floor(Date.now() / DAY_MS) * DAY_MS + 60 * 60 * 1000;
export const NOW_SEC = NOW_MS / 1000;

/** The same instant as Swift's default `Date` encoding (seconds since 2001-01-01). */
export function referenceSeconds(unixSec: number): number {
  return unixSec - REFERENCE_DATE_OFFSET;
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function contentState(nowSec = NOW_SEC) {
  return {
    state: "printing",
    progress: 42.5,
    layer: 120,
    totalLayers: 300,
    endsAt: referenceSeconds(nowSec + 3600),
    stage: "Printing",
  };
}

export function startRequest(nowSec = NOW_SEC, token = randomHex(32)) {
  return {
    token,
    kind: "start",
    attributes: {
      projectId: "2f1d7c9e-1b7a-4c1e-9a55-7d0f0c3e8b21",
      printId: "9b0e4a6c-3c51-4e0b-8f3a-1c2d3e4f5a6b",
      title: "Desk hook",
      printerName: "Bambu Lab P1S",
    },
    contentState: { ...contentState(nowSec), state: "preparing", progress: 0, layer: 0, stage: "Heating the bed" },
    staleDate: nowSec + 3600 + 600,
    priority: 10,
    alert: { title: "Desk hook is printing", body: "On Bambu Lab P1S" },
  };
}

export function updateRequest(nowSec = NOW_SEC, token = randomHex(32)) {
  return { token, kind: "update", contentState: contentState(nowSec), staleDate: nowSec + 3600 + 600, priority: 5 };
}

export function endRequest(nowSec = NOW_SEC, token = randomHex(32)) {
  return {
    token,
    kind: "end",
    contentState: { ...contentState(nowSec), state: "finished", progress: 100, layer: 300, endsAt: referenceSeconds(nowSec), stage: "" },
    priority: 10,
    alert: { title: "Desk hook is done", body: "Take it off the plate.", sound: "default" },
  };
}

export interface ApnsCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for api.push.apple.com that records each request and answers from `reply`. */
export function mockApns(reply: (call: ApnsCall, index: number) => Response | Promise<Response> = () => new Response(null, { status: 200, headers: { "apns-id": "4b9a0cc0-2a4c-4bd5-9e0e-6d1f1b1c2d3e" } })) {
  const calls: ApnsCall[] = [];
  const fetch: RelayDeps["fetch"] = async (input, init) => {
    const call: ApnsCall = {
      url: input,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body: JSON.parse(String(init.body)),
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { calls, fetch };
}

export function apnsError(status: number, reason: string): Response {
  return new Response(JSON.stringify({ reason }), { status, headers: { "content-type": "application/json" } });
}

export function relayRequest(body: unknown, init: { ip?: string; contentType?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": init.contentType ?? "application/json" };
  if (init.ip) headers["cf-connecting-ip"] = init.ip;
  return new Request("https://counterpart.dtmont.com/relay/v1/live-activity", {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function base64urlDecode(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export interface DecodedJwt {
  header: unknown;
  claims: unknown;
  signatureBytes: number;
  verified: boolean;
  parts: string[];
}

export async function decodeJwt(jwt: string, publicKeyPem: string): Promise<DecodedJwt> {
  const parts = jwt.split(".");
  const [header = "", claims = "", signature = ""] = parts;
  const spki = base64urlDecode(publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sig = base64urlDecode(signature);
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(`${header}.${claims}`));
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64urlDecode(part))) as unknown;
  return { header: decode(header), claims: decode(claims), signatureBytes: sig.byteLength, verified, parts };
}
