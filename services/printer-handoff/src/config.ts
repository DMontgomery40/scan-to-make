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

export const printerSelectionSchema = z.strictObject({
  model: z.string().trim().min(1).max(128).optional(),
  printerType: z.enum(['octoprint', 'klipper', 'duet', 'repetier', 'bambu', 'prusa', 'creality']).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.string().trim().min(1).max(16).optional(),
  nozzleDiameterMm: z.literal([0.2, 0.4, 0.6, 0.8]).optional(),
  nozzleType: z.enum(['stainless_steel', 'hardened_steel', 'tungsten_carbide', 'brass']).optional(),
  bedType: z.string().trim().min(1).max(64).optional(),
  material: z.string().trim().min(1).max(128).optional(),
  plateIndex: z.number().int().min(0).max(1000).optional(),
  useAms: z.boolean().optional(),
  amsSlots: z.array(z.number().int()).max(64).optional(),
  // The two servers use different ams_mapping shapes: an absolute tray array
  // in bambu-printer-mcp and a material-to-slot object in mcp-3D-printer-server.
  amsMapping: z.union([z.array(z.number().int()).max(64), z.record(z.string(), z.number().int())]).optional(),
  autoMatchAms: z.boolean().optional(),
});
export type PrinterSelection = z.infer<typeof printerSelectionSchema>;

export const printerSlicerSchema = z.strictObject({
  type: z.string().trim().min(1).max(64).optional(),
  profile: z.string().trim().min(1).max(4096).optional(),
  filamentProfile: z.string().trim().min(1).max(4096).optional(),
  loadFilaments: z.string().trim().min(1).max(4096).optional(),
  templateName: z.string().trim().min(1).max(256).optional(),
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
  toolMs: z.number().int().min(50).max(1800000).optional(),
  elicitationMs: z.number().int().min(50).max(1800000).optional(),
});
export type PrinterTimeouts = z.infer<typeof printerTimeoutsSchema>;

export const printerHandoffConfigSchema = z.strictObject({
  backend: printerBackendSchema,
  process: printerMcpProcessSchema,
  selection: printerSelectionSchema.optional(),
  slicer: printerSlicerSchema.optional(),
  print: printerPrintOptionsSchema.optional(),
  cameraSnapshot: z.boolean().optional(),
  timeouts: printerTimeoutsSchema.optional(),
});
export type PrinterHandoffConfig = z.infer<typeof printerHandoffConfigSchema>;

export const DEFAULT_TIMEOUTS = {connectMs: 10000, toolMs: 600000, elicitationMs: 600000} as const;
export function timeoutsFor(config: Pick<PrinterHandoffConfig, 'timeouts'>): Required<PrinterTimeouts> {
  return {...DEFAULT_TIMEOUTS, ...config.timeouts};
}

/** Reads one JSON operator config. Credentials belong in the MCP server's own env config, not in a handoff bundle. */
export async function readPrinterHandoffConfig(path: string): Promise<PrinterHandoffConfig> {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 65536) throw new Error('Printer handoff config exceeds byte limit');
  return printerHandoffConfigSchema.parse(JSON.parse(text));
}
