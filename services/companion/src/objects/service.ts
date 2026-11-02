import {copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {basename, extname, isAbsolute, join} from 'node:path';
import {DispatchedPrintError, PrinterMcpError, readPrintReport, routeArgs, sliceEstimate,
  type PrintProgress, type PendingElicitation, type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrintReport, type PrinterSession} from '@scan-to-make/printer-handoff';
import type {PrintEstimate, PrintSettings, ProjectStatus} from '@scan-to-make/contracts/counterpart';
import {PrintMonitorRunner, matchJob, milestonesFor, type EventDraft, type MonitorClock, type MonitorEnd, type MonitorTarget} from '../printing/monitor.js';
import {CameraFrames, CameraUnavailableError, type CameraFrame} from '../printing/camera.js';
import {PrinterUpdatingError, type PrintGate} from '../printing/print-gate.js';
import {sliceOverrides, settingsUnsupported} from '../printing/print-settings.js';
import type {CompanionSettingsStore} from '../settings.js';
import {PRINT_LOG, printEndFailure, projectTitle, sizeText} from '../events/words.js';
import {PassTimings, STAGE_DEFAULT_SEC, passEstimate, stageWords, type PassKind, type PassStage, type StageId} from '../touchup/stages.js';
import type {DesignEngine} from '../touchup/invocation.js';
import type {PrintHandoffServices} from '../print-handoff-http.js';
import {printQuestion, validateAnswer, type ConfirmationValue} from './confirmation.js';
import {InvalidStateError, SlicerRefusedError} from './errors.js';
import type {TouchupInput} from '../touchup/touchup.js';
import {publicTouchupText, type TouchupActivity, type TouchupResult} from '../touchup/runner.js';
import {ObjectNotFoundError, ObjectStore, type ObjectPrintConfirmation, type StmObject} from './store.js';
import {macReconstructRunner, type Reconstruct} from './reconstruct.js';
import type {PrinterCatalog} from './printers.js';
import type {PrinterDirectory, PublicDestination} from '../printing/directory.js';

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

export interface CaptureManifest {version: 1; images: string[]; depthRequired: boolean}

/** A file on this Mac that `objects.addFile` refuses: the sentence says why. */
export class InvalidFileError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidFileError'; }
}
const FILE_KINDS = {
  photos: {extensions: ['.jpg', '.jpeg', '.png', '.heic'], limit: 25 * 1024 * 1024, words: 'a JPEG, PNG or HEIC photo'},
  scan: {extensions: ['.stl', '.3mf', '.usdz'], limit: 64 * 1024 * 1024, words: 'an STL, 3MF or USDZ file'},
} as const;
/** The first bytes must agree with the extension. */
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
      || manifest.images.length < 1 || manifest.images.length > 10000
      || manifest.images.some(name => typeof name !== 'string' || !/^[0-9]{4}\.heic$/.test(name))
      || new Set(manifest.images).size !== manifest.images.length) throw new InvalidCaptureManifestError();
  return {version: 1, images: [...manifest.images].sort(), depthRequired: manifest.depthRequired};
}

function captureDigest(object: StmObject, depthRequired: boolean): string {
  return createHash('sha256').update(JSON.stringify({version: 1, depthRequired,
    images: [...(object.capture ?? [])].sort(), depth: [...(object.captureDepth ?? [])].sort()})).digest('hex');
}

