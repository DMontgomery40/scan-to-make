import { z } from 'zod';

/**
 * Counterpart 2 wire contracts between the Mac companion and its clients (the
 * iPhone app over HTTPS, the Mac app over the control socket). The prose
 * specification is in docs/protocols/objects-api.md and docs/protocols/events.md.
 * Every object here is additive to what older clients already decode: unknown
 * keys must be ignored and unknown enum values must not fail a whole list.
 */

const uuid = z.uuid();
const iso = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().max(max);

// ---------------------------------------------------------------------------
// Events (PRD §8.7)

export const COUNTERPART_EVENT_TYPES = [
  'pass.started', 'pass.stage', 'pass.ready', 'pass.ask', 'pass.failed',
  'print.preparing', 'print.confirm', 'print.started', 'print.status', 'print.first-layer',
  'print.milestone', 'print.paused', 'print.resumed', 'print.done', 'print.failed', 'print.cancelled',
  'print.not-started', 'print.unreachable', 'print.sent',
  // #630: the printer's own camera shows something the printer doesn't detect itself (nothing coming out of the nozzle).
  'print.check',
  // PRD §5.4: a project's status (or, later, its settings) changed.
  'project.updated',
  // A project and its files were deleted; `data.by` says from where.
  'project.deleted',
  // Companion-wide settings changed; clients refresh their saved preferences.
  'settings.changed',
  // PRD §8.10 (KAN-214 PR 6). No projectId; emitted only once every client decodes events without one.
  'mcp.update.started', 'mcp.update.waiting', 'mcp.update.done', 'mcp.update.failed',
] as const;
export const CounterpartEventTypeSchema = z.enum(COUNTERPART_EVENT_TYPES);
export type CounterpartEventType = z.infer<typeof CounterpartEventTypeSchema>;

export const NotifyLevelSchema = z.enum(['none', 'passive', 'active', 'timeSensitive']);
export type NotifyLevel = z.infer<typeof NotifyLevelSchema>;

export const EventProblemSchema = z.strictObject({ code: text(64), message: text(500) });

export const CounterpartEventDataSchema = z.strictObject({
  progress: z.number().min(0).max(100).optional(),
  remainingSec: z.number().int().nonnegative().optional(),
  endsAt: iso.optional(),
  layer: z.number().int().nonnegative().optional(),
  totalLayers: z.number().int().nonnegative().optional(),
  state: text(32).optional(),
  stage: text(120).optional(),
  problems: z.array(EventProblemSchema).max(16).optional(),
  estimateSec: z.number().int().nonnegative().optional(),
  grams: z.number().nonnegative().optional(),
  askId: uuid.optional(),
  confirmationId: uuid.optional(),
  expiresAt: iso.optional(),
  /** project.updated: what changed (for example `["status"]`). */
  keys: z.array(text(64)).max(16).optional(),
  /** project.deleted: who deleted it, the phone's device id or `mac`. */
  by: text(128).optional(),
  /** mcp.update.*: the install, the versions, and on failure the end of its log (≤ 4 KB). */
  mcpId: text(64).optional(),
  fromVersion: text(64).optional(),
  toVersion: text(64).optional(),
  log: text(4096).optional(),
});

/** Exactly PRD §8.7's `CounterpartEvent`. `frame` is relative to the project's directory. */
export const CounterpartEventSchema = z.strictObject({
  v: z.literal(1),
  seq: z.number().int().positive(),
  id: uuid,
  at: iso,
  type: CounterpartEventTypeSchema,
  /** Absent for events about the Mac rather than a project (mcp.update.*). */
  projectId: uuid.optional(),
  printId: uuid.optional(),
  destinationId: text(256).optional(),
  printerName: text(120).optional(),
  title: text(200),
  body: text(500),
  notify: NotifyLevelSchema,
  data: CounterpartEventDataSchema.optional(),
  frame: z.string().regex(/^prints\/[0-9a-f-]{36}\/frames\/[0-9a-f-]{36}\.jpg$/).optional(),
});
export type CounterpartEvent = z.infer<typeof CounterpartEventSchema>;

