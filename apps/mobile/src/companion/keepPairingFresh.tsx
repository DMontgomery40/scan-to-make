import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useRequestGate, type RequestGate } from '../screens/requestGate';
import { companionNative, type CompanionNative } from './pairing';

const DAY = 86_400_000;
/**
 * A paired credential lasts 30 days. Under 20 days left, the phone asks your
 * Mac for another 30 days of the same credential, so at most about every 10
 * days (the Mac also turns away refreshes that come too often).
 */
export const REFRESH_WITHIN = 20 * DAY;
// Your Mac turned the credential away: this phone has to pair again.
const REFUSED = new Set(['unauthorized', 'forbidden', 'pairing-required']);

export type Freshness = 'fresh' | 'refreshed' | 'skipped' | 'pair-again';

/**
 * Keeps the paired Mac's credential alive (KAN-182). Quiet unless your Mac
 * refuses it; a Mac that can't be reached is simply asked again next time.
 * The request waits its turn in the app's one queue of calls to your Mac.
 */
export async function keepPairingFresh(
  native: CompanionNative,
  gate: RequestGate,
  now: () => number = Date.now,
): Promise<Freshness> {
  let status;
  try {
    status = await native.status();
  } catch {
    return 'skipped';
  }
  // Too late to refresh: your Mac accepts only a live credential.
  if (status.state === 'expired') return 'pair-again';
  if (status.state !== 'paired' || typeof status.expiresAt !== 'number')
    return 'skipped';
  if (status.expiresAt - now() > REFRESH_WITHIN) return 'fresh';
  const refresh = native.refresh;
  if (!refresh) return 'skipped';
  try {
    await gate(() => refresh());
    return 'refreshed';
  } catch (error) {
    const code = (error as { code?: string })?.code ?? '';
    return REFUSED.has(code) ? 'pair-again' : 'skipped';
  }
}

/**
 * Runs keepPairingFresh when the app opens and each time it comes back to
 * the front. Renders nothing; tells the app when the pairing needs a look.
 */
export function KeepPairingFresh({
  native = companionNative(),
  onPairAgain,
}: {
  native?: CompanionNative;
  /** Your Mac refused the credential: screens should read the pairing again. */
  onPairAgain: () => void;
}) {
  const gate = useRequestGate();
  const told = useRef(onPairAgain);
  told.current = onPairAgain;
  useEffect(() => {
    if (!native) return;
    let running = false;
    let live = true;
    const run = () => {
      if (running) return;
      running = true;
      keepPairingFresh(native, gate)
        .then(result => {
          if (live && result === 'pair-again') told.current();
        })
        .finally(() => {
          running = false;
        });
    };
    run();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') run();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [native, gate]);
  return null;
}
