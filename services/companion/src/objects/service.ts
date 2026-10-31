import {copyFile, mkdir, readFile, rm} from 'node:fs/promises';
import {basename, join} from 'node:path';
import type {ElicitationRelay, HandoffBundleStore, PendingElicitation, PrinterHandoffConfig, PrinterHandoffRunner} from '@scan-to-make/printer-handoff';
import type {PlateVerdict} from './bedcheck.js';
import type {TouchupInput} from '../touchup/touchup.js';
import type {TouchupResult} from '../touchup/runner.js';
import {ObjectStore, type StmObject} from './store.js';

/** How many of an object's photos go to one touch-up pass. More only costs time. */
export const PHOTOS_PER_PASS = 24;
const BEST_GUESS_NOTE = "Make your best guess for the parts you couldn't see in the photos, and carry on.";

export class InvalidStateError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidStateError'; }
}

export interface ObjectServiceDeps {
  store: ObjectStore;
  runTouchup: (input: TouchupInput) => Promise<TouchupResult & {passDir: string}>;
  /** Bounding box in millimetres, from the user's printer MCP (get_stl_info). */
  stlInfo: (stlPath: string) => Promise<[number, number, number] | undefined>;
  claudePath: string;
  handoff: PrinterHandoffConfig;
  onChange?: (object: StmObject) => void;
  print?: {
    services: {store: HandoffBundleStore; relay: ElicitationRelay; runner: Pick<PrinterHandoffRunner, 'runBundle' | 'backend'>; selection?: PrinterHandoffConfig['selection']};
    judgePlate: (photoBase64: string) => Promise<PlateVerdict>;
  };
}

