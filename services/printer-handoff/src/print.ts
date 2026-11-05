import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, extname, isAbsolute, join} from 'node:path';
import type {ElicitResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  printerHandoffConfigSchema,
  type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrinterPrintOptions,
} from './config.js';
import type {ElicitationContext, ElicitationRelay} from './elicitation.js';
import {slicedFacts, type SliceEstimate, type SliceSettings} from './slice-estimate.js';
import {inspectModelFile} from './model-file.js';
import {lacksSlicerReport, slicerReport} from './slicer-report.js';
import {slicePreview, type SlicePreview} from './slice-preview.js';
import {createHash} from 'node:crypto';
import type {HandoffBundleStore} from './bundle.js';
import {PrinterMcpError, toolResultJson, toolResultText, type McpProgress, type PrinterToolCatalog} from './mcp-client.js';
import {PrinterSession} from './session.js';
import {packageLabel, readPrinterInfo} from './counterpart.js';

export type PrintStep = 'discover' | 'lay_flat' | 'slice_stl' | 'inspect' | 'print';
export type PrintPhase = 'connecting' | 'orienting' | 'slicing' | 'inspecting' | 'slice-ready' | 'checking-printer' | 'requesting-print' | 'accepted';
/** `mcp`: the printer MCP's own progress during that phase (slicing, requesting the print), when it sends any. */
export interface PrintProgress {phase: PrintPhase; estimate?: SliceEstimate; mcp?: McpProgress}
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
  /**
   * The sliced file the person was shown (an estimate's `sliced`): printed as it is, never sliced again.
   * With `expectedSha256`, the MCP's inspection of what is about to be sent must report that same hash.
   */
  presliced?: {bytes: Buffer; extension: string; slicerWarning?: string; plateCount?: number};
  /** The SHA-256 of the file the person saw previewed. Printing refuses (`preview-mismatch`) unless the inspected file has it. */
  expectedSha256?: string;
  /** Ask the MCP's inspect_print_file for its G-code preview of the sliced file. */
  preview?: boolean;
  /**
   * A question Counterpart asks before slicing, through the relay that carries the printer's own questions.
   * The print goes on only when the person picks `proceed`; any other choice, a decline or a timeout stops
   * before anything is sliced or sent (PrinterMcpError `print-choice`, detail = the choice or `declined`).
   * Asked only when printing: an estimate never asks.
   */
  ask?: PrintAsk;
}
/** A choice put to the person before a print (`PrintRunInput.ask`). */
export interface PrintAsk {message: string; title: string; choices: {value: string; title: string}[]; proceed: string}
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
interface CallOptions {signal?: AbortSignal; beforeDispatch?: () => Promise<void>; elicitationContext?: ElicitationContext; failFast?: boolean; onProgress?: (progress: McpProgress) => void}
async function call(session: PrinterSession, name: string, args: Record<string, unknown>, options: CallOptions = {}) {
  return session.call(name, filtered(session, name, args), {
    ...(options.signal ? {signal: options.signal} : {}),
    ...(DISPATCH_TOOLS.includes(name) ? {dispatchSensitive: true} : {}),
    ...(options.beforeDispatch ? {beforeDispatch: options.beforeDispatch} : {}),
    ...(options.elicitationContext ? {elicitationContext: options.elicitationContext} : {}),
    ...(options.failFast ? {failFast: true} : {}),
    ...(options.onProgress ? {onProgress: options.onProgress} : {}),
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
   * Slices the model exactly as a print would, then reads the
   * time, grams and settings from the sliced file. Never prints.
   */
  async estimate(input: {stlPath: string; selection?: PrinterSelection; slicer?: PrinterSlicer; signal?: AbortSignal}): Promise<{estimate?: SliceEstimate; settings: SliceSettings; slicerWarning?: string;
    /** The exact sliced file this estimate describes, to be printed as it is (`PrintRunInput.presliced`). */
    sliced: {bytes: Buffer; extension: string; sha256: string; slicerWarning?: string};
    /** The MCP's picture of that file's G-code (inspect_print_file `preview`), when it draws one. */
    preview?: SlicePreview;
    /** False when the installed MCP's inspect_print_file can't draw previews at all (an update would). */
    previewSupported: boolean}> {
    let sliced: Buffer | undefined, extension = '.3mf';
    const {slicerWarning, inspection} = await this.run({stlPath: input.stlPath, print: false, preview: true, ...(input.selection ? {selection: input.selection} : {}), ...(input.slicer ? {slicer: input.slicer} : {}),
      ...(input.signal ? {signal: input.signal} : {}),
      // Read the output while the MCP is alive: a one-shot backend may delete it when it closes.
      persistOutput: async output => { sliced = await readFile(output.slicedPath); extension = extname(output.slicedPath) || '.3mf'; return output; }});
    if (!sliced) fail('invalid-output-path');
    const sha256 = createHash('sha256').update(sliced).digest('hex');
    const preview = slicePreview(inspection?.result, sha256);
    const previewSupported = (inspection as {previewAsked?: boolean} | undefined)?.previewAsked === true;
    // The MCP's reading of that exact file (inspect_print_file `sliced`).
    const {estimate, settings} = slicedFacts(inspection?.result);
    return {...(estimate ? {estimate} : {}), settings, ...(slicerWarning ? {slicerWarning} : {}),
      sliced: {bytes: sliced, extension, sha256, ...(slicerWarning ? {slicerWarning} : {})}, ...(preview ? {preview} : {}), previewSupported};
  }

  /** Connects and lists the server's tools without calling one (a one-shot session then disconnects). */
  async discover(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    return this.#use(session => session.connect(signal ? {signal} : {}));
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

  private async inspect(session: PrinterSession, slicedPath: string, selection: PrinterSelection, options: CallOptions, preview = false) {
    if (session.hasTool('inspect_print_file')) {
      const takesPreview = preview && Object.hasOwn(session.getTool('inspect_print_file').inputSchema.properties ?? {}, 'include_preview');
      const result = await call(session, 'inspect_print_file', {
        ...(takesPreview ? {include_preview: true} : {}),
        file_path: slicedPath,
        bambu_model: selection.model,
        plate_index: selection.plateIndex ?? 0,
        nozzle_diameters: selection.nozzleDiameterMm === undefined ? undefined : [selection.nozzleDiameterMm],
        bed_type: selection.bedType,
      }, options);
      return {tool: 'inspect_print_file', result: toolResultJson(result), previewAsked: takesPreview};
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

  /** Puts `ask` to the person; returns only when they pick `ask.proceed`. */
  async #choose(ask: PrintAsk, context: ElicitationContext, signal?: AbortSignal): Promise<void> {
    const stopped = (choice: string) => new PrinterMcpError('print-choice', undefined, choice);
    const relay = this.#relay;
    if (!relay) throw stopped('declined');
    if (signal?.aborted) fail('cancelled');
    let id: string | undefined;
    const stop = relay.subscribe(pending => { id ??= pending.id; });
    let answer: Promise<ElicitResult>;
    try {
      answer = relay.request({method: 'elicitation/create', params: {mode: 'form', message: ask.message, requestedSchema: {
        type: 'object', required: ['choice'],
        properties: {choice: {type: 'string', title: ask.title, oneOf: ask.choices.map(choice => ({const: choice.value, title: choice.title}))}},
      }}}, context);
    } finally { stop(); }
    const abort = () => { if (id) relay.respond(id, {action: 'cancel'}); };
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const result = await answer;
      if (signal?.aborted) fail('cancelled');
      const choice = result.action === 'accept' && typeof result.content?.choice === 'string' ? result.content.choice : 'declined';
      if (choice !== ask.proceed) throw stopped(choice);
    } finally { signal?.removeEventListener('abort', abort); }
  }

  /**
   * Runs one handoff: slice -> inspect -> print, using the tool
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
      for (const key of ['loadFilaments', 'filamentProfile', 'filamentColours', 'templateName', 'quality', 'strength', 'layerHeightMm', 'wallLoops', 'sparseInfillDensity', 'enableSupport', 'supportType'] as const) {
        if (input.slicer?.[key] === undefined) delete slicer[key];
      }
    }
    if (alreadySliced && slicer.pauseAtLayers?.length)
      throw new PrinterMcpError('published-sliced-settings', undefined, 'This file is already sliced, so its layer pauses are the ones it was sliced with. Share the designer’s editable 3MF to add a pause.');
    if (alreadySliced && ((slicer.repetitions ?? 1) !== 1 || ['quality', 'strength', 'layerHeightMm', 'wallLoops', 'sparseInfillDensity', 'enableSupport', 'supportType', 'loadFilaments', 'filamentProfile', 'filamentColours', 'templateName'].some(key => Object.hasOwn(input.slicer ?? {}, key))))
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
    // Counterpart's own question comes first: nothing is sliced or sent until the person picks the print.
    if (input.ask && input.print !== false) await this.#choose(input.ask, tag, signal);
    const local: CallOptions = {signal, ...(shared ? (selection.model ? {} : {elicitationContext: tag}) : {elicitationContext: tag})};
    const progress = async (phase: PrintPhase, estimate?: SliceEstimate) => { await input.onProgress?.({phase, ...(estimate ? {estimate} : {})}); };
    const mcpProgress = (phase: PrintPhase) => (mcp: McpProgress) => { void input.onProgress?.({phase, mcp})?.catch(() => undefined); };
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
    // What this MCP's slice can apply (supports, copies, orient): the MCP says, the app never knows slicers (PRD §8.0).
    // An MCP without it (older than bambu-printer-mcp 1.1.58 / mcp-3d-printer-server 1.2.32) gets none of them.
    const info = await readPrinterInfo(session, {...(signal ? {signal} : {})}).catch(() => undefined);
    const slicing = info?.capabilities.slicing;
    // A chosen quality or strength the MCP can't apply is refused, never silently printed at preset values.
    {
      const sliceProperties = session.getTool('slice_stl').inputSchema.properties ?? {};
      if ((slicer.quality !== undefined && slicer.quality !== 'standard' && !Object.hasOwn(sliceProperties, 'quality'))
          || (slicer.strength !== undefined && slicer.strength !== 'standard' && !Object.hasOwn(sliceProperties, 'strength'))
          || (slicer.layerHeightMm !== undefined && !Object.hasOwn(sliceProperties, 'layer_height'))
          || (slicer.wallLoops !== undefined && !Object.hasOwn(sliceProperties, 'wall_loops'))
          || (slicer.sparseInfillDensity !== undefined && !Object.hasOwn(sliceProperties, 'sparse_infill_density'))
          || (slicer.pauseAtLayers?.length && !Object.hasOwn(sliceProperties, 'pause_at_layers'))
          // Supports and copies only where the MCP says its slice applies them (capabilities.slicing, PRD §8.0).
          || ((slicer.enableSupport !== undefined || slicer.supportType !== undefined) && !slicing?.supports)
          || (slicer.enableSupport !== undefined && !Object.hasOwn(sliceProperties, 'enable_support'))
          || (slicer.supportType !== undefined && !Object.hasOwn(sliceProperties, 'support_type'))
              || (slicer.repetitions !== undefined && slicer.repetitions > 1 && (!Object.hasOwn(sliceProperties, 'repetitions') || !slicing?.copies))) fail('print-settings-unsupported');
    }
    // Every slice_stl argument but the model's path.
    const sliceArgs = {
      slice_plate: threeMf ? (selection.plateIndex ?? 0) + 1 : undefined,
      // The printer's configured model, as the person set it; the MCP decides what its slicer does with it.
      bambu_model: selection.model,
      nozzle_diameter: selection.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
      bed_type: selection.bedType,
      nozzle_type: selection.nozzleType,
      slicer_type: slicer.type,
      slicer_profile: slicer.profile,
      filament_profile: slicer.filamentProfile,
      load_filaments: slicer.loadFilaments,
      filament_colours: slicer.filamentColours,
      template_name: slicer.templateName,
      // Standard sends nothing: the preset decides, on MCPs with or without quality and strength.
      quality: slicer.quality === 'standard' ? undefined : slicer.quality,
      strength: slicer.strength === 'standard' ? undefined : slicer.strength,
      layer_height: slicer.layerHeightMm,
      wall_loops: slicer.wallLoops,
      sparse_infill_density: slicer.sparseInfillDensity,
      enable_support: slicer.enableSupport,
      support_type: slicer.supportType,
      pause_at_layers: slicer.pauseAtLayers?.length ? slicer.pauseAtLayers : undefined,
      // Sent whenever it is set and the tool takes it, 1 included: a request for one copy overrides a configured 3.
      repetitions: slicer.repetitions !== undefined && (slicer.repetitions > 1 || Object.hasOwn(session.getTool('slice_stl').inputSchema.properties ?? {}, 'repetitions'))
        ? slicer.repetitions : undefined,
      use_printer_filaments: false,
      arrange: !threeMf || (slicer.repetitions ?? 1) > 1,
      ensure_on_bed: !threeMf,
      // An STL is oriented by the slicer where the MCP says it can (capabilities.slicing.orient); a 3MF keeps its placement.
      orient: threeMf ? false : slicing?.orient ? true : undefined,
    };
    // The file the person was shown is printed as it is: it is never sliced again (see expectedSha256 below).
    // Slicing the same model the same way again is the MCP's to reuse (its slice cache), not Counterpart's.
    const reused = input.presliced && !alreadySliced ? input.presliced : undefined;
    // Counterpart is a bridge: the model goes to the slicer as it is, and the slicer orients it.
    let orientedStlPath = input.stlPath;
    if (threeMf && !alreadySliced && !Object.hasOwn(session.getTool('slice_stl').inputSchema.properties ?? {}, 'slice_plate'))
      throw new PrinterMcpError('plate-selection-unsupported', undefined, 'Update your printer service to slice the selected 3MF plate.');
    if (!alreadySliced && !reused) await progress('slicing');
    const sliced = alreadySliced || reused ? undefined : await call(session, 'slice_stl', {
      stl_path: orientedStlPath,
      ...sliceArgs,
    }, {...local, onProgress: mcpProgress('slicing')});
    let slicedPath = sliced ? absolutePath(sliced) : input.stlPath;
    if (reused) {
      // Named as a fresh slice of this input would be: the printer's job is named after the file.
      slicedPath = join(dirname(input.stlPath), `${basename(input.stlPath, extname(input.stlPath))}_sliced${reused.extension}`);
      await writeFile(slicedPath, reused.bytes, {mode: 0o600});
    }
    if (sliced) step('slice_stl');
    // Studio's own verdict on this slice (absent from an MCP that returns only the path): an error is
    // never printed, and a warning is printed only on the user's explicit go, as in Studio.
    // An MCP that passes the slicer's result.json but not its verdict could hide a slicer warning: Update.
    if (sliced && lacksSlicerReport(sliced.structuredContent))
      throw new PrinterMcpError('slicer-report-unavailable', undefined, `Update ${packageLabel(this.#config.backend)} in Settings → Printers to print from Counterpart.`);
    const report = reused ? undefined : slicerReport(sliced?.structuredContent);
    if (report?.failed) throw new PrinterMcpError('slicer-error', undefined, report.message);
    const slicerWarning = reused ? reused.slicerWarning : report?.message;
    await progress('inspecting');
    const inspection = await this.inspect(session, slicedPath, selection, local, input.preview === true);
    // The MCP's reading of the exact file (inspect_print_file `sliced`): its plates, estimate and settings.
    const facts = slicedFacts(inspection?.result);
    // Either reading of a second plate counts: the file's plates or the ones the slicer says it sliced.
    const plateCount = Math.max(facts.plateCount ?? 0, report?.plateCount ?? 0, reused?.plateCount ?? 0) || undefined;
    // Copies in this flow mean copies in one print. The MCP dispatches one selected plate,
    // so never present one plate's estimate or dispatch as fulfilling a multi-plate request.
    if ((slicer.repetitions ?? 1) > 1 && plateCount && plateCount > 1) {
      throw new PrinterMcpError('copies-multiple-plates', undefined,
        `The slicer placed ${slicer.repetitions} copies on ${plateCount} plates, requiring ${plateCount} separate prints. Choose fewer copies for this print.`);
    }
    const estimate = facts.estimate;
    if (input.expectedSha256 !== undefined) {
      // What was previewed is what prints: the MCP's own hash of the exact file about to be sent.
      const sent = (inspection?.result as {artifact?: {sha256?: string}} | undefined)?.artifact?.sha256;
      if (inspection?.tool !== 'inspect_print_file' || sent !== input.expectedSha256)
        throw new PrinterMcpError('preview-mismatch', undefined, 'What would print is not the file you were shown. Open Print again to see it before printing.');
    }
    if (alreadySliced) {
      const receipt = inspection?.result as {artifact?: {sha256?: string}; selection?: {plate_index?: number; bambu_model?: string}; inspection?: unknown} | undefined;
      if (inspection?.tool !== 'inspect_print_file' || receipt?.artifact?.sha256 !== model!.sha256 || receipt.selection?.plate_index !== (selection.plateIndex ?? 0) || receipt.selection?.bambu_model !== selection.model)
        throw new PrinterMcpError('published-inspection-required', undefined, 'This sliced file needs a compatible printer and a current printer service that can check it.');
    }
    if (inspection) step('inspect');
    if (input.persistOutput) ({slicedPath, orientedStlPath} = await input.persistOutput({slicedPath, orientedStlPath}));
    // The file the printer is sent is the saved copy: it too must be the one previewed.
    if (input.expectedSha256 !== undefined && createHash('sha256').update(await readFile(slicedPath)).digest('hex') !== input.expectedSha256)
      throw new PrinterMcpError('preview-mismatch', undefined, 'What would print is not the file you were shown. Open Print again to see it before printing.');
    await progress('slice-ready', estimate);
    const common = {backend: this.#config.backend, catalog, stlPath: input.stlPath, orientedStlPath, slicedPath, inspection, steps,
      ...(slicerWarning ? {slicerWarning} : {})};
    if (input.print === false) return common;
    if (slicerWarning) await this.#slicerGo(slicerWarning, tag, signal);

    await progress('checking-printer');
    // PRD §5.6: no bed check. Bambu's own bed levelling finds a full plate; the MCP's own confirmation is relayed as it asks.
    const printContext: ElicitationContext = tag;

    // The printer MCP owns its route and the printer's errors: Print never clears one itself.
    await progress('requesting-print');
    let printed: unknown;
    // How a sliced file is sent is the MCP's to say (counterpart_printer_info print3mf / gcode), never the package's.
    if (!info) throw new PrinterMcpError('print-unavailable', undefined, `Update ${packageLabel(this.#config.backend)} in Settings → Printers to print from Counterpart.`);
    if (slicedPath.toLowerCase().endsWith('.3mf')) {
      if (!info.capabilities.print3mf) fail('expected-sliced-gcode');
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
      }, {signal, beforeDispatch: input.beforePrint, elicitationContext: printContext, onProgress: mcpProgress('requesting-print')});
      printed = resultValue(result);
    } else {
      if (!info.capabilities.gcode) fail('expected-sliced-3mf');
      const result = await call(session, 'upload_gcode', {
        gcode_path: slicedPath,
        print: true,
        filename: basename(slicedPath),
        material: selection.material,
        type: selection.printerType,
        host: selection.host,
        port: selection.port,
      }, {signal, beforeDispatch: input.beforePrint, elicitationContext: printContext, onProgress: mcpProgress('requesting-print')});
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
  async runBundle(store: HandoffBundleStore, id: string, options: {print?: boolean; signal?: AbortSignal; slicer?: PrinterSlicer; onProgress?: PrintRunInput['onProgress']; beforePrint?: PrintRunInput['beforePrint']; ask?: PrintAsk;
    presliced?: PrintRunInput['presliced']; expectedSha256?: string} = {}) {
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
        ...(options.ask ? {ask: options.ask} : {}),
        ...(options.presliced ? {presliced: options.presliced} : {}), ...(options.expectedSha256 !== undefined ? {expectedSha256: options.expectedSha256} : {}),
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
