// Exercise preflight against the compiled companion, without Tailscale or phones.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RemoteAuthStore} from '../../../services/companion/dist/remote-auth.js';
import {startGenerationServer} from '../../../services/companion/dist/generation.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'preflight-companion-'));
const host = 'companion.example-tail.ts.net';
const login = 'alice@example.test';
const servers = [];
function health(url, headers = {}) {
  return new Promise((resolve, reject) => {
    request(new URL('/healthz', url), {headers}, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject).end();
  });
}
async function probe(url) {
  const {stdout} = await exec('python3', ['-c',
    'import json,sys; sys.path.insert(0,"tools/tailscale"); import preflight; print(json.dumps(preflight.default_health_probe(int(sys.argv[1]))))',
    new URL(url).port], {cwd: root});
  return JSON.parse(stdout);
}
try {
  const store = await RemoteAuthStore.create(join(temporary, 'registry'), {host, allowedLogins: [login]});
  const invitation = await store.createPairing(login);
  const credential = await store.exchange(login, {code: invitation.code, deviceName: 'Integration fixture'});
  const remote = await startGenerationServer({port: 0, remoteAuth: store});
  servers.push(remote);
  assert.equal(await health(remote.url, {
    host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https',
    'tailscale-user-login': login, authorization: `Bearer ${credential.token}`,
    'x-scan-device': credential.deviceId,
  }), 200);
  assert.equal(await health(remote.url), 403);
  const protectedProbe = await probe(remote.url);
  assert.equal(protectedProbe.state, 'authorization-required');
  assert.equal(protectedProbe.httpStatus, 403);
  assert.equal(protectedProbe.ok, false);
  assert.equal(protectedProbe.identityVerified, false);
  const local = await startGenerationServer({port: 0});
  servers.push(local);
  const localProbe = await probe(local.url);
  assert.equal(localProbe.state, 'local-healthy');
  assert.equal(localProbe.ok, true);
  assert.equal(localProbe.identityVerified, false);
  console.log('PASS: real companion authenticated health200, anonymous403 classified unverified; legacy local health remains healthy. No tailnet/phone proof.');
} finally {
  await Promise.all(servers.map(server => server.close()));
  await rm(temporary, {recursive: true, force: true});
}
