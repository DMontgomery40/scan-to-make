import { NativeModules } from 'react-native';
export interface PairingStatus {
  state: 'disconnected' | 'paired' | 'expired';
  baseUrl?: string;
  deviceId?: string;
  expiresAt?: number;
  fixture?: boolean;
}
export interface CompanionNative {
  status(): Promise<PairingStatus>;
  /** Friendly local label; the installation key stays native and is never metadata. */
  deviceName?(): Promise<string>;
  setDeviceName?(name: string): Promise<string>;
  pair(
    baseUrl: string,
    code: string,
    deviceName: string,
    /** SHA-256 of the companion's certificate; when set, only it is trusted. */
    certificateSha256: string | null,
  ): Promise<PairingStatus>;
  /**
   * Pairing link v2: tries each address in order, trusting only the companion's
   * public key (SHA-256 of its SubjectPublicKeyInfo), and keeps the list.
   */
  pairAddresses(
    addresses: string[],
    code: string,
    deviceName: string,
    publicKeySha256: string,
  ): Promise<PairingStatus>;
  check(): Promise<PairingStatus>;
  /**
   * POST /v1/auth/refresh: the same credential for another full lifetime.
   * Absent from builds before KAN-182.
   */
  refresh?(): Promise<PairingStatus>;
  disconnect(): Promise<PairingStatus>;
  cancel(): Promise<void>;
}
export function companionNative(): CompanionNative | undefined {
  return NativeModules.CompanionPairing;
}
/** A parsed invitation: v1 (`baseUrl`, optional certificate pin) or v2 (addresses and a public-key pin). */
export type PairingInvitation = {
  baseUrl: string;
  code: string;
  certificateSha256?: string;
  addresses?: string[];
  publicKeySha256?: string;
  name?: string;
};
/** Pairs with any parsed invitation; the screens call this rather than a native method. */
export function pairWithInvitation(
  native: CompanionNative,
  parsed: PairingInvitation,
  deviceName: string,
): Promise<PairingStatus> {
  return parsed.publicKeySha256 !== undefined && parsed.addresses
    ? native.pairAddresses(
        parsed.addresses,
        parsed.code,
        deviceName,
        parsed.publicKeySha256,
      )
    : native.pair(
        parsed.baseUrl,
        parsed.code,
        deviceName,
        parsed.certificateSha256 ?? null,
      );
}
// Plain words only: what happened, and the one thing to do about it.
export const EXPIRED =
  'That code expired. Show a new one on your Mac: click the Counterpart icon in the menu bar → Add a phone.';
export const UNREACHABLE =
  'Your phone can’t reach your Mac. Are they on the same Wi-Fi, or is your VPN on?';
const errors: Record<string, string> = {
  'invalid-invitation':
    'That isn’t a Counterpart code. Point at the code in Counterpart on your Mac.',
  'expired-invitation': EXPIRED,
  'unsupported-invitation':
    'That code is from a newer Counterpart. Update the app on this phone, then scan it again.',
  unauthorized:
    'Your Mac turned this phone down, or the code was already used. Show a new code on your Mac and scan it.',
  forbidden: 'Your Mac turned this phone down. Show a new code and scan it.',
  'rate-limited':
    'Too many tries. Wait a minute, then scan a new code from your Mac.',
  'certificate-changed':
    'This Mac looks different from last time. Pair again to be safe.',
  certificate:
    'Your phone couldn’t check that this is your Mac. Show a new code on your Mac and scan it.',
  'wrong-host':
    'That code sent your phone somewhere else, so nothing was shared. Scan the code on your Mac again.',
  network: UNREACHABLE,
  timeout: UNREACHABLE,
  unavailable: 'Your Mac is busy right now. Try again in a moment.',
  'secure-storage':
    'This phone couldn’t store the pairing. Unlock it and try again.',
  'pairing-required': 'Pair this phone with your Mac again.',
  'pairing-changed': 'Your Mac changed while this was running. Try again.',
  'invalid-response':
    'Your Mac answered in a way this app doesn’t understand. Update Counterpart on both, then pair again.',
  'invalid-device-name': 'Give this phone a name between 1 and 80 characters.',
  // Nearby pairing (MAC-5).
  'nearby-denied':
    'Your Mac said no to this phone. If that was a mistake, try again and click Allow on your Mac.',
  'nearby-expired':
    'That took too long, so nothing was paired. Try again, then click Allow on your Mac.',
  'local-network':
    'Counterpart can’t look on your Wi-Fi. Turn on Local Network for Counterpart in Settings.',
  cancelled: 'Cancelled. Nothing changed.',
  busy: 'Still working on the last request. Try again in a moment.',
};
export function pairingError(error: unknown): string | undefined {
  return errors[(error as { code?: string })?.code ?? ''];
}
// Lowercase hex SHA-256 of the companion's certificate, as it prints it.
const PIN = /^[a-f0-9]{64}$/;
const PINNED_URL =
  /^https:\/\/(\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3}|[a-z0-9-]+|([a-z0-9-]+\.)+local)(:\d{1,5})?\/?$/i;

export function invitation(input: string, baseUrl: string, now = Date.now()) {
  let code = input.trim();
  let url = baseUrl.trim();
  let pin: string | undefined;
  if (code.startsWith('{')) {
    let payload;
    try {
      payload = JSON.parse(code);
    } catch {
      throw { code: 'invalid-invitation' };
    }
    if (
      !payload ||
      payload.version !== 1 ||
      typeof payload.baseUrl !== 'string' ||
      typeof payload.code !== 'string' ||
      !Number.isSafeInteger(payload.expiresAt) ||
      (payload.certificateSha256 !== undefined &&
        !PIN.test(String(payload.certificateSha256)))
    ) {
      throw { code: 'invalid-invitation' };
    }
    if (payload.expiresAt <= now) {
      throw { code: 'expired-invitation' };
    }
    if (url && url.replace(/\/$/, '') !== payload.baseUrl.replace(/\/$/, '')) {
      throw { code: 'invalid-invitation' };
    }
    url = payload.baseUrl;
    code = payload.code;
    pin = payload.certificateSha256;
  }
  // Native validation is authoritative, including Simulator-only fixture URLs.
  if (!url || !/^[A-Za-z0-9_-]{32}$/.test(code)) {
    throw { code: 'invalid-invitation' };
  }
  // A pinned companion uses its own certificate, which iOS only allows on an
  // IP address, a name ending in .local (one or more labels before it) or a
  // single-label name, as native checks.
  if (pin && !PINNED_URL.test(url)) {
    throw { code: 'invalid-invitation' };
  }
  return pin
    ? { baseUrl: url, code, certificateSha256: pin }
    : { baseUrl: url, code };
}