/** `GET /v1/events` and the control method `events.wait`. */
export const EventsPageSchema = z.strictObject({
  events: z.array(CounterpartEventSchema).max(500),
  /** Pass this as `after` next time. Never smaller than the `after` that was sent, unless `reset`. */
  next: z.number().int().nonnegative(),
  /** The newest seq in the log (0 when it is empty). */
  latest: z.number().int().nonnegative(),
  /** Events between `after` and the oldest retained one were pruned (7-day retention): resync from the objects list. */
  truncated: z.literal(true).optional(),
  /** `after` was beyond `latest` (the log was recreated): resync from the objects list and continue from `next`. */
  reset: z.literal(true).optional(),
});
export type EventsPage = z.infer<typeof EventsPageSchema>;

// ---------------------------------------------------------------------------
// Project status words (PRD §4 state table), written by the companion's events/words.ts

export const PROJECT_PHASES = ['sending', 'working', 'needs-you', 'ready', 'preparing', 'printing', 'printed', 'failed', 'sent', 'confirmed', 'draft'] as const;
export const ProjectPhaseSchema = z.enum(PROJECT_PHASES);
export type ProjectPhase = z.infer<typeof ProjectPhaseSchema>;

export const ObjectStatusSchema = z.strictObject({
  phase: ProjectPhaseSchema,
  /** The whole status line, e.g. "Printing on Bambu Lab P1S · 42% · 1 h 5 min left". */
  text: text(300),
  /**
   * What a list row shows under the project's title when the row already sits under its phase's heading ("Needs
   * you", "Ready"): only what differs between rows there (the question, the size, the stage), never the heading
   * again. Absent when the whole line is already that (a print's line, a failure's sentence).
   */
  detail: text(300).optional(),
  /** SF Symbol name from the PRD §4 table. */
  symbol: text(64),
  tint: z.enum(['blue', 'orange', 'accent', 'green', 'secondary', 'red']),
});
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;

// ---------------------------------------------------------------------------
// Printing (PRD §8.4–§8.6)

export const PRINT_STATES = ['idle', 'preparing', 'printing', 'paused', 'finished', 'failed', 'cancelled', 'offline', 'busy'] as const;
export const PrintStateSchema = z.enum(PRINT_STATES);

export const PrintProblemSchema = z.strictObject({
  code: text(64),
  severity: z.enum(['fatal', 'error', 'warning', 'info']),
  message: text(500),
  url: z.url().optional(),
});

/** The last report from the printer, normalized from `counterpart_print_progress` or the older `get_printer_status`. */
export const PrintLiveSchema = z.strictObject({
  source: z.enum(['counterpart', 'status-fallback']),
  observedAt: iso,
  state: PrintStateSchema,
  job: z.strictObject({
    name: text(256),
    id: text(128).optional(),
    progress: z.number().min(0).max(100).optional(),
    elapsedSec: z.number().nonnegative().optional(),
    remainingSec: z.number().nonnegative().optional(),
    layer: z.number().int().nonnegative().optional(),
    totalLayers: z.number().int().nonnegative().optional(),
    stage: text(120).optional(),
  }).optional(),
  /** `observedAt + remainingSec`, when the printer reports a time left. */
  endsAt: iso.optional(),
  temps: z.strictObject({
    nozzle: z.strictObject({ actual: z.number(), target: z.number() }).optional(),
    bed: z.strictObject({ actual: z.number(), target: z.number() }).optional(),
    chamber: z.number().optional(),
  }).optional(),
  activeFilament: z.strictObject({ slot: text(32).optional(), material: text(64).optional(), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional() }).optional(),
  problems: z.array(PrintProblemSchema).max(32),
});
export type PrintLive = z.infer<typeof PrintLiveSchema>;

/** `sent`: the printer accepted it but Counterpart can't follow this print (no job identity it could match). */
export const MonitorEndSchema = z.enum(['done', 'failed', 'cancelled', 'not-started', 'replaced', 'sent']);
export const PrintMonitorSchema = z.strictObject({
  phase: z.enum(['starting', 'watching', 'ended']),
  startedAt: iso,
  /** The printer's report time of the last report that belonged to this print. */
  lastReportAt: iso.optional(),
  milestonesSent: z.array(z.number().int().min(1).max(99)).max(99),
  /** "First layer's down" was said, from the camera showing plastic where the slice puts it (#630), never from counters. */
  firstLayerSent: z.boolean(),
  /** `print.check` was sent for this print: once, even across a restart. */
  checkSent: z.boolean().optional(),
  /** Set while the printer can't be reached (3 failed reads, or offline for 60 s). Never a failure by itself. */
  unreachableSince: iso.optional(),
  endState: MonitorEndSchema.optional(),
  endedAt: iso.optional(),
});
export type PrintMonitor = z.infer<typeof PrintMonitorSchema>;

