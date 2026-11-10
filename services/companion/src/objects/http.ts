import {CadSetupRefused} from '../cad-settings.js';
import {projectPlates, type ProjectPlate} from './plates.js';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {readFile, realpath, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, join, isAbsolute, sep} from 'node:path';
import type {RemoteScope} from '../remote-auth.js';
import {InvalidAnswerError, InvalidCaptureCameraError, InvalidCaptureManifestError, InvalidStateError, passKind, projectStatus, type ObjectService} from './service.js';
import {CameraUnavailableError, type CameraFrame} from '../printing/camera.js';
import {CompanionSettingsPatchSchema, FitSchema, type ObjectStatus, type ProjectStatus} from '@scan-to-make/contracts/counterpart';
import {z} from 'zod';
import {fitRequest} from './fit.js';
import {askKind} from './asks.js';
import {objectStatus, projectTitle} from '../events/words.js';
import {ObjectNotFoundError, type ObjectPass, type StmObject} from './store.js';
import {RECONSTRUCTION_FAILED} from './reconstruct.js';
import {canRetryPass, passWords} from './pass-end.js';
import {ControlFailure, parameters} from '../local-control-protocol.js';
import {PrinterSetupError, type PrinterSetup} from '../printing/setup.js';

const READ: RemoteScope = 'projects:read', WRITE: RemoteScope = 'captures:import', PRINT: RemoteScope = 'printer-handoff:use';
const MAX_SCAN = 64 * 1024 * 1024, MAX_PHOTO = 25 * 1024 * 1024, MAX_JSON = 16 * 1024;
const MAX_DEPTH = 8 * 1024 * 1024;
const PATH = /^\/v1\/objects(?:\/([0-9a-f-]{36})(?:\/(scan|model|ask|plate-selection|settings|duplicate|photos|capture|capture-manifest|capture-depth|capture-camera|reconstruction|reconstruction-preview\.stl|start|corrections|closeup|print|print\/pause|print\/resume|print\/cancel|estimate|camera\.jpg|prints\/[0-9a-f-]{36}\/frames\/[0-9a-f-]{36}\.jpg|asks\/[0-9a-f-]{36}\.jpg|filaments|colour-mapping|print-confirmation|printer|model\.stl|original\/[0-9]+|passes\/[^/]+\/activity|(?:renders|photos|capture|scan)\/[^/]+))?)?$/;
const PRINTER_CAMERA = /^\/v1\/objects\/printers\/([A-Za-z0-9_-]{1,256})\/camera\.jpg$/;
/** Settings -> Printers: the printer MCP's connection (`route`) and which MCP a printer uses (`mcp`). */
const PRINTER_CHOICE = /^\/v1\/objects\/printers\/([A-Za-z0-9_-]{1,256})\/(route|mcp)$/;
const SETTINGS: RemoteScope = 'projects:write';

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

