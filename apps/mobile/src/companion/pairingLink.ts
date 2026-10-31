import { NativeModules } from 'react-native';
import { invitation } from './pairing';

/**
 * The companion shows its invitation as a QR code:
 * `scantomake://pair?v=1&u=<https base URL>&c=<one-time code>&e=<expiresAt ms>`.
 * The older invitation JSON is accepted too.
 */
export const isPairingLink = (value: string) =>
  /^scantomake:\/\/pair\?/i.test(value.trim());

const KEYS = ['v', 'u', 'c', 'e'];

export function parsePairingQR(value: string, now = Date.now()) {
  const text = value.trim();
  if (text.startsWith('{')) return invitation(text, '', now);
  if (!isPairingLink(text)) throw { code: 'invalid-invitation' };
  // Exactly v, u, c and e, once each, form-encoded as URLSearchParams writes
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
    !/^https:\/\/[^\s/?#]+/.test(params.u ?? '') ||
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
    }),
    '',
    now,
  );
}

export type QRScanner = { scan(): Promise<string> };
export const qrScanner = (): QRScanner | undefined =>
  NativeModules.QRScannerBridge;
