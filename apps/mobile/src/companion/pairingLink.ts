import { NativeModules } from 'react-native';
import { invitation } from './pairing';

/**
 * The companion shows its invitation as a QR code:
 * `scantomake://pair?v=1&u=<https base URL>&c=<one-time code>&e=<expiresAt ms>`,
 * plus `f=<certificate SHA-256>` when the companion uses its own certificate.
 * The older invitation JSON is accepted too.
 */
export const isPairingLink = (value: string) =>
  /^scantomake:\/\/pair\?/i.test(value.trim());

const KEYS = ['v', 'u', 'c', 'e', 'f'];
// Without a pin the companion is reached through Tailscale Serve, so the
// phone only accepts a *.ts.net name on the default port (as native checks).
const TAILSCALE_URL =
  /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\/?$/i;

export function parsePairingQR(value: string, now = Date.now()) {
  const parsed = parseQR(value.trim(), now);
  if (!('certificateSha256' in parsed) && !TAILSCALE_URL.test(parsed.baseUrl)) {
    throw { code: 'invalid-invitation' };
  }
  return parsed;
}

function parseQR(text: string, now: number) {
  if (text.startsWith('{')) return invitation(text, '', now);
  if (!isPairingLink(text)) throw { code: 'invalid-invitation' };
  // v, u, c and e, plus an optional certificate pin f, once each, form-encoded as URLSearchParams writes
  // them. Parsed here rather than with React Native's partial URL polyfill.
  const params: Record<string, string> = {};
  for (const pair of text.slice(text.indexOf('?') + 1).split('&')) {
    const split = pair.indexOf('=');
    const key = split < 0 ? pair : pair.slice(0, split);
    if (!KEYS.includes(key) || key in params) {
      throw { code: 'invalid-invitation' };
    }
    try {
      params[key] = decodeURIComponent(
        pair.slice(split + 1).replace(/\+/g, ' '),
      );
    } catch {
      throw { code: 'invalid-invitation' };
    }
  }
  const expiresAt = Number(params.e);
  if (
    params.v !== '1' ||
    !/^https:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?\/?$/i.test(
      params.u ?? '',
    ) ||
    !Number.isSafeInteger(expiresAt)
  ) {
    throw { code: 'invalid-invitation' };
  }
  return invitation(
    JSON.stringify({
      version: 1,
      baseUrl: params.u,
      code: params.c ?? '',
      expiresAt,
      ...(params.f !== undefined ? { certificateSha256: params.f } : {}),
    }),
    '',
    now,
  );
}

export type QRScanner = { scan(): Promise<string> };
export const qrScanner = (): QRScanner | undefined =>
  NativeModules.QRScannerBridge;
