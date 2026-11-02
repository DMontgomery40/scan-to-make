import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A missing export is asserted as missing behavior, before implementation exists.
const authModule = await import('../dist/remote-auth.js').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
async function fixture(t) {
  assert.equal(
    typeof authModule.RemoteAuthStore,
    'function',
    'private auth registry exists'
  );
  const root = await mkdtemp(join(tmpdir(), 'remote-auth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const directory = join(root, 'private');
  const clock = () => now;
  const store = await authModule.RemoteAuthStore.create(
    directory,
    {
      host: 'companion.example-tail.ts.net',
      allowedLogins: ['alice@example.test', 'bob@example.test'],
    },
    clock
  );
  return {
    store,
    directory,
    clock,
    advance: (ms) => {
      now += ms;
    },
  };
}
const denied = (f, code = 'unauthorized') =>
  assert.rejects(f, (e) => e.code === code);
// Pairings minted by the generation-era default; the phone default is tested separately.
const LEGACY_SCOPES = ['generation:health', 'generation:create'];
const exchange = async (s, login = 'alice@example.test', scopes = LEGACY_SCOPES) => {
  const invite = await s.createPairing(login, scopes);
  return s.exchange(login, { code: invite.code, deviceName: 'Test phone' });
};

test('re-pairing the same installation replaces its credential while equal names on separate phones remain separate', async (t) => {
  const { store, directory, clock } = await fixture(t);
  const installationKey = 'a'.repeat(43);
  const pair = async (key, name = 'Kitchen iPhone') => {
    const { code } = await store.createPairing('alice@example.test');
    return store.exchange('alice@example.test', { code, deviceName: name, installationKey: key });
  };
  const first = await pair(installationKey);
  const secondPhone = await pair('b'.repeat(43));
  let current = first;
  for (let i = 0; i < 5; i++) current = await pair(installationKey, 'David’s iPhone');
  assert.equal(current.deviceId, first.deviceId);
  assert.notEqual(current.token, first.token);
  const devices = await store.listDevices();
  assert.equal(devices.length, 2);
  assert.equal(devices.find(d => d.deviceId === first.deviceId).deviceName, 'David’s iPhone');
  assert.ok(devices.every(d => !('installationKeyHash' in d) && !('installationKey' in d)));
  assert.ok(!(await readFile(join(directory, 'auth.json'), 'utf8')).includes(installationKey));
  const reopened = await authModule.RemoteAuthStore.open(directory, clock);
  await denied(() => reopened.authorize('alice@example.test', first.deviceId, first.token, 'generation:health'));
  await reopened.authorize('alice@example.test', current.deviceId, current.token, 'generation:health');
  await reopened.authorize('alice@example.test', secondPhone.deviceId, secondPhone.token, 'generation:health');
});

test('a legacy row joins an installation only with its existing token, never its public id or shared name', async (t) => {
  const { store } = await fixture(t);
  const legacy = await exchange(store);
  const otherLegacy = await exchange(store);
  const pair = async (installationKey, previous) => {
    const { code } = await store.createPairing('alice@example.test');
    return store.exchange('alice@example.test', { code, deviceName: 'Test phone', installationKey }, previous);
  };
  const attacker = await pair('c'.repeat(43), { deviceId: legacy.deviceId, token: 'x'.repeat(43) });
  assert.notEqual(attacker.deviceId, legacy.deviceId);
  const upgraded = await pair('d'.repeat(43), { deviceId: legacy.deviceId, token: legacy.token });
  assert.equal(upgraded.deviceId, legacy.deviceId);
  assert.equal((await store.listDevices()).length, 3);
  await denied(() => store.authorize('alice@example.test', legacy.deviceId, legacy.token, 'generation:health'));
  await store.authorize('alice@example.test', otherLegacy.deviceId, otherLegacy.token, 'generation:health');
  // A credential does not let a different installation silently take ownership of an already-keyed row.
  const distinct = await pair('e'.repeat(43), { deviceId: upgraded.deviceId, token: upgraded.token });
  assert.notEqual(distinct.deviceId, upgraded.deviceId);
  await store.authorize('alice@example.test', upgraded.deviceId, upgraded.token, 'generation:health');
});

test('single-use code is login bound, expires within five minutes and never survives reuse', async (t) => {
  const { store, advance } = await fixture(t);
  const invite = await store.createPairing('alice@example.test');
  assert.equal(invite.expiresAt - 1_800_000_000_000, 300_000);
  assert.equal(new URL(invite.qrPayload).searchParams.get('c'), invite.code);
  await denied(() =>
    store.exchange('bob@example.test', {
      code: invite.code,
      deviceName: 'Other',
    })
  );
  const phone = await store.exchange('alice@example.test', {
    code: invite.code,
    deviceName: 'Phone',
  });
  assert.ok(phone.token.length >= 43);
  await denied(() =>
    store.exchange('alice@example.test', {
      code: invite.code,
      deviceName: 'Replay',
    })
  );
  const expired = await store.createPairing('alice@example.test');
  advance(300_000);
  await denied(() =>
    store.exchange('alice@example.test', {
      code: expired.code,
      deviceName: 'Late',
    })
  );
});

test('private persistence stores hashes only; revocation, expiry and device binding survive reopen; the path does not bind the device', async (t) => {
  const { store, directory, clock, advance } = await fixture(t);
  const a = await exchange(store),
    b = await exchange(store);
  const persisted = await readFile(join(directory, 'auth.json'), 'utf8');
  assert.ok(!persisted.includes(a.token));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
  const other = await authModule.RemoteAuthStore.open(directory, clock);
  await other.authorize(
    'alice@example.test',
    a.deviceId,
    a.token,
    'generation:create'
  );
  await denied(() =>
    other.authorize(
      'alice@example.test',
      b.deviceId,
      a.token,
      'generation:create'
    )
  );
  // Auth v2: one credential works over every allowed path (LAN, VPN, Tailscale login),
  // so a device paired through alice's login also works through bob's. Unlisted logins never do.
  await other.authorize('bob@example.test', a.deviceId, a.token, 'generation:create');
  await assert.rejects(
    () => other.authorize('mallory@example.test', a.deviceId, a.token, 'generation:health'),
    (e) => e.code === 'unauthorized'
  );
  await other.revoke(a.deviceId);
  await denied(() =>
    store.authorize(
      'alice@example.test',
      a.deviceId,
      a.token,
      'generation:health'
    )
  );
  await store.authorize(
    'alice@example.test',
    b.deviceId,
    b.token,
    'generation:health'
  );
  advance(30 * 24 * 60 * 60 * 1000);
  await denied(() =>
    store.authorize(
      'alice@example.test',
      b.deviceId,
      b.token,
      'generation:health'
    )
  );
});

test('scopes are local-admin assigned and tokens cannot access ungranted operations', async (t) => {
  const { store } = await fixture(t);
  const p = await exchange(store, 'alice@example.test', ['generation:health']);
  await store.authorize(
    'alice@example.test',
    p.deviceId,
    p.token,
    'generation:health'
  );
  await denied(
    () =>
      store.authorize(
        'alice@example.test',
        p.deviceId,
        p.token,
        'generation:create'
      ),
    'forbidden'
  );
  await assert.rejects(() =>
    store.createPairing('alice@example.test', ['printer:dispatch'])
  );
  await assert.rejects(() => store.createPairing('not-allowed@example.test'));
  await denied(() =>
    store.exchange('alice@example.test', {
      code: 'x',
      deviceName: 'x',
      scopes: ['generation:create'],
    })
  );
});

test('racing exchanges cannot redeem twice, limits survive restart, and corrupt or locked state fails closed', async (t) => {
  const { store, directory, clock, advance } = await fixture(t);
  const invite = await store.createPairing('alice@example.test');
  const results = await Promise.allSettled([
    store.exchange('alice@example.test', {
      code: invite.code,
      deviceName: 'A',
    }),
    store.exchange('alice@example.test', {
      code: invite.code,
      deviceName: 'B',
    }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  for (let i = 0; i < 5; i++)
    await store.reservePairAttempt('alice@example.test');
  const other = await authModule.RemoteAuthStore.open(directory, clock);
  await denied(
    () => other.reservePairAttempt('alice@example.test'),
    'rate-limited'
  );
  advance(60_000);
  await other.reservePairAttempt('alice@example.test');
  await mkdir(join(directory, '.lock'));
  await denied(
    () => store.createPairing('alice@example.test'),
    'auth-unavailable'
  );
  await rm(join(directory, '.lock'), { recursive: true });
  await writeFile(join(directory, 'auth.json'), '{}');
  await denied(
    () =>
      store.authorize('alice@example.test', 'any', 'any', 'generation:health'),
    'auth-unavailable'
  );
});

const { request: httpRequest } = await import('node:http');
const { startCompanionServer } = await import('../dist/server.js');
const forwarded = JSON.parse(
  await readFile(
    new URL('./fixtures/tailscale-serve-v1.94.2.json', import.meta.url),
    'utf8'
  )
);
async function httpFixture(t) {
  const f = await fixture(t);
  const server = await startCompanionServer({ port: 0, remoteAuth: f.store });
  t.after(() => server.close());
  return { ...f, server };
}

test('HTTP pairing upgrades a legacy credential using native authorization headers', async (t) => {
  const { store, server } = await httpFixture(t);
  const original = await exchange(store);
  const { code } = await store.createPairing('alice@example.test');
  const response = await wire(server, '/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${original.token}`, 'x-scan-device': original.deviceId },
    body: JSON.stringify({ code, deviceName: 'David’s iPhone', installationKey: 'f'.repeat(43) }),
  });
  assert.equal(response.status, 200);
  const upgraded = response.body;
  assert.equal(upgraded.deviceId, original.deviceId);
  assert.notEqual(upgraded.token, original.token);
  assert.equal((await store.listDevices()).length, 1);
  await denied(() => store.authorize('alice@example.test', original.deviceId, original.token, 'generation:health'));
});
function wire(
  server,
  path = '/healthz',
  { method = 'GET', headers = {}, body, forward = true } = {}
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      server.url + path,
      {
        method,
        headers: { ...(forward ? forwarded.expected : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
const credentials = (p) => ({
  authorization: `Bearer ${p.token}`,
  'x-scan-device': p.deviceId,
});
const pairHttp = (s, code) =>
  wire(s, '/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'HTTP phone' }),
  });

test('HTTP source-derived Serve fixture pairs a phone that then passes the authenticated health check', async (t) => {
  const { store, server } = await httpFixture(t);
  const invite = await store.createPairing('alice@example.test');
  const paired = await pairHttp(server, invite.code);
  assert.equal(paired.status, 200);
  const health = await wire(server, '/healthz', {
    headers: credentials(paired.body),
  });
  assert.equal(health.status, 200);
  // capabilities is additive; without the objects service there are no generic confirmations to answer.
  assert.deepEqual(health.body, { status: 'ok', protocolVersion: '0.1.0', capabilities: { genericConfirmations: false, materialChoice: false, mcpUpdates: false, publishedModels: false } });
});

test('HTTP rejects missing, wrong and duplicated identity, browser origins, Funnel and local-mode fallback', async (t) => {
  const { store, server } = await httpFixture(t);
  const p = await exchange(store);
  for (const headers of [
    { host: '127.0.0.1:9077' },
    { host: '' },
    { 'tailscale-user-login': '' },
    { 'tailscale-user-login': 'other@example.test' },
    { 'tailscale-user-login': ['alice@example.test', 'alice@example.test'] },
    { 'x-forwarded-host': 'wrong.ts.net' },
    { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-proto': '' },
    { 'tailscale-funnel-request': '?1' },
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'same-origin' },
  ])
    assert.equal(
      (
        await wire(server, '/healthz', {
          headers: { ...credentials(p), ...headers },
        })
      ).status,
      403,
      JSON.stringify(headers)
    );
  assert.equal(
    (await wire(server, '/healthz', { forward: false })).status,
    403
  );
  assert.equal((await wire(server)).status, 401);
});

test('HTTP rejects invalid, reused and expired codes, limits malformed attempts and body size', async (t) => {
  const { store, server, advance } = await httpFixture(t);
  assert.equal((await pairHttp(server, undefined)).status, 401);
  const invite = await store.createPairing('alice@example.test');
  assert.equal((await pairHttp(server, invite.code)).status, 200);
  assert.equal((await pairHttp(server, invite.code)).status, 401);
  const late = await store.createPairing('alice@example.test');
  advance(300_000);
  assert.equal((await pairHttp(server, late.code)).status, 401);
  assert.equal(
    (
      await wire(server, '/v1/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(4097),
      })
    ).status,
    413
  );
  for (let i = 0; i < 3; i++)
    assert.equal((await pairHttp(server, 'bad')).status, 401);
  assert.equal((await pairHttp(server, 'bad')).status, 429);
});

test('HTTP token scopes, expiry, revocation and per-device credentials prevent cross-device access', async (t) => {
  const { store, server, advance } = await httpFixture(t);
  const a = await exchange(store),
    b = await exchange(store, 'alice@example.test', ['generation:health']);
  assert.equal(
    (
      await wire(server, '/healthz', {
        headers: { ...credentials(a), 'x-scan-device': b.deviceId },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await wire(server, '/healthz', {
        headers: {
          ...credentials(a),
          authorization: 'Bearer ' + 'z'.repeat(43),
        },
      })
    ).status,
    401
  );
  // The credential, not the path, is the device: another allowed login may carry it,
  // and a login outside the allow list is stopped before the credential is checked.
  assert.equal(
    (
      await wire(server, '/healthz', {
        headers: {
          ...credentials(a),
          'tailscale-user-login': 'bob@example.test',
        },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await wire(server, '/healthz', {
        headers: {
          ...credentials(a),
          'tailscale-user-login': 'mallory@example.test',
        },
      })
    ).status,
    403
  );
  const projectsOnly = await exchange(store, 'alice@example.test', [
    'projects:read',
    'projects:write',
  ]);
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(projectsOnly) }))
      .status,
    403
  );
  await store.revoke(a.deviceId);
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(a) })).status,
    401
  );
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(b) })).status,
    200
  );
  for (const route of [
    '/v1/generate',
    '/v1/revoke',
    '/v1/devices',
    '/v1/print',
    '/v1/discovery',
    '/v1/journal',
  ]) {
    assert.equal(
      (await wire(server, route, { method: 'POST', headers: credentials(b) }))
        .status,
      404
    );
  }
  advance(30 * 24 * 60 * 60 * 1000);
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(b) })).status,
    401
  );
});

