import {basename} from 'node:path';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {PrinterBackend, PrinterHandoffConfig, PrinterSelection} from './config.js';
import {PrinterMcpError, toolResultJson, type PrinterToolCatalog} from './mcp-client.js';
import type {PrinterSession, SessionCallOptions} from './session.js';

/**
 * The consumer side of the `counterpart/1` tool contract (PRD §8.4) that both
 * printer MCPs add, plus the fallback for installs that don't have it yet.
 * Results are validated here; unknown extra fields from a newer MCP are dropped.
 */

const printerKinds = ['bambu', 'octoprint', 'klipper', 'prusa', 'duet', 'repetier', 'creality'] as const;
export const counterpartPrinterInfoSchema = z.object({
  contract: z.literal('counterpart/1'),
  server: z.object({name: z.string().max(128), version: z.string().max(64)}),
  printer: z.object({
    kind: z.enum(printerKinds), model: z.string().max(64).optional(), serial: z.string().max(64).optional(),
    host: z.string().max(255), name: z.string().max(120).optional(),
  }),
  capabilities: z.object({
    progress: z.boolean(), layers: z.boolean(),
    camera: z.enum(['bambu-tcp', 'rtsp', 'http-snapshot', 'none']),
    cameraStream: z.boolean().optional(),
    filaments: z.enum(['ams', 'single', 'none']),
    pause: z.boolean(), resume: z.boolean(), cancel: z.boolean(), print3mf: z.boolean(), gcode: z.boolean(),
  }),
});
export type CounterpartPrinterInfo = z.infer<typeof counterpartPrinterInfoSchema>;

export const printStateSchema = z.enum(['idle', 'preparing', 'printing', 'paused', 'finished', 'failed', 'cancelled', 'offline', 'busy']);
export type PrintState = z.infer<typeof printStateSchema>;
const temp = z.object({actual: z.number().finite(), target: z.number().finite()});
export const counterpartPrintProgressSchema = z.object({
  contract: z.literal('counterpart/1'),
  observedAt: z.iso.datetime({offset: true}),
  state: printStateSchema,
  job: z.object({
    name: z.string().max(256), id: z.string().max(128).optional(),
    progress: z.number().min(0).max(100).optional(), elapsedSec: z.number().nonnegative().optional(),
    remainingSec: z.number().nonnegative().optional(), layer: z.number().int().nonnegative().optional(),
    totalLayers: z.number().int().nonnegative().optional(), stage: z.string().max(120).optional(),
  }).optional(),
  temps: z.object({nozzle: temp.optional(), bed: temp.optional(), chamber: z.number().finite().optional()}).optional(),
  activeFilament: z.object({slot: z.string().max(32).optional(), material: z.string().max(64).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()}).optional(),
  problems: z.array(z.object({
    code: z.string().max(64), severity: z.enum(['fatal', 'error', 'warning', 'info']),
    message: z.string().max(500), url: z.url().optional(),
  })).max(32),
});
export type CounterpartPrintProgress = z.infer<typeof counterpartPrintProgressSchema>;

/**
 * A normalized printer report; `source` says which tool it came from.
 * `stateKnown: false` marks a firmware state that says nothing about printing
 * (Moonraker's Klippy "ready" holds while it prints).
 */
export type PrintReport = Omit<CounterpartPrintProgress, 'contract'> & {source: 'counterpart' | 'status-fallback'; stateKnown?: false};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const textOf = (value: unknown, max = 256): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/** Bambu `gcode_state` → counterpart state (PRD §8.4 table). */
export function bambuState(gcodeState: unknown): PrintState {
  switch (String(gcodeState ?? '').toUpperCase()) {
    case 'IDLE': return 'idle';
    case 'PREPARE': case 'SLICING': return 'preparing';
    case 'RUNNING': return 'printing';
    case 'PAUSE': return 'paused';
    case 'FINISH': return 'finished';
    case 'FAILED': return 'failed';
    default: return 'busy';
  }
}

