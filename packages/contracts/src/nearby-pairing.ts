import { z } from 'zod';

/**
 * Nearby pairing v1 (MAC-5, docs/design/journey.md §3.4): the phone finds the Mac over
 * Bonjour, both screens show the same 6-digit code, and the user clicks Allow on the Mac.
 *
 * 1. The phone opens TLS to the advertised address and keeps S, the SHA-256 of the
 *    SubjectPublicKeyInfo it saw in that handshake (32 bytes). Nothing in the advert or in
 *    a response body stands in for S: anyone on the Wi-Fi can advertise the service.
 * 2. The phone makes a fresh 32-byte key P and sends only `commit = SHA-256(commitInput(P))`.
 * 3. The Mac answers with a fresh 32-byte nonce N, made after the commit arrived.
 * 4. The phone reveals P; the Mac checks it against the commit and only then shows the code.
 * 5. Both sides show `nearbyCodeFromDigest(SHA-256(codeInput(S, P, N)))`. Allow on the Mac
 *    releases a v2 pairing link (`./pairing-link`) to the holder of P only, over the same
 *    key. The phone checks the link's `k` equals S, then pairs as if it had scanned the QR.
 *
 * Because the phone commits to P before it sees N, a man in the middle must fix its own
 * key and nonce before it learns P: each try matches by chance one time in a million,
 * and every try is a pairing attempt (5 a minute) and a card the user has to Allow.
 *
 * This module fixes the bytes; hashing is the caller's (node:crypto, CommonCrypto).
 * `fixtures/nearby-pairing-v1.json` is the test vector both sides check.
 */
export const NEARBY_SERVICE_TYPE = '_scantomake._tcp';
export const NEARBY_VERSION = 1;
/** A session must reach Allow within this time after it starts. */
export const NEARBY_SESSION_MS = 120_000;
/** After Allow, the phone has this long to collect its link. */
export const NEARBY_PICKUP_MS = 60_000;
/** Open sessions at once, across all phones. */
export const NEARBY_MAX_SESSIONS = 4;
/** The longest a result request waits for the Mac's answer before saying "waiting". */
export const NEARBY_RESULT_WAIT_MS = 25_000;

const COMMIT_TAG = 'scantomake nearby v1 commit';
const CODE_TAG = 'scantomake nearby v1 code';

/** 32 bytes as unpadded base64url, canonical (the last character carries 4 bits and 2 zero bits). */
export const NearbyBytesSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
/** Same rule as the QR exchange's device name. */
const DeviceNameSchema = z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
const Time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const NearbyStartRequestSchema = z.strictObject({ commit: NearbyBytesSchema, deviceName: DeviceNameSchema });
export const NearbyStartResponseSchema = z.strictObject({ session: z.uuid(), nonce: NearbyBytesSchema, expiresAt: Time });
/** The body of both `/reveal` and `/result`: the key travels only inside TLS, never in a URL. */
export const NearbyKeyRequestSchema = z.strictObject({ session: z.uuid(), key: NearbyBytesSchema });
export const NearbyRevealResponseSchema = z.strictObject({ status: z.literal('waiting'), expiresAt: Time });
export const NearbyResultResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('waiting'), expiresAt: Time }),
  z.strictObject({ status: z.literal('denied') }),
  z.strictObject({ status: z.literal('allowed'), link: z.string().min(1).max(4096) }),
]);
export type NearbyStartRequest = z.infer<typeof NearbyStartRequestSchema>;
export type NearbyStartResponse = z.infer<typeof NearbyStartResponseSchema>;
export type NearbyKeyRequest = z.infer<typeof NearbyKeyRequestSchema>;
export type NearbyResultResponse = z.infer<typeof NearbyResultResponseSchema>;

/** What the Mac lists for Allow (control socket `nearby.list`). Only revealed sessions have a code. */
export const NearbyRequestSchema = z.strictObject({
  id: z.uuid(),
  deviceName: DeviceNameSchema,
  code: z.string().regex(/^[0-9]{6}$/),
  expiresAt: Time,
});
export type NearbyRequest = z.infer<typeof NearbyRequestSchema>;

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
function join(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function bytes32(value: Uint8Array, name: string) {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new TypeError(`${name} must be 32 bytes`);
  return value;
}

/** `"scantomake nearby v1 commit" || 0x00 || P`; the commit is its SHA-256. */
export function nearbyCommitInput(key: Uint8Array) {
  return join(ascii(COMMIT_TAG), Uint8Array.of(0), bytes32(key, 'key'));
}

/** `"scantomake nearby v1 code" || 0x00 || S || P || N`; the code comes from its SHA-256. */
export function nearbyCodeInput(publicKeySha256: Uint8Array, key: Uint8Array, nonce: Uint8Array) {
  return join(ascii(CODE_TAG), Uint8Array.of(0), bytes32(publicKeySha256, 'publicKeySha256'), bytes32(key, 'key'), bytes32(nonce, 'nonce'));
}

/** The first 8 digest bytes as a big-endian unsigned integer, mod 1,000,000, as 6 digits. */
export function nearbyCodeFromDigest(digest: Uint8Array) {
  if (!(digest instanceof Uint8Array) || digest.length < 8) throw new TypeError('digest must be at least 8 bytes');
  const word = (at: number) => ((digest[at]! << 24) >>> 0) + (digest[at + 1]! << 16) + (digest[at + 2]! << 8) + digest[at + 3]!;
  // (hi·2³² + lo) mod 10⁶ without BigInt: 2³² mod 10⁶ = 967296, and every product stays below 2⁵³.
  const value = ((word(0) % 1_000_000) * 967_296 + word(4)) % 1_000_000;
  return String(value).padStart(6, '0');
}