/** The printer MCP's own confirmation is a form of booleans; answering it means setting each to true. */
function confirmAnswer(schema: unknown): Record<string, boolean> | undefined {
  const properties = (schema as {properties?: Record<string, {type?: string}>} | undefined)?.properties;
  if (!properties || !Object.keys(properties).length) return {};
  if (!Object.values(properties).every(property => property.type === 'boolean')) return undefined;
  return Object.fromEntries(Object.keys(properties).map(key => [key, true]));
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
  readonly #confirmations = new Map<string, PendingElicitation>();
  constructor(deps: ObjectServiceDeps) { this.#deps = deps; }

  create(instructions?: string) { return this.#deps.store.create(instructions).then(o => this.#changed(o)); }
  list() { return this.#deps.store.list(); }
  get(id: string) { return this.#deps.store.get(id); }

  async addScan(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'new') throw new InvalidStateError('The scan can only be added before the touch-up starts.');
    await this.#deps.store.addFile(id, 'scan', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, scan: name})));
  }

  async addPhoto(id: string, name: string, bytes: Buffer): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'new' && object.state !== 'needs-closeup') throw new InvalidStateError('Photos can only be added before the touch-up starts, or when a close-up was asked for.');
    await this.#deps.store.addFile(id, 'photos', name, bytes);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, photos: o.photos.includes(name) ? o.photos : [...o.photos, name]})));
  }

  /** The inputs are complete: start the touch-up. Starting again while it runs changes nothing. */
  async start(id: string): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state === 'touching-up') return object;
    if (object.state === 'needs-closeup') return this.#pass(object, {});
    if (object.state !== 'new' && object.state !== 'failed') throw new InvalidStateError('This object has already been touched up.');
    return this.#pass(object, {});
  }

  async correct(id: string, note: string): Promise<StmObject> {
    const object = await this.get(id);
    if (!object.current) throw new InvalidStateError('There is no model to correct yet.');
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    return this.#pass(object, {note: note.trim()});
  }

  async answerCloseup(id: string, answer: {bestGuess?: boolean}): Promise<StmObject> {
    const object = await this.get(id);
    if (object.state !== 'needs-closeup') throw new InvalidStateError('No close-up was asked for.');
    return this.#pass(object, answer.bestGuess ? {note: BEST_GUESS_NOTE} : {});
  }

  /** Prints the current model through the user's printer MCP. The plate is checked in the background. */
  async print(id: string): Promise<StmObject> {
    const object = await this.get(id);
    if (!object.current) throw new InvalidStateError('There is no model to print yet.');
    if (object.state === 'touching-up' || object.state === 'printing') throw new InvalidStateError('Wait until the current step finishes.');
    const printing = this.#deps.print;
    if (!printing) throw new InvalidStateError('Printing is not set up on this Mac.');
    const {store: bundles, relay, runner, selection} = printing.services;
    const stl = await readFile(join(this.#deps.store.dir(id), object.current.model));
    const manifest = await bundles.create({stl, prompt: '', backend: runner.backend, ...(selection ? {selection} : {})});
    const started = await this.#deps.store.update(id, o => ({...o, state: 'printing', print: {bundleId: manifest.id}, plate: undefined, failure: undefined}));
    const unsubscribe = relay.subscribe(pending => { void this.#confirm(id, pending); });
    const work = runner.runBundle(bundles, manifest.id, {print: true})
      .then(() => this.#deps.store.update(id, o => ({...o, state: 'printed', plate: undefined})),
        error => this.#deps.store.update(id, o => ({...o, state: 'failed', plate: undefined, failure: error instanceof Error ? error.message : String(error)})))
      .then(o => this.#changed(o))
      .finally(() => { unsubscribe(); this.#running.delete(id); this.#confirmations.delete(id); });
    this.#running.set(id, work);
    return this.#changed(started);
  }

  /** The user says the plate is clear (no camera, or the check saw something that isn't really there). */
  async answerPlate(id: string, answer: {clear: true}): Promise<StmObject> {
    const pending = this.#confirmations.get(id), content = pending && confirmAnswer(pending.requestedSchema);
    if (!answer.clear || !pending || !content) throw new InvalidStateError('Nothing is waiting for the plate.');
    this.#deps.print!.services.relay.respond(pending.id, {action: 'accept', content});
    this.#confirmations.delete(id);
    return this.#changed(await this.#deps.store.update(id, o => ({...o, plate: undefined})));
  }

  async #confirm(id: string, pending: PendingElicitation): Promise<void> {
    this.#confirmations.set(id, pending);
    const content = confirmAnswer(pending.requestedSchema);
    if (!pending.cameraSnapshot) { this.#changed(await this.#deps.store.update(id, o => ({...o, plate: {noCamera: true}}))); return; }
    let verdict: PlateVerdict;
    try { verdict = await this.#deps.print!.judgePlate(pending.cameraSnapshot.base64); }
    catch { verdict = {clear: false, item: 'something'}; }
    if (verdict.clear && content) {
      this.#deps.print!.services.relay.respond(pending.id, {action: 'accept', content});
      this.#confirmations.delete(id);
      return;
    }
    this.#changed(await this.#deps.store.update(id, o => ({...o, plate: {item: verdict.item?.trim() || 'something'}})));
  }

  /** Resolves when the object's current touch-up or print (if any) has finished. */
  async settled(id: string): Promise<StmObject> {
    return (await this.#running.get(id)) ?? this.get(id);
  }

  async #pass(object: StmObject, opts: {note?: string}): Promise<StmObject> {
    const store = this.#deps.store, dir = store.dir(object.id);
    const fromCurrent = opts.note !== undefined && object.current !== undefined;
    const scan = fromCurrent ? [join(dir, object.current!.model)] : object.scan ? [join(dir, 'scan', object.scan)] : [];
    const photos = spreadPick(object.photos, PHOTOS_PER_PASS).map(name => join(dir, 'photos', name));
    const startedAtMs = Date.now();
    const running = await store.update(object.id, o => ({...o, state: 'touching-up', question: undefined, failure: undefined,
      passes: [...o.passes, {startedAtMs, ...(opts.note ? {note: opts.note} : {})}]}));
    this.#changed(running);
    const input: TouchupInput = {root: join(dir, 'passes'), objectId: 'pass', scan, photos, handoff: this.#deps.handoff, claudePath: this.#deps.claudePath,
      ...(object.instructions ? {instructions: object.instructions} : {}),
      ...(opts.note !== undefined ? {note: opts.note, ...(object.current?.summary ? {summary: object.current.summary} : {})} : {})};
    const work = this.#deps.runTouchup(input)
      .then(result => this.#finish(object.id, startedAtMs, result), error => this.#fail(object.id, startedAtMs, error))
      .finally(() => this.#running.delete(object.id));
    this.#running.set(object.id, work);
    return running;
  }

  async #finish(id: string, startedAtMs: number, result: TouchupResult & {passDir: string}): Promise<StmObject> {
    const store = this.#deps.store, dir = store.dir(id);
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
    const updated = await store.update(id, o => ({...o, state,
      ...(current ? {current} : {}),
      ...(state === 'needs-closeup' ? {question: {closeup: result.closeup ?? 'a part of the object'}} : {}),
      ...(state === 'failed' ? {failure: result.reason ?? 'The touch-up stopped without a model.'} : {}),
      passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, endedAtMs: Date.now(), status: result.status,
        ...(result.summary ? {summary: result.summary} : {}), seconds: result.stats.seconds,
        ...(result.stats.costUsd !== undefined ? {costUsd: result.stats.costUsd} : {}), dir: result.passDir})}));
    return this.#changed(updated);
  }

  async #fail(id: string, startedAtMs: number, error: unknown): Promise<StmObject> {
    const message = error instanceof Error ? error.message : String(error);
    const updated = await this.#deps.store.update(id, o => ({...o, state: 'failed', failure: message,
      passes: o.passes.map(p => p.startedAtMs !== startedAtMs ? p : {...p, endedAtMs: Date.now(), status: 'failed'})}));
    return this.#changed(updated);
  }

  #changed(object: StmObject): StmObject { this.#deps.onChange?.(object); return object; }
}
