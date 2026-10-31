import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {
  NEARBY_SERVICE_TYPE, NearbyBytesSchema, NearbyKeyRequestSchema, NearbyRequestSchema, NearbyResultResponseSchema,
  NearbyStartRequestSchema, NearbyStartResponseSchema, nearbyCodeFromDigest, nearbyCodeInput, nearbyCommitInput,
} from '../dist/nearby-pairing.js';

const vector = JSON.parse(await readFile(new URL('../fixtures/nearby-pairing-v1.json', import.meta.url), 'utf8'));
const sha = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());
const b64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'));
const hex = (text) => new Uint8Array(Buffer.from(text, 'hex'));

test('the fixed vector: commit, digest and code, byte for byte', () => {
  const S = hex(vector.publicKeySha256), P = b64(vector.key), N = b64(vector.nonce);
  assert.equal(Buffer.from(sha(nearbyCommitInput(P))).toString('base64url'), vector.commit);
  const digest = sha(nearbyCodeInput(S, P, N));
  assert.equal(Buffer.from(digest).toString('hex'), vector.codeDigest);
  assert.equal(nearbyCodeFromDigest(digest), vector.code);
  // The layout spelled out, independently of the helpers.
  assert.deepEqual(nearbyCodeInput(S, P, N), new Uint8Array(Buffer.concat([Buffer.from('scantomake nearby v1 code\0'), S, P, N])));
  assert.deepEqual(nearbyCommitInput(P), new Uint8Array(Buffer.concat([Buffer.from('scantomake nearby v1 commit\0'), P])));
  assert.equal(NEARBY_SERVICE_TYPE, '_scantomake._tcp');
});

test('the code is the first 8 digest bytes, big-endian, mod a million, padded to 6 digits', () => {
  const bigint = (d) => String(Buffer.from(d).readBigUInt64BE(0) % 1_000_000n).padStart(6, '0');
  const edges = [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 7, 9), Uint8Array.of(0x80, 0, 0, 0, 0, 0, 0, 0)];
  for (const d of edges) assert.equal(nearbyCodeFromDigest(d), bigint(d));
  assert.equal(nearbyCodeFromDigest(new Uint8Array(32)), '000000');
  for (let i = 0; i < 2000; i++) { const d = randomBytes(32); assert.equal(nearbyCodeFromDigest(new Uint8Array(d)), bigint(d)); }
  // Every input changes the code (with overwhelming probability), so S, P and N are all bound.
  const S = randomBytes(32), P = randomBytes(32), N = randomBytes(32);
  const code = (s, p, n) => nearbyCodeFromDigest(sha(nearbyCodeInput(new Uint8Array(s), new Uint8Array(p), new Uint8Array(n))));
  const base = code(S, P, N), flip = (b) => { const c = Buffer.from(b); c[31] ^= 1; return c; };
  assert.notEqual(new Set([base, code(flip(S), P, N), code(S, flip(P), N), code(S, P, flip(N))]).size, 1);
  assert.throws(() => nearbyCodeFromDigest(new Uint8Array(7)), TypeError);
  for (const bad of [new Uint8Array(31), new Uint8Array(33), [...new Uint8Array(32)]]) {
    assert.throws(() => nearbyCommitInput(bad), TypeError);
    assert.throws(() => nearbyCodeInput(bad, P, N), TypeError);
  }
});

test('wire shapes: canonical 32-byte base64url, strict bodies, the key never in a URL', () => {
  const key = vector.key, session = '00000000-0000-4000-8000-000000000001';
  assert.ok(NearbyBytesSchema.safeParse(key).success);
  for (const bad of [key.slice(1), key + 'A', key.replace(/.$/, 'B'), Buffer.from(b64(key)).toString('base64'), key.replace('I', '+')])
    assert.equal(NearbyBytesSchema.safeParse(bad).success, false, bad);
  assert.deepEqual(NearbyStartRequestSchema.parse({commit: vector.commit, deviceName: " David's iPhone "}), {commit: vector.commit, deviceName: "David's iPhone"});
  for (const deviceName of ['', ' ', 'a\nb', 'x'.repeat(81)])
    assert.equal(NearbyStartRequestSchema.safeParse({commit: vector.commit, deviceName}).success, false);
  assert.equal(NearbyStartRequestSchema.safeParse({commit: vector.commit, deviceName: 'p', key}).success, false);
  assert.ok(NearbyStartResponseSchema.safeParse({session, nonce: vector.nonce, expiresAt: 1}).success);
  assert.ok(NearbyKeyRequestSchema.safeParse({session, key}).success);
  assert.equal(NearbyKeyRequestSchema.safeParse({session: 'x', key}).success, false);
  for (const ok of [{status: 'waiting', expiresAt: 5}, {status: 'denied'}, {status: 'allowed', link: 'scantomake://pair?v=2'}])
    assert.ok(NearbyResultResponseSchema.safeParse(ok).success);
  for (const bad of [{status: 'allowed'}, {status: 'denied', link: 'x'}, {status: 'other'}])
    assert.equal(NearbyResultResponseSchema.safeParse(bad).success, false);
  assert.ok(NearbyRequestSchema.safeParse({id: session, deviceName: 'p', code: '012345', expiresAt: 1}).success);
  assert.equal(NearbyRequestSchema.safeParse({id: session, deviceName: 'p', code: '12345', expiresAt: 1}).success, false);
});
