/**
 * The `scantomake://pair` link a companion shows as a QR code, versions 1 and 2.
 * One parser and one formatter for the phone and the companion. No runtime imports.
 *
 * v1: `v=1&u=<https base URL>&c=<code>&e=<expiresAt ms>[&f=<certificate SHA-256>]`
 * v2: `v=2&c=<code>&e=<expiresAt ms>&k=<public key SHA-256>&a=<origin>[&a=<origin>…][&n=<name>]`
 *
 * `f` pins the companion's whole certificate; `k` pins its public key (the SHA-256 of
 * its DER SubjectPublicKeyInfo), so a new address or a renewed certificate on the
 * same key keeps working. `a` repeats, once per address, in the order to try.
 * Unknown keys are ignored within a known version; a repeated single key is invalid.
 */

export const PAIRING_LINK_MAX_ADDRESSES = 8;
export const PAIRING_LINK_MAX_NAME = 63;

export type PairingLinkV1 = {
  version: 1;
  baseUrl: string;
  code: string;
  expiresAt: number;
  certificateSha256?: string;
};
export type PairingLinkV2 = {
  version: 2;
  addresses: string[];
  code: string;
  expiresAt: number;
  publicKeySha256: string;
  name?: string;
};
export type PairingLink = PairingLinkV1 | PairingLinkV2;

export type PairingLinkErrorCode =
  | 'invalid-invitation'
  | 'expired-invitation'
  | 'unsupported-invitation';
export class PairingLinkError extends Error {
  constructor(readonly code: PairingLinkErrorCode) {
    super(
      {
        'invalid-invitation': 'Not a valid pairing invitation',
        'expired-invitation': 'The pairing invitation has expired',
        'unsupported-invitation': 'The pairing invitation needs a newer app',
      }[code],
    );
  }
}
const fail = (code: PairingLinkErrorCode = 'invalid-invitation'): never => {
  throw new PairingLinkError(code);
};

const CODE = /^[A-Za-z0-9_-]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// v1 `u`: an https origin, optionally with a trailing slash.
const V1_URL = /^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?\/?$/i;
// iOS accepts a companion's own certificate only on IP addresses, .local names and
// single-label names (App Transport Security's local-networking exemption).
const PINNABLE_URL =
  /^https:\/\/(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:\d{1,5})?\/?$/i;
// v2 `a`: a pinnable origin, no trailing slash.
const PINNABLE_ORIGIN =
  /^https:\/\/(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:\d{1,5})?$/i;
// Without a pin, the companion is reached through Tailscale Serve: a *.ts.net name on 443.
const TAILSCALE_URL =
  /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\/?$/i;
const NAME = new RegExp(`^[^\\x00-\\x1f\\x7f]{1,${PAIRING_LINK_MAX_NAME}}$`);
const SINGLE = { 1: ['v', 'u', 'c', 'e', 'f'], 2: ['v', 'c', 'e', 'k', 'n'] } as const;

export const isPairingLink = (text: string) => /^scantomake:\/\/pair\?/i.test(text);

/** Form-encoded like URLSearchParams, without depending on it (React Native's is partial). */
const encode = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');

function read(text: string) {
  if (!isPairingLink(text)) fail();
  const params = new Map<string, string[]>();
  for (const pair of text.slice(text.indexOf('?') + 1).split('&')) {
    const split = pair.indexOf('=');
    const key = split < 0 ? pair : pair.slice(0, split);
    let value = '';
    try {
      value = split < 0 ? '' : decodeURIComponent(pair.slice(split + 1).replace(/\+/g, ' '));
    } catch {
      fail();
    }
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  return params;
}

function check(link: PairingLink, now?: number): PairingLink {
  if (!Number.isSafeInteger(link.expiresAt) || link.expiresAt <= 0) fail();
  if (link.version === 1) {
    if (!V1_URL.test(link.baseUrl)) fail();
    if (link.certificateSha256 !== undefined && !SHA256.test(link.certificateSha256)) fail();
    if (now !== undefined && link.expiresAt <= now) fail('expired-invitation');
    if (!CODE.test(link.code)) fail();
    const pinned = link.certificateSha256 !== undefined;
    if (pinned ? !PINNABLE_URL.test(link.baseUrl) : !TAILSCALE_URL.test(link.baseUrl)) fail();
  } else {
    const { addresses } = link;
    if (
      !CODE.test(link.code) ||
      !SHA256.test(link.publicKeySha256) ||
      addresses.length < 1 ||
      addresses.length > PAIRING_LINK_MAX_ADDRESSES ||
      new Set(addresses.map((a) => a.toLowerCase())).size !== addresses.length ||
      addresses.some((a) => !PINNABLE_ORIGIN.test(a)) ||
      (link.name !== undefined && !NAME.test(link.name))
    )
      fail();
    if (now !== undefined && link.expiresAt <= now) fail('expired-invitation');
  }
  return link;
}

/**
 * Parses a pairing link. Throws `PairingLinkError` with `code` `invalid-invitation`,
 * `expired-invitation` (only when `now` is given) or `unsupported-invitation` (v3 or later).
 */
export function parsePairingLink(text: string, now?: number): PairingLink {
  const params = read(text);
  const version = params.get('v');
  if (version?.length !== 1) return fail();
  if (version[0] !== '1' && version[0] !== '2')
    return fail(/^[1-9][0-9]{0,8}$/.test(version[0]!) ? 'unsupported-invitation' : 'invalid-invitation');
  const v = Number(version[0]) as 1 | 2;
  if (SINGLE[v].some((key) => (params.get(key)?.length ?? 0) > 1)) fail();
  const one = (key: string) => params.get(key)?.[0];
  // Unix milliseconds as plain decimal digits; Number() alone would read '', ' ', '0x10' or '1e5'.
  const e = one('e');
  const expiresAt = e !== undefined && /^[0-9]{1,16}$/.test(e) ? Number(e) : NaN;
  if (v === 1) {
    const f = one('f');
    return check(
      { version: 1, baseUrl: one('u') ?? '', code: one('c') ?? '', expiresAt, ...(f !== undefined ? { certificateSha256: f } : {}) },
      now,
    );
  }
  const name = one('n');
  return check(
    { version: 2, addresses: params.get('a') ?? [], code: one('c') ?? '', expiresAt, publicKeySha256: one('k') ?? '', ...(name !== undefined ? { name } : {}) },
    now,
  );
}

/** Formats a link the parser accepts; throws `PairingLinkError` for anything it would refuse. */
export function formatPairingLink(link: PairingLink): string {
  check(link);
  const query: [string, string][] =
    link.version === 1
      ? [['v', '1'], ['u', link.baseUrl], ['c', link.code], ['e', String(link.expiresAt)],
          ...(link.certificateSha256 !== undefined ? [['f', link.certificateSha256] as [string, string]] : [])]
      : [['v', '2'], ['c', link.code], ['e', String(link.expiresAt)], ['k', link.publicKeySha256],
          ...link.addresses.map((a) => ['a', a] as [string, string]),
          ...(link.name !== undefined ? [['n', link.name] as [string, string]] : [])];
  return 'scantomake://pair?' + query.map(([k, v]) => `${k}=${encode(v)}`).join('&');
}
