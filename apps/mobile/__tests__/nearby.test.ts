import { formatPairingLink } from '@scan-to-make/contracts/pairing-link';
import { pairingError, type CompanionNative, type PairingStatus } from '../src/companion/pairing';
import {
  formatNearbyCode,
  pairNearby,
  type NearbyAnswer,
  type NearbyNative,
} from '../src/companion/nearby';

const S = 'd3'.repeat(32);
const code = 'A'.repeat(32);
const addresses = ['https://192.168.68.123:9077', 'https://Mac-mini.local:9077'];
const paired: PairingStatus = { state: 'paired', baseUrl: addresses[0], deviceId: 'id', expiresAt: 2000000000000 };
const link = (extra: Partial<{ publicKeySha256: string }> = {}) =>
  formatPairingLink({ version: 2, code, expiresAt: Date.now() + 300000, addresses, publicKeySha256: S, name: 'Mac mini', ...extra });

function companionMock(): CompanionNative {
  return {
    status: jest.fn(async () => paired),
    pair: jest.fn(async () => paired),
    pairAddresses: jest.fn(async () => paired),
    check: jest.fn(async () => paired),
    disconnect: jest.fn(async () => ({ state: 'disconnected' as const })),
    cancel: jest.fn(async () => {}),
  };
}
function nearbyMock(answers: Array<NearbyAnswer | { code: string }>): NearbyNative {
  return {
    browse: jest.fn(async () => [{ name: 'Mac mini', publicKeySha256: S }]),
    start: jest.fn(async () => ({ code: '482913', publicKeySha256: S, baseUrl: 'https://192.168.68.123:9077', expiresAt: Date.now() + 120000 })),
    result: jest.fn(async () => {
      const next = answers.shift()!;
      if ('code' in next) throw next;
      return next;
    }),
    cancel: jest.fn(async () => {}),
  };
}

it('shows the code, waits for Allow, then pairs through the v2 path pinned to the key the phone saw', async () => {
  const nearby = nearbyMock([{ status: 'waiting', expiresAt: 1 }, { status: 'allowed', link: link() }]);
  const companion = companionMock();
  const shown: string[] = [];
  await expect(pairNearby(nearby, companion, 'Mac mini', "David's iPhone", s => shown.push(formatNearbyCode(s.code)))).resolves.toEqual(paired);
  expect(shown).toEqual(['482 913']);
  expect(nearby.start).toHaveBeenCalledWith('Mac mini', "David's iPhone");
  expect(nearby.result).toHaveBeenCalledTimes(2);
  expect(companion.pairAddresses).toHaveBeenCalledWith(addresses, code, "David's iPhone", S);
  expect(companion.pair).not.toHaveBeenCalled();
});

it('a refusal, a link for another key, or a link that is not v2 never pairs', async () => {
  for (const [answer, expected] of [
    [{ status: 'denied' }, 'nearby-denied'],
    [{ status: 'allowed', link: link({ publicKeySha256: 'ab'.repeat(32) }) }, 'invalid-response'],
    [{ status: 'allowed', link: formatPairingLink({ version: 1, baseUrl: addresses[0], code, expiresAt: Date.now() + 300000, certificateSha256: S }) }, 'invalid-response'],
    [{ status: 'allowed', link: 'scantomake://pair?v=2' }, 'invalid-response'],
  ] as const) {
    const companion = companionMock();
    await expect(pairNearby(nearbyMock([answer]), companion, 'Mac mini', 'Phone', () => {})).rejects.toEqual({ code: expected });
    expect(companion.pairAddresses).not.toHaveBeenCalled();
  }
  expect(pairingError({ code: 'nearby-denied' })).toMatch(/Allow on your Mac/);
  expect(pairingError({ code: 'nearby-expired' })).toMatch(/too long/);
  expect(pairingError({ code: 'local-network' })).toMatch(/Local Network/);
});

it('a dropped wait is asked again, but not forever; other failures end it', async () => {
  const retried = nearbyMock([{ code: 'network' }, { code: 'timeout' }, { status: 'allowed', link: link() }]);
  await expect(pairNearby(retried, companionMock(), 'Mac mini', 'Phone', () => {})).resolves.toEqual(paired);
  const gone = nearbyMock([{ code: 'network' }, { code: 'network' }, { code: 'network' }]);
  await expect(pairNearby(gone, companionMock(), 'Mac mini', 'Phone', () => {})).rejects.toEqual({ code: 'network' });
  await expect(pairNearby(nearbyMock([{ code: 'nearby-expired' }]), companionMock(), 'Mac mini', 'Phone', () => {})).rejects.toEqual({ code: 'nearby-expired' });
  await expect(pairNearby(nearbyMock([{ code: 'cancelled' }]), companionMock(), 'Mac mini', 'Phone', () => {})).rejects.toEqual({ code: 'cancelled' });
});