test('local default still works directly and refuses proxy headers instead of bypassing pairing', async (t) => {
  const server = await startCompanionServer({ port: 0 });
  t.after(() => server.close());
  assert.equal(
    (await wire(server, '/healthz', { forward: false })).status,
    200
  );
  const host = new URL(server.url).host;
  assert.equal(
    (await wire(server, '/healthz', { headers: { host } })).status,
    403
  );
  assert.equal(
    (await wire(server, '/v1/pair', { forward: false, method: 'POST' })).status,
    404
  );
});

const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const admin = fileURLToPath(
  new URL('../dist/remote-auth-cli.js', import.meta.url)
);
const serve = fileURLToPath(
  new URL('../dist/server-cli.js', import.meta.url)
);
function runCli(file, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (x) => (stdout += x));
    p.stderr.on('data', (x) => (stderr += x));
    p.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
test('operator CLI initializes once, returns QR material, lists and individually revokes; startup configuration never falls back', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  const init = await runCli(admin, [
    'init',
    directory,
    'companion.example-tail.ts.net',
    'alice@example.test',
  ]);
  assert.equal(init.code, 0, init.stderr);
  assert.notEqual(
    (
      await runCli(admin, [
        'init',
        directory,
        'evil.example',
        'bob@example.test',
      ])
    ).code,
    0
  );
  const invitation = await runCli(admin, [
    'pair-capture',
    directory,
    'alice@example.test',
  ]);
  assert.equal(invitation.code, 0, invitation.stderr);
  assert.match(invitation.stderr, /[▄▀█]/);
  const pageUrl = JSON.parse(invitation.stdout).pairingPageUrl;
  assert.match(pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  const page = await fetch(pageUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<svg/);
  const store = await authModule.RemoteAuthStore.open(directory);
  const p = await store.exchange('alice@example.test', {
    code: JSON.parse(invitation.stdout).code,
    deviceName: 'CLI paired',
  });
  const devices = await runCli(admin, ['devices', directory]);
  assert.equal(JSON.parse(devices.stdout)[0].deviceId, p.deviceId);
  assert.ok(!devices.stdout.includes(p.token));
  assert.equal(
    (await runCli(admin, ['revoke', directory, p.deviceId])).code,
    0
  );
  await denied(() =>
    store.authorize(
      'alice@example.test',
      p.deviceId,
      p.token,
      'generation:health'
    )
  );
  assert.notEqual((await runCli(admin, ['not-a-command', directory])).code, 0);
  const failure = await runCli(serve, [], {
    SCAN_TO_MAKE_REMOTE_AUTH_DIR: join(root, 'missing'),
  });
  assert.notEqual(failure.code, 0);
  assert.ok(!failure.stdout.includes('ready'));
});