export interface ObjectServiceDeps {
  store: ObjectStore;
  runTouchup: (input: TouchupInput) => Promise<TouchupResult & {passDir: string}>;
  /** Bounding box in millimetres, from the user's printer MCP (get_stl_info). */
  stlInfo: (stlPath: string) => Promise<[number, number, number] | undefined>;
  claudePath: string;
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
  /** Where print and pass events go (the event log, PRD §8.7). */
  events?: {emit(draft: EventDraft): Promise<void>};
  /** PRD §8.10: prints and MCP updates on a printer exclude each other. */
  printGate?: PrintGate;
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
export interface PrintOptions extends PrintSettings {checked?: boolean; filament?: FilamentChoice}
const BAMBU_TO_STATUS: Record<string, string> = {idle: 'IDLE', preparing: 'PREPARE', printing: 'RUNNING', paused: 'PAUSE', finished: 'FINISH', failed: 'FAILED', cancelled: 'FAILED', offline: 'OFFLINE', busy: 'UNKNOWN'};

export type ObjectPrintAnswer = {action: 'accept'; content: Record<string, ConfirmationValue>} | {action: 'decline' | 'cancel'; content?: never};
export interface FilamentChoice {slot: number; colour: string; material: string; name: string; filamentId: string; destinationId: string; suggested?: boolean}
type LiveFilament = FilamentChoice & {profile: string};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

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
 * PRD §8.9: a copy is cleaned up in Blender; a new design may use Fusion. Set at creation; otherwise a project
 * with a scan (LiDAR or a handheld capture) is a copy, even with a request ("Copy this. Close up the bottom."),
 * since the phone sends only the request; a request with photos alone is a new design.
 */
export function passKind(object: Pick<StmObject, 'kind' | 'scan' | 'capture' | 'instructions'>): PassKind {
  if (object.kind) return object.kind;
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

export class ObjectService {
  readonly #deps: ObjectServiceDeps;
  readonly #running = new Map<string, Promise<StmObject>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #confirmations = new Map<string, {pending: PendingElicitation; printing: NonNullable<ObjectServiceDeps['print']>; timer: ReturnType<typeof setTimeout>}>();
  readonly #cancelledPrints = new Set<string>();
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
  async settings() { return this.#deps.settings ? this.#deps.settings.load() : {milestones: '50' as const}; }
  async updateSettings(patch: {milestones?: 'off' | '50' | '25-50-75' | 'every-10'}) {
    if (!this.#deps.settings) throw new InvalidStateError('Settings are unavailable on this Mac.');
    return this.#deps.settings.update(patch);
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
    if (there && !(status === 'works' && object.pendingFollowup)) return object;
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if ((status === 'works' || status === 'printed') && !object.current) throw new InvalidStateError("There's no model yet, so it can't be marked printed.");
    const updated = await this.#deps.store.update(id, o => {
      const {outcome: _outcome, ...rest} = o;
      if (status === 'works') rest.pendingFollowup = undefined;
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

  create(instructions?: string, kind?: 'fit' | 'copy') { return this.#deps.store.create(instructions, kind).then(o => this.#changed(o)); }
  async list() {
    const objects = await Promise.all((await this.#deps.store.list()).map(o => this.get(o.id)));
    // Projects from before titles get one, once and in the background, the first time they're listed.
    // (A new project gets its title at its first pass, from the request as it is then.)
    for (const object of objects) if (object.state !== 'new') this.#title(object, {backfill: true});
    return objects;
  }
  readonly #printerReports = new Map<string, {atMs: number; value: Promise<{state: string; job?: string; checkedAtMs: number; percent?: number; remainingMinutes?: number} | undefined>}>();
  readonly #estimates = new Map<string, {seconds?: number; grams?: number}>();
  async get(id: string): Promise<StmObject> {
    let object = await this.#deps.store.get(id);
    if (object.state === 'touching-up') object = await this.#freshEstimate(object);
    if (!object.print) return object;
    // A watched print reads its monitor's last report instead of asking the printer again.
    if (object.print.live) {
      const live = object.print.live, active = ['preparing', 'printing', 'paused'].includes(live.state);
      object = {...object, print: {...object.print, printerStatus: {state: BAMBU_TO_STATUS[live.state] ?? 'UNKNOWN',
        ...(live.job?.name ? {job: live.job.name.slice(0, 160)} : {}), checkedAtMs: Date.parse(live.observedAt) || Date.now(),
        ...(active && live.job?.progress !== undefined ? {percent: live.job.progress} : {}),
        ...(active && live.job?.remainingSec !== undefined ? {remainingMinutes: Math.round(live.job.remainingSec / 60)} : {})}}};
      return object;
    }
    const printing = this.#deps.print;
    // A print recorded against a destination that has since become a duplicate reads through its winner.
    const recorded = object.print.destination?.id;
    const destinationId = recorded === undefined ? undefined : this.#deps.printerCatalog?.canonical(recorded) ?? recorded;
    const services = destinationId ? printing?.destinations?.get(destinationId) : printing?.services;
    if (services?.runner.status) {
      const key = destinationId ?? "default";
      let report = this.#printerReports.get(key);
      if (!report || Date.now() - report.atMs > 15000) {
        report = {atMs:Date.now(), value:services.runner.status(AbortSignal.timeout(5000)).then(value => {
          if (!record(value)) return undefined;
          const raw = record(value.raw) ? value.raw : {};
          const state = value.connected === false ? "OFFLINE" : String(raw.gcode_state ?? value.status ?? "UNKNOWN");
          const job = record(value.print) ? value.print.filename : raw.subtask_name;
          const active = ['RUNNING','PREPARE','PAUSE','SLICING'].includes(state.toUpperCase());
          const percent = record(value.print) ? value.print.progress : undefined;
          const remaining = record(value.print) ? (value.print.timeRemaining ?? value.print.remaining) : undefined;
          return {...(active && typeof percent === 'number' && percent >= 0 && percent <= 100 ? {percent} : {}),
            ...(active && typeof remaining === 'number' && remaining >= 0 ? {remainingMinutes:remaining} : {}), state:state.slice(0,40), ...(typeof job === "string" && job ? {job:job.slice(0,160)} : {}), checkedAtMs:Date.now()};
        }).catch(() => undefined)};
        this.#printerReports.set(key, report);
      }
      const printerStatus = await report.value;
      if (printerStatus) object = {...object, print:{...object.print!, printerStatus}};
    }
    if (object.print!.estimate) return object;
    const bundleId = object.print!.bundleId;
    let estimate = this.#estimates.get(bundleId);
    if (!estimate) {
      if (services) try {
        const manifest = await services.store.read(bundleId);
        if (manifest.artifacts.sliced) estimate = await sliceEstimate(await readFile(join(services.store.directory(bundleId), manifest.artifacts.sliced.file)), manifest.selection?.plateIndex ?? 0);
        if (estimate) this.#estimates.set(bundleId, estimate);
      } catch { /* Missing historical artifacts do not hide the project. */ }
    }
    return estimate ? {...object, print:{...object.print!, sliced:true, estimate}} : object;
  }
  dir(id: string) { return this.#deps.store.dir(id); }

  async passActivity(id: string, index: number): Promise<TouchupActivity[]> {
    if (!Number.isSafeInteger(index) || index < 0) throw new ObjectNotFoundError();
    const pass = (await this.get(id)).passes[index];
    if (!pass) throw new ObjectNotFoundError();
    return pass.activity ?? [];
  }

  printers(options: {view?: boolean} = {}): {defaultDestinationId?: string; destinations: PublicDestination[]} {
    if (this.#deps.printers) {
      const listed = this.#deps.printers.list();
      // A printer view opened: warm each camera that has one, so its first frame doesn't wait on a cold session.
      if (options.view) for (const destination of listed.destinations)
        if (destination.capabilities?.camera !== 'none') this.#warmCamera(destination.id);
      return listed;
    }
    const catalog = this.#deps.printerCatalog;
    return {defaultDestinationId: catalog?.defaultDestinationId, destinations: catalog?.destinations.map(({id, name, backend, model, address, source, origin}) =>
      ({id, name, backend, ...(model ? {model} : {}), ...(address ? {address} : {}), source, ...(origin ? {origin} : {})})) ?? []};
  }

  /** The listed destination an object's choice stands for now (a duplicate resolves to its winner). */
  #destinationId(object: StmObject): string | undefined {
    const catalog = this.#deps.printerCatalog;
    const chosen = object.printerDestinationId ?? catalog?.defaultDestinationId;
    return chosen === undefined ? undefined : catalog?.canonical(chosen) ?? chosen;
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

  private async liveFilaments(id: string): Promise<LiveFilament[]> {
    const object = await this.get(id), configured = this.#deps.print;
    const destinationId = this.#destinationId(object);
    const services = destinationId ? configured?.destinations?.get(destinationId) : configured?.services;
    if (!services || services.runner.backend !== 'bambu-printer-mcp' || !services.runner.filaments) throw new InvalidStateError('Filament choices are unavailable for this printer. Open the model in your slicer to choose a material.');
    let inventory: unknown;
    try { inventory = await services.runner.filaments(); }
    catch { throw new InvalidStateError('Couldn’t read the printer’s filament. Check its connection and try again.'); }
    if (!record(inventory) || !Array.isArray(inventory.trays)) throw new InvalidStateError('The printer did not return a filament inventory.');
    return inventory.trays.flatMap((tray: unknown): LiveFilament[] => {
      if (!record(tray) || tray.loaded !== true || !Number.isSafeInteger(tray.slot) || (tray.slot as number) < 0
          || typeof tray.tray_color !== 'string' || !/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(tray.tray_color)
          || typeof tray.tray_type !== 'string' || !tray.tray_type || tray.tray_type.length > 128 || typeof tray.tray_info_idx !== 'string' || tray.tray_info_idx.length > 128
          || typeof tray.resolved_profile_path !== 'string' || !tray.resolved_profile_path.startsWith('/')) return [];
      return [{slot:tray.slot as number, colour:'#' + tray.tray_color.slice(0,6).toUpperCase(), material:tray.tray_type,
        filamentId:tray.tray_info_idx, destinationId:destinationId ?? 'default', name:typeof tray.display_name === 'string' ? tray.display_name.slice(0,256) : tray.tray_type,
        profile:tray.resolved_profile_path}];
    });
  }

  /** Live filaments; `suggested` marks the preselected one: the configured material's first loaded tray, else the first tray. */
  async filaments(id: string): Promise<FilamentChoice[]> {
    const live = await this.liveFilaments(id), object = await this.get(id);
    const destinationId = this.#destinationId(object);
    const material = (destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services)?.selection?.material?.toLowerCase();
    const pick = live.find(item => material && item.material.toLowerCase() === material) ?? live[0];
    return live.map(({profile: _profile, ...choice}) => ({...choice, ...(choice === pick || (pick && choice.slot === pick.slot) ? {suggested: true} : {})}));
  }

  selectPrinter(id: string, destinationId: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id), catalog = this.#deps.printerCatalog;
      if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes before changing printers.');
      const chosen = catalog?.canonical(destinationId);
      if (!chosen || !catalog?.destinations.some(destination => destination.id === chosen) || !catalog.resolve(chosen))
        throw new InvalidStateError('That printer is no longer available. Choose another printer.');
      return this.#changed(await this.#deps.store.update(id, o => ({...o, printerDestinationId: chosen})));
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
      if (object.captureCompletion) await this.#deps.store.update(id, o => ({...o, captureCompletion: undefined}));
      await this.#deps.store.addFile(id, 'capture', name, bytes);
      return this.#changed(await this.#deps.store.update(id, o => {
        const capture = o.capture ?? [];
        return {...o, capture: capture.includes(name) ? capture : [...capture, name], captureCompletion: undefined};
      }));
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
  async addPhoto(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    await this.get(id);
    await this.#deps.store.addFile(id, 'photos', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, photos: o.photos.includes(name) ? o.photos : [...o.photos, name]})));
  }

  /**
   * Copies a file on this Mac into the object (the Mac app's New Project and drop targets).
   * The control socket can't carry file bytes, so the companion reads the path itself.
   */
  addFile(id: string, kind: 'photos' | 'scan', path: string): Promise<StmObject> {
    // One at a time per object, so two files with the same name can't take the same slot.
    return this.#gate(id, () => this.#addFile(id, kind, path));
  }
  async #addFile(id: string, kind: 'photos' | 'scan', path: string): Promise<StmObject> {
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
    if (kind === 'scan') return this.addScan(id, `scan${extension}`, bytes);
    return this.addPhoto(id, photoName(path, (await this.get(id)).photos), bytes);
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
      await this.#captureFilesPresent(object);
      const sha256 = captureDigest(object, manifest.depthRequired);
      const same = object.captureCompletion?.sha256 === sha256 && object.captureCompletion.depthRequired === manifest.depthRequired;
      if (same && ['touching-up', 'needs-closeup', 'ready', 'printing', 'printed'].includes(object.state)) return object;
      if (!same) {
        if (object.state !== 'new' && object.state !== 'failed') throw new InvalidStateError('Wait until the current step finishes.');
        object = await this.#deps.store.update(id, o => ({...o, captureCompletion: {
          version: 1, depthRequired: manifest.depthRequired, frameCount: manifest.images.length, sha256, completedAtMs: Date.now(),
        }}));
      }
    }
    // Photos only show what something looks like; without a scan, the description says what to make.
    if (!object.scan && !object.capture?.length && !object.captureDepth?.length && !object.instructions?.trim() && object.state === 'new')
      throw new InvalidStateError('Describe what to make, or add a scan.');
    // A touch-up works from photos; a model with neither photos nor a request has nothing to go on.
    if (object.scan && !object.photos.length && !object.capture?.length && !object.instructions?.trim() && (object.state === 'new' || object.state === 'failed'))
      throw new InvalidStateError("Add photos of it, or describe what you'd like changed.");
    if (object.state === 'touching-up') return object;
    if (object.state === 'needs-closeup') return this.#pass(object, {});
    if (object.state !== 'new' && object.state !== 'failed') throw new InvalidStateError('This object has already been touched up.');
    return this.#pass(object, {});
  }

