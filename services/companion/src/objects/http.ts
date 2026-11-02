import type {IncomingMessage, ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import type {RemoteScope} from '../remote-auth.js';
import {InvalidAnswerError, InvalidCaptureManifestError, InvalidStateError, projectStatus, type ObjectService} from './service.js';
import {CameraUnavailableError, type CameraFrame} from '../printing/camera.js';
import {MilestonesSchema, type ObjectStatus, type ProjectStatus} from '@scan-to-make/contracts/counterpart';
import {objectStatus, projectTitle} from '../events/words.js';
import {ObjectNotFoundError, type ObjectPass, type StmObject} from './store.js';
import {RECONSTRUCTION_FAILED} from './reconstruct.js';
import {parameters} from '../local-control-protocol.js';

const READ: RemoteScope = 'projects:read', WRITE: RemoteScope = 'captures:import', PRINT: RemoteScope = 'printer-handoff:use';
const MAX_SCAN = 64 * 1024 * 1024, MAX_PHOTO = 25 * 1024 * 1024, MAX_JSON = 16 * 1024;
const MAX_DEPTH = 8 * 1024 * 1024;
const PATH = /^\/v1\/objects(?:\/([0-9a-f-]{36})(?:\/(scan|settings|photos|capture|capture-depth|start|corrections|closeup|print|print\/pause|print\/resume|print\/cancel|estimate|camera\.jpg|prints\/[0-9a-f-]{36}\/frames\/[0-9a-f-]{36}\.jpg|asks\/[0-9a-f-]{36}\.jpg|filaments|print-confirmation|printer|model\.stl|passes\/[^/]+\/activity|(?:renders|photos|capture)\/[^/]+))?)?$/;
const PRINTER_CAMERA = /^\/v1\/objects\/printers\/([A-Za-z0-9_-]{1,256})\/camera\.jpg$/;
const SETTINGS: RemoteScope = 'projects:write';

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
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

export type PublicObject = Omit<StmObject, 'passes' | 'title'> & {title: string; status: ObjectStatus; settings: {status: ProjectStatus; archived: boolean}; passes: (Omit<ObjectPass, 'dir' | 'activity'> & {activityCount: number})[]};

// Earlier generic failures asserted a capture mistake without evidence. Correct the displayed
// advice for those retained attempts too, leaving their original stored records intact.
function currentFailureText(message: string | undefined): string | undefined {
  return message === "Your Mac couldn't build a model from these photos. Try again with the object filling more of the frame, turning it slowly."
    ? RECONSTRUCTION_FAILED : message;
}

/** Project metadata stays small; retained activity is read one pass at a time. */
/** Project Settings as the apps read them: the status, and whether it's hidden from Home. */
export function projectSettingsView(object: StmObject): {status: ProjectStatus; archived: boolean} {
  return {status: projectStatus(object), archived: !!object.archived};
}

export function publicObject(object: StmObject): PublicObject {
  const failure = currentFailureText(object.failure);
  // Never null: until a title is generated (or backfilled for an older project), the request's first words.
  return {...object, title: projectTitle(object), failure, status: objectStatus({...object, ...(failure !== undefined ? {failure} : {})}, object.updatedAtMs),
    settings: projectSettingsView(object),
    passes: object.passes.map(({dir: _dir, activity, ...pass}) => ({...pass,
      summary: currentFailureText(pass.summary), activityCount: activity?.length ?? 0}))};
}

function sendFrame(response: ServerResponse, frame: CameraFrame): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'image/jpeg');
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-captured-at', frame.capturedAt);
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(frame.bytes);
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

