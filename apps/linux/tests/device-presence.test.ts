import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceConnected } from '../src/device-presence';

test('credential refresh does not turn an absent phone into connected', () => {
  const now = 1_800_000_000_000;
  const refreshed = { lastRefreshedAt: now, lastSeenAt: now - 900_000 };
  assert.equal(deviceConnected(refreshed, now), false);
  for (const [age, expected] of [[0, true], [299_999, true], [300_000, false], [900_000, false], [-1, false], [NaN, false]] as const) {
    assert.equal(deviceConnected({lastSeenAt: now - age}, now), expected);
  }
  assert.equal(deviceConnected({}, now), false);
  assert.equal(deviceConnected({lastSeenAt: now, legacy: true}, now), false);
});
