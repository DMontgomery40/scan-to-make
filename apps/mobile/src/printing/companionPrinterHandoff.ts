import { z } from 'zod';
import type { CaptureFile } from '../capture/retainedCaptures';
import {
  PRINTER_BACKENDS,
  type CameraSnapshot,
  type Confirmation,
  type ConfirmationAnswer,
  type Handoff,
  type PrinterBackend,
  type PrinterHandoff,
  type PrinterOption,
} from './printerHandoff';

type HandoffRequest = {
  context: string;
  method: 'GET' | 'POST';
  path: string;
  /** JSON body, for confirmation answers. */
  body?: string;
  /** The verified local model, sent byte for byte as the upload body. */
  source?: CaptureFile;
  prompt?: string;
  backend?: PrinterBackend;
};
type HandoffResponse = { status: number; body: string };

/**
 * Native transport for the companion's printer-handoff routes
 * (PrinterHandoffBridge). The native side owns the pairing credential,
 * allowlists each route, checks the `printer-handoff:use` scope, and uploads
 * the model only after re-verifying its cached bytes against `source`.
 */
export interface PrinterHandoffNative {
  context(): Promise<string>;
  request(options: HandoffRequest): Promise<HandoffResponse>;
  cancel(): Promise<void>;
}

const ROOT = '/v1/printer-handoff';
const STATUSES = ['ready', 'claimed', 'designed', 'sliced', 'printed', 'uncertain', 'failed'] as const;
const backendSchema = z.enum(PRINTER_BACKENDS as [PrinterBackend, PrinterBackend]);
// The companion keeps every job; the bridge caps the list reply at 6 MB.
const MAX_BUNDLES = 10000;
const manifestSchema = z.object({
  id: z.uuid(),
  backend: backendSchema,
  status: z.enum(STATUSES),
  prompt: z.string().max(8000).optional(),
  failure: z.string().max(2048).optional(),
});
const bundleResponse = z.object({ bundle: manifestSchema, printing: z.boolean().optional() });
const listedResponse = z.object({
  bundles: z
    .array(
      manifestSchema.extend({
        createdAtMs: z.number().finite().optional(),
        cleanStl: z.object({ sha256: z.string() }).optional(),
      }),
    )
    .max(MAX_BUNDLES),
});
// Just the ids, skipping any entry this app can't read, so one odd job on
// the companion never stops a new send.
const listedIds = z.object({ bundles: z.array(z.unknown()).max(MAX_BUNDLES) });
// Phone and companion clocks can differ, so a lost send recorded without the
// handoffs listed before it is matched from ten minutes before it started.
const CLOCK_SLACK_MS = 10 * 60000;
const selectionSchema = z
  .object({ printerType: z.string().max(64).optional(), model: z.string().max(128).optional() })
  .optional();
const backendsResponse = z.object({
  backends: z
    .array(z.union([backendSchema, z.object({ backend: backendSchema, selection: selectionSchema })]))
    .max(2),
});
const pendingSchema = z.object({
  id: z.uuid(),
  mode: z.enum(['form', 'url']),
  message: z.string().max(4000),
  requestedSchema: z.unknown().optional(),
  url: z.string().max(2048).optional(),
  cameraSnapshot: z.object({ format: z.string().max(16), base64: z.string() }).optional(),
  createdAtMs: z.number().finite().optional(),
  expiresAtMs: z.number().finite(),
});
const pendingResponse = z.object({ elicitations: z.array(pendingSchema).max(32) });

const SNAPSHOT_TYPES: Record<string, CameraSnapshot['mediaType']> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
};
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SNAPSHOT_BASE64 = 4 * 1024 * 1024;

function snapshot(value?: { format: string; base64: string }): CameraSnapshot | undefined {
  const mediaType = value && SNAPSHOT_TYPES[value.format.toLowerCase()];
  if (!value || !mediaType || value.base64.length > MAX_SNAPSHOT_BASE64) return undefined;
  return BASE64.test(value.base64) ? { mediaType, base64: value.base64 } : undefined;
}

