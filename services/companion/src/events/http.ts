import type {IncomingMessage, ServerResponse} from 'node:http';
import type {RemoteScope} from '../remote-auth.js';
import {MAX_PAGE, MAX_WAIT_MS, type EventLog} from './log.js';

export const MAX_LONG_POLLS = 32;
const READ: RemoteScope = 'projects:read';

function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
}
const integer = (value: string | null, fallback: number, min: number, max: number): number | undefined => {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
};

/** `GET /v1/events?after=&wait=&limit=` (PRD §8.7): the phone's long poll. */
export function createEventRoutes(log: EventLog) {
  let polls = 0;
  return {
    async handle(request: IncomingMessage, response: ServerResponse, authorize: (scope: RemoteScope) => Promise<void>): Promise<void> {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/v1/events') return send(response, 404, {error: {code: 'not-found', message: 'not-found'}});
      if (request.method !== 'GET') return send(response, 405, {error: {code: 'method-not-allowed', message: 'method-not-allowed'}});
      await authorize(READ);
      const after = integer(url.searchParams.get('after'), 0, 0, Number.MAX_SAFE_INTEGER);
      const wait = integer(url.searchParams.get('wait'), 0, 0, MAX_WAIT_MS / 1000);
      const limit = integer(url.searchParams.get('limit'), 100, 0, MAX_PAGE);
      if (after === undefined || wait === undefined || limit === undefined || [...url.searchParams.keys()].some(key => !['after', 'wait', 'limit'].includes(key)))
        return send(response, 400, {error: {code: 'invalid-request', message: 'invalid-request'}});
      const holding = wait > 0 && log.page(after, limit).events.length === 0;
      if (holding && polls >= MAX_LONG_POLLS) {
        response.setHeader('retry-after', '1');
        return send(response, 503, {error: {code: 'busy', message: 'Too many waiting requests. Try again in a second.'}});
      }
      const gone = new AbortController();
      const hangUp = () => gone.abort();
      response.once('close', hangUp);
      if (holding) polls++;
      try {
        const page = await log.wait(after, {waitMs: wait * 1000, limit, signal: gone.signal});
        if (gone.signal.aborted) return;
        // The pairing may have been revoked while the request waited.
        await authorize(READ);
        send(response, 200, page);
      } finally {
        if (holding) polls--;
        response.off('close', hangUp);
      }
    },
  };
}
