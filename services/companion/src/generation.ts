import {createCaptureRoutes,type CaptureServices} from './capture-http.js';
import {acquireInstanceLock} from './instance-lock.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ArtifactRefSchema } from '@scan-to-make/contracts';
import {
  GenerationRequestSchema,
  GenerationResponseSchema,
  GENERATION_TIMEOUT_MS,
  MAX_GENERATION_REQUEST_BYTES,
  MAX_GENERATION_RESPONSE_BYTES,
  type GenerationResponse,
  type GenerationErrorCode,
} from '@scan-to-make/contracts/generation';
import { readVerifiedStl } from './stl-export.js';
import {
  RemoteAuthFailure,
  RemoteAuthStore,
  type RemoteScope,
} from './remote-auth.js';

const errors: Record<GenerationErrorCode, readonly [number, string]> = {
  'invalid-request': [400, 'Invalid generation request'],
  'payload-too-large': [413, 'Generation payload limit exceeded'],
  'unsupported-template': [422, 'This generator supports drawer trays only'],
  busy: [429, 'A generation request is already active'],
  'generation-failed': [502, 'The configured generator failed'],
  'generation-timeout': [504, 'The generator exceeded its deadline'],
  'invalid-output': [502, 'The generator returned invalid artifact data'],
  forbidden: [403, 'Only direct local clients are supported'],
  'not-found': [404, 'Unknown generation route'],
  'method-not-allowed': [405, 'Method not allowed'],
  'unsupported-media-type': [415, 'Generation requests require JSON'],
};
export class GenerationFailure extends Error {
  readonly status: number;
  constructor(readonly code: GenerationErrorCode) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}
export interface GenerationWorker {
  generate(input: unknown, signal?: AbortSignal): Promise<GenerationResponse>;
}
export interface GenerationWorkerOptions {
  /** Trusted operator configuration, never fields in a generation request. */
  executable?: string;
  generatorPath?: string;
  temporaryRoot?: string;
  timeoutMs?: number;
}

