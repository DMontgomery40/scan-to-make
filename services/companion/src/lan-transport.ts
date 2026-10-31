import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';

/** Direct LAN mode binds one selected IPv4 address, never every interface. */
export function isLanAddress(host: string) {
  if (isIP(host) !== 4) return false;
  const [a,b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}
export function isLanAuthority(authority: string) {
  try {
    const url = new URL(`https://${authority}`);
    return url.host === authority && isLanAddress(url.hostname) &&
      url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash &&
      Number(url.port || '443') > 0;
  } catch { return false; }
}
export function certificateFingerprint(cert: string | Buffer) {
  return new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
}
export function checkLanCertificate(cert: string | Buffer, host: string, fingerprint: string) {
  const certificate = new X509Certificate(cert);
  const now = Date.now();
  if (certificateFingerprint(cert) !== fingerprint || !certificate.checkIP(host) ||
      Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error('LAN certificate does not match pairing configuration or is expired');
  }
}
