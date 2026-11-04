import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, extname, isAbsolute, join} from 'node:path';
import type {ElicitResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  printerHandoffConfigSchema,
  type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrinterPrintOptions,
} from './config.js';
import type {ElicitationContext, ElicitationRelay} from './elicitation.js';
import {sliceEstimate, sliceSettings, slicePlateCount, type SliceEstimate, type SliceSettings} from './slice-estimate.js';
import {inspectModelFile} from './model-file.js';
import {slicerReport} from './slicer-report.js';
import {keepSlice, readSlice, sliceCacheKey, presetDigests} from './slice-cache.js';
import type {HandoffBundleStore} from './bundle.js';
import {PrinterMcpError, toolResultJson, toolResultText, type PrinterToolCatalog} from './mcp-client.js';
import {PrinterSession} from './session.js';
import {readPrintRoute} from './counterpart.js';

export type PrintStep = 'discover' | 'lay_flat' | 'slice_stl' | 'inspect' | 'print';
export type PrintPhase = 'connecting' | 'orienting' | 'slicing' | 'inspecting' | 'slice-ready' | 'checking-printer' | 'resolving-printer-error' | 'requesting-print' | 'accepted';
export interface PrintProgress {phase: PrintPhase; estimate?: SliceEstimate}
export interface PrintRunInput {
  onProgress?: (update: PrintProgress) => Promise<void>;
  /** Persist a non-replayable intent before sending the print tool call. */
  beforePrint?: () => Promise<void>;
  /** Save backend scratch outputs while the MCP is alive; dispatch uses the returned durable paths. */
  persistOutput?: (output: {slicedPath: string; orientedStlPath: string}) => Promise<{slicedPath: string; orientedStlPath: string}>;
  stlPath: string;
  selection?: PrinterSelection;
  slicer?: PrinterSlicer;
  printOptions?: PrinterPrintOptions;
  /** Set false to stop after slicing and inspection. Defaults to printing. */
  print?: boolean;
  signal?: AbortSignal;
  /** Tags the printer's questions with the bundle being printed. */
  bundleId?: string;
  /** Keep each slice here and print a kept one again when nothing that shapes it changed (slice-cache.ts). */
  sliceCache?: {directory: string};
}
/** How the printer will report this print, so its job can be recognised (PRD §8.6). */
export interface DispatchIdentity {
  /** The printer's task id, when the print tool returned a real one. */
  taskId?: string;
  /** The job name the printer reports: Bambu's subtask name, or the uploaded file name. */
  jobName?: string;
  /** The sliced file's name without its extension: a job the printer names after it can be adopted. */
  fileBase?: string;
}
export interface PrintRunResult {
  backend: PrinterHandoffConfig['backend'];
  dispatch?: DispatchIdentity;
  catalog: PrinterToolCatalog;
  stlPath: string;
  orientedStlPath: string;
  slicedPath: string;
  inspection?: {tool: string; result: unknown};
  /** Bambu Studio's warning on this slice, word for word (slice_stl's `slicer_result`); printing it needed the user's go. */
  slicerWarning?: string;
  print?: unknown;
  steps: PrintStep[];
}
export interface ProcessAndPrintInput {
  stlPath: string;
  extensionInches?: number;
  material?: string;
  selection?: PrinterSelection;
  signal?: AbortSignal;
}

function fail(code: string): never { throw new PrinterMcpError(code); }

/** Bare, phone-safe failure code for a bundle manifest; never a message or path. */
export function sanitizedFailureReason(error: unknown): string {
  const code = (error as {code?: unknown})?.code;
  return typeof code === 'string' && /^[a-z0-9-]{1,64}$/.test(code) ? code : 'print-failed';
}

