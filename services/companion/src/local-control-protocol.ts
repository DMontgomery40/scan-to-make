import {z} from 'zod';
import {ModelAccessChoiceSchema} from './model-access-protocol.js';
import {ObtainRequestSchema, PrinterFormSchema} from './printing/setup.js';
import {CompanionSettingsPatchSchema, ProjectSettingsPatchSchema, PrintColourSchema, PrintQualitySchema, PrintStrengthSchema, PrintSettingsSchema} from '@scan-to-make/contracts/counterpart';
import {ReconstructionAnswerSchema} from '@scan-to-make/contracts/reconstruction';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Plain sentences the apps show as they are (Nov 6); a refusal with its own sentence replaces these. */
const messages = {
  'invalid-request': 'Update Counterpart on this Mac, then try again.',
  'unsupported-version': 'Update Counterpart on this Mac, then try again.',
  'not-found': 'This one is no longer on your Mac.',
  conflict: 'That can’t be done right now.',
  unavailable: 'That isn’t available on your Mac right now.',
  internal: 'Something went wrong on your Mac.',
  // KAN-223: Bambu Studio refused the slice; the message is Studio's own words.
  'slicer-error': 'Bambu Studio could not slice this model',
  // Nov 6: a request past its deadline, or past the connection limit, is answered, never dropped without a word.
  'timed-out': 'Your Mac took too long to answer. It may still finish; this page updates when it does.',
  busy: 'Your Mac is answering too many requests at once. Try again in a moment.',
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
  'blender.status': empty,
  'blender.check': empty,
  'blender.update': empty,
  'printer.check': z.strictObject({start:z.boolean().default(false)}),
  'modelAccess.get': empty,
  'modelAccess.set': z.strictObject({expectedRevision:z.uuid(),choice:ModelAccessChoiceSchema}),
  'modelAccess.check': z.strictObject({revision:z.uuid()}),
  'status.get': empty,
  'jobs.list': z.strictObject({projectId: projectId.optional(), cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).default(50)}),
  'devices.list': empty,
  'devices.remove': z.strictObject({deviceId: z.uuid()}),
  'events.wait': z.strictObject({after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), timeoutMs: z.number().int().min(0).max(25000).optional(), limit: z.number().int().min(0).max(500).optional()}),
  'liveActivity.tokens': empty,
  'pairing.create': z.strictObject({login: z.string().min(1).max(256).optional()}),
  'pairing.icloudToken': empty,
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
  'objects.colourMapping': z.strictObject({id: z.uuid()}),
  'objects.selectPrinter': z.strictObject({id: z.uuid(), destinationId: z.string().min(1).max(256)}),
  'objects.get': z.strictObject({id: z.uuid()}),
  'objects.settings.get': z.strictObject({id: z.uuid()}),
  'objects.settings.set': ProjectSettingsPatchSchema.safeExtend({id: z.uuid()}).refine(value => Object.keys(value).some(key => key !== 'id')),
  'objects.duplicate': z.strictObject({id: z.uuid()}),
  'objects.locate': z.strictObject({id: z.uuid()}),
  'objects.passActivity': z.strictObject({id: z.uuid(), index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}),
  'objects.start': z.strictObject({id: z.uuid()}),
  'objects.delete': z.strictObject({id: z.uuid()}),
  'objects.correct': z.strictObject({id: z.uuid(), note: z.string().trim().min(1).max(4000), photoNames: z.array(z.string().min(1).max(128)).max(100).optional(), photos: z.array(z.string().min(2).max(4096)).max(24).optional()}),
  'objects.addStarter': z.strictObject({starterId: z.enum(['scan-platform', 'long-vernier-caliper'])}),
  'objects.create': z.strictObject({instructions: z.string().max(8000).optional(), kind: z.enum(['fit', 'copy', 'published']).optional(), url: z.string().max(2048).optional()}),
  'objects.selectPlate': z.strictObject({id: z.uuid(), fileIndex: z.number().int().nonnegative(), plateIndex: z.number().int().nonnegative()}),
  'objects.answerAsk': z.strictObject({id: z.uuid(), askId: z.uuid(), choices: z.array(z.string().min(1).max(64)).min(1).max(32)}),
  'objects.addFile': z.strictObject({id: z.uuid(), kind: z.enum(['photos', 'scan', 'model']), path: z.string().min(2).max(4096), forMessage: z.boolean().optional()}),
  'objects.answerCloseup': z.strictObject({id: z.uuid(), bestGuess: z.boolean(), photoNames: z.array(z.string().min(1).max(128)).max(100).optional(), text: z.string().trim().min(1).max(2000).optional()}),
  'objects.answerReconstruction': z.strictObject({id: z.uuid(), reviewId: z.uuid(), answer: ReconstructionAnswerSchema}),
  'objects.print': z.strictObject({id: z.uuid(), expectedPlate: z.string().regex(/^[0-9a-f]{64}:[0-9]+$/).optional(), checked: z.boolean().optional(), filament: z.strictObject({
    slot:z.number().int().min(0).max(255), colour:z.string().regex(/^#[0-9A-F]{6}$/), material:z.string().min(1).max(128),
    name:z.string().max(256), filamentId:z.string().max(128), destinationId:z.string().min(1).max(256), label:z.string().max(64).optional(), feed:z.string().max(32).optional(), suggested:z.boolean().optional(),
  }).optional(), filaments: z.array(z.strictObject({
    slot:z.number().int().min(0).max(4095), colour:z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/), material:z.string().min(1).max(128),
    name:z.string().max(256), filamentId:z.string().max(128), destinationId:z.string().min(1).max(256), label:z.string().max(64).optional(), feed:z.string().max(32).optional(), suggested:z.boolean().optional(),
  })).min(1).max(64).optional(), filamentsModelVersion: z.string().min(1).max(128).optional(), quality: PrintQualitySchema.optional(), strength: PrintStrengthSchema.optional(), colour: PrintColourSchema.optional(),
    copies: z.number().int().min(1).max(64).optional(), pauseBeforeLayers: PrintSettingsSchema.shape.pauseBeforeLayers,
    sliceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional()}),
  // The print sheet's estimate takes every choice Print takes: it slices exactly what Print will send (Nov 5).
  'objects.estimate': z.strictObject({id: z.uuid(), destinationId: z.string().min(1).max(256).optional(), quality: PrintQualitySchema.optional(), strength: PrintStrengthSchema.optional(),
    colour: PrintColourSchema.optional(), pauseBeforeLayers: PrintSettingsSchema.shape.pauseBeforeLayers, filament: z.strictObject({
      slot:z.number().int().min(0).max(255), colour:z.string().regex(/^#[0-9A-F]{6}$/), material:z.string().min(1).max(128),
      name:z.string().max(256), filamentId:z.string().max(128), destinationId:z.string().min(1).max(256), label:z.string().max(64).optional(), feed:z.string().max(32).optional(), suggested:z.boolean().optional(),
    }).optional(),
    copies: z.number().int().min(1).max(64).optional(), filaments: z.array(z.strictObject({
      slot:z.number().int().min(0).max(4095), colour:z.string().regex(/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/), material:z.string().min(1).max(128),
      name:z.string().max(256), filamentId:z.string().max(128), destinationId:z.string().min(1).max(256), label:z.string().max(64).optional(), feed:z.string().max(32).optional(), suggested:z.boolean().optional(),
    })).min(1).max(64).optional(), filamentsModelVersion: z.string().min(1).max(128).optional()}),
  'objects.pausePrint': z.strictObject({id: z.uuid()}),
  'objects.resumePrint': z.strictObject({id: z.uuid()}),
  'objects.cancelPrint': z.strictObject({id: z.uuid()}),
  'objects.camera': z.strictObject({id: z.uuid()}),
  'printers.camera': z.strictObject({destinationId: z.string().min(1).max(256)}),
  'printers.route': z.strictObject({destinationId: z.string().min(1).max(256), route: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional()}),
  'printers.mcps': empty,
  'printers.installMcp': z.strictObject({package: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server'])}),
  'printers.discover': empty,
  'printers.check': z.strictObject({printer: PrinterFormSchema}),
  'printers.obtain': ObtainRequestSchema,
  'printers.add': z.strictObject({printer: PrinterFormSchema}),
  'printers.remove': z.strictObject({destinationId: z.string().min(1).max(256)}),
  'printers.completeSettings': z.strictObject({destinationId: z.string().min(1).max(256), model: z.string().regex(/^[a-z0-9]{1,16}$/).optional()}),
  'printers.chooseMcp': z.strictObject({destinationId: z.string().min(1).max(256), backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server'])}),
  'printers.updateMcp': z.strictObject({mcpId: z.string().regex(/^mcp-[0-9a-f]{16}$/), fresh: z.boolean().optional()}),
  'fusion.report': z.strictObject({installed:z.boolean(), configured:z.boolean(), running:z.boolean()}),
  'fusion.claimSetup': z.strictObject({claimantId:z.uuid()}),
  'fusion.setupDone': z.strictObject({requestId:z.uuid(), ok:z.boolean(), message:z.string().max(500).optional()}),
  'fusion.setup': z.strictObject({install:z.boolean()}),
  'fusion.status': empty,
  // The printer MCP's code design engine (PRD §8.9): its cad_status, and Set Up (cad_setup), on every layout.
  'cad.status': empty,
  'cad.setup': empty,
  'settings.get': empty,
  'settings.set': CompanionSettingsPatchSchema,
  'objects.answerPrintConfirmation': z.strictObject({id: z.uuid(), confirmationId: z.uuid(), answer: z.union([
    // Any elicitation primitive; checked field by field against the pending question's own schema.
    z.strictObject({action: z.literal('accept'), content: z.record(z.string().max(128), z.union([z.boolean(), z.string().max(4096), z.number().finite()]))}),
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