function serverCode(body: string): string | undefined {
  try {
    const code = JSON.parse(body)?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

const MESSAGES: Record<string, string> = {
  'print-busy': 'Your companion is already printing another job. Wait for it to finish, then try again.',
  'backend-unavailable':
    'Your companion isn’t set up for that printer software. Choose the other one, or set it up on your computer.',
  'backend-mismatch':
    'Your companion is now set up for different printer software. Send the model again.',
  'invalid-stl': 'Your companion couldn’t read this model. Check the scan again, then send it.',
  'payload-too-large': 'This model is too large to send to your printer.',
  'handoff-unavailable': 'Your companion couldn’t hand this to your printer software. Check it on your computer.',
  'elicitation-not-pending': 'That question has already ended.',
  'dispatch-uncertain':
    'Your companion asked your printer software to print, then lost touch with it, so this may already be printing. Check your printer. It won’t be sent again from here.',
  'already-printed': 'This job was already sent to your printer.',
};

function failure(response: HandoffResponse, what: string): never {
  const code = serverCode(response.body);
  const { status } = response;
  const message =
    (code && MESSAGES[code]) ??
    (status === 401
      ? 'Your companion connection expired or was revoked. Connect again.'
      : status === 403
      ? 'This connection can’t send to your printer yet. Scan a new QR code from your companion to pair again.'
      : status === 404
      ? `${what} isn’t on your companion any more.`
      : status === 429
      ? 'Your companion is busy. Try again shortly.'
      : `Your companion couldn’t complete this request (${status}).`);
  throw Object.assign(Error(message), { code: code ?? 'unavailable', status });
}

function parse<T>(schema: z.ZodType<T>, body: string): T {
  try {
    return schema.parse(JSON.parse(body));
  } catch {
    throw Object.assign(Error('Your companion sent a reply this app can’t read. Check that both are up to date.'), {
      code: 'invalid-response',
    });
  }
}

const notAvailable = () =>
  Object.assign(Error('Your companion can’t send to a printer yet. Update it, then try again.'), {
    code: 'not-available',
    status: 404,
  });

const handoffOf = (value: z.infer<typeof bundleResponse>): Handoff => ({
  id: value.bundle.id,
  backend: value.bundle.backend,
  status: value.bundle.status,
  ...(value.bundle.prompt ? { prompt: value.bundle.prompt } : {}),
  ...(value.bundle.failure ? { failure: value.bundle.failure } : {}),
  ...(value.printing !== undefined ? { printing: value.printing } : {}),
});

/** The live client for the companion's `/v1/printer-handoff` routes (KAN-132). */
export function companionPrinterHandoff(native: PrinterHandoffNative): PrinterHandoff {
  const send = async (options: Omit<HandoffRequest, 'context'>) =>
    native.request({ ...options, context: await native.context() });
  const ok = (status: number) => status >= 200 && status < 300;
  return {
    async backends() {
      const response = await send({ method: 'GET', path: `${ROOT}/backends` });
      if (response.status === 404) {
        // Companions that don't list backends run their one configured
        // server, but only ones with the handoff routes can print at all.
        const probe = await send({ method: 'GET', path: `${ROOT}/elicitations` });
        if (ok(probe.status)) return null;
        if (probe.status === 404) throw notAvailable();
        failure(probe, 'The printer list');
      }
      if (!ok(response.status)) failure(response, 'The printer list');
      return parse(backendsResponse, response.body).backends.map(
        (entry): PrinterOption => (typeof entry === 'string' ? { backend: entry } : entry),
      );
    },
    async bundleIds() {
      const response = await send({ method: 'GET', path: `${ROOT}/bundles` });
      if (!ok(response.status)) failure(response, 'Your print jobs');
      return parse(listedIds, response.body).bundles.flatMap(bundle => {
        const id = (bundle as { id?: unknown } | null)?.id;
        return typeof id === 'string' ? [id] : [];
      });
    },
    async create(_projectId, _captureId, _ack, request) {
      const response = await send({
        method: 'POST',
        path: `${ROOT}/bundles`,
        // Exactly the identity the native side verifies, nothing more.
        source: {
          sha256: request.model.sha256,
          byteLength: request.model.byteLength,
          mediaType: request.model.mediaType,
        },
        prompt: request.prompt,
        ...(request.backend ? { backend: request.backend } : {}),
      });
      if (response.status === 404 && serverCode(response.body) === 'not-found') throw notAvailable();
      if (!ok(response.status)) failure(response, 'The printer handoff');
      return handoffOf(parse(bundleResponse, response.body));
    },
    async status(_projectId, _captureId, _ack, handoffId) {
      z.uuid().parse(handoffId);
      const response = await send({ method: 'GET', path: `${ROOT}/bundles/${handoffId}` });
      if (!ok(response.status)) failure(response, 'This print job');
      return handoffOf(parse(bundleResponse, response.body));
    },
    async find(_projectId, _captureId, _ack, request) {
      const response = await send({ method: 'GET', path: `${ROOT}/bundles` });
      if (!ok(response.status)) failure(response, 'Your print jobs');
      const before = request.before && new Set(request.before);
      const [match] = parse(listedResponse, response.body)
        .bundles.filter(
          bundle =>
            bundle.cleanStl?.sha256 === request.model &&
            (bundle.prompt ?? '') === request.prompt &&
            (request.backend === null || bundle.backend === request.backend) &&
            (before
              ? !before.has(bundle.id)
              : (bundle.createdAtMs ?? 0) >= request.startedAtMs - CLOCK_SLACK_MS),
        )
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
      return match ? handoffOf({ bundle: match }) : null;
    },
    async print(handoffId) {
      z.uuid().parse(handoffId);
      const response = await send({ method: 'POST', path: `${ROOT}/bundles/${handoffId}/print` });
      if (!ok(response.status)) failure(response, 'This print job');
    },
    async cancel(handoffId) {
      z.uuid().parse(handoffId);
      const response = await send({ method: 'POST', path: `${ROOT}/bundles/${handoffId}/cancel` });
      if (ok(response.status)) return true;
      // Older companions have no cancel route.
      if (response.status === 405 || (response.status === 404 && serverCode(response.body) === 'not-found')) {
        return false;
      }
      return failure(response, 'This print job');
    },
    async confirmations() {
      const response = await send({ method: 'GET', path: `${ROOT}/elicitations` });
      if (!ok(response.status)) failure(response, 'The printer’s questions');
      return parse(pendingResponse, response.body).elicitations.map((pending): Confirmation => {
        const photo = snapshot(pending.cameraSnapshot);
        return {
          id: pending.id,
          mode: pending.mode,
          message: pending.message,
          ...(pending.requestedSchema !== undefined ? { requestedSchema: pending.requestedSchema } : {}),
          ...(pending.url ? { url: pending.url } : {}),
          ...(photo ? { cameraSnapshot: photo } : {}),
          ...(pending.createdAtMs !== undefined ? { createdAtMs: pending.createdAtMs } : {}),
          expiresAtMs: pending.expiresAtMs,
        };
      });
    },
    async answer(confirmationId, answer: ConfirmationAnswer) {
      z.uuid().parse(confirmationId);
      const response = await send({
        method: 'POST',
        path: `${ROOT}/elicitations/${confirmationId}/respond`,
        body: JSON.stringify(answer),
      });
      if (!ok(response.status)) failure(response, 'That question');
    },
  };
}