/** Phone-facing objects: start something, send its scan and photos, follow it, correct it, print it. */
export function createObjectRoutes(service: ObjectService) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse, authorize: (scope: RemoteScope) => Promise<void>, header: (name: string) => string | undefined): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = PATH.exec(url.pathname);
      try {
        if (url.pathname === '/v1/objects/printers') {
          if (request.method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          return send(response, 200, service.printers({view: true}));
        }
        const printerCamera = PRINTER_CAMERA.exec(url.pathname);
        if (printerCamera) {
          if (request.method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          return sendFrame(response, await service.printerCamera(printerCamera[1]!));
        }
        if (url.pathname === '/v1/settings') {
          if (request.method === 'GET') { await authorize(READ); return send(response, 200, {settings: await service.settings()}); }
          if (request.method !== 'PATCH') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(SETTINGS);
          const input = await json<Record<string, unknown>>(request);
          const milestones = MilestonesSchema.safeParse(input.milestones);
          if (!milestones.success || Object.keys(input).some(key => key !== 'milestones')) throw new HttpFailure(400, 'invalid-request');
          return send(response, 200, {settings: await service.updateSettings({milestones: milestones.data})});
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
          const {status, archived, title} = parsed.data;
          let updated = status !== undefined ? await service.setStatus(id, status) : await service.get(id);
          if (archived !== undefined) updated = await service.setArchived(id, archived);
          if (title !== undefined) updated = await service.rename(id, title);
          return send(response, 200, {settings: projectSettingsView(updated), object: publicObject(updated)});
        }
        if (!id) {
          if (method === 'GET') { await authorize(READ); return send(response, 200, {objects: (await service.list()).map(publicObject)}); }
          if (method === 'POST') {
            await authorize(WRITE);
            const {instructions, kind} = await json<{instructions?: unknown; kind?: unknown}>(request);
            if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw new HttpFailure(400, 'invalid-request');
            if (kind !== undefined && kind !== 'fit' && kind !== 'copy') throw new HttpFailure(400, 'invalid-request');
            return send(response, 201, {object: publicObject(await service.create(instructions, kind))});
          }
          throw new HttpFailure(405, 'method-not-allowed');
        }
        if (!action) {
          if (method === 'PATCH') {
            await authorize(WRITE);
            const {instructions} = await json<{instructions?: unknown}>(request);
            if (typeof instructions !== 'string' || instructions.length > 8000) throw new HttpFailure(400, 'invalid-request');
            return send(response, 200, {object: publicObject(await service.updateInstructions(id, instructions))});
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
        if (action === 'filaments') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          return send(response, 200, {filaments: await service.filaments(id)});
        }
        if (action.startsWith('passes/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const value = action.split('/')[1]!, index = Number(value);
          if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(index)) throw new HttpFailure(400, 'invalid-request');
          return send(response, 200, {activity: await service.passActivity(id, index)});
        }
        if (action.startsWith('photos/') || action.startsWith('capture/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const kind = action.startsWith('photos/') ? 'photos' : 'capture';
          let name: string;
          try { name = decodeURIComponent(action.slice(kind.length + 1)); }
          catch { throw new HttpFailure(404, 'not-found'); }
          if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) || name.includes('..')) throw new HttpFailure(404, 'not-found');
          const extension = name.split('.').at(-1)?.toLowerCase();
          const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
            : extension === 'png' ? 'image/png' : extension === 'heic' ? 'image/heic' : undefined;
          if (!type || !(await service.get(id))[kind]?.includes(name)) throw new HttpFailure(404, 'not-found');
          const bytes = await readFile(join(service.dir(id), kind, name)).catch(() => { throw new HttpFailure(404, 'not-found'); });
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
          return sendFrame(response, await service.camera(id));
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
        if (action === 'model.stl' || action.startsWith('renders/')) {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          const object = await service.get(id);
          const relative = action === 'model.stl' ? object.current?.model
            : object.current?.renders.find(render => basename(render) === decodeURIComponent(action.slice('renders/'.length)));
          if (!relative) throw new HttpFailure(404, 'not-found');
          const bytes = await readFile(join(service.dir(id), relative));
          response.statusCode = 200;
          response.setHeader('content-type', action === 'model.stl' ? 'model/stl' : 'image/png');
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
            object = await service.receive(id, async () => service.addScan(id, name, await body(request, MAX_SCAN)));
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
            const name = url.searchParams.get('name') ?? '';
            if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) || name.includes('..')) throw new HttpFailure(400, 'invalid-name');
            object = await service.receive(id, async () => {
              const bytes = await body(request, MAX_PHOTO);
              return action === 'capture' ? service.addCapturePhoto(id, name, bytes) : service.addPhoto(id, name, bytes);
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
          case 'corrections': {
            const {note, photoNames} = await json<{note?: unknown; photoNames?: unknown}>(request);
            if (typeof note !== 'string' || !note.trim() || note.length > 4000) throw new HttpFailure(400, 'invalid-request');
            if (photoNames !== undefined && (!Array.isArray(photoNames) || photoNames.length > 100 || photoNames.some(name => typeof name !== 'string' || name.length > 128))) throw new HttpFailure(400, 'invalid-request');
            object = await service.correct(id, note, [], photoNames as string[] | undefined);
            break;
          }
          case 'closeup': {
            const input = await json<{bestGuess?: unknown; text?: unknown}>(request);
            if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000)) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerCloseup(id, {bestGuess: input.bestGuess === true, ...(typeof input.text === 'string' ? {text: input.text} : {})});
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
        if (error instanceof HttpFailure) return send(response, error.status, {error: {code: error.code, message: error.message}});
        if (error instanceof ObjectNotFoundError) return send(response, 404, {error: {code: 'not-found', message: 'Object not found'}});
        if (error instanceof InvalidAnswerError) return send(response, 400, {error: {code: 'invalid-request', message: error.message}});
        if (error instanceof InvalidStateError) return send(response, 409, {error: {code: 'invalid-state', message: error.message}});
        if (error instanceof InvalidCaptureManifestError) return send(response, 400, {error: {code: 'invalid-request', message: error.message}});
        if (error instanceof CameraUnavailableError) return send(response, error.reason === 'no-camera' ? 404 : 503, {error: {code: error.reason === 'no-camera' ? 'not-found' : 'unavailable', message: error.message}});
        if (error instanceof Error && error.message === 'Invalid file name') return send(response, 400, {error: {code: 'invalid-name', message: error.message}});
        throw error;
      }
    },
  };
}
