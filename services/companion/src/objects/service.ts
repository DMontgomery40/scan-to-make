import {starterModelId, starterProject as bundledStarter, type StarterProject} from '../starters/catalog.js';
import {acknowledgePlate, projectPlates, retainedPlateProgress, selectedPlateIdentity, selectingPlate} from './plates.js';
import {copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename, dirname, extname, isAbsolute, join} from 'node:path';
import {type PrintAsk, DispatchedPrintError, PrinterMcpError, inspectModelFile, modelDeclaredFilaments, modelFilamentSlotCount, modelFilaments, modelHasPainting, modelPlateFilaments, readModelFile, type ModelFileInfo, type ModelFilament, packageLabel, readPrintReport, readPrintRoute, routeArgs, setPrintRoute, timeoutsFor, type PrintRoute,
  type PrintProgress, type PendingElicitation, type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrintReport, type PrinterSession, type FilamentProposalInput} from '@scan-to-make/printer-handoff';
import type {PrintEstimate, PrintSettings, ProjectStatus, ProjectSettingsPatch} from '@scan-to-make/contracts/counterpart';
import {PrintMonitorRunner, matchJob, milestonesFor, type EventDraft, type MonitorClock, type MonitorEnd, type MonitorTarget} from '../printing/monitor.js';
import {CameraFrames, CameraUnavailableError, type CameraFrame, type CameraSize} from '../printing/camera.js';
import {PrinterUpdatingError, type PrintGate} from '../printing/print-gate.js';
import {defaultRunPublished, publishedLink, type PublishedModel, type PublishedPassInput, type PublishedResult} from '../published/published.js';
import {filamentProposalUnavailable, ownSettingsUnavailable, previewUnavailable, sliceOverrides, settingsUnsupported} from '../printing/print-settings.js';
import type {RuntimeSettings} from '../runtime-settings.js';
import type {CompanionSettingsStore} from '../settings.js';
import type {CompanionSettingsPatch} from '@scan-to-make/contracts/counterpart';
import {PRINT_LOG, printEndFailure, projectTitle, sizeText} from '../events/words.js';
import {PassTimings, STAGE_DEFAULT_SEC, passEstimate, stageWords, type PassKind, type PassStage, type StageId} from '../touchup/stages.js';
import type {DesignEngine} from '../touchup/invocation.js';
import type {PrintHandoffServices} from '../print-handoff-http.js';
import {InvalidAnswerError, printQuestion, validateAnswer, type ConfirmationValue} from './confirmation.js';
import {InvalidStateError, SlicerRefusedError} from './errors.js';
import type {TouchupInput} from '../touchup/touchup.js';
import {publicTouchupText, type TouchupActivity, type TouchupResult} from '../touchup/runner.js';
import {ObjectNotFoundError, ObjectStore, type ObjectPrintConfirmation, type StmObject} from './store.js';
import {readFilamentProposal, type FilamentProposal, type ProposalTray} from './filament-proposal.js';
import {defaultReconstructRunner, ReconstructionReviewNeeded, type Reconstruct} from './reconstruct.js';
import {captureCameraDigest, validateCaptureCamera} from './capture-camera.js';
import {clearReconstructionInputs, publicReview, reconstructionInputs, reconstructionPaths, saveReviewPreview, writeCaptureCamera, writeMeasurement, writeObjectRegion} from './reconstruction.js';
import {ReconstructionAnswerSchema, type ReconstructionAnswer} from '@scan-to-make/contracts/reconstruction';
import type {PrinterCatalog} from './printers.js';
import type {PrinterDirectory, PublicDestination} from '../printing/directory.js';

/** How early before its deadline the relay's own expiry may report an unanswered question as cancelled. */
const CONFIRMATION_EXPIRY_SLACK_MS = 1000;

/** The completion check's failure in a few plain words: a timeout says so, anything else keeps its first line. */
function completionCheckReason(message: string): string {
  if (/timed? ?out|ETIMEDOUT|SIGTERM/i.test(message)) return 'it took too long';
  const line = message.split('\n')[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line || 'no answer';
}

const STAGE_DEFAULTS = (kind: PassKind) => ({...STAGE_DEFAULT_SEC[kind]});

/** Copies an Ask's picture as JPEG: PNG through macOS's sips; where there is no sips, the bytes as they are. */
async function askPicture(source: string, target: string): Promise<void> {
  const bytes = await readFile(source);
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (png && await stat('/usr/bin/sips').then(() => true, () => false)) {
    await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', source, '--out', target]);
    return;
  }
  await writeFile(target, bytes);
}

/** How many of an object's photos go to one touch-up pass. More only costs time. */
export const PHOTOS_PER_PASS = 24;
const BEST_GUESS_NOTE = "Make your best guess for the parts you couldn't see in the photos, and carry on.";
const UNCERTAIN = 'The printer may have started this print. Check the printer before printing again.';

export {InvalidStateError, SlicerRefusedError} from './errors.js';
export {InvalidAnswerError} from './confirmation.js';

export class InvalidCaptureManifestError extends Error {
  constructor() { super('Invalid capture manifest'); this.name = 'InvalidCaptureManifestError'; }
}

export interface CaptureManifest {version: 1; images: string[]; depthRequired: boolean; cameraMetadataRequired?: boolean; scaleQualificationRequired?: boolean}

export {InvalidCaptureCameraError} from './capture-camera.js';

/** While a reconstruction review is open, only the preview answer counts; older clients get this. */
export const RECONSTRUCTION_REVIEW_UPDATE = 'This question is about the rebuilt model itself. Update Counterpart, then open this project to review the model and answer it.';
const CAPTURE_CAMERA_PENDING = 'The capture is still missing its camera information. Resume sending it from the phone that recorded it.';

/** A file on this Mac that `objects.addFile` refuses: the sentence says why. */
export class InvalidFileError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidFileError'; }
}
const FILE_KINDS = {
  photos: {extensions: ['.jpg', '.jpeg', '.png', '.heic'], limit: 25 * 1024 * 1024, words: 'a JPEG, PNG or HEIC photo'},
  scan: {extensions: ['.stl', '.3mf', '.usdz'], limit: 64 * 1024 * 1024, words: 'an STL, 3MF or USDZ file'},
  /** PRD §8.11: a published model's own file, shared for a file Ask. */
  model: {extensions: ['.stl', '.3mf'], limit: 64 * 1024 * 1024, words: 'a 3MF or STL model'},
} as const;
/** The first bytes must agree with the extension. */
/** The designer's supports choice for the current model, as slice_stl takes it; nothing when the design made none. */
function designedSupports(object: StmObject): Pick<PrinterSlicer, 'enableSupport' | 'supportType'> {
  const supports = object.kind === 'published' ? undefined : object.current?.supports;
  return supports ? {enableSupport: supports.enabled, ...(supports.enabled && supports.type ? {supportType: supports.type} : {})} : {};
}

function looksLike(extension: string, head: Buffer): boolean {
  switch (extension) {
    case '.jpg': case '.jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case '.png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case '.heic': return head.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(head.subarray(8, 12).toString('latin1'));
    case '.3mf': case '.usdz': return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    case '.stl': return head.length >= 84 || head.subarray(0, 5).toString('latin1').toLowerCase() === 'solid';
    default: return false;
  }
}
/** A plain, unique file name for a photo copied in from this Mac. */
function photoName(path: string, taken: string[]): string {
  const extension = extname(path).toLowerCase();
  let stem = basename(path, extname(path)).replace(/[^A-Za-z0-9._ -]/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/\.\.+/g, '.').slice(0, 100) || 'photo';
  if (!/^[A-Za-z0-9]/.test(stem)) stem = 'photo';
  // macOS volumes are usually case-insensitive: Photo.jpg and photo.jpg are one file.
  const used = new Set(taken.map(item => item.toLowerCase()));
  let name = `${stem}${extension}`, n = 2;
  while (used.has(name.toLowerCase())) name = `${stem}-${n++}${extension}`;
  return name;
}
const CAPTURE_PENDING = 'The capture is still missing camera or depth files, or its completed file list. Resume sending it from the phone that recorded it.';

function parseCaptureManifest(value: unknown): CaptureManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidCaptureManifestError();
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || typeof manifest.depthRequired !== 'boolean' || !Array.isArray(manifest.images)
      || (manifest.cameraMetadataRequired !== undefined && typeof manifest.cameraMetadataRequired !== 'boolean')
      || (manifest.scaleQualificationRequired !== undefined && typeof manifest.scaleQualificationRequired !== 'boolean')
      || manifest.images.length < 1 || manifest.images.length > 10000
      || manifest.images.some(name => typeof name !== 'string' || !/^[0-9]{4}\.(heic|jpe?g|png)$/.test(name))
      // Depth companions belong to the iPhone HEIC protocol only.
      || (manifest.depthRequired && manifest.images.some(name => typeof name !== 'string' || !name.endsWith('.heic')))
      || new Set(manifest.images).size !== manifest.images.length) throw new InvalidCaptureManifestError();
  return {version: 1, images: [...manifest.images].sort(), depthRequired: manifest.depthRequired,
    ...(manifest.cameraMetadataRequired !== undefined ? {cameraMetadataRequired: manifest.cameraMetadataRequired} : {}),
    ...(manifest.scaleQualificationRequired !== undefined ? {scaleQualificationRequired: manifest.scaleQualificationRequired} : {})};
}

function captureDigest(object: StmObject, depthRequired: boolean, cameraMetadataRequired = false, scaleQualificationRequired = false): string {
  return createHash('sha256').update(JSON.stringify({version: 1, depthRequired,
    // Only present fields bind, so digests of older image-only captures are unchanged.
    ...(cameraMetadataRequired ? {cameraMetadataRequired: true} : {}),
    ...(scaleQualificationRequired ? {scaleQualificationRequired: true} : {}),
    ...(object.captureCamera ? {camera: object.captureCamera.sha256} : {}),
    images: [...(object.capture ?? [])].sort(), depth: [...(object.captureDepth ?? [])].sort()})).digest('hex');
}

export interface ObjectServiceDeps {
  store: ObjectStore;
  runTouchup: (input: TouchupInput) => Promise<TouchupResult & {passDir: string}>;
  /** Bounding box in millimetres, from the user's printer MCP (get_stl_info). */
  stlInfo: (stlPath: string) => Promise<[number, number, number] | undefined>;
  claudePath: string;
  modelAccess?: import('../model-access.js').ModelAccessService;
  /** Starters' designer files, kept once per computer by model id (default: beside the projects folder). */
  starterCache?: string;
  /** Where the person's browser saves downloads (default ~/Downloads). */
  downloads?: string;
  /** The starter catalog (default: the bundled catalog.json). */
  starter?: (id: string) => StarterProject | undefined;
  requireModelAccess?:boolean;
  handoff: PrinterHandoffConfig;
  /** The handoff profile as the companion runs it now: after an MCP update (PRD §8.10) it carries that update's command. */
  runningHandoff?: () => PrinterHandoffConfig;
  printerCatalog?: PrinterCatalog;
  /** Live destination state and capabilities, from each destination's long-lived session. */
  printers?: PrinterDirectory;
  onChange?: (object: StmObject) => void;
  /** Rebuilds a handheld scan from its photos (`mac-reconstruct samples`). Defaults to the bundled tool. */
  reconstruct?: Reconstruct;
  print?: {
    services: PrintHandoffServices;
    /** Built once from each catalog entry's entire MCP config, never a host override. */
    destinations?: ReadonlyMap<string, PrintHandoffServices>;
  };
  /** Companion settings: which milestones the print monitor announces. */
  settings?: CompanionSettingsStore;
  runtimeSettings?: RuntimeSettings;
  /** Where print and pass events go (the event log, PRD §8.7). */
  events?: {emit(draft: EventDraft): Promise<void>};
  /** PRD §8.10: prints and MCP updates on a printer exclude each other. */
  printGate?: PrintGate;
  /** PRD §8.11: the worker that gets a published model's file (tests swap it). */
  runPublished?: (input: PublishedPassInput) => Promise<PublishedResult>;
  /** The printers' cameras, through their sessions, with a shared 3 s cache. */
  camera?: CameraFrames;
  /** Tests only. */
  monitorClock?: MonitorClock;
  /** This Mac's real stage durations, for pass estimates. */
  passTimings?: PassTimings;
  /** A short title for a request ("Mic mount"), best effort; the worker names it otherwise. */
  titleFor?: (request: string) => Promise<string | undefined>;
  reportsCompletion?: (note: string) => Promise<'works' | 'changes' | 'unknown'>;
}

/** What the print sheet sends with Print (PRD §8.5). */
export interface PrintOptions extends PrintSettings {expectedPlate?: string; checked?: boolean; filament?: FilamentChoice;
  /** The print sheet's estimate (`sliceSha256`): Print sends exactly that sliced file, the one its preview showed. */
  sliceSha256?: string;
  /** A multi-part 3MF: the spool chosen for each of the model's filaments, in filament order. */
  filaments?: FilamentChoice[];
  /** The model version those choices were made against (`colourMapping`'s), so a redesign can't inherit them. */
  filamentsModelVersion?: string}
/** One of a multi-part model's filaments with its suggested (or chosen) spool, for the print sheet. */
export interface ColourMappingFilament extends ModelFilament {
  /** The MCP's proposed tray's absolute slot; absent when nothing can print this colour. */
  slot?: number; distance?: number; materialMismatch?: boolean; guessed?: boolean;
  /** The MCP's verdict on its proposal (`same-colour`, `closest`, `no-colour`, `none`) and what the person should know, in its words. */
  verdict?: 'same-colour' | 'closest' | 'no-colour' | 'none'; note?: string;
}
export interface ColourMapping {filaments: ColourMappingFilament[]; trays: FilamentChoice[]; modelVersion?: string}
/**
 * Print's question for a design made in several colours before Counterpart kept each colour as its own part
 * (`#legacyColourDesign`): its model is the merged STL, so it would print in one colour.
 */
const LEGACY_COLOUR_ASK: PrintAsk = {
  message: 'This design was made in several colours before Counterpart kept each colour as its own part, so it would print in one colour. Make it again to keep its colours, or print it in one colour.',
  title: 'Colours',
  choices: [{value: 'one-colour', title: 'Print it in one colour'}, {value: 'remake', title: 'Make it again in colour'}],
  proceed: 'one-colour',
};
/** What "Make it again in colour" asks for, sent as the person's own message. */
const REMAKE_IN_COLOUR = 'Make this design again in the colours it was designed with, with each colour as its own part.';
const BAMBU_TO_STATUS: Record<string, string> = {idle: 'IDLE', preparing: 'PREPARE', printing: 'RUNNING', paused: 'PAUSE', finished: 'FINISH', failed: 'FAILED', cancelled: 'FAILED', offline: 'OFFLINE', busy: 'UNKNOWN'};

export type ObjectPrintAnswer = {action: 'accept'; content: Record<string, ConfirmationValue>} | {action: 'decline' | 'cancel'; content?: never};
/** A loaded spool. `label` ("A2", "External") and `name` ("Sunflower Yellow PLA Basic") are the printer MCP's words for it. */
export interface FilamentChoice {slot: number; colour: string; material: string; name: string; filamentId: string; destinationId: string; label?: string;
  /** Which spools can feed one print together (`ams`, `external`), as the printer MCP groups them. */
  feed?: string; suggested?: boolean}
/** A loaded tray; `profile` is absent when the MCP resolves no slicer profile for it (usable for a sliced file, not for slicing). */
type LiveFilament = FilamentChoice & {profile?: string};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** The installed MCP lacks a capability this needs: the person is asked to update it, never given a fallback. */
class McpUpdateNeeded extends InvalidStateError {}
/** One of the model's filaments as `counterpart_propose_filaments` takes it. */
const proposalFilament = (filament: ModelFilament) => ({index: filament.index, ...(filament.name ? {name: filament.name.slice(0, 256)} : {}),
  ...(filament.colour && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(filament.colour) ? {colour: filament.colour} : {}), ...(filament.material ? {material: filament.material.slice(0, 64)} : {})});

function toolProgress(name: string): string {
  if (['Read', 'WebSearch', 'WebFetch'].includes(name)) return 'Checking the reference material.';
  if (name.toLowerCase().includes('blender')) return 'Working on the model in Blender.';
  return 'Working on your project.';
}

/** Evenly spread picks from first to last, so every side of the object stays represented. */
export function spreadPick<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({length: count}, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]!);
}

/** The object lifecycle: inputs arrive, the touch-up runs by itself, and the result is ready to print. */
/**
 * A copy whose source is a 3MF the person added (a designer's project): its path in the project, else undefined.
 * Such a copy edits that file in place, so every pass starts from it rather than from the merged mesh.
 */
export function designerFile(object: Pick<StmObject, 'scan'>, kind: PassKind, scanName = object.scan): string | undefined {
  return kind === 'copy' && scanName?.toLowerCase().endsWith('.3mf') ? join('scan', scanName) : undefined;
}

/** What a print sheet's slice was made with (`recipeKey`), and whether the MCP drew it. Print must match `recipe`. */
interface ShownSliceShape {recipe: string; previewed: boolean; previewSupported: boolean}
/** The MCP takes previews but drew nothing for this file. */
const NOTHING_TO_PREVIEW = "Counterpart couldn't draw what this file would print, so it won't send it. Nothing was sent to the printer.";

/** One string for a print's model, destination, selection and slicer arguments: equal only when the slice would be. */
function recipeKey(destinationId: string, recipe: {selected?: PrinterSelection; sliced: PrinterSlicer}, model: Buffer): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    : value;
  return createHash('sha256').update(JSON.stringify(canonical({model: createHash('sha256').update(model).digest('hex'), destinationId, selection: recipe.selected ?? null, slicer: recipe.sliced}))).digest('hex');
}

/**
 * The request as Print applies it: saved defaults fill gaps; a 3MF owns its colours; saved pauses never apply; a
 * file that prints with its own settings (a designer's 3MF) gets no quality or strength the request didn't name.
 */
function printOptions(object: StmObject, options: PrintOptions, ownSettings: boolean): PrintOptions {
  const {pauseBeforeLayers: _savedPauses, ...defaults} = {...object.preferences?.printDefaults};
  if (isMultipart(object)) delete defaults.colour;
  if (ownSettings) { delete defaults.quality; delete defaults.strength; }
  return {...defaults, ...options, ...(options.filament ? {colour: undefined} : {})};
}

/** The same project on another printer: whether its file prints with its own settings is asked again there. */
function forgetOwnSettings(object: StmObject): Pick<StmObject, 'current'> {
  return object.current ? {current: {...object.current, ownSettings: undefined, ownSettingsFor: undefined}} : {};
}

/** A 3MF model owns its parts and their filaments: a published file, or a design in several colours. */
function isMultipart(object: Pick<StmObject, 'current'>): boolean {
  return object.current?.model.toLowerCase().endsWith('.3mf') === true;
}

/**
 * PRD §8.9: a copy is cleaned up in Blender; a new design may use Fusion. Set at creation; otherwise a project
 * with a scan (LiDAR or a handheld capture) is a copy, even with a request ("Copy this. Close up the bottom."),
 * since the phone sends only the request; a request with photos alone is a new design.
 */
export function passKind(object: Pick<StmObject, 'kind' | 'scan' | 'capture' | 'instructions' | 'current'>): PassKind {
  // A copy needs something to copy: one that never received a scan or capture is its request, a new design.
  // Its model, if any, came from passes run on the request alone (the Nov 2 guitar pick); a duplicate keeps its source's scan.
  if (object.kind === 'copy' && !object.scan && !object.capture?.length && object.instructions?.trim()) return 'fit';
  if (object.kind) return object.kind;
  // PRD §8.11: a link to a published model's page prints the designer's file; it is never designed.
  if (publishedLink(object.instructions)) return 'published';
  if (object.scan || object.capture?.length) return 'copy';
  return object.instructions?.trim() ? 'fit' : 'copy';
}

/** PRD §5.4: the Status Project Settings shows, from the project's state and what the person set. */
export function projectStatus(object: Pick<StmObject, 'state' | 'outcome'>): ProjectStatus {
  // `archived` is a separate flag now: the status underneath is what shows (KAN-217).
  // A known-good part stays known-good, through a reprint too.
  if (object.state === 'confirmed' || object.outcome === 'works') return 'works';
  if (object.outcome === 'needs-changes') return 'needs-changes';
  if (object.state === 'printed' || object.state === 'sent') return 'printed';
  return 'not-printed';
}

/** Anything sent into the project yet: a scan, photos, or a handheld capture. */
export function hasFiles(object: Pick<StmObject, 'scan' | 'photos' | 'capture' | 'captureDepth'>): boolean {
  return !!object.scan || object.photos.length > 0 || (object.capture?.length ?? 0) > 0 || (object.captureDepth?.length ?? 0) > 0;
}

const RESUMED_ELSEWHERE = 'Resumed outside Counterpart (on the printer or another app).';
/** Counterpart sent the Resume that ended the latest pause ("Resume sent." after the last "The printer paused it."). */
function resumedHere(events: readonly {message: string}[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.message === 'Resume sent.') return true;
    if (events[index]!.message === PRINT_LOG['print.paused']) return false;
  }
  return false;
}

/** A starter's file Ask: the print profile's 3MF, by the site's own button (its raw model has lost the plates). */
function starterFileQuestion(starter: StarterProject): string {
  return `On ${starter.site}, open ${starter.title.toLowerCase()}, choose the designer’s print profile and press Download 3MF, then add that 3MF here. Not the raw model files (STL or a zip): they don’t have the designer’s plates.`;
}
function starterRawModel(starter: StarterProject): string {
  return `That’s the raw model from ${starter.site}, without the designer’s plates. On the model’s page, choose the designer’s print profile and press Download 3MF, then add that 3MF.`;
}

