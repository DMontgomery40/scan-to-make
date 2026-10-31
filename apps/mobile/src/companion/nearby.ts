import { NativeModules } from 'react-native';
import { parsePairingLink } from '@scan-to-make/contracts/pairing-link';
import {
  pairWithInvitation,
  type CompanionNative,
  type PairingStatus,
} from './pairing';

/**
 * Nearby pairing (MAC-5, journey.md §3.4): the Mac advertises itself over Bonjour, both
 * screens show the same 6-digit code, and the user clicks Allow on the Mac. The protocol
 * is in @scan-to-make/contracts/nearby-pairing; the key and session stay in native code.
 */
export interface NearbyMac {
  name: string;
  /** From the advert, so a hint only: anyone on the Wi-Fi can advertise. */
  publicKeySha256?: string;
}
export interface NearbyStarted {
  /** Six digits; show them as formatNearbyCode does. */
  code: string;
  /** The SHA-256 of the key this phone saw on the Mac's TLS connection (S). */
  publicKeySha256: string;
  baseUrl: string;
  expiresAt: number;
}
export type NearbyAnswer =
  | { status: 'waiting'; expiresAt: number }
  | { status: 'denied' }
  | { status: 'allowed'; link: string };
export interface NearbyNative {
  /** Macs seen within timeoutMs. Rejects `local-network` when Local Network access is off. */
  browse(timeoutMs: number): Promise<NearbyMac[]>;
  start(name: string, deviceName: string): Promise<NearbyStarted>;
  /** One wait for the Mac's answer, up to about 25 seconds. */
  result(): Promise<NearbyAnswer>;
  /** Ends the session and browsing; anything in flight rejects `cancelled`. */
  cancel(): Promise<void>;
}
export function nearbyNative(): NearbyNative | undefined {
  return NativeModules.NearbyPairing;
}

/** "482913" → "482 913", the same on both screens. */
export function formatNearbyCode(code: string) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

const RETRY = new Set(['network', 'timeout']);

/**
 * Pairs with a nearby Mac: starts the session, gives the screen the code to show, waits for
 * Allow, then pairs through the ordinary v2 path, trusting only the key this phone saw.
 * Rejects `{code: 'nearby-denied'}` when the Mac says no and `{code: 'nearby-expired'}`
 * after two minutes; cancel with `nearby.cancel()`.
 */
export async function pairNearby(
  nearby: NearbyNative,
  companion: CompanionNative,
  mac: string,
  deviceName: string,
  onCode: (started: NearbyStarted) => void,
): Promise<PairingStatus> {
  const started = await nearby.start(mac, deviceName);
  onCode(started);
  let dropped = 0;
  for (;;) {
    let answer: NearbyAnswer;
    try {
      answer = await nearby.result();
      dropped = 0;
    } catch (error) {
      // A dropped wait keeps the session on the Mac: ask again, but not forever.
      if (RETRY.has((error as { code?: string })?.code ?? '') && ++dropped < 3)
        continue;
      throw error;
    }
    if (answer.status === 'waiting') continue;
    if (answer.status === 'denied') throw { code: 'nearby-denied' };
    let link;
    try {
      link = parsePairingLink(answer.link);
    } catch {
      throw { code: 'invalid-response' };
    }
    // The link came over the connection pinned to S; a different key means a broken Mac.
    if (link.version !== 2 || link.publicKeySha256 !== started.publicKeySha256)
      throw { code: 'invalid-response' };
    return pairWithInvitation(
      companion,
      {
        baseUrl: link.addresses[0]!,
        code: link.code,
        addresses: link.addresses,
        publicKeySha256: link.publicKeySha256,
        ...(link.name !== undefined ? { name: link.name } : {}),
      },
      deviceName,
    );
  }
}
