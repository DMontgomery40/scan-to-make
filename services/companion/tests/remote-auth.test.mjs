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
const exchange = async (s, login = 'alice@example.test', scopes) => {
  const invite = await s.createPairing(login, scopes);
  return s.exchange(login, { code: invite.code, deviceName: 'Test phone' });
};

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

test('private persistence stores hashes only; revocation, expiry, device and login binding survive reopen', async (t) => {
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
  await denied(() =>
    other.authorize(
      'bob@example.test',
      a.deviceId,
      a.token,
      'generation:create'
    )
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
  assert.deepEqual(health.body, { status: 'ok', protocolVersion: '0.1.0' });
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
  assert.equal(
    (
      await wire(server, '/healthz', {
        headers: {
          ...credentials(a),
          'tailscale-user-login': 'bob@example.test',
        },
      })
    ).status,
    401
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
