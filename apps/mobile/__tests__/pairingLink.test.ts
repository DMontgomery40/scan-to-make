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

test('an optional certificate pin is read from f or certificateSha256', () => {
  const pin = '0f'.repeat(32);
  const lan = (extra: string) =>
    link(extra).replace(
      encodeURIComponent('https://mac.tail1234.ts.net'),
      encodeURIComponent('https://192.168.1.20:9077'),
    );
  expect(parsePairingQR(lan('&f=' + pin), now)).toEqual({
    baseUrl: 'https://192.168.1.20:9077',
    code,
    certificateSha256: pin,
  });
  // iOS only accepts a companion's own certificate on these hosts.
  for (const host of [
    'https://mac.local',
    'https://mac:9077',
    'https://[fd00::1]:9077',
  ]) {
    const json = JSON.stringify({
      version: 1,
      baseUrl: host,
      code,
      expiresAt: now + 1,
      certificateSha256: pin,
    });
    expect(parsePairingQR(json, now).baseUrl).toBe(host);
  }
  expect(() => parsePairingQR(link('&f=' + pin), now)).toThrow(
    expect.objectContaining({ code: 'invalid-invitation' }),
  );
  const json = JSON.stringify({
    version: 1,
    baseUrl: 'https://192.168.1.20:8443',
    code,
    expiresAt: now + 1,
    certificateSha256: pin,
  });
  expect(parsePairingQR(json, now)).toEqual({
    baseUrl: 'https://192.168.1.20:8443',
    code,
    certificateSha256: pin,
  });
  for (const bad of [
    pin.toUpperCase(),
    pin.slice(1),
    pin + '0',
    'zz'.repeat(32),
  ]) {
    expect(() => parsePairingQR(lan('&f=' + bad), now)).toThrow(
      expect.objectContaining({ code: 'invalid-invitation' }),
    );
  }
  expect(() => parsePairingQR(lan('&f=' + pin + '&f=' + pin), now)).toThrow();
});

test('the QR address must be a bare https origin, and multi-label .local names may be pinned', () => {
  const pin = '0f'.repeat(32);
  const json = JSON.stringify({
    version: 1,
    baseUrl: 'https://studio.office.local:9077',
    code,
    expiresAt: now + 1,
    certificateSha256: pin,
  });
  expect(parsePairingQR(json, now).baseUrl).toBe(
    'https://studio.office.local:9077',
  );
  for (const bad of [
    link().replace(
      encodeURIComponent('https://'),
      encodeURIComponent('https://user@'),
    ),
    link().replace(
      encodeURIComponent('.ts.net'),
      encodeURIComponent('.ts.net/extra'),
    ),
  ]) {
    expect(() => parsePairingQR(bad, now)).toThrow(
      expect.objectContaining({ code: 'invalid-invitation' }),
    );
  }
});

test('an unpinned QR must name a Tailscale address, as the phone requires', () => {
  for (const host of [
    'https://192.168.1.20:9077',
    'https://mac.local',
    'https://mac.example.com',
    'https://mac.tail1234.ts.net:8443',
  ]) {
    const unpinned = link().replace(
      encodeURIComponent('https://mac.tail1234.ts.net'),
      encodeURIComponent(host),
    );
    expect(() => parsePairingQR(unpinned, now)).toThrow(
      expect.objectContaining({ code: 'invalid-invitation' }),
    );
    const json = JSON.stringify({
      version: 1,
      baseUrl: host,
      code,
      expiresAt: now + 1,
    });
    expect(() => parsePairingQR(json, now)).toThrow(
      expect.objectContaining({ code: 'invalid-invitation' }),
    );
  }
  expect(parsePairingQR(link().replace('ts.net', 'ts.net%2F'), now)).toEqual({
    baseUrl: 'https://mac.tail1234.ts.net/',
    code,
  });
});
