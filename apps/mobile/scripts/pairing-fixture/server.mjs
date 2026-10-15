// Isolated local Simulator fixture. No Tailscale, account, TLS bypass or printer.
// Run after npm ci/build in services/companion. Invitations are written to a
// private temporary directory, never stdout. Only fixed synthetic identities.
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuthStore } from '../../../../services/companion/dist/remote-auth.js';
import { startGenerationServer } from '../../../../services/companion/dist/generation.js';
const root = await mkdtemp(join(tmpdir(), 'scan-pairing-fixture-'));
const auth = await RemoteAuthStore.create(join(root, 'auth'), {
  host: 'fixture.example.ts.net',
  allowedLogins: ['fixture@example.test'],
});
const nativeFaults = process.env.SCAN_NATIVE_FAULTS === '1';
const faultKey = nativeFaults ? randomBytes(32).toString('hex') : null;
if (faultKey)
  await writeFile(join(root, 'fault-key'), faultKey, { mode: 0o600 });
const captureEnabled = process.env.SCAN_CAPTURE_FIXTURE === '1';
let capture;
if (captureEnabled) {
  const { FileSavedProjectStorage } = await import(
    '../../../../services/project/dist/index.js'
  );
  const { CaptureStore } = await import(
    '../../../../services/companion/dist/capture-import.js'
  );
  const { createCaptureConverter } = await import(
    '../../../../services/companion/dist/capture-converter.js'
  );
  const storage = new FileSavedProjectStorage(join(root, 'projects'));
  const captures = new CaptureStore(
    storage,
    join(root, 'captures'),
    createCaptureConverter({
      executable: process.env.SCAN_TO_MAKE_CAPTURE_PYTHON || 'python3',
      temporaryRoot: join(root, 'workers'),
    }),
  );
  capture = { storage, captures };
}
const backend = await startGenerationServer({
  port: 0,
  remoteAuth: auth,
  capture,
});
await writeFile(join(root, 'mode'), 'ok', { mode: 0o600 });
async function invite() {
  const value = await auth.createPairing(
    'fixture@example.test',
    captureEnabled
      ? [
          'generation:health',
          'generation:create',
          'projects:read',
          'projects:write',
          'captures:read',
          'captures:import',
        ]
      : undefined,
  );
  await writeFile(
    join(root, 'invitation.json'),
    JSON.stringify({
      version: 1,
      baseUrl: 'http://127.0.0.1:9078',
      code: value.code,
      expiresAt: value.expiresAt,
    }),
    { mode: 0o600 },
  );
}
await invite();
process.on('SIGUSR1', () => invite().catch(() => {}));
process.on('SIGUSR2', () =>
  auth
    .listDevices()
    .then(devices => Promise.all(devices.map(d => auth.revoke(d.deviceId))))
    .catch(() => {}),
);
const proxy = createServer(async (req, res) => {
  if (nativeFaults && req.url?.startsWith('/__fixture/mode/')) {
    const selected = req.url.slice('/__fixture/mode/'.length);
    const allowed = [
      'ok',
      'wrong-hash',
      'wrong-type',
      'wrong-bytes',
      'oversized',
      'delayed',
    ];
    if (
      req.method !== 'POST' ||
      req.headers['x-fixture-key'] !== faultKey ||
      !allowed.includes(selected)
    ) {
      res.writeHead(403).end();
      return;
    }
    await writeFile(join(root, 'mode'), selected, { mode: 0o600 });
    res.writeHead(204).end();
    return;
  }
  const mode = (await readFile(join(root, 'mode'), 'utf8')).trim();
  if (mode === 'offline') {
    req.socket.destroy();
    return;
  }
  if (mode === 'redirect') {
    res.writeHead(302, { Location: 'https://other.example.ts.net/healthz' });
    res.end();
    return;
  }
  if (mode === 'forbidden') {
    res.writeHead(403);
    res.end('{"error":{"code":"forbidden","message":"Fixture denial"}}');
    return;
  }
  const upstream = request(
    `${backend.url}${req.url}`,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: auth.host,
        'x-forwarded-host': auth.host,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': 'fixture@example.test',
      },
    },
    response => {
      // Fault injection only after the real authenticated artifact route succeeds.
      const fault =
        nativeFaults &&
        response.statusCode === 200 &&
        req.url?.includes('/artifacts/') &&
        mode !== 'ok';
      if (!fault) {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let bytes = Buffer.concat(chunks);
        const headers = { ...response.headers };
        if (mode === 'wrong-hash') headers['x-content-sha256'] = '0'.repeat(64);
        if (mode === 'wrong-type') headers['content-type'] = 'text/plain';
        if (mode === 'wrong-bytes') {
          bytes = Buffer.from(bytes);
          bytes[0] ^= 1;
        }
        if (mode === 'oversized') {
          delete headers['content-length'];
          bytes = Buffer.concat([bytes, Buffer.from('x')]);
        }
        res.writeHead(200, headers);
        if (mode === 'delayed') {
          res.write(bytes.subarray(0, 1));
          const timer = setTimeout(() => res.end(bytes.subarray(1)), 2000);
          res.on('close', () => clearTimeout(timer));
        } else res.end(bytes);
      });
      response.on('error', () => res.destroy());
    },
  );
  upstream.on('error', () => {
    res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
});
proxy.listen(9078, '127.0.0.1', () =>
  console.log(
    JSON.stringify({
      fixture: true,
      directory: root,
      port: 9078,
      pid: process.pid,
    }),
  ),
);
const shutdown = async () => {
  proxy.close();
  await backend.close();
  process.exit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