/** A print call succeeded even though recording its result failed. */
export class DispatchedPrintError extends PrinterMcpError {
  constructor(cause: unknown) { super(sanitizedFailureReason(cause), cause); }
}
function defined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}
function filtered(session: PrinterSession, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool: Tool = session.getTool(name);
  const clean = defined(args);
  const properties = (tool.inputSchema as {properties?: unknown}).properties;
  if (!properties || typeof properties !== 'object') return clean;
  const allowed = new Set(Object.keys(properties));
  return Object.fromEntries(Object.entries(clean).filter(([key]) => allowed.has(key)));
}
const DISPATCH_TOOLS = ['print_3mf', 'upload_gcode', 'process_and_print_stl'];
interface CallOptions {signal?: AbortSignal; beforeDispatch?: () => Promise<void>; elicitationContext?: ElicitationContext; failFast?: boolean}
async function call(session: PrinterSession, name: string, args: Record<string, unknown>, options: CallOptions = {}) {
  return session.call(name, filtered(session, name, args), {
    ...(options.signal ? {signal: options.signal} : {}),
    ...(DISPATCH_TOOLS.includes(name) ? {dispatchSensitive: true} : {}),
    ...(options.beforeDispatch ? {beforeDispatch: options.beforeDispatch} : {}),
    ...(options.elicitationContext ? {elicitationContext: options.elicitationContext} : {}),
    ...(options.failFast ? {failFast: true} : {}),
  });
}
function absolutePath(result: Parameters<typeof toolResultText>[0]): string {
  const path = toolResultText(result).trim();
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) fail('invalid-output-path');
  return path;
}
function resultValue(result: Parameters<typeof toolResultText>[0]): unknown {
  if (result.isError) fail('tool-failed');
  if (result.structuredContent !== undefined) return result.structuredContent;
  try { return toolResultJson(result); } catch { return toolResultText(result); }
}
export function isBambuSlicing(config: PrinterHandoffConfig, selection: PrinterSelection, slicer?: PrinterSlicer): boolean {
  if (config.backend === 'bambu-printer-mcp') return true;
  if (selection.printerType === 'bambu') return true;
  const type = (slicer?.type ?? '').toLowerCase();
  return type === 'bambustudio' || type === 'orcaslicer-bambulab' || type === 'fulu-orca' || type === 'orca-studio';
}

export interface PrinterHandoffRunnerOptions {
  relay?: ElicitationRelay;
  onStep?: (step: PrintStep) => void;
  onStderr?: (chunk: string) => void;
  /**
   * The destination's long-lived session (PRD §8.3). Without one, each
   * operation opens its own MCP process and closes it when it ends.
   */
  session?: PrinterSession;
}

/**
 * The identity the printer will report for a dispatched print: the
 * counterpart/1 `taskId`/`subtaskName` or `jobName` when the MCP returns them;
 * otherwise, for bambu-printer-mcp today, the uploaded file's name without
 * `.3mf` (its `subtask_name`); for G-code uploads, the file name sent.
 */
export function dispatchIdentity(printed: unknown, slicedPath: string): DispatchIdentity {
  const value = printed && typeof printed === 'object' ? printed as Record<string, unknown> : {};
  const text = (item: unknown) => typeof item === 'string' && item.trim() ? item.trim().slice(0, 256) : typeof item === 'number' && Number.isFinite(item) ? String(item) : undefined;
  const taskId = text(value.taskId);
  // bambu_network / bambu_native report the checked name they sent as printerJobName.
  const named = text(value.subtaskName) ?? text(value.jobName) ?? text(value.printerJobName);
  const remote = text(value.remoteProjectPath);
  const jobName = named ?? (remote ? basename(remote).replace(/\.3mf$/i, '') : slicedPath.toLowerCase().endsWith('.3mf') ? undefined : basename(slicedPath));
  const fileBase = basename(slicedPath).replace(/(\.gcode)?\.(3mf|gcode|bgcode)$/i, '');
  return {...(taskId && taskId !== '0' ? {taskId} : {}), ...(jobName ? {jobName} : {}), ...(fileBase ? {fileBase} : {})};
}

export class PrinterHandoffRunner {
  readonly #config: PrinterHandoffConfig;
  readonly #relay?: ElicitationRelay;
  readonly #onStep?: (step: PrintStep) => void;
  readonly #onStderr?: (chunk: string) => void;
  readonly #session?: PrinterSession;

  constructor(config: PrinterHandoffConfig, options: PrinterHandoffRunnerOptions = {}) {
    this.#config = printerHandoffConfigSchema.parse(structuredClone(config));
    this.#relay = options.relay;
    this.#onStep = options.onStep;
    this.#onStderr = options.onStderr;
    this.#session = options.session;
  }