/** Bambu print_error 0300_400C: "The task was canceled." */
export const BAMBU_CANCELLED = 0x0300400c;
const hex4 = (value: number) => value.toString(16).toUpperCase().padStart(4, '0');
/** `hms[]` entry → `AAAA_BBBB_CCCC_DDDD`, with Bambu's severity in the code's high half. */
export function hmsProblem(entry: unknown): CounterpartPrintProgress['problems'][number] | undefined {
  if (!record(entry)) return undefined;
  const attr = finite(entry.attr), code = finite(entry.code);
  if (attr === undefined || code === undefined || attr < 0 || code < 0 || attr > 0xffffffff || code > 0xffffffff) return undefined;
  const id = [attr >>> 16, attr & 0xffff, code >>> 16, code & 0xffff].map(hex4).join('_');
  const level = code >>> 16;
  const severity = level === 1 ? 'fatal' : level === 2 ? 'error' : level === 4 ? 'info' : 'warning';
  return {code: id, severity, message: `The printer reported problem ${id}.`};
}

/** Maps bambu-printer-mcp's `get_printer_status` result (older installs, PRD §8.4 "Older MCP installs"). */
export function bambuStatusReport(value: unknown, observedAt: Date): PrintReport {
  const at = observedAt.toISOString();
  if (!record(value) || value.connected === false) return {source: 'status-fallback', observedAt: at, state: 'offline', problems: []};
  const raw = record(value.raw) ? value.raw : {};
  const print = record(value.print) ? value.print : {};
  const printError = finite(raw.print_error);
  // A job stopped from the printer or an app reports FAILED with "the task was canceled".
  const state = bambuState(raw.gcode_state ?? value.status) === 'failed' && printError === BAMBU_CANCELLED ? 'cancelled' : bambuState(raw.gcode_state ?? value.status);
  const name = textOf(raw.subtask_name) ?? (textOf(print.filename) !== 'None' ? textOf(print.filename) : undefined);
  const progress = finite(print.progress ?? raw.mc_percent);
  const remainingMin = finite(print.timeRemaining ?? raw.mc_remaining_time);
  const layer = finite(print.currentLayer ?? raw.layer_num), totalLayers = finite(print.totalLayers ?? raw.total_layer_num);
  const taskId = raw.task_id === undefined ? undefined : textOf(String(raw.task_id), 128);
  const problems: CounterpartPrintProgress['problems'] = [];
  if (printError && printError !== BAMBU_CANCELLED) {
    const code = printError.toString(16).toUpperCase().padStart(8, '0');
    problems.push({code, severity: 'error', message: `The printer reported error ${code}.`});
  }
  if (Array.isArray(raw.hms)) for (const entry of raw.hms.slice(0, 31)) { const problem = hmsProblem(entry); if (problem) problems.push(problem); }
  const temps = record(value.temperatures) ? value.temperatures : {};
  const pair = (item: unknown) => record(item) && finite(item.actual) !== undefined && finite(item.target) !== undefined
    ? {actual: finite(item.actual)!, target: finite(item.target)!} : undefined;
  const nozzle = pair(temps.nozzle), bed = pair(temps.bed), chamber = finite(temps.chamber);
  const active = state === 'preparing' || state === 'printing' || state === 'paused';
  return {
    source: 'status-fallback', observedAt: at, state,
    ...(name ? {job: {name,
      ...(taskId ? {id: taskId} : {}),
      ...(progress !== undefined && progress >= 0 && progress <= 100 ? {progress} : {}),
      ...(active && remainingMin !== undefined && remainingMin >= 0 ? {remainingSec: Math.round(remainingMin * 60)} : {}),
      ...(layer !== undefined && layer >= 0 ? {layer: Math.trunc(layer)} : {}),
      ...(totalLayers !== undefined && totalLayers > 0 ? {totalLayers: Math.trunc(totalLayers)} : {}),
    }} : {}),
    ...(nozzle || bed || chamber !== undefined ? {temps: {...(nozzle ? {nozzle} : {}), ...(bed ? {bed} : {}), ...(chamber !== undefined ? {chamber} : {})}} : {}),
    problems,
  };
}

/**
 * mcp-3D-printer-server's `get_printer_status` returns the firmware's own
 * printer endpoint, which has no job progress: only a state is read.
 */
