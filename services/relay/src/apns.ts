// APNs: the provider token (ES256 JWT), the Live Activity push request, and how to read the answer.
// Apple: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
// and https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications

import type { RelayRequest } from "./contract";

export const APNS_PRODUCTION = "https://api.push.apple.com";
export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
export const APNS_TOPIC = "com.scantomake.push-type.liveactivity";
export const ATTRIBUTES_TYPE = "PrintAttributes";
/** APNs rejects larger bodies with 413 PayloadTooLarge. */
export const APNS_MAX_BODY_BYTES = 4096;
/** `end` keeps the finished activity on the Lock Screen this long (PRD §8.8: 4 hours). */
export const DISMISSAL_DELAY_SEC = 4 * 60 * 60;

const encoder = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Reads the .p8 file Apple issues (PKCS #8 PEM). Accepts the file as-is, with `\n` escapes from a
 * one-line paste, or as bare base64.
 */
export function pkcs8FromPem(pem: string): Uint8Array {
  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("APNS_KEY_P8 is not a PEM private key");
  }
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) der[i] = binary.charCodeAt(i);
  return der;
}

export async function importApnsKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * The provider token: header `{alg: "ES256", kid}`, claims `{iss: teamId, iat}`. WebCrypto's ECDSA
 * signature is already the raw 64-byte r‖s form that JWS uses.
 */
export async function signProviderToken(key: CryptoKey, keyId: string, teamId: string, iatSec: number): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: teamId, iat: iatSec })));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

/** The JSON body APNs receives (PRD §8.8). Key order follows the PRD. */
export function apnsBody(request: RelayRequest, timestampSec: number): Record<string, unknown> {
  const { contentState } = request;
  const state: Record<string, unknown> = {
    state: contentState.state,
    progress: contentState.progress,
    layer: contentState.layer,
    totalLayers: contentState.totalLayers,
    endsAt: contentState.endsAt,
    stage: contentState.stage,
  };
  if (contentState.problem !== undefined) state.problem = contentState.problem;

  const aps: Record<string, unknown> = {
    timestamp: timestampSec,
    event: request.kind,
    "content-state": state,
  };
  if (request.staleDate !== undefined) aps["stale-date"] = request.staleDate;
  if (request.kind === "start" && request.attributes) {
    const { projectId, printId, title, printerName } = request.attributes;
    aps["attributes-type"] = ATTRIBUTES_TYPE;
    aps.attributes = { projectId, printId, title, printerName };
    // iOS 18 and later give a push-started activity an update token only when the start asks for one.
    // The Mac needs that token for every later update and end.
    aps["input-push-token"] = 1;
  }
  if (request.alert) {
    const alert: Record<string, unknown> = { title: request.alert.title, body: request.alert.body };
    if (request.alert.sound !== undefined) alert.sound = request.alert.sound;
    aps.alert = alert;
  }
  if (request.kind === "end") aps["dismissal-date"] = timestampSec + DISMISSAL_DELAY_SEC;
  return { aps };
}

export interface ApnsPush {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function apnsPush(origin: string, request: RelayRequest, providerToken: string, timestampSec: number): ApnsPush {
  return {
    url: `${origin}/3/device/${request.token}`,
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-push-type": "liveactivity",
      "apns-topic": APNS_TOPIC,
      "apns-priority": String(request.priority),
      "content-type": "application/json",
    },
    body: JSON.stringify(apnsBody(request, timestampSec)),
  };
}

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

export type ApnsOutcome =
  | { kind: "delivered"; apnsId: string | null }
  /** The token will never work again: 410, or 400 BadDeviceToken. */
  | { kind: "token-dead"; status: number; reason: string }
  /** Our provider token was refused; mint a fresh one. */
  | { kind: "provider-token"; status: number; reason: string }
  /** Try again later. */
  | { kind: "retry"; status: number; reason: string; retryAfterSec: number }
  /** Anything else Apple refused; retrying the same push won't help. */
  | { kind: "rejected"; status: number; reason: string };

/** Apple: retry 5xx after 15 minutes. */
const SERVER_ERROR_RETRY_SEC = 15 * 60;
const THROTTLE_RETRY_SEC = 60;

export async function readApnsResponse(response: Response): Promise<ApnsOutcome> {
  const apnsId = response.headers.get("apns-id");
  if (response.status === 200) {
    await response.body?.cancel();
    return { kind: "delivered", apnsId };
  }
  let reason = "";
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (parsed && typeof parsed === "object" && typeof (parsed as { reason?: unknown }).reason === "string") {
      reason = (parsed as { reason: string }).reason.slice(0, 64);
    }
  } catch {
    // An unreadable error body still has a status.
  }
  const status = response.status;
  if (status === 410 || (status === 400 && reason === "BadDeviceToken")) return { kind: "token-dead", status, reason };
  if (status === 403 && (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken")) {
    return { kind: "provider-token", status, reason };
  }
  if (status === 429) return { kind: "retry", status, reason, retryAfterSec: THROTTLE_RETRY_SEC };
  if (status >= 500) return { kind: "retry", status, reason, retryAfterSec: SERVER_ERROR_RETRY_SEC };
  return { kind: "rejected", status, reason };
}