export const PrintQualitySchema = z.enum(['draft', 'standard', 'fine']);
export const PrintStrengthSchema = z.enum(['standard', 'strong', 'max']);
/** v1 colour: one AMS slot, the external spool, or (generic printers) the loaded material. Omitted: the MCP's own default. */
export const PrintColourSchema = z.union([
  z.strictObject({ auto: z.literal(true) }),
  z.strictObject({ amsSlot: z.number().int().min(0).max(253) }),
  z.strictObject({ external: z.literal(true) }),
  z.strictObject({ material: z.string().trim().min(1).max(64) }),
]);
export const PrintSettingsSchema = z.strictObject({
  quality: PrintQualitySchema.optional(),
  strength: PrintStrengthSchema.optional(),
  colour: PrintColourSchema.optional(),
  /** How many on the plate (slice_stl `repetitions`); 1 sends nothing. */
  copies: z.number().int().min(1).max(64).optional(),
  /** Pause before each of these 1-based layers, as the slicer preview numbers them (slice_stl `pause_at_layers`), e.g. to drop in magnets. */
  pauseBeforeLayers: z.array(z.number().int().min(2).max(100000)).min(1).max(16).optional(),
});
export type PrintSettings = z.infer<typeof PrintSettingsSchema>;

/** `objects.estimate` and `POST /v1/objects/<id>/estimate`. */
export const PrintEstimateSchema = z.strictObject({
  destinationId: text(256),
  quality: PrintQualitySchema,
  strength: PrintStrengthSchema,
  seconds: z.number().nonnegative().optional(),
  grams: z.number().nonnegative().optional(),
  layers: z.number().int().positive().optional(),
  layerHeightMm: z.number().positive().optional(),
  infillPercent: z.number().min(0).max(100).optional(),
  wallLoops: z.number().int().nonnegative().optional(),
  /** How many on the plate; time and grams cover every copy. */
  copies: z.number().int().min(1).max(64).optional(),
  /** Bambu Studio's own warning on this slice, verbatim (KAN-223), e.g. a floating cantilever. Print asks before sending. */
  slicerWarning: text(2000).optional(),
  /** The installed printer MCP can't say whether this 3MF prints with its own settings: update it, in its own words. */
  ownSettingsUpdate: text(500).optional(),
  slicedAt: iso,
  /** The SHA-256 of this estimate's sliced file. Print sends it as `sliceSha256` and prints exactly that file. */
  sliceSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /**
   * The printer MCP's pictures of that exact file's G-code: what will print, shown before Print. Absent when
   * the installed MCP doesn't draw them (then Print is refused until it is updated).
   */
  preview: z.strictObject({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    views: z.array(z.strictObject({
      name: z.enum(['top', 'bed_side']), label: text(120),
      png: z.string().max(6_000_000), width: z.number().int().positive(), height: z.number().int().positive(),
    })).length(2),
    mmPerPixel: z.number().positive().optional(),
  }).optional(),
});
export type PrintEstimate = z.infer<typeof PrintEstimateSchema>;

/** What a destination's installed MCP can do, read from its `initialize` reply and tool list (PRD §8.2). */
export const PrinterCapabilitiesSchema = z.strictObject({
  server: z.strictObject({ name: text(128), version: text(64) }),
  /** "counterpart/1" when the MCP has `counterpart_printer_info`. */
  contract: z.literal('counterpart/1').optional(),
  progress: z.boolean(),
  layers: z.boolean(),
  camera: z.enum(['bambu-tcp', 'rtsp', 'http-snapshot', 'none']),
  filaments: z.enum(['ams', 'single', 'none']),
  pause: z.boolean(),
  resume: z.boolean(),
  cancel: z.boolean(),
  /** `slice_stl` takes `layer_height`. */
  quality: z.boolean(),
  /** `slice_stl` takes `wall_loops` and `sparse_infill_density`. */
  strength: z.boolean(),
  multiColour: z.boolean(),
  /** slice_stl takes `repetitions`: Print and Estimate take `copies`. */
  copies: z.boolean().optional(),
  /** slice_stl takes `pause_at_layers`: Print takes `pauseBeforeLayers`. */
  layerPauses: z.boolean().optional(),
  /** The print sheet may ask "What's loaded?": `colour: {material}` is accepted (shown as chips when there is no spool list). */
  materialChoice: z.boolean().optional(),
  /** The features this install lacks, each with the update that unlocks it. */
  missing: z.array(z.enum(['progress', 'camera', 'filaments', 'pause', 'resume', 'quality', 'strength', 'multi-colour'])).max(8),
  /** Present when `missing` is not empty: "Update mcp-3D-printer-server to see progress and camera." */
  update: z.strictObject({
    message: text(300),
    package: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']),
    /** The package manager command for how this MCP is installed, as argv; absent when it can't be told (a git checkout). */
    command: z.array(text(512)).max(16).optional(),
    /** PRD §8.10 (PR 6): the newest published version (`npm view`), when it is newer than this one or features are missing. */
    latestVersion: text(64).optional(),
  }).optional(),
  detectedAt: iso,
});
export type PrinterCapabilities = z.infer<typeof PrinterCapabilitiesSchema>;

