import {
  isPairingLink as isLink,
  parsePairingLink,
} from '@scan-to-make/contracts/pairing-link';
import { invitation, type PairingInvitation } from './pairing';

/**
 * The companion shows its invitation as a QR code, a `scantomake://pair` link
 * (`@scan-to-make/contracts/pairing-link`):
 * - v1: `v=1&u=<https base URL>&c=<one-time code>&e=<expiresAt ms>`, plus
 *   `f=<certificate SHA-256>` when the companion uses its own certificate;
 * - v2: every address the Mac answers on (`a=`, in the order to try) and its
 *   public-key pin (`k=`).
 * Unknown keys are ignored. The older invitation JSON is accepted too.
 */
export const isPairingLink = (value: string) => isLink(value.trim());

// Without a pin the companion is reached through Tailscale Serve, so the
// phone only accepts a *.ts.net name on the default port (as native checks).
const TAILSCALE_URL =
  /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\/?$/i;

export function parsePairingQR(
  value: string,
  now = Date.now(),
): PairingInvitation {
  const text = value.trim();
  if (text.startsWith('{')) {
    const parsed = invitation(text, '', now);
    if (!parsed.certificateSha256 && !TAILSCALE_URL.test(parsed.baseUrl)) {
      throw { code: 'invalid-invitation' };
    }
    return parsed;
  }
  if (!isLink(text)) throw { code: 'invalid-invitation' };
  const link = parsePairingLink(text, now);
  if (link.version === 1) {
    return link.certificateSha256 !== undefined
      ? {
          baseUrl: link.baseUrl,
          code: link.code,
          certificateSha256: link.certificateSha256,
        }
      : { baseUrl: link.baseUrl, code: link.code };
  }
  return {
    baseUrl: link.addresses[0]!,
    code: link.code,
    addresses: link.addresses,
    publicKeySha256: link.publicKeySha256,
    ...(link.name !== undefined ? { name: link.name } : {}),
  };
}

