import {createServer, createConnection, type Socket} from 'node:net';
import {chmod, lstat, mkdir, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {acquireInstanceLock} from './instance-lock.js';
import {controlError, ControlFailure, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, parseRequest, type ControlMethod} from './local-control-protocol.js';

async function privateDirectory(path: string) {
  await mkdir(path, {recursive:true, mode:0o700});
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new ControlFailure('unavailable');
}
async function removeStaleSocket(path: string) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket() || info.uid !== process.getuid!()) throw new ControlFailure('conflict');
  const stale = await new Promise<boolean>(resolve => {
    const probe = createConnection(path);
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
    probe.once('error', error => resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
  });
  if (!stale) throw new ControlFailure('conflict');
  const current = await lstat(path);
  if (current.ino !== info.ino || current.dev !== info.dev) throw new ControlFailure('conflict');
  await unlink(path);
}

/** Methods allowed past the usual 10 s connection deadline. */
export function methodDeadlineMs(method: ControlMethod, params: unknown): number | undefined {
  if (method === 'objects.estimate') return 180_000;
  // It answers within 7 s (a slow npm is reported, and asked again next time); the update runs after the reply.
  if (method === 'printers.updateMcp') return 15_000;
  // The printer MCP may ask its own confirmation; the call waits up to 120 s for it.
  if (method === 'objects.pausePrint' || method === 'objects.resumePrint' || method === 'objects.cancelPrint') return 130_000;
  if (method === 'events.wait') {
    const timeout = (params as {timeoutMs?: unknown})?.timeoutMs;
    return (typeof timeout === 'number' && Number.isFinite(timeout) ? Math.min(Math.max(timeout, 0), 25_000) : 25_000) + 5_000;
  }
  return undefined;
}

/** Host-local administration only: a filesystem endpoint, never an HTTP route. */
export async function startLocalControl(options: {
  path: string;
  dispatch: (method: ControlMethod, params: unknown) => Promise<unknown>;
  timeoutMs?: number;
}) {
  if (!process.getuid || !isAbsolute(options.path) || options.path.includes('\0') || Buffer.byteLength(options.path) > 103) throw new ControlFailure('unavailable');
  const parent = dirname(options.path);
  await privateDirectory(parent);
  const lockDirectory = join(parent, '.control-' + createHash('sha256').update(options.path).digest('hex').slice(0,16));
  await privateDirectory(lockDirectory);
  const lock = await acquireInstanceLock(lockDirectory).catch(() => { throw new ControlFailure('conflict'); });
  const clients = new Set<Socket>();
  const active = new Set<Promise<void>>();
  const server = createServer({allowHalfOpen:true}, socket => {
    if (clients.size >= 16 || active.size >= 16) { socket.destroy(); return; }
    clients.add(socket);
    let bytes = Buffer.alloc(0), received = false;
    let timer = setTimeout(() => socket.destroy(), options.timeoutMs ?? 10_000);
    /** Long methods get their own deadline once their request is read (events.wait, objects.estimate). */
    const extend = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => socket.destroy(), ms); };
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); clients.delete(socket); });
    const reply = (id: string | null, result: unknown, error?: unknown) => {
      if (socket.destroyed) return;
      let encoded = JSON.stringify(error ? {v:1,id,error:controlError(error)} : {v:1,id,result}) + '\n';
      if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) encoded = JSON.stringify({v:1,id,error:controlError(new ControlFailure('unavailable'))}) + '\n';
      socket.end(encoded);
    };
    socket.once('end', () => { if (!received) { received = true; reply(null, null, new ControlFailure('invalid-request')); } });
    socket.on('data', chunk => {
      if (received) return; // One request per connection; never replay a mutation.
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_REQUEST_BYTES) { received = true; reply(null, null, new ControlFailure('invalid-request')); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      received = true;
      let id: string | null = null;
      const work = (async () => {
        try {
          if (newline !== bytes.length - 1) throw new ControlFailure('invalid-request');
          const raw: unknown = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0,newline)));
          const possibleID = z.object({id:z.uuid()}).safeParse(raw);
          if (possibleID.success) id = possibleID.data.id;
          const request = parseRequest(raw);
          const deadline = methodDeadlineMs(request.method, request.params);
          if (deadline !== undefined) extend(deadline);
          const result = await options.dispatch(request.method, request.params);
          reply(id, result);
        } catch (error) {
          reply(id, null, error instanceof SyntaxError || error instanceof TypeError ? new ControlFailure('invalid-request') : error);
        }
      })();
      active.add(work);
      void work.finally(() => active.delete(work));
    });
  });
  try {
    await removeStaleSocket(options.path);
    await new Promise<void>((resolve,reject) => {
      server.once('error',reject);
      server.listen(options.path, () => { server.off('error',reject); resolve(); });
    });
    await chmod(options.path,0o600);
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await lock.release();
    throw error instanceof ControlFailure ? error : new ControlFailure('unavailable');
  }
  let closing: Promise<void> | undefined;
  return {path:options.path, close() {
    return closing ??= (async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled(active);
      await lock.release();
    })();
  }};
}
