import type {IncomingMessage, ServerResponse} from 'node:http';
import {z} from 'zod';
import {
  HandoffBundleStore,
  DispatchedPrintError,
  InMemoryElicitationRelay,
  PrinterHandoffRunner,
  printerHandoffConfigSchema,
  sanitizedFailureReason,
  timeoutsFor,
  type ElicitationAnswer,
  type ElicitationRelay,
  type HandoffManifest,
  type PrinterHandoffConfig,
  type PrinterSessionPool,
  type PrinterToolCatalog,
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
  runner: Pick<PrinterHandoffRunner, 'runBundle' | 'backend'> & Partial<Pick<PrinterHandoffRunner, 'filaments' | 'status' | 'session' | 'run' | 'estimate'>>;
  selection?: PrinterHandoffConfig['selection'];
  /** PRD §8.10: holds the printer for a print, so its MCP isn't updated under it; throws while it updates. */
  admit?: () => () => void;
  /** The other destinations' relays: their remote (`/v1/mcp`) questions are listed and answered here too. */
  remoteRelays?: () => ElicitationRelay[];
}

/**
 * Builds the production services from an operator printer-handoff config.
 * With a pool, every call to this destination goes through its one long-lived
 * MCP session (PRD §8.3); without one, each run opens and closes its own.
 */
export function createPrintHandoffServices(configInput: PrinterHandoffConfig, bundlesDirectory: string,
  shared?: {pool: PrinterSessionPool; destinationId: string; onConnect?: (catalog: PrinterToolCatalog) => void;
    /** The relay the destination's pooled session was made with, when its services are rebuilt with a new config. */
    relay?: InMemoryElicitationRelay}): PrintHandoffServices {
  const config = printerHandoffConfigSchema.parse(structuredClone(configInput));
  const relay = shared?.relay ?? new InMemoryElicitationRelay({timeoutMs: timeoutsFor(config).elicitationMs});
  const session = shared?.pool.session(shared.destinationId, config, {relay, ...(shared.onConnect ? {onConnect: shared.onConnect} : {})});
  return {
    store: new HandoffBundleStore(bundlesDirectory),
    relay,
    runner: new PrinterHandoffRunner(config, {relay, ...(session ? {session} : {})}),
    selection: config.selection,
  };
}

const bundlePath = /^\/v1\/printer-handoff\/bundles(?:\/([a-fA-F0-9-]{36})(?:\/print)?)?$/;
const elicitationPath = /^\/v1\/printer-handoff\/elicitations(?:\/([a-fA-F0-9-]{36})\/respond)?$/;

/**
 * Phone-facing printer handoff: create a bundle from a clean STL, read its
 * status, start the configured MCP print run, and answer the print server's
 * elicitations. The backend, MCP process and printer selection come from the
 * operator config; the phone never chooses them.
 */
interface ActivePrint {bundleId: string; controller: AbortController; done: Promise<void>}

// The phone may only answer what the printer server actually asked: content
// keys, types, enums and required fields are checked against the pending
// prompt's requested schema, so an answer cannot smuggle in a printer,
// model or process choice the server never offered.
function validateAnswer(requestedSchema: unknown, answer: ElicitationAnswer): void {
  if (answer.action !== 'accept') return;
  const schema = requestedSchema as {
    properties?: Record<string, {type?: string; enum?: unknown[]}>;
    required?: string[];
  } | undefined;
  const properties = schema?.properties;
  const invalid = () => { throw new Failure(400, 'invalid-answer'); };
  if (!properties || typeof properties !== 'object') {
    if (Object.keys(answer.content).length) invalid();
    return;
  }
  for (const required of schema.required ?? []) {
    if (!(required in answer.content)) invalid();
  }
  for (const [key, value] of Object.entries(answer.content)) {
    const property = properties[key];
    if (!property) invalid();
    if (property!.enum && !property!.enum.includes(value as never)) invalid();
    const type = property!.type;
    if (type === 'string' && typeof value !== 'string') invalid();
    if (type === 'boolean' && typeof value !== 'boolean') invalid();
    if (type === 'number' && typeof value !== 'number') invalid();
    if (type === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) invalid();
    if (type === 'array' && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) invalid();
  }
}

