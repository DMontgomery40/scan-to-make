import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename, join} from 'node:path';
import {DispatchedPrintError, type PendingElicitation, type PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import type {PrintHandoffServices} from '../print-handoff-http.js';
import type {PlateVerdict} from './bedcheck.js';
import type {TouchupInput} from '../touchup/touchup.js';
import {publicTouchupText, type TouchupActivity, type TouchupResult} from '../touchup/runner.js';
import {ObjectNotFoundError, ObjectStore, type ObjectPrintConfirmation, type StmObject} from './store.js';
import {macReconstructRunner, type Reconstruct} from './reconstruct.js';
import type {PrinterCatalog} from './printers.js';

/** How many of an object's photos go to one touch-up pass. More only costs time. */
export const PHOTOS_PER_PASS = 24;
const BEST_GUESS_NOTE = "Make your best guess for the parts you couldn't see in the photos, and carry on.";
const UNCERTAIN = 'The printer may have started this print. Check the printer before printing again.';

export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}

export class InvalidCaptureManifestError extends Error {
  constructor() { super('Invalid capture manifest'); this.name = 'InvalidCaptureManifestError'; }
}

export interface CaptureManifest {version: 1; images: string[]; depthRequired: boolean}
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
  printerCatalog?: PrinterCatalog;
  onChange?: (object: StmObject) => void;
  /** Rebuilds a handheld scan from its photos (`mac-reconstruct samples`). Defaults to the bundled tool. */
  reconstruct?: Reconstruct;
  print?: {
    services: PrintHandoffServices;
    /** Built once from each catalog entry's entire MCP config, never a host override. */
    destinations?: ReadonlyMap<string, PrintHandoffServices>;
    judgePlate: (photoBase64: string) => Promise<PlateVerdict>;
  };
}

