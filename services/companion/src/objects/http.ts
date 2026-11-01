import type {IncomingMessage, ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import type {RemoteScope} from '../remote-auth.js';
import {InvalidStateError, type ObjectService} from './service.js';
import {ObjectNotFoundError, type StmObject} from './store.js';

const READ: RemoteScope = 'projects:read', WRITE: RemoteScope = 'captures:import', PRINT: RemoteScope = 'printer-handoff:use';
const MAX_SCAN = 64 * 1024 * 1024, MAX_PHOTO = 25 * 1024 * 1024, MAX_JSON = 16 * 1024;
const PATH = /^\/v1\/objects(?:\/([0-9a-f-]{36})(?:\/(scan|photos|capture|start|corrections|closeup|print|plate\.jpg|plate|model\.stl|renders\/[^/]+))?)?$/;

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
async function json<T>(request: IncomingMessage): Promise<T> {
  const bytes = await body(request, MAX_JSON);
  if (!bytes.length) return {} as T;
  try { return JSON.parse(bytes.toString('utf8')) as T; } catch { throw new HttpFailure(400, 'invalid-request'); }
}

/** What the phone sees: no Mac file paths. */
export function publicObject(object: StmObject): StmObject {
  return {...object, passes: object.passes.map(({dir: _dir, ...pass}) => pass)};
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

/** Phone-facing objects: start something, send its scan and photos, follow it, correct it, print it. */
export function createObjectRoutes(service: ObjectService) {
  return {
    async handle(request: IncomingMessage, response: ServerResponse, authorize: (scope: RemoteScope) => Promise<void>, _header: (name: string) => string | undefined): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = PATH.exec(url.pathname);
      try {
        if (!match) throw new HttpFailure(404, 'not-found');
        const [, id, action] = match;
        const method = request.method ?? 'GET';
        if (!id) {
          if (method === 'GET') { await authorize(READ); return send(response, 200, {objects: (await service.list()).map(publicObject)}); }
          if (method === 'POST') {
            await authorize(WRITE);
            const {instructions} = await json<{instructions?: unknown}>(request);
            if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw new HttpFailure(400, 'invalid-request');
            return send(response, 201, {object: publicObject(await service.create(instructions))});
          }
          throw new HttpFailure(405, 'method-not-allowed');
        }
        if (!action) {
          if (method === 'DELETE') {
            await authorize(WRITE);
            await service.delete(id);
            return send(response, 200, {deleted: true});
          }
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(READ);
          return send(response, 200, {object: publicObject(await service.get(id))});
        }
        if (action === 'plate.jpg') {
          if (method !== 'GET') throw new HttpFailure(405, 'method-not-allowed');
          await authorize(PRINT);
          if (!(await service.get(id)).plate?.photo) throw new HttpFailure(404, 'not-found');
          const bytes = await readFile(join(service.dir(id), 'plate.jpg')).catch(() => { throw new HttpFailure(404, 'not-found'); });
          response.statusCode = 200;
          response.setHeader('content-type', 'image/jpeg');
          response.end(bytes);
          return;
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
        await authorize(action === 'print' || action === 'plate' ? PRINT : WRITE);
        let object: StmObject;
        switch (action) {
          case 'scan': object = await service.addScan(id, 'scan.usdz', await body(request, MAX_SCAN)); break;
          case 'photos':
          case 'capture': {
            const name = url.searchParams.get('name') ?? '';
            if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) || name.includes('..')) throw new HttpFailure(400, 'invalid-name');
            const bytes = await body(request, MAX_PHOTO);
            object = action === 'capture' ? await service.addCapturePhoto(id, name, bytes) : await service.addPhoto(id, name, bytes);
            break;
          }
          case 'start': object = await service.start(id); break;
          case 'corrections': {
            const {note} = await json<{note?: unknown}>(request);
            if (typeof note !== 'string' || !note.trim() || note.length > 4000) throw new HttpFailure(400, 'invalid-request');
            object = await service.correct(id, note);
            break;
          }
          case 'closeup': object = await service.answerCloseup(id, {bestGuess: (await json<{bestGuess?: unknown}>(request)).bestGuess === true}); break;
          case 'print': object = await service.print(id, (await json<{checked?: unknown}>(request)).checked === true ? {checked: true} : {}); break;
          case 'plate': {
            if ((await json<{clear?: unknown}>(request)).clear !== true) throw new HttpFailure(400, 'invalid-request');
            object = await service.answerPlate(id, {clear: true});
            break;
          }
          default: throw new HttpFailure(404, 'not-found');
        }
        return send(response, 200, {object: publicObject(object)});
      } catch (error) {
        if (error instanceof HttpFailure) return send(response, error.status, {error: {code: error.code, message: error.message}});
        if (error instanceof ObjectNotFoundError) return send(response, 404, {error: {code: 'not-found', message: 'Object not found'}});
        if (error instanceof InvalidStateError) return send(response, 409, {error: {code: 'invalid-state', message: error.message}});
        if (error instanceof Error && error.message === 'Invalid file name') return send(response, 400, {error: {code: 'invalid-name', message: error.message}});
        throw error;
      }
    },
  };
}