export function createPrintHandoffRoutes(services: PrintHandoffServices) {
  // This destination's questions, plus remote questions asked on any other destination.
  const questions = () => [
    ...services.relay.pending().map(item => ({item, relay: services.relay})),
    ...(services.remoteRelays?.() ?? []).filter(relay => relay !== services.relay)
      .flatMap(relay => relay.pending().filter(item => item.remoteDeviceId).map(item => ({item, relay}))),
  ];
  let activePrint: ActivePrint | undefined;
  let completedPrints = 0;
  let startingPrint: Promise<void> | undefined;
  let closed = false;
  let creating = false;
  const unpersistedDispatches = new Map<string, {status: 'printed' | 'uncertain'; failure: string}>();
  const phoneManifest = (manifest: HandoffManifest): HandoffManifest => {
    const failure = unpersistedDispatches.get(manifest.id);
    return failure ? {...manifest, ...failure} : manifest;
  };

  const startPrint = (bundleId: string) => {
    if (closed) throw new Failure(503, 'closing');
    if (activePrint) throw new Failure(409, 'print-busy');
    let release: () => void;
    try { release = services.admit?.() ?? (() => undefined); } catch { throw new Failure(409, 'print-busy'); }
    const controller = new AbortController();
    const entry: ActivePrint = {bundleId, controller, done: Promise.resolve()};
    entry.done = (async () => {
      try { await services.runner.runBundle(services.store, bundleId, {signal: controller.signal}); }
      catch (error) {
        // Preserve a successful dispatch even if saving its outputs failed.
        // Other escaped failures must still leave a terminal, phone-safe code.
        const manifest = await services.store.read(bundleId).catch(() => undefined);
        const dispatched = error instanceof DispatchedPrintError || manifest?.status === 'printed';
        const failure = sanitizedFailureReason(error);
        const status = dispatched ? 'printed' : failure === 'dispatch-uncertain' ? 'uncertain' : 'failed';
        if (status !== 'failed') unpersistedDispatches.set(bundleId, {status, failure});
        await services.store.setStatus(bundleId, status, failure)
          .then(() => { unpersistedDispatches.delete(bundleId); })
          .catch(() => undefined);
      } finally {
        release();
        completedPrints++;
        if (activePrint === entry) activePrint = undefined;
      }
    })();
    activePrint = entry;
  };

  return {
    async close() {
      closed = true;
      services.relay.cancelAll();
      const pending = activePrint;
      pending?.controller.abort();
      await startingPrint;
      await pending?.done;
    },
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
      authorize: (scope: RemoteScope) => Promise<void>,
      header: (name: string) => string | undefined,
      /** The answering device, so a remote device can never answer its own question. */
      deviceId: () => string | undefined = () => undefined,
    ) {
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', disconnected);
      try {
        if (closed) throw new Failure(503, 'closing');
        const url = new URL(request.url!, 'http://localhost');
        if (url.search) throw new Failure(400, 'invalid-request');
        const bundle = bundlePath.exec(url.pathname);
        const elicitation = elicitationPath.exec(url.pathname);
        if (!bundle && !elicitation) throw new Failure(404, 'not-found');
        // Re-authorize after awaited body/storage reads too: a pairing can
        // be revoked while those operations are in progress.
        await authorize(HANDOFF_SCOPE);

        if (elicitation) {
          const id = elicitation[1]?.toLowerCase();
          if (!id) {
            if (request.method !== 'GET') throw new Failure(405, 'method-not-allowed');
            const elicitations = questions().map(entry => entry.item);
            await authorize(HANDOFF_SCOPE);
            await send(response, JSON.stringify({elicitations}));
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
          const found = questions().find(entry => entry.item.id === id);
          if (!found) throw new Failure(404, 'elicitation-not-pending');
          if (found.item.remoteDeviceId && found.item.remoteDeviceId === deviceId()) throw new Failure(403, 'own-question');
          validateAnswer(found.item.requestedSchema, answer);
          if (!found.relay.respond(id, answer)) throw new Failure(404, 'elicitation-not-pending');
          await send(response, JSON.stringify({id, answered: true}));
          return;
        }

        const bundleId = bundle![1]?.toLowerCase();
        const isPrint = url.pathname.endsWith('/print');
        if (!bundleId && request.method === 'GET') {
          const bundles = await services.store.list();
          await authorize(HANDOFF_SCOPE);
          await send(response, JSON.stringify({bundles: bundles.map(phoneManifest)}));
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
          if (creating) throw new Failure(429, 'busy');
          creating = true;
          try {
            const stl = await body(request, controller.signal, MAX_STL_BYTES, 120000);
            await authorize(HANDOFF_SCOPE);
            let created: Awaited<ReturnType<HandoffBundleStore['create']>>;
            try {
              created = await services.store.create({
                stl, prompt, backend: services.runner.backend, selection: services.selection,
              });
            } catch (error) {
              const code = (error as NodeJS.ErrnoException)?.code;
              if (code && ['EACCES', 'ENOSPC', 'EROFS', 'EIO'].includes(code)) throw new Failure(503, 'storage-unavailable');
              if (error instanceof z.ZodError) throw new Failure(400, 'invalid-request');
              throw new Failure(400, 'invalid-stl');
            }
            response.statusCode = 201;
            await send(response, JSON.stringify({bundle: created}));
          } finally { creating = false; }
          return;
        }
        if (!bundleId) throw new Failure(405, 'method-not-allowed');
        if (!z.uuid().safeParse(bundleId).success) throw new Failure(400, 'invalid-request');
        if (isPrint) {
          if (request.method !== 'POST') throw new Failure(405, 'method-not-allowed');
          // Reserve admission before reading status or re-authorizing. A
          // concurrent request must not dispatch from a stale ready manifest.
          if (activePrint || startingPrint) throw new Failure(409, 'print-busy');
          let finishAdmission!: () => void;
          startingPrint = new Promise(resolve => { finishAdmission = resolve; });
          try {
            if (unpersistedDispatches.has(bundleId)) throw new Failure(409, unpersistedDispatches.get(bundleId)!.status === 'uncertain' ? 'dispatch-uncertain' : 'already-printed');
            const manifest = await services.store.read(bundleId);
            if (manifest.backend !== services.runner.backend) throw new Failure(409, 'backend-mismatch');
            if (manifest.status === 'uncertain') throw new Failure(409, 'dispatch-uncertain');
            if (manifest.status === 'printed') throw new Failure(409, 'already-printed');
            await authorize(HANDOFF_SCOPE);
            startPrint(bundleId);
          } finally {
            startingPrint = undefined;
            finishAdmission();
          }
          response.statusCode = 202;
          await send(response, JSON.stringify({bundleId, printing: true}));
          return;
        }
        if (request.method !== 'GET') throw new Failure(405, 'method-not-allowed');
        let manifest: HandoffManifest;
        let completionAtRead: number;
        do {
          completionAtRead = completedPrints;
          manifest = await services.store.read(bundleId);
          await authorize(HANDOFF_SCOPE);
          // Completion can persist a terminal status and clear its fallback
          // during either await. Re-read before reporting printing: false.
        } while (completionAtRead !== completedPrints);
        await send(response, JSON.stringify({bundle: phoneManifest(manifest), printing: activePrint?.bundleId === bundleId}));
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