export const PrinterReadinessSchema = z.enum(['ready', 'busy', 'offline', 'unknown']);

/** One entry of `GET /v1/objects/printers` / `objects.printers`. */
export const PrinterDestinationSchema = z.strictObject({
  id: text(256),
  name: text(120),
  backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']),
  model: text(64).optional(),
  address: text(255).optional(),
  source: z.enum(['current', 'mcp-profile']),
  /** Which client config it came from: claude-code, claude-desktop, cursor, codemode, codex, or the Mac app's own printer-handoff.json. */
  origin: text(32).optional(),
  /** Last known state, from the destination's session; `unknown` until a session has read it. */
  state: PrinterReadinessSchema.optional(),
  stateCheckedAt: iso.optional(),
  /** Absent until the destination's MCP has connected once since the companion started. */
  capabilities: PrinterCapabilitiesSchema.optional(),
  /** PRD §8.10 (PR 6): the MCP install this printer runs; every printer on the same install shares it. */
  mcpId: z.string().regex(/^mcp-[0-9a-f]{16}$/).optional(),
  /** The MCP its prints go through, as people know it (`mcp-3D-printer-server`): clients show it as sent. */
  mcpLabel: text(64).optional(),
  /**
   * The same printer reached through both MCPs: each MCP's profile, the one in use first (`printers.chooseMcp`). Each
   * names the install it runs, its name as people know it and its versions, so every MCP keeps its Settings row and Update.
   */
  mcps: z.array(z.strictObject({backend: z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']), destinationId: text(256),
    mcpId: z.string().regex(/^mcp-[0-9a-f]{16}$/).optional(), label: text(64).optional(), version: text(64).optional(),
    latestVersion: text(64).optional()})).max(2).optional(),
  /** A printer added in Counterpart (`origin: "counterpart"`): the folder its MCP runs in, whose `.env` holds its settings. */
  folder: text(4096).optional(),
  /** Its `.env` lacks settings its MCP needs (names only); `fill` is what `printers.completeSettings` adds (only the model). */
  incomplete: z.strictObject({missing: z.array(text(64)).max(16), fill: z.record(text(64), text(4096))}).optional(),
});
export type PrinterDestination = z.infer<typeof PrinterDestinationSchema>;

/** `printers.updateMcp` / `POST /v1/printers/mcp/<mcpId>/update` (PRD §8.10). */
export const McpUpdateSchema = z.strictObject({
  mcpId: z.string().regex(/^mcp-[0-9a-f]{16}$/),
  state: z.enum(['started', 'waiting', 'current', 'unresolved']),
  fromVersion: text(64).optional(),
  toVersion: text(64).optional(),
  /** `unresolved`: what was found, in plain words. Offer Install a Fresh Copy (`fresh: true`). */
  found: text(500).optional(),
});
export type McpUpdate = z.infer<typeof McpUpdateSchema>;

// ---------------------------------------------------------------------------
// Passes (PRD §4, §8.7, §8.9)

export const PASS_STAGES = ['building', 'preparing', 'working', 'saving'] as const;
export const PassStageSchema = z.strictObject({
  id: z.enum(PASS_STAGES),
  /** "Building the model from your photos", "Getting Blender ready", "Designing it", "Saving the result". */
  words: text(120),
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative().optional(),
  /** The median of this stage's recent real durations on this Mac (a default until there are some). */
  typicalSec: z.number().int().nonnegative(),
});
export const PassEstimateSchema = z.strictObject({ remainingSec: z.number().int().nonnegative(), endsAtMs: z.number().int().nonnegative() });