export function genericStatusReport(input: unknown, observedAt: Date): PrintReport {
  let value: unknown = input;
  const at = observedAt.toISOString();
  const base = {source: 'status-fallback' as const, observedAt: at, problems: []};
  if (!record(value)) return {...base, state: 'offline'};
  // Moonraker /printer/info answers {result: {state}} with Klippy's own state, which stays
  // "ready" while it prints: only its error states say anything.
  if (record(value.result) && typeof value.result.state === 'string') {
    const klippy = value.result.state.toLowerCase();
    return {...base, state: klippy === 'shutdown' || klippy === 'error' ? 'busy' : 'idle', stateKnown: false};
  }
  // Duet /machine/status: {state: {status}}.
  if (record(value.state) && typeof value.state.status === 'string') {
    const duet = value.state.status.toLowerCase();
    const state = duet === 'processing' || duet === 'simulating' ? 'printing' : duet === 'paused' || duet === 'pausing' || duet === 'resuming' ? 'paused'
      : duet === 'idle' ? 'idle' : duet === 'off' ? 'offline' : 'busy';
    return {...base, state};
  }
  // PrusaLink {printer: {state}}.
  if (record(value) && record(value.printer) && typeof value.printer.state === 'string') value = {state: value.printer.state};
  if (!record(value)) return {...base, state: 'offline'};
  const state = record(value.state) ? value.state : undefined;
  const flags = state && record(state.flags) ? state.flags : undefined;
  if (flags) { // OctoPrint /api/printer
    if (flags.printing === true) return {...base, state: 'printing'};
    if (flags.paused === true || flags.pausing === true) return {...base, state: 'paused'};
    if (flags.error === true || flags.closedOrError === true) return {...base, state: 'busy'};
    if (flags.ready === true || flags.operational === true) return {...base, state: 'idle'};
    return {...base, state: 'busy'};
  }
  const text = typeof value.state === 'string' ? value.state.toLowerCase() : typeof value.status === 'string' ? value.status.toLowerCase() : undefined;
  if (text === 'ready' || text === 'idle' || text === 'operational' || text === 'standby' || text === 'finished' || text === 'stopped') return {...base, state: 'idle'};
  if (text === 'printing') return {...base, state: 'printing'};
  if (text === 'paused' || text === 'attention') return {...base, state: 'paused'};
  if (text === 'offline' || text === 'disconnected') return {...base, state: 'offline'};
  return {...base, state: 'busy'};
}

function argsFor(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (tool.inputSchema as {properties?: unknown}).properties;
  const allowed = properties && typeof properties === 'object' ? new Set(Object.keys(properties)) : undefined;
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (!allowed || allowed.has(key))));
}

/** The configured route overrides each tool accepts (the MCP's own env supplies the rest). */
export function routeArgs(config: PrinterHandoffConfig, selection: PrinterSelection | undefined = config.selection): Record<string, unknown> {
  return config.backend === 'bambu-printer-mcp' ? {} : {host: selection?.host, type: selection?.printerType, port: selection?.port};
}

/** One printer report through the destination's session: `counterpart_print_progress`, else `get_printer_status`. */
export async function readPrintReport(session: PrinterSession, options: SessionCallOptions & {now?: () => Date} = {}): Promise<PrintReport> {
  const now = options.now ?? (() => new Date());
  await session.connect({...(options.signal ? {signal: options.signal} : {}), ...(options.failFast ? {failFast: true} : {})});
  const config = session.config;
  const call = {...(options.signal ? {signal: options.signal} : {}), ...(options.failFast ? {failFast: true} : {}), timeoutMs: options.timeoutMs ?? 15000};
  if (session.hasTool('counterpart_print_progress')) {
    const result = await session.call('counterpart_print_progress', argsFor(session.getTool('counterpart_print_progress'), routeArgs(config)), call);
    const parsed = counterpartPrintProgressSchema.safeParse(toolResultJson(result));
    if (!parsed.success) throw new PrinterMcpError('invalid-progress');
    const {contract: _contract, ...report} = parsed.data;
    return {...report, source: 'counterpart'};
  }
  if (!session.hasTool('get_printer_status')) throw new PrinterMcpError('progress-unavailable');
  const result = await session.call('get_printer_status', argsFor(session.getTool('get_printer_status'), routeArgs(config)), call);
  const value = toolResultJson(result);
  return config.backend === 'bambu-printer-mcp' ? bambuStatusReport(value, now()) : genericStatusReport(value, now());
}

/** `counterpart_printer_info`, when the install has it; undefined otherwise or when its result is invalid. */
export async function readPrinterInfo(session: PrinterSession, options: SessionCallOptions = {}): Promise<CounterpartPrinterInfo | undefined> {
  if (!session.hasTool('counterpart_printer_info')) return undefined;
  const result = await session.call('counterpart_printer_info', argsFor(session.getTool('counterpart_printer_info'), routeArgs(session.config)), {timeoutMs: 15000, ...options});
  const parsed = counterpartPrinterInfoSchema.safeParse(toolResultJson(result));
  return parsed.success ? parsed.data : undefined;
}