test('store rejects symlinks, loose permissions, oversized/corrupt state and changed configuration over HTTP', async (t) => {
  const { store, server, directory } = await httpFixture(t);
  const p = await exchange(store),
    path = join(directory, 'auth.json');
  const original = await readFile(path);
  const { chmod, symlink } = await import('node:fs/promises');
  await chmod(path, 0o644);
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(p) })).status,
    503
  );
  await chmod(path, 0o600);
  const outside = join(directory, 'backup.json');
  await writeFile(outside, original, { mode: 0o600 });
  await rm(path);
  await symlink(outside, path);
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(p) })).status,
    503
  );
  await rm(path);
  await writeFile(path, 'x'.repeat(128 * 1024 + 1), { mode: 0o600 });
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(p) })).status,
    503
  );
  const changed = JSON.parse(original);
  changed.configuration.allowedLogins.push('new@example.test');
  await writeFile(path, JSON.stringify(changed));
  assert.equal(
    (await wire(server, '/healthz', { headers: credentials(p) })).status,
    503
  );
});

test('invitations are bounded and only hashes are persisted before redemption', async (t) => {
  const { store, directory, advance } = await fixture(t);
  const invite = await store.createPairing('alice@example.test');
  assert.ok(
    !(await readFile(join(directory, 'auth.json'), 'utf8')).includes(
      invite.code
    )
  );
  for (let i = 1; i < 8; i++) await store.createPairing('alice@example.test');
  await denied(() => store.createPairing('alice@example.test'), 'rate-limited');
  advance(300_000);
  await store.createPairing('alice@example.test');
});