export const ChangeSchema = z.strictObject({
  tag: z.enum(['added', 'changed', 'assumed', 'estimated']),
  text: text(300),
  /** For estimated sizes: plus or minus this many millimetres. */
  toleranceMm: z.number().nonnegative().optional(),
});
export type Change = z.infer<typeof ChangeSchema>;

/**
 * One size of a real object, in millimetres. `id` is opaque (nothing may switch on it); `label` says what was
 * measured in words a person can act on ("longest side", "width at the waist").
 */
export const SizeSchema = z.strictObject({ id: text(64).min(1), label: text(120).min(1), mm: z.number().positive().max(10_000) });
export type Size = z.infer<typeof SizeSchema>;
/**
 * How a fit gets its exact size, chosen in New: the maker's published size confirmed by the person (`lookup`), the
 * person's own measurements (`measured`), or the scan (`scan`). Sent as fields beside `instructions`, which holds
 * only what the person typed; the companion composes the worker's brief from this.
 */
export const FitSchema = z.strictObject({
  sizeSource: z.enum(['lookup', 'measured', 'scan']),
  measured: z.array(SizeSchema).min(1).max(6).optional(),
}).refine(fit => fit.sizeSource !== 'measured' || !!fit.measured?.length, { message: 'measured sizes are required when the person measured' })
  .refine(fit => fit.sizeSource === 'measured' || fit.measured === undefined, { message: 'measured sizes go with the measured source only' });
export type Fit = z.infer<typeof FitSchema>;

export const AskSchema = z.strictObject({
  id: uuid,
  question: text(300),
  /** Relative to the project's directory; served at GET /v1/objects/<id>/asks/<askId>.jpg. */
  photo: z.string().regex(/^asks\/[0-9a-f-]{36}\.jpg$/).optional(),
  /** The region to highlight on `photo`, as fractions of its width and height (origin top-left). */
  region: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }).optional(),
  answers: z.array(z.enum(['camera', 'photos', 'best-guess', 'text', 'file', 'choice', 'sizes'])).min(1).max(6),
  /** PRD §8.11 (PR 7): `file` asks for a published model's file, `choice` lists options. Absent means `closeup`.
   *  Kept for clients from before `kind`; a `sizes` ask leaves it absent, so they show the question and their text box. */
  type: z.enum(['closeup', 'file', 'choice']).optional(),
  /**
   * What the project is waiting on the person for: the one enumeration of waits. `closeup`: a photo or words about
   * a part; `file`: the designer's file; `choice`: one of `options`; `region` / `scale`: the two questions of a
   * reconstruction review (which part is the object, how big it is), answered through the review's own route;
   * `sizes`: confirm or correct `sizes`. A client that doesn't know a kind shows the question and says to update.
   */
  kind: z.enum(['closeup', 'file', 'choice', 'region', 'scale', 'sizes']).optional(),
  /** `file`: why the file is wanted when it isn't simply "send it": macOS refused the Downloads folder. */
  reason: z.enum(['downloads-access']).optional(),
  /** `sizes`: the sizes to confirm or correct, prefilled, each with where the number came from. One to six. */
  sizes: z.array(z.strictObject({ ...SizeSchema.shape, from: z.enum(['scan', 'published']) })).min(1).max(6).optional(),
  /** `file`: the model's page (Open in Safari), its name and site, and the file types it takes. */
  url: z.string().url().max(2048).optional(),
  modelName: text(120).optional(),
  site: text(64).optional(),
  accepts: z.array(z.enum(['3mf', 'stl'])).max(2).optional(),
  /** `file`: a likely file the Mac found but isn't sure of (an absolute path on the Mac). */
  candidate: z.strictObject({ path: text(1024), name: text(255) }).optional(),
  /** `choice`: what to pick from, and whether several may be picked; `choices` holds the answer. */
  options: z.array(z.strictObject({ id: text(64), label: text(120), detail: text(300).optional(), thumbnail: text(512).optional() })).max(32).optional(),
  multiple: z.boolean().optional(),
  choices: z.array(text(64)).max(32).optional(),
  status: z.enum(['open', 'answered']),
  askedAtMs: z.number().int().nonnegative(),
});
export type Ask = z.infer<typeof AskSchema>;

// ---------------------------------------------------------------------------
// Settings and Live Activity tokens (PRD §8.6, §8.8)

