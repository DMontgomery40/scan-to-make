import {createCaptureRoutes,type CaptureServices} from './capture-http.js';
import {createPrintHandoffRoutes,type PrintHandoffServices} from './print-handoff-http.js';
import {acquireInstanceLock} from './instance-lock.js';
import { createServer, type IncomingMessage } from 'node:http';
import {
  RemoteAuthFailure,
  RemoteAuthStore,
  type RemoteScope,
} from './remote-auth.js';

const MAX_PAIR_REQUEST_BYTES = 4096;
const errors = {
  'invalid-request': [400, 'Invalid request'],
  'payload-too-large': [413, 'Request payload limit exceeded'],
  'companion-failed': [500, 'The companion could not complete the request'],
  forbidden: [403, 'Only direct local clients are supported'],
  'not-found': [404, 'Unknown companion route'],
  'method-not-allowed': [405, 'Method not allowed'],
  'unsupported-media-type': [415, 'Requests require JSON'],
} as const;
type ServerErrorCode = keyof typeof errors;

export class ServerFailure extends Error {
  readonly status: number;
  constructor(readonly code: ServerErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
  limit: number
): Promise<unknown> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, length));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) finish(new ServerFailure('payload-too-large'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new ServerFailure('invalid-request'));
    const aborted = () => finish(new ServerFailure('invalid-request'));
    const timer = setTimeout(
      () => finish(new ServerFailure('invalid-request')),
      5000
    );
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ServerFailure('invalid-request');
  }
}

function singleHeader(
  request: IncomingMessage,
  name: string
): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) count++;
  const value = request.headers[name];
  if (count > 1 || Array.isArray(value))
    throw new RemoteAuthFailure('forbidden');
  return value;
}

/** Loopback listener; remote access requires explicit private Serve authentication. */
export async function startCompanionServer(
  options: {
    port?: number;
    remoteAuth?: RemoteAuthStore;
    capture?: CaptureServices;
    printHandoff?: PrintHandoffServices;
  } = {}
): Promise<{ url: string; close(): Promise<void> }> {
  const port = options.port ?? 9077;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid local port');
  const auth = options.remoteAuth;
  if(options.capture&&!auth)throw new Error('Capture routes require explicit authentication');
  if(options.printHandoff&&!auth)throw new Error('Printer handoff routes require explicit authentication');
  // One companion process per capture directory: scan processing assumes its
  // jobs, workers and cancellation all live in this process.
  const instanceLock=options.capture?.scanProcessing?await acquireInstanceLock(options.capture.scanProcessing.directory):undefined;
  const captureRoutes=options.capture?createCaptureRoutes(options.capture):undefined;
  const printHandoffRoutes=options.printHandoff?createPrintHandoffRoutes(options.printHandoff):undefined;
  let authority = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    try {
      if (
        request.headers.origin !== undefined ||
        request.headers['sec-fetch-site'] !== undefined
      )
        throw new ServerFailure('forbidden');
      let login = '';
      if (auth) {
        login = singleHeader(request, 'tailscale-user-login') ?? '';
        if (
          singleHeader(request, 'host') !== auth.host ||
          singleHeader(request, 'x-forwarded-host') !== auth.host ||
          singleHeader(request, 'x-forwarded-proto') !== 'https' ||
          request.headers['tailscale-funnel-request'] !== undefined ||
          !auth.allowsLogin(login)
        )
          throw new RemoteAuthFailure('forbidden');
      } else if (
        request.headers.host !== authority ||
        Object.keys(request.headers).some(
          (key) =>
            key.startsWith('x-forwarded-') || key.startsWith('tailscale-')
        )
      ) {
        throw new ServerFailure('forbidden');
      }
      const authorize = async (scope: RemoteScope) => {
        if (!auth) return;
        const authorization = singleHeader(request, 'authorization');
        const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
        await auth.authorize(
          login,
          singleHeader(request, 'x-scan-device'),
          token,
          scope
        );
      };
      if (request.url === '/healthz' && request.method === 'GET') {
        // Scope name kept from the first protocol so existing pairings still parse.
        await authorize('generation:health');
        response.end(JSON.stringify({ status: 'ok', protocolVersion: '0.1.0' }));
        return;
      }
      if(captureRoutes&&request.url?.startsWith('/v1/saved-projects/')){
        await captureRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      if(printHandoffRoutes&&request.url?.startsWith('/v1/printer-handoff/')){
        await printHandoffRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      if (!auth || request.url !== '/v1/pair')
        throw new ServerFailure('not-found');
      if (request.method !== 'POST')
        throw new ServerFailure('method-not-allowed');
      await auth.reservePairAttempt(login);
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] ?? ''
        ) ||
        (request.headers['content-encoding'] !== undefined &&
          request.headers['content-encoding'] !== 'identity')
      )
        throw new ServerFailure('unsupported-media-type');
      if (Number(request.headers['content-length'] ?? 0) > MAX_PAIR_REQUEST_BYTES)
        throw new ServerFailure('payload-too-large');
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once('close', abort);
      try {
        const input = await readBody(request, controller.signal, MAX_PAIR_REQUEST_BYTES);
        if (controller.signal.aborted)
          throw new ServerFailure('invalid-request');
        response.end(JSON.stringify(await auth.exchange(login, input)));
      } finally {
        response.off('close', abort);
      }
    } catch (error) {
      const failure =
        error instanceof ServerFailure || error instanceof RemoteAuthFailure
          ? error
          : new ServerFailure('companion-failed');
      if (!response.destroyed) {
        response.statusCode = failure.status;
        response.end(
          JSON.stringify({
            error: { code: failure.code, message: failure.message },
          })
        );
      }
    }
  });
  server.headersTimeout = 5000;
  // Handoff STL uploads are bounded at 64 MiB and need longer than the small
  // JSON routes; the route body reader enforces its own matching timeout.
  server.requestTimeout = printHandoffRoutes ? 120000 : 5000;
  server.maxRequestsPerSocket = 1;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await instanceLock?.release();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await instanceLock?.release();
    throw new Error('Local listener has no address');
  }
  authority = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${authority}`,
    close() {
      if (!closing)
        closing = (async () => {
          const stopped = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
          const capturesStopped=captureRoutes?.close();
          const handoffStopped=printHandoffRoutes?.close();
          server.closeAllConnections();
          await stopped;
          await capturesStopped;
          await handoffStopped;
          await instanceLock?.release();
        })();
      return closing;
    },
  };
}
