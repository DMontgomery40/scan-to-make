import {fork} from 'node:child_process';
import {createServer, type IncomingMessage} from 'node:http';
import QRCode from 'qrcode';
import {RemoteAuthStore} from './remote-auth.js';
import {renderPairingPage} from './pairing-view.js';

export type PairingInvitation = Awaited<ReturnType<RemoteAuthStore['createPairing']>>;

export async function renderPairingQr(invitation: PairingInvitation) {
  const [svg, terminal] = await Promise.all([
    QRCode.toString(invitation.qrPayload, {type: 'svg', errorCorrectionLevel: 'M', margin: 4}),
    QRCode.toString(invitation.qrPayload, {type: 'terminal', small: true, errorCorrectionLevel: 'M', margin: 4}),
  ]);
  return {svg, terminal};
}

function localRequest(request: IncomingMessage, host: string) {
  if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host) return false;
  for (const key of Object.keys(request.headers)) {
    if (key === 'origin' || key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-')) return false;
  }
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none' && site !== 'same-origin') return false;
  const referer = request.headers.referer;
  if (referer !== undefined) {
    try { if (new URL(referer).origin !== `http://${host}`) return false; }
    catch { return false; }
  }
  // Duplicate Host headers must not bypass the allowlist through parser differences.
  return request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === 'host').length === 1;
}

export async function startPairingPage(store: RemoteAuthStore, invitation: PairingInvitation) {
  const {svg} = await renderPairingQr(invitation);
  let host = '';
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const reject = (status: number) => { response.writeHead(status); response.end(); };
    if (!localRequest(request, host)) return reject(403);
    if (request.method !== 'GET' && request.method !== 'HEAD') return reject(405);
    if (request.url !== '/pair') return reject(404);
    void store.isPairingActive(invitation.code).then(active => {
      if (response.destroyed) return;
      const body = renderPairingPage(active ? svg : null, invitation.expiresAt);
      response.writeHead(active ? 200 : 410, {'Content-Type':'text/html; charset=utf-8'});
      response.end(request.method === 'HEAD' ? undefined : body);
    }).catch(() => { if (!response.destroyed) reject(503); });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback listener');
  host = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => {
    clearTimeout(deadline);
    server.close(() => resolve());
    server.closeAllConnections();
  });
  // A stale/open browser must never keep the display child alive indefinitely.
  // Ten seconds lets its refresh show the expired page before closing the listener.
  const deadline = setTimeout(() => void close(), Math.max(0, Math.min(300_000, invitation.expiresAt - Date.now())) + 10_000);
  server.on('error', () => void close());
  return {url: `http://${host}/pair`, close};
}

/** Secrets cross a private IPC channel, never argv, environment or files. */
export async function launchPairingPage(directory: string, invitation: PairingInvitation): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./pairing-page-cli.js', import.meta.url), [], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: {},
    });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); child.kill();
      if (child.connected) child.disconnect();
      reject(new Error('Local pairing page unavailable'));
    };
    const timeout = setTimeout(fail, 5_000);
    child.once('error', fail);
    child.once('exit', fail);
    child.once('message', message => {
      if (typeof message !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/pair$/.test(message)) return fail();
      if (settled) return;
      settled = true;
      clearTimeout(timeout); child.removeListener('exit', fail);
      child.disconnect(); child.unref(); resolve(message);
    });
    child.send({directory, invitation}, error => { if (error) fail(); });
  });
}