export class ObjectService {
  readonly #deps: ObjectServiceDeps;
  readonly #running = new Map<string, Promise<StmObject>>();
  readonly #controlling = new Set<string>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #confirmations = new Map<string, {pending: PendingElicitation; printing: NonNullable<ObjectServiceDeps['print']>; timer: ReturnType<typeof setTimeout>}>();
  readonly #cancelledPrints = new Set<string>();
  /** Projects whose print the person stopped to make the design again in colour: that pass starts once the print ends. */
  readonly #remakes = new Set<string>();
  /** Per-print spool rechecks, run again when the printer's confirmation is accepted (it can wait minutes). */
  readonly #dispatchRechecks = new Map<string, () => Promise<void>>();
  /** Why a recheck declined a print, kept so the settled project still explains itself. */
  readonly #recheckFailures = new Map<string, string>();
  readonly #monitors = new Map<string, {runner: PrintMonitorRunner; controller: AbortController; done: Promise<void>}>();
  readonly #expiredConfirmations = new Set<string>();
  /** One action at a time per object, so a double tap can't start the same work twice. */
  readonly #gates = new Map<string, Promise<unknown>>();
  #closed = false;
  constructor(deps: ObjectServiceDeps) { this.#deps = deps; }

  #gate<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.#gates.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (this.#closed) throw new InvalidStateError('Counterpart is shutting down on this Mac.');
      return action();
    });
    this.#gates.set(id, next);
    void next.catch(() => undefined).finally(() => { if (this.#gates.get(id) === next) this.#gates.delete(id); });
    return next;
  }

  /** Stops running touch-ups and prints and waits for them to finish. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#deps.camera?.close();
    for (const controller of this.#controllers.values()) controller.abort();
    // Monitors stop watching; their saved state lets the next start carry on.
    for (const monitor of this.#monitors.values()) monitor.controller.abort();
    await Promise.allSettled([...this.#monitors.values()].map(monitor => monitor.done));
    for (const confirmation of this.#confirmations.values()) confirmation.printing.services.relay.respond(confirmation.pending.id, {action: 'cancel'});
    await Promise.allSettled([...this.#gates.values(), ...this.#running.values()]);
  }

  /** Print settings, controls and the monitor need the printers' sessions. */
  get printSettingsAvailable(): boolean { return !!this.#deps.printers; }
  async settings() { return {...(this.#deps.settings ? await this.#deps.settings.load() : {milestones: '50' as const}), ...this.#deps.runtimeSettings?.snapshot()}; }
  testAI(revision: string) { return this.runtimeSettings().testAI(revision); }
  setupFusion() { return this.runtimeSettings().requestFusion(); }
  private runtimeSettings() {
    if (!this.#deps.runtimeSettings) throw new InvalidStateError('Open an updated Counterpart on your Mac.');
    return this.#deps.runtimeSettings;
  }
  async updateSettings(patch: CompanionSettingsPatch) {
    if (!this.#deps.settings) throw new InvalidStateError('Settings are unavailable on this Mac.');
    if (patch.ai) await this.runtimeSettings().setAI(patch.ai);
    else await this.#deps.settings.update(patch);
    await this.#emit({id: randomUUID(), type: 'settings.changed', data: {keys: Object.keys(patch)}});
    return this.settings();
  }

  /** Hide from Home (KAN-217): a flag of its own. The status underneath stays exactly as it was, `sent` included. */
  setArchived(id: string, archived: boolean): Promise<StmObject> {
    return this.#gate(id, async () => this.#setArchivedNow(id, await this.get(id), archived));
  }
  async #setArchivedNow(id: string, object: StmObject, archived: boolean): Promise<StmObject> {
    if (!!object.archived === archived) return object;
    const updated = await this.#deps.store.update(id, o => {
      const {archived: _archived, ...rest} = o;
      return archived ? {...rest, archived: true} : rest;
    });
    await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['archived']}});
    return this.#changed(updated);
  }

  /** Save future-work defaults through the same gate as the project's other mutations. */
  setProjectSettings(id: string, patch: ProjectSettingsPatch): Promise<StmObject> {
    return this.#gate(id, async () => {
      let object = await this.get(id);
      let destination = patch.printerDestinationId;
      if (destination !== undefined && destination !== null) {
        const catalog = this.#deps.printerCatalog;
        destination = catalog?.canonical(destination);
        if (!destination || !catalog?.resolve(destination)) throw new InvalidStateError('That printer is no longer available. Choose another printer.');
      }
      if (patch.printerDestinationId !== undefined && (object.state === 'touching-up' || object.state === 'printing'))
        throw new InvalidStateError('Wait until the current step finishes before changing printers.');
      if (patch.designEngine === 'fusion' && passKind(object) === 'copy')
        throw new InvalidStateError('Scanned copies are cleaned up in Blender.');
      // Validate all new fields before applying the existing status/archive actions.
      if (patch.status !== undefined) object = await this.#setStatusNow(id, patch.status);
      if (patch.archived !== undefined) object = await this.#setArchivedNow(id, object, patch.archived);
      const keys = Object.keys(patch).filter(key => key !== 'status' && key !== 'archived');
      if (!keys.length) return object;
      const updated = await this.#deps.store.update(id, o => {
        const preferences = {...o.preferences};
        if (patch.printDefaults !== undefined) preferences.printDefaults = patch.printDefaults;
        else if (patch.printerDestinationId !== undefined && (destination ?? this.#deps.printerCatalog?.defaultDestinationId) !== this.#destinationId(o) && preferences.printDefaults) {
          const {colour: _colour, ...settings} = preferences.printDefaults;
          preferences.printDefaults = settings;
        }
        if (patch.designEngine !== undefined) preferences.designEngine = patch.designEngine;
        if (patch.notifications !== undefined) preferences.notifications = patch.notifications;
        const moved = patch.printerDestinationId !== undefined && (destination ?? this.#deps.printerCatalog?.defaultDestinationId) !== this.#destinationId(o);
        return {...o, ...(patch.title !== undefined ? {title: patch.title} : {}),
          ...(patch.printerDestinationId !== undefined ? {printerDestinationId: destination ?? undefined} : {}), preferences, ...(moved ? forgetOwnSettings(o) : {})};
      });
      await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys}});
      return this.#changed(updated);
    });
  }

  /** An independent ready project: copy model/design files, never jobs, outcomes or pending work. */
  duplicate(id: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      const source = await this.get(id);
      if (!source.current) throw new InvalidStateError('There is no model to duplicate yet.');
      if (source.state === 'touching-up') throw new InvalidStateError('Wait until the current step finishes.');
      const kind = passKind(source);
      const duplicate = await this.#deps.store.create(source.instructions, kind);
      try {
        const current = source.current;
        // A copy keeps the scan it copies, or with nothing scanned its request would read as a new design.
        const scan = kind === 'copy' ? source.scan : undefined;
        // Duplicate the chosen original, not every alternate file or an earlier plate.
        const receipt = source.kind === 'published' ? source.files?.receipts?.find(file => file.path === current.model) : undefined;
        const files = receipt ? {original: [receipt.path], current: receipt.path, receipts: [receipt]} : undefined;
        const publishedSelection = source.publishedSelection ? {...source.publishedSelection, fileIndex: 0} : undefined;
        // A designed multi-colour model prints its 3MF but is corrected from the merged mesh beside it: both copy.
        const paths = [current.model, ...(isMultipart(source) && source.kind !== 'published' ? ['current/model.stl'] : []), ...current.renders, ...(scan ? [`scan/${scan}`] : []), ...(receipt?.plates.flatMap(plate => plate.thumbnail ? [plate.thumbnail] : []) ?? []), ...(current.design ? [current.design.f3d, ...(current.design.parameters ? [current.design.parameters] : [])] : [])];
        for (const path of new Set(paths)) {
          if (isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new InvalidFileError('The model has an invalid file path.');
          const target = join(this.dir(duplicate.id), path);
          await mkdir(dirname(target), {recursive: true});
          // The merged mesh beside a designed 3MF is best-effort: a 3MF with none
          // (never written by a design pass) still duplicates as a printable model.
          if (path === 'current/model.stl' && current.model !== path)
            await copyFile(join(this.dir(id), path), target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
          else await copyFile(join(this.dir(id), path), target);
        }
        const credit = (source as StmObject & {credit?: unknown}).credit;
        const result = await this.#deps.store.update(duplicate.id, o => ({...o, state: 'ready', current,
          title: `${projectTitle(source).slice(0, 114)} copy`, printerDestinationId: source.printerDestinationId,
          preferences: {...source.preferences, printDefaults: this.#resolvedPrintDefaults(source)}, ...(credit ? {credit} : {}),
          ...(files ? {files} : {}), ...(publishedSelection ? {publishedSelection} : {}), ...(scan ? {scan} : {})}));
        await this.#emit({id: randomUUID(), type: 'project.updated', projectId: result.id, data: {keys: ['created']}});
        return this.#changed(result);
      } catch (error) { await this.#deps.store.remove(duplicate.id); throw error; }
    });
  }

  /**
   * How Print slices and routes this model with these choices (spools, colour mapping, quality, strength, copies,
   * pauses, plate, supports). The print sheet's estimate slices exactly this, and Print sends that file only when
   * its own recipe is the same (`recipeKey`).
   */
  async #sliceRecipe(id: string, object: StmObject, options: PrintOptions, selection: PrinterSelection | undefined, backend: PrinterHandoffConfig['backend'], destination?: {destinationId?: string}) {
    const {selection: colourSelection, slicer, chosenTrays} = await this.#colour(id, options, selection, backend, destination);
    const selected = object.publishedSelection ? {...colourSelection, plateIndex: object.publishedSelection.plateIndex} : colourSelection;
    const overrides = object.publishedSelection?.sliced
      ? {repetitions: 1, ...(options.pauseBeforeLayers?.length ? {pauseAtLayers: options.pauseBeforeLayers} : {})}
      : sliceOverrides(options);
    const sliced = {...slicer, ...overrides, ...designedSupports(object)};
    return {selected, overrides, sliced, ...(chosenTrays ? {chosenTrays} : {})};
  }

  /** The printer this project would print on takes `copies` (slice_stl repetitions). */
  get printCopiesAvailable(): boolean {
    return (this.#deps.printers?.list().destinations ?? []).some(destination => destination.capabilities?.copies);
  }

  /**
   * PRD §5.4 Status, set by hand at any time (for example to mark something done that printed elsewhere):
   * `works` → state `confirmed`; `printed`; `not-printed` → `ready`; `needs-changes`; `archived` hides it, keeping everything.
   */
  setStatus(id: string, status: ProjectStatus): Promise<StmObject> {
    return this.#gate(id, () => this.#setStatusNow(id, status));
  }
  async #setStatusNow(id: string, status: ProjectStatus): Promise<StmObject> {
    const object = await this.get(id);
    // Already there (the state itself, not just the label: a sent project marked printed is a real change).
    // `archived` is its own flag (setArchived); the status alias `archived` still hides it.
    if (status === 'archived') return this.#setArchivedNow(id, object, true);
    const clean = !object.outcome;
    const there = {works: object.state === 'confirmed', printed: object.state === 'printed' && clean,
      'needs-changes': object.outcome === 'needs-changes',
      'not-printed': clean && (object.current ? object.state === 'ready' : !['printed', 'confirmed', 'sent'].includes(object.state))}[status];
    if (there && !(status === 'works' && object.pendingFollowup) && !(object.publishedSelection && ['works', 'printed', 'not-printed'].includes(status))) return object;
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if ((status === 'works' || status === 'printed') && !object.current) throw new InvalidStateError("There's no model yet, so it can't be marked printed.");
    const updated = await this.#deps.store.update(id, o => {
      const {outcome: _outcome, ...rest} = o;
      if (o.publishedSelection && (status === 'works' || status === 'printed' || status === 'not-printed'))
        rest.plateProgress = acknowledgePlate(o, status === 'not-printed' ? 'not-printed' : 'printed');
      if (status === 'works') {
        const message = o.messages?.find(item => item.id === o.pendingMessageId);
        if (message) rest.completion = {messageId: message.id, note: message.text, atMs: message.atMs, previousStatus: projectStatus(o)};
        rest.pendingFollowup = undefined; rest.pendingMessageId = undefined;
      }
      if (status !== 'works' && rest.completion) rest.completion = {...rest.completion, undone: true};
      // A person saying it printed (or works) settles a print Counterpart couldn't follow.
      const settled = o.print?.uncertain ? {print: {...o.print, uncertain: undefined}} : {};
      switch (status) {
        // Hide from Home: the project keeps its status (Done stays Done) and gets it back when unhidden.
        case 'works': return {...rest, ...settled, state: o.state === 'printing' ? o.state : 'confirmed', outcome: 'works'};
        case 'printed': return {...rest, ...settled, state: 'printed'};
        // Without a model, only the flags clear: a draft stays a draft.
        case 'not-printed': return {...rest, ...(o.current ? {state: 'ready' as const} : {})};
        case 'needs-changes': return {...rest, outcome: 'needs-changes', ...(o.state === 'confirmed' ? {state: 'printed' as const} : {})};
      }
    });
    await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['status']}});
    return this.#changed(updated);
  }


  /** A person's name wins over a title generator or a pass still finishing in the background. */
  rename(id: string, title: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      const updated = await this.#deps.store.update(id, object => ({...object, title}));
      await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['title']}});
      return this.#changed(updated);
    });
  }

  #starterAdding: Promise<unknown> = Promise.resolve();
  /** Curated assets only; this never copies an existing project or any of its activity. */
  addStarter(starterId: string): Promise<StmObject> {
    const next = this.#starterAdding.catch(() => undefined).then(async () => {
      const starter = this.#starter(starterId);
      if (!starter) throw new InvalidStateError('Choose one of the starter projects.');
      const existing = (await this.#deps.store.list()).find(o => o.starterId === starterId);
      if (existing) return this.get(existing.id);
      const store = this.#deps.store;
      const created = await store.create(starter.instructions, 'published');
      try {
        const credit = {url: starter.url, designer: starter.designer, site: starter.site, title: starter.title, licence: starter.licence};
        await store.update(created.id, o => ({...o, starterId, title: starter.title, credit}));
        // Ready to go (David, Nov 5: "READY TO GO. not ready to be downloaded from maker world"): the same
        // published-model pass a pasted link runs (PRD §8.11) gets the designer's own files with the person's own
        // MakerWorld sign-in. Never bundled: the MakerWorld Standard Digital File License doesn't allow re-hosting.
        try { return await this.start(created.id); }
        catch (error) {
          console.error(`starter ${starterId}: no download pass for project ${created.id}: ${this.#publicText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 400)}`);
          // No worker to download with (AI is off, or its settings are unavailable): the project stays, and the person
          // adds the designer's files, as a pasted link asks when they can't be fetched.
          const ask = {id: randomUUID(), type: 'file' as const, question: starterFileQuestion(starter),
            url: starter.url, modelName: starter.title, site: starter.site, accepts: ['3mf' as const],
            answers: ['file' as const], status: 'open' as const, askedAtMs: Date.now()};
          return this.#changed(await store.update(created.id, o => ({...o, state: 'needs-closeup', ask})));
        }
      } catch (error) { await store.remove(created.id); throw error; }
    });
    this.#starterAdding = next;
    return next;
  }

  async create(instructions?: string, kind?: 'fit' | 'copy' | 'published', url?: string) {
    const link = url ? publishedLink(url) : undefined;
    if (url && !link) throw new InvalidStateError('Choose a published model page.');
    if (kind === 'published' && !link) throw new InvalidStateError('Add the published model’s link.');
    const created = await this.#deps.store.create(instructions, link ? 'published' : kind);
    return this.#changed(link ? await this.#deps.store.update(created.id, o => ({...o, credit: {url: link.url, site: link.site}})) : created);
  }
  async list() {
    const objects = await Promise.all((await this.#deps.store.list()).map(o => this.get(o.id)));
    // Projects from before titles get one, once and in the background, the first time they're listed.
    // (A new project gets its title at its first pass, from the request as it is then.)
    for (const object of objects) if (object.state !== 'new') this.#title(object, {backfill: true});
    // Whether each 3MF prints with its own settings, asked once per file and in the background.
    for (const object of objects) void this.#askOwnSettings(object);
    return objects;
  }

  /**
   * Answers per file and destination this run, so a plate switch back restores one: the MCP's own_process, or
   * `unsupported` when that MCP can't answer (the sheet then says to update it). `#ownSettingsAsking` shares a question
   * in flight, so an estimate waits for the same one.
   */
  readonly #ownSettingsAsked = new Map<string, boolean | 'unsupported'>();
  readonly #ownSettingsAsking = new Map<string, Promise<void>>();
  /** The model file's identity for these answers: a new pass writes a new current/model.3mf under the same name. */
  async #ownSettingsKey(object: StmObject, destinationId: string | undefined): Promise<{key: string; file: string; modelPath: string; destinationId: string | undefined} | undefined> {
    const current = object.current;
    if (!current || !isMultipart(object) || object.publishedSelection?.sliced) return undefined;
    const modelPath = join(this.#deps.store.dir(object.id), current.model);
    const file = await stat(modelPath).catch(() => undefined);
    if (!file) return undefined;
    // The running MCP's version too: after an update (Settings → Printers) its answer is asked for again.
    const server = destinationId ? this.#deps.printers?.capabilities(destinationId)?.server?.version ?? null : null;
    const identity = [object.id, current.model, file.mtimeMs, file.size, destinationId ?? null];
    return {key: JSON.stringify([...identity, server]), file: JSON.stringify(identity), modelPath, destinationId};
  }
  /**
   * Whose answer `current.ownSettings` is: the printer and its MCP's running version (`current@1.1.65`). An updated MCP
   * may decide differently, so its answer is asked for again.
   */
  #ownSettingsFor(destinationId: string | undefined): string {
    const version = destinationId ? this.#deps.printers?.capabilities(destinationId)?.server?.version : undefined;
    return `${destinationId ?? 'current'}${version ? `@${version}` : ''}`;
  }
  /** That printer's MCP can't say whether this project's 3MF prints with its own settings: an older MCP to update. */
  async #ownSettingsUnsupported(object: StmObject, destinationId: string | undefined): Promise<boolean> {
    const asked = await this.#ownSettingsKey(object, destinationId);
    return !!asked && this.#ownSettingsAsked.get(asked.key) === 'unsupported';
  }
  /**
   * The MCP said this file prints with its own settings on that printer: kept on `current` for the project's printer,
   * or this run's answer for another printer the sheet slices for.
   */
  async #ownSettingsOn(object: StmObject, destinationId: string | undefined): Promise<boolean> {
    if (object.current?.ownSettingsFor === this.#ownSettingsFor(destinationId)) return object.current.ownSettings === true;
    const asked = await this.#ownSettingsKey(object, destinationId);
    return !!asked && this.#ownSettingsAsked.get(asked.key) === true;
  }
  /**
   * Asks the project's printer MCP whether its current 3MF prints with the settings it carries (a designer's
   * project) and keeps the answer on `current.ownSettings`, for that file and printer only. Once per file per run; a
   * failed call is asked again later, and an MCP that can't answer leaves it absent. Never throws.
   */
  #askOwnSettings(object: StmObject, destinationId = this.#destinationId(object)): Promise<void> {
    const current = object.current;
    if (current?.ownSettings !== undefined && current.ownSettingsFor === this.#ownSettingsFor(destinationId)) return Promise.resolve();
    return (async () => {
      const asked = await this.#ownSettingsKey(object, destinationId);
      if (!asked) return;
      const {key, file, modelPath} = asked;
      const pending = this.#ownSettingsAsking.get(key);
      if (pending) return pending;
      const asking = this.#ownSettingsAnswer(object, key, file, modelPath, destinationId).finally(() => this.#ownSettingsAsking.delete(key));
      this.#ownSettingsAsking.set(key, asking);
      return asking;
    })();
  }
  async #ownSettingsAnswer(object: StmObject, key: string, file: string, modelPath: string, destinationId: string | undefined): Promise<void> {
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    const ask = services?.runner.ownProcess;
    if (!ask) return;
    try {
      let own = this.#ownSettingsAsked.get(key);
      if (own === undefined) {
        // The design's own supports, as Print's slice sends them (`#sliceRecipe`).
        own = await ask.call(services.runner, {modelPath, ...(services.selection ? {selection: services.selection} : {}),
          ...(Object.keys(designedSupports(object)).length ? {slicer: designedSupports(object)} : {}), signal: AbortSignal.timeout(60_000)});
        this.#ownSettingsAsked.set(key, own);
        // Connecting for the question can tell the directory the MCP's version: the answer is that version's too.
        const after = await this.#ownSettingsKey(object, destinationId);
        if (after && after.file === file) this.#ownSettingsAsked.set(after.key, own);
      }
      // Kept on the project only for its own printer; another printer's answer stays this run's (`#ownSettingsOn`).
      if (own === 'unsupported' || destinationId !== this.#destinationId(object)) return;
      // The answer is for the file that was asked about: a pass that replaced it since gets its own question.
      const now = await this.#ownSettingsKey(await this.#deps.store.get(object.id), destinationId);
      if (now?.file !== file) return;
      let changed = false;
      const answer = own;
      const updated = await this.#deps.store.update(object.id, o => {
        if (!o.current || o.current.model !== object.current!.model || this.#destinationId(o) !== destinationId
            || (o.current.ownSettings === answer && o.current.ownSettingsFor === this.#ownSettingsFor(destinationId))) return o;
        changed = true;
        return {...o, current: {...o.current, ownSettings: answer, ownSettingsFor: this.#ownSettingsFor(destinationId)}};
      });
      if (!changed) return;
      await this.#emit({id: randomUUID(), type: 'project.updated', projectId: object.id, data: {keys: ['current']}});
      this.#changed(updated);
    } catch { /* a failed call leaves it unknown; the next list or estimate asks again */ }
  }
  async get(id: string): Promise<StmObject> {
    let object = await this.#deps.store.get(id);
    if (object.state === 'touching-up') object = await this.#freshEstimate(object);
    if (!object.print) return object;
    // A watched print reads its monitor's last report instead of asking the printer again.
    const statusOf = (report: Pick<PrintReport, 'state' | 'job' | 'observedAt'>) => {
      const active = ['preparing', 'printing', 'paused'].includes(report.state);
      return {state: BAMBU_TO_STATUS[report.state] ?? 'UNKNOWN',
        ...(report.job?.name ? {job: report.job.name.slice(0, 160)} : {}), checkedAtMs: Date.parse(report.observedAt) || Date.now(),
        ...(active && report.job?.progress !== undefined ? {percent: report.job.progress} : {}),
        ...(active && report.job?.remainingSec !== undefined ? {remainingMinutes: Math.round(report.job.remainingSec / 60)} : {})};
    };
    if (object.print.live) return {...object, print: {...object.print, printerStatus: statusOf(object.print.live)}};
    const printing = this.#deps.print;
    // A print recorded against a destination that has since become a duplicate reads through its winner.
    const recorded = object.print.destination?.id;
    const destinationId = recorded === undefined ? undefined : this.#deps.printerCatalog?.canonical(recorded) ?? recorded;
    const services = destinationId ? printing?.destinations?.get(destinationId) : printing?.services;
    // The printer's last counterpart_print_progress report, as the printer list and the monitor read it:
    // a project read never asks the printer itself.
    const report = destinationId ? this.#deps.printers?.lastReport(destinationId) : undefined;
    if (report) object = {...object, print: {...object.print!, printerStatus: statusOf(report)}};
    // The estimate a print shows is the one the MCP read from its sliced file at print time (saved with the print).
    return object;
  }
  dir(id: string) { return this.#deps.store.dir(id); }

  async passActivity(id: string, index: number): Promise<TouchupActivity[]> {
    if (!Number.isSafeInteger(index) || index < 0) throw new ObjectNotFoundError();
    const pass = (await this.get(id)).passes[index];
    if (!pass) throw new ObjectNotFoundError();
    return pass.activity ?? [];
  }

  printers(): {defaultDestinationId?: string; destinations: PublicDestination[]} {
    // Metadata reads also come from status/event refreshes with no camera on screen.
    if (this.#deps.printers) return this.#deps.printers.list();
    const catalog = this.#deps.printerCatalog;
    return {defaultDestinationId: catalog?.defaultDestinationId, destinations: catalog?.destinations.map(({id, aliases, name, backend, model, address, source, origin, mcps, folder}) =>
      ({id, ...(aliases ? {aliases} : {}), name, backend, ...(model ? {model} : {}), ...(address ? {address} : {}), source, ...(origin ? {origin} : {}), ...(mcps ? {mcps} : {}), ...(folder ? {folder} : {})})) ?? []};
  }

  /** The listed destination an object's choice stands for now (a duplicate resolves to its winner). */
  #destinationId(object: StmObject): string | undefined {
    const catalog = this.#deps.printerCatalog;
    const chosen = object.printerDestinationId ?? catalog?.defaultDestinationId;
    return chosen === undefined ? undefined : catalog?.canonical(chosen) ?? chosen;
  }

  /** Saved defaults are intentional; a historical spool belongs only to its recorded printer. */
  #resolvedPrintDefaults(object: StmObject): PrintSettings | undefined {
    if (object.preferences?.printDefaults !== undefined) return object.preferences.printDefaults;
    const previous = object.print?.settings;
    if (!previous) return undefined;
    const recorded = object.print?.destinationId ?? object.print?.destination?.id;
    const previousPrinter = recorded === undefined ? undefined : this.#deps.printerCatalog?.canonical(recorded) ?? recorded;
    // Layer pauses belong to that print of that model, never to defaults.
    const {pauseBeforeLayers: _pauses, ...settings} = previous;
    if (previousPrinter !== undefined && previousPrinter === this.#destinationId(object)) return settings;
    const {colour: _colour, ...defaults} = settings;
    return defaults;
  }

  /** A filament profile path mcp-3D-printer-server reports for a loaded material (`slots[].profile`), if any. */
  async #genericProfile(id: string, material: string): Promise<string | undefined> {
    const object = await this.get(id);
    const destinationId = this.#destinationId(object);
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    if (!services?.runner.filaments) return undefined;
    const inventory = await services.runner.filaments().catch(() => undefined);
    const slots = record(inventory) && Array.isArray(inventory.slots) ? inventory.slots : [];
    for (const slot of slots) {
      if (!record(slot) || typeof slot.material !== 'string' || slot.material.toLowerCase() !== material.toLowerCase()) continue;
      const path = typeof slot.profile === 'string' ? slot.profile : typeof slot.resolved_profile_path === 'string' ? slot.resolved_profile_path : undefined;
      if (path && path.startsWith('/')) return path;
    }
    return undefined;
  }

  private async liveFilaments(id: string, override?: {destinationId?: string}): Promise<LiveFilament[]> {
    const object = await this.get(id), configured = this.#deps.print;
    // An estimate may name a different printer from the project's saved one: its spools are that printer's.
    const destinationId = override ? override.destinationId : this.#destinationId(object);
    const services = destinationId ? configured?.destinations?.get(destinationId) : configured?.services;
    // Trays come from any MCP that reports them (counterpart_printer_info `filaments: "ams"`), not from one package.
    const ams = !!destinationId && this.#deps.printers?.capabilities(destinationId)?.filaments === 'ams';
    if (!services || !ams || !services.runner.filaments) throw new InvalidStateError('Filament choices are unavailable for this printer. Open the model in your slicer to choose a material.');
    let inventory: unknown;
    try { inventory = await services.runner.filaments(); }
    catch { throw new InvalidStateError('Couldn’t read the printer’s filament. Check its connection and try again.'); }
    // The counterpart/1 filament contract (mcp-3D-printer-server): {slots: [{id, material, color, name, profile}]}.
    if (record(inventory) && Array.isArray(inventory.slots)) return inventory.slots.flatMap((slot: unknown): LiveFilament[] => {
      if (!record(slot) || typeof slot.id !== 'string' || !/^(\d{1,4}|ext)$/.test(slot.id) || typeof slot.material !== 'string' || !slot.material || slot.material.length > 128
          || typeof slot.color !== 'string' || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(slot.color)) return [];
      const number = slot.id === 'ext' ? 254 : Number(slot.id);
      if (number > 4095) return [];
      const profile = typeof slot.profile === 'string' && slot.profile.startsWith('/') ? slot.profile : undefined;
      return [{slot:number, colour:slot.color.slice(0,7).toUpperCase(), material:slot.material,
        filamentId:typeof slot.filamentId === 'string' ? slot.filamentId.slice(0,128) : '', destinationId:destinationId ?? 'default',
        name:typeof slot.name === 'string' ? slot.name.slice(0,256) : slot.material,
        ...(typeof slot.label === 'string' && slot.label ? {label: slot.label.slice(0,64)} : {}), ...(profile ? {profile} : {})}];
    });
    if (!record(inventory) || !Array.isArray(inventory.trays)) throw new InvalidStateError('The printer did not return a filament inventory.');
    return inventory.trays.flatMap((tray: unknown): LiveFilament[] => {
      if (!record(tray) || tray.loaded !== true || !Number.isSafeInteger(tray.slot) || (tray.slot as number) < 0
          || typeof tray.tray_color !== 'string' || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(tray.tray_color)
          || typeof tray.tray_type !== 'string' || !tray.tray_type || tray.tray_type.length > 128 || typeof tray.tray_info_idx !== 'string' || tray.tray_info_idx.length > 128) return [];
      const profile = typeof tray.resolved_profile_path === 'string' && tray.resolved_profile_path.startsWith('/') ? tray.resolved_profile_path : undefined;
      return [{slot:tray.slot as number, colour:'#' + tray.tray_color.slice(0,6).toUpperCase(), material:tray.tray_type,
        filamentId:tray.tray_info_idx, destinationId:destinationId ?? 'default',
        // The MCP's words for the spool and where it sits; an MCP without them shows the material.
        name:typeof tray.spool_name === 'string' && tray.spool_name ? tray.spool_name.slice(0,256) : tray.tray_type,
        ...(typeof tray.label === 'string' && tray.label ? {label: tray.label.slice(0,64)} : {}),
        ...(profile ? {profile} : {})}];
    });
  }

  /** Live filaments; `suggested` marks the preselected one: the configured material's first loaded tray, else the first tray.
   * Single-colour choices slice with the spool's profile, so profile-less trays are not offered here. */
  async filaments(id: string): Promise<FilamentChoice[]> {
    const live = (await this.liveFilaments(id)).filter(item => item.profile), object = await this.get(id);
    const destinationId = this.#destinationId(object);
    const material = (destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services)?.selection?.material?.toLowerCase();
    const pick = live.find(item => material && item.profile && item.material.toLowerCase() === material) ?? live.find(item => item.profile) ?? live[0];
    return live.map(({profile: _profile, ...choice}) => ({...choice, ...(choice === pick || (pick && choice.slot === pick.slot) ? {suggested: true} : {})}));
  }

  /**
   * The current 3MF's filaments with the colour each belongs in, its declared
   * slot count, and a version of the model bytes: the file's own assignments
   * (published files carry colours) for the selected plate, overlaid with what
   * the design pass declared (a designed 3MF carries filaments but no colours).
   * Declared colours match file filaments by part name first, then by position
   * when the counts agree — several parts may share one filament.
   */
  async #modelData(object: StmObject): Promise<{filaments: ModelFilament[]; slots: number; version: string; declaredSlots: ModelFilament[]; plateUsed?: Set<number>}> {
    const bytes = isMultipart(object) && object.current ? await this.#modelBytes(object).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    // The plate and the declared colours are part of the version: choices made for one
    // plate (or before a colour-only redesign of a byte-identical 3MF) must not validate.
    const version = createHash('sha256').update(bytes)
      .update(`|plate:${object.publishedSelection?.plateIndex ?? 0}|declared:${JSON.stringify(object.current?.filaments ?? [])}`).digest('hex');
    if (!bytes.length) return {filaments: [], slots: 0, version, declaredSlots: []};
    const declaredSlots = modelDeclaredFilaments(bytes);
    const plateIndex = object.publishedSelection?.plateIndex ?? 0;
    const plateList = modelPlateFilaments(bytes, plateIndex);
    const plateUsed = plateList ? new Set(plateList) : undefined;
    const fromFile = modelFilaments(bytes, plateIndex);
    const declared = object.current!.filaments ?? [];
    if (!fromFile.length) return {filaments: declared.map((entry, i) => ({index: i + 1, ...entry})), slots: declared.length, version, declaredSlots, plateUsed};
    // Name matching only where the name is unique on both sides; duplicates fall back to position.
    const count = (values: (string | undefined)[]) => values.reduce((map, name) => name ? map.set(name.trim().toLowerCase(), (map.get(name.trim().toLowerCase()) ?? 0) + 1) : map, new Map<string, number>());
    const declaredCounts = count(declared.map(entry => entry.name)), fileCounts = count(fromFile.map(filament => filament.name));
    const byName = new Map(declared.flatMap(entry => entry.name && declaredCounts.get(entry.name.trim().toLowerCase()) === 1 && fileCounts.get(entry.name.trim().toLowerCase()) === 1
      ? [[entry.name.trim().toLowerCase(), entry] as const] : []));
    const aligned = declared.length === fromFile.length;
    const filaments = fromFile.map((filament, position) => {
      const declaredEntry = (filament.name ? byName.get(filament.name.trim().toLowerCase()) : undefined) ?? (aligned ? declared[position] : undefined);
      return {index: filament.index,
        ...((filament.name ?? declaredEntry?.name) ? {name: filament.name ?? declaredEntry!.name} : {}),
        ...((filament.colour ?? declaredEntry?.colour) ? {colour: filament.colour ?? declaredEntry!.colour} : {}),
        ...((filament.material ?? declaredEntry?.material) ? {material: filament.material ?? declaredEntry!.material} : {})};
    });
    // Painted regions print with filaments no part names. When the file carries
    // painting (and no authoritative plate list already named them), every other
    // declared slot is a colour of the model too — visible and editable in the
    // sheet, not silently auto-assigned. Without painting they are unused presets.
    if (!plateUsed && modelHasPainting(bytes)) {
      const known = new Set(filaments.map(filament => filament.index));
      for (const slot of declaredSlots) if (!known.has(slot.index)) filaments.push({...slot});
      filaments.sort((a, b) => a.index - b.index);
    }
    return {filaments, slots: Math.max(modelFilamentSlotCount(bytes), ...filaments.map(filament => filament.index)), version, declaredSlots, plateUsed};
  }

  /** Whether this object's printer reports AMS trays at all (the gate `liveFilaments` applies). */
  #amsAvailable(object: StmObject, override?: {destinationId?: string}): boolean {
    const destinationId = override ? override.destinationId : this.#destinationId(object);
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    return !!services?.runner.filaments && !!destinationId && this.#deps.printers?.capabilities(destinationId)?.filaments === 'ams';
  }

  /**
   * The printer MCP's spool proposal for this model (`counterpart_propose_filaments`), read from the printer
   * the print goes to. The companion keeps no colour matching of its own (PRD §8.0 item 7).
   */
  async #proposal(object: StmObject, input: FilamentProposalInput, override?: {destinationId?: string}): Promise<{proposal: FilamentProposal; destinationId: string}> {
    const destinationId = override ? override.destinationId : this.#destinationId(object);
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    if (!services) throw new InvalidStateError('Filament choices are unavailable for this printer. Open the model in your slicer to choose a material.');
    if (!services.runner.proposeFilaments) throw new McpUpdateNeeded(filamentProposalUnavailable(services.runner.backend));
    let value: unknown;
    try { value = await services.runner.proposeFilaments(input); }
    catch (error) {
      if (error instanceof PrinterMcpError && error.code === 'filament-proposal-unavailable') throw new McpUpdateNeeded(filamentProposalUnavailable(services.runner.backend));
      throw new InvalidStateError('Couldn’t read the printer’s filament. Check its connection and try again.');
    }
    const proposal = readFilamentProposal(value);
    if (!proposal) throw new McpUpdateNeeded(filamentProposalUnavailable(services.runner.backend));
    return {proposal, destinationId: destinationId ?? 'default'};
  }

  /** A spool from the MCP's proposal, as the print sheet and the dispatch recheck read it. */
  static #choice(tray: ProposalTray, destinationId: string): LiveFilament {
    // The MCP's own colour, unchanged: the sheet sends it back as the spool's identity.
    return {slot: tray.slot, colour: tray.colour, material: tray.material, filamentId: tray.filamentId,
      destinationId, name: tray.name, label: tray.label, feed: tray.feed, ...(tray.profile ? {profile: tray.profile} : {})};
  }

  /** The print sheet's colour rows for a multi-part model: its filaments, the loaded spools, and the MCP's proposal for each. */
  async colourMapping(id: string): Promise<ColourMapping> {
    const object = await this.get(id);
    const {filaments: model, version} = await this.#modelData(object);
    if (!model.length || !this.#amsAvailable(object)) return {filaments: [], trays: []};
    const sliced = !!object.publishedSelection?.sliced;
    const {proposal, destinationId} = await this.#proposal(object, {filaments: model.map(proposalFilament), sliced});
    const rows = new Map(proposal.proposal.map(row => [row.index, row]));
    return {
      filaments: model.map(filament => {
        const row = rows.get(filament.index);
        return {...filament, ...(row ? {
          ...(row.slot !== undefined ? {slot: row.slot} : {}),
          ...(row.distance !== undefined ? {distance: row.distance} : {}),
          ...(row.materialMismatch ? {materialMismatch: true} : {}),
          ...(row.verdict === 'no-colour' ? {guessed: true} : {}),
          verdict: row.verdict, ...(row.note ? {note: row.note} : {}),
        } : {})};
      }),
      // The MCP lists only spools it can use for this model: for an unsliced one, those it can slice with.
      trays: proposal.trays.map(tray => { const {profile: _profile, ...choice} = ObjectService.#choice(tray, destinationId); return choice; }),
      modelVersion: version,
    };
  }

  /**
   * A multi-part 3MF's spools as the MCP's selection and slicing options: the sheet's choices, checked by the
   * MCP against what is loaded now, or the MCP's proposal. Undefined when the model's filaments can't be read,
   * or (with no explicit choices) when the printer's filament can't be read: the MCP's own defaults then apply.
   */
  async #multipartColour(object: StmObject, options: PrintOptions, selection: PrinterSelection | undefined,
      _backend: PrinterHandoffConfig['backend'], destinationOverride?: {destinationId?: string}): Promise<{selection?: PrinterSelection; slicer?: PrinterSlicer; chosenTrays?: LiveFilament[]} | undefined> {
    const {filaments: model, slots, version, declaredSlots, plateUsed} = await this.#modelData(object);
    // Explicit choices are validated even when this model's filaments can't be read:
    // falling back to the MCP's defaults would silently drop the person's spools.
    if (options.filaments && (options.filamentsModelVersion !== version || !model.length))
      throw new InvalidStateError(options.filamentsModelVersion
        ? 'The model changed since you chose its spools. Reopen the print sheet and check the colours.'
        : 'These spool choices carry no model version. Reopen the print sheet and choose the spools again.');
    if (!model.length) return undefined;
    // A printer that reports no AMS has one spool for every part: the MCP's own selection prints it, as before.
    if (!options.filaments && !this.#amsAvailable(object, destinationOverride)) return undefined;
    if (options.filaments && options.filaments.length !== model.length)
      throw new InvalidStateError('Choose a spool for every colour in this model, then try again.');
    const sliced = !!object.publishedSelection?.sliced;
    const known = new Set(model.map(filament => filament.index));
    // Slots no part names (painted regions) the MCP maps too; one the selected plate never uses can't block it.
    const painted = declaredSlots.filter(slot => !known.has(slot.index) && slot.index <= slots)
      .map(slot => ({...proposalFilament(slot), ...(plateUsed ? {prints: plateUsed.has(slot.index)} : {})}));
    let result: {proposal: FilamentProposal; destinationId: string};
    try {
      result = await this.#proposal(object, {filaments: model.map(proposalFilament), ...(painted.length ? {painted} : {}), sliced,
        ...(options.filaments ? {chosen: options.filaments.map((choice, i) => ({index: model[i]!.index, slot: choice.slot, colour: choice.colour, material: choice.material, filamentId: choice.filamentId}))} : {})},
        destinationOverride);
    } catch (error) {
      // An MCP without the proposal asks for its update, chosen spools or not: never a silent fallback to its defaults.
      // A printer whose filament can't be read right now prints with the MCP's own selection, as before.
      if (options.filaments || error instanceof McpUpdateNeeded) throw error;
      return undefined;
    }
    const {proposal, destinationId} = result;
    if (options.filaments?.some(choice => choice.destinationId !== destinationId))
      throw new InvalidStateError('A chosen filament changed. Choose the current spools and try again.');
    const [problem] = proposal.problems;
    // The MCP's refusal, in its words: the companion never decides which of its problems may be ignored.
    if (problem) throw new InvalidStateError(problem.message);
    if (!proposal.mapping) return undefined;
    const trays = new Map(proposal.trays.map(tray => [tray.slot, ObjectService.#choice(tray, destinationId)]));
    const byIndex = new Map(proposal.mapping.flatMap(entry => trays.has(entry.slot) ? [[entry.index, trays.get(entry.slot)!] as const] : []));
    const first = byIndex.get(model[0]!.index);
    if (!first || model.some(filament => !byIndex.has(filament.index)))
      throw new InvalidStateError('The printer service returned an incomplete spool mapping. Reopen the print sheet and try again.');
    // One entry per declared slot, used or not: slicing requires exactly that many profiles.
    const at = (index: number) => byIndex.get(index) ?? first;
    const amsMapping = Array.from({length: slots}, (_, i) => at(i + 1).slot);
    const feeds = new Map(proposal.trays.map(tray => [tray.slot, tray.feed]));
    // Every spool in the final mapping is rechecked at dispatch, painted slots included.
    const allTrays = [...new Map([...byIndex.values()].map(tray => [tray.slot, tray])).values()];
    const mapped: PrinterSelection = {...selection,
      useAms: model.some(filament => feeds.get(at(filament.index).slot) === 'ams'),
      amsMapping, amsSlots: undefined, autoMatchAms: false};
    if (sliced) return {selection: mapped, chosenTrays: allTrays};
    if (Array.from({length: slots}, (_, i) => at(i + 1)).some(tray => !tray.profile))
      throw new InvalidStateError('A chosen spool has no slicing profile on this Mac. Choose another spool.');
    return {selection: mapped, chosenTrays: allTrays, slicer: {
      loadFilaments: Array.from({length: slots}, (_, i) => at(i + 1).profile!).join(';'),
      filamentColours: Array.from({length: slots}, (_, i) => at(i + 1).colour.slice(0, 7).toUpperCase()).join(';'),
    }};
  }

  selectPrinter(id: string, destinationId: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id), catalog = this.#deps.printerCatalog;
      if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes before changing printers.');
      const chosen = catalog?.canonical(destinationId);
      if (!chosen || !catalog?.destinations.some(destination => destination.id === chosen) || !catalog.resolve(chosen))
        throw new InvalidStateError('That printer is no longer available. Choose another printer.');
      return this.#changed(await this.#deps.store.update(id, o => {
        const {colour: _colour, ...defaults} = o.preferences?.printDefaults ?? {};
        return {...o, printerDestinationId: chosen, ...(this.#destinationId(o) !== chosen && o.preferences?.printDefaults
          ? {preferences: {...o.preferences, printDefaults: defaults}} : {}), ...(this.#destinationId(o) !== chosen ? forgetOwnSettings(o) : {})};
      }));
    });
  }

  /** An unsent draft may change; once a pass starts its original request is part of the history. */
  updateInstructions(id: string, instructions: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      if ((await this.get(id)).state !== 'new') throw new InvalidStateError('The description cannot change after work starts. Send a correction instead.');
      return this.#changed(await this.#deps.store.update(id, object => ({...object, instructions: instructions.trim() || undefined})));
    });
  }

  /** Phone uploads arriving right now, per project. A `new` project with none and no files yet is a draft. */
  readonly #receiving = new Map<string, number>();
  /** Whether a phone upload for this project is arriving right now (its body is being read or stored). */
  receiving(id: string): boolean { return (this.#receiving.get(id) ?? 0) > 0; }
  /**
   * Counts one phone upload while its body arrives and is stored. The companion keeps no other trace of an upload in
   * progress (bodies are read whole before a file is written), so this is how the Mac tells a send from a draft.
   */
  async receive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.#receiving.get(id) ?? 0;
    this.#receiving.set(id, before + 1);
    if (before === 0) await this.#draftChanged(id);
    try { return await work(); }
    finally {
      const left = (this.#receiving.get(id) ?? 1) - 1;
      if (left > 0) this.#receiving.set(id, left);
      else { this.#receiving.delete(id); await this.#draftChanged(id); }
    }
  }
  /** The apps re-read on any event: say so when a new project with no files starts or stops receiving one. */
  async #draftChanged(id: string): Promise<void> {
    const object = await this.#deps.store.get(id).catch(() => undefined);
    if (object?.state === 'new' && !hasFiles(object)) await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['receiving']}});
  }

  async addScan(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'new') throw new InvalidStateError('The scan can only be added before the touch-up starts.');
    await this.#deps.store.addFile(id, 'scan', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, scan: name})));
  }

  /** One photo of a handheld scan (the object turned in front of a still phone). */
  addCapturePhoto(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id);
      if (object.state !== 'new' || object.scan) throw new InvalidStateError('The scan can only be added before the touch-up starts.');
      // Replacing capture photos invalidates camera metadata bound to the old bytes.
      if (object.captureCamera) {
        await clearReconstructionInputs(this.dir(id));
        await this.#deps.store.update(id, o => ({...o, captureCamera: undefined, reconstructionReview: undefined}));
      }
      if (object.captureCompletion) await this.#deps.store.update(id, o => ({...o, captureCompletion: undefined}));
      await this.#deps.store.addFile(id, 'capture', name, bytes);
      return this.#changed(await this.#deps.store.update(id, o => {
        const capture = o.capture ?? [];
        return {...o, capture: capture.includes(name) ? capture : [...capture, name], captureCompletion: undefined};
      }));
    });
  }

  /**
   * capture-camera v1 for the saved capture photos (Android ARCore centres and
   * intrinsics). Only before start; every frame is bound to the exact saved
   * bytes, and the frame set must be exactly the captured set.
   */
  addCaptureCamera(id: string, value: unknown): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id);
      if (object.state !== 'new' || object.scan) throw new InvalidStateError('Camera information can only be added before the touch-up starts.');
      const camera = await validateCaptureCamera(value, join(this.dir(id), 'capture'), object.capture ?? []);
      // Store exactly what was validated; the digest binds those bytes to the completion.
      const stored = Buffer.from(JSON.stringify(camera, null, 2) + '\n', 'utf8');
      await writeCaptureCamera(this.dir(id), camera);
      return this.#changed(await this.#deps.store.update(id, o => ({...o,
        captureCamera: {sha256: captureCameraDigest(stored), frameCount: camera.frames.length},
        captureCompletion: undefined})));
    });
  }

  /** A lossless depth payload paired with a numbered RGB frame; retries retain the same identity. */
  addCaptureDepth(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    return this.#gate(id, async () => {
      if (!/^[0-9]{4}\.depth\.plist$/.test(name) || bytes.length < 8 || bytes.subarray(0, 8).toString('ascii') !== 'bplist00')
        throw new Error('Invalid file name');
      const object = await this.get(id);
      if (object.state !== 'new' || object.scan) throw new InvalidStateError('Depth can only be added before reconstruction starts.');
      if (object.captureCompletion) await this.#deps.store.update(id, o => ({...o, captureCompletion: undefined}));
      await this.#deps.store.addFile(id, 'capture', name, bytes);
      return this.#changed(await this.#deps.store.update(id, o => ({...o,
        captureDepth: o.captureDepth?.includes(name) ? o.captureDepth : [...(o.captureDepth ?? []), name],
        captureCompletion: undefined,
      })));
    });
  }

  /** Photos are welcome at any time; one added while a pass runs is used by the next pass ("late photos"). */
  async addPhoto(id: string, name: string, bytes: Buffer, forMessage = false): Promise<StmObject> {
    await this.get(id);
    await this.#deps.store.addFile(id, 'photos', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => {
      if (o.photos.includes(name)) return o;
      // With no model after an initial failure, added evidence is for Try Again.
      // Preserve the sender's message ownership even if its upload arrives after failure.
      const requestEvidence = !forMessage && ((o.state === 'new' && o.passes.length === 0) || (o.state === 'failed' && !o.current));
      return {...o, photos: [...o.photos, name], ...(requestEvidence
        ? {requestPhotos: [...(o.requestPhotos ?? []), name]}
        : {pendingPhotos: [...(o.pendingPhotos ?? []), name]})};
    }));
  }

  /**
   * Copies a file on this Mac into the object (the Mac app's New Project and drop targets).
   * The control socket can't carry file bytes, so the companion reads the path itself.
   */
  addFile(id: string, kind: 'photos' | 'scan' | 'model', path: string, forMessage = false): Promise<StmObject> {
    // One at a time per object, so two files with the same name can't take the same slot.
    return this.addFileReceipt(id, kind, path, forMessage).then(receipt => receipt.object);
  }
  /** The exact name assigned to this upload, independent of other pending evidence. */
  addFileReceipt(id: string, kind: 'photos' | 'scan' | 'model', path: string, forMessage = false): Promise<{object: StmObject; photoName?: string}> {
    return this.#gate(id, () => this.#addFileReceipt(id, kind, path, forMessage));
  }
  async #addFileReceipt(id: string, kind: 'photos' | 'scan' | 'model', path: string, forMessage = false): Promise<{object: StmObject; photoName?: string}> {
    const rule = FILE_KINDS[kind];
    if (!isAbsolute(path) || path.includes('\0')) throw new InvalidFileError('Choose a file on this Mac.');
    const extension = extname(path).toLowerCase();
    if (!(rule.extensions as readonly string[]).includes(extension)) throw new InvalidFileError(`That isn't ${rule.words}.`);
    let bytes: Buffer;
    const handle = await open(path, 'r').catch(() => { throw new ObjectNotFoundError(); });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new InvalidFileError(`That isn't ${rule.words}.`);
      if (info.size > rule.limit) throw new InvalidFileError(`That file is larger than ${rule.limit / 1024 / 1024} MB.`);
      if (info.size === 0) throw new InvalidFileError('That file is empty.');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (bytes.length > rule.limit || !looksLike(extension, bytes.subarray(0, 84))) throw new InvalidFileError(`That isn't ${rule.words}.`);
    if (kind === 'model') return {object: await this.#addModelFile(id, basename(path), bytes)};
    if (kind === 'scan') return {object: await this.addScan(id, `scan${extension}`, bytes)};
    const name = photoName(path, (await this.get(id)).photos);
    return {object: await this.addPhoto(id, name, bytes, forMessage), photoName: name};
  }

  /** The inputs are complete: start the touch-up. Starting again while it runs changes nothing. */
  start(id: string, captureManifest?: unknown): Promise<StmObject> { return this.#gate(id, () => this.#start(id, captureManifest)); }
  async #start(id: string, captureManifest?: unknown): Promise<StmObject> {
    let object = await this.get(id);
    if (captureManifest !== undefined) {
      const manifest = parseCaptureManifest(captureManifest);
      const images = [...(object.capture ?? [])].sort(), depths = [...(object.captureDepth ?? [])].sort();
      const expectedDepth = manifest.depthRequired ? manifest.images.map(name => name.replace('.heic', '.depth.plist')) : [];
      if (JSON.stringify(images) !== JSON.stringify(manifest.images) || JSON.stringify(depths) !== JSON.stringify(expectedDepth))
        throw new InvalidStateError(CAPTURE_PENDING);
      if (manifest.cameraMetadataRequired && !object.captureCamera)
        throw new InvalidStateError(CAPTURE_CAMERA_PENDING);
      await this.#captureFilesPresent(object);
      const sha256 = captureDigest(object, manifest.depthRequired, manifest.cameraMetadataRequired, manifest.scaleQualificationRequired);
      const same = object.captureCompletion?.sha256 === sha256 && object.captureCompletion.depthRequired === manifest.depthRequired
        && !!object.captureCompletion.cameraMetadataRequired === !!manifest.cameraMetadataRequired
        && !!object.captureCompletion.scaleQualificationRequired === !!manifest.scaleQualificationRequired;
      if (same && ['touching-up', 'needs-closeup', 'ready', 'printing', 'printed'].includes(object.state)) return object;
      if (!same) {
        if (object.state !== 'new' && object.state !== 'failed') throw new InvalidStateError('Wait until the current step finishes.');
        object = await this.#deps.store.update(id, o => ({...o, captureCompletion: {
          version: 1, depthRequired: manifest.depthRequired,
          ...(manifest.cameraMetadataRequired ? {cameraMetadataRequired: true} : {}),
          ...(manifest.scaleQualificationRequired ? {scaleQualificationRequired: true} : {}),
          frameCount: manifest.images.length, sha256, completedAtMs: Date.now(),
        }}));
      }
    }
    // Photos only show what something looks like; without a scan, the description says what to make.
    if (!object.scan && !object.capture?.length && !object.captureDepth?.length && !object.instructions?.trim() && !object.credit?.url && object.state === 'new')
      throw new InvalidStateError('Describe what to make, or add a scan.');
    // A touch-up works from photos; a model with neither photos nor a request has nothing to go on.
    if (object.scan && !object.photos.length && !object.capture?.length && !object.instructions?.trim() && (object.state === 'new' || object.state === 'failed'))
      throw new InvalidStateError("Add photos of it, or describe what you'd like changed.");
    if (object.state === 'touching-up') return object;
    if (object.kind === 'published' && object.current && ['ready', 'needs-closeup'].includes(object.state)) return object;
    // A starter downloads its files at most once per computer: the cache, then ~/Downloads, before any browser work.
    if (object.starterId && !object.current && ['new', 'failed', 'needs-closeup'].includes(object.state)) {
      const starter = this.#starter(object.starterId);
      const found = starter ? await this.#starterOnDisk(starter) : undefined;
      if (starter && found) {
        console.error(`starter ${starter.id}: project ${id} uses the designer’s files already on this computer (${found.from}), no download: ${found.files.map(file => basename(file)).join(', ')}`);
        return this.#changed(await this.#keepPublished(id, found.files, {...(object.credit ? {credit: object.credit} : {})}));
      }
    }
    if (object.state === 'needs-closeup') return this.#pass(object, {});
    if (object.state !== 'new' && object.state !== 'failed') throw new InvalidStateError('This object has already been touched up.');
    return this.#pass(object, {});
  }

  async #captureFilesPresent(object: StmObject): Promise<void> {
    // Names came from the validated manifest or its bound completion marker, never a caller path.
    const names = [...(object.capture ?? []), ...(object.captureDepth ?? [])];
    for (let offset = 0; offset < names.length; offset += 32) {
      const present = await Promise.all(names.slice(offset, offset + 32).map(async name => {
        if (!/^[0-9]{4}\.(heic|jpe?g|png|depth\.plist)$/.test(name)) return false;
        const info = await stat(join(this.dir(object.id), 'capture', name)).catch(() => undefined);
        return info?.isFile() && info.size > 0;
      }));
      if (!present.every(Boolean)) throw new InvalidStateError(CAPTURE_PENDING);
    }
  }

  async #requireCaptureCompletion(object: StmObject): Promise<void> {
    const complete = object.captureCompletion;
    if (!object.captureDepth?.length && !complete) return; // Previously recorded image-only captures.
    if (!complete || complete.version !== 1 || complete.frameCount !== object.capture?.length
        || (object.captureDepth?.length && !complete.depthRequired)
        || (complete.cameraMetadataRequired && !object.captureCamera)
        || complete.sha256 !== captureDigest(object, complete.depthRequired, complete.cameraMetadataRequired, complete.scaleQualificationRequired)) throw new InvalidStateError(CAPTURE_PENDING);
    await this.#captureFilesPresent(object);
  }

  /** Asks for changes; `photos` are files on this Mac added first (the Mac app's drop target). */
  correct(id: string, note: string, photos: string[] = [], photoNames?: string[]): Promise<StmObject> { return this.#gate(id, () => this.#correct(id, note, photos, photoNames)); }
  async #correct(id: string, note: string, photos: string[], photoNames?: string[]): Promise<StmObject> {
    let object = await this.get(id);
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if (!object.current && object.state !== 'failed') throw new InvalidStateError('There is no model to correct yet.');
    const imported: string[] = [];
    for (const path of photos) {
      const receipt = await this.#addFileReceipt(id, 'photos', path, true);
      object = receipt.object;
      if (receipt.photoName) imported.push(receipt.photoName);
    }
    const held = object.messages?.find(message => message.id === object.pendingMessageId && message.text === note.trim());
    // A retry owns its original evidence; later uploads belong to the next message unless explicitly selected.
    const attached = [...new Set([...(photoNames ?? held?.photos ?? object.pendingPhotos ?? []), ...imported])];
    object = await this.#message(object, note.trim(), attached);
    const message = object.messages!.find(item => item.id === object.pendingMessageId)!;
    // Photos can document a successful print too. They must not force a mesh-changing pass.
    if (object.current && !object.question && object.ask?.status !== 'open' && this.#deps.reportsCompletion) {
      // A check that couldn't run is not an answer: companion.log and the person both hear why.
      let unavailable: string | undefined;
      const intent = await this.#deps.reportsCompletion(note).catch((error: unknown) => {
        unavailable = error instanceof Error ? error.message : String(error);
        console.error(`completion check for ${id} could not run: ${unavailable}`);
        return 'unknown' as const;
      });
      if (intent === 'unknown') {
        this.#changed(object);
        await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['pendingFollowup']}});
        throw new InvalidStateError(unavailable === undefined
          ? "Your message is saved, but I couldn't tell whether it marks Done or asks for changes. Try sending it again, or set Status to Done."
          : `Your message is saved, but the AI couldn't check whether it marks Done or asks for changes (${completionCheckReason(unavailable)}). Try sending it again, or set Status to Done.`);
      }
      if (intent === 'works') {
        const previousStatus = projectStatus(object);
        await this.#deps.store.update(id, o => ({...o, pendingFollowup: undefined, pendingMessageId: undefined,
          completion: {messageId: message.id, note: message.text, atMs: message.atMs, previousStatus}}));
        return this.#setStatusNow(id, 'works');
      }
    }
    return this.#pass(object, {note: note.trim(), messageId: message.id, photos: message.photos,
      trigger: message.photos.length ? 'late-photos' : 'changes'});
  }

  /** Record only known attachment ownership. Retry of a held message keeps its identity and timestamp. */
  async #message(object: StmObject, text: string, photos: string[], reusePending = true): Promise<StmObject> {
    if (photos.some(name => !object.photos.includes(name))) throw new InvalidFileError('That photo is not in this project.');
    return this.#deps.store.update(object.id, o => {
      const previous = reusePending ? o.messages?.find(item => item.id === o.pendingMessageId && item.text === text) : undefined;
      const message = previous ? {...previous, photos: [...new Set([...previous.photos, ...photos])]}
        : {id: randomUUID(), text, photos, atMs: Date.now()};
      return {...o, messages: [...(o.messages ?? []).filter(item => item.id !== message.id), message],
        pendingFollowup: text, pendingMessageId: message.id,
        pendingPhotos: (o.pendingPhotos ?? []).filter(name => !photos.includes(name))};
    });
  }

  /** Answers the open Ask: with a photo (uploaded first), Best guess, or the person's own words. */
  answerCloseup(id: string, answer: {bestGuess?: boolean; text?: string; photoNames?: string[]}): Promise<StmObject> { return this.#gate(id, () => this.#answerCloseup(id, answer)); }
  async #answerCloseup(id: string, answer: {bestGuess?: boolean; text?: string; photoNames?: string[]}): Promise<StmObject> {
    // Claim the install before consuming the Ask or its photos. The admitted pass takes its own
    // counted reservation through worker cleanup; this one only covers the answer transaction.
    let release = () => {};
    try { release = this.#deps.printGate?.hold('current') ?? release; }
    catch (error) { if (error instanceof PrinterUpdatingError) throw new InvalidStateError(error.message); throw error; }
    try { return await this.#reservedAnswerCloseup(id, answer); }
    finally { release(); }
  }

  async #reservedAnswerCloseup(id: string, answer: {bestGuess?: boolean; text?: string; photoNames?: string[]}): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'needs-closeup') throw new InvalidStateError('No close-up was asked for.');
    // A reconstruction review is not a close-up: Best Guess, words or photos must not approve it.
    if (object.reconstructionReview) throw new InvalidStateError(RECONSTRUCTION_REVIEW_UPDATE);
    // Carry on with what the asking pass was doing: a correction keeps its note and its model.
    // Only this answer's explicit attachments belong to it. Other pending photos may already
    // be reserved by a correction queued on either client; Best Guess and text claim none.
    const photos = [...new Set(answer.photoNames ?? [])];
    if (!photos.length && !answer.bestGuess && !answer.text?.trim()) throw new InvalidStateError('Choose photos for this answer, answer in words, or use Best Guess. If you already chose photos, update Counterpart and try again.');
    if (photos.some(name => !object.photos.includes(name))) throw new InvalidStateError('That photo is not in this project.');
    const asked = object.passes.at(-1)?.note;
    const said = answer.text?.trim() ? `Answer to "${object.ask?.question ?? object.question?.closeup ?? 'your question'}": ${answer.text.trim()}` : undefined;
    const parts = [asked, said, answer.bestGuess && !asked?.includes(BEST_GUESS_NOTE) ? BEST_GUESS_NOTE : undefined].filter(Boolean);
    if (object.ask) await this.#deps.store.update(id, o => o.ask ? {...o, ask: {...o.ask, status: 'answered'}} : o);
    const updated = await this.#message(await this.get(id), answer.text?.trim() ?? (answer.bestGuess ? 'Use your best guess.' : ''), photos, false);
    const message = updated.messages!.find(item => item.id === updated.pendingMessageId)!;
    return this.#pass(updated, {...(parts.length ? {note: parts.join('\n')} : {}), messageId: message.id, photos: message.photos, trigger: 'ask-answer'});
  }

  /**
   * Deletes the object and its files. Not while a touch-up or print is running.
   * `by` is who asked: the phone's device id, or `mac` for the Mac app. The `project.deleted` event records it.
   */
  delete(id: string, by?: string): Promise<void> { return this.#gate(id, () => this.#delete(id, by)); }
  async #delete(id: string, by?: string): Promise<void> {
    const object = await this.get(id);
    if (object.state === 'touching-up' || object.state === 'printing' || this.#running.has(id))
      throw new InvalidStateError('Wait until the current step finishes.');
    await this.#deps.store.remove(id);
    await this.#emit({id: randomUUID(), type: 'project.deleted', projectId: id, ...(by ? {data: {by: by.slice(0, 128)}} : {}),
      detail: {title: projectTitle(object)}});
  }

  /** Select any retained plate, including after printing another one. Shares the print operation gate. */
  selectPlate(id: string, fileIndex: number, plateIndex: number): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id);
      if (object.state === 'printing' || object.state === 'touching-up') throw new InvalidStateError('Wait until the current step finishes.');
      if (object.print?.uncertain) throw new InvalidStateError('Check the current print on your printer before changing plates.');
      if (!Number.isSafeInteger(fileIndex) || !Number.isSafeInteger(plateIndex) || !projectPlates(object).some(p => p.fileIndex === fileIndex && p.plateIndex === plateIndex))
        throw new InvalidStateError('Choose a plate in this model.');
      return this.#changed(await this.#deps.store.update(id, o => selectingPlate(o, fileIndex, plateIndex)));
    });
  }

  /** Prints the current model through the user's printer MCP. */
  print(id: string, options: PrintOptions = {}): Promise<StmObject> { return this.#gate(id, () => this.#print(id, options)); }
  async #print(id: string, options: PrintOptions): Promise<StmObject> {
    const object = await this.get(id);
    if (options.expectedPlate && !projectPlates(object).some(p => p.selected && p.id === options.expectedPlate))
      throw new InvalidStateError('The selected plate changed. Open Print again for the plate you want.');
    // A 3MF owns its filament assignments; the sheets do not offer a single-spool override.
    // Keep the saved preference for other models, but do not silently apply it here.
    // Layer pauses come only from this request (the sheet shows them): a saved default never adds a hidden stop.
    options = printOptions(object, options, await this.#ownSettingsOn(object, this.#destinationId(object)));
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
    if (object.ask?.status === 'open' && object.ask.type === 'choice') throw new InvalidStateError('Choose the model’s file and plate before printing.');
    this.#publishedSettings(object, options);
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if (object.print?.uncertain && !options.checked) throw new InvalidStateError("The printer may already be printing this. Check the printer, then print again if it isn't.");
    if (options.filament && options.colour) throw new InvalidStateError('Choose one colour.');
    const configured = this.#deps.print;
    if (!configured) throw new InvalidStateError('Printing is not set up on this Mac.');
    const catalog = this.#deps.printerCatalog;
    const destinationId = this.#destinationId(object);
    const destination = catalog?.destinations.find(item => item.id === destinationId);
    const config = destinationId ? catalog?.resolve(destinationId) : undefined;
    if (destinationId && (!destination || !config)) throw new InvalidStateError('That printer is no longer available. Choose another printer.');
    const services = destinationId ? configured.destinations?.get(destinationId) : configured.services;
    if (!services || (config && services.runner.backend !== config.backend)) throw new InvalidStateError('Printing is not set up for this printer.');
    const gated = destination?.id ?? destinationId ?? 'current';
    if (this.#deps.printGate?.updating(gated)) throw new InvalidStateError(new PrinterUpdatingError().message);
    // Keep the exact route and identity for this dispatch and every later confirmation.
    const printing = {...configured, services};
    const printDestination = destination ? {id: destination.id, name: destination.name} : undefined;
    const {store: bundles, relay, runner} = printing.services;
    const recipe = await this.#sliceRecipe(id, object, options, services.selection, runner.backend);
    const {selected, overrides, sliced, chosenTrays} = recipe;
    // Slicing and confirmation can take minutes: re-read the spools at dispatch, so a spool
    // swapped in between can't silently take the mapping (the MCPs check material, not colour).
    const recheckTrays = chosenTrays?.length ? async () => {
      const live = await this.liveFilaments(id);
      const rgb = (colour: string) => colour.slice(0, 7).toUpperCase();
      for (const tray of chosenTrays) if (!live.some(item => item.slot === tray.slot && rgb(item.colour) === rgb(tray.colour)
        && item.material === tray.material && item.filamentId === tray.filamentId && item.destinationId === tray.destinationId))
        throw new InvalidStateError('A chosen spool changed before printing started. Nothing was sent — open the print sheet and check the colours.');
    } : undefined;
    const capabilities = destinationId ? this.#deps.printers?.capabilities(destinationId) : undefined;
    if (capabilities && (('quality' in overrides && !capabilities.quality) || ('strength' in overrides && !capabilities.strength)
        || (overrides.repetitions !== undefined && overrides.repetitions > 1 && !capabilities.copies)
        || (overrides.pauseAtLayers?.length && !capabilities.layerPauses)))
      throw new InvalidStateError(settingsUnsupported(runner.backend, options));
    const settings: PrintSettings = {...(options.quality ? {quality: options.quality} : {}), ...(options.strength ? {strength: options.strength} : {}),
      ...(options.colour ? {colour: options.colour} : {}), ...(options.copies !== undefined ? {copies: options.copies} : {}),
      ...(options.pauseBeforeLayers?.length ? {pauseBeforeLayers: options.pauseBeforeLayers} : {})};
    // What prints is what the sheet showed (Nov 5): the estimate's own sliced file, never a fresh slice nobody saw.
    // The shown file for this model and these settings: a correction or a changed setting since the sheet finds none.
    const stl = await this.#modelBytes(object);
    const shown = options.sliceSha256 ? await this.#shownSlice(id, options.sliceSha256, recipeKey(destinationId ?? 'current', recipe, stl)) : undefined;
    if (!shown) throw new InvalidStateError(options.sliceSha256 && await this.#shownSlice(id, options.sliceSha256)
      ? 'The model or its print settings changed since the preview. Open Print again to see what will print.'
      : 'Open Print to see what will print, then print it from there.');
    if (!shown.shape.previewed) throw new InvalidStateError(shown.shape.previewSupported ? NOTHING_TO_PREVIEW : previewUnavailable(runner.backend));
    const ask = await this.#legacyColourDesign(object) ? LEGACY_COLOUR_ASK : undefined;
    const manifest = await bundles.create({...(object.kind === 'published' || isMultipart(object) ? {model: {bytes: stl, format: isMultipart(object) ? '3mf' as const : 'stl' as const}} : {stl}), prompt: '', backend: runner.backend, ...(selected ? {selection:selected} : {})});
    const printId = randomUUID();
    const plate = selectedPlateIdentity(object);
    const print = {bundleId: manifest.id, printId, ...(plate ? {plate} : {}), ...(printDestination ? {destination: printDestination, destinationId: printDestination.id} : {}),
      ...(Object.keys(settings).length ? {settings} : {})};
    // PRD §8.10: held from here until the dispatch ends, so the printer's MCP isn't updated under it.
    let release: () => void = () => undefined;
    try { release = this.#deps.printGate?.hold(gated) ?? release; }
    catch (error) { throw error instanceof PrinterUpdatingError ? new InvalidStateError(error.message) : error; }
    const started = await this.#deps.store.update(id, o => ({...o, plateProgress: retainedPlateProgress(o), state: 'printing', progress: 'Connecting to your printer service…', print, printConfirmation: undefined, failure: undefined}))
      .catch(error => { release(); throw error; });
    // Only this print's questions: other prints share the relay.
    const unsubscribe = relay.subscribe(pending => {
      if (pending.bundleId === manifest.id) void this.#confirm(id, pending, printing).catch(() => { relay.respond(pending.id, {action: 'cancel'}); });
    });
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const messages: Record<PrintProgress['phase'], string> = {
      connecting:'Connecting to your printer service…', orienting:'Orienting the model for printing…', slicing:'Slicing the model…',
      inspecting:'Checking the sliced print file…', 'slice-ready':'Sliced file saved.', 'checking-printer':'Checking the printer…',
      'requesting-print':'Requesting print. Waiting for the printer service…', accepted:'Print request accepted.',
    };
    const eventBase = {projectId: id, printId, ...(printDestination ? {destinationId: printDestination.id, printerName: printDestination.name} : {})};
    const onProgress = async (update: PrintProgress) => {
      const message = messages[update.phase];
      this.#changed(await this.#deps.store.update(id, o => o.print?.bundleId !== manifest.id || o.state !== 'printing' ? o : ({...o,
        progress:message, print:{...o.print, ...(update.phase === 'slice-ready' ? {sliced:true} : {}),
          ...(update.estimate ? {estimate:update.estimate} : {}), events:[...(o.print.events ?? []), {atMs:Date.now(), message}].slice(-20)},
      })));
      if (update.phase !== 'accepted') await this.#emit({id: randomUUID(), type: 'print.preparing', ...eventBase, data: {stage: message.replace(/…$/, '')}});
    };
    if (recheckTrays) this.#dispatchRechecks.set(id, recheckTrays);
    // Print Again slices again; the printer MCP reuses its own identical slice (PRD §8.0 item 8).
    const work = runner.runBundle(bundles, manifest.id, {print: true, signal: controller.signal, onProgress,
      presliced: {bytes: shown.bytes, extension: shown.extension, ...(shown.slicerWarning ? {slicerWarning: shown.slicerWarning} : {})}, expectedSha256: options.sliceSha256!,
      ...(recheckTrays ? {beforePrint: recheckTrays} : {}), ...(Object.keys(sliced).length ? {slicer: sliced} : {}), ...(ask ? {ask} : {})})
      .then(outcome => this.#dispatched(id, manifest.id, printDestination?.id ?? destinationId, (outcome as {result?: {dispatch?: {jobName?: string; taskId?: string; fileBase?: string}}} | undefined)?.result?.dispatch),
        async error => {
          const status = (await bundles.read(manifest.id).catch(() => undefined))?.status;
          // Once the printer has the job it is printing, whatever went wrong afterwards (as the phone's print route does).
          if (error instanceof DispatchedPrintError || status === 'printed') return this.#dispatched(id, manifest.id, printDestination?.id ?? destinationId, undefined);
          // It may have reached the printer: never send it again by itself. The phone is told the project changed
          // (it reads the failure), never that the printer didn't start it.
          if (status === 'uncertain') {
            const unclear = await this.#deps.store.update(id, o => ({...o, state: 'failed', printConfirmation: undefined, progress: undefined, failure: error instanceof PrinterMcpError && error.detail ? `Printer service: ${error.detail} Counterpart could not confirm a print start. Check the printer before trying again.` : UNCERTAIN, print: {...o.print!, uncertain: true}}));
            await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['print']}});
            return unclear;
          }
          if (this.#cancelledPrints.has(id) && !this.#recheckFailures.has(id)) return this.#deps.store.update(id, o => ({...o, state: 'ready', progress: undefined, printConfirmation: undefined, failure: undefined}));
          // Refused before anything reached the printer (review item 23): the phone hears it, with the reason.
          const refused = async (state: 'failed' | 'ready', failure: string) => {
            const updated = await this.#deps.store.update(id, o => ({...o, state, progress: undefined, printConfirmation: undefined, failure}));
            await this.#emit({id: randomUUID(), type: 'print.not-started', ...eventBase, detail: {reason: failure}});
            return updated;
          };
          // A spool changed under the waiting question: a safety-check refusal like the
          // dispatch one, so it ends the Live Activity instead of cancelling quietly.
          const recheckFailure = this.#recheckFailures.get(id);
          if (recheckFailure) return refused('failed', recheckFailure);
          // The relay's own expiry and ours share expiresAtMs, and a Node timer can fire a millisecond before
          // Date.now() reaches it: an unanswered question (still in #confirmations) at its deadline timed out.
          if (this.#expiredConfirmations.has(id) || (this.#confirmations.get(id)?.pending.expiresAtMs ?? Infinity) <= Date.now() + CONFIRMATION_EXPIRY_SLACK_MS)
            return refused('failed', 'Printer confirmation timed out; no print was sent. Press Print to try again.');
          // The person answered Print's own question: nothing was sliced or sent. "Make it again" starts that pass once this print ends.
          if (error instanceof PrinterMcpError && error.code === 'print-choice') {
            if (error.detail === 'remake') this.#remakes.add(id);
            return refused('ready', error.detail === 'remake' ? 'Not printed. Making it again in colour.' : 'Not printed.');
          }
          if (error instanceof PrinterMcpError && error.code === 'print-settings-unsupported') return refused('ready', settingsUnsupported(runner.backend, {...options, supports: !!object.current?.supports}));
          return refused('failed', error instanceof PrinterMcpError && error.detail ? error.detail : error instanceof Error ? error.message : String(error));
        })
      .then(o => this.#changed(o))
      .finally(() => {
        release();
        unsubscribe(); this.#running.delete(id); this.#controllers.delete(id);
        clearTimeout(this.#confirmations.get(id)?.timer); this.#confirmations.delete(id);
        this.#dispatchRechecks.delete(id);
        this.#recheckFailures.delete(id);
        this.#cancelledPrints.delete(id);
        this.#expiredConfirmations.delete(id);
        if (this.#remakes.delete(id)) void this.correct(id, REMAKE_IN_COLOUR).catch(async error => this.#changed(await this.#deps.store.update(id, o =>
          ({...o, failure: `Couldn't start making it again: ${error instanceof Error ? error.message : String(error)}`}))));
      });
    this.#running.set(id, work);
    return this.#changed(started);
  }

  /** The print sheet's colour, as the MCP's own selection and slicing options (PRD §8.5 colour v1). */
  async #colour(id: string, options: PrintOptions, selection: PrinterSelection | undefined, backend: PrinterHandoffConfig['backend'], destination?: {destinationId?: string})
    : Promise<{selection?: PrinterSelection; slicer?: PrinterSlicer; chosenTrays?: LiveFilament[]}> {
    const object = await this.get(id);
    // Per-colour choices for a model that is no longer a multi-part 3MF are stale, never ignored.
    if (options.filaments?.length && !isMultipart(object))
      throw new InvalidStateError('The model changed since you chose its spools. Reopen the print sheet and check the colours.');
    if (isMultipart(object)) {
      // A 3MF owns its per-part filaments: map each to a spool, never one spool for the whole model.
      const multipart = await this.#multipartColour(object, options, selection, backend, destination);
      if (multipart) return multipart;
    }
    if (options.filament) {
      const choice = options.filament;
      const live = (await this.liveFilaments(id, destination)).find(item => item.slot === choice.slot && item.colour === choice.colour
        && item.material === choice.material && item.filamentId === choice.filamentId && item.destinationId === choice.destinationId);
      if (!live) throw new InvalidStateError('The chosen filament changed. Choose a current spool and try again.');
      if (!live.profile) throw new InvalidStateError('That spool has no slicing profile on this Mac. Choose another spool.');
      return {selection: {...selection, material:live.material, useAms:live.slot !== 254 && live.slot !== 255, amsSlots:[live.slot], amsMapping:undefined, autoMatchAms:false},
        slicer: {loadFilaments:live.profile, filamentColours:live.colour}};
    }
    const colour = options.colour;
    if (!colour) return {...(selection ? {selection} : {})};
    // Trays are the MCP's to report (counterpart_printer_info `filaments: "ams"`), not one package's.
    const destinationId = destination ? destination.destinationId : this.#destinationId(object);
    const ams = !!destinationId && this.#deps.printers?.capabilities(destinationId)?.filaments === 'ams';
    if ('auto' in colour) return ams
      ? {selection: {...selection, useAms: true, autoMatchAms: true, amsSlots: undefined, amsMapping: undefined}} : {...(selection ? {selection} : {})};
    if ('material' in colour) {
      // "What's loaded?" (PRD §8.4–8.5): the person says which material is in the printer.
      const material = colour.material.trim();
      if (ams) {
        const live = await this.liveFilaments(id, destination).catch(() => [] as LiveFilament[]);
        const match = live.find(item => item.profile && item.material.toLowerCase() === material.toLowerCase());
        // A loaded spool of that material: print from it with its own profile.
        if (match) return {selection: {...selection, material: match.material, useAms: match.slot !== 254 && match.slot !== 255,
          amsSlots: [match.slot], amsMapping: undefined, autoMatchAms: false}, slicer: {loadFilaments: match.profile!, filamentColours: match.colour}};
        // No spool reports it (the external spool counts once the printer knows its type): there is no profile to
        // slice it with, and slicing with the preset's filament would print the wrong material's settings.
        throw new InvalidStateError(`The printer doesn't report a ${material} spool. Set the external spool to ${material} on the printer, or load ${material} in the AMS, then try again.`);
      }
      // A single-spool printer: sliced with the profile its filament report gives for that material. Without one,
      // only the configured material (what the MCP's own preset is for) can be declared without a profile.
      const profile = await this.#genericProfile(id, material);
      if (profile) return {selection: {...selection, material}, slicer: {loadFilaments: profile}};
      const configured = selection?.material?.trim();
      if (configured && configured.toLowerCase() === material.toLowerCase()) return {selection: {...selection, material: configured}};
      throw new InvalidStateError(`${packageLabel(backend)} doesn't give a slicing profile for ${material} on this printer, so Counterpart can't slice for it. ${configured ? `Choose ${configured}, the configured material, or update` : 'Update'} ${packageLabel(backend)}.`);
    }
    const live = await this.liveFilaments(id, destination);
    if ('external' in colour) {
      const tray = live.find(item => item.slot === 254 || item.slot === 255);
      return {selection: {...selection, useAms: false, amsSlots: undefined, amsMapping: undefined, autoMatchAms: false, ...(tray ? {material: tray.material} : {})},
        ...(tray?.profile ? {slicer: {loadFilaments: tray.profile, filamentColours: tray.colour}} : {})};
    }
    const tray = live.find(item => item.slot === colour.amsSlot);
    if (!tray) throw new InvalidStateError('That AMS slot is empty now. Choose a loaded spool and try again.');
    if (!tray.profile) throw new InvalidStateError('That spool has no slicing profile on this Mac. Choose another spool.');
    return {selection: {...selection, material: tray.material, useAms: true, amsSlots: [tray.slot], amsMapping: undefined, autoMatchAms: false},
      slicer: {loadFilaments: tray.profile, filamentColours: tray.colour}};
  }

  /**
   * The printer MCP accepted the print. "Printed" now means printed (PRD §8.5):
   * when the destination can report this job, the object stays `printing` and
   * the monitor sets `printed` when the job finishes. A destination that can't
   * report jobs (an older mcp-3D-printer-server) ends here, as before.
   */
  async #dispatched(id: string, bundleId: string, destinationId: string | undefined, dispatch: {jobName?: string; taskId?: string; fileBase?: string} | undefined): Promise<StmObject> {
    const session = destinationId ? this.#deps.printers?.session(destinationId) : undefined;
    // The route is the MCP's own setting; it says whether this print went to Bambu Connect.
    const route = session ? await readPrintRoute(session).catch(() => undefined) : undefined;
    const reports = !!session && session.hasTool('counterpart_print_progress');
    const identified = !!(dispatch?.jobName || dispatch?.taskId);
    // Bambu Connect only opens the job on the Mac: the person presses Print there.
    const bambuConnect = route?.mode === 'bambu_connect';
    // Some routes (Bambu's pre-sliced .gcode.3mf, X2D native, BambuNetwork) return no identity: a job
    // named after our file within the start window is adopted; otherwise the print ends "sent".
    const watchable = !!session && reports && !bambuConnect && (identified || !!dispatch?.fileBase);
    const dispatchedAt = new Date().toISOString();
    if (!watchable || !session) {
      // PRD §2.6: no evidence, no "printed". The printer has it; Counterpart can't follow it.
      const sent = await this.#deps.store.update(id, o => o.print?.bundleId !== bundleId ? o : ({...o, state: 'sent', progress: undefined, printConfirmation: undefined,
        failure: undefined, print: {...o.print, dispatchedAt, uncertain: true, ...(dispatch?.jobName ? {jobName: dispatch.jobName} : {}), ...(dispatch?.taskId ? {taskId: dispatch.taskId} : {}),
          ...(bambuConnect ? {sentVia: 'bambu-connect' as const} : {})}}));
      if (sent.print?.printId) await this.#emit({id: randomUUID(), type: 'print.sent', projectId: id, printId: sent.print.printId,
        ...(sent.print.destination ? {destinationId: sent.print.destination.id, printerName: sent.print.destination.name} : {}), ...(bambuConnect ? {detail: {message: 'bambu-connect'}} : {})});
      return sent;
    }
    const updated = await this.#deps.store.update(id, o => o.print?.bundleId !== bundleId ? o : ({...o, state: 'printing', progress: undefined, printConfirmation: undefined,
      print: {...o.print, dispatchedAt, ...(dispatch?.jobName ? {jobName: dispatch.jobName} : {}), ...(dispatch?.taskId ? {taskId: dispatch.taskId} : {}),
        ...(!identified && dispatch?.fileBase ? {fileBase: dispatch.fileBase} : {}),
        monitor: {phase: 'starting', startedAt: dispatchedAt, milestonesSent: [], firstLayerSent: false}}}));
    this.#watch(updated, session);
    return updated;
  }

  /** Starts (or, after a restart, resumes) the monitor of a dispatched print. */
  #watch(object: StmObject, session: PrinterSession): void {
    const print = object.print;
    // One monitor per print, not per project: the last print's may still be sending its final frame.
    if (!print?.printId || !print.dispatchedAt || !print.monitor || print.monitor.phase === 'ended' || this.#monitors.has(print.printId) || this.#closed) return;
    const id = object.id, printId = print.printId, destinationId = print.destinationId ?? print.destination?.id ?? 'current';
    const printerName = print.destination?.name ?? 'Your printer';
    const target: MonitorTarget = {projectId: id, printId, destinationId, printerName, dispatchedAtMs: Date.parse(print.dispatchedAt),
      ...(print.taskId ? {taskId: print.taskId} : {}), ...(print.jobName ? {jobName: print.jobName} : {}), ...(print.fileBase ? {fileBase: print.fileBase} : {}),
      ...(print.estimate ? {estimate: print.estimate} : {})};
    const ours = (o: StmObject) => o.print?.printId === printId;
    const controller = new AbortController();
    const release = session.hold();
    const runner = new PrintMonitorRunner(target, {
      ...(this.#deps.monitorClock ? {clock: this.#deps.monitorClock} : {}),
      read: async signal => {
        try {
          const report = await readPrintReport(session, {signal, failFast: true});
          this.#deps.printers?.record(destinationId, report);
          return report;
        } catch (error) { this.#deps.printers?.record(destinationId, undefined, true); throw error; }
      },
      frame: async (eventId, signal) => {
        const frame = await this.#frame(destinationId, session, signal);
        if (!frame) return undefined;
        const relative = join('prints', printId, 'frames', `${eventId}.jpg`);
        await mkdir(join(this.dir(id), 'prints', printId, 'frames'), {recursive: true});
        await writeFile(join(this.dir(id), relative), frame.bytes, {mode: 0o600});
        return relative;
      },
      milestones: () => milestonesFor(this.#deps.settings?.current().milestones ?? '50'),
      adopted: async jobName => { this.#changed(await this.#deps.store.update(id, o => ours(o) ? {...o, print: {...o.print!, jobName}} : o)); },
      save: async (monitor, live) => { this.#changed(await this.#deps.store.update(id, o => ours(o) ? {...o, print: {...o.print!, monitor, ...(live ? {live} : {})}} : o)); },
      end: async (end, report) => { this.#changed(await this.#deps.store.update(id, o => ours(o) ? this.#ended(o, end, report) : o)); },
      emit: async draft => {
        const fixed = draft.type === 'print.milestone' && draft.data?.progress !== 50 ? `${draft.data?.progress}% done.` : PRINT_LOG[draft.type];
        if (fixed) this.#changed(await this.#deps.store.update(id, o => {
          if (!ours(o)) return o;
          const events = o.print!.events ?? [];
          // Nov 3: Bambu Handy resumed a pick Counterpart couldn't; "Printing again." read as if Counterpart had.
          const line = draft.type === 'print.resumed' && !resumedHere(events) ? RESUMED_ELSEWHERE : fixed;
          return {...o, print: {...o.print!, events: [...events, {atMs: Date.now(), message: line}].slice(-20)}};
        }));
        await this.#emit(draft);
      },
    }, print.monitor);
    const done = runner.run(controller.signal).catch(() => undefined).then(() => undefined).finally(() => {
      release();
      if (this.#monitors.get(printId)?.runner === runner) this.#monitors.delete(printId);
    });
    this.#monitors.set(printId, {runner, controller, done});
  }

  /** The object after its print's monitor ended. */
  #ended(o: StmObject, end: MonitorEnd, report: PrintReport | undefined): StmObject {
    const base = {...o, progress: undefined, printConfirmation: undefined};
    // The problem that stopped it: an error over a warning, in the printer's own words.
    const stopped = report?.problems.find(problem => problem.severity === 'fatal' || problem.severity === 'error') ?? report?.problems[0];
    const context = {title: projectTitle(o), printer: o.print?.destination?.name ?? 'Your printer', ...(stopped ? {problem: stopped} : {})};
    switch (end) {
      // A Done project printed again is still Done (PRD §5.4): the part is known to work.
      // A new print after changes asks "Did it fit?" again: needs-changes ends with it (KAN-217).
      case 'done': {
        const {outcome, ...rest} = base;
        return outcome === 'works' ? {...base, state: 'confirmed', failure: undefined} : {...rest, state: 'printed', failure: undefined};
      }
      case 'cancelled': return {...base, state: o.outcome === 'works' ? 'confirmed' : 'ready', failure: undefined};
      case 'not-started': return {...base, state: 'failed', failure: printEndFailure('not-started', context), print: {...o.print!, uncertain: undefined}};
      case 'replaced': return {...base, state: 'failed', failure: printEndFailure('replaced', context)};
      case 'sent': return {...base, state: 'sent', failure: undefined, print: {...o.print!, uncertain: true}};
      case 'failed': return {...base, state: 'failed', failure: printEndFailure('failed', context)};
    }
  }

  /** After a restart: resume watching dispatched prints; a print still being prepared was interrupted. */
  async resume(): Promise<void> {
    for (let object of await this.#deps.store.list()) {
      // A printer's question lives only as long as the process that asked it: none survives a restart.
      if (object.printConfirmation) object = this.#changed(await this.#deps.store.update(object.id, o => ({...o, printConfirmation: undefined})));
      if (object.state !== 'printing' || !object.print) continue;
      const monitor = object.print.monitor;
      const destinationId = object.print.destinationId ?? object.print.destination?.id;
      const session = destinationId ? this.#deps.printers?.session(destinationId) : undefined;
      if (monitor && monitor.phase !== 'ended' && session) {
        await session.connect({failFast: true}).catch(() => undefined);
        this.#watch(object, session);
        continue;
      }
      if (monitor && monitor.phase !== 'ended') continue; // Its printer isn't configured now: leave it as it was.
      const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
      const status = (await services?.store.read(object.print.bundleId).catch(() => undefined))?.status;
      const reached = status === 'uncertain' || status === 'printed';
      this.#changed(await this.#deps.store.update(object.id, o => ({...o, state: 'failed', progress: undefined, printConfirmation: undefined,
        failure: reached ? UNCERTAIN : 'interrupted when your Mac restarted the app', ...(reached ? {print: {...o.print!, uncertain: true}} : {})})));
    }
  }

  async #emit(draft: EventDraft): Promise<void> {
    if (draft.projectId && draft.type.startsWith('print.') &&
        !['print.confirm', 'print.paused', 'print.failed', 'print.not-started', 'print.unreachable', 'print.sent'].includes(draft.type)) {
      const object = await this.#deps.store.get(draft.projectId).catch(() => undefined);
      if (object?.preferences?.notifications === 'problems') draft = {...draft, notify: 'none'};
    }
    await this.#deps.events?.emit(draft).catch(() => undefined);
  }

  async #frame(destinationId: string, session: PrinterSession, signal?: AbortSignal): Promise<CameraFrame | undefined> {
    const camera = this.#deps.camera;
    if (!camera || signal?.aborted) return undefined;
    return camera.frame(destinationId, session, {model: session.config.selection?.model}).catch(() => undefined);
  }

  /** PRD §8.10: a print is being prepared or monitored on this printer, so its MCP isn't updated now. */
  async printerBusy(destinationId: string): Promise<boolean> {
    const canonical = this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId;
    for (const object of await this.#deps.store.list()) {
      if (object.state !== 'printing') continue;
      const target = object.print?.destinationId ?? object.print?.destination?.id ?? this.#destinationId(object);
      if (target && (this.#deps.printerCatalog?.canonical(target) ?? target) === canonical) return true;
    }
    return false;
  }

  /** Reading a project does not imply that someone is watching its printer camera. */
  async view(id: string): Promise<StmObject> { return this.get(id); }

  /** The camera of the project's printer (the one printing it, else its chosen one). */
  async camera(id: string, options: {size?: CameraSize} = {}): Promise<CameraFrame> {
    const object = await this.get(id);
    const destinationId = object.state === 'printing' ? object.print?.destinationId ?? object.print?.destination?.id ?? this.#destinationId(object) : this.#destinationId(object);
    if (!destinationId) throw new CameraUnavailableError('no-camera');
    return this.printerCamera(destinationId, options);
  }
  async cameraStream(id: string, options: {size?: CameraSize; signal: AbortSignal}): Promise<AsyncGenerator<CameraFrame>> {
    const object = await this.get(id);
    const destinationId = object.state === 'printing' ? object.print?.destinationId ?? object.print?.destination?.id ?? this.#destinationId(object) : this.#destinationId(object);
    if (!destinationId) throw new CameraUnavailableError('no-camera');
    return this.printerCameraStream(destinationId, options);
  }
  async printerCameraStream(destinationId: string, options: {size?: CameraSize; signal: AbortSignal}): Promise<AsyncGenerator<CameraFrame>> {
    const session = this.#deps.printers?.session(destinationId), camera = this.#deps.camera;
    if (!session || !camera) throw new CameraUnavailableError('no-camera');
    return camera.watch(this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId, session, {model: session.config.selection?.model, ...options});
  }
  /**
   * Settings -> Printers: how the destination's MCP reaches the printer (local network or Bambu
   * Cloud), and changing it. The MCP keeps the setting; Counterpart holds no copy. Undefined when
   * the destination has no such choice (mcp-3D-printer-server, older bambu-printer-mcp).
   */
  async printRoute(destinationId: string, route?: PrintRoute['route']): Promise<PrintRoute | undefined> {
    const session = this.#deps.printers?.session(destinationId);
    if (!session) throw new ObjectNotFoundError();
    const canonical = this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId;
    const destination = this.#deps.printerCatalog?.destinations.find(item => item.id === canonical);
    const ids = [...new Set([destinationId, canonical, ...(destination?.mcps?.map(item => item.destinationId) ?? [])])];
    const gate = this.#deps.printGate;
    const busy = () => new InvalidStateError('This printer is printing or preparing work. Change its connection when that finishes.');
    // Reserve before any await: a new dispatch cannot enter between the check and the MCP mutation.
    if (route && gate && !gate.beginUpdate(ids)) throw busy();
    try {
      if (route && (await this.printerBusy(destinationId) || await this.#deps.printers?.printing(destinationId))) {
        throw busy();
      }
      await session.connect();
      if (!session.hasTool('counterpart_print_route')) return undefined;
      return route ? await setPrintRoute(session, route) : await readPrintRoute(session);
    } finally {
      if (route) gate?.endUpdate(ids);
    }
  }

  async printerCamera(destinationId: string, options: {size?: CameraSize} = {}): Promise<CameraFrame> {
    const session = this.#deps.printers?.session(destinationId), camera = this.#deps.camera;
    if (!session || !camera) throw new CameraUnavailableError('no-camera');
    return camera.frame(this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId, session, {model: session.config.selection?.model, view: true, ...options});
  }

  /** Pause, resume or stop this project's print, through the destination's mutex (PRD §8.6). */
  /**
   * Not under the object's gate: the printer MCP may ask its own confirmation
   * during the call, and answering it goes through that gate. A second control while
   * one still waits is refused, never queued behind its question (the app's request
   * would end long before a queued control could run).
   */
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<StmObject> {
    if (this.#closed) throw new InvalidStateError('Counterpart is shutting down on this Mac.');
    if (this.#controlling.has(id)) throw new InvalidStateError('The printer is still answering the last Pause, Resume or Stop. Answer its question or wait, then try again.');
    this.#controlling.add(id);
    try { return await this.#control(id, action); } finally { this.#controlling.delete(id); }
  }
  async #control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<StmObject> {
    const object = await this.get(id);
    const print = object.print;
    if (object.state !== 'printing' || !print?.dispatchedAt || !print.monitor || print.monitor.phase === 'ended')
      throw new InvalidStateError(action === 'cancel' ? 'Nothing of this project is printing.' : `There is no print to ${action}.`);
    const destinationId = print.destinationId ?? print.destination?.id ?? 'current';
    const session = this.#deps.printers?.session(destinationId);
    const services = this.#deps.print?.destinations?.get(this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId) ?? this.#deps.print?.services;
    const tool = {pause: 'pause_print', resume: 'resume_print', cancel: 'cancel_print'}[action];
    if (!session || !services) throw new InvalidStateError('That printer is no longer available.');
    await session.connect({failFast: true}).catch(() => undefined);
    if (!session.hasTool(tool)) throw new InvalidStateError(`Update ${packageLabel(session.backend)} in Settings → Printers to ${action === 'cancel' ? 'stop' : action} prints from Counterpart.`);
    // The printer MCP's own confirmation, if it asks, is relayed like Print's.
    const printing = {...this.#deps.print!, services};
    const unsubscribe = services.relay.subscribe(pending => {
      if (pending.bundleId === print.bundleId) void this.#confirm(id, pending, printing).catch(() => { services.relay.respond(pending.id, {action: 'cancel'}); });
    });
    const target = {...(print.taskId ? {taskId: print.taskId} : {}), ...(print.jobName ? {jobName: print.jobName} : {})};
    let notOurs = false;
    try {
      const properties = (session.getTool(tool).inputSchema as {properties?: Record<string, unknown>}).properties;
      // The server controls a print over the connection it printed with (its own route setting).
      const args = Object.fromEntries(Object.entries(routeArgs(session.config)).filter(([key, value]) => value !== undefined && (!properties || Object.hasOwn(properties, key))));
      await session.exclusive(async () => {
        // The printer's controls act on whatever it is printing now: make sure that is still this project.
        const report = await readPrintReport(session, {failFast: true});
        if (matchJob(target, report) !== 'ours' || !['preparing', 'printing', 'paused'].includes(report.state)) { notOurs = true; return; }
        // The MCP may ask a person first (a Resume it can't verify does): wait as long as that question stays open.
        const result = await session.call(tool, args, {held: true, elicitationContext: {bundleId: print.bundleId},
          timeoutMs: timeoutsFor(session.config).elicitationMs + 120_000});
        if (result.isError) throw new PrinterMcpError('tool-failed', undefined, (result.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join(' ').trim().slice(0, 300) || undefined);
      });
    } catch (error) {
      const detail = error instanceof PrinterMcpError ? error.detail : undefined;
      const message = detail ? `The printer didn't ${action === 'cancel' ? 'stop' : action}: ${detail}` : `The printer didn't ${action === 'cancel' ? 'stop' : action}. Check it, then try again.`;
      // Kept, not only shown: the project's activity and companion.log say what was refused and why.
      console.error(`print control ${action} refused for ${id}: ${message}${detail ? '' : ` (${error instanceof Error ? error.message : String(error)})`}`);
      // A question this control asked ends with it: never leave it on the project, where it hides the controls.
      await this.#deps.store.update(id, o => o.print ? {...o, printConfirmation: undefined, print: {...o.print, events: [...(o.print.events ?? []), {atMs: Date.now(), message: message.slice(0, 400)}].slice(-20)}} : o)
        .then(updated => this.#changed(updated)).catch(() => undefined);
      throw new InvalidStateError(message);
    } finally {
      unsubscribe();
      clearTimeout(this.#confirmations.get(id)?.timer); this.#confirmations.delete(id);
    }
    if (notOurs) throw new InvalidStateError(`The printer isn't printing ${projectTitle(object)} any more, so nothing was sent.`);
    const line = {pause: 'Pause sent.', resume: 'Resume sent.', cancel: 'Stop sent.'}[action];
    return this.#changed(await this.#deps.store.update(id, o => ({...o, printConfirmation: undefined,
      ...(o.print ? {print: {...o.print, events: [...(o.print.events ?? []), {atMs: Date.now(), message: line}].slice(-20)}} : {})})));
  }

  /**
   * A design made in several colours before Counterpart kept each colour as its own part (#293): its model is the
   * merged STL, while the pass that made that STL also left a 3MF whose parts print on different filaments or
   * colours. Only that pass counts (matched by the STL's bytes), so a later one-colour redesign never asks, and an
   * assembly of parts on one filament is an ordinary one-colour model. Nothing is adopted or changed here.
   */
  async #legacyColourDesign(object: StmObject): Promise<boolean> {
    if (!object.current || isMultipart(object) || object.kind === 'published') return false;
    const current = await readFile(join(this.#deps.store.dir(object.id), object.current.model)).catch(() => undefined);
    if (!current) return false;
    const digest = createHash('sha256').update(current).digest('hex');
    for (const pass of [...object.passes].reverse()) {
      if (!pass.dir) continue;
      const out = join(isAbsolute(pass.dir) ? pass.dir : join(this.#deps.store.dir(object.id), pass.dir), 'out');
      const made = await readFile(join(out, 'touched.stl')).catch(() => undefined);
      if (!made || createHash('sha256').update(made).digest('hex') !== digest) continue;
      for (const name of await readdir(out).catch(() => [] as string[])) {
        if (extname(name).toLowerCase() !== '.3mf') continue;
        const info = await stat(join(out, name)).catch(() => undefined);
        if (!info?.isFile() || info.size > 64 * 1024 * 1024) continue;
        const filaments = modelFilaments(await readFile(join(out, name)).catch(() => Buffer.alloc(0)));
        if (new Set(filaments.map(filament => filament.index)).size > 1
          || new Set(filaments.flatMap(filament => filament.colour ? [filament.colour] : [])).size > 1) return true;
      }
      return false;
    }
    return false;
  }

  async #modelBytes(object: StmObject): Promise<Buffer> {
    const path = object.current!.model;
    const bytes = await readModelFile(join(this.dir(object.id), path));
    const receipt = object.files?.receipts?.find(file => file.path === path);
    if (receipt && (receipt.byteLength !== bytes.length || receipt.sha256 !== createHash('sha256').update(bytes).digest('hex')))
      throw new InvalidFileError('The saved original changed. Share the designer’s file again before printing.');
    return bytes;
  }

  #publishedSettings(object: StmObject, options: {quality?: string; strength?: string; copies?: number}) {
    if (object.publishedSelection?.sliced && ((options.quality && options.quality !== 'standard') || (options.strength && options.strength !== 'standard') || (options.copies ?? 1) !== 1))
      throw new InvalidStateError('This file is already sliced. Share the designer’s editable 3MF to change quality, strength or copies.');
  }

  readonly #estimates2 = new Map<string, Promise<PrintEstimate>>();

  /**
   * The sliced file a print sheet showed (its estimate and preview), kept so Print sends exactly it
   * (`<project>/slices/shown/<sha256>`), with one record per recipe (`<sha256>.<recipe>.json`): two recipes can slice
   * to the same bytes, such as an already-sliced 3MF for two printers. `shape` is what the sheet chose.
   */
  async #keepShownSlice(id: string, file: {bytes: Buffer; extension: string; sha256: string; slicerWarning?: string}, shape: ShownSliceShape): Promise<string> {
    const directory = join(this.#deps.store.dir(id), 'slices', 'shown');
    await mkdir(directory, {recursive: true});
    const extension = /^\.(3mf|gcode)$/i.test(file.extension) ? file.extension.toLowerCase() : '.3mf';
    // The record first, so a concurrent sweep never takes the bytes it names.
    await writeFile(join(directory, `${file.sha256}.${shape.recipe}.json`), JSON.stringify({extension, shape, ...(file.slicerWarning ? {slicerWarning: file.slicerWarning} : {})}), {mode: 0o600});
    await writeFile(join(directory, `${file.sha256}${extension}`), file.bytes, {mode: 0o600});
    // Keep the last few sheets' records only, and the files they name.
    const entries = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    if (entries.length > 8) {
      const dated = await Promise.all(entries.map(async name => ({name, at: (await stat(join(directory, name)).catch(() => undefined))?.mtimeMs ?? 0})));
      for (const {name} of dated.sort((a, b) => a.at - b.at).slice(0, entries.length - 8)) await rm(join(directory, name), {force: true});
      const left = await readdir(directory).catch(() => [] as string[]);
      const named = new Set(left.filter(name => name.endsWith('.json')).map(name => name.slice(0, 64)));
      for (const other of left) if (!named.has(other.slice(0, 64))) await rm(join(directory, other), {force: true});
    }
    return file.sha256;
  }
  /** The shown file and its record for `recipe`; without a recipe, any record of that file. */
  async #shownSlice(id: string, sha256: string, recipe?: string): Promise<{bytes: Buffer; extension: string; shape: ShownSliceShape; slicerWarning?: string} | undefined> {
    if (!/^[0-9a-f]{64}$/.test(sha256) || (recipe !== undefined && !/^[0-9a-f]{64}$/.test(recipe))) return undefined;
    const directory = join(this.#deps.store.dir(id), 'slices', 'shown');
    const name = recipe ? `${sha256}.${recipe}.json`
      : (await readdir(directory).catch(() => [] as string[])).find(entry => entry.startsWith(`${sha256}.`) && entry.endsWith('.json'));
    if (!name) return undefined;
    const record = await readFile(join(directory, name), 'utf8').then(text => JSON.parse(text) as {extension: string; shape: ShownSliceShape; slicerWarning?: string}, () => undefined);
    if (!record || !/^\.(3mf|gcode)$/.test(record.extension)) return undefined;
    const bytes = await readFile(join(directory, `${sha256}${record.extension}`)).catch(() => undefined);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined;
    return {bytes, extension: record.extension, shape: record.shape, ...(record.slicerWarning ? {slicerWarning: record.slicerWarning} : {})};
  }
  /**
   * A kept 3MF's plates and their pictures from the default printer's MCP (`list_3mf_plates`). Undefined when no
   * printer MCP is there to ask; an MCP without the tool throws its Update sentence (PrinterMcpError `plates-unsupported`).
   */
  async #mcpPlates(dir: string, relative: string, sha256: string, options: {needed?: boolean; destinationId?: string} = {}): Promise<ModelFileInfo['plates'] | undefined> {
    // The printer the project prints on (the catalog's default for a new file), through the MCP it uses now.
    const destinationId = options.destinationId ?? this.#deps.printerCatalog?.defaultDestinationId;
    const canonical = destinationId === undefined ? undefined : this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId;
    const runner = (canonical ? this.#deps.print?.destinations?.get(canonical) : undefined)?.runner ?? this.#deps.print?.services?.runner;
    if (!runner?.modelPlates) return undefined;
    let listed;
    try { listed = await runner.modelPlates({modelPath: join(dir, relative), signal: AbortSignal.timeout(60_000)}); }
    catch (error) {
      // An MCP to update says so where the plates are needed (an estimate, a print); an import keeps the file and
      // lists its plates later, as it does with no printer to reach yet.
      if (options.needed && error instanceof PrinterMcpError && error.code === 'plates-unsupported') throw new InvalidStateError(error.detail ?? 'Update your printer service in Settings → Printers.');
      return undefined;
    }
    const plates: ModelFileInfo['plates'] = [];
    for (const plate of listed.plates) {
      let thumbnail: string | undefined;
      if (plate.thumbnail) {
        await mkdir(join(dir, 'renders'), {recursive: true});
        thumbnail = join('renders', `${sha256}-${plate.index}.png`);
        await writeFile(join(dir, thumbnail), plate.thumbnail, {mode: 0o600});
      }
      plates.push({index: plate.index, name: plate.name, objects: plate.objects, sliced: plate.sliced, ...(thumbnail ? {thumbnail} : {})});
    }
    return plates;
  }

  /** A project's 3MFs kept before a printer MCP could list their plates, listed now (or its Update sentence). */
  async #listPlates(id: string, destinationId?: string): Promise<void> {
    const object = await this.get(id);
    const pending = (object.files?.receipts ?? []).filter(receipt => receipt.platesListed === false);
    if (!pending.length) return;
    const dir = this.#deps.store.dir(id);
    const listed = new Map<string, ModelFileInfo['plates']>();
    for (const receipt of pending) {
      // Only the file being printed needs its plates now; another one stays pending if this MCP can't list it.
      const plates = await this.#mcpPlates(dir, receipt.path, receipt.sha256, {needed: receipt.path === object.current?.model, destinationId: destinationId ?? this.#destinationId(object)});
      if (plates) listed.set(receipt.sha256, plates);
    }
    if (!listed.size) return;
    this.#changed(await this.#deps.store.update(id, o => {
      const receipts = (o.files?.receipts ?? []).map(({platesListed, ...receipt}) => listed.has(receipt.sha256)
        ? {...receipt, plates: listed.get(receipt.sha256)!} : {...receipt, ...(platesListed === false ? {platesListed} : {})});
      const selected = o.publishedSelection && receipts[o.publishedSelection.fileIndex];
      const plate = selected && listed.has(selected.sha256) ? (selected.plates.find(item => item.index === o.publishedSelection!.plateIndex) ?? selected.plates[0]) : undefined;
      return {...o, files: {...o.files!, receipts},
        ...(plate ? {publishedSelection: {fileIndex: o.publishedSelection!.fileIndex, plateIndex: plate.index, sliced: plate.sliced},
          current: {...o.current!, renders: plate.thumbnail ? [plate.thumbnail] : o.current!.renders}} : {})};
    }));
  }

  /** Slices the current model with the print sheet's settings, exactly as Print would, and reads the estimate. Never prints. */
  async estimate(id: string, request: PrintOptions & {destinationId?: string} = {}): Promise<PrintEstimate> {
    // Whether the file prints with its own settings on the printer this slice is for is settled first, so this slice's
    // defaults are the ones Print uses (`printOptions`): an answer arriving later would change Print's recipe.
    const {destinationId: requested, ...choices} = request;
    // A 3MF kept before there was a printer MCP gets its plates first, from the MCP of the printer this estimate is for.
    await this.#listPlates(id, requested);
    const sliceFor = (o: StmObject) => requested ? this.#deps.printerCatalog?.canonical(requested) ?? requested : this.#destinationId(o);
    const before = await this.get(id);
    await this.#askOwnSettings(before, sliceFor(before));
    const object = await this.get(id);
    // The estimate slices exactly what Print would (`#sliceRecipe`): its file is the one Print sends.
    const options = printOptions(object, choices, await this.#ownSettingsOn(object, sliceFor(object)));
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
    this.#publishedSettings(object, options);
    if (options.filament && options.colour) throw new InvalidStateError('Choose one colour.');
    const catalog = this.#deps.printerCatalog;
    const destinationId = requested ? catalog?.canonical(requested) : this.#destinationId(object);
    if (requested && !destinationId) throw new InvalidStateError('That printer is no longer available. Choose another printer.');
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    if (!services?.runner.estimate) throw new InvalidStateError('Estimates are unavailable for this printer.');
    const quality = options.quality ?? 'standard', strength = options.strength ?? 'standard';
    const copies = options.copies && options.copies > 1 ? options.copies : undefined;
    const recipe = await this.#sliceRecipe(id, object, options, services.selection, services.runner.backend, destinationId ? {destinationId} : undefined);
    const {overrides} = recipe;
    const capabilities = destinationId ? this.#deps.printers?.capabilities(destinationId) : undefined;
    if (capabilities && (('quality' in overrides && !capabilities.quality) || ('strength' in overrides && !capabilities.strength)
        || (copies && !capabilities.copies) || (overrides.pauseAtLayers?.length && !capabilities.layerPauses)))
      throw new InvalidStateError(settingsUnsupported(services.runner.backend, {quality, strength, ...(copies ? {copies} : {}), ...(options.pauseBeforeLayers?.length ? {pauseBeforeLayers: options.pauseBeforeLayers} : {})}));
    const model = await this.#modelBytes(object);
    const recipeId = recipeKey(destinationId ?? 'current', recipe, model);
    // The installed MCP's version too: an update can change what it slices and whether it draws previews.
    const server = destinationId ? this.#deps.printers?.capabilities(destinationId)?.server?.version ?? null : null;
    const key = JSON.stringify([id, createHash('sha256').update(model).digest('hex'), recipeId, server]);
    let running = this.#estimates2.get(key);
    // A kept estimate whose sliced file is gone (only the last few are kept) is sliced again.
    if (running) {
      const kept = await running.catch(() => undefined);
      if (kept?.sliceSha256 && !await this.#shownSlice(id, kept.sliceSha256, recipeId)) { this.#estimates2.delete(key); running = undefined; }
    }
    if (!running) {
      const runner = services.runner;
      running = (async () => {
        const work = await mkdtemp(join(tmpdir(), 'counterpart-estimate-'));
        try {
          const stlPath = join(work, object.current!.model.toLowerCase().endsWith('.3mf') ? 'model.3mf' : 'model.stl');
          await writeFile(stlPath, model);
          const {estimate, settings, slicerWarning, sliced: slicedFile, preview, previewSupported} = await runner.estimate!({stlPath,
            ...(recipe.selected ? {selection: recipe.selected} : {}), ...(Object.keys(recipe.sliced).length ? {slicer: recipe.sliced} : {}),
            signal: AbortSignal.timeout(150_000)});
          return {destinationId: destinationId ?? 'current', quality, strength, ...(copies ? {copies} : {}),
            ...(estimate?.seconds !== undefined ? {seconds: estimate.seconds} : {}), ...(estimate?.grams !== undefined ? {grams: estimate.grams} : {}),
            ...(settings.layers !== undefined ? {layers: settings.layers} : {}), ...(settings.layerHeightMm !== undefined ? {layerHeightMm: settings.layerHeightMm} : {}),
            ...(settings.infillPercent !== undefined ? {infillPercent: settings.infillPercent} : {}), ...(settings.wallLoops !== undefined ? {wallLoops: settings.wallLoops} : {}),
            // Bambu Studio's own warning on this slice, word for word (KAN-223). Print asks "Print anyway" with the same words.
            ...(slicerWarning ? {slicerWarning} : {}),
            ...(slicedFile ? {sliceSha256: await this.#keepShownSlice(id, slicedFile, {recipe: recipeId, previewed: !!preview, previewSupported: previewSupported !== false})} : {}),
            ...(preview ? {preview} : {}),
            slicedAt: new Date().toISOString()};
        } finally { await rm(work, {recursive: true, force: true}).catch(() => undefined); }
      })();
      this.#estimates2.set(key, running);
      // Failures aren't kept; a new model has a new key, so stale estimates are never served.
      running.catch(() => { if (this.#estimates2.get(key) === running) this.#estimates2.delete(key); });
      if (this.#estimates2.size > 64) this.#estimates2.delete(this.#estimates2.keys().next().value!);
    }
    // An MCP that can't say whether this file prints with its own settings: the person updates it (AGENTS.md).
    const update = await this.#ownSettingsUnsupported(object, sliceFor(object)) ? {ownSettingsUpdate: ownSettingsUnavailable(services.runner.backend)} : {};
    try { return {...structuredClone(await running), ...update}; }
    catch (error) {
      if (error instanceof PrinterMcpError && error.code === 'print-settings-unsupported') throw new InvalidStateError(settingsUnsupported(services.runner.backend, {quality, strength, supports: designedSupports(object).enableSupport !== undefined}));
      // Bambu Studio refused the slice: its own words, exactly what a Print of the same model fails with.
      if (error instanceof PrinterMcpError && ['slicer-error', 'copies-multiple-plates'].includes(error.code) && error.detail) throw new SlicerRefusedError(error.detail);
      throw new InvalidStateError(error instanceof PrinterMcpError && error.detail ? `Couldn't slice it for an estimate: ${error.detail}` : "Couldn't slice it for an estimate. Check the printer service, then try again.");
    }
  }


  answerPrintConfirmation(id: string, confirmationId: string, answer: unknown): Promise<StmObject> {
    return this.#gate(id, async () => {
      const confirmation = this.#confirmations.get(id);
      if (!confirmation || confirmation.pending.id !== confirmationId || !this.#pending(id, confirmationId)) {
        // Nothing waits for this answer any more: take the question off the project so its controls come back.
        this.#changed(await this.#deps.store.update(id, o => o.printConfirmation?.id === confirmationId ? {...o, printConfirmation: undefined} : o));
        throw new InvalidStateError('That printer confirmation is no longer waiting. Refresh the project.');
      }
      const question = printQuestion(confirmation.pending);
      if (!record(answer) || Object.keys(answer).some(key => !['action', 'content'].includes(key)))
        throw new InvalidStateError('Invalid printer confirmation answer.');
      let checked: ObjectPrintAnswer;
      if (answer.action === 'cancel' || answer.action === 'decline') {
        if (answer.content !== undefined) throw new InvalidStateError('Invalid printer confirmation answer.');
        checked = {action: answer.action};
      } else if (answer.action === 'accept' && question.supported) {
        // Checked field by field against the MCP's own schema before it ever reaches the MCP.
        checked = {action: 'accept', content: validateAnswer(question, answer.content)};
        // The question can wait minutes: re-read the chosen spools before this acceptance
        // is forwarded, and decline instead when one changed underneath it.
        const recheck = this.#dispatchRechecks.get(id);
        if (recheck) {
          try { await recheck(); }
          catch (error) {
            // Only a delivered decline makes this our refusal; an already-expired question
            // keeps its own timeout outcome in the dispatch handler.
            if (confirmation.printing.services.relay.respond(confirmationId, {action: 'decline'})) {
              this.#recheckFailures.set(id, error instanceof Error ? error.message : 'A chosen spool changed before printing started.');
              this.#cancelledPrints.add(id);
            // Guarded on the dispatch still running: if it settled (and cleaned up)
            // while the recheck waited, a late flag would poison the next print's reason.
            } else if (this.#running.has(id)) this.#expiredConfirmations.add(id);
            clearTimeout(confirmation.timer);
            this.#confirmations.delete(id);
            await this.#deps.store.update(id, o => o.printConfirmation?.id === confirmationId ? {...o, printConfirmation: undefined} : o);
            throw error;
          }
        }
      } else throw new InvalidStateError('This printer question cannot be approved here. Cancel it and use a supported confirmation form.');
      // Declining Print's own question cancels that print; declining a pause or stop question changes nothing else.
      if (checked.action !== 'accept' && this.#running.has(id)) this.#cancelledPrints.add(id);
      if (!confirmation.printing.services.relay.respond(confirmationId, checked)) {
        this.#cancelledPrints.delete(id);
        this.#changed(await this.#deps.store.update(id, o => o.printConfirmation?.id === confirmationId ? {...o, printConfirmation: undefined} : o));
        throw new InvalidStateError('That printer confirmation is no longer waiting. Refresh the project.');
      }
      clearTimeout(confirmation.timer);
      this.#confirmations.delete(id);
      return this.#changed(await this.#deps.store.update(id, o => o.printConfirmation?.id === confirmationId
        ? {...o, printConfirmation: undefined} : o));
    });
  }

  #pending(id: string, confirmationId: string): boolean {
    const current = this.#confirmations.get(id);
    return current?.pending.id === confirmationId && current.pending.expiresAtMs > Date.now()
      && current.printing.services.relay.pending().some(item => item.id === confirmationId);
  }

  async #confirm(id: string, pending: PendingElicitation, printing: NonNullable<ObjectServiceDeps['print']>): Promise<void> {
    clearTimeout(this.#confirmations.get(id)?.timer);
    const timer = setTimeout(() => {
      void this.#gate(id, async () => {
        if (this.#confirmations.get(id)?.pending.id !== pending.id) return;
        this.#expiredConfirmations.add(id);
        printing.services.relay.respond(pending.id, {action: 'cancel'});
        this.#confirmations.delete(id);
        this.#changed(await this.#deps.store.update(id, o => o.printConfirmation?.id === pending.id
          ? {...o, printConfirmation: undefined} : o));
      }).catch(() => undefined);
    }, Math.max(0, pending.expiresAtMs - Date.now()));
    this.#confirmations.set(id, {pending, printing, timer});
    const asked = await this.#deps.store.update(id, o => this.#pending(id, pending.id)
      ? {...o, printConfirmation: printQuestion(pending)} : o);
    this.#changed(asked);
    if (asked.print?.printId) await this.#emit({id: randomUUID(), type: 'print.confirm', projectId: id, printId: asked.print.printId,
      ...(asked.print.destination ? {destinationId: asked.print.destination.id, printerName: asked.print.destination.name} : {}),
      data: {confirmationId: pending.id, expiresAt: new Date(pending.expiresAtMs).toISOString()}, detail: {message: pending.message.slice(0, 300)}});
  }

  /** Resolves when the object's current touch-up or print (if any) has finished. */
  async settled(id: string): Promise<StmObject> {
    return (await this.#running.get(id)) ?? this.get(id);
  }

  async #pass(object: StmObject, opts: {note?: string; messageId?: string; photos?: string[]; trigger?: NonNullable<StmObject['passes'][number]['trigger']>}): Promise<StmObject> {
    // Design/cleanup workers use the current MCP too. Reserve before any await so an update cannot
    // swap its files while this pass is admitted, queued, running, saving, or closing its helper.
    let release = () => {};
    try { release = this.#deps.printGate?.hold('current') ?? release; }
    catch (error) { if (error instanceof PrinterUpdatingError) throw new InvalidStateError(error.message); throw error; }
    try { return await this.#reservedPass(object, opts, release); }
    catch (error) { release(); throw error; }
  }

  async #reservedPass(object: StmObject, opts: {note?: string; messageId?: string; photos?: string[]; trigger?: NonNullable<StmObject['passes'][number]['trigger']>}, release: () => void): Promise<StmObject> {
    if(this.#deps.requireModelAccess&&!this.#deps.modelAccess)throw new InvalidStateError('AI settings are unavailable. Open AI Settings on your Mac and retry.');
    const worker = this.#deps.modelAccess?.projectWorker();
    await this.#requireCaptureCompletion(object);
    const store = this.#deps.store, dir = store.dir(object.id);
    const fromCurrent = opts.note !== undefined && object.current !== undefined;
    const kind: PassKind = passKind(object);
    // Keep the decision: once this pass makes a model, a copy with nothing scanned would otherwise read as a copy again.
    if (object.kind !== kind) object = await store.update(object.id, o => ({...o, kind}));
    // A handheld scan is rebuilt into scan/scan.usdz first, once; its photos also show the touch-up the object.
    const build = kind !== 'published' && !fromCurrent && !object.scan && (object.capture?.length ?? 0) > 0;
    const capturePhotos = (object.capture ?? []).map(name => join(dir, 'capture', name));
    // Preserve the original/prior context, but never let a later queued message's uploads influence this pass.
    const pending = new Set(object.pendingPhotos ?? []);
    const photos = spreadPick([...object.photos.filter(name => !pending.has(name)).map(name => join(dir, 'photos', name)), ...capturePhotos], PHOTOS_PER_PASS);
    const startedAtMs = Date.now();
    // PRD §8.9: copies are cleaned up in Blender; a new design may use Fusion (the touch-up decides).
    const plan: StageId[] = [...(build ? ['building' as const] : []), 'preparing', 'working', 'saving'];
    let engine: DesignEngine = 'blender';
    let typical = await this.#typical(kind, engine);
    const first: PassStage = {id: plan[0]!, words: stageWords(plan[0]!, engine, kind), startedAtMs, typicalSec: typical[plan[0]!]};
    const running = await store.update(object.id, o => ({...o, state: 'touching-up', question: undefined, failure: undefined, pendingFollowup: undefined, pendingMessageId: undefined,
      ...(o.completion ? {completion: {...o.completion, undone: true}} : {}),
      ...(build ? {progress: 'Building the model from your photos.'} : {progress: undefined}),
      passes: [...o.passes, {startedAtMs, ...(opts.messageId ? {messageId: opts.messageId, photos: opts.photos ?? []} : {}), trigger: opts.trigger ?? 'new', stages: [first], estimate: passEstimate([first], plan, typical, startedAtMs),
        ...(opts.note ? {note: opts.note} : {})}]}));
    this.#changed(running);
    await this.#emit({id: randomUUID(), type: 'pass.started', projectId: object.id, data: {stage: first.words, estimateSec: passEstimate([first], plan, typical, startedAtMs).remainingSec}});
    // A published model's title is its own name (PRD §8.11), set when the file arrives.
    if (kind !== 'published') this.#title(running);
    const controller = new AbortController();
    this.#controllers.set(object.id, controller);
    let writing = Promise.resolve();
    /** Moves the pass to its next stage: closes the current one, records its real time, re-estimates, announces it. */
    const stage = (id: StageId, nextEngine: DesignEngine = engine) => {
      writing = writing.then(async () => {
        const now = Date.now();
        if (nextEngine !== engine) { engine = nextEngine; typical = await this.#typical(kind, engine); }
        const latest = (await store.get(object.id)).passes.find(p => p.startedAtMs === startedAtMs);
        const previous = latest?.stages?.at(-1);
        if (previous?.id === id) return;
        if (previous && previous.endedAtMs === undefined) void this.#deps.passTimings?.record(kind, engine, previous.id, (now - previous.startedAtMs) / 1000).catch(() => undefined);
        const next: PassStage = {id, words: stageWords(id, engine, kind), startedAtMs: now, typicalSec: typical[id]};
        const stages = [...(latest?.stages ?? []).map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item), next];
        const estimate = passEstimate(stages, plan, typical, now);
        this.#changed(await store.update(object.id, o => ({...o, passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, stages, estimate, engine})})));
        await this.#emit({id: randomUUID(), type: 'pass.stage', projectId: object.id, data: {stage: next.words, estimateSec: estimate.remainingSec}});
      }).catch(() => undefined);
    };
    const onProgress: NonNullable<TouchupInput['onProgress']> = progress => {
      if (!progress.activity?.length) return;
      const entries = this.#activity([], progress.activity);
      if (!entries.length) return;
      writing = writing.then(async () => {
        this.#changed(await store.update(object.id, o => ({...o,
          progress: entries.at(-1)!.kind === 'tool' ? toolProgress(entries.at(-1)!.text) : entries.at(-1)!.text,
          passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, activity: this.#activity(p.activity, entries)}),
        })));
      });
      // The worker callback is synchronous; the pass awaits this chain before its final state.
      void writing.catch(() => undefined);
    };
    if (kind === 'published') {
      // PRD §8.11: never the design pass. The worker gets the designer's own file, or the project asks for it.
      const published = (async () => {
        try { return await this.#getPublished(object, opts.note, photos, startedAtMs, controller.signal, onProgress, id => stage(id), worker); }
        finally { stage('saving'); await writing; }
      })()
        .then(result => this.#finishPublished(object.id, startedAtMs, result))
        .catch(error => this.#fail(object.id, startedAtMs, error))
        .finally(() => { release(); this.#running.delete(object.id); this.#controllers.delete(object.id); });
      this.#running.set(object.id, published);
      return running;
    }
    const work = (async () => {
      let scanName = object.scan;
      if (build) scanName = await this.#build(object.id, dir, controller.signal);
      // A copy of a designer's 3MF works on that 3MF every pass: the latest edit of it, then the designer's own
      // file to compare against. Its merged mesh has lost the designer's parts, colours and print settings.
      const designer = designerFile(object, kind, scanName);
      // A multi-colour design is revised from its merged mesh; Fusion passes also get the parametric design.
      const currentMesh = object.current && isMultipart(object) && object.kind !== 'published' ? join('current', 'model.stl') : object.current?.model;
      const scan = designer
        ? [...new Set([fromCurrent && isMultipart(object) ? object.current!.model : designer, designer])].map(path => join(dir, path))
        : fromCurrent ? [join(dir, currentMesh!)] : scanName ? [join(dir, 'scan', scanName)] : [];
      const input: TouchupInput = {worker, root: join(dir, 'passes'), objectId: 'pass', scan, photos, currentModel: fromCurrent && !designer, handoff: this.#handoff(), claudePath: this.#deps.claudePath,
        ...(designer ? {designerCopy: true} : {}),
        kind, ...(object.preferences?.designEngine && object.preferences.designEngine !== 'auto' ? {preferredEngine: object.preferences.designEngine} : {}), onStage: (id, chosen) => stage(id, chosen),
        ...(fromCurrent && object.current?.engine === 'fusion' && object.current.design
          ? {design: {f3d: join(dir, object.current.design.f3d), ...(object.current.design.parameters ? {parameters: join(dir, object.current.design.parameters)} : {})}} : {}),
        ...(object.instructions ? {instructions: object.instructions} : {}),
        ...(opts.note !== undefined ? {note: opts.note, ...(object.current?.summary ? {summary: object.current.summary} : {})} : {})};
      try { return await this.#deps.runTouchup({...input, signal: controller.signal, onProgress}); }
      finally { stage('saving'); await writing; }
    })()
      .then(result => this.#finish(object.id, startedAtMs, result, kind),
        error => error instanceof ReconstructionReviewNeeded
          ? this.#finishReconstructionReview(object.id, startedAtMs, error)
          : this.#fail(object.id, startedAtMs, error))
      .finally(() => { release(); this.#running.delete(object.id); this.#controllers.delete(object.id); });
    this.#running.set(object.id, work);
    return running;
  }

  /** Runs the published-model worker for the project's link (or the one in a correction). */
  async #getPublished(object: StmObject, note: string | undefined, photos: string[], startedAtMs: number, signal: AbortSignal,
    onProgress: NonNullable<TouchupInput['onProgress']>, stage: (id: StageId) => void, worker?: import('../touchup/runner.js').ProjectWorker): Promise<PublishedResult> {
    const link = publishedLink(note) ?? publishedLink(object.instructions) ?? (object.credit ? {url: object.credit.url, site: object.credit.site ?? new URL(object.credit.url).hostname} : undefined);
    if (!link) return {status: 'needs_file'};
    // A starter's files already kept on this computer are never downloaded again: the worker gets only what's missing.
    const starter = object.starterId ? this.#starter(object.starterId) : undefined;
    const kept = starter ? await this.#starterDownloads(starter, await this.#modelFiles(this.#starterCacheDir(starter), 1)) : [];
    const keptNote = kept.length ? `Already on this computer, so don't download these again: ${kept.map(file => basename(file.path)).join(', ')}. Download only the other file${starter!.files - kept.length === 1 ? '' : 's'}.` : undefined;
    const request = [object.instructions?.trim(), note?.trim(), keptNote].filter(Boolean).join('\n\n');
    const run = this.#deps.runPublished ?? (input => defaultRunPublished(input));
    return run({worker, root: join(this.dir(object.id), 'passes'), photos, request, link, claudePath: this.#deps.claudePath,
      startedAtMs, signal, onProgress, onStage: stage});
  }

  /** Keeps the designer's file as published (original and current), credits the designer, or asks for the file. */
  async #finishPublished(id: string, startedAtMs: number, result: PublishedResult): Promise<StmObject> {
    const store = this.#deps.store, dir = store.dir(id), now = Date.now();
    const endPass = (o: StmObject, status: string, summary?: string) => o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== startedAtMs
      ? {...p, ...(_estimate ? {estimate: _estimate} : {})}
      : {...p, endedAtMs: now, status, stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item), ...(summary ? {summary: this.#publicText(summary)} : {})});
    const credit = result.model ? {url: result.model.url, site: result.model.site, title: result.model.title, ...(result.model.designer ? {designer: result.model.designer} : {}),
      ...(result.model.licence ? {licence: result.model.licence} : {})} : undefined;
    // A starter whose files reached ~/Downloads while the pass ran is ready, whatever the worker concluded (Nov 6,
    // e95f31ea: both 150 mm profiles were in Downloads at 21:08, the worker's own check missed them, and the project
    // said "Sign in"). PRD §8.11 step 2.2: a matching download is used at once.
    if (result.status !== 'downloaded' && !(result.status === 'failed' && result.run?.stopReason === 'cancelled')) {
      const object = await store.get(id), starter = object.starterId ? this.#starter(object.starterId) : undefined;
      const files = starter ? await this.#starterFiles(starter, result.arrived ?? []) : [];
      const kit = starter ? this.#kit(starter, files) : undefined;
      if (starter && kit) {
        console.error(`published pass: project ${id} took the designer’s ${kit.length} file${kit.length === 1 ? '' : 's'} from Downloads (the worker reported ${result.status}): ${kit.map(file => basename(file)).join(', ')}`);
        return this.#keepPublished(id, kit, {startedAtMs, now, ...(result.model ? {model: result.model} : {}), ...(credit ? {credit} : {})});
      }
      // Even part of a kit is kept (only the catalog's own files, when it pins them), so a later pass never downloads it again.
      if (starter) await this.#cacheStarter(starter, files.filter(file => !starter.sha256?.length || starter.sha256.includes(file.sha256)).map(file => file.path));
    }
    // Every published pass that doesn't bring the file back logs why, with what finds its transcript (Nov 6:
    // a starter said "Sign in" while the browser was signed in, and the log had nothing).
    if (result.status !== 'downloaded') this.#logPublished(id, startedAtMs, result);
    if (result.status === 'failed') {
      const message = this.#publicText(result.reason);
      const updated = await store.update(id, o => ({...o, state: 'failed', failure: message, progress: undefined, ...(credit ? {credit} : {}), passes: endPass(o, 'failed', message)}));
      await this.#emit({id: randomUUID(), type: 'pass.failed', projectId: id, detail: {reason: message}});
      return this.#changed(updated);
    }
    if (result.status === 'needs_file') {
      const object = await store.get(id);
      if (object.starterId && result.browser !== false) {
        // A starter has nothing for the person to choose or download by hand: one sentence and Try Again.
        // With no browser to download with (Linux, no Chrome extension), it asks for the files as any link does.
        // Only a site that showed the worker signed out asks for a sign-in, once, on the page it left open in Chrome
        // (Chrome keeps it). Any other miss says what the worker saw: a server error is not a sign-in.
        const site = object.credit?.site ?? 'MakerWorld';
        const seen = result.summary ? this.#publicText(result.summary).replace(/\s+/g, ' ').trim().slice(0, 400) : '';
        const message = result.reason === 'not_signed_in'
          ? `Counterpart couldn’t download the designer’s files because ${site} isn’t signed in. Sign in to ${site} on the page Counterpart left open in your browser, then try again.`
          : `Counterpart couldn’t download the designer’s files from ${site}.${seen ? ` ${seen}` : ''} Try again.`;
        const updated = await store.update(id, o => ({...o, state: 'failed', failure: message, progress: undefined, ask: undefined, passes: endPass(o, 'failed', message)}));
        await this.#emit({id: randomUUID(), type: 'pass.failed', projectId: id, detail: {reason: message}});
        return this.#changed(updated);
      }
      const site = result.model?.site ?? object.credit?.site ?? publishedLink(object.instructions)?.site;
      const url = result.model?.url ?? object.credit?.url ?? publishedLink(object.instructions)?.url;
      const modelName = result.model?.title ?? object.credit?.title;
      // A starter asks for its print profile's 3MF (the designer's plates) and names the button; any other link takes a 3MF or STL.
      const starter = object.starterId ? this.#starter(object.starterId) : undefined;
      const ask = {id: randomUUID(), type: 'file' as const, question: (starter ? starterFileQuestion(starter) : `Download ${modelName ?? 'the model'} from ${site ?? 'its page'} and share it here.`).slice(0, 300),
        ...(url ? {url} : {}), ...(modelName ? {modelName} : {}), ...(site ? {site} : {}), accepts: starter ? ['3mf' as const] : ['3mf' as const, 'stl' as const],
        ...(result.candidate ? {candidate: {path: result.candidate, name: basename(result.candidate)}} : {}),
        answers: ['file' as const], status: 'open' as const, askedAtMs: now};
      const updated = await store.update(id, o => ({...o, state: 'needs-closeup', progress: undefined, ask, question: undefined, kind: 'published' as const,
        ...(!o.title && result.model ? {title: result.model.title} : {}), ...(credit ? {credit} : {}), passes: endPass(o, 'needs_file', result.summary)}));
      await this.#emit({id: randomUUID(), type: 'pass.ask', projectId: id, data: {askId: ask.id}, detail: {question: ask.question}});
      return this.#changed(updated);
    }
    const summary = [result.summary, result.profile ? `Profile: ${result.profile}.` : undefined].filter(Boolean).join(' ');
    // A starter's worker may have downloaded only what was missing (Codex on #369): its kept part comes with it.
    const object = await store.get(id), starter = object.starterId ? this.#starter(object.starterId) : undefined;
    let files = result.files;
    if (starter) {
      const all = await this.#starterFiles(starter, result.files);
      const kit = this.#kit(starter, all);
      files = kit ?? [...new Set([...all.map(file => file.path), ...result.files])];
    }
    return this.#keepPublished(id, files, {startedAtMs, now, ...(result.model ? {model: result.model} : {}), ...(summary ? {summary} : {}), ...(credit ? {credit} : {})});
  }

  /** The designer's own files among `files`: metadata names the catalog's designer, one per sha256 (repeat clicks copy). */
  async #starterDownloads(starter: StarterProject, files: string[]): Promise<{path: string; sha256: string; plates: number}[]> {
    const picked: {path: string; sha256: string; plates: number}[] = [];
    for (const path of files) {
      // Only the print profile's 3MF has the designer's plates; a raw-model STL never stands in for it.
      if (extname(path).toLowerCase() !== '.3mf') continue;
      try {
        const metadata = inspectModelFile(await readModelFile(path), '3mf');
        if (metadata.designer !== starter.designer || picked.some(file => file.sha256 === metadata.sha256)) continue;
        picked.push({path, sha256: metadata.sha256, plates: Math.max(1, metadata.plates.length)});
      } catch { /* not a model this starter can use */ }
    }
    return picked;
  }
  /**
   * The complete kit among a starter's files, or nothing: every one of the catalog's pinned files when it pins them
   * (two calipers of other lengths never stand in for the caliper and its gauge), else the catalog's file and plate
   * counts (the rig's full kit has six plates, never a part of it).
   */
  #kit(starter: StarterProject, files: {path: string; sha256: string; plates: number}[]): string[] | undefined {
    if (starter.sha256?.length) {
      const kit = starter.sha256.map(sha256 => files.find(file => file.sha256 === sha256));
      return kit.every(Boolean) ? kit.map(file => file!.path) : undefined;
    }
    const plates = files.reduce((sum, file) => sum + file.plates, 0);
    return files.length >= starter.files && plates >= (starter.plates ?? 0) ? files.map(file => file.path) : undefined;
  }

  /**
   * A starter's files on hand to make up its kit with `extra`: what its cache keeps, and, when the catalog pins its files,
   * any pinned one in ~/Downloads however long it has been there (its sha256 proves what it is). Codex on #369.
   */
  async #starterFiles(starter: StarterProject, extra: string[]) {
    const kept = await this.#modelFiles(this.#starterCacheDir(starter), 1);
    const pinned = starter.sha256?.length ? (await this.#starterDownloads(starter, await this.#modelFiles(this.#deps.downloads ?? join(homedir(), 'Downloads'), 0)))
      .filter(file => starter.sha256!.includes(file.sha256)).map(file => file.path) : [];
    return this.#starterDownloads(starter, [...kept, ...pinned, ...extra]);
  }
  #starter(id: string) { return (this.#deps.starter ?? bundledStarter)(id); }
  #starterCacheDir(starter: StarterProject) {
    return join(this.#deps.starterCache ?? join(dirname(this.#deps.store.root), 'starters'), starterModelId(starter));
  }
  /** Model files in a folder, `depth` levels down (the cache keeps each file in a folder named by its sha256). */
  async #modelFiles(folder: string, depth: number): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(folder, {withFileTypes: true}).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth > 0) out.push(...await this.#modelFiles(path, depth - 1));
      else if (entry.isFile() && /\.(3mf|stl)$/i.test(entry.name)) out.push(path);
    }
    return out.sort();
  }
  /** The kit a starter's project accepted, as kept in its cache (kit.json names each file by sha256), when all of it is there. */
  async #cachedKit(starter: StarterProject): Promise<string[] | undefined> {
    const root = this.#starterCacheDir(starter);
    const kit = await readFile(join(root, 'kit.json'), 'utf8').then(text => JSON.parse(text) as {sha256?: unknown}, () => undefined);
    const wanted = Array.isArray(kit?.sha256) ? kit.sha256.filter((value): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) : [];
    if (!wanted.length) return undefined;
    const files = await this.#starterDownloads(starter, await this.#modelFiles(root, 1));
    const found = wanted.map(sha256 => files.find(file => file.sha256 === sha256));
    return found.every(Boolean) ? found.map(file => file!.path) : undefined;
  }
  /**
   * Everything a starter needs that is already on this computer: the kit kept in its cache first, then ~/Downloads,
   * where only the catalog's pinned files count (a starter with none pinned isn't looked for there).
   */
  async #starterOnDisk(starter: StarterProject): Promise<{files: string[]; from: 'cache' | 'Downloads'} | undefined> {
    // ('Downloads' when any of it comes from there or from the cache's kept fragments.)
    const cached = await this.#cachedKit(starter);
    if (cached) return {files: cached, from: 'cache'};
    if (!starter.sha256?.length) return undefined;
    // Pinned files, wherever they are kept: the cache's fragments and ~/Downloads together (Codex on #369).
    const kit = this.#kit(starter, await this.#starterFiles(starter, []));
    return kit ? {files: kit, from: 'Downloads'} : undefined;
  }
  /** Keeps a starter's designer files once per computer (and, with `kit`, which of them make it ready), so Try Again and a second tap never download them again. */
  async #cacheStarter(starter: StarterProject, files: string[], kit?: string[]) {
    const root = this.#starterCacheDir(starter);
    for (const file of files) {
      try {
        const bytes = await readModelFile(file);
        const sha256 = inspectModelFile(bytes, extname(file).toLowerCase() === '.stl' ? 'stl' : '3mf').sha256;
        const folder = join(root, sha256), target = join(folder, basename(file).replace(/^[0-9a-f]{64}-/, ''));
        if (await stat(target).then(() => true, () => false)) continue;
        await mkdir(folder, {recursive: true, mode: 0o700});
        const temporary = join(folder, `.incoming-${randomUUID()}`);
        await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
        await rename(temporary, target);
      } catch (error) {
        console.error(`starter ${starter.id}: couldn’t keep ${basename(file)} in its cache: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (kit?.length) {
      const temporary = join(root, `.kit-${randomUUID()}`);
      try { await mkdir(root, {recursive: true, mode: 0o700}); await writeFile(temporary, JSON.stringify({sha256: kit}), {mode: 0o600}); await rename(temporary, join(root, 'kit.json')); }
      catch (error) { await rm(temporary, {force: true}); console.error(`starter ${starter.id}: couldn’t record its kit: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /** One companion-log line per published pass that ended without the file: the real cause, never only the sentence shown. */
  #logPublished(id: string, startedAtMs: number, result: Exclude<PublishedResult, {status: 'downloaded'}>) {
    const run = result.run;
    const facts = [`project ${id}`, `pass ${new Date(startedAtMs).toISOString()}`, `status ${result.status}`,
      ...(result.status === 'needs_file' ? [`reason ${result.reason ?? 'unknown'}`, `browser ${result.browser === false ? 'none' : 'chrome'}`] : []),
      ...(run ? [`tool calls ${run.toolCalls}`, `${run.seconds} s`, `exit ${run.exitCode ?? 'none'}`, ...(run.stopReason ? [`stopped: ${run.stopReason}`] : []),
        ...(run.sessionId ? [`worker session ${run.sessionId}`] : [])] : [])];
    const said = result.status === 'failed' ? result.reason : result.summary ?? '(no summary)';
    console.error(`published pass did not get the file: ${facts.join(', ')}: ${this.#publicText(said).replace(/\s+/g, ' ').slice(0, 600)}`);
  }

  /** The designer's file becomes the project's model, exactly as published: original/<name> and current/model.<ext>. */
  async #keepPublished(id: string, files: string[], info: {startedAtMs?: number; now?: number; model?: PublishedModel; summary?: string; credit?: StmObject['credit']}): Promise<StmObject> {
    const store = this.#deps.store, dir = store.dir(id), now = info.now ?? Date.now();
    const object = await store.get(id);

    const originals = [...(object.files?.original ?? [])];
    const receipts = [...(object.files?.receipts ?? [])];
    await mkdir(join(dir, 'original'), {recursive: true});
    for (const file of files) {
      const bytes = await readModelFile(file);
      const format = extname(file).toLowerCase() === '.stl' ? 'stl' : '3mf';
      let metadata: ModelFileInfo;
      try { metadata = inspectModelFile(bytes, format); } catch (error) { throw new InvalidFileError(error instanceof Error ? error.message : 'That model could not be read.'); }
      if (receipts.some(receipt => receipt.sha256 === metadata.sha256)) continue;
      const name = `${metadata.sha256}-${basename(file).replace(/[^A-Za-z0-9._ ()-]/g, '_').slice(-120)}`;
      const relative = join('original', name);
      const existing = originals.includes(relative) ? await readModelFile(join(dir, relative)).catch(() => undefined) : undefined;
      if (!existing?.equals(bytes)) {
        const temporary = join(dir, 'original', `.incoming-${randomUUID()}`);
        await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
        try { await rename(temporary, join(dir, relative)); } finally { await rm(temporary, {force: true}); }
      }
      if (!originals.includes(relative)) {
        // A 3MF's plates are the printer MCP's reading of it (list_3mf_plates, PRD §8.0 item 9), as Bambu Studio shows
        // them. With no printer MCP yet, they are listed when there is one (#listPlates).
        const plates = format === '3mf' ? await this.#mcpPlates(dir, relative, metadata.sha256) : [];
        originals.push(relative); receipts.push({...metadata, plates: plates ?? [], ...(format === '3mf' && !plates ? {platesListed: false} : {}),
          path: relative, name: basename(file), ...(info.credit ? {credit: {...info.credit, ...(metadata.designer ? {designer: metadata.designer} : {}), ...(metadata.licence ? {licence: metadata.licence} : {})}} : {})});
      }
    }
    const options = receipts.flatMap((file, fileIndex) => (file.plates.length ? file.plates : [{index: 0, name: 'Model', objects: [], sliced: false}])
      .map(plate => ({id: `${fileIndex}:${plate.index}`, label: `${file.name} · ${plate.name}`.slice(0, 120), ...(plate.objects.length ? {detail: plate.objects.join(', ').slice(0, 300)} : {}), ...(plate.thumbnail ? {thumbnail: plate.thumbnail} : {})})));
    const first = receipts[0]!;
    const firstPlate = first.plates[0];
    const summary = info.summary ? this.#publicText(info.summary) : undefined;
    const current = {model: first.path, renders: firstPlate?.thumbnail ? [firstPlate.thumbnail] : [], ...(summary ? {summary} : {})};
    const published = {original: originals, current: current.model, receipts};
    const credit = {...(first.credit ?? info.credit), ...(first.designer ? {designer: first.designer} : {}), ...(first.licence ? {licence: first.licence} : {})};
    // A starter keeps all its files and plates (the rig's six plates; the caliper and its depth gauge), each printed
    // from the plate picker, so it is ready without a question. Any other published model asks which to print.
    const ask = options.length > 1 && !object.starterId ? {id: randomUUID(), type: 'choice' as const, question: 'Which file and plate would you like to print?', options,
      multiple: false, answers: ['choice' as const], status: 'open' as const, askedAtMs: now} : undefined;
    const updated = await store.update(id, o => ({...o, ...(o.print ? {plateProgress: retainedPlateProgress(o)} : {}), print: undefined, printConfirmation: undefined, state: ask ? 'needs-closeup' : 'ready', progress: undefined, failure: undefined, kind: 'published', current, files: published,
      publishedSelection: {fileIndex: 0, plateIndex: firstPlate?.index ?? 0, sliced: firstPlate?.sliced ?? false},
      ...(!o.title && (first.title || info.model?.title) ? {title: first.title ?? info.model!.title} : {}), ...(credit.url ? {credit: credit as NonNullable<StmObject['credit']>} : {}),
      ...(ask ? {ask} : o.ask?.status === 'open' ? {ask: {...o.ask, status: 'answered' as const}} : {}),
      passes: info.startedAtMs === undefined ? o.passes : o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== info.startedAtMs ? {...p, ...(_estimate ? {estimate: _estimate} : {})}
        : {...p, endedAtMs: now, status: 'done', stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item), ...(summary ? {summary} : {})})}));
    // A starter that is ready keeps the kit it accepted, once per computer: Try Again and a second tap never download it.
    const starter = object.starterId ? this.#starter(object.starterId) : undefined;
    // Only a whole kit (#kit) is recorded as one: a worker's or the person's partial or wrong set is kept as files, never replayed.
    if (starter && updated.state === 'ready') {
      const files = await this.#starterDownloads(starter, receipts.map(receipt => join(dir, receipt.path)));
      const kit = this.#kit(starter, files);
      await this.#cacheStarter(starter, files.map(file => file.path), kit ? files.filter(file => kit.includes(file.path)).map(file => file.sha256) : undefined);
    }
    await this.#emit({id: randomUUID(), type: ask ? 'pass.ask' : 'pass.ready', projectId: id, ...(ask ? {data: {askId: ask.id}, detail: {question: ask.question}} : {})});
    return this.#changed(updated);
  }

  /**
   * A `choice` Ask, answered (PR 7): the picked option ids are kept on the Ask, and the next pass goes on with them
   * (for a published model: the plate, the parts or the colours the person picked).
   */
  answerAsk(id: string, askId: string, choices: string[]): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id);
      // A normal choice must not approve a reconstruction review either.
      if (object.reconstructionReview) throw new InvalidStateError(RECONSTRUCTION_REVIEW_UPDATE);
      const ask = object.ask;
      if (!ask || ask.id !== askId || ask.status !== 'open' || ask.type !== 'choice') throw new InvalidStateError('That question has been answered or replaced. Look again.');
      const known = new Set((ask.options ?? []).map(option => option.id));
      if (!choices.length || choices.some(choice => !known.has(choice)) || (!ask.multiple && choices.length > 1)) throw new InvalidStateError('Pick one of the choices.');
      if (object.kind === 'published' && object.files?.receipts) {
        const [fileIndex, plateIndex] = choices[0]!.split(':').map(Number);
        const file = object.files.receipts[fileIndex!];
        const plate = file?.plates.find(item => item.index === plateIndex);
        if (!file || (file.format === '3mf' && !plate && !(file.platesListed === false && plateIndex === 0))) throw new InvalidStateError('Choose a plate in this model.');
        const updated = await this.#deps.store.update(id, o => selectingPlate(o, fileIndex!, plateIndex!));
        await this.#emit({id: randomUUID(), type: 'pass.ready', projectId: id});
        return this.#changed(updated);
      }
      const labels = choices.map(choice => ask.options!.find(option => option.id === choice)!.label);
      const answered = await this.#deps.store.update(id, o => ({...o, ask: {...o.ask!, status: 'answered' as const, choices}}));
      this.#changed(answered);
      return this.#pass(answered, {note: `${ask.question} The person chose: ${labels.join(', ')}.`, trigger: 'ask-answer'});
    });
  }

  /** The current review's preview STL, as a project-relative path for the bounded file export. */
  async reconstructionPreview(id: string, reviewId: string): Promise<string> {
    const object = await this.get(id);
    if (!object.reconstructionReview || object.reconstructionReview.id !== reviewId) throw new ObjectNotFoundError();
    return reconstructionPaths(this.dir(id)).previewStlRelative(reviewId);
  }

  /**
   * The explicit reconstruction answer: which part is the object, or how big
   * it is. Bound to the open review's id and hashes; the answer is stored
   * privately and the cached rebuild resumes. Original photos are retained.
   */
  answerReconstruction(id: string, reviewId: unknown, answerValue: unknown): Promise<StmObject> {
    return this.#gate(id, async () => {
      if (typeof reviewId !== 'string' || !/^[0-9a-f-]{36}$/i.test(reviewId)) throw new InvalidAnswerError('That question has been answered or replaced. Look again.');
      const parsed = ReconstructionAnswerSchema.safeParse(answerValue);
      if (!parsed.success) throw new InvalidAnswerError('That answer is not complete. Review the model and answer again.');
      const answer: ReconstructionAnswer = parsed.data;
      const object = await this.get(id);
      const review = object.reconstructionReview;
      if (!review || review.id !== reviewId || object.state !== 'needs-closeup')
        throw new InvalidAnswerError('That question has been answered or replaced. Look again.');
      if (answer.type !== review.kind)
        throw new InvalidAnswerError(review.kind === 'region'
          ? 'First choose which part of the model is the object.'
          : 'First say how big the object is.');
      const dir = this.dir(id);
      if (answer.type === 'region') {
        if (answer.previewMeshSha256 !== review.previewMeshSha256)
          throw new InvalidAnswerError('That answer was for an older preview. Look again and answer the current one.');
        const selection = answer.selection;
        if (selection.type === 'component' && review.components && selection.index >= review.components.length)
          throw new InvalidAnswerError('That piece is not in the current preview. Look again.');
        if (selection.type === 'crop') {
          const {min, max} = selection;
          const inverted = min.some((v, i) => !(v < max[i]!));
          const misses = min.some((v, i) => max[i]! < review.boundsMin[i]! || v > review.boundsMax[i]!);
          if (inverted || misses) throw new InvalidAnswerError('That selection does not cover any of the model. Try again.');
        }
        await writeObjectRegion(dir, {version: 1, kind: 'capture-object-region',
          previewMeshSha256: answer.previewMeshSha256, selection});
      } else {
        if (answer.meshSha256 !== review.meshSha256)
          throw new InvalidAnswerError('That measurement was for an older model. Look again and measure the current one.');
        await writeMeasurement(dir, {version: 1, kind: 'capture-measurement',
          meshSha256: answer.meshSha256, axis: answer.axis, extentMm: answer.extentMm});
      }
      await rm(reconstructionPaths(dir).previewStl(review.id), {force: true});
      const answered = await this.#deps.store.update(id, o => ({...o, reconstructionReview: undefined,
        ...(o.ask ? {ask: {...o.ask, status: 'answered' as const}} : {}), question: undefined}));
      this.#changed(answered);
      return this.#pass(answered, {trigger: 'ask-answer'});
    });
  }

  /** PRD §8.11's file Ask, answered: the person shared the designer's file (phone upload or a path on this Mac). */
  addModelFile(id: string, name: string, bytes: Buffer): Promise<StmObject> { return this.#gate(id, () => this.#addModelFile(id, name, bytes)); }
  #addModelFile(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    return (async () => {
      const object = await this.get(id);
      if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
      if (object.print?.uncertain) throw new InvalidStateError('Check the current print on your printer before adding files.');
      if (object.kind !== 'published') throw new InvalidStateError('Start a project with the model’s link before sharing its file.');
      // A starter is the designer's print profile: its raw model (an STL, or the zip of them) has lost the plates.
      const starter = object.starterId ? this.#starter(object.starterId) : undefined;
      if (starter && !/\.3mf$/i.test(name)) throw new InvalidStateError(starterRawModel(starter));
      if (!/\.(3mf|stl)$/i.test(name)) throw new InvalidStateError('Share the model as a 3MF or STL file.');
      if (/\.3mf$/i.test(name) ? !(bytes[0] === 0x50 && bytes[1] === 0x4b) : bytes.length < 84) throw new InvalidStateError("That file isn't a 3MF or STL model.");
      const folder = join(this.dir(id), 'incoming');
      await mkdir(folder, {recursive: true});
      const incoming = await mkdtemp(join(folder, 'model-'));
      const path = join(incoming, basename(name));
      await writeFile(path, bytes, {mode: 0o600});
      const credit = object.credit ?? (() => { const link = publishedLink(object.instructions); return link ? {url: link.url, site: link.site} : undefined; })();
      try { return await this.#keepPublished(id, [path], credit ? {credit} : {}); } finally { await rm(incoming, {recursive: true, force: true}); }
    })();
  }

  /** Rebuilds a handheld scan on this Mac, showing progress in words, and records it as the object's scan. */
  async #build(id: string, dir: string, signal: AbortSignal): Promise<string> {
    const reconstruct = this.#deps.reconstruct ?? defaultReconstructRunner();
    const store = this.#deps.store;
    let shownAt = 0, pending: string | undefined, writing = Promise.resolve();
    const show = (words: string) => {
      pending = words;
      if (Date.now() - shownAt < 1000) return;   // at most one update a second
      shownAt = Date.now();
      writing = writing.then(async () => { this.#changed(await store.update(id, o => ({...o, progress: pending}))); }).catch(() => undefined);
    };
    await mkdir(join(dir, 'scan'), {recursive: true});
    // Qualification is keyed on the capture's own declaration, never on
    // whether camera metadata happens to be present.
    const scaleQualificationRequired = !!(await store.get(id)).captureCompletion?.scaleQualificationRequired;
    const outcome = await reconstruct({photosDir: join(dir, 'capture'), output: join(dir, 'scan', 'scan.usdz'),
      masksDir: join(dir, 'capture-masks'), ...await reconstructionInputs(dir),
      ...(scaleQualificationRequired ? {scaleQualificationRequired: true} : {}), signal, onProgress: show});
    await writing;
    if (outcome?.status === 'needs-review') {
      // Not a failure and not a scan: the pass ends as an Ask (see #finishReconstructionReview).
      const reviewId = randomUUID();
      await saveReviewPreview(dir, reviewId, outcome.review.previewStl);
      throw new ReconstructionReviewNeeded(outcome.review, reviewId);
    }
    this.#changed(await store.update(id, o => ({...o, scan: 'scan.usdz', progress: undefined, reconstructionReview: undefined})));
    return 'scan.usdz';
  }

  /** A rebuild stopped for the person: needs-closeup with an Ask and the public review, never failed. */
  async #finishReconstructionReview(id: string, startedAtMs: number, needed: ReconstructionReviewNeeded): Promise<StmObject> {
    const store = this.#deps.store, now = Date.now();
    const review = publicReview(needed.reviewId, needed.review);
    const question = needed.review.kind === 'region'
      ? 'Which part of this model is the object you scanned? Check the preview, then confirm it or choose the right part.'
      : 'How big is the object? Measure one side of it and enter the size in millimetres.';
    const ask: NonNullable<StmObject['ask']> = {id: randomUUID(), question, type: 'choice',
      answers: ['choice'], status: 'open', askedAtMs: now};
    const updated = await store.update(id, o => ({...o, state: 'needs-closeup', progress: undefined,
      failure: undefined, ask, reconstructionReview: review,
      question: {closeup: needed.review.kind === 'region' ? 'which part is the object' : 'how big the object is'},
      passes: o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== startedAtMs ? {...p, ...(_estimate ? {estimate: _estimate} : {})}
        : {...p, endedAtMs: now, status: 'needs_closeup',
          stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item),
          activity: this.#activity(p.activity, [{atMs: now, kind: 'message', text: question}])})}));
    await this.#emit({id: randomUUID(), type: 'pass.ask', projectId: id, data: {askId: ask.id}, detail: {question}});
    return this.#changed(updated);
  }

  /** A running pass's time left, recomputed at every read so it counts down (and never shows an expired estimate). */
  async #freshEstimate(object: StmObject): Promise<StmObject> {
    const pass = object.passes.at(-1);
    if (!pass?.stages?.length || pass.endedAtMs !== undefined) return object;
    const kind: PassKind = passKind(object);
    const typical = {...await this.#typical(kind, pass.engine ?? 'blender')};
    for (const stage of pass.stages) typical[stage.id] = stage.typicalSec;
    const plan: StageId[] = [...(pass.stages.some(stage => stage.id === 'building') ? ['building' as const] : []), 'preparing', 'working', 'saving'];
    const estimate = passEstimate(pass.stages, plan, typical, Date.now());
    return {...object, passes: [...object.passes.slice(0, -1), {...pass, estimate}]};
  }

  async #typical(kind: PassKind, engine: DesignEngine) {
    return this.#deps.passTimings ? this.#deps.passTimings.typical(kind, engine).catch(() => STAGE_DEFAULTS(kind)) : STAGE_DEFAULTS(kind);
  }

  readonly #titling = new Set<string>();
  #backfills: Promise<unknown> = Promise.resolve();
  /**
   * A quick title for a request, if the project has none yet: at its first pass, or (backfill) when an older
   * project is listed. Tried once per project per run; backfills run one at a time. Never holds anything up.
   */
  #title(object: StmObject, options: {backfill?: boolean} = {}): void {
    if (passKind(object) === 'published') return;
    const request = object.instructions?.trim(), titleFor = this.#deps.titleFor;
    if (object.title || !request || !titleFor || this.#titling.has(object.id)) return;
    this.#titling.add(object.id);
    const save = async (title: string | undefined) => {
      const clean = title?.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/[.!]+$/, '').trim().slice(0, 40);
      if (clean) this.#changed(await this.#deps.store.update(object.id, o => o.title ? o : {...o, title: clean}));
    };
    if (!options.backfill) { void titleFor(request).then(save).catch(() => undefined); return; }
    this.#backfills = this.#backfills.then(async () => {
      if ((await this.#deps.store.get(object.id).catch(() => undefined))?.title) return;
      await save(await titleFor(request));
    }).catch(() => undefined);
  }

  async #finish(id: string, startedAtMs: number, result: TouchupResult & {passDir: string; engine?: DesignEngine; note?: string}, kind: PassKind = 'copy'): Promise<StmObject> {
    const store = this.#deps.store, dir = store.dir(id);
    result = {...result,
      summary: result.summary === undefined ? undefined : this.#publicText(result.summary),
      reason: result.reason === undefined ? undefined : this.#publicText(result.reason),
      closeup: result.closeup === undefined ? undefined : this.#publicText(result.closeup)};
    let current: StmObject['current'] | undefined;
    if (result.model) {
      const currentDir = join(dir, 'current'), rendersDir = join(currentDir, 'renders');
      await rm(rendersDir, {recursive: true, force: true});
      await mkdir(rendersDir, {recursive: true});
      await copyFile(result.model, join(currentDir, 'model.stl'));
      const renders: string[] = [];
      for (const render of result.renders) {
        await copyFile(render, join(rendersDir, basename(render)));
        renders.push(join('current', 'renders', basename(render)));
      }
      const sizeMm = await this.#deps.stlInfo(join(currentDir, 'model.stl')).catch(() => undefined);
      const summary = result.status === 'unchanged' ? result.summary ?? 'Nothing needed changing.'
        : result.status === 'capped' ? `Stopped at the ${result.reason?.includes('time') ? 'time limit' : 'step limit'}; this is the last saved version.${result.summary ? ' ' + result.summary : ''}`
        : result.summary;
      const engine = result.engine ?? 'blender';
      let design: {f3d: string; parameters?: string} | undefined;
      if (engine === 'fusion' && result.design) {
        await copyFile(result.design.f3d, join(currentDir, 'design.f3d'));
        if (result.design.parameters) await copyFile(result.design.parameters, join(currentDir, 'parameters.json')).catch(() => undefined);
        design = {f3d: join('current', 'design.f3d'), ...(result.design.parameters ? {parameters: join('current', 'parameters.json')} : {})};
      }
      if (result.parts) await copyFile(result.parts, join(currentDir, 'model.3mf'));
      else await rm(join(currentDir, 'model.3mf'), {force: true});
      current = {model: join('current', result.parts ? 'model.3mf' : 'model.stl'), renders, ...(sizeMm ? {sizeMm} : {}), ...(summary ? {summary} : {}),
        ...(result.parts && result.partColours?.length ? {filaments: result.partColours} : {}),
        ...(result.changes?.length ? {changes: result.changes} : {}), ...(result.supports ? {supports: result.supports} : {}), engine, ...(design ? {design} : {})};
    }
    const ask = result.status === 'needs_closeup' ? await this.#ask(id, result) : undefined;
    const state: StmObject['state'] = result.status === 'needs_closeup' ? 'needs-closeup'
      : current && (result.status === 'done' || result.status === 'unchanged') ? 'ready' : 'failed';
    const failure = result.status === 'capped'
      ? `Stopped at the ${result.reason?.includes('time') ? 'time' : 'step'} limit. ${current ? 'Try again or review the saved checkpoint.' : 'Try again.'}`
      : result.reason ?? 'The touch-up stopped without a model.';
    const now = Date.now();
    // A changed model hasn't been shown to work yet: its first print asks "Did it fit?" again. A pass that
    // changed nothing leaves the outcome alone, and a Done project stays Done.
    const changed = !!current && result.status !== 'unchanged';
    const updated = await store.update(id, o => ({...(changed ? (({outcome: _outcome, ...rest}) => rest)(o) : o),
      state: state === 'ready' && !changed && o.outcome === 'works' ? 'confirmed' : state, progress: undefined,
      ...(current ? {current} : {}),
      ...(!o.title && result.title ? {title: result.title} : {}),
      ...(o.kind ? {} : {kind}),
      ...(ask ? {ask} : {}),
      ...(state === 'needs-closeup' ? {question: {closeup: result.closeup ?? result.ask?.question ?? 'a part of the object'}} : {}),
      ...(state === 'failed' ? {failure} : {}),
      passes: o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== startedAtMs ? {...p, ...(_estimate ? {estimate: _estimate} : {})} : {...p, endedAtMs: now, status: result.status,
        stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item),
        ...(result.engine ? {engine: result.engine} : {}), ...(result.note ? {engineNote: this.#publicText(result.note)} : {}),
        ...(state === 'failed' ? {activity: this.#activity(p.activity, [{atMs: Date.now(), kind: 'message', text: failure}])} : {}),
        ...(result.summary ? {summary: result.summary} : {}), seconds: result.stats.seconds,
        ...(result.stats.costUsd !== undefined ? {costUsd: result.stats.costUsd} : {}), dir: result.passDir})}));
    const saving = updated.passes.find(p => p.startedAtMs === startedAtMs)?.stages?.find(item => item.id === 'saving');
    if (saving?.endedAtMs !== undefined) void this.#deps.passTimings?.record(kind, result.engine ?? 'blender', 'saving', (saving.endedAtMs - saving.startedAtMs) / 1000).catch(() => undefined);
    const size = sizeText(updated.current?.sizeMm);
    if (state === 'ready') await this.#emit({id: randomUUID(), type: 'pass.ready', projectId: id, ...(size ? {detail: {size}} : {})});
    else if (state === 'needs-closeup') await this.#emit({id: randomUUID(), type: 'pass.ask', projectId: id, ...(ask ? {data: {askId: ask.id}} : {}),
      detail: {question: ask?.question ?? `Can you take a close-up of ${result.closeup ?? 'a part of the object'}?`}});
    else await this.#emit({id: randomUUID(), type: 'pass.failed', projectId: id, detail: {reason: updated.failure ?? 'The touch-up stopped without a model.'}});
    return this.#changed(updated);
  }

  /** The structured Ask: one question, the picture it is about (copied into asks/), and the answers allowed. */
  async #ask(id: string, result: TouchupResult & {passDir: string}): Promise<NonNullable<StmObject['ask']>> {
    const askId = randomUUID();
    const question = result.ask?.question ?? `Can you take a close-up of ${result.closeup ?? 'a part of the object'}?`;
    let photo: string | undefined;
    const name = result.ask?.photo;
    if (name && /\.(png|jpe?g)$/i.test(name)) {
      // Always asks/<id>.jpg (docs/protocols/objects-api.md): a PNG render is converted on the Mac.
      const target = join('asks', `${askId}.jpg`);
      for (const folder of ['photos', 'out']) {
        const source = join(result.passDir, folder, name);
        if (await mkdir(join(this.dir(id), 'asks'), {recursive: true}).then(() => askPicture(source, join(this.dir(id), target))).then(() => true, () => false)) { photo = target; break; }
      }
    }
    return {id: askId, question: question.slice(0, 300), ...(photo ? {photo} : {}), ...(photo && result.ask?.region ? {region: result.ask.region} : {}),
      answers: ['camera', 'photos', 'best-guess', 'text'], status: 'open', askedAtMs: Date.now()};
  }

  async #fail(id: string, startedAtMs: number, error: unknown): Promise<StmObject> {
    const message = this.#publicText(error instanceof Error ? error.message : String(error));
    console.error(`pass failed: project ${id}, pass ${new Date(startedAtMs).toISOString()}: ${message.replace(/\s+/g, ' ').slice(0, 600)}`);
    const now = Date.now();
    const updated = await this.#deps.store.update(id, o => ({...o, state: 'failed', failure: message, progress: undefined,
      passes: o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== startedAtMs ? {...p, ...(_estimate ? {estimate: _estimate} : {})} : {...p, endedAtMs: now, status: 'failed',
        stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item),
        activity: this.#activity(p.activity, [{atMs: now, kind: 'message', text: message}])})}));
    await this.#emit({id: randomUUID(), type: 'pass.failed', projectId: id, detail: {reason: message}});
    return this.#changed(updated);
  }

  #activity(previous: TouchupActivity[] = [], entries: TouchupActivity[]): TouchupActivity[] {
    const clean = entries.filter(entry => (entry.kind === 'message' || entry.kind === 'tool') && Number.isFinite(entry.atMs) && typeof entry.text === 'string')
      .map(entry => ({atMs: entry.atMs, kind: entry.kind, text: this.#publicText(entry.text)}))
      .filter(entry => entry.text.length > 0);
    return [...previous, ...clean].slice(-200);
  }

  #handoff(): PrinterHandoffConfig { return this.#deps.runningHandoff?.() ?? this.#deps.handoff; }
  #publicText(text: string): string { return publicTouchupText(text, {...process.env, ...this.#handoff().process.env}); }

  #changed(object: StmObject): StmObject { this.#deps.onChange?.(object); return object; }
}
