// LAN pairing fixtures whose server binds the port its pairing host names.
//
// The pairing host (127.0.0.1:<port>) is stored in the auth store before the companion listens, so the port is found
// by binding port 0 and closing it. In that gap another process can take it: the gate runs the companion tests under
// Node 22 and 24 side by side, and one run's port-0 listener got the other's port (EADDRINUSE, agents-171, #690).
// So a start that meets EADDRINUSE starts again on a new port with a new store, a bounded number of times.
import {execFileSync} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {createServer} from 'node:net';
import {RemoteAuthStore} from '../../dist/remote-auth.js';
import {startCompanionServer} from '../../dist/server.js';
import {tempDir} from './temp.mjs';

export async function chosenPort() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const {port} = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

/** `start(port)` with a port nobody held a moment ago; again with another port when someone took it before `start`
 * bound it. `first` is tried first when given. Any other failure is the test's. */
export async function onFreePort(start, {first, attempts = 5} = {}) {
  for (let attempt = 1; ; attempt++) {
    const port = attempt === 1 && first !== undefined ? first : await chosenPort();
    try { return await start(port); } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt >= attempts) throw error;
    }
  }
}

/**
 * A self-signed certificate for 127.0.0.1 and a LAN auth store on a chosen port. `f.serve(options)` starts the
 * companion on it; if that port was taken meanwhile, `f.port`, `f.store` and `f.authDir` are replaced by a new port and a
 * fresh store, so do any work on the store after `serve`.
 */
export async function lanFixture(t, {prefix = 'lan-', keyArgs = ['-newkey', 'rsa:2048']} = {}) {
  const root = await tempDir(prefix); t.after(() => rm(root, {recursive: true, force: true}));
  execFileSync('openssl', ['req', '-x509', ...keyArgs, '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], {stdio: 'ignore'});
  const cert = await readFile(join(root, 'cert.pem')), key = await readFile(join(root, 'key.pem'));
  const certificateSha256 = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
  const storeIn = (authDir, port) => RemoteAuthStore.create(authDir, {transport: 'lan', host: `127.0.0.1:${port}`, certificateSha256, allowedLogins: ['lan']});
  const port = await chosenPort(), authDir = join(root, 'auth');
  const f = {root, cert, key, certificateSha256, port, authDir, store: await storeIn(authDir, port)};
  f.serve = (options = {}) => onFreePort(async candidate => {
    if (candidate !== f.port) {
      const authDir = join(root, `auth-${candidate}`);
      Object.assign(f, {port: candidate, authDir, store: await storeIn(authDir, candidate)});
    }
    return startCompanionServer({remoteAuth: f.store, lanTls: {cert, key}, ...options});
  }, {first: f.port});
  return f;
}