  async #captureFilesPresent(object: StmObject): Promise<void> {
    // Names came from the validated manifest or its bound completion marker, never a caller path.
    const names = [...(object.capture ?? []), ...(object.captureDepth ?? [])];
    for (let offset = 0; offset < names.length; offset += 32) {
      const present = await Promise.all(names.slice(offset, offset + 32).map(async name => {
        if (!/^[0-9]{4}\.(heic|depth\.plist)$/.test(name)) return false;
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
        || complete.sha256 !== captureDigest(object, complete.depthRequired)) throw new InvalidStateError(CAPTURE_PENDING);
    await this.#captureFilesPresent(object);
  }

  /** Asks for changes; `photos` are files on this Mac added first (the Mac app's drop target). */
  correct(id: string, note: string, photos: string[] = []): Promise<StmObject> { return this.#gate(id, () => this.#correct(id, note, photos)); }
  async #correct(id: string, note: string, photos: string[]): Promise<StmObject> {
    let object = await this.get(id);
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if (!object.current && object.state !== 'failed') throw new InvalidStateError('There is no model to correct yet.');
    // A success report is a project outcome, not a request to change its mesh (PRD §5.4).
    // Attached evidence still takes the normal pass path; the classifier only handles text-only reports.
    if (object.current && !photos.length && !object.question && object.ask?.status !== 'open' && this.#deps.reportsCompletion) {
      const intent = await this.#deps.reportsCompletion(note).catch(() => 'unknown' as const);
      if (intent === 'unknown') {
        const saved = await this.#deps.store.update(id, o => ({...o, pendingFollowup: note.trim()}));
        this.#changed(saved);
        await this.#emit({id: randomUUID(), type: 'project.updated', projectId: id, data: {keys: ['pendingFollowup']}});
        throw new InvalidStateError("Your message is saved, but I couldn't tell whether it marks Done or asks for changes. Try sending it again, or set Status to Done.");
      }
      if (intent === 'works') {
        const previousStatus = projectStatus(object);
        await this.#deps.store.update(id, o => ({...o, pendingFollowup: undefined, completion: {note: note.trim(), atMs: Date.now(), previousStatus}}));
        return this.#setStatusNow(id, 'works');
      }
    }
    for (const path of photos) object = await this.#addFile(id, 'photos', path);
    // New photos sent with the request make it a late-photos pass.
    return this.#pass(object, {note: note.trim(), trigger: photos.length ? 'late-photos' : 'changes'});
  }

  /** Answers the open Ask: with a photo (uploaded first), Best guess, or the person's own words. */
  answerCloseup(id: string, answer: {bestGuess?: boolean; text?: string}): Promise<StmObject> { return this.#gate(id, () => this.#answerCloseup(id, answer)); }
  async #answerCloseup(id: string, answer: {bestGuess?: boolean; text?: string}): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'needs-closeup') throw new InvalidStateError('No close-up was asked for.');
    // Carry on with what the asking pass was doing: a correction keeps its note and its model.
    const asked = object.passes.at(-1)?.note;
    const said = answer.text?.trim() ? `Answer to "${object.ask?.question ?? object.question?.closeup ?? 'your question'}": ${answer.text.trim()}` : undefined;
    const parts = [asked, said, answer.bestGuess && !asked?.includes(BEST_GUESS_NOTE) ? BEST_GUESS_NOTE : undefined].filter(Boolean);
    if (object.ask) await this.#deps.store.update(id, o => o.ask ? {...o, ask: {...o.ask, status: 'answered'}} : o);
    return this.#pass(await this.get(id), {...(parts.length ? {note: parts.join('\n')} : {}), trigger: 'ask-answer'});
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

  /** Prints the current model through the user's printer MCP. */
  print(id: string, options: PrintOptions = {}): Promise<StmObject> { return this.#gate(id, () => this.#print(id, options)); }
  async #print(id: string, options: PrintOptions): Promise<StmObject> {
    const object = await this.get(id);
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
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
    const {selection: selected, slicer} = await this.#colour(id, options, services.selection, runner.backend);
    const overrides = sliceOverrides(options, selected?.nozzleDiameterMm);
    const capabilities = destinationId ? this.#deps.printers?.capabilities(destinationId) : undefined;
    if (capabilities && ((overrides.layerHeightMm !== undefined && !capabilities.quality) || (overrides.wallLoops !== undefined && !capabilities.strength)
        || (overrides.repetitions !== undefined && overrides.repetitions > 1 && !capabilities.copies)))
      throw new InvalidStateError(settingsUnsupported(runner.backend, options));
    const settings: PrintSettings = {...(options.quality ? {quality: options.quality} : {}), ...(options.strength ? {strength: options.strength} : {}),
      ...(options.colour ? {colour: options.colour} : {}), ...(options.copies && options.copies > 1 ? {copies: options.copies} : {})};
    const sliced = {...slicer, ...overrides};
    const stl = await readFile(join(this.#deps.store.dir(id), object.current.model));
    const manifest = await bundles.create({stl, prompt: '', backend: runner.backend, ...(selected ? {selection:selected} : {})});
    const printId = randomUUID();
    const print = {bundleId: manifest.id, printId, ...(printDestination ? {destination: printDestination, destinationId: printDestination.id} : {}),
      ...(Object.keys(settings).length ? {settings} : {})};
    // PRD §8.10: held from here until the dispatch ends, so the printer's MCP isn't updated under it.
    let release: () => void = () => undefined;
    try { release = this.#deps.printGate?.hold(gated) ?? release; }
    catch (error) { throw error instanceof PrinterUpdatingError ? new InvalidStateError(error.message) : error; }
    const started = await this.#deps.store.update(id, o => ({...o, state: 'printing', progress: 'Connecting to your printer service…', print, printConfirmation: undefined, failure: undefined}))
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
      'resolving-printer-error':'The printer needs your acknowledgment of its rejected command.',
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
    const work = runner.runBundle(bundles, manifest.id, {print: true, signal: controller.signal, onProgress,
      ...(Object.keys(sliced).length ? {slicer: sliced} : {})})
      .then(outcome => this.#dispatched(id, manifest.id, printDestination?.id ?? destinationId, (outcome as {result?: {dispatch?: {jobName?: string; taskId?: string; fileBase?: string}}} | undefined)?.result?.dispatch, selected?.connectionMode),
        async error => {
          const status = (await bundles.read(manifest.id).catch(() => undefined))?.status;
          // Once the printer has the job it is printing, whatever went wrong afterwards (as the phone's print route does).
          if (error instanceof DispatchedPrintError || status === 'printed') return this.#dispatched(id, manifest.id, printDestination?.id ?? destinationId, undefined, selected?.connectionMode);
          // It may have reached the printer: never send it again by itself.
          if (status === 'uncertain') return this.#deps.store.update(id, o => ({...o, state: 'failed', printConfirmation: undefined, progress: undefined, failure: error instanceof PrinterMcpError && error.detail ? `Printer service: ${error.detail} Counterpart could not confirm a print start. Check the printer before trying again.` : UNCERTAIN, print: {...o.print!, uncertain: true}}));
          if (this.#cancelledPrints.has(id)) return this.#deps.store.update(id, o => ({...o, state: 'ready', progress: undefined, printConfirmation: undefined, failure: undefined}));
          if (this.#expiredConfirmations.has(id) || (this.#confirmations.get(id)?.pending.expiresAtMs ?? Infinity) <= Date.now())
            return this.#deps.store.update(id, o => ({...o, state: 'failed', progress: undefined, printConfirmation: undefined, failure: 'Printer confirmation timed out; no print was sent. Press Print to try again.'}));
          if (error instanceof PrinterMcpError && error.code === 'print-settings-unsupported')
            return this.#deps.store.update(id, o => ({...o, state: 'ready', progress: undefined, printConfirmation: undefined, failure: settingsUnsupported(runner.backend, options)}));
          return this.#deps.store.update(id, o => ({...o, state: 'failed', progress: undefined, printConfirmation: undefined, failure: error instanceof PrinterMcpError && error.detail ? error.detail : error instanceof Error ? error.message : String(error)}));
        })
      .then(o => this.#changed(o))
      .finally(() => {
        release();
        unsubscribe(); this.#running.delete(id); this.#controllers.delete(id);
        clearTimeout(this.#confirmations.get(id)?.timer); this.#confirmations.delete(id);
        this.#cancelledPrints.delete(id);
        this.#expiredConfirmations.delete(id);
      });
    this.#running.set(id, work);
    return this.#changed(started);
  }

  /** The print sheet's colour, as the MCP's own selection and slicing options (PRD §8.5 colour v1). */
  async #colour(id: string, options: PrintOptions, selection: PrinterSelection | undefined, backend: PrinterHandoffConfig['backend'])
    : Promise<{selection?: PrinterSelection; slicer?: PrinterSlicer}> {
    if (options.filament) {
      const choice = options.filament;
      const live = (await this.liveFilaments(id)).find(item => item.slot === choice.slot && item.colour === choice.colour
        && item.material === choice.material && item.filamentId === choice.filamentId && item.destinationId === choice.destinationId);
      if (!live) throw new InvalidStateError('The chosen filament changed. Choose a current spool and try again.');
      return {selection: {...selection, material:live.material, useAms:live.slot !== 254 && live.slot !== 255, amsSlots:[live.slot], amsMapping:undefined, autoMatchAms:false},
        slicer: {loadFilaments:live.profile, filamentColours:live.colour}};
    }
    const colour = options.colour;
    if (!colour) return {...(selection ? {selection} : {})};
    if ('auto' in colour) return backend === 'bambu-printer-mcp'
      ? {selection: {...selection, useAms: true, autoMatchAms: true, amsSlots: undefined, amsMapping: undefined}} : {...(selection ? {selection} : {})};
    if ('material' in colour) {
      // "What's loaded?" (PRD §8.4–8.5): the person says which material is in the printer.
      const material = colour.material.trim();
      if (backend === 'bambu-printer-mcp') {
        const live = await this.liveFilaments(id).catch(() => [] as LiveFilament[]);
        const match = live.find(item => item.material.toLowerCase() === material.toLowerCase());
        // A loaded spool of that material: print from it with its own profile.
        if (match) return {selection: {...selection, material: match.material, useAms: match.slot !== 254 && match.slot !== 255,
          amsSlots: [match.slot], amsMapping: undefined, autoMatchAms: false}, slicer: {loadFilaments: match.profile, filamentColours: match.colour}};
        // No spool reports it (the external spool counts once the printer knows its type): there is no profile to
        // slice it with, and slicing with the preset's filament would print the wrong material's settings.
        throw new InvalidStateError(`The printer doesn't report a ${material} spool. Set the external spool to ${material} on the printer, or load ${material} in the AMS, then try again.`);
      }
      // mcp-3D-printer-server: sliced with the profile its filament report gives for that material. Without one,
      // only the configured material (what the MCP's own preset is for) can be declared without a profile.
      const profile = await this.#genericProfile(id, material);
      if (profile) return {selection: {...selection, material}, slicer: {loadFilaments: profile}};
      const configured = selection?.material?.trim();
      if (configured && configured.toLowerCase() === material.toLowerCase()) return {selection: {...selection, material: configured}};
      throw new InvalidStateError(`mcp-3D-printer-server doesn't give a slicing profile for ${material} on this printer, so Counterpart can't slice for it. ${configured ? `Choose ${configured}, the configured material, or update` : 'Update'} mcp-3D-printer-server.`);
    }
    const live = await this.liveFilaments(id);
    if ('external' in colour) {
      const tray = live.find(item => item.slot === 254 || item.slot === 255);
      return {selection: {...selection, useAms: false, amsSlots: undefined, amsMapping: undefined, autoMatchAms: false, ...(tray ? {material: tray.material} : {})},
        ...(tray ? {slicer: {loadFilaments: tray.profile, filamentColours: tray.colour}} : {})};
    }
    const tray = live.find(item => item.slot === colour.amsSlot);
    if (!tray) throw new InvalidStateError('That AMS slot is empty now. Choose a loaded spool and try again.');
    return {selection: {...selection, material: tray.material, useAms: true, amsSlots: [tray.slot], amsMapping: undefined, autoMatchAms: false},
      slicer: {loadFilaments: tray.profile, filamentColours: tray.colour}};
  }

  /**
   * The printer MCP accepted the print. "Printed" now means printed (PRD §8.5):
   * when the destination can report this job, the object stays `printing` and
   * the monitor sets `printed` when the job finishes. A destination that can't
   * report jobs (an older mcp-3D-printer-server) ends here, as before.
   */
  async #dispatched(id: string, bundleId: string, destinationId: string | undefined, dispatch: {jobName?: string; taskId?: string; fileBase?: string} | undefined,
    route?: PrinterSelection['connectionMode']): Promise<StmObject> {
    const session = destinationId ? this.#deps.printers?.session(destinationId) : undefined;
    const reports = !!session && (session.hasTool('counterpart_print_progress') || (session.backend === 'bambu-printer-mcp' && session.hasTool('get_printer_status')));
    const identified = !!(dispatch?.jobName || dispatch?.taskId);
    // Bambu Connect only opens the job on the Mac: the person presses Print there.
    const bambuConnect = route === 'bambu_connect';
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
      fallback: !session.hasTool('counterpart_print_progress'),
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
        const line = draft.type === 'print.milestone' && draft.data?.progress !== 50 ? `${draft.data?.progress}% done.` : PRINT_LOG[draft.type];
        if (line) this.#changed(await this.#deps.store.update(id, o => ours(o) ? {...o, print: {...o.print!, events: [...(o.print!.events ?? []), {atMs: Date.now(), message: line}].slice(-20)}} : o));
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
    for (const object of await this.#deps.store.list()) {
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

  async #emit(draft: EventDraft): Promise<void> { await this.#deps.events?.emit(draft).catch(() => undefined); }

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

  /** A client opened this project: while it prints (or the printer asks something), warm its printer's camera. */
  async view(id: string): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state === 'printing' || object.printConfirmation) {
      const destinationId = object.print?.destinationId ?? object.print?.destination?.id ?? this.#destinationId(object);
      if (destinationId) this.#warmCamera(destinationId);
    }
    return object;
  }
  #warmCamera(destinationId: string): void {
    const session = this.#deps.printers?.session(destinationId);
    if (session) this.#deps.camera?.warm(this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId, session, {model: session.config.selection?.model});
  }

  /** The camera of the project's printer (the one printing it, else its chosen one). */
  async camera(id: string): Promise<CameraFrame> {
    const object = await this.get(id);
    const destinationId = object.state === 'printing' ? object.print?.destinationId ?? object.print?.destination?.id ?? this.#destinationId(object) : this.#destinationId(object);
    if (!destinationId) throw new CameraUnavailableError('no-camera');
    return this.printerCamera(destinationId);
  }
  async printerCamera(destinationId: string): Promise<CameraFrame> {
    const session = this.#deps.printers?.session(destinationId), camera = this.#deps.camera;
    if (!session || !camera) throw new CameraUnavailableError('no-camera');
    return camera.frame(this.#deps.printerCatalog?.canonical(destinationId) ?? destinationId, session, {model: session.config.selection?.model, view: true});
  }

  /** Pause, resume or stop this project's print, through the destination's mutex (PRD §8.6). */
  /**
   * Not under the object's gate: the printer MCP may ask its own confirmation
   * during the call, and answering it goes through that gate. Two taps are still
   * one at a time, behind the destination's mutex.
   */
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<StmObject> {
    if (this.#closed) throw new InvalidStateError('Counterpart is shutting down on this Mac.');
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
    if (!session.hasTool(tool)) throw new InvalidStateError(`Update ${session.backend === 'bambu-printer-mcp' ? 'bambu-printer-mcp' : 'mcp-3D-printer-server'} to ${action === 'cancel' ? 'stop' : action} prints from Counterpart.`);
    // The printer MCP's own confirmation, if it asks, is relayed like Print's.
    const printing = {...this.#deps.print!, services};
    const unsubscribe = services.relay.subscribe(pending => {
      if (pending.bundleId === print.bundleId) void this.#confirm(id, pending, printing).catch(() => { services.relay.respond(pending.id, {action: 'cancel'}); });
    });
    const target = {...(print.taskId ? {taskId: print.taskId} : {}), ...(print.jobName ? {jobName: print.jobName} : {})};
    let notOurs = false;
    try {
      const properties = (session.getTool(tool).inputSchema as {properties?: Record<string, unknown>}).properties;
      const args = Object.fromEntries(Object.entries(routeArgs(session.config)).filter(([key, value]) => value !== undefined && (!properties || Object.hasOwn(properties, key))));
      await session.exclusive(async () => {
        // The printer's controls act on whatever it is printing now: make sure that is still this project.
        const report = await readPrintReport(session, {failFast: true});
        if (matchJob(target, report) !== 'ours' || !['preparing', 'printing', 'paused'].includes(report.state)) { notOurs = true; return; }
        const result = await session.call(tool, args, {held: true, elicitationContext: {bundleId: print.bundleId}, timeoutMs: 120_000});
        if (result.isError) throw new PrinterMcpError('tool-failed', undefined, (result.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join(' ').trim().slice(0, 300) || undefined);
      });
    } catch (error) {
      const detail = error instanceof PrinterMcpError ? error.detail : undefined;
      throw new InvalidStateError(detail ? `The printer didn't ${action === 'cancel' ? 'stop' : action}: ${detail}` : `The printer didn't ${action === 'cancel' ? 'stop' : action}. Check it, then try again.`);
    } finally {
      unsubscribe();
      clearTimeout(this.#confirmations.get(id)?.timer); this.#confirmations.delete(id);
    }
    if (notOurs) throw new InvalidStateError(`The printer isn't printing ${projectTitle(object)} any more, so nothing was sent.`);
    const line = {pause: 'Pause sent.', resume: 'Resume sent.', cancel: 'Stop sent.'}[action];
    return this.#changed(await this.#deps.store.update(id, o => ({...o, printConfirmation: undefined,
      ...(o.print ? {print: {...o.print, events: [...(o.print.events ?? []), {atMs: Date.now(), message: line}].slice(-20)}} : {})})));
  }

  readonly #estimates2 = new Map<string, Promise<PrintEstimate>>();
  /** Slices the current model with the print sheet's settings, exactly as Print would, and reads the estimate. Never prints. */
  async estimate(id: string, request: {destinationId?: string; quality?: PrintSettings['quality']; strength?: PrintSettings['strength']; copies?: number} = {}): Promise<PrintEstimate> {
    const object = await this.get(id);
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
    const catalog = this.#deps.printerCatalog;
    const destinationId = request.destinationId ? catalog?.canonical(request.destinationId) : this.#destinationId(object);
    if (request.destinationId && !destinationId) throw new InvalidStateError('That printer is no longer available. Choose another printer.');
    const services = destinationId ? this.#deps.print?.destinations?.get(destinationId) : this.#deps.print?.services;
    if (!services?.runner.estimate) throw new InvalidStateError('Estimates are unavailable for this printer.');
    const quality = request.quality ?? 'standard', strength = request.strength ?? 'standard';
    const copies = request.copies && request.copies > 1 ? request.copies : undefined;
    // Exactly as Print: named copies (1 included) override the printer config's own repetitions.
    const overrides = sliceOverrides({quality, strength, ...(request.copies !== undefined ? {copies: request.copies} : {})}, services.selection?.nozzleDiameterMm);
    const capabilities = destinationId ? this.#deps.printers?.capabilities(destinationId) : undefined;
    if (capabilities && ((overrides.layerHeightMm !== undefined && !capabilities.quality) || (overrides.wallLoops !== undefined && !capabilities.strength)
        || (copies && !capabilities.copies)))
      throw new InvalidStateError(settingsUnsupported(services.runner.backend, {quality, strength, ...(copies ? {copies} : {})}));
    const model = await readFile(join(this.dir(id), object.current.model));
    const key = JSON.stringify([createHash('sha256').update(model).digest('hex'), destinationId ?? 'default', quality, strength, request.copies ?? 'configured']);
    let running = this.#estimates2.get(key);
    if (!running) {
      const runner = services.runner;
      running = (async () => {
        const work = await mkdtemp(join(tmpdir(), 'counterpart-estimate-'));
        try {
          const stlPath = join(work, 'model.stl');
          await writeFile(stlPath, model);
          const {estimate, settings, slicerWarning} = await runner.estimate!({stlPath, ...(services.selection ? {selection: services.selection} : {}), ...(Object.keys(overrides).length ? {slicer: overrides} : {}),
            signal: AbortSignal.timeout(150_000)});
          return {destinationId: destinationId ?? 'current', quality, strength, ...(copies ? {copies} : {}),
            ...(estimate?.seconds !== undefined ? {seconds: estimate.seconds} : {}), ...(estimate?.grams !== undefined ? {grams: estimate.grams} : {}),
            ...(settings.layers !== undefined ? {layers: settings.layers} : {}), ...(settings.layerHeightMm !== undefined ? {layerHeightMm: settings.layerHeightMm} : {}),
            ...(settings.infillPercent !== undefined ? {infillPercent: settings.infillPercent} : {}), ...(settings.wallLoops !== undefined ? {wallLoops: settings.wallLoops} : {}),
            // Bambu Studio's own warning on this slice, word for word (KAN-223). Print asks "Print anyway" with the same words.
            ...(slicerWarning ? {slicerWarning} : {}),
            slicedAt: new Date().toISOString()};
        } finally { await rm(work, {recursive: true, force: true}).catch(() => undefined); }
      })();
      this.#estimates2.set(key, running);
      // Failures aren't kept; a new model has a new key, so stale estimates are never served.
      running.catch(() => { if (this.#estimates2.get(key) === running) this.#estimates2.delete(key); });
      if (this.#estimates2.size > 64) this.#estimates2.delete(this.#estimates2.keys().next().value!);
    }
    try { return structuredClone(await running); }
    catch (error) {
      if (error instanceof PrinterMcpError && error.code === 'print-settings-unsupported') throw new InvalidStateError(settingsUnsupported(services.runner.backend, {quality, strength}));
      // Bambu Studio refused the slice: its own words, exactly what a Print of the same model fails with.
      if (error instanceof PrinterMcpError && error.code === 'slicer-error' && error.detail) throw new SlicerRefusedError(error.detail);
      throw new InvalidStateError(error instanceof PrinterMcpError && error.detail ? `Couldn't slice it for an estimate: ${error.detail}` : "Couldn't slice it for an estimate. Check the printer service, then try again.");
    }
  }


  answerPrintConfirmation(id: string, confirmationId: string, answer: unknown): Promise<StmObject> {
    return this.#gate(id, async () => {
      const confirmation = this.#confirmations.get(id);
      if (!confirmation || confirmation.pending.id !== confirmationId || !this.#pending(id, confirmationId))
        throw new InvalidStateError('That printer confirmation is no longer waiting. Refresh the project.');
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
      } else throw new InvalidStateError('This printer question cannot be approved here. Cancel it and use a supported confirmation form.');
      // Declining Print's own question cancels that print; declining a pause or stop question changes nothing else.
      if (checked.action !== 'accept' && this.#running.has(id)) this.#cancelledPrints.add(id);
      if (!confirmation.printing.services.relay.respond(confirmationId, checked)) {
        this.#cancelledPrints.delete(id);
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

  async #pass(object: StmObject, opts: {note?: string; trigger?: NonNullable<StmObject['passes'][number]['trigger']>}): Promise<StmObject> {
    // Design/cleanup workers use the current MCP too. Reserve before any await so an update cannot
    // swap its files while this pass is admitted, queued, running, saving, or closing its helper.
    let release = () => {};
    try { release = this.#deps.printGate?.hold('current') ?? release; }
    catch (error) { if (error instanceof PrinterUpdatingError) throw new InvalidStateError(error.message); throw error; }
    try { return await this.#reservedPass(object, opts, release); }
    catch (error) { release(); throw error; }
  }

  async #reservedPass(object: StmObject, opts: {note?: string; trigger?: NonNullable<StmObject['passes'][number]['trigger']>}, release: () => void): Promise<StmObject> {
    await this.#requireCaptureCompletion(object);
    const store = this.#deps.store, dir = store.dir(object.id);
    const fromCurrent = opts.note !== undefined && object.current !== undefined;
    // A handheld scan is rebuilt into scan/scan.usdz first, once; its photos also show the touch-up the object.
    const build = !fromCurrent && !object.scan && (object.capture?.length ?? 0) > 0;
    const capturePhotos = (object.capture ?? []).map(name => join(dir, 'capture', name));
    const photos = spreadPick([...object.photos.map(name => join(dir, 'photos', name)), ...capturePhotos], PHOTOS_PER_PASS);
    const startedAtMs = Date.now();
    // PRD §8.9: copies are cleaned up in Blender; a new design may use Fusion (the touch-up decides).
    const kind: PassKind = passKind(object);
    const plan: StageId[] = [...(build ? ['building' as const] : []), 'preparing', 'working', 'saving'];
    let engine: DesignEngine = 'blender';
    let typical = await this.#typical(kind, engine);
    const first: PassStage = {id: plan[0]!, words: stageWords(plan[0]!, engine, kind), startedAtMs, typicalSec: typical[plan[0]!]};
    const running = await store.update(object.id, o => ({...o, state: 'touching-up', question: undefined, failure: undefined, pendingFollowup: undefined,
      ...(o.completion ? {completion: {...o.completion, undone: true}} : {}),
      ...(build ? {progress: 'Building the model from your photos.'} : {progress: undefined}),
      passes: [...o.passes, {startedAtMs, trigger: opts.trigger ?? 'new', stages: [first], estimate: passEstimate([first], plan, typical, startedAtMs),
        ...(opts.note ? {note: opts.note} : {})}]}));
    this.#changed(running);
    await this.#emit({id: randomUUID(), type: 'pass.started', projectId: object.id, data: {stage: first.words, estimateSec: passEstimate([first], plan, typical, startedAtMs).remainingSec}});
    this.#title(running);
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
    const work = (async () => {
      let scanName = object.scan;
      if (build) scanName = await this.#build(object.id, dir, controller.signal);
      const scan = fromCurrent ? [join(dir, object.current!.model)] : scanName ? [join(dir, 'scan', scanName)] : [];
      const input: TouchupInput = {root: join(dir, 'passes'), objectId: 'pass', scan, photos, currentModel: fromCurrent, handoff: this.#handoff(), claudePath: this.#deps.claudePath,
        kind, onStage: (id, chosen) => stage(id, chosen),
        ...(fromCurrent && object.current?.engine === 'fusion' && object.current.design
          ? {design: {f3d: join(dir, object.current.design.f3d), ...(object.current.design.parameters ? {parameters: join(dir, object.current.design.parameters)} : {})}} : {}),
        ...(object.instructions ? {instructions: object.instructions} : {}),
        ...(opts.note !== undefined ? {note: opts.note, ...(object.current?.summary ? {summary: object.current.summary} : {})} : {})};
      try { return await this.#deps.runTouchup({...input, signal: controller.signal, onProgress}); }
      finally { stage('saving'); await writing; }
    })()
      .then(result => this.#finish(object.id, startedAtMs, result, kind), error => this.#fail(object.id, startedAtMs, error))
      .finally(() => { release(); this.#running.delete(object.id); this.#controllers.delete(object.id); });
    this.#running.set(object.id, work);
    return running;
  }

  /** Rebuilds a handheld scan on this Mac, showing progress in words, and records it as the object's scan. */
  async #build(id: string, dir: string, signal: AbortSignal): Promise<string> {
    const reconstruct = this.#deps.reconstruct ?? macReconstructRunner();
    const store = this.#deps.store;
    let shownAt = 0, pending: string | undefined, writing = Promise.resolve();
    const show = (words: string) => {
      pending = words;
      if (Date.now() - shownAt < 1000) return;   // at most one update a second
      shownAt = Date.now();
      writing = writing.then(async () => { this.#changed(await store.update(id, o => ({...o, progress: pending}))); }).catch(() => undefined);
    };
    await mkdir(join(dir, 'scan'), {recursive: true});
    await reconstruct({photosDir: join(dir, 'capture'), output: join(dir, 'scan', 'scan.usdz'), masksDir: join(dir, 'capture-masks'), signal, onProgress: show});
    await writing;
    this.#changed(await store.update(id, o => ({...o, scan: 'scan.usdz', progress: undefined})));
    return 'scan.usdz';
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
      current = {model: join('current', 'model.stl'), renders, ...(sizeMm ? {sizeMm} : {}), ...(summary ? {summary} : {}),
        ...(result.changes?.length ? {changes: result.changes} : {}), engine, ...(design ? {design} : {})};
    }
    const ask = result.status === 'needs_closeup' ? await this.#ask(id, result) : undefined;
    const state: StmObject['state'] = result.status === 'needs_closeup' ? 'needs-closeup'
      : current && result.status !== 'failed' ? 'ready' : 'failed';
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
      ...(state === 'failed' ? {failure: result.reason ?? 'The touch-up stopped without a model.'} : {}),
      passes: o.passes.map(({estimate: _estimate, ...p}) => p.startedAtMs !== startedAtMs ? {...p, ...(_estimate ? {estimate: _estimate} : {})} : {...p, endedAtMs: now, status: result.status,
        stages: p.stages?.map(item => item.endedAtMs === undefined ? {...item, endedAtMs: now} : item),
        ...(result.engine ? {engine: result.engine} : {}), ...(result.note ? {engineNote: this.#publicText(result.note)} : {}),
        ...(state === 'failed' ? {activity: this.#activity(p.activity, [{atMs: Date.now(), kind: 'message', text: result.reason ?? 'The touch-up stopped without a model.'}])} : {}),
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