  get backend(): PrinterHandoffConfig['backend'] { return this.#config.backend; }
  /** The shared session, when this runner has one. */
  get session(): PrinterSession | undefined { return this.#session; }

  async #use<T>(work: (session: PrinterSession, shared: boolean) => Promise<T>): Promise<T> {
    if (this.#session) {
      const release = this.#session.hold();
      try { return await work(this.#session, true); } finally { release(); }
    }
    const session = new PrinterSession('one-shot', this.#config, {relay: this.#relay, onStderr: this.#onStderr});
    try { return await work(session, false); } finally { await session.close(); }
  }

  /**
   * Lays the model flat and slices it exactly as a print would, then reads the
   * time, grams and settings from the sliced file. Never prints.
   */
  async estimate(input: {stlPath: string; selection?: PrinterSelection; slicer?: PrinterSlicer; signal?: AbortSignal; sliceCache?: PrintRunInput['sliceCache']}): Promise<{estimate?: SliceEstimate; settings: SliceSettings; slicerWarning?: string}> {
    let sliced: Buffer | undefined;
    const plate = {...this.#config.selection, ...input.selection}.plateIndex ?? 0;
    const {slicerWarning} = await this.run({stlPath: input.stlPath, print: false, ...(input.selection ? {selection: input.selection} : {}), ...(input.slicer ? {slicer: input.slicer} : {}),
      ...(input.signal ? {signal: input.signal} : {}), ...(input.sliceCache ? {sliceCache: input.sliceCache} : {}),
      // Read the output while the MCP is alive: a one-shot backend may delete it when it closes.
      persistOutput: async output => { sliced = await readFile(output.slicedPath); return output; }});
    if (!sliced) fail('invalid-output-path');
    const estimate = await sliceEstimate(sliced, plate);
    return {...(estimate ? {estimate} : {}), settings: await sliceSettings(sliced, plate), ...(slicerWarning ? {slicerWarning} : {})};
  }

  /** Connects and lists the server's tools without calling one (a one-shot session then disconnects). */
  async discover(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    return this.#use(session => session.connect(signal ? {signal} : {}));
  }

  /** Display-only printer status, using the configured route and the standard MCP tool. */
  async status(signal?: AbortSignal): Promise<unknown> {
    return this.#use(async (session, shared) => {
      await session.connect({...(signal ? {signal} : {}), failFast: shared});
      if (!session.hasTool('get_printer_status')) return undefined;
      const selection = this.#config.selection;
      return resultValue(await call(session, 'get_printer_status', {
        host: selection?.host, type: selection?.printerType, port: selection?.port,
      }, {...(signal ? {signal} : {}), failFast: shared}));
    });
  }

  /** Read the printer's live material inventory without starting or uploading a print. */
  async filaments(signal?: AbortSignal): Promise<unknown> {
    return this.#use(async (session, shared) => {
      await session.connect({...(signal ? {signal} : {}), failFast: shared});
      if (!session.hasTool('get_printer_filaments')) fail('filament-inventory-unavailable');
      const selection = this.#config.selection;
      return resultValue(await call(session, 'get_printer_filaments', {
        bambu_model: selection?.model,
        nozzle_diameter: selection?.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
      }, {...(signal ? {signal} : {}), failFast: shared}));
    });
  }

  private async inspect(session: PrinterSession, slicedPath: string, selection: PrinterSelection, options: CallOptions) {
    if (session.hasTool('inspect_print_file')) {
      const result = await call(session, 'inspect_print_file', {
        file_path: slicedPath,
        bambu_model: selection.model,
        plate_index: selection.plateIndex ?? 0,
        nozzle_diameters: selection.nozzleDiameterMm === undefined ? undefined : [selection.nozzleDiameterMm],
        bed_type: selection.bedType,
      }, options);
      return {tool: 'inspect_print_file', result: toolResultJson(result)};
    }
    if (slicedPath.toLowerCase().endsWith('.gcode') && session.hasTool('confirm_temperatures')) {
      const result = await call(session, 'confirm_temperatures', {gcode_path: slicedPath}, options);
      return {tool: 'confirm_temperatures', result: toolResultJson(result)};
    }
    return undefined;
  }

  /**
   * Asks the user, through the relay that carries the printer's own questions, whether to print
   * despite Bambu Studio's warning. The question is Studio's words; only an explicit yes goes on,
   * and a decline, a timeout or an abort stops before the printer is asked anything.
   */
  async #slicerGo(warning: string, context: ElicitationContext, signal?: AbortSignal): Promise<void> {
    const declined = () => new PrinterMcpError('slicer-warning-declined', undefined, warning);
    const relay = this.#relay;
    if (!relay) throw declined();
    if (signal?.aborted) fail('cancelled');
    // The relay announces a question synchronously as it is asked: the first announcement is this one.
    let id: string | undefined;
    const stop = relay.subscribe(pending => { id ??= pending.id; });
    let answer: Promise<ElicitResult>;
    try {
      answer = relay.request({method: 'elicitation/create', params: {mode: 'form', message: warning, requestedSchema: {
        type: 'object', required: ['confirmed'],
        properties: {confirmed: {type: 'boolean', title: 'Print anyway', default: false}},
      }}}, context);
    } finally { stop(); }
    const abort = () => { if (id) relay.respond(id, {action: 'cancel'}); };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const result = await answer;
      if (signal?.aborted) fail('cancelled');
      if (result.action !== 'accept' || result.content?.confirmed !== true) throw declined();
    } finally { signal?.removeEventListener('abort', abort); }
  }

  /**
   * Runs one handoff: lay flat -> slice -> inspect -> print, using the tool
   * sequence of the configured backend. Print confirmations are elicited by
   * the server during the print call and answered through the relay.
   */
  async run(input: PrintRunInput): Promise<PrintRunResult> {
    if (!isAbsolute(input.stlPath)) fail('invalid-stl-path');
    return this.#use((session, shared) => this.#run(session, shared, input));
  }

  async #run(session: PrinterSession, shared: boolean, input: PrintRunInput): Promise<PrintRunResult> {
    const selection: PrinterSelection = {...this.#config.selection, ...input.selection};
    const slicer: PrinterSlicer = {...this.#config.slicer, ...input.slicer};
    const threeMf = extname(input.stlPath).toLowerCase() === '.3mf';
    const model = threeMf ? inspectModelFile(await readFile(input.stlPath), '3mf') : undefined;
    const plate = model?.plates.find(item => item.index === (selection.plateIndex ?? 0));
    if (threeMf && !plate) throw new PrinterMcpError('invalid-plate', undefined, 'Choose a plate contained in this model.');
    const alreadySliced = plate?.sliced === true;
    // A 3MF already owns its per-part filaments and profile. Global STL defaults must not collapse them.
    if (threeMf) {
      for (const key of ['loadFilaments', 'filamentProfile', 'filamentColours', 'templateName', 'layerHeightMm', 'wallLoops', 'sparseInfillDensity'] as const) {
        if (input.slicer?.[key] === undefined) delete slicer[key];
      }
    }
    if (alreadySliced && slicer.pauseAtLayers?.length)
      throw new PrinterMcpError('published-sliced-settings', undefined, 'This file is already sliced, so its layer pauses are the ones it was sliced with. Share the designer’s editable 3MF to add a pause.');
    if (alreadySliced && ((slicer.repetitions ?? 1) !== 1 || ['layerHeightMm', 'wallLoops', 'sparseInfillDensity', 'loadFilaments', 'filamentProfile', 'filamentColours', 'templateName'].some(key => Object.hasOwn(input.slicer ?? {}, key))))
      throw new PrinterMcpError('published-sliced-settings', undefined, 'This file is already sliced. Share the designer’s editable 3MF to change its slicing settings or copies.');
    // A chosen spool's profile (load_filaments) replaces the configured filament alias: MCPs refuse the two when they differ.
    if (input.slicer?.loadFilaments && input.slicer.filamentProfile === undefined) delete slicer.filamentProfile;
    const printOptions: PrinterPrintOptions = {...this.#config.print, ...input.printOptions};
    const steps: PrintStep[] = [];
    const step = (name: PrintStep) => { steps.push(name); this.#onStep?.(name); };
    const tag: ElicitationContext = input.bundleId === undefined ? {} : {bundleId: input.bundleId};
    // A one-shot session is this run's alone, so every question it causes is this
    // run's. On a shared session only a mutex holder may tag questions: slicing
    // without a known model may ask for it, so it holds the mutex then.
    const signal = input.signal;
    const local: CallOptions = {signal, ...(shared ? (selection.model ? {} : {elicitationContext: tag}) : {elicitationContext: tag})};
    const read: CallOptions = {signal, ...(shared ? {} : {elicitationContext: tag})};
    const progress = async (phase: PrintPhase, estimate?: SliceEstimate) => { await input.onProgress?.({phase, ...(estimate ? {estimate} : {})}); };
    await progress('connecting');
    const catalog = await session.connect(signal ? {signal} : {});
    step('discover');
    if (slicer.filamentColours) {
      const sliceProperties = session.getTool('slice_stl').inputSchema.properties ?? {};
      if (!Object.hasOwn(sliceProperties, 'filament_colours') || !Object.hasOwn(sliceProperties, 'load_filaments'))
        fail('filament-selection-unsupported');
      if (input.print !== false) {
        const printProperties = session.getTool('print_3mf').inputSchema.properties ?? {};
        if (!Object.hasOwn(printProperties, 'ams_slots') || !Object.hasOwn(printProperties, 'use_ams'))
          fail('filament-selection-unsupported');
      }
    }
    // A chosen quality or strength the MCP can't apply is refused, never silently printed at preset values.
    {
      const sliceProperties = session.getTool('slice_stl').inputSchema.properties ?? {};
      if ((slicer.layerHeightMm !== undefined && !Object.hasOwn(sliceProperties, 'layer_height'))
          || (slicer.wallLoops !== undefined && !Object.hasOwn(sliceProperties, 'wall_loops'))
          || (slicer.sparseInfillDensity !== undefined && !Object.hasOwn(sliceProperties, 'sparse_infill_density'))
          || (slicer.pauseAtLayers?.length && !Object.hasOwn(sliceProperties, 'pause_at_layers'))
          // mcp-3D-printer-server forwards repetitions only on its Bambu-compatible route; elsewhere it would slice one.
          || (slicer.repetitions !== undefined && slicer.repetitions > 1 && (!Object.hasOwn(sliceProperties, 'repetitions') || !isBambuSlicing(this.#config, selection, slicer)))) fail('print-settings-unsupported');
    }
    // Every slice_stl argument but the model's path and whether lay_flat already chose its face.
    const sliceArgs = {
      slice_plate: threeMf ? (selection.plateIndex ?? 0) + 1 : undefined,
      bambu_model: isBambuSlicing(this.#config, selection, slicer) ? selection.model : undefined,
      nozzle_diameter: selection.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
      bed_type: selection.bedType,
      nozzle_type: selection.nozzleType,
      slicer_type: slicer.type,
      slicer_profile: slicer.profile,
      filament_profile: slicer.filamentProfile,
      load_filaments: slicer.loadFilaments,
      filament_colours: slicer.filamentColours,
      template_name: slicer.templateName,
      layer_height: slicer.layerHeightMm,
      wall_loops: slicer.wallLoops,
      sparse_infill_density: slicer.sparseInfillDensity,
      pause_at_layers: slicer.pauseAtLayers?.length ? slicer.pauseAtLayers : undefined,
      // Sent whenever it is set and the tool takes it, 1 included: a request for one copy overrides a configured 3.
      repetitions: slicer.repetitions !== undefined && (slicer.repetitions > 1 || Object.hasOwn(session.getTool('slice_stl').inputSchema.properties ?? {}, 'repetitions'))
        ? slicer.repetitions : undefined,
      use_printer_filaments: false,
      arrange: !threeMf || (slicer.repetitions ?? 1) > 1,
      ensure_on_bed: !threeMf,
    };
    // The same model sliced the same way before (Print Again, or Print after Estimate): print that file. Only lay_flat
    // and slice_stl are skipped; inspection, the printer checks, Studio's warning and the print call all run as always.
    // SSH, shells and other wrappers can change cwd or host before starting the MCP. Their
    // actual defaults are not visible here, so only cache direct local Node/npm launches.
    const localLaunch = /^(node|nodejs|npx)(\.exe|\.cmd)?$/i.test(basename(this.#config.process.command));
    // The `.env` the running MCP started with, not the file now: an edit reaches the MCP only when it restarts.
    const started = catalog.startedWith;
    const presets = input.sliceCache && !alreadySliced && localLaunch && started
      ? await presetDigests(sliceArgs, this.#config.process.cwd ?? process.cwd(), {...started.presets, ...this.#config.process.env}) : undefined;
    const cacheKey = input.sliceCache && !alreadySliced && presets ? sliceCacheKey({model: await readFile(input.stlPath), backend: this.#config.backend, presets,
      server: catalog.server, config: this.#config.process, env: started?.envSha256,
      args: {...sliceArgs, lay_flat: !threeMf && session.hasTool('lay_flat')}}) : undefined;
    const reused = cacheKey ? await readSlice(input.sliceCache!.directory, cacheKey) : undefined;
    let orientedStlPath = input.stlPath;
    let laidFlat = false;
    if (!reused && !threeMf && session.hasTool('lay_flat')) {
      await progress('orienting');
      const orientation = await call(session, 'lay_flat', {stl_path: input.stlPath}, local);
      orientedStlPath = absolutePath(orientation);
      // Newer MCPs explicitly return the unchanged model when no face can rest
      // on the bed. Let the slicer orient it; older path-only results retain
      // their established behavior.
      laidFlat = orientation.structuredContent?.laid_flat !== false;
      step('lay_flat');
    }
    if (threeMf && !alreadySliced && !Object.hasOwn(session.getTool('slice_stl').inputSchema.properties ?? {}, 'slice_plate'))
      throw new PrinterMcpError('plate-selection-unsupported', undefined, 'Update your printer service to slice the selected 3MF plate.');
    if (!alreadySliced && !reused) await progress('slicing');
    const sliced = alreadySliced || reused ? undefined : await call(session, 'slice_stl', {
      stl_path: orientedStlPath,
      ...sliceArgs,
      // lay_flat already chose the flat face; otherwise let the slicer orient.
      orient: !threeMf && !laidFlat,
    }, local);
    let slicedPath = sliced ? absolutePath(sliced) : input.stlPath;
    if (reused) {
      // Named as a fresh slice of this input would be: the printer's job is named after the file.
      slicedPath = join(dirname(input.stlPath), `${basename(input.stlPath, extname(input.stlPath))}_sliced${reused.extension}`);
      await writeFile(slicedPath, reused.bytes, {mode: 0o600});
    }
    if (sliced) step('slice_stl');
    // Studio's own verdict on this slice (absent from an MCP that returns only the path): an error is
    // never printed, and a warning is printed only on the user's explicit go, as in Studio.
    const report = reused ? undefined : slicerReport(sliced?.structuredContent);
    if (report?.failed) throw new PrinterMcpError('slicer-error', undefined, report.message);
    const slicerWarning = reused ? reused.slicerWarning : report?.message;
    const slicedBytes = await readFile(slicedPath);
    const plateCount = slicePlateCount(slicedBytes) ?? report?.plateCount ?? reused?.plateCount;
    if (cacheKey && !reused) await keepSlice(input.sliceCache!.directory, cacheKey, {bytes: slicedBytes, extension: extname(slicedPath), ...(slicerWarning ? {slicerWarning} : {}), ...(plateCount !== undefined ? {plateCount} : {})});
    // Copies in this flow mean copies in one print. The MCP dispatches one selected plate,
    // so never present one plate's estimate or dispatch as fulfilling a multi-plate request.
    if ((slicer.repetitions ?? 1) > 1 && plateCount && plateCount > 1) {
      throw new PrinterMcpError('copies-multiple-plates', undefined,
        `The slicer placed ${slicer.repetitions} copies on ${plateCount} plates, requiring ${plateCount} separate prints. Choose fewer copies for this print.`);
    }
    const estimate = await sliceEstimate(slicedBytes, selection.plateIndex ?? 0);
    await progress('inspecting', estimate);
    const inspection = await this.inspect(session, slicedPath, selection, local);
    if (alreadySliced) {
      const receipt = inspection?.result as {artifact?: {sha256?: string}; selection?: {plate_index?: number; bambu_model?: string}; inspection?: unknown} | undefined;
      if (inspection?.tool !== 'inspect_print_file' || receipt?.artifact?.sha256 !== model!.sha256 || receipt.selection?.plate_index !== (selection.plateIndex ?? 0) || receipt.selection?.bambu_model !== selection.model)
        throw new PrinterMcpError('published-inspection-required', undefined, 'This sliced file needs a compatible printer and a current printer service that can check it.');
    }
    if (inspection) step('inspect');
    if (input.persistOutput) ({slicedPath, orientedStlPath} = await input.persistOutput({slicedPath, orientedStlPath}));
    await progress('slice-ready', estimate);
    const common = {backend: this.#config.backend, catalog, stlPath: input.stlPath, orientedStlPath, slicedPath, inspection, steps,
      ...(slicerWarning ? {slicerWarning} : {})};
    if (input.print === false) return common;
    if (slicerWarning) await this.#slicerGo(slicerWarning, tag, signal);

    await progress('checking-printer');
    // PRD §5.6: no bed check. Bambu's own bed levelling finds a full plate; the MCP's own confirmation is relayed as it asks.
    const printContext: ElicitationContext = tag;

    // A rejected unsigned command leaves a software HMS error. FULU's authenticated
    // route can recover it only through the server's own human confirmation. The route
    // is the MCP's own setting, so ask it rather than keeping a copy here.
    if (this.#config.backend === 'bambu-printer-mcp' && session.hasTool('get_printer_status') && session.hasTool('clear_hms_errors')
        // The route only decides this optional recovery: a failed read skips it, never the print.
        && (await readPrintRoute(session, {signal}).catch(error => { if (signal?.aborted) throw error; return undefined; }))?.mode === 'bambu_network') {
      const status = resultValue(await call(session, 'get_printer_status', {}, read)) as {raw?: {hms?: {attr?: number; code?: number}[]}};
      const errors = status?.raw?.hms;
      if (Array.isArray(errors) && errors.length === 1 && errors[0]?.attr === 0x05000500 && errors[0]?.code === 0x00010007) {
        await progress('resolving-printer-error');
        await call(session, 'clear_hms_errors', {bambu_model:selection.model}, {signal, elicitationContext: tag});
      }
    }
    await progress('requesting-print');
    let printed: unknown;
    if (this.#config.backend === 'bambu-printer-mcp' || slicedPath.toLowerCase().endsWith('.3mf') || selection.printerType === 'bambu') {
      if (!slicedPath.toLowerCase().endsWith('.3mf')) fail('expected-sliced-3mf');
      const result = await call(session, 'print_3mf', {
        three_mf_path: slicedPath,
        bambu_model: selection.model,
        bed_type: selection.bedType,
        nozzle_type: selection.nozzleType,
        nozzle_diameter: selection.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
        nozzle_diameters: selection.nozzleDiameterMm === undefined ? undefined : [selection.nozzleDiameterMm],
        plate_index: selection.plateIndex ?? 0,
        use_ams: selection.useAms,
        ams_slots: selection.amsSlots,
        ams_mapping: selection.amsMapping,
        auto_match_ams: selection.autoMatchAms,
        bed_leveling: printOptions.bedLeveling,
        flow_calibration: printOptions.flowCalibration,
        vibration_calibration: printOptions.vibrationCalibration,
        layer_inspect: printOptions.layerInspect,
        timelapse: printOptions.timelapse,
      }, {signal, beforeDispatch: input.beforePrint, elicitationContext: printContext});
      printed = resultValue(result);
    } else {
      const result = await call(session, 'upload_gcode', {
        gcode_path: slicedPath,
        print: true,
        filename: basename(slicedPath),
        material: selection.material,
        type: selection.printerType,
        host: selection.host,
        port: selection.port,
      }, {signal, beforeDispatch: input.beforePrint, elicitationContext: printContext});
      printed = resultValue(result);
    }
    step('print');
    await progress('accepted').catch(() => undefined); // Telemetry cannot erase an accepted dispatch.
    return {...common, print: printed, dispatch: dispatchIdentity(printed, slicedPath)};
  }

  /**
   * Runs a stored handoff bundle and records the sliced output back into it.
   * The bundle backend must match this runner's configured backend.
   */
  async runBundle(store: HandoffBundleStore, id: string, options: {print?: boolean; signal?: AbortSignal; slicer?: PrinterSlicer; onProgress?: PrintRunInput['onProgress']; sliceCache?: PrintRunInput['sliceCache']; beforePrint?: PrintRunInput['beforePrint']} = {}) {
    const manifest = await store.read(id);
    if (manifest.backend !== this.#config.backend) fail('backend-mismatch');
    if (manifest.status === 'uncertain') fail('dispatch-uncertain');
    if (manifest.status === 'printed') fail('already-printed');
    // Slice in a throwaway per-run directory: backends write outputs beside
    // the input STL, and a re-slice must never overwrite a manifest-owned
    // artifact before the new one is recorded.
    const workDirectory = await mkdtemp(join(tmpdir(), 'printer-handoff-run-'));
    let dispatched = false;
    try {
      const inputStl = join(workDirectory, basename(store.stlPath(manifest)));
      await copyFile(store.stlPath(manifest), inputStl);
      const result = await this.run({stlPath: inputStl, selection: manifest.selection, slicer: options.slicer, print: options.print, signal: options.signal, bundleId: id, onProgress: options.onProgress,
        ...(options.sliceCache ? {sliceCache: options.sliceCache} : {}),
        persistOutput: async output => {
          // MCP backends may delete scratch files on close. Save both artifacts
          // before dispatch, and give the printer the durable bundle path.
          let saved = await store.recordArtifact(id, 'sliced', basename(output.slicedPath), await readFile(output.slicedPath));
          if (output.orientedStlPath !== inputStl) {
            saved = await store.recordArtifact(id, 'oriented', basename(output.orientedStlPath), await readFile(output.orientedStlPath));
          }
          return {slicedPath: join(store.directory(id), saved.artifacts.sliced!.file),
            orientedStlPath: saved.artifacts.oriented ? join(store.directory(id), saved.artifacts.oriented.file) : store.stlPath(saved)};
        },
        // The caller's last check runs first: if it refuses, nothing was dispatched and the bundle is not uncertain.
        beforePrint: async () => { await options.beforePrint?.(); await store.setStatus(id, 'uncertain', 'dispatch-uncertain'); },
      });
      dispatched = options.print !== false;
      // A later artifact write must not erase a successful print dispatch
      // and make the phone offer the same bundle for printing again.
      if (dispatched) await store.setStatus(id, 'printed');
      const updated = await store.setStatus(id, options.print === false ? 'sliced' : 'printed');
      // Report persisted bundle paths, not the throwaway run directory.
      const persisted: PrintRunResult = {
        ...result,
        stlPath: store.stlPath(updated),
        orientedStlPath: updated.artifacts.oriented
          ? join(store.directory(id), updated.artifacts.oriented.file)
          : store.stlPath(updated),
        slicedPath: join(store.directory(id), updated.artifacts.sliced!.file),
      };
      return {manifest: updated, result: persisted};
    } catch (error) {
      await store.setStatus(id, dispatched ? 'printed' : sanitizedFailureReason(error) === 'dispatch-uncertain' ? 'uncertain' : 'failed', sanitizedFailureReason(error)).catch(() => undefined);
      throw dispatched ? new DispatchedPrintError(error) : error;
    } finally {
      await rm(workDirectory, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  /** mcp-3D-printer-server's one-call extend-and-print pipeline. */
  async processAndPrint(input: ProcessAndPrintInput): Promise<{catalog: PrinterToolCatalog; result: unknown}> {
    if (this.#config.backend !== 'mcp-3d-printer-server') fail('unsupported-backend');
    if (!isAbsolute(input.stlPath)) fail('invalid-stl-path');
    const selection: PrinterSelection = {...this.#config.selection, ...input.selection};
    return this.#use(async session => {
      const catalog = await session.connect(input.signal ? {signal: input.signal} : {});
      this.#onStep?.('discover');
      const result = await call(session, 'process_and_print_stl', {
        stl_path: input.stlPath,
        extension_inches: input.extensionInches,
        material: input.material ?? selection.material,
        type: selection.printerType,
        host: selection.host,
        port: selection.port,
      }, {signal: input.signal, elicitationContext: {}});
      this.#onStep?.('print');
      return {catalog, result: resultValue(result)};
    });
  }
}
