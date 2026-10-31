import type {IncomingMessage, ServerResponse} from 'node:http';
import {z} from 'zod';
import {
  HandoffBundleStore,
  InMemoryElicitationRelay,
  PrinterHandoffRunner,
  printerHandoffConfigSchema,
  timeoutsFor,
  type ElicitationAnswer,
  type ElicitationRelay,
  type PrinterHandoffConfig,
} from '@scan-to-make/printer-handoff';
import {RemoteAuthFailure, type RemoteScope} from './remote-auth.js';

const MAX_STL_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 16384;
const HANDOFF_SCOPE: RemoteScope = 'printer-handoff:use';

class Failure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const answerSchema: z.ZodType<ElicitationAnswer> = z.union([
  z.strictObject({
    action: z.literal('accept'),
    content: z.record(z.string().max(128), z.union([
      z.string().max(4096), z.number(), z.boolean(), z.array(z.string().max(4096)).max(64),
    ])),
  }),
  z.strictObject({action: z.literal(['decline', 'cancel'])}),
]);

function body(request: IncomingMessage, signal: AbortSignal, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      request.off('aborted', failed);
      signal.removeEventListener('abort', aborted);
      if (error) { request.resume(); reject(error); } else resolve(Buffer.concat(chunks, length));
    };
    const data = (bytes: Buffer) => {
      length += bytes.length;
      if (length > limit) finish(new Failure(413, 'payload-too-large'));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const failed = () => finish(new Failure(400, 'invalid-request'));
    const aborted = () => finish(new Failure(499, 'cancelled'));
    const timer = setTimeout(() => finish(new Failure(408, 'body-timeout')), timeoutMs);
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    request.once('aborted', failed);
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
  });
}

function send(response: ServerResponse, bytes: Buffer | string): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); response.off('finish', done); response.off('close', done); resolve(); };
    const timer = setTimeout(() => { response.destroy(); done(); }, 30000);
    response.once('finish', done);
    response.once('close', done);
    response.setHeader('Content-Length', Buffer.byteLength(bytes));
    response.end(bytes);
  });
}

/** The pieces the handoff routes drive. Tests inject a fake runner. */
export interface PrintHandoffServices {
  store: HandoffBundleStore;
  relay: ElicitationRelay;
  runner: Pick<PrinterHandoffRunner, 'runBundle' | 'backend'>;
  selection?: PrinterHandoffConfig['selection'];
}

/** Builds the production services from an operator printer-handoff config. */
export function createPrintHandoffServices(configInput: PrinterHandoffConfig, bundlesDirectory: string): PrintHandoffServices {
  const config = printerHandoffConfigSchema.parse(structuredClone(configInput));
  const relay = new InMemoryElicitationRelay({timeoutMs: timeoutsFor(config).elicitationMs});
  return {
    store: new HandoffBundleStore(bundlesDirectory),
    relay,
    runner: new PrinterHandoffRunner(config, {relay}),
    selection: config.selection,
  };
}

const bundlePath = /^\/v1\/printer-handoff\/bundles(?:\/([a-f0-9-]{36})(?:\/print)?)?$/;
const elicitationPath = /^\/v1\/printer-handoff\/elicitations(?:\/([a-f0-9-]{36})\/respond)?$/;

/**
 * Phone-facing printer handoff: create a bundle from a clean STL, read its
 * status, start the configured MCP print run, and answer the print server's
 * elicitations. The backend, MCP process and printer selection come from the
 * operator config; the phone never chooses them.
 */
interface ActivePrint {bundleId: string; controller: AbortController; done: Promise<void>}