test(
  'pairing has a real body deadline and does not issue credentials for incomplete JSON',
  { timeout: 8000 },
  async (t) => {
    const { store, server } = await httpFixture(t);
    const invite = await store.createPairing('alice@example.test');
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(
        server.url + '/v1/pair',
        {
          method: 'POST',
          headers: {
            ...forwarded.expected,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.write('{"code":"');
    });
    assert.equal(result, 400);
    assert.equal((await store.listDevices()).length, 0);
    assert.equal((await pairHttp(server, invite.code)).status, 200);
  }
);

test('package consumers can initialize authentication through the supported subpath', async () => {
  const exported = await import('@scan-to-make/companion/remote-auth').catch(
    (e) => {
      if (e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return {};
      throw e;
    }
  );
  assert.equal(typeof exported.RemoteAuthStore, 'function');
});

test('valid repeated init refuses an existing registry and preserves a paired device byte-for-byte', async (t) => {
  const { store, directory } = await fixture(t);
  const p = await exchange(store);
  const before = await readFile(join(directory, 'auth.json'));
  const result = await runCli(admin, [
    'init',
    directory,
    'companion.example-tail.ts.net',
    'alice@example.test',
  ]);
  assert.equal(result.code, 1);
  assert.deepEqual(await readFile(join(directory, 'auth.json')), before);
  await store.authorize(
    'alice@example.test',
    p.deviceId,
    p.token,
    'generation:create'
  );
});

test('existing generation pairing never acquires project/capture authority and explicit scopes remain revocable',async t=>{
 const {store,directory,clock}=await fixture(t);
 const old=await exchange(store);
 const reopened=await authModule.RemoteAuthStore.open(directory,clock);
 const added=['projects:read','projects:write','captures:read','captures:import'];
 for(const scope of added)await denied(()=>reopened.authorize('alice@example.test',old.deviceId,old.token,scope),'forbidden');
 const capture=await exchange(reopened,'alice@example.test',added);
 assert.deepEqual(capture.scopes,added);
 for(const scope of added)await reopened.authorize('alice@example.test',capture.deviceId,capture.token,scope);
 await denied(()=>reopened.authorize('alice@example.test',capture.deviceId,capture.token,'generation:create'),'forbidden');
 await reopened.revoke(capture.deviceId);
 await denied(()=>reopened.authorize('alice@example.test',capture.deviceId,capture.token,'captures:read'));
});

const contracts = await import('@scan-to-make/contracts/device-auth');
const DAY = 24 * 60 * 60 * 1000;

test('a phone pairing grants exactly the scopes the iPhone app uses, and the credential shape is unchanged', async (t) => {
  const { store } = await fixture(t);
  const invite = await store.createPairing('alice@example.test');
  const phone = await store.exchange('alice@example.test', { code: invite.code, deviceName: 'Phone' });
  assert.deepEqual(phone.scopes, [...contracts.PHONE_SCOPES]);
  assert.ok(phone.scopes.includes('printer-handoff:use'));
  // The phone's own validator: at least two scopes, including generation:health.
  assert.ok(phone.scopes.length >= 2 && phone.scopes.includes('generation:health'));
  assert.deepEqual(Object.keys(phone).sort(), ['deviceId', 'expiresAt', 'protocolVersion', 'scopes', 'token']);
  assert.equal(phone.protocolVersion, '0.1.0');
  assert.deepEqual(contracts.DeviceCredentialSchema.parse(phone), phone);
  assert.equal(phone.expiresAt - 1_800_000_000_000, contracts.DEVICE_CREDENTIAL_LIFETIME_MS);
});

test('rolling refresh extends a live credential with the same token; expired or revoked ones stay dead', async (t) => {
  const { store, directory, advance } = await fixture(t);
  const phone = await exchange(store, 'alice@example.test', [...contracts.PHONE_SCOPES]);
  advance(29 * DAY);
  // Refresh is identity-bound, not path-bound: bob's allowed login carries alice's device.
  const refreshed = await store.refresh('bob@example.test', phone.deviceId, phone.token);
  assert.deepEqual(refreshed, { ...phone, expiresAt: 1_800_000_000_000 + 59 * DAY });
  assert.ok(!(await readFile(join(directory, 'auth.json'), 'utf8')).includes(phone.token));
  advance(29 * DAY);
  await store.authorize('alice@example.test', phone.deviceId, phone.token, 'printer-handoff:use');
  const [device] = await store.listDevices();
  assert.equal(device.lastRefreshedAt, 1_800_000_000_000 + 29 * DAY);
  assert.equal(device.pairedAt, 1_800_000_000_000);
  assert.deepEqual(device.pairedVia, { transport: 'tailscale', login: 'alice@example.test' });
  assert.equal(device.tokenHash, undefined);
  advance(DAY);
  await denied(() => store.refresh('alice@example.test', phone.deviceId, phone.token));
  const other = await exchange(store);
  await denied(() => store.refresh('alice@example.test', other.deviceId, phone.token));
  await denied(() => store.refresh('mallory@example.test', other.deviceId, other.token));
  await store.revoke(other.deviceId);
  await denied(() => store.refresh('alice@example.test', other.deviceId, other.token));
});

test('HTTP refresh returns the stored credential shape and needs a valid device credential', async (t) => {
  const { store, server, advance } = await httpFixture(t);
  const phone = await exchange(store, 'alice@example.test', [...contracts.PHONE_SCOPES]);
  advance(10 * DAY);
  const refreshed = await wire(server, '/v1/auth/refresh', { method: 'POST', headers: credentials(phone) });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(contracts.DeviceCredentialSchema.parse(refreshed.body), {
    ...phone,
    expiresAt: 1_800_000_000_000 + 40 * DAY,
  });
  assert.equal((await wire(server, '/v1/auth/refresh', { headers: credentials(phone) })).status, 405);
  assert.equal((await wire(server, '/v1/auth/refresh', { method: 'POST' })).status, 401);
  assert.equal(
    (await wire(server, '/v1/auth/refresh', { method: 'POST', headers: { ...credentials(phone), 'x-scan-device': randomUUID() } })).status,
    401
  );
  assert.equal(
    (await wire(server, '/v1/auth/refresh', { method: 'POST', headers: { ...credentials(phone), 'tailscale-user-login': 'mallory@example.test' } })).status,
    403
  );
});

async function writeV1(directory, state) {
  await mkdir(directory, { mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify(state));
  await writeFile(join(directory, 'auth.json'), bytes, { mode: 0o600 });
  return bytes;
}

test('a version 1 LAN store migrates in place: same devices, hashes, scopes and expiry, a byte-exact backup, no escalation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'auth');
  const now = 1_800_000_000_000;
  const token = 'A'.repeat(43);
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const configuration = {
    transport: 'lan', host: '192.168.68.123:9077', allowedLogins: ['lan'],
    certificateSha256: 'b'.repeat(64),
  };
  const capture = ['generation:health', 'projects:read', 'projects:write', 'captures:read', 'captures:import'];
  const phoneId = randomUUID(), oldId = randomUUID();
  const original = await writeV1(directory, {
    version: 1,
    configuration,
    codes: [{ codeHash: 'c'.repeat(64), login: 'lan', scopes: capture, expiresAt: now + 60_000 }],
    devices: [
      { deviceId: phoneId, deviceName: 'My phone', login: 'lan', tokenHash, scopes: capture, expiresAt: now + 20 * DAY },
      { deviceId: oldId, deviceName: 'Expired', login: 'lan', tokenHash: 'd'.repeat(64), scopes: capture, expiresAt: now - 1 },
    ],
    attempts: [],
  });
  const store = await authModule.RemoteAuthStore.open(directory, () => now);
  const migrated = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.configuration, configuration);
  assert.equal(migrated.codes.length, 1);
  assert.deepEqual(migrated.devices, [{
    deviceId: phoneId, deviceName: 'My phone', tokenHash, scopes: capture,
    pairedAt: now - 10 * DAY, lastRefreshedAt: now - 10 * DAY, expiresAt: now + 20 * DAY,
    pairedVia: { transport: 'lan', login: 'lan' },
  }]);
  assert.deepEqual(await readFile(join(directory, 'auth.v1.json')), original);
  assert.equal((await stat(join(directory, 'auth.v1.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
  // The phone's stored token still works, and gains no scope it never had.
  await store.authorize('lan', phoneId, token, 'captures:import');
  await denied(() => store.authorize('lan', phoneId, token, 'printer-handoff:use'), 'forbidden');
  // Reopening is a no-op and never overwrites the first backup.
  await authModule.RemoteAuthStore.open(directory, () => now);
  assert.deepEqual(await readFile(join(directory, 'auth.v1.json')), original);
  assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).version, 2);
});

test('an unknown store version fails closed and is left untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'auth');
  const original = await writeV1(directory, {
    version: 3, configuration: { host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'] },
    codes: [], devices: [], attempts: [],
  });
  await denied(() => authModule.RemoteAuthStore.open(directory), 'auth-unavailable');
  assert.deepEqual(await readFile(join(directory, 'auth.json')), original);
  await assert.rejects(() => stat(join(directory, 'auth.v1.json')));
});

test('CLI pair mints the phone scopes; pair-capture omits only printing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-cli-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  assert.equal((await runCli(admin, ['init', directory, 'companion.example-tail.ts.net', 'alice@example.test'])).code, 0);
  const store = await authModule.RemoteAuthStore.open(directory);
  const scopesOf = async (command) => {
    const invitation = await runCli(admin, [command, directory, 'alice@example.test']);
    assert.equal(invitation.code, 0, invitation.stderr);
    const code = JSON.parse(invitation.stdout).code;
    return (await store.exchange('alice@example.test', { code, deviceName: command })).scopes;
  };
  assert.deepEqual(await scopesOf('pair'), [...contracts.PHONE_SCOPES]);
  assert.deepEqual(await scopesOf('pair-capture-and-printer-handoff'), [...contracts.PHONE_SCOPES]);
  assert.deepEqual(
    await scopesOf('pair-capture'),
    contracts.PHONE_SCOPES.filter((scope) => scope !== 'printer-handoff:use')
  );
  const devices = JSON.parse((await runCli(admin, ['devices', directory])).stdout);
  assert.deepEqual(devices.map((d) => d.pairedVia.transport), ['tailscale', 'tailscale', 'tailscale']);
});

test('a version 1 Serve store migrates with its login provenance, and a code minted before migration still pairs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-v1-serve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'auth');
  const now = 1_800_000_000_000;
  const { createHash } = await import('node:crypto');
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  const code = 'C'.repeat(32), token = 'T'.repeat(43), deviceId = randomUUID();
  await writeV1(directory, {
    version: 1,
    configuration: { host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test', 'bob@example.test'] },
    codes: [{ codeHash: sha(code), login: 'bob@example.test', scopes: ['generation:health', 'captures:read'], expiresAt: now + 60_000 }],
    devices: [{ deviceId, deviceName: 'Alice phone', login: 'alice@example.test', tokenHash: sha(token), scopes: ['generation:health', 'generation:create'], expiresAt: now + DAY }],
    attempts: [],
  });
  const store = await authModule.RemoteAuthStore.open(directory, () => now);
  const [device] = (await store.listDevices()).filter((d) => d.deviceId === deviceId);
  assert.deepEqual(device.pairedVia, { transport: 'tailscale', login: 'alice@example.test' });
  // Codes stay bound to the login that minted them.
  await denied(() => store.exchange('alice@example.test', { code, deviceName: 'Wrong login' }));
  const paired = await store.exchange('bob@example.test', { code, deviceName: 'Bob phone' });
  assert.deepEqual(paired.scopes, ['generation:health', 'captures:read']);
  await store.authorize('bob@example.test', deviceId, token, 'generation:create');
});

test('a busy lock defers migration: reads work on the version 1 file without writing; the next write migrates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-v1-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'auth');
  const now = 1_800_000_000_000;
  const { createHash } = await import('node:crypto');
  const token = 'B'.repeat(43), deviceId = randomUUID();
  const original = await writeV1(directory, {
    version: 1,
    configuration: { transport: 'lan', host: '192.168.1.2:9077', allowedLogins: ['lan'], certificateSha256: 'e'.repeat(64) },
    codes: [],
    devices: [{ deviceId, deviceName: 'My phone', login: 'lan', tokenHash: createHash('sha256').update(token).digest('hex'), scopes: ['generation:health', 'captures:read'], expiresAt: now + DAY }],
    attempts: [],
  });
  await mkdir(join(directory, '.lock'));
  const store = await authModule.RemoteAuthStore.open(directory, () => now);
  await store.authorize('lan', deviceId, token, 'captures:read');
  assert.deepEqual(await readFile(join(directory, 'auth.json')), original);
  await assert.rejects(() => stat(join(directory, 'auth.v1.json')));
  await rm(join(directory, '.lock'), { recursive: true });
  await store.createPairing('lan');
  assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).version, 2);
  assert.deepEqual(await readFile(join(directory, 'auth.v1.json')), original);
  await store.authorize('lan', deviceId, token, 'captures:read');
});

