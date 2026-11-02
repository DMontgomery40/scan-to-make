import {z} from 'zod';
import {ModelAccessChoiceSchema} from './model-access-protocol.js';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const messages = {
  'invalid-request': 'Invalid local control request',
  'unsupported-version': 'Unsupported local control version',
  'not-found': 'The requested item is no longer available',
  conflict: 'The requested operation conflicts with current state',
  unavailable: 'The requested capability is unavailable',
  internal: 'The local control operation failed',
} as const;
export class ControlFailure extends Error {
  /** `detail` replaces the generic sentence when the refusal has a plain one of its own. */
  constructor(readonly code: keyof typeof messages, detail?: string) { super(detail ?? messages[code]); }
}
export function controlError(error: unknown) {
  const failure = error instanceof ControlFailure ? error : new ControlFailure('internal');
  return {code: failure.code, message: failure.message};
}
const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const empty = z.strictObject({});
const answer = z.union([
  z.strictObject({action: z.literal('accept'), content: z.record(z.string().max(128), z.union([
    z.string().max(4096), z.number().finite(), z.boolean(), z.array(z.string().max(4096)).max(64),
  ]))}),
  z.strictObject({action: z.enum(['decline', 'cancel'])}),
]);
export const parameters = {
  'printer.check': z.strictObject({start:z.boolean().default(false)}),
  'modelAccess.get': empty,
  'modelAccess.set': z.strictObject({expectedRevision:z.uuid(),choice:ModelAccessChoiceSchema}),
  'modelAccess.check': z.strictObject({revision:z.uuid()}),
  'status.get': empty,
  'jobs.list': z.strictObject({projectId: projectId.optional(), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(50)}),
  'devices.list': empty,
  'devices.remove': z.strictObject({deviceId: z.uuid()}),
  'pairing.create': z.strictObject({login: z.string().min(1).max(256).optional()}),
  'pairing.isActive': z.strictObject({code: z.string().regex(/^[A-Za-z0-9_-]{32}$/)}),
  'nearby.list': empty,
  'nearby.answer': z.strictObject({id: z.uuid(), allow: z.boolean()}),
  'confirmations.list': empty,
  'confirmations.answer': z.strictObject({id: z.uuid(), answer}),
  'doors.prepare': z.strictObject({projectId: projectId.optional(), handoffId: z.uuid().optional(), door: z.enum(['finder', 'blender', 'bambu-studio', 'orca'])})
    .refine(p => (p.projectId === undefined) !== (p.handoffId === undefined)),
  'objects.list': empty,
  'objects.printers': empty,
  'objects.filaments': z.strictObject({id: z.uuid()}),
  'objects.selectPrinter': z.strictObject({id: z.uuid(), destinationId: z.string().min(1).max(256)}),
  'objects.get': z.strictObject({id: z.uuid()}),
  'objects.passActivity': z.strictObject({id: z.uuid(), index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}),
  'objects.start': z.strictObject({id: z.uuid()}),
  'objects.delete': z.strictObject({id: z.uuid()}),
  'objects.correct': z.strictObject({id: z.uuid(), note: z.string().trim().min(1).max(4000), photos: z.array(z.string().min(2).max(4096)).max(24).optional()}),
  'objects.create': z.strictObject({instructions: z.string().max(8000).optional()}),
  'objects.addFile': z.strictObject({id: z.uuid(), kind: z.enum(['photos', 'scan']), path: z.string().min(2).max(4096)}),
  'objects.answerCloseup': z.strictObject({id: z.uuid(), bestGuess: z.boolean()}),
  'objects.print': z.strictObject({id: z.uuid(), checked: z.boolean().optional(), filament: z.strictObject({
    slot:z.number().int().min(0).max(255), colour:z.string().regex(/^#[0-9A-F]{6}$/), material:z.string().min(1).max(128),
    name:z.string().max(256), filamentId:z.string().max(128), destinationId:z.string().min(1).max(256),
  }).optional()}),
  'objects.answerPlate': z.strictObject({id: z.uuid()}),
  'objects.answerPrintConfirmation': z.strictObject({id: z.uuid(), confirmationId: z.uuid(), answer: z.union([
    z.strictObject({action: z.literal('accept'), content: z.record(z.string().max(128), z.boolean())}),
    z.strictObject({action: z.enum(['decline', 'cancel'])}),
  ])}),
};
export type ControlMethod = keyof typeof parameters;
export type DoorParameters = z.infer<typeof parameters['doors.prepare']>;
export type JobParameters = z.infer<typeof parameters['jobs.list']>;
const envelope = z.strictObject({v: z.number(), id: z.uuid(), method: z.string(), params: z.unknown()});
export function parseRequest(value: unknown) {
  const result = envelope.safeParse(value);
  if (!result.success) throw new ControlFailure('invalid-request');
  if (result.data.v !== 1) throw new ControlFailure('unsupported-version');
  if (!Object.hasOwn(parameters, result.data.method)) throw new ControlFailure('invalid-request');
  const method = result.data.method as ControlMethod;
  if (!parameters[method].safeParse(result.data.params).success) throw new ControlFailure('invalid-request');
  return {...result.data, method};
}
