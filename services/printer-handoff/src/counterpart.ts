import {basename} from 'node:path';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {PrinterBackend, PrinterHandoffConfig, PrinterSelection} from './config.js';
import {PrinterMcpError, toolResultJson, type PrinterToolCatalog} from './mcp-client.js';
import type {PrinterSession, SessionCallOptions} from './session.js';

/**
 * The consumer side of the `counterpart/1` tool contract (PRD §8.4) that both
 * printer MCPs add. The contract is required (PRD §8.0): an install without it
 * says "Update <MCP>". Results are validated here; unknown extra fields from a
 * newer MCP are dropped.
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
    /** What slice_stl can apply with the MCP's slicer for this printer (PRD §8.0): the app never knows slicers. */
    slicing: z.object({supports: z.boolean(), copies: z.boolean(), orient: z.boolean()}).optional(),
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

/** A printer report: `counterpart_print_progress` without its contract tag. */
export type PrintReport = Omit<CounterpartPrintProgress, 'contract'> & {source: 'counterpart'};

function argsFor(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  const properties = (tool.inputSchema as {properties?: unknown}).properties;
  const allowed = properties && typeof properties === 'object' ? new Set(Object.keys(properties)) : undefined;
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => value !== undefined && (!allowed || allowed.has(key))));
}

/** The configured route overrides each tool accepts (the MCP's own env supplies the rest). */
export function routeArgs(config: PrinterHandoffConfig, selection: PrinterSelection | undefined = config.selection): Record<string, unknown> {
  return config.backend === 'bambu-printer-mcp' ? {} : {host: selection?.host, type: selection?.printerType, port: selection?.port};
}

/** One printer report through the destination's session (`counterpart_print_progress`); an MCP without it must be updated. */
export async function readPrintReport(session: PrinterSession, options: SessionCallOptions = {}): Promise<PrintReport> {
  await session.connect({...(options.signal ? {signal: options.signal} : {}), ...(options.failFast ? {failFast: true} : {})});
  const call = {...(options.signal ? {signal: options.signal} : {}), ...(options.failFast ? {failFast: true} : {}), timeoutMs: options.timeoutMs ?? 15000};
  if (!session.hasTool('counterpart_print_progress')) throw new PrinterMcpError('progress-unavailable', undefined, `Update ${packageLabel(session.backend)} in Settings → Printers to see its prints.`);
  const result = await session.call('counterpart_print_progress', argsFor(session.getTool('counterpart_print_progress'), routeArgs(session.config)), call);
  const parsed = counterpartPrintProgressSchema.safeParse(toolResultJson(result));
  if (!parsed.success) throw new PrinterMcpError('invalid-progress');
  const {contract: _contract, ...report} = parsed.data;
  return {...report, source: 'counterpart'};
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
/** The MCP's package name as people see it on npm, for "Update <MCP> in Settings → Printers". */
export function packageLabel(backend: PrinterBackend): string { return PACKAGE_NAMES[backend]; }

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

/**
 * Capabilities from the server's `initialize` reply and tool list, and its `counterpart_printer_info` (PRD §8.2).
 * What the printer can do comes only from `counterpart_printer_info`: without it (an MCP older than the contract,
 * or before its first answer) nothing lights up and Printers says to update the MCP.
 */
export function detectCapabilities(config: PrinterHandoffConfig, catalog: PrinterToolCatalog, info?: CounterpartPrinterInfo, at = new Date()): PrinterCapabilities {
  const has = (tool: string) => catalog.tools.some(item => item.name === tool);
  const contract = has('counterpart_printer_info');
  const progress = has('counterpart_print_progress') && info?.capabilities.progress === true;
  const camera = has('camera_snapshot') ? info?.capabilities.camera ?? 'none' : 'none';
  const filaments = has('get_printer_filaments') ? info?.capabilities.filaments ?? 'none' : 'none';
  const pause = has('pause_print') && info?.capabilities.pause === true;
  const resume = has('resume_print') && info?.capabilities.resume === true;
  const cancel = has('cancel_print') && info?.capabilities.cancel === true;
  // The MCP turns quality and strength into its slicer's numbers (PRD §8.0); older versions say Update.
  const quality = hasArgs(catalog, 'slice_stl', ['quality']);
  const strength = hasArgs(catalog, 'slice_stl', ['strength']);
  const multiColour = has('counterpart_make_3mf');
  // Copies only where the MCP says its slice makes them (capabilities.slicing, PRD §8.0); older versions say Update.
  const copies = hasArgs(catalog, 'slice_stl', ['repetitions']) && info?.capabilities.slicing?.copies === true;
  const layerPauses = hasArgs(catalog, 'slice_stl', ['pause_at_layers']);
  // Missing means this version lacks the tool, not that the printer lacks the hardware.
  const missing: CapabilityFeature[] = [];
  if (!contract || !has('counterpart_print_progress')) missing.push('progress');
  if (!has('camera_snapshot')) missing.push('camera');
  if (!has('get_printer_filaments')) missing.push('filaments');
  if (!has('pause_print')) missing.push('pause');
  if (!has('resume_print')) missing.push('resume');
  if (!quality) missing.push('quality');
  if (!strength) missing.push('strength');
  // Colours per part are missing only where the MCP says the printer has an AMS to print them with.
  if (info?.capabilities.filaments === 'ams' && !multiColour) missing.push('multi-colour');
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
    progress, layers: progress && info?.capabilities.layers === true,
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
export function readiness(report: Pick<PrintReport, 'state'> | undefined): 'ready' | 'busy' | 'offline' | 'unknown' {
  if (!report) return 'unknown';
  switch (report.state) {
    case 'idle': case 'finished': case 'failed': case 'cancelled': return 'ready';
    case 'offline': return 'offline';
    default: return 'busy';
  }
}