async function runGenerator(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new GenerationFailure('generation-failed');
  const child = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let expired = false,
    overflow = false,
    spawnFailed = false,
    total = 0;
  const kill = () => {
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, timeoutMs);
  const drain = (chunk: Buffer) => {
    total += chunk.length;
    if (total > 64 * 1024) {
      overflow = true;
      kill();
    }
  };
  child.stdout.on('data', drain);
  child.stderr.on('data', drain);
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
    });
    // Wait for close, not merely an AbortError: cleanup must follow actual child exit.
    child.once('close', (code) => resolve(code));
  });
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  try {
    const code = await exit;
    if (expired) throw new GenerationFailure('generation-timeout');
    if (signal?.aborted || spawnFailed || overflow || code !== 0)
      throw new GenerationFailure('generation-failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}

async function readManifest(path: string): Promise<unknown> {
  if (!(await lstat(path)).isFile()) throw new Error('Not a regular manifest');
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Not a regular manifest');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length === bytes.length) throw new Error('Manifest limit exceeded');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally {
    await file.close();
  }
}
const manifestSchema = z.object({
  schemaVersion: z.literal('0.1.0'),
  kind: z.literal('drawer-tray'),
  generator: z.strictObject({
    name: z.literal('tools/templates/drawer-organizer/drawer.py'),
    version: z.literal('0.1.0'),
  }),
  sourceSpec: z.strictObject({
    id: z.string(),
    revision: z.number(),
    template: z.literal('drawer-tray'),
    schemaVersion: z.literal('0.2.0'),
  }),
  artifact: ArtifactRefSchema,
  cornerRadiusAssumedMm: z.literal(0),
  status: z.literal('preview-geometry-not-print-authorized'),
});

export function createGenerationWorker(
  options: GenerationWorkerOptions = {}
): GenerationWorker {
  const executable = options.executable ?? 'python3';
  const generatorPath =
    options.generatorPath ??
    fileURLToPath(
      new URL(
        '../../../tools/templates/drawer-organizer/drawer.py',
        import.meta.url
      )
    );
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? GENERATION_TIMEOUT_MS;
  if (
    !isAbsolute(generatorPath) ||
    !isAbsolute(temporaryRoot) ||
    !executable ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > GENERATION_TIMEOUT_MS
  )
    throw new Error('Invalid generation configuration');
  return {
    async generate(input, signal) {
      const parsed = GenerationRequestSchema.safeParse(input);
      if (!parsed.success) throw new GenerationFailure('invalid-request');
      const sourceFit = parsed.data.sourceFit;
      if (sourceFit.template !== 'drawer-tray')
        throw new GenerationFailure('unsupported-template');
      if (
        Buffer.byteLength(JSON.stringify(parsed.data)) >
        MAX_GENERATION_REQUEST_BYTES
      )
        throw new GenerationFailure('payload-too-large');
      if (signal?.aborted) throw new GenerationFailure('generation-failed');
      const directory = await mkdtemp(
        join(temporaryRoot, 'scan-to-make-generation-')
      );
      try {
        const spec = join(directory, 'source.json');
        await writeFile(spec, JSON.stringify(sourceFit), {
          mode: 0o600,
          flag: 'wx',
        });
        await runGenerator(
          executable,
          [generatorPath, 'generate', '--spec', spec, '--out-dir', directory],
          timeoutMs,
          signal
        );
        if (signal?.aborted) throw new GenerationFailure('generation-failed');
        try {
          const manifest = manifestSchema.parse(
            await readManifest(join(directory, 'drawer-tray.manifest.json'))
          );
          if (
            manifest.sourceSpec.id !== sourceFit.id ||
            manifest.sourceSpec.revision !== sourceFit.revision
          )
            throw new Error('Wrong source');
          const { bytes, geometry } = await readVerifiedStl(
            join(directory, 'drawer-tray.stl'),
            manifest.artifact
          );
          return GenerationResponseSchema.parse({
            formatVersion: '0.1.0',
            receipt: {
              sourceFit,
              artifact: manifest.artifact,
              geometry,
              generator: { name: 'drawer-tray', version: '0.1.0' },
              assumptions: { cornerRadiusAssumedMm: 0 },
              status: 'preview-only',
            },
            stlBase64: bytes.toString('base64'),
          });
        } catch {
          throw new GenerationFailure('invalid-output');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
  limit = MAX_GENERATION_REQUEST_BYTES
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
      if (length > limit) finish(new GenerationFailure('payload-too-large'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const failed = () => finish(new GenerationFailure('invalid-request'));
    const aborted = () => finish(new GenerationFailure('generation-failed'));
    const timer = setTimeout(
      () => finish(new GenerationFailure('invalid-request')),
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
    throw new GenerationFailure('invalid-request');
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

/** Loopback listener; remote access requires explicit private Serve authentication. No printer routes. */
export async function startGenerationServer(
  options: {
    port?: number;
    worker?: GenerationWorker;
    remoteAuth?: RemoteAuthStore;
    capture?: CaptureServices;
  } = {}
): Promise<{ url: string; close(): Promise<void> }> {
  const port = options.port ?? 9077;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid local port');
  const worker = options.worker ?? createGenerationWorker();
  const auth = options.remoteAuth;
  if(options.capture&&!auth)throw new Error('Capture routes require explicit authentication');
  // One companion process per capture directory: scan processing assumes its
  // jobs, workers and cancellation all live in this process.
  const instanceLock=options.capture?.scanProcessing?await acquireInstanceLock(options.capture.scanProcessing.directory):undefined;
  let captureRoutes:ReturnType<typeof createCaptureRoutes>|undefined;
  try {
    captureRoutes=options.capture?createCaptureRoutes(options.capture):undefined;
  } catch (error) {
    await instanceLock?.release();
    throw error;
  }
  let authority = '';
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    let finish: (() => void) | undefined;
    try {
      if (
        request.headers.origin !== undefined ||
        request.headers['sec-fetch-site'] !== undefined
      )
        throw new GenerationFailure('forbidden');
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
        throw new GenerationFailure('forbidden');
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
        await authorize('generation:health');
        response.end(
          JSON.stringify({
            status: 'ok',
            protocolVersion: '0.1.0',
            templates: ['drawer-tray'],
          })
        );
        return;
      }
      if(captureRoutes&&request.url?.startsWith('/v1/saved-projects/')){
        await captureRoutes.handle(request,response,authorize,name=>singleHeader(request,name));return;
      }
      const pairing = auth && request.url === '/v1/pair';
      if (request.url !== '/v1/generate' && !pairing)
        throw new GenerationFailure('not-found');
      if (request.method !== 'POST')
        throw new GenerationFailure('method-not-allowed');
      if (pairing) await auth.reservePairAttempt(login);
      else await authorize('generation:create');
      if (
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
          request.headers['content-type'] ?? ''
        ) ||
        (request.headers['content-encoding'] !== undefined &&
          request.headers['content-encoding'] !== 'identity')
      )
        throw new GenerationFailure('unsupported-media-type');
      if (
        Number(request.headers['content-length'] ?? 0) >
        (pairing ? 4096 : MAX_GENERATION_REQUEST_BYTES)
      )
        throw new GenerationFailure('payload-too-large');
      if (pairing) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once('close', abort);
        try {
          const input = await readBody(request, controller.signal, 4096);
          if (controller.signal.aborted)
            throw new GenerationFailure('invalid-request');
          response.end(JSON.stringify(await auth.exchange(login, input)));
        } finally {
          response.off('close', abort);
        }
        return;
      }
      if (active) throw new GenerationFailure('busy');
      const controller = new AbortController();
      active = {
        controller,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      const disconnected = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once('close', disconnected);
      try {
        const input = GenerationRequestSchema.safeParse(
          await readBody(request, controller.signal)
        );
        if (!input.success) throw new GenerationFailure('invalid-request');
        await authorize('generation:create');
        const result = GenerationResponseSchema.parse(
          await worker.generate(input.data, controller.signal)
        );
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > MAX_GENERATION_RESPONSE_BYTES)
          throw new GenerationFailure('invalid-output');
        if (!controller.signal.aborted) {
          response.statusCode = 200;
          response.setHeader('Content-Length', Buffer.byteLength(body));
          response.end(body);
        }
      } finally {
        response.off('close', disconnected);
      }
    } catch (error) {
      const failure =
        error instanceof GenerationFailure || error instanceof RemoteAuthFailure
          ? error
          : new GenerationFailure('generation-failed');
      if (!response.destroyed) {
        response.statusCode = failure.status;
        response.end(
          JSON.stringify({
            error: { code: failure.code, message: failure.message },
          })
        );
      }
    } finally {
      if (finish) {
        active = undefined;
        finish();
      }
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = options.capture?.preparedJobs ? 30000 : 5000;
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
          const pending = active?.done;
          const stopped = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
          );
          active?.controller.abort();
          const capturesStopped=captureRoutes?.close();
          server.closeAllConnections();
          await stopped;
          await pending;
          await capturesStopped;
          await instanceLock?.release();
        })();
      return closing;
    },
  };
}
