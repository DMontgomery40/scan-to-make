// Isolated local Simulator fixture. No Tailscale, account, TLS bypass or printer.
// Run after npm ci/build in services/companion. Invitations are written to a
// private temporary directory, never stdout. Only fixed synthetic identities.
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuthStore } from '../../../../services/companion/dist/remote-auth.js';
import { startGenerationServer } from '../../../../services/companion/dist/generation.js';
const root = await mkdtemp(join(tmpdir(), 'scan-pairing-fixture-'));
const auth = await RemoteAuthStore.create(join(root, 'auth'), { host: 'fixture.example.ts.net', allowedLogins: ['fixture@example.test'] });
const backend = await startGenerationServer({ port: 0, remoteAuth: auth });
await writeFile(join(root, 'mode'), 'ok', { mode: 0o600 });
async function invite() {
  const value = await auth.createPairing('fixture@example.test');
  await writeFile(join(root, 'invitation.json'), JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:9078', code: value.code, expiresAt: value.expiresAt }), { mode: 0o600 });
}
await invite();
process.on('SIGUSR1', () => invite().catch(() => {}));
process.on('SIGUSR2', () => auth.listDevices().then(devices => Promise.all(devices.map(d => auth.revoke(d.deviceId)))).catch(() => {}));
const proxy = createServer(async (req, res) => {
  const mode = (await readFile(join(root, 'mode'), 'utf8')).trim();
  if (mode === 'offline') { req.socket.destroy(); return; }
  if (mode === 'redirect') { res.writeHead(302, { Location: 'https://other.example.ts.net/healthz' }); res.end(); return; }
  if (mode === 'forbidden') { res.writeHead(403); res.end('{"error":{"code":"forbidden","message":"Fixture denial"}}'); return; }
  const upstream = request(`${backend.url}${req.url}`, { method: req.method, headers: {
    ...req.headers, host: auth.host, 'x-forwarded-host': auth.host, 'x-forwarded-proto': 'https', 'tailscale-user-login': 'fixture@example.test',
  } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  upstream.on('error', () => { res.writeHead(503); res.end(); }); req.pipe(upstream);
});
proxy.listen(9078, '127.0.0.1', () => console.log(JSON.stringify({ fixture: true, directory: root, port: 9078, pid: process.pid })));
const shutdown = async () => { proxy.close(); await backend.close(); process.exit(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
