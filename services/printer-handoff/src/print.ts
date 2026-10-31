import {readFile} from 'node:fs/promises';
import {basename, isAbsolute} from 'node:path';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {
  printerHandoffConfigSchema,
  type PrinterHandoffConfig, type PrinterSelection, type PrinterSlicer, type PrinterPrintOptions,
} from './config.js';
import type {ElicitationRelay} from './elicitation.js';
import type {HandoffBundleStore} from './bundle.js';
import {PrinterMcpClient, PrinterMcpError, toolResultJson, toolResultText, type PrinterToolCatalog} from './mcp-client.js';

export type PrintStep = 'discover' | 'lay_flat' | 'slice_stl' | 'inspect' | 'camera_snapshot' | 'print';
export interface PrintRunInput {
  stlPath: string;
  selection?: PrinterSelection;
  slicer?: PrinterSlicer;
  printOptions?: PrinterPrintOptions;
  /** Set false to stop after slicing and inspection. Defaults to printing. */
  print?: boolean;
  signal?: AbortSignal;
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
async function call(client: PrinterMcpClient, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  return client.callTool(name, filtered(client, name, args), {signal});
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

  constructor(config: PrinterHandoffConfig, options: {relay?: ElicitationRelay; onStep?: (step: PrintStep) => void} = {}) {
    this.#config = printerHandoffConfigSchema.parse(structuredClone(config));
    this.#relay = options.relay;
    this.#onStep = options.onStep;
  }

  get backend(): PrinterHandoffConfig['backend'] { return this.#config.backend; }

  private client(): PrinterMcpClient { return new PrinterMcpClient(this.#config, {relay: this.#relay}); }

  /** Connects, lists the server's tools, and disconnects without calling any tool. */
  async discover(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    const client = this.client();
    try { return await client.connect(signal); }
    finally { await client.close().catch(() => undefined); }
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
    try {
      const catalog = await client.connect(input.signal);
      step('discover');
      let orientedStlPath = input.stlPath;
      const laidFlat = client.hasTool('lay_flat');
      if (laidFlat) {
        orientedStlPath = absolutePath(await call(client, 'lay_flat', {stl_path: input.stlPath}, input.signal));
        step('lay_flat');
      }
      const slicedPath = absolutePath(await call(client, 'slice_stl', {
        stl_path: orientedStlPath,
        bambu_model: isBambuSlicing(this.#config, selection, slicer) ? selection.model : undefined,
        nozzle_diameter: selection.nozzleDiameterMm === undefined ? undefined : String(selection.nozzleDiameterMm),
        bed_type: selection.bedType,
        nozzle_type: selection.nozzleType,
        slicer_type: slicer.type,
        slicer_profile: slicer.profile,
        filament_profile: slicer.filamentProfile,
        load_filaments: slicer.loadFilaments,
        template_name: slicer.templateName,
        use_printer_filaments: false,
        // lay_flat already chose the flat face; otherwise let the slicer orient.
        orient: !laidFlat,
        arrange: true,
        ensure_on_bed: true,
      }, input.signal));
      step('slice_stl');
      const inspection = await this.inspect(client, slicedPath, selection, input.signal);
      if (inspection) step('inspect');
      const common = {backend: this.#config.backend, catalog, stlPath: input.stlPath, orientedStlPath, slicedPath, inspection, steps};
      if (input.print === false) return common;

      let cameraSnapshot: Record<string, unknown> | undefined;
      if (this.#config.backend === 'bambu-printer-mcp' && this.#config.cameraSnapshot !== false && client.hasTool('camera_snapshot')) {
        try {
          const snapshot = toolResultJson<Record<string, unknown>>(
            await call(client, 'camera_snapshot', {bambu_model: selection.model, timeout_ms: 8000}, input.signal));
          if (typeof snapshot.base64 === 'string' && snapshot.base64) {
            cameraSnapshot = snapshot;
            client.setElicitationContext({cameraSnapshot: {
              format: typeof snapshot.format === 'string' ? snapshot.format : 'jpeg',
              base64: snapshot.base64,
              ...(typeof snapshot.savedTo === 'string' ? {savedTo: snapshot.savedTo} : {}),
            }});
            step('camera_snapshot');
          }
        } catch { /* The print prompts still go to the user without an image. */ }
      }

      let printed: unknown;
      try {
        if (this.#config.backend === 'bambu-printer-mcp' || slicedPath.toLowerCase().endsWith('.3mf') || selection.printerType === 'bambu') {
          if (!slicedPath.toLowerCase().endsWith('.3mf')) fail('expected-sliced-3mf');
          const result = await call(client, 'print_3mf', {
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
          }, input.signal);
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
          }, input.signal);
          printed = resultValue(result);
        }
      } finally { client.clearElicitationContext(); }
      step('print');
      return {...common, cameraSnapshot, print: printed};
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Runs a stored handoff bundle and records the sliced output back into it.
   * The bundle backend must match this runner's configured backend.
   */
  async runBundle(store: HandoffBundleStore, id: string, options: {print?: boolean; signal?: AbortSignal} = {}) {
    const manifest = await store.read(id);
    if (manifest.backend !== this.#config.backend) fail('backend-mismatch');
    let result: PrintRunResult;
    try {
      result = await this.run({stlPath: store.stlPath(manifest), selection: manifest.selection, print: options.print, signal: options.signal});
    } catch (error) {
      await store.setStatus(id, 'failed', error instanceof Error ? error.message : 'print failed').catch(() => undefined);
      throw error;
    }
    const sliced = await readFile(result.slicedPath);
    let updated = await store.recordArtifact(id, 'sliced', basename(result.slicedPath), sliced);
    updated = await store.setStatus(id, options.print === false ? 'sliced' : 'printed');
    return {manifest: updated, result};
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