export type ObjectPrintAnswer = {action: 'accept'; content: Record<string, boolean>} | {action: 'decline' | 'cancel'; content?: never};
export interface FilamentChoice {slot: number; colour: string; material: string; name: string; filamentId: string; destinationId: string}
type LiveFilament = FilamentChoice & {profile: string};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Preserve the question; support only the boolean form we can faithfully show and answer. */
function printQuestion(pending: PendingElicitation): ObjectPrintConfirmation {
  const question: ObjectPrintConfirmation = {id: pending.id, message: pending.message, expiresAtMs: pending.expiresAtMs, fields: [], supported: false};
  const schema = pending.requestedSchema;
  if (pending.mode !== 'form' || !record(schema) || schema.type !== 'object' || !record(schema.properties)
      || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description'].includes(key))
      || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')) return question;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key))) return question;
  const fields: ObjectPrintConfirmation['fields'] = [];
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!name.length || name.length > 128 || !record(property) || property.type !== 'boolean'
        || Object.keys(property).some(key => !['type', 'title', 'description', 'default'].includes(key))
        || (property.title !== undefined && typeof property.title !== 'string')
        || (property.description !== undefined && typeof property.description !== 'string')
        || (property.default !== undefined && typeof property.default !== 'boolean')) return question;
    fields.push({name, title: typeof property.title === 'string' ? property.title : name,
      ...(typeof property.description === 'string' ? {description: property.description} : {}), required: required.includes(name)});
  }
  return fields.length ? {...question, fields, supported: true} : question;
}

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
export class ObjectService {
  readonly #deps: ObjectServiceDeps;
  readonly #running = new Map<string, Promise<StmObject>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #confirmations = new Map<string, {pending: PendingElicitation; printing: NonNullable<ObjectServiceDeps['print']>; timer: ReturnType<typeof setTimeout>}>();
  readonly #cancelledPrints = new Set<string>();
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
    for (const controller of this.#controllers.values()) controller.abort();
    for (const confirmation of this.#confirmations.values()) confirmation.printing.services.relay.respond(confirmation.pending.id, {action: 'cancel'});
    await Promise.allSettled([...this.#gates.values(), ...this.#running.values()]);
  }

  create(instructions?: string) { return this.#deps.store.create(instructions).then(o => this.#changed(o)); }
  list() { return this.#deps.store.list(); }
  get(id: string) { return this.#deps.store.get(id); }
  dir(id: string) { return this.#deps.store.dir(id); }

  async passActivity(id: string, index: number): Promise<TouchupActivity[]> {
    if (!Number.isSafeInteger(index) || index < 0) throw new ObjectNotFoundError();
    const pass = (await this.get(id)).passes[index];
    if (!pass) throw new ObjectNotFoundError();
    return pass.activity ?? [];
  }

  printers(): {defaultDestinationId?: string; destinations: PrinterCatalog['destinations']} {
    const catalog = this.#deps.printerCatalog;
    return {defaultDestinationId: catalog?.defaultDestinationId, destinations: catalog?.destinations.map(({id, name, backend, model, address, source}) =>
      ({id, name, backend, ...(model ? {model} : {}), ...(address ? {address} : {}), source})) ?? []};
  }

  private async liveFilaments(id: string): Promise<LiveFilament[]> {
    const object = await this.get(id), configured = this.#deps.print, catalog = this.#deps.printerCatalog;
    const destinationId = object.printerDestinationId ?? catalog?.defaultDestinationId;
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

  async filaments(id: string): Promise<FilamentChoice[]> {
    return (await this.liveFilaments(id)).map(({profile: _profile, ...choice}) => choice);
  }

  selectPrinter(id: string, destinationId: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      const object = await this.get(id), catalog = this.#deps.printerCatalog;
      if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes before changing printers.');
      if (!catalog?.destinations.some(destination => destination.id === destinationId) || !catalog.resolve(destinationId))
        throw new InvalidStateError('That printer is no longer available. Choose another printer.');
      return this.#changed(await this.#deps.store.update(id, o => ({...o, printerDestinationId: destinationId})));
    });
  }

  /** An unsent draft may change; once a pass starts its original request is part of the history. */
  updateInstructions(id: string, instructions: string): Promise<StmObject> {
    return this.#gate(id, async () => {
      if ((await this.get(id)).state !== 'new') throw new InvalidStateError('The description cannot change after work starts. Send a correction instead.');
      return this.#changed(await this.#deps.store.update(id, object => ({...object, instructions: instructions.trim() || undefined})));
    });
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

  async addPhoto(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'new' && object.state !== 'needs-closeup') throw new InvalidStateError('Photos can only be added before the touch-up starts, or when a close-up was asked for.');
    await this.#deps.store.addFile(id, 'photos', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, photos: o.photos.includes(name) ? o.photos : [...o.photos, name]})));
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

  correct(id: string, note: string): Promise<StmObject> { return this.#gate(id, () => this.#correct(id, note)); }
  async #correct(id: string, note: string): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if (!object.current && object.state !== 'failed') throw new InvalidStateError('There is no model to correct yet.');
    return this.#pass(object, {note: note.trim()});
  }

  answerCloseup(id: string, answer: {bestGuess?: boolean}): Promise<StmObject> { return this.#gate(id, () => this.#answerCloseup(id, answer)); }
  async #answerCloseup(id: string, answer: {bestGuess?: boolean}): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'needs-closeup') throw new InvalidStateError('No close-up was asked for.');
    // Carry on with what the asking pass was doing: a correction keeps its note and its model.
    const asked = object.passes.at(-1)?.note;
    const parts = [asked, answer.bestGuess && !asked?.includes(BEST_GUESS_NOTE) ? BEST_GUESS_NOTE : undefined].filter(Boolean);
    return this.#pass(object, parts.length ? {note: parts.join('\n')} : {});
  }

  /** Deletes the object and its files. Not while a touch-up or print is running. */
  delete(id: string): Promise<void> { return this.#gate(id, () => this.#delete(id)); }
  async #delete(id: string): Promise<void> {
    const object = await this.get(id);
    if (object.state === 'touching-up' || object.state === 'printing' || this.#running.has(id))
      throw new InvalidStateError('Wait until the current step finishes.');
    await this.#deps.store.remove(id);
  }

  /** Prints the current model through the user's printer MCP. The plate is checked in the background. */
  print(id: string, options: {checked?: boolean; filament?: FilamentChoice} = {}): Promise<StmObject> { return this.#gate(id, () => this.#print(id, options)); }
  async #print(id: string, options: {checked?: boolean; filament?: FilamentChoice}): Promise<StmObject> {
    const object = await this.get(id);
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    if (object.print?.uncertain && !options.checked) throw new InvalidStateError("The printer may already be printing this. Check the printer, then print again if it isn't.");
    const configured = this.#deps.print;
    if (!configured) throw new InvalidStateError('Printing is not set up on this Mac.');
    const catalog = this.#deps.printerCatalog;
    const destinationId = object.printerDestinationId ?? catalog?.defaultDestinationId;
    const destination = catalog?.destinations.find(item => item.id === destinationId);
    const config = destinationId ? catalog?.resolve(destinationId) : undefined;
    if (destinationId && (!destination || !config)) throw new InvalidStateError('That printer is no longer available. Choose another printer.');
    const services = destinationId ? configured.destinations?.get(destinationId) : configured.services;
    if (!services || (config && services.runner.backend !== config.backend)) throw new InvalidStateError('Printing is not set up for this printer.');
    // Keep the exact route and identity for this dispatch and every later confirmation.
    const printing = {...configured, services};
    const printDestination = destination ? {id: destination.id, name: destination.name} : undefined;
    const {store: bundles, relay, runner, selection} = printing.services;
    let selected = selection;
    let slicer: {loadFilaments: string; filamentColours: string} | undefined;
    if (options.filament) {
      const choice = options.filament;
      const live = (await this.liveFilaments(id)).find(item => item.slot === choice.slot && item.colour === choice.colour
        && item.material === choice.material && item.filamentId === choice.filamentId && item.destinationId === choice.destinationId);
      if (!live) throw new InvalidStateError('The chosen filament changed. Choose a current spool and try again.');
      selected = {...selection, material:live.material, useAms:live.slot !== 254 && live.slot !== 255, amsSlots:[live.slot], amsMapping:undefined, autoMatchAms:false};
      slicer = {loadFilaments:live.profile, filamentColours:live.colour};
    }
    const stl = await readFile(join(this.#deps.store.dir(id), object.current.model));
    const manifest = await bundles.create({stl, prompt: '', backend: runner.backend, ...(selected ? {selection:selected} : {})});
    const print = {bundleId: manifest.id, ...(printDestination ? {destination: printDestination} : {})};
    const started = await this.#deps.store.update(id, o => ({...o, state: 'printing', print, plate: undefined, printConfirmation: undefined, failure: undefined}));
    // Only this print's questions: other prints share the relay.
    const unsubscribe = relay.subscribe(pending => {
      if (pending.bundleId === manifest.id) void this.#confirm(id, pending, printing).catch(() => { relay.respond(pending.id, {action: 'cancel'}); });
    });
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const work = runner.runBundle(bundles, manifest.id, {print: true, signal: controller.signal, ...(slicer ? {slicer} : {})})
      .then(() => this.#deps.store.update(id, o => ({...o, state: 'printed', plate: undefined, printConfirmation: undefined})),
        async error => {
          const status = (await bundles.read(manifest.id).catch(() => undefined))?.status;
          // Once the printer has the job it is printing, whatever went wrong afterwards (as the phone's print route does).
          if (error instanceof DispatchedPrintError || status === 'printed') return this.#deps.store.update(id, o => ({...o, state: 'printed', plate: undefined, printConfirmation: undefined}));
          // It may have reached the printer: never send it again by itself.
          if (status === 'uncertain') return this.#deps.store.update(id, o => ({...o, state: 'failed', plate: undefined, printConfirmation: undefined, failure: UNCERTAIN, print: {...print, uncertain: true}}));
          if (this.#cancelledPrints.has(id)) return this.#deps.store.update(id, o => ({...o, state: 'ready', plate: undefined, printConfirmation: undefined, failure: undefined}));
          if (this.#expiredConfirmations.has(id) || (this.#confirmations.get(id)?.pending.expiresAtMs ?? Infinity) <= Date.now())
            return this.#deps.store.update(id, o => ({...o, state: 'failed', plate: undefined, printConfirmation: undefined, failure: 'Printer confirmation timed out; no print was sent. Press Print to try again.'}));
          return this.#deps.store.update(id, o => ({...o, state: 'failed', plate: undefined, printConfirmation: undefined, failure: error instanceof Error ? error.message : String(error)}));
        })
      .then(o => this.#changed(o))
      .finally(() => {
        unsubscribe(); this.#running.delete(id); this.#controllers.delete(id);
        clearTimeout(this.#confirmations.get(id)?.timer); this.#confirmations.delete(id);
        this.#cancelledPrints.delete(id);
        this.#expiredConfirmations.delete(id);
        void rm(join(this.#deps.store.dir(id), 'plate.jpg'), {force: true}).catch(() => undefined);
      });
    this.#running.set(id, work);
    return this.#changed(started);
  }

  /** Older clients cannot turn a plate-only answer into approval of a hardware operation. */
  async answerPlate(id: string, _answer: {clear: true}): Promise<StmObject> {
    await this.get(id);
    throw new InvalidStateError('Read and answer the printer confirmation in an updated app. A clear plate alone does not approve the print.');
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
      } else if (answer.action === 'accept' && question.supported && record(answer.content)) {
        const content = answer.content;
        if (Object.entries(content).some(([key, value]) => typeof value !== 'boolean' || !question.fields.some(field => field.name === key))
            || question.fields.some(field => field.required && !Object.hasOwn(content, field.name)))
          throw new InvalidStateError('Answer the fields in the current printer confirmation.');
        checked = {action: 'accept', content: {...content} as Record<string, boolean>};
      } else throw new InvalidStateError('This printer question cannot be approved here. Cancel it and use a supported confirmation form.');
      if (checked.action !== 'accept') this.#cancelledPrints.add(id);
      if (!confirmation.printing.services.relay.respond(confirmationId, checked)) {
        this.#cancelledPrints.delete(id);
        throw new InvalidStateError('That printer confirmation is no longer waiting. Refresh the project.');
      }
      clearTimeout(confirmation.timer);
      this.#confirmations.delete(id);
      return this.#changed(await this.#deps.store.update(id, o => o.printConfirmation?.id === confirmationId
        ? {...o, printConfirmation: undefined, plate: undefined} : o));
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
          ? {...o, printConfirmation: undefined, plate: undefined} : o));
      }).catch(() => undefined);
    }, Math.max(0, pending.expiresAtMs - Date.now()));
    this.#confirmations.set(id, {pending, printing, timer});
    this.#changed(await this.#deps.store.update(id, o => this.#pending(id, pending.id)
      ? {...o, printConfirmation: printQuestion(pending), plate: pending.cameraSnapshot ? undefined : {noCamera: true}} : o));
    if (!pending.cameraSnapshot || !this.#pending(id, pending.id)) return;
    // Camera evidence is advisory; it never answers the MCP's human hardware confirmation.
    const photo = await writeFile(join(this.#deps.store.dir(id), 'plate.jpg'), Buffer.from(pending.cameraSnapshot.base64, 'base64')).then(() => true, () => false);
    if (!this.#pending(id, pending.id)) return;
    this.#changed(await this.#deps.store.update(id, o => this.#pending(id, pending.id)
      ? {...o, plate: {...(photo ? {photo} : {})}} : o));
    let verdict: PlateVerdict;
    try { verdict = await printing.judgePlate(pending.cameraSnapshot.base64); }
    catch { return; }
    if (!this.#pending(id, pending.id)) return;
    this.#changed(await this.#deps.store.update(id, o => this.#pending(id, pending.id)
      ? {...o, plate: {...(photo ? {photo} : {}), ...(!verdict.clear ? {item: verdict.item?.trim() || 'something'} : {})}} : o));
  }

  /** Resolves when the object's current touch-up or print (if any) has finished. */
  async settled(id: string): Promise<StmObject> {
    return (await this.#running.get(id)) ?? this.get(id);
  }

  async #pass(object: StmObject, opts: {note?: string}): Promise<StmObject> {
    await this.#requireCaptureCompletion(object);
    const store = this.#deps.store, dir = store.dir(object.id);
    const fromCurrent = opts.note !== undefined && object.current !== undefined;
    // A handheld scan is rebuilt into scan/scan.usdz first, once; its photos also show the touch-up the object.
    const build = !fromCurrent && !object.scan && (object.capture?.length ?? 0) > 0;
    const capturePhotos = (object.capture ?? []).map(name => join(dir, 'capture', name));
    const photos = spreadPick([...object.photos.map(name => join(dir, 'photos', name)), ...capturePhotos], PHOTOS_PER_PASS);
    const startedAtMs = Date.now();
    const running = await store.update(object.id, o => ({...o, state: 'touching-up', question: undefined, failure: undefined,
      ...(build ? {progress: 'Building the model from your photos.'} : {progress: undefined}),
      passes: [...o.passes, {startedAtMs, ...(opts.note ? {note: opts.note} : {})}]}));
    this.#changed(running);
    const controller = new AbortController();
    this.#controllers.set(object.id, controller);
    let writing = Promise.resolve();
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
      const input: TouchupInput = {root: join(dir, 'passes'), objectId: 'pass', scan, photos, currentModel: fromCurrent, handoff: this.#deps.handoff, claudePath: this.#deps.claudePath,
        ...(object.instructions ? {instructions: object.instructions} : {}),
        ...(opts.note !== undefined ? {note: opts.note, ...(object.current?.summary ? {summary: object.current.summary} : {})} : {})};
      try { return await this.#deps.runTouchup({...input, signal: controller.signal, onProgress}); }
      finally { await writing; }
    })()
      .then(result => this.#finish(object.id, startedAtMs, result), error => this.#fail(object.id, startedAtMs, error))
      .finally(() => { this.#running.delete(object.id); this.#controllers.delete(object.id); });
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

  async #finish(id: string, startedAtMs: number, result: TouchupResult & {passDir: string}): Promise<StmObject> {
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
      current = {model: join('current', 'model.stl'), renders, ...(sizeMm ? {sizeMm} : {}), ...(summary ? {summary} : {})};
    }
    const state: StmObject['state'] = result.status === 'needs_closeup' ? 'needs-closeup'
      : current && result.status !== 'failed' ? 'ready' : 'failed';
    const updated = await store.update(id, o => ({...o, state, progress: undefined,
      ...(current ? {current} : {}),
      ...(state === 'needs-closeup' ? {question: {closeup: result.closeup ?? 'a part of the object'}} : {}),
      ...(state === 'failed' ? {failure: result.reason ?? 'The touch-up stopped without a model.'} : {}),
      passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, endedAtMs: Date.now(), status: result.status,
        ...(state === 'failed' ? {activity: this.#activity(p.activity, [{atMs: Date.now(), kind: 'message', text: result.reason ?? 'The touch-up stopped without a model.'}])} : {}),
        ...(result.summary ? {summary: result.summary} : {}), seconds: result.stats.seconds,
        ...(result.stats.costUsd !== undefined ? {costUsd: result.stats.costUsd} : {}), dir: result.passDir})}));
    return this.#changed(updated);
  }

  async #fail(id: string, startedAtMs: number, error: unknown): Promise<StmObject> {
    const message = this.#publicText(error instanceof Error ? error.message : String(error));
    const updated = await this.#deps.store.update(id, o => ({...o, state: 'failed', failure: message, progress: undefined,
      passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, endedAtMs: Date.now(), status: 'failed',
        activity: this.#activity(p.activity, [{atMs: Date.now(), kind: 'message', text: message}])})}));
    return this.#changed(updated);
  }

  #activity(previous: TouchupActivity[] = [], entries: TouchupActivity[]): TouchupActivity[] {
    const clean = entries.filter(entry => (entry.kind === 'message' || entry.kind === 'tool') && Number.isFinite(entry.atMs) && typeof entry.text === 'string')
      .map(entry => ({atMs: entry.atMs, kind: entry.kind, text: this.#publicText(entry.text)}))
      .filter(entry => entry.text.length > 0);
    return [...previous, ...clean].slice(-200);
  }

  #publicText(text: string): string { return publicTouchupText(text, {...process.env, ...this.#deps.handoff.process.env}); }

  #changed(object: StmObject): StmObject { this.#deps.onChange?.(object); return object; }
}
