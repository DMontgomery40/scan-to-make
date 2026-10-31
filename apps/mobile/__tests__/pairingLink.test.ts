import { isPairingLink, parsePairingQR } from '../src/companion/pairingLink';

const code = 'A'.repeat(16) + 'b_-'.repeat(5) + 'z';
const now = 1_800_000_000_000;
const link = (extra = '') =>
  `scantomake://pair?v=1&u=${encodeURIComponent(
    'https://mac.tail1234.ts.net',
  )}&c=${code}&e=${now + 300_000}${extra}`;

test('a companion QR link gives its address and one-time code', () => {
  expect(isPairingLink(link())).toBe(true);
  expect(parsePairingQR(link(), now)).toEqual({
    baseUrl: 'https://mac.tail1234.ts.net',
    code,
  });
});

test('the older invitation JSON in a QR still pairs', () => {
  const json = JSON.stringify({
    version: 1,
    baseUrl: 'https://mac.tail1234.ts.net',
    code,
    expiresAt: now + 1,
  });
  expect(parsePairingQR(json, now).code).toBe(code);
});

test('expired, malformed or foreign codes are refused', () => {
  expect(() => parsePairingQR(link(), now + 300_000)).toThrow(
    expect.objectContaining({ code: 'expired-invitation' }),
  );
  for (const bad of [
    link().replace('v=1', 'v=2'),
    link().replace(encodeURIComponent('https://'), 'http%3A%2F%2F'),
    link().replace(code, 'short'),
    'https://example.com/pair?c=x',
    link('&name=Mac'),
    link('&c=' + code),
    'hello',
  ]) {
    expect(() => parsePairingQR(bad, now)).toThrow(
      expect.objectContaining({ code: 'invalid-invitation' }),
    );
  }
});