export function createPrintHandoffRoutes(services: PrintHandoffServices) {
  let activePrint: ActivePrint | undefined;

  const startPrint = (bundleId: string) => {
    if (activePrint) throw new Failure(409, 'print-busy');
    const controller = new AbortController();
    const entry: ActivePrint = {bundleId, controller, done: Promise.resolve()};
    entry.done = (async () => {
      try { await services.runner.runBundle(services.store, bundleId, {signal: controller.signal}); }
      catch { /* runBundle records the failure on the bundle itself. */ }
      finally { if (activePrint === entry) activePrint = undefined; }
    })();
    activePrint = entry;
  };

  return {
    async close() {
      services.relay.cancelAll();
      const pending = activePrint;
      pending?.controller.abort();
      await pending?.done;
    },
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
      authorize: (scope: RemoteScope) => Promise<void>,
      header: (name: string) => string | undefined,
    ) {
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnected);
      try {
        const url = new URL(request.url!, 'http://localhost');
        if (url.search) throw new Failure(400, 'invalid-request');
        const bundle = bundlePath.exec(url.pathname);
        const elicitation = elicitationPath.exec(url.pathname);
        if (!bundle && !elicitation) throw new Failure(404, 'not-found');
        await authorize(HANDOFF_SCOPE);

        if (elicitation) {
          const id = elicitation[1];
          if (!id) {
            if (request.method !== 'GET') throw new Failure(405, 'method-not-allowed');
            await send(response, JSON.stringify({elicitations: services.relay.pending()}));
            return;
          }
          if (request.method !== 'POST') throw new Failure(405, 'method-not-allowed');
          if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(header('content-type') ?? '')
            || !['identity', undefined].includes(header('content-encoding'))) {
            throw new Failure(415, 'unsupported-media-type');
          }
          const bytes = await body(request, controller.signal, MAX_JSON_BYTES, 5000);
          let answer: ElicitationAnswer;
          try { answer = answerSchema.parse(JSON.parse(bytes.toString('utf8'))); }
          catch { throw new Failure(400, 'invalid-request'); }
          await authorize(HANDOFF_SCOPE);
          if (!services.relay.respond(id, answer)) throw new Failure(404, 'elicitation-not-pending');
          await send(response, JSON.stringify({id, answered: true}));
          return;
        }

        const bundleId = bundle![1];
        const isPrint = url.pathname.endsWith('/print');
        if (!bundleId && request.method === 'GET') {
          await send(response, JSON.stringify({bundles: await services.store.list()}));
          return;
        }
        if (!bundleId && request.method === 'POST') {
          if ((header('content-type') ?? '') !== 'model/stl'
            || !['identity', undefined].includes(header('content-encoding'))) {
            throw new Failure(415, 'unsupported-media-type');
          }
          if (Number(header('content-length') ?? 0) > MAX_STL_BYTES) throw new Failure(413, 'payload-too-large');
          let prompt = '';
          const rawPrompt = header('x-handoff-prompt');
          if (rawPrompt !== undefined) {
            try { prompt = decodeURIComponent(rawPrompt); } catch { throw new Failure(400, 'invalid-request'); }
          }
          const stl = await body(request, controller.signal, MAX_STL_BYTES, 120000);
          await authorize(HANDOFF_SCOPE);
          let created: Awaited<ReturnType<HandoffBundleStore['create']>>;
          try {
            created = await services.store.create({
              stl, prompt, backend: services.runner.backend, selection: services.selection,
            });
          } catch { throw new Failure(400, 'invalid-stl'); }
          response.statusCode = 201;
          await send(response, JSON.stringify({bundle: created}));
          return;
        }
        if (!bundleId) throw new Failure(405, 'method-not-allowed');
        if (!z.uuid().safeParse(bundleId).success) throw new Failure(400, 'invalid-request');
        if (isPrint) {
          if (request.method !== 'POST') throw new Failure(405, 'method-not-allowed');
          const manifest = await services.store.read(bundleId);
          if (manifest.backend !== services.runner.backend) throw new Failure(409, 'backend-mismatch');
          await authorize(HANDOFF_SCOPE);
          startPrint(bundleId);
          response.statusCode = 202;
          await send(response, JSON.stringify({bundleId, printing: true}));
          return;
        }
        if (request.method !== 'GET') throw new Failure(405, 'method-not-allowed');
        const manifest = await services.store.read(bundleId);
        await send(response, JSON.stringify({bundle: manifest, printing: activePrint?.bundleId === bundleId}));
      } catch (error) {
        const failure = error instanceof Failure || error instanceof RemoteAuthFailure
          ? error
          : (error as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? new Failure(404, 'not-found')
            : new Failure(422, 'handoff-unavailable');
        if (!response.destroyed && !response.headersSent) {
          response.statusCode = failure.status;
          await send(response, JSON.stringify({error: {code: failure.code, message: failure.code}}));
        }
      } finally {
        response.off('close', disconnected);
      }
    },
  };
}
