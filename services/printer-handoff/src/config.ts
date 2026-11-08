import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {z} from 'zod';

export const printerBackendSchema = z.enum(['bambu-printer-mcp', 'mcp-3d-printer-server']);
export type PrinterBackend = z.infer<typeof printerBackendSchema>;

const absolutePath = z.string().refine(isAbsolute);
export const printerMcpProcessSchema = z.strictObject({
  command: absolutePath,
  args: z.array(z.string()).max(256).optional(),
  cwd: absolutePath.optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type PrinterMcpProcess = z.infer<typeof printerMcpProcessSchema>;

export const printerTypeSchema = z.enum(['octoprint', 'klipper', 'duet', 'repetier', 'bambu', 'prusa', 'creality']);

/** Dropped before validation so older printer-handoff.json files and bundles still load: the printer MCP
 * owns its route (counterpart_print_route, Settings -> Printers), and nothing reads a copy here. */
function withoutLegacyRoute(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'connectionMode')) return value;
  const {connectionMode: _connectionMode, ...rest} = value as Record<string, unknown>;
  return rest;
}

export const printerSelectionSchema = z.preprocess(withoutLegacyRoute, z.strictObject({
  model: z.string().trim().min(1).max(128).optional(),
  printerType: printerTypeSchema.optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.string().trim().min(1).max(16).optional(),
  nozzleDiameterMm: z.literal([0.2, 0.4, 0.6, 0.8]).optional(),
  nozzleType: z.enum(['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']).optional(),
  bedType: z.string().trim().min(1).max(64).optional(),
  material: z.string().trim().min(1).max(128).optional(),
  plateIndex: z.number().int().min(0).max(1000).optional(),
  useAms: z.boolean().optional(),
  amsSlots: z.array(z.number().int()).max(64).optional(),
  // Both servers accept a project-level absolute tray array; mcp-3D-printer-server
  // also accepts trays keyed by project filament index (anyOf in its schema).
  amsMapping: z.union([z.array(z.number().int()).max(64), z.record(z.string(), z.number().int())]).optional(),
  autoMatchAms: z.boolean().optional(),
  connectionType: z.enum(['lan','cloud']).optional(),
}));
export type PrinterSelection = z.infer<typeof printerSelectionSchema>;

export const printerSlicerSchema = z.strictObject({
  type: z.string().trim().min(1).max(64).optional(),
  profile: z.string().trim().min(1).max(4096).optional(),
  filamentProfile: z.string().trim().min(1).max(4096).optional(),
  loadFilaments: z.string().trim().min(1).max(4096).optional(),
  /** One `#RRGGBB` per filament in order, `;`-separated — `slice_stl`'s `filament_colours` shape. */
  filamentColours: z.string().regex(/^#[0-9a-fA-F]{6}(;#[0-9a-fA-F]{6}){0,63}$/).optional(),
  templateName: z.string().trim().min(1).max(256).optional(),
  /** The print sheet's quality and strength (PRD §8.5), passed to slice_stl as chosen: the MCP owns the numbers (PRD §8.0). */
  quality: z.enum(['draft', 'standard', 'fine']).optional(),
  strength: z.enum(['standard', 'strong', 'max']).optional(),
  /** A printer config's own explicit process values, passed through unchanged. */
  layerHeightMm: z.number().min(0.04).max(1.2).optional(),
  wallLoops: z.number().int().min(1).max(20).optional(),
  sparseInfillDensity: z.string().regex(/^(100|[1-9]?[0-9])%$/).optional(),
  /** Copies on the plate: slice_stl `repetitions`. */
  repetitions: z.number().int().min(1).max(64).optional(),
  /** The designer's supports choice, sent as slice_stl `enable_support` and `support_type` (false included). */
  enableSupport: z.boolean().optional(),
  supportType: z.enum(['normal(auto)', 'tree(auto)']).optional(),
  /** Pause before these 1-based layers: slice_stl `pause_at_layers`. */
  pauseAtLayers: z.array(z.number().int().min(2).max(100000)).min(1).max(16).optional(),
});
export type PrinterSlicer = z.infer<typeof printerSlicerSchema>;

export const printerPrintOptionsSchema = z.strictObject({
  bedLeveling: z.boolean().optional(),
  flowCalibration: z.boolean().optional(),
  vibrationCalibration: z.boolean().optional(),
  layerInspect: z.boolean().optional(),
  timelapse: z.boolean().optional(),
});
export type PrinterPrintOptions = z.infer<typeof printerPrintOptionsSchema>;

export const printerTimeoutsSchema = z.strictObject({
  connectMs: z.number().int().min(50).max(120000).optional(),
  /** One tool call's bound; for a call that reports progress, the longest time without any. */
  toolMs: z.number().int().min(50).max(1800000).optional(),
  /** A call that reports progress (print_3mf's upload) may run this long in total while it keeps reporting. */
  toolTotalMs: z.number().int().min(50).max(14_400_000).optional(),
  elicitationMs: z.number().int().min(50).max(1800000).optional(),
}).refine(({toolMs, toolTotalMs}) => toolMs === undefined || toolTotalMs === undefined || toolTotalMs >= toolMs,
  {message: 'toolTotalMs must be at least toolMs', path: ['toolTotalMs']});
export type PrinterTimeouts = z.infer<typeof printerTimeoutsSchema>;

export const printerHandoffConfigSchema = z.strictObject({
  backend: printerBackendSchema,
  process: printerMcpProcessSchema,
  selection: printerSelectionSchema.optional(),
  slicer: printerSlicerSchema.optional(),
  print: printerPrintOptionsSchema.optional(),
  /** Whether the Mac app's printer check tests the camera. Never used to check the bed (PRD §5.6). */
  cameraSnapshot: z.boolean().optional(),
  timeouts: printerTimeoutsSchema.optional(),
});
export type PrinterHandoffConfig = z.infer<typeof printerHandoffConfigSchema>;

/**
 * toolTotalMs is sized for the largest file a printer MCP sends at the slowest upload measured, with its pauses:
 * bambu-printer-mcp accepts print files up to 256 MiB (src/safety/archive.ts), and a P1S took 130 KiB/s
 * (src/printers/ftp-upload.ts), so 268,435,456 B / 133,120 B/s = 2,017 s of upload; the print's confirmation may
 * wait elicitationMs, 600 s, in the same call; that leaves 983 s, eight of the 120 s SD-card pauses either MCP
 * allows (FTP_UPLOAD_STALL_MS), before one hour. A printer that stops is still caught by toolMs without progress.
 */
export const DEFAULT_TIMEOUTS = {connectMs: 10000, toolMs: 600000, toolTotalMs: 3_600_000, elicitationMs: 600000} as const;
export function timeoutsFor(config: Pick<PrinterHandoffConfig, 'timeouts'>): Required<PrinterTimeouts> {
  return {...DEFAULT_TIMEOUTS, ...config.timeouts};
}

/** Reads one JSON operator config. Credentials belong in the MCP server's own env config, not in a handoff bundle. */
export async function readPrinterHandoffConfig(path: string): Promise<PrinterHandoffConfig> {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 65536) throw new Error('Printer handoff config exceeds byte limit');
  return printerHandoffConfigSchema.parse(JSON.parse(text));
}