test('an older, different backup is never overwritten; the new one gets a hash suffix', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'auth-v1-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'auth');
  const original = await writeV1(directory, {
    version: 1,
    configuration: { host: 'companion.example-tail.ts.net', allowedLogins: ['alice@example.test'] },
    codes: [], devices: [], attempts: [],
  });
  await writeFile(join(directory, 'auth.v1.json'), 'stale', { mode: 0o600 });
  await authModule.RemoteAuthStore.open(directory, () => 1_800_000_000_000);
  const { createHash } = await import('node:crypto');
  const suffix = createHash('sha256').update(original).digest('hex').slice(0, 12);
  assert.equal(await readFile(join(directory, 'auth.v1.json'), 'utf8'), 'stale');
  assert.deepEqual(await readFile(join(directory, `auth.v1-${suffix}.json`)), original);
  assert.equal((await stat(join(directory, `auth.v1-${suffix}.json`))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).version, 2);
});

test('refreshing again within an hour writes nothing; the HTTP route refuses a body', async (t) => {
  const { store, server, directory, advance } = await httpFixture(t);
  const phone = await exchange(store, 'alice@example.test', [...contracts.PHONE_SCOPES]);
  advance(2 * DAY);
  const first = await store.refresh('alice@example.test', phone.deviceId, phone.token);
  const bytes = await readFile(join(directory, 'auth.json'));
  advance(30 * 60 * 1000);
  assert.deepEqual(await store.refresh('alice@example.test', phone.deviceId, phone.token), first);
  assert.deepEqual(await readFile(join(directory, 'auth.json')), bytes);
  // A busy lock does not fail a refresh that needs no write.
  await mkdir(join(directory, '.lock'));
  assert.deepEqual(await store.refresh('alice@example.test', phone.deviceId, phone.token), first);
  await rm(join(directory, '.lock'), { recursive: true });
  assert.equal(
    (await wire(server, '/v1/auth/refresh', { method: 'POST', headers: { ...credentials(phone), 'content-type': 'application/json' }, body: '{}' })).status,
    400
  );
});
