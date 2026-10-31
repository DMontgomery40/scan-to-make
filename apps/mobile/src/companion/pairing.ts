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
  pair(
    baseUrl: string,
    code: string,
    deviceName: string,
  ): Promise<PairingStatus>;
  check(): Promise<PairingStatus>;
  disconnect(): Promise<PairingStatus>;
  cancel(): Promise<void>;
}
export function companionNative(): CompanionNative | undefined {
  return NativeModules.CompanionPairing;
}
const errors: Record<string, string> = {
  'invalid-invitation':
    'Use the HTTPS address and fresh pairing code from your companion. Don’t enter an account password.',
  'expired-invitation':
    'This invitation has expired. Ask your companion for a new one.',
  unauthorized:
    'This code or device pairing was rejected or revoked. Get a new invitation from your companion and connect again.',
  forbidden:
    'Access was denied. Check that both devices use the intended Tailscale account and that the companion allows this device.',
  'rate-limited':
    'Too many pairing attempts. Wait a minute, then use a fresh invitation.',
  certificate:
    'The companion’s HTTPS certificate could not be verified. Check the exact address and ask the host owner to repair HTTPS. Certificate checks stay enabled.',
  'wrong-host':
    'The companion redirected to another address. Check the original HTTPS address; credentials were not forwarded.',
  network:
    'Couldn’t reach your companion. Check that it is running and both devices are connected to the same Tailscale network, then retry.',
  timeout:
    'The companion took too long to respond. Check its connection and retry.',
  unavailable:
    'The companion is temporarily unavailable. Wait briefly and retry; your projects are unchanged.',
  'secure-storage':
    'Secure pairing storage is unavailable. Unlock this device and retry. If an invitation was consumed, request a new one.',
  'pairing-required':
    'Connect this device again using a fresh invitation from your companion.',
  'pairing-changed':
    'The companion connection changed. Your draft is still here; retry with the current connection.',
  'invalid-response':
    'This companion returned an incompatible response. Check its version and this device’s permissions before pairing again.',
  cancelled: 'Connection cancelled. Your projects are unchanged.',
  busy: 'A connection request is already running. Wait for it to finish.',
};
export function pairingError(error: unknown): string | undefined {
  return errors[(error as { code?: string })?.code ?? ''];
}
export function invitation(input: string, baseUrl: string, now = Date.now()) {
  let code = input.trim();
  let url = baseUrl.trim();
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
      !Number.isSafeInteger(payload.expiresAt)
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
  }
  // Native validation is authoritative, including Simulator-only fixture URLs.
  if (!url || !/^[A-Za-z0-9_-]{32}$/.test(code)) {
    throw { code: 'invalid-invitation' };
  }
  return { baseUrl: url, code };
}