export const MilestonesSchema = z.enum(['off', '50', '25-50-75', 'every-10']);
// Sparse maps preserve explicit choices, including event types introduced by newer clients.
const NotificationChoicesSchema = z.record(z.string().min(1).max(128), z.boolean());
const NotificationDevicesSchema = z.record(z.string().min(1).max(128), NotificationChoicesSchema);
const GeneralSettingsSchema = z.strictObject({
  openAtLogin: z.boolean().optional(), showInDock: z.boolean().optional(), keepAwake: z.boolean().optional(),
  /** "Keep printer software up to date": the companion installs a newer printer MCP by itself while nothing is working. On unless turned off. */
  autoUpdateMcps: z.boolean().optional(),
});
const NotificationsSchema = z.strictObject({
  mac: NotificationChoicesSchema.default({}), devices: NotificationDevicesSchema.default({}),
});
export const CompanionSettingsSchema = z.strictObject({
  milestones: MilestonesSchema,
  notifications: NotificationsSchema.optional(),
  general: GeneralSettingsSchema.optional(),
});
export type CompanionSettings = z.infer<typeof CompanionSettingsSchema>;
export const PhoneAIChangeSchema = z.strictObject({
  expectedRevision: z.uuid(), choice: z.strictObject({kind: z.enum(['none', 'claude-code', 'codex-cli'])}),
});
export const CompanionSettingsPatchSchema = z.strictObject({
  milestones: MilestonesSchema.optional(),
  ai: PhoneAIChangeSchema.optional(),
  notifications: z.strictObject({mac: NotificationChoicesSchema.optional(), devices: NotificationDevicesSchema.optional()}).optional(),
  general: GeneralSettingsSchema.optional(),
}).refine(value => Object.keys(value).length > 0, 'A setting is required')
  .refine(value => !value.ai || Object.keys(value).length === 1, 'Change AI separately from other settings');
export type CompanionSettingsPatch = z.infer<typeof CompanionSettingsPatchSchema>;

/** PRD §5.4 Status, set by hand: `PATCH /v1/objects/<id>/settings {status}` / `objects.settings.set {id, status}`. */
export const PROJECT_STATUSES = ['not-printed', 'printed', 'works', 'needs-changes', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** Print and engine defaults apply to future work; notification choices affect future events. */
export const ProjectPreferencesSchema = z.strictObject({
  printDefaults: PrintSettingsSchema.optional(),
  designEngine: z.enum(['auto', 'blender', 'fusion']).optional(),
  notifications: z.enum(['all', 'problems']).optional(),
});
export type ProjectPreferences = z.infer<typeof ProjectPreferencesSchema>;
export const ProjectSettingsPatchSchema = ProjectPreferencesSchema.extend({
  title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
  status: ProjectStatusSchema.optional(), archived: z.boolean().optional(),
  printerDestinationId: z.string().min(1).max(256).nullable().optional(),
}).refine(value => Object.keys(value).length > 0);
export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>;


const apnsToken = z.string().regex(/^[0-9a-fA-F]{16,512}$/);
/** `POST /v1/devices/live-activity-tokens`. At least one of the two. */
export const LiveActivityTokenUploadSchema = z.strictObject({
  pushToStart: apnsToken.optional(),
  activity: z.strictObject({ printId: uuid, token: apnsToken.nullable() }).optional(),
}).refine(body => body.pushToStart !== undefined || body.activity !== undefined);

/** The control method `liveActivity.tokens`. */
export const LiveActivityTokensSchema = z.strictObject({
  pushToStart: z.array(z.strictObject({ deviceId: uuid, token: apnsToken, updatedAt: iso })).max(64),
  activities: z.array(z.strictObject({ printId: uuid, deviceId: uuid, token: apnsToken, updatedAt: iso })).max(1024),
});
export type LiveActivityTokens = z.infer<typeof LiveActivityTokensSchema>;

// A read-only snapshot: deleting or changing the source never changes the new project's context.
// `items` are the person's words (`you`) and the app's replies and questions (`app`), in time order. An item copied
// from an earlier generation (the source was itself made from another) names that project in `from`; the source's
// own items have none. `fit` is how the source's size was settled, measured sizes included: a brief, not words.
const InheritedFromSchema = z.object({id: z.string(), title: z.string()});
export const InheritedHistorySchema = z.object({
  from: InheritedFromSchema,
  items: z.array(z.object({at: z.number().finite(), who: z.enum(['you', 'app']), text: z.string(), from: InheritedFromSchema.optional()})),
  fit: FitSchema.optional(),
});
export type InheritedHistory = z.infer<typeof InheritedHistorySchema>;
