import type {RemoteAuthStore} from '../remote-auth.js';
import type {DevicePresence} from './presence.js';
import type {LiveActivityTokenStore} from './live-activity-tokens.js';

/** A legacy device that hasn't made a request for this long (counted from this release when it never has) is removed. */
export const LEGACY_DEVICE_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Removes the records left by pairings from before stable installation identity
 * (audit M4: "six My phone rows"). Re-pairing already replaces a device; these
 * are the old rows. A legacy device that authenticates is seen like any other
 * and stays while it keeps being used. Returns the removed ids.
 */
export async function pruneLegacyDevices(auth: Pick<RemoteAuthStore, 'legacyDevices' | 'revoke'>, presence: DevicePresence,
  options: {now?: () => number; tokens?: Pick<LiveActivityTokenStore, 'removeDevice'>} = {}): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const since = await presence.since();
  const removed: string[] = [];
  for (const {deviceId, pairedAt, lastRefreshedAt} of await auth.legacyDevices()) {
    const lastSeenAt = (await presence.get(deviceId)).lastSeenAt;
    // Any sign of use counts: a request, a token refresh, or the pairing itself (one made after this release).
    if (now - Math.max(lastSeenAt ?? 0, lastRefreshedAt, pairedAt, since) < LEGACY_DEVICE_IDLE_MS) continue;
    await auth.revoke(deviceId);
    await options.tokens?.removeDevice(deviceId).catch(() => undefined);
    await presence.forget(deviceId).catch(() => undefined);
    removed.push(deviceId);
  }
  return removed;
}