/** Export only regular files whose canonical location stays in this project. */
async function exportFile(directory: string, relative: string): Promise<Buffer> {
  if (isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpFailure(404, 'not-found');
  try {
    const root = await realpath(directory), path = await realpath(join(root, relative));
    if (!path.startsWith(root + sep)) throw new HttpFailure(404, 'not-found');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new HttpFailure(404, 'not-found');
      if (stat.size > MAX_SCAN) throw new HttpFailure(413, 'file-too-large');
      return await file.readFile();
    } finally { await file.close(); }
  } catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure(404, 'not-found'); }
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpFailure(413, 'too-large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
async function json<T>(request: IncomingMessage, limit = MAX_JSON): Promise<T> {
  const bytes = await body(request, limit);
  if (!bytes.length) return {} as T;
  try { return JSON.parse(bytes.toString('utf8')) as T; } catch { throw new HttpFailure(400, 'invalid-request'); }
}

export type PublicObject = Omit<StmObject, 'passes' | 'title' | 'failedPass'> & {plates?: ProjectPlate[]; title: string; canRetryCleanup: boolean; status: ObjectStatus; settings: ReturnType<typeof projectSettingsView>; passes: (Omit<ObjectPass, 'dir' | 'activity' | 'sessionId' | 'resumable' | 'checkpoints' | 'resume' | 'sessionCwd'> & {activityCount: number; words?: string})[]};

// Earlier generic failures asserted a capture mistake without evidence. Correct the displayed
// advice for those retained attempts too, leaving their original stored records intact.
function currentFailureText(message: string | undefined): string | undefined {
  return message === "Your Mac couldn't build a model from these photos. Try again with the object filling more of the frame, turning it slowly."
    ? RECONSTRUCTION_FAILED : message;
}

/** Project metadata stays small; retained activity is read one pass at a time. */
/** Project Settings as the apps read them: the status, and whether it's hidden from Home. */
export function projectSettingsView(object: StmObject) {
  return {status: projectStatus(object), archived: !!object.archived, ...(object.printerDestinationId ? {printerDestinationId: object.printerDestinationId} : {}), ...object.preferences};
}

export function publicObject(stored: StmObject): PublicObject {
  // What the person typed, and the fit choice as fields: never the brief a client once appended to the request.
  const {typed, fit} = fitRequest(stored);
  const {instructions: _instructions, fit: _fit, ...rest} = stored;
  // Every question says its kind, also one saved before kinds were written.
  const kind = askKind(stored);
  const object: StmObject = {...rest, ...(typed ? {instructions: typed} : {}), ...(fit ? {fit} : {}), ...(rest.ask && kind ? {ask: {...rest.ask, kind}} : {})};
  const failure = currentFailureText(object.failure);
  // Carry this worker stop's retry decision to every client, without exposing its local recovery fields.
  // A later printer failure must not inherit Retry from an older worker stop.
  const canRetryCleanup = canRetryPass(object);
  // Never null: until a title is generated (or backfilled for an older project), the request's first words.
  // The companion's decision (copy, new design or published), so neither app re-derives it.
  // Local bookkeeping, like the passes' recovery fields below.
  const {failedPass: _failedPass, ...shown} = object;
  return {...shown, ...(object.kind === 'published' ? {plates: projectPlates(object)} : {}), kind: passKind(object), title: projectTitle(object), failure, canRetryCleanup, status: objectStatus({...object, ...(failure !== undefined ? {failure} : {})}, object.updatedAtMs),
    settings: projectSettingsView(object),
    passes: object.passes.map(({dir: _dir, activity, sessionId: _session, sessionCwd: _sessionCwd, resumable: _resumable, checkpoints: _checkpoints, resume: _resume, ...pass}) => ({...pass,
      summary: currentFailureText(pass.summary), activityCount: activity?.length ?? 0, ...(passWords(pass) ? {words: passWords(pass)} : {})}))};
}

function sendFrame(response: ServerResponse, frame: CameraFrame, match?: string): void {
  const etag = `"${createHash('sha256').update(frame.bytes).digest('base64url')}"`;
  response.statusCode = match === etag ? 304 : 200;
  response.setHeader('etag', etag);
  if (frame.stream) response.setHeader('x-camera-stream', '1');
  response.setHeader('content-type', 'image/jpeg');
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-captured-at', frame.capturedAt);
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(response.statusCode === 304 ? undefined : frame.bytes);
}

/** A bounded NDJSON stream; old clients continue receiving JPEG from the same path without stream=1. */
async function sendCameraStream(response: ServerResponse, authorize: () => Promise<void>, open: (signal: AbortSignal) => Promise<AsyncGenerator<CameraFrame>>): Promise<void> {
  const controller = new AbortController();
  const close = () => controller.abort();
  response.once('close', close);
  let frames: AsyncGenerator<CameraFrame> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    frames = await open(controller.signal);
    const first = await frames.next(); // Unsupported capability/errors still have an ordinary HTTP status.
    if (controller.signal.aborted) return;
    if (first.done) throw new CameraUnavailableError('unreachable');
    response.statusCode = 200;
    response.setHeader('content-type', 'application/x-ndjson');
    response.setHeader('x-camera-protocol', '1');
    response.setHeader('cache-control', 'private, no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.flushHeaders();
    let checking = false;
    heartbeat = setInterval(() => {
      if (checking) return;
      checking = true;
      void authorize().then(() => { if (!controller.signal.aborted && !response.write('\n')) close(); }, close)
        .finally(() => { checking = false; });
    }, 15000);
    heartbeat.unref?.();
    const write = async (frame: CameraFrame) => {
      controller.signal.throwIfAborted();
      await authorize();
      const line = JSON.stringify({v: 1, seq: frame.seq ?? 0, capturedAt: frame.capturedAt, base64: frame.bytes.toString('base64')}) + '\n';
      if (Buffer.byteLength(line) > 65536) throw new Error('Camera frame exceeded stream line limit');
      if (!response.write(line)) await once(response, 'drain', {signal: controller.signal});
    };
    await write(first.value);
    for await (const frame of frames) await write(frame);
  } catch (error) {
    if (!controller.signal.aborted && !response.headersSent) throw error;
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    await frames?.return(undefined).catch(() => undefined);
    response.off('close', close);
    if (response.headersSent && !response.writableEnded) response.end();
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

/** Phone-facing objects: start something, send its scan and photos, follow it, correct it, print it. */
export function createObjectRoutes(service: ObjectService, options: {printerSetup?: Pick<PrinterSetup, 'chooseMcp'>} = {}) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse, authorize: (scope: RemoteScope) => Promise<void>, header: (name: string) => string | undefined): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = PATH.exec(url.pathname);
      try {
        if (url.pathname === '/v1/objects/printers') {
          if (request.method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          return send(response, 200, service.printers());
        }
        const printerCamera = PRINTER_CAMERA.exec(url.pathname);
        if (printerCamera) {
          if (request.method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          if (url.searchParams.get('stream') === '1') return await sendCameraStream(response, () => authorize(PRINT), signal => service.printerCameraStream(printerCamera[1]!, {size: url.searchParams.get('size') === 'full' ? 'full' : 'card', signal}));
          return sendFrame(response, await service.printerCamera(printerCamera[1]!, {size: url.searchParams.get('size') === 'full' ? 'full' : 'card'}), header('if-none-match'));
        }
        const printerChoice = PRINTER_CHOICE.exec(url.pathname);
        if (printerChoice) {
          // The same companion methods as the Mac's Settings -> Printers (`printers.route`, `printers.chooseMcp`).
          // Reading needs printing; changing also needs settings, so a print-only token can't rewrite an MCP's .env.
          const [, destinationId, kind] = printerChoice as unknown as [string, string, 'route' | 'mcp'];
          if (kind === 'route' && request.method === 'GET') {
            await authorize(PRINT);
            return send(response, 200, {route: await service.printRoute(destinationId) ?? null});
          }
          if (request.method !== 'PUT' && request.method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT); await authorize(SETTINGS);
          const input = await json<unknown>(request);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'destinationId')) throw new HttpFailure(400, 'invalid-request');
          if (kind === 'route') {
            const parsed = parameters['printers.route'].safeParse({...input, destinationId});
            if (!parsed.success || !parsed.data.route) throw new HttpFailure(400, 'invalid-request');
            const route = await service.printRoute(destinationId, parsed.data.route);
            if (!route) throw new HttpFailure(409, 'not-supported', 'This printer’s MCP has no connection choice.');
            return send(response, 200, {route});
          }
          const parsed = parameters['printers.chooseMcp'].safeParse({...input, destinationId});
          if (!parsed.success) throw new HttpFailure(400, 'invalid-request');
          if (!options.printerSetup) throw new HttpFailure(503, 'unavailable', 'Counterpart on this Mac can’t change a printer’s MCP.');
          try {
            const selected = await options.printerSetup.chooseMcp(destinationId, parsed.data.backend);
            return send(response, 200, request.method === 'POST' ? {...selected, ...service.printers()} : selected);
          }
          catch (error) {
            if (!(error instanceof PrinterSetupError)) throw error;
            const status = error.code === 'not-found' ? 404 : error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : 503;
            throw new HttpFailure(status, error.code === 'invalid' ? 'invalid-request' : error.code, error.message);
          }
        }
        if (url.pathname === '/v1/settings/cad') {
          // The code design engine's row, read fresh: GET /v1/settings only carries the last answer.
          if (request.method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          return send(response, 200, {cad: await service.codeEngine()});
        }
        if (url.pathname === '/v1/settings/cad/setup') {
          // Settings → the code design engine's Set Up (PRD §8.9): the companion runs the printer MCP's cad_setup.
          if (request.method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(SETTINGS);
          const parsed = parameters['cad.setup'].safeParse(await json<unknown>(request));
          if (!parsed.success) throw new HttpFailure(400, 'invalid-request');
          try { await service.setupCad(); }
          catch (error) { if (error instanceof CadSetupRefused) throw new HttpFailure(409, 'conflict', error.message); throw error; }
          return send(response, 200, {settings: await service.settings()});
        }
        if (url.pathname === '/v1/settings/ai/test' || url.pathname === '/v1/settings/fusion/setup') {
          if (request.method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(SETTINGS);
          const input = await json<unknown>(request);
          const method = url.pathname.endsWith('/ai/test') ? 'modelAccess.check' : 'settings.get';
          const parsed = parameters[method].safeParse(input);
          if (!parsed.success) throw new HttpFailure(400, 'invalid-request');
          if ('revision' in parsed.data) service.testAI(parsed.data.revision);
          else await service.setupFusion();
          return send(response, 200, {settings: await service.settings()});
        }
        if (url.pathname === '/v1/settings') {
          if (request.method === 'GET') { await authorize(READ); return send(response, 200, {settings: await service.settings()}); }
          if (request.method !== 'PATCH') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(SETTINGS);
          const input = await json<Record<string, unknown>>(request);
          const patch = CompanionSettingsPatchSchema.safeParse(input);
          if (!patch.success) throw new HttpFailure(400, 'invalid-request');
          return send(response, 200, {settings: await service.updateSettings(patch.data)});
        }
        if (!match) throw new HttpFailure(404, 'not-found');
        const [, id, action] = match;
        const method = request.method ?? 'GET';
        if (action === 'settings' && id) {
          // PRD §5.4 Project Settings. This version takes Status; the other settings come later.
          if (method === 'GET') { await authorize(READ); return send(response, 200, {settings: projectSettingsView(await service.get(id))}); }
          if (method !== 'PATCH') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(WRITE);
          const input = await json<Record<string, unknown>>(request);
          const parsed = parameters['objects.settings.set'].safeParse({...input, id});
          if (!parsed.success || 'id' in input) throw new HttpFailure(400, 'invalid-request');
          const {id: _id, ...patch} = parsed.data;
          const updated = await service.setProjectSettings(id, patch);
          return send(response, 200, {settings: projectSettingsView(updated), object: publicObject(updated)});
        }
        if (!id) {
          if (method === 'GET') { await authorize(READ); return send(response, 200, {objects: (await service.list()).map(publicObject)}); }
          if (method === 'POST') {
            await authorize(WRITE);
            const input = await json<{instructions?: unknown; kind?: unknown; url?: unknown; starterId?: unknown; fit?: unknown}>(request);
            const {instructions, kind, url: link, starterId} = input;
            const fit = input.fit === undefined ? undefined : FitSchema.safeParse(input.fit);
            if (fit && !fit.success) throw new HttpFailure(400, 'invalid-request');
            if (starterId !== undefined) {
              if (typeof starterId !== 'string' || Object.keys(input).length !== 1) throw new HttpFailure(400, 'invalid-request');
              return send(response, 201, {object: publicObject(await service.addStarter(starterId))});
            }
            if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw new HttpFailure(400, 'invalid-request');
            if (kind !== undefined && kind !== 'fit' && kind !== 'copy' && kind !== 'published') throw new HttpFailure(400, 'invalid-request');
            if (link !== undefined && (typeof link !== 'string' || link.length > 2048)) throw new HttpFailure(400, 'invalid-request');
            return send(response, 201, {object: publicObject(await service.create(instructions, kind, link, fit?.data))});
          }
          throw new HttpFailure(405, 'method-not-allowed');
        }
        if (!action) {
          if (method === 'PATCH') {
            await authorize(WRITE);
            const {instructions, kind, fit: sent} = await json<{instructions?: unknown; kind?: unknown; fit?: unknown}>(request);
            if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw new HttpFailure(400, 'invalid-request');
            if (kind !== undefined && kind !== 'fit' && kind !== 'copy') throw new HttpFailure(400, 'invalid-request');
            // `fit: null` clears the choice (the draft became a copy).
            const fit = sent === undefined || sent === null ? undefined : FitSchema.safeParse(sent);
            if (fit && !fit.success) throw new HttpFailure(400, 'invalid-request');
            if (instructions === undefined && kind === undefined && sent === undefined) throw new HttpFailure(400, 'invalid-request');
            return send(response, 200, {object: publicObject(await service.updateDraft(id, {
              ...(instructions !== undefined ? {instructions} : {}), ...(kind !== undefined ? {kind} : {}),
              ...(sent === null ? {fit: null} : fit ? {fit: fit.data} : {})}))});
          }
          if (method === 'DELETE') {
            await authorize(WRITE);
            // The device id authorize() just checked: the event says which phone deleted it.
            await service.delete(id, header('x-scan-device'));
            return send(response, 200, {deleted: true});
          }
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          return send(response, 200, {object: publicObject(await service.view(id))});
        }
        if (action === 'plate-selection') {
          if (method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(WRITE);
          const input = await json<Record<string, unknown>>(request);
          const parsed = parameters['objects.selectPlate'].safeParse({...input, id});
          if (!parsed.success || 'id' in input) throw new HttpFailure(400, 'invalid-request');
          return send(response, 200, {object: publicObject(await service.selectPlate(id, parsed.data.fileIndex, parsed.data.plateIndex))});
        }
        if (action === 'filaments') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          return send(response, 200, {filaments: await service.filaments(id)});
        }
        if (action === 'colour-mapping') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          return send(response, 200, await service.colourMapping(id));
        }
        if (action.startsWith('passes/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const value = action.split('/')[1]!, index = Number(value);
          if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(index)) throw new HttpFailure(400, 'invalid-request');
          return send(response, 200, {activity: await service.passActivity(id, index)});
        }
        if (action.startsWith('original/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const index = Number(action.slice('original/'.length));
          const object = await service.get(id) as StmObject & {files?: {original?: unknown[]}};
          const path = Number.isSafeInteger(index) ? object.files?.original?.[index] : undefined;
          if (typeof path !== 'string' || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpFailure(404, 'not-found');
          const extension = path.split('.').at(-1)?.toLowerCase();
          const type = extension === 'stl' ? 'model/stl' : extension === '3mf' ? 'model/3mf' : extension === 'usdz' ? 'model/vnd.usdz+zip' : undefined;
          if (!type) throw new HttpFailure(404, 'not-found');
          const bytes = await exportFile(service.dir(id), path);
          response.statusCode = 200;
          response.setHeader('content-type', type);
          response.setHeader('cache-control', 'private, no-store');
          response.setHeader('x-content-type-options', 'nosniff');
          response.end(bytes);
          return;
        }
        if (action.startsWith('photos/') || action.startsWith('capture/') || action.startsWith('scan/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const kind = action.startsWith('photos/') ? 'photos' : action.startsWith('scan/') ? 'scan' : 'capture';
          let name: string;
          try { name = decodeURIComponent(action.slice(kind.length + 1)); }
          catch { throw new HttpFailure(404, 'not-found'); }
          if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) || name.includes('..')) throw new HttpFailure(404, 'not-found');
          const extension = name.split('.').at(-1)?.toLowerCase();
          const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
            : extension === 'png' ? 'image/png' : extension === 'heic' ? 'image/heic'
            : kind === 'scan' && extension === 'usdz' ? 'model/vnd.usdz+zip'
            : kind === 'scan' && extension === 'stl' ? 'model/stl'
            : kind === 'scan' && extension === '3mf' ? 'model/3mf' : undefined;
          const object = await service.get(id);
          if (!type || !(kind === 'scan' ? object.scan === name : object[kind]?.includes(name))) throw new HttpFailure(404, 'not-found');
          const bytes = await exportFile(service.dir(id), `${kind}/${name}`);
          response.statusCode = 200;
          response.setHeader('content-type', type);
          response.setHeader('x-content-type-options', 'nosniff');
          response.setHeader('cache-control', 'private, no-store');
          response.end(bytes);
          return;
        }
        if (action.startsWith('asks/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const object = await service.get(id);
          // The Ask's own picture only, never another file under the project.
          if (!object.ask?.photo || object.ask.photo !== action) throw new HttpFailure(404, 'not-found');
          const bytes = await readFile(join(service.dir(id), action)).catch(() => { throw new HttpFailure(404, 'not-found'); });
          response.statusCode = 200;
          // JPEG, except on a host without sips, where a PNG render is passed on as it is.
          response.setHeader('content-type', bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : 'image/jpeg');
          response.setHeader('cache-control', 'private, no-store');
          response.setHeader('x-content-type-options', 'nosniff');
          response.end(bytes);
          return;
        }
        if (action.startsWith('prints/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          await service.get(id);
          const bytes = await readFile(join(service.dir(id), action)).catch(() => { throw new HttpFailure(404, 'not-found'); });
          response.statusCode = 200;
          response.setHeader('content-type', 'image/jpeg');
          response.setHeader('cache-control', 'private, max-age=86400');
          response.setHeader('x-content-type-options', 'nosniff');
          response.end(bytes);
          return;
        }
        if (action === 'camera.jpg') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          if (url.searchParams.get('stream') === '1') return await sendCameraStream(response, () => authorize(PRINT), signal => service.cameraStream(id, {size: url.searchParams.get('size') === 'full' ? 'full' : 'card', signal}));
          return sendFrame(response, await service.camera(id, {size: url.searchParams.get('size') === 'full' ? 'full' : 'card'}), header('if-none-match'));
        }
        if (action === 'estimate') {
          if (method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          const input = await json<unknown>(request);
          const parsed = parameters['objects.estimate'].safeParse({...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}), id});
          if (!parsed.success || (input && typeof input === 'object' && Object.hasOwn(input, 'id'))) throw new HttpFailure(400, 'invalid-request');
          const {id: _id, ...estimate} = parsed.data;
          return send(response, 200, await service.estimate(id, estimate));
        }
        if (action.startsWith('print/')) {
          if (method !== 'POST') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          await json<unknown>(request);
          return send(response, 200, {object: publicObject(await service.control(id, action.slice('print/'.length) as 'pause' | 'resume' | 'cancel'))});
        }
        if (action === 'reconstruction-preview.stl') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const reviewId = url.searchParams.get('reviewId') ?? '';
          if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new HttpFailure(404, 'not-found');
          // Only the current review's own preview; the service refuses any other id.
          const relative = await service.reconstructionPreview(id, reviewId);
          const bytes = await exportFile(service.dir(id), relative);
          response.statusCode = 200;
          response.setHeader('content-type', 'model/stl');
          response.setHeader('cache-control', 'private, no-store');
          response.setHeader('x-content-type-options', 'nosniff');
          response.end(bytes);
          return;
        }
        if (action === 'model.stl' || action.startsWith('renders/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const object = await service.get(id);
          const relative = action === 'model.stl' ? object.current?.model
            : [...(object.current?.renders ?? []), ...(object.files?.receipts?.flatMap(file => file.plates.flatMap(plate => plate.thumbnail ? [plate.thumbnail] : [])) ?? [])].find(render => basename(render) === decodeURIComponent(action.slice('renders/'.length)));
          if (!relative) throw new HttpFailure(404, 'not-found');
          const bytes = await exportFile(service.dir(id), relative);
          response.statusCode = 200;
          response.setHeader('content-type', action === 'model.stl' ? (relative?.endsWith('.3mf') ? 'model/3mf' : 'model/stl') : 'image/png');
          response.end(bytes);
          return;
        }
        if (method !== (action === 'scan' ? 'PUT' : 'POST')) throw new HttpFailure(405, 'method-not-allowed');
        await authorize(['print', 'printer', 'print-confirmation'].includes(action) ? PRINT : WRITE);
        let object: StmObject;
        switch (action) {
          case 'scan': {
            const name = url.searchParams.get('name') ?? 'scan.usdz';
            if (!/^scan\.(usdz|stl|3mf)$/.test(name)) throw new HttpFailure(400, 'invalid-name');
            const preview = url.searchParams.get('preview') === 'true';
            object = await service.receive(id, async () => service.addScan(id, name, await body(request, MAX_SCAN), {preview}));
            break;
          }
          case 'ask': {
            // A choice Ask's answer (PR 7): {askId, choices: [optionId]}.
            const input = await json<{askId?: unknown; choices?: unknown}>(request);
            if (typeof input.askId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.askId) || !Array.isArray(input.choices) || input.choices.length > 32
              || input.choices.some(choice => typeof choice !== 'string' || choice.length > 64)) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerAsk(id, input.askId, input.choices as string[]);
            break;
          }
          case 'model': {
            // PRD §8.11: the designer's file, shared for a file Ask (3MF or STL, ≤ 64 MiB).
            const name = url.searchParams.get('name') ?? '';
            if (!/\.(3mf|stl)$/i.test(name) || name.length > 255 || /[\/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new HttpFailure(400, 'invalid-name');
            object = await service.addModelFile(id, name, await body(request, MAX_SCAN));
            break;
          }
          case 'capture-manifest': {
            // A walk-around names its every image before sending any (source: object-capture).
            object = await service.declareCapture(id, await json<unknown>(request, 256 * 1024));
            break;
          }
          case 'capture-camera': {
            // capture-camera v1 JSON, bound by the service to the exact saved photos.
            const input = await json<unknown>(request, 4 * 1024 * 1024);
            object = await service.addCaptureCamera(id, input);
            break;
          }
          case 'reconstruction': {
            const input = await json<{reviewId?: unknown; answer?: unknown}>(request, 64 * 1024);
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || Object.keys(input).some(key => !['reviewId', 'answer'].includes(key))) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerReconstruction(id, input.reviewId, input.answer);
            break;
          }
          case 'capture-depth': {
            const name = url.searchParams.get('name') ?? '';
            if (!/^[0-9]{4}\.depth\.plist$/.test(name)) throw new HttpFailure(400, 'invalid-name');
            object = await service.receive(id, async () => service.addCaptureDepth(id, name, await body(request, MAX_DEPTH)));
            break;
          }
          case 'photos':
          case 'capture': {
            const messageIntent = url.searchParams.get('forMessage');
            if (action === 'photos' && messageIntent !== null && !['true', 'false'].includes(messageIntent)) throw new HttpFailure(400, 'invalid-for-message');
            const name = url.searchParams.get('name') ?? '';
            if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) || name.includes('..')) throw new HttpFailure(400, 'invalid-name');
            object = await service.receive(id, async () => {
              const bytes = await body(request, MAX_PHOTO);
              return action === 'capture' ? service.addCapturePhoto(id, name, bytes) : service.addPhoto(id, name, bytes, messageIntent === 'true');
            });
            break;
          }
          case 'start': {
            const input = await json<unknown>(request, 128 * 1024);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpFailure(400, 'invalid-request');
            object = await service.start(id, (input as {captureManifest?: unknown}).captureManifest);
            break;
          }
          case 'printer': {
            const {destinationId} = await json<{destinationId?: unknown}>(request);
            if (typeof destinationId !== 'string' || !destinationId.length || destinationId.length > 256) throw new HttpFailure(400, 'invalid-request');
            object = await service.selectPrinter(id, destinationId);
            break;
          }
          case 'duplicate': { object = await service.duplicate(id); break; }
          case 'corrections': {
            const {note, photoNames} = await json<{note?: unknown; photoNames?: unknown}>(request);
            if (typeof note !== 'string' || !note.trim() || note.length > 4000) throw new HttpFailure(400, 'invalid-request');
            if (photoNames !== undefined && (!Array.isArray(photoNames) || photoNames.length > 100 || photoNames.some(name => typeof name !== 'string' || name.length > 128))) throw new HttpFailure(400, 'invalid-request');
            object = await service.correct(id, note, [], photoNames as string[] | undefined);
            break;
          }
          case 'closeup': {
            const input = await json<{bestGuess?: unknown; text?: unknown; photoNames?: unknown; sizes?: unknown}>(request);
            if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000)) throw new HttpFailure(400, 'invalid-request');
            // A sizes question's numbers: {id, mm} for the sizes it listed.
            const sizes = input.sizes === undefined ? undefined : z.array(z.strictObject({id: z.string().min(1).max(64), mm: z.number().positive().max(10_000)})).min(1).max(6).safeParse(input.sizes);
            if (sizes && !sizes.success) throw new HttpFailure(400, 'invalid-request');
            if (input.photoNames !== undefined && (!Array.isArray(input.photoNames) || input.photoNames.length > 100 || input.photoNames.some(name => typeof name !== 'string' || !name || name.length > 128))) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerCloseup(id, {photoNames: input.photoNames as string[] | undefined, bestGuess: input.bestGuess === true, ...(typeof input.text === 'string' ? {text: input.text} : {}), ...(sizes ? {sizes: sizes.data} : {})});
            break;
          }
          case 'print': {
            const input = await json<unknown>(request);
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpFailure(400, 'invalid-request');
            const parsed = parameters['objects.print'].safeParse({...(input as object), id});
            if (!parsed.success || Object.hasOwn(input, 'id')) throw new HttpFailure(400, 'invalid-request');
            const {id: _id, ...options} = parsed.data;
            object = await service.print(id, options);
            break;
          }
          case 'print-confirmation': {
            const input = await json<unknown>(request);
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || Object.keys(input).some(key => !['confirmationId', 'answer'].includes(key))) throw new HttpFailure(400, 'invalid-request');
            const {confirmationId, answer} = input as {confirmationId?: unknown; answer?: unknown};
            if (typeof confirmationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(confirmationId)) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerPrintConfirmation(id, confirmationId, answer);
            break;
          }
          default: throw new HttpFailure(404, 'not-found');
        }
        return send(response, 200, {object: publicObject(object)});
      } catch (error) {
        // Every refusal is logged with its status and code (Nov 6: a refusal nobody could see). `sentence` marks a
        // message written for the person, which the apps show as it is.
        const refuse = (status: number, code: string, message: string, sentence = false) => {
          console.error(`http ${request.method} ${url.pathname} refused: ${status} ${code}: ${message}`);
          return send(response, status, {error: {code, message, ...(sentence ? {sentence: message} : {})}});
        };
        if (error instanceof PrinterSetupError) return refuse(error.code === 'conflict' ? 409 : error.code === 'invalid' ? 400 : error.code === 'not-found' ? 404 : 503, error.code === 'invalid' ? 'invalid-request' : error.code, error.message, true);
        if (error instanceof ControlFailure) return refuse(error.code === 'conflict' ? 409 : error.code === 'invalid-request' ? 400 : 503, error.code, error.message, error.code !== 'internal');
        if (error instanceof HttpFailure) return refuse(error.status, error.code, error.message);
        if (error instanceof ObjectNotFoundError) return refuse(404, 'not-found', 'Object not found');
        if (error instanceof InvalidAnswerError) return refuse(400, 'invalid-request', error.message, true);
        if (error instanceof InvalidStateError) return refuse(409, 'invalid-state', error.message, true);
        if (error instanceof InvalidCaptureManifestError) return refuse(400, 'invalid-request', error.message);
        if (error instanceof InvalidCaptureCameraError) return refuse(400, 'invalid-request', error.message);
        if (error instanceof CameraUnavailableError) return refuse(error.reason === 'unreachable' ? 503 : 404, error.reason === 'not-supported' ? 'not-supported' : error.reason === 'no-camera' ? 'not-found' : 'unavailable', error.message);
        if (error instanceof Error && error.message === 'Invalid file name') return refuse(400, 'invalid-name', error.message);
        throw error;
      }
    },
  };
}
