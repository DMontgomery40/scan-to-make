import type {IncomingMessage, ServerResponse} from 'node:http';
import {
  createRemoteMcpServer, serveRemoteMcpRequest, REMOTE_CLASSES,
  type RemoteClass, type PrinterSession, type ElicitationRelay,
} from '@scan-to-make/printer-handoff';
import {RemoteAuthFailure, type RemoteScope} from './remote-auth.js';

/** One configured printer, as `/v1/mcp` reaches it: its shared session and its relay. */
export interface RemoteMcpDestination {
  session: PrinterSession;
  relay: ElicitationRelay;
}
export interface RemoteMcpServices {
  /** `current` and every other configured destination, by id (never a session the route makes itself). */
  destinations: () => ReadonlyMap<string, RemoteMcpDestination>;
  /** The bundle store; remote writes go to `<bundleRoot>/remote/<deviceId>/`. */
  bundleRoot: string;
  /** PRD §8.10 admission for a destination; throws while its MCP updates. */
  admit?: (destinationId: string) => () => void;
  lockTimeoutMs?: number;
  /** How long a remote question waits for an answer before `cancel` (default 0; see RemoteMcpOptions). */
  questionMs?: number;
  toolTimeoutMs?: number;
}
export interface RemoteMcpDevice { deviceId: string; deviceName: string; scopes: readonly string[] }

const MAX_BODY = 1024 * 1024;
const path = /^\/v1\/mcp(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,63}))?$/;
const classesOf = (scopes: readonly string[]) =>
  new Set<RemoteClass>(REMOTE_CLASSES.filter(cls => scopes.includes(`mcp:${cls}` satisfies string as RemoteScope)));

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

/** Reads at most 1 MiB; past that it stops keeping or counting anything. Exported for its test. */
export function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (error?: Failure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off('data', data);
      if (error) {
        chunks.length = 0;
        // Nothing more is kept or counted; the rest is drained. Every reply sets Connection: close (server.ts), and
        // server.requestTimeout bounds a client that keeps sending.
        request.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, length));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY) finish(new Failure(413, 'payload-too-large'));
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => { finish(new Failure(408, 'body-timeout')); request.destroy(); }, 30_000);
    request.on('data', data);
    request.once('end', () => finish());
    request.once('error', () => finish(new Failure(400, 'invalid-request')));
  });
}

export function isRemoteMcpPath(url: string | undefined): boolean {
  return !!url && path.test(url.split('?')[0]!);
}

/**
 * `/v1/mcp` and `/v1/mcp/<destinationId>` (docs/design/remote-mcp.md): one stateless Streamable HTTP
 * MCP request from a paired device. The companion's handler has already checked the front door
 * (Serve identity or LAN TLS, Host, Funnel); `device` checks the token and returns its scopes.
 */
export async function handleRemoteMcp(
  services: RemoteMcpServices,
  request: IncomingMessage,
  response: ServerResponse,
  device: () => Promise<RemoteMcpDevice>,
): Promise<void> {
  try {
    const url = new URL(request.url!, 'http://localhost');
    const match = path.exec(url.pathname);
    if (!match || url.search) throw new Failure(404, 'not-found');
    // Before the body: a valid token with mcp:read (pairing always grants it).
    const caller = await device();
    if (!caller.scopes.includes('mcp:read')) throw new RemoteAuthFailure('forbidden');
    if (request.method !== 'POST') throw new Failure(405, 'method-not-allowed');
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new Failure(415, 'unsupported-media-type');
    const destinationId = match[1] ?? 'current';
    const destination = services.destinations().get(destinationId);
    if (!destination) throw new Failure(404, 'unknown-printer');
    let body: unknown;
    try { body = JSON.parse((await readBody(request)).toString('utf8')); }
    catch (error) { throw error instanceof Failure ? error : new Failure(400, 'invalid-json'); }
    const server = await createRemoteMcpServer(destination.session, {
      deviceId: caller.deviceId,
      deviceName: caller.deviceName,
      classes: classesOf(caller.scopes),
      // Checked again per call, after the mutex and right before dispatch.
      reauthorize: async cls => {
        const now = await device();
        if (now.deviceId !== caller.deviceId || !now.scopes.includes(`mcp:${cls}`)) throw new RemoteAuthFailure('forbidden');
      },
    }, {
      bundleRoot: services.bundleRoot,
      relay: destination.relay,
      ...(services.questionMs !== undefined ? {questionMs: services.questionMs} : {}),
      ...(services.toolTimeoutMs !== undefined ? {toolTimeoutMs: services.toolTimeoutMs} : {}),
      ...(services.admit ? {admit: () => services.admit!(destinationId)} : {}),
      ...(services.lockTimeoutMs !== undefined ? {lockTimeoutMs: services.lockTimeoutMs} : {}),
    }).catch(() => { throw new Failure(503, 'printer-unavailable'); });
    // The transport writes its own content type and status.
    response.removeHeader('Content-Type');
    await serveRemoteMcpRequest(server, request, response, body);
  } catch (error) {
    const failure = error instanceof Failure || error instanceof RemoteAuthFailure ? error : new Failure(500, 'companion-failed');
    if (!response.headersSent && !response.destroyed) {
      response.statusCode = failure.status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({error: {code: failure.code, message: failure.message}}));
    }
  }
}
