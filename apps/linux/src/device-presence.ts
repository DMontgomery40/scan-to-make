/** Same request-only, five-minute presence rule as CounterpartKit.DeviceConnection. */
export function deviceConnected(device: { lastSeenAt?: number; legacy?: boolean }, now = Date.now()): boolean {
  if (device.legacy || device.lastSeenAt === undefined) return false;
  const age = now - device.lastSeenAt;
  return Number.isFinite(age) && age >= 0 && age < 300_000;
}