/**
 * How the printer MCP reaches the printer for prints and Stop/Pause/Resume: the MCP's own
 * setting (`counterpart_print_route`, both MCPs). Today `lan` (the local network through FULU), `cloud`
 * (Bambu Cloud) and `developer` (straight to a printer in LAN Only + Developer Mode); `options` carries the
 * MCP's own label, availability and what controls do on each, so a new route needs no Counterpart change.
 */
const routeId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const printRouteSchema = z.object({
  route: routeId,
  mode: z.string(),
  type: z.string(),
  choices: z.array(routeId),
  options: z.array(z.object({
    id: routeId, label: z.string().min(1).max(80), available: z.boolean(),
    reason: z.string().max(300).optional(), controls: z.string().max(400).optional(),
  })).optional(),
  savedTo: z.string().nullable(),
});
export type PrintRoute = z.infer<typeof printRouteSchema>;

/** Read the MCP's print route; undefined when the install has no route tool or answers something else. */
export async function readPrintRoute(session: PrinterSession, options: SessionCallOptions = {}): Promise<PrintRoute | undefined> {
  if (!session.hasTool('counterpart_print_route')) return undefined;
  const parsed = printRouteSchema.safeParse(toolResultJson(await session.call('counterpart_print_route', {}, {timeoutMs: 15000, ...options})));
  return parsed.success ? parsed.data : undefined;
}

/** Change the MCP's print route. The MCP applies it to the next print and control and saves it in its own config. */
export async function setPrintRoute(session: PrinterSession, route: PrintRoute['route'], options: SessionCallOptions = {}): Promise<PrintRoute> {
  if (!session.hasTool('counterpart_print_route')) throw new PrinterMcpError('route-unavailable');
  const parsed = printRouteSchema.safeParse(toolResultJson(await session.call('counterpart_print_route', {route}, {timeoutMs: 15000, ...options})));
  if (!parsed.success) throw new PrinterMcpError('invalid-route');
  return parsed.data;
}

export type CapabilityFeature = 'progress' | 'camera' | 'filaments' | 'pause' | 'resume' | 'quality' | 'strength' | 'multi-colour';
export interface PrinterCapabilities {
  server: {name: string; version: string};
  contract?: 'counterpart/1';
  progress: boolean; layers: boolean;
  camera: 'bambu-tcp' | 'rtsp' | 'http-snapshot' | 'none';
  filaments: 'ams' | 'single' | 'none';
  pause: boolean; resume: boolean; cancel: boolean;
  quality: boolean; strength: boolean; multiColour: boolean;
  copies: boolean;
  /** slice_stl takes pause_at_layers. */
  layerPauses: boolean;
  materialChoice: boolean;
  missing: CapabilityFeature[];
  /** `latestVersion` (PRD §8.10) is added by the companion from `npm view`. */
  update?: {message: string; package: PrinterBackend; command?: string[]; latestVersion?: string};
  detectedAt: string;
}

const PACKAGE_NAMES: Record<PrinterBackend, string> = {'bambu-printer-mcp': 'bambu-printer-mcp', 'mcp-3d-printer-server': 'mcp-3D-printer-server'};
const RTSP_MODELS = /^(x1|x1c|x1e|p2s|h2d|h2s|h2c|h2dpro|x2d)$/i;

function hasArgs(catalog: PrinterToolCatalog, tool: string, names: string[]): boolean {
  const properties = (catalog.tools.find(item => item.name === tool)?.inputSchema as {properties?: Record<string, unknown>} | undefined)?.properties;
  return !!properties && names.every(name => Object.hasOwn(properties, name));
}

/** How to update the installed MCP, as argv, when it's a global npm install; undefined for npx (always fetches) or a checkout. */
export function updateCommand(config: PrinterHandoffConfig): string[] | undefined {
  const name = config.backend;
  const command = config.process.command, args = config.process.args ?? [];
  if (/^npx$/.test(basename(command))) return undefined;
  if (args.some(arg => /(^|\/)npx-cli\.js$/.test(arg))) return undefined;
  const paths = [command, ...args];
  if (paths.some(path => new RegExp(`/lib/node_modules/${name}(/|$)`, 'i').test(path)) || new RegExp(`/bin/${name}$`, 'i').test(command))
    return ['npm', 'install', '-g', `${name}@latest`];
  return undefined;
}

