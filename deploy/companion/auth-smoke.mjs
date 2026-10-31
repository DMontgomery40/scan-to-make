import assert from 'node:assert/strict';
import {request} from 'node:http';

// Node 24 fetch replaces Host; use the HTTP client to model Serve's headers.
function fetchLocal(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, {...options, timeout: 5000}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {body += chunk;});
      res.on('end', () => resolve({status: res.statusCode, json: () => JSON.parse(body)}));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.end(options.body);
  });
}
import {RemoteAuthStore} from '../../services/companion/dist/remote-auth.js';
const store = await RemoteAuthStore.open(process.env.SCAN_TO_MAKE_REMOTE_AUTH_DIR);
const headers = {
  host: 'smoke.example.ts.net', 'x-forwarded-host': 'smoke.example.ts.net',
  'x-forwarded-proto': 'https', 'tailscale-user-login': 'smoke@example.com',
};
const base = `http://127.0.0.1:${process.env.SCAN_TO_MAKE_GENERATION_PORT ?? '9077'}`;
const invite = await store.createPairing('smoke@example.com', ['generation:health']);
const response = await fetchLocal(`${base}/v1/pair`, {
  method: 'POST', headers: {...headers, 'content-type': 'application/json'},
  body: JSON.stringify({code: invite.code, deviceName: 'Packaging smoke'}), signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 200);
const device = await response.json();
try {
  const health = await fetchLocal(`${base}/healthz`, {headers: {...headers,
    authorization: `Bearer ${device.token}`, 'x-scan-device': device.deviceId}, signal: AbortSignal.timeout(5000)});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {status: 'ok', protocolVersion: '0.1.0'});
  const anonymous = await fetchLocal(`${base}/healthz`, {signal: AbortSignal.timeout(5000)});
  assert.equal(anonymous.status, 403);
  console.log('Paired /healthz passed; anonymous request rejected');
} finally {await store.revoke(device.deviceId);}
