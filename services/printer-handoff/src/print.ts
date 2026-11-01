import {copyFile, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, isAbsolute, join} from 'node:path';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  printerHandoffConfigSchema,
  type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrinterPrintOptions,
} from './config.js';
import type {ElicitationRelay} from './elicitation.js';
import {sliceEstimate, type SliceEstimate} from './slice-estimate.js';
import type {HandoffBundleStore} from './bundle.js';
import {PrinterMcpClient, PrinterMcpError, toolResultJson, toolResultText, type PrinterToolCatalog} from './mcp-client.js';

export type PrintStep = 'discover' | 'lay_flat' | 'slice_stl' | 'inspect' | 'camera_snapshot' | 'print';
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
}
export interface PrintRunResult {
  backend: PrinterHandoffConfig['backend'];
  catalog: PrinterToolCatalog;
  stlPath: string;
  orientedStlPath: string;
  slicedPath: string;
  inspection?: {tool: string; result: unknown};
  cameraSnapshot?: Record<string, unknown>;
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
function filtered(client: PrinterMcpClient, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool: Tool = client.getTool(name);
  const clean = defined(args);
  const properties = (tool.inputSchema as {properties?: unknown}).properties;
  if (!properties || typeof properties !== 'object') return clean;
  const allowed = new Set(Object.keys(properties));
  return Object.fromEntries(Object.entries(clean).filter(([key]) => allowed.has(key)));
}
async function call(client: PrinterMcpClient, name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeDispatch?: () => Promise<void>) {
  const dispatchSensitive = ['print_3mf', 'upload_gcode', 'process_and_print_stl'].includes(name);
  return client.callTool(name, filtered(client, name, args), {signal, dispatchSensitive, beforeDispatch});
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
function isBambuSlicing(config: PrinterHandoffConfig, selection: PrinterSelection, slicer?: PrinterSlicer): boolean {
  if (config.backend === 'bambu-printer-mcp') return true;
  if (selection.printerType === 'bambu') return true;
  const type = (slicer?.type ?? '').toLowerCase();
  return type === 'bambustudio' || type === 'orcaslicer-bambulab' || type === 'fulu-orca' || type === 'orca-studio';
}

export class PrinterHandoffRunner {
  readonly #config: PrinterHandoffConfig;
  readonly #relay?: ElicitationRelay;
  readonly #onStep?: (step: PrintStep) => void;
  readonly #onStderr?: (chunk: string) => void;

  constructor(config: PrinterHandoffConfig, options: {relay?: ElicitationRelay; onStep?: (step: PrintStep) => void; onStderr?: (chunk: string) => void} = {}) {
    this.#config = printerHandoffConfigSchema.parse(structuredClone(config));
    this.#relay = options.relay;
    this.#onStep = options.onStep;
    this.#onStderr = options.onStderr;
  }

  get backend(): PrinterHandoffConfig['backend'] { return this.#config.backend; }

  private client(): PrinterMcpClient { return new PrinterMcpClient(this.#config, {relay: this.#relay, onStderr: this.#onStderr}); }

  /** Connects, lists the server's tools, and disconnects without calling any tool. */
  async discover(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    const client = this.client();
    try { return await client.connect(signal); }
    finally { await client.close().catch(() => undefined); }
  }

  /** Display-only printer status, using the configured route and the standard MCP tool. */
  async status(signal?: AbortSignal): Promise<unknown> {
    const client = this.client();
    try {
      await client.connect(signal);
      if (!client.hasTool('get_printer_status')) return undefined;
      const selection = this.#config.selection;
      return resultValue(await call(client, 'get_printer_status', {
        host: selection?.host, type: selection?.printerType, port: selection?.port,
      }, signal));
    } finally { await client.close().catch(() => undefined); }
  }

  /** Read the printer's live material inventory without starting or uploading a print. */
  async filaments(signal?: AbortSignal): Promise<unknown> {
    const client = this.client();
    try {
      await client.connect(signal);
      if (!client.hasTool('get_printer_filaments')) fail('filament-inventory-unavailable');
      const selection = this.#config.selection;
      return resultValue(await call(client, 'get_printer_filaments', {
        bambu_model: selection?.model,
        nozzle_diameter: selection?.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
      }, signal));
    } finally { await client.close().catch(() => undefined); }
  }

  private async inspect(client: PrinterMcpClient, slicedPath: string, selection: PrinterSelection, signal?: AbortSignal) {
    if (client.hasTool('inspect_print_file')) {
      const result = await call(client, 'inspect_print_file', {
        file_path: slicedPath,
        bambu_model: selection.model,
        plate_index: selection.plateIndex ?? 0,
        nozzle_diameters: selection.nozzleDiameterMm === undefined ? undefined : [selection.nozzleDiameterMm],
        bed_type: selection.bedType,
      }, signal);
      return {tool: 'inspect_print_file', result: toolResultJson(result)};
    }
    if (slicedPath.toLowerCase().endsWith('.gcode') && client.hasTool('confirm_temperatures')) {
      const result = await call(client, 'confirm_temperatures', {gcode_path: slicedPath}, signal);
      return {tool: 'confirm_temperatures', result: toolResultJson(result)};
    }
    return undefined;
  }

  /**
   * Runs one handoff: lay flat -> slice -> inspect -> print, using the tool
   * sequence of the configured backend. Print confirmations are elicited by
   * the server during the print call and answered through the relay.
   */
  async run(input: PrintRunInput): Promise<PrintRunResult> {
    if (!isAbsolute(input.stlPath)) fail('invalid-stl-path');
    const selection: PrinterSelection = {...this.#config.selection, ...input.selection};
    const slicer: PrinterSlicer = {...this.#config.slicer, ...input.slicer};
    const printOptions: PrinterPrintOptions = {...this.#config.print, ...input.printOptions};
    const steps: PrintStep[] = [];
    const step = (name: PrintStep) => { steps.push(name); this.#onStep?.(name); };
    const client = this.client();
    const tag = input.bundleId === undefined ? {} : {bundleId: input.bundleId};
    client.setElicitationContext(tag);
    const progress = async (phase: PrintPhase, estimate?: SliceEstimate) => { await input.onProgress?.({phase, ...(estimate ? {estimate} : {})}); };
    try {
      await progress('connecting');
      const catalog = await client.connect(input.signal);
      step('discover');
      if (selection.connectionMode || selection.connectionType) {
        const properties = client.getTool('print_3mf').inputSchema.properties ?? {};
        if ((selection.connectionMode && !Object.hasOwn(properties, 'connection_mode'))
            || (selection.connectionType && !Object.hasOwn(properties, 'connection_type'))) fail('print-transport-unsupported');
      }
      if (slicer.filamentColours) {
        const sliceProperties = client.getTool('slice_stl').inputSchema.properties ?? {};
        if (!Object.hasOwn(sliceProperties, 'filament_colours') || !Object.hasOwn(sliceProperties, 'load_filaments'))
          fail('filament-selection-unsupported');
        if (input.print !== false) {
          const printProperties = client.getTool('print_3mf').inputSchema.properties ?? {};
          if (!Object.hasOwn(printProperties, 'ams_slots') || !Object.hasOwn(printProperties, 'use_ams'))
            fail('filament-selection-unsupported');
        }
      }
      let orientedStlPath = input.stlPath;
      const laidFlat = client.hasTool('lay_flat');
      if (laidFlat) {
        await progress('orienting');
        orientedStlPath = absolutePath(await call(client, 'lay_flat', {stl_path: input.stlPath}, input.signal));
        step('lay_flat');
      }
      await progress('slicing');
      let slicedPath = absolutePath(await call(client, 'slice_stl', {
        stl_path: orientedStlPath,
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
        use_printer_filaments: false,
        // lay_flat already chose the flat face; otherwise let the slicer orient.
        orient: !laidFlat,
        arrange: true,
        ensure_on_bed: true,
      }, input.signal));
      step('slice_stl');
      const estimate = await sliceEstimate(await readFile(slicedPath), selection.plateIndex ?? 0);
      await progress('inspecting', estimate);
      const inspection = await this.inspect(client, slicedPath, selection, input.signal);
      if (inspection) step('inspect');
      if (input.persistOutput) ({slicedPath, orientedStlPath} = await input.persistOutput({slicedPath, orientedStlPath}));
      await progress('slice-ready', estimate);
      const common = {backend: this.#config.backend, catalog, stlPath: input.stlPath, orientedStlPath, slicedPath, inspection, steps};
      if (input.print === false) return common;

      await progress('checking-printer');
      let cameraSnapshot: Record<string, unknown> | undefined;
      if (this.#config.backend === 'bambu-printer-mcp' && this.#config.cameraSnapshot !== false && client.hasTool('camera_snapshot')) {
        try {
          const snapshot = toolResultJson<Record<string, unknown>>(
            await call(client, 'camera_snapshot', {bambu_model: selection.model, timeout_ms: 8000}, input.signal));
          if (typeof snapshot.base64 === 'string' && snapshot.base64) {
            cameraSnapshot = snapshot;
            client.setElicitationContext({...tag, cameraSnapshot: {
              format: typeof snapshot.format === 'string' ? snapshot.format : 'jpeg',
              base64: snapshot.base64,
              ...(typeof snapshot.savedTo === 'string' ? {savedTo: snapshot.savedTo} : {}),
            }});
            step('camera_snapshot');
          }
        } catch { /* The print prompts still go to the user without an image. */ }
      }

      // A rejected unsigned command leaves a software HMS error. The authenticated
      // LAN route can recover it only through the server's own human confirmation.
      if (this.#config.backend === 'bambu-printer-mcp' && selection.connectionMode === 'bambu_network'
          && client.hasTool('get_printer_status') && client.hasTool('clear_hms_errors')) {
        const status = resultValue(await call(client, 'get_printer_status', {}, input.signal)) as {raw?: {hms?: {attr?: number; code?: number}[]}};
        const errors = status?.raw?.hms;
        if (Array.isArray(errors) && errors.length === 1 && errors[0]?.attr === 0x05000500 && errors[0]?.code === 0x00010007) {
          await progress('resolving-printer-error');
          await call(client, 'clear_hms_errors', {bambu_model:selection.model}, input.signal);
        }
      }
      await progress('requesting-print');
      let printed: unknown;
      try {
        if (this.#config.backend === 'bambu-printer-mcp' || slicedPath.toLowerCase().endsWith('.3mf') || selection.printerType === 'bambu') {
          if (!slicedPath.toLowerCase().endsWith('.3mf')) fail('expected-sliced-3mf');
          const result = await call(client, 'print_3mf', {
            three_mf_path: slicedPath,
            connection_mode: selection.connectionMode,
            connection_type: selection.connectionType,
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
          }, input.signal, input.beforePrint);
          printed = resultValue(result);
        } else {
          const result = await call(client, 'upload_gcode', {
            gcode_path: slicedPath,
            print: true,
            filename: basename(slicedPath),
            material: selection.material,
            type: selection.printerType,
            host: selection.host,
            port: selection.port,
          }, input.signal, input.beforePrint);
          printed = resultValue(result);
        }
      } finally { client.setElicitationContext(tag); }
      step('print');
      await progress('accepted').catch(() => undefined); // Telemetry cannot erase an accepted dispatch.
      return {...common, cameraSnapshot, print: printed};
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Runs a stored handoff bundle and records the sliced output back into it.
   * The bundle backend must match this runner's configured backend.
   */
  async runBundle(store: HandoffBundleStore, id: string, options: {print?: boolean; signal?: AbortSignal; slicer?: PrinterSlicer; onProgress?: PrintRunInput['onProgress']} = {}) {
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
        beforePrint: async () => { await store.setStatus(id, 'uncertain', 'dispatch-uncertain'); },
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
    const client = this.client();
    try {
      const catalog = await client.connect(input.signal);
      this.#onStep?.('discover');
      const result = await call(client, 'process_and_print_stl', {
        stl_path: input.stlPath,
        extension_inches: input.extensionInches,
        material: input.material ?? selection.material,
        type: selection.printerType,
        host: selection.host,
        port: selection.port,
      }, input.signal);
      this.#onStep?.('print');
      return {catalog, result: resultValue(result)};
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