function sentence(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Capabilities from the server's `initialize` reply and tool list, refined by `counterpart_printer_info` (PRD §8.2). */
export function detectCapabilities(config: PrinterHandoffConfig, catalog: PrinterToolCatalog, info?: CounterpartPrinterInfo, at = new Date()): PrinterCapabilities {
  const has = (tool: string) => catalog.tools.some(item => item.name === tool);
  const bambu = config.backend === 'bambu-printer-mcp';
  const model = info?.printer.model ?? config.selection?.model;
  const progressTool = has('counterpart_print_progress');
  const progress = progressTool ? (info?.capabilities.progress ?? true) : bambu && has('get_printer_status');
  const camera = has('camera_snapshot')
    ? info?.capabilities.camera ?? (bambu ? (model && RTSP_MODELS.test(model) ? 'rtsp' : 'bambu-tcp') : 'http-snapshot')
    : 'none';
  const filaments = has('get_printer_filaments') ? info?.capabilities.filaments ?? (bambu ? 'ams' : 'single') : 'none';
  const pause = has('pause_print') && (info?.capabilities.pause ?? true);
  const resume = has('resume_print') && (info?.capabilities.resume ?? true);
  const cancel = has('cancel_print') && (info?.capabilities.cancel ?? true);
  const quality = hasArgs(catalog, 'slice_stl', ['layer_height']);
  const strength = hasArgs(catalog, 'slice_stl', ['wall_loops', 'sparse_infill_density']);
  const multiColour = has('counterpart_make_3mf');
  // Copies only where the slice really makes them: mcp-3D-printer-server forwards repetitions on its Bambu-compatible route only.
  const slicerType = (config.slicer?.type ?? '').toLowerCase();
  const bambuRoute = bambu || config.selection?.printerType === 'bambu' || ['bambustudio', 'orcaslicer-bambulab', 'fulu-orca', 'orca-studio'].includes(slicerType);
  const copies = hasArgs(catalog, 'slice_stl', ['repetitions']) && bambuRoute;
  const layerPauses = hasArgs(catalog, 'slice_stl', ['pause_at_layers']);
  // Missing means this version lacks the tool, not that the printer lacks the hardware.
  const missing: CapabilityFeature[] = [];
  if (!progressTool && !progress) missing.push('progress');
  if (!has('camera_snapshot')) missing.push('camera');
  if (!has('get_printer_filaments')) missing.push('filaments');
  if (!has('pause_print')) missing.push('pause');
  if (!has('resume_print')) missing.push('resume');
  if (!quality) missing.push('quality');
  if (!strength) missing.push('strength');
  if (bambu && !multiColour) missing.push('multi-colour');
  const see = missing.filter(item => ['progress', 'camera', 'filaments'].includes(item)).map(item => item === 'filaments' ? 'the loaded filament' : item);
  const control = missing.filter(item => item === 'pause' || item === 'resume');
  const choose = missing.filter(item => ['quality', 'strength', 'multi-colour'].includes(item)).map(item => item === 'multi-colour' ? 'colours per part' : item);
  const phrases = [
    ...(see.length ? [`see ${sentence(see)}`] : []),
    ...(control.length ? [control.length === 2 ? 'pause and resume prints' : `${control[0]} prints`] : []),
    ...(choose.length ? [`choose ${sentence(choose)}`] : []),
  ];
  const command = updateCommand(config);
  return {
    server: {name: catalog.server.name.slice(0, 128), version: catalog.server.version.slice(0, 64)},
    ...(info ? {contract: 'counterpart/1' as const} : {}),
    progress, layers: progress && (info?.capabilities.layers ?? bambu),
    camera, filaments, pause, resume, cancel, quality, strength, multiColour, copies, layerPauses,
    // Every printer can be told what's loaded: the companion slices it with the profile of a spool the printer
    // reports for it (mcp-3D-printer-server: the profile its filament report gives), or refuses with what to do.
    materialChoice: true,
    missing,
    ...(missing.length ? {update: {message: `Update ${PACKAGE_NAMES[config.backend]} to ${sentence(phrases)}.`, package: config.backend, ...(command ? {command} : {})}} : {}),
    detectedAt: at.toISOString(),
  };
}

/** Destination readiness for the print sheet's printer cards. */
export function readiness(report: Pick<PrintReport, 'state' | 'stateKnown'> | undefined): 'ready' | 'busy' | 'offline' | 'unknown' {
  if (!report || (report.stateKnown === false && report.state === 'idle')) return 'unknown';
  switch (report.state) {
    case 'idle': case 'finished': case 'failed': case 'cancelled': return 'ready';
    case 'offline': return 'offline';
    default: return 'busy';
  }
}
