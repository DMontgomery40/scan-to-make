import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ajv, type ValidateFunction } from 'ajv';

/** Operator configuration only. Never populate these fields from a mobile request. */
export interface TrustedMcpProcess {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export interface DiscoveryOptions {
  timeoutMs?: number;
  maxPages?: number;
  maxTools?: number;
  maxCatalogBytes?: number;
  signal?: AbortSignal;
}
export interface DiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface PrinterToolCatalog {
  readonly server: Readonly<{ name: string; version: string }>;
  readonly tools: readonly DiscoveredTool[];
}
type DiscoveryFailure = 'invalid-configuration' | 'connection-failed' | 'discovery-timeout'
  | 'discovery-cancelled' | 'catalog-limit' | 'duplicate-tool' | 'cursor-cycle'
  | 'missing-print-tool' | 'invalid-print-schema' | 'cleanup-failed'
  | 'invalid-inspection-schema' | 'inspection-failed' | 'inspection-limit' | 'incompatible-print-schema'
  | 'invalid-slice-schema' | 'slice-failed' | 'slice-limit' | 'unsupported-file-tool' | 'credentialed-process';
export class McpDiscoveryError extends Error {
  constructor(readonly code: DiscoveryFailure) {
    // Never expose subprocess arguments, environment, stderr or remote error text.
    super(`MCP discovery failed: ${code}`);
    this.name = 'McpDiscoveryError';
  }
}
function fail(code: DiscoveryFailure): never { throw new McpDiscoveryError(code); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('invalid-configuration');
  return n;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function childAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
class DiscoveryTransport extends StdioClientTransport {
  observedPid: number | null = null;
  private closing?: Promise<void>;
  override async start(): Promise<void> {
    await super.start();
    this.observedPid = this.pid;
  }
  override close(): Promise<void> {
    // Failed initialization calls close without awaiting it inside the SDK.
    // Every caller must await that same shutdown, rather than an empty second close.
    return this.closing ??= super.close();
  }
}
async function closeAndVerify(client: Client, transport: DiscoveryTransport): Promise<void> {
  const pid = transport.observedPid;
  await client.close();
  await transport.close();
  // SDK close sends SIGKILL last but does not await that final exit.
  if (pid !== null) {
    const end = Date.now() + 1000;
    while (childAlive(pid) && Date.now() < end) await delay(20);
    if (childAlive(pid)) fail('cleanup-failed');
  }
}

/**
 * Initialize a trusted MCP process, list its tools and close it. No tools/call
 * capability or live client escapes. This is schema evidence, never observed
 * printer identity, readiness, printable-byte inspection or authorization.
 */
export async function discoverPrinterTools(config: TrustedMcpProcess, options: DiscoveryOptions = {}): Promise<PrinterToolCatalog> {
  return withPrinterTools(config, options, async (_client, catalog) => catalog);
}

// Only this module can access the live client; public operations name their one capability.
async function withPrinterTools<T>(config: TrustedMcpProcess, options: DiscoveryOptions,
  operation: (client: Client, catalog: PrinterToolCatalog, requestOptions: {signal: AbortSignal; timeout: number; maxTotalTimeout: number}) => Promise<T>,
  requirePrintValidator = true): Promise<T> {
  if (options.signal?.aborted) fail('discovery-cancelled');
  const timeoutMs = bounded(options.timeoutMs, 10_000, 50, 120_000);
  const maxPages = bounded(options.maxPages, 32, 1, 128);
  const maxTools = bounded(options.maxTools, 512, 1, 2048);
  const maxCatalogBytes = bounded(options.maxCatalogBytes, 2 * 1024 * 1024, 256, 8 * 1024 * 1024);
  if (!config.command?.trim() || config.command.includes('\0')
      || config.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      || (config.env && Object.entries(config.env).some(([key, val]) => !key || key.includes('=') || key.includes('\0') || typeof val !== 'string' || val.includes('\0')))) fail('invalid-configuration');
  const transport = new DiscoveryTransport({ command: config.command, args: [...(config.args ?? [])],
    cwd: config.cwd, env: { ...config.env }, stderr: 'pipe', maxBufferSize: Math.max(maxCatalogBytes, 64 * 1024) });
  transport.stderr?.on('data', () => {}); // drain without exposing credential-bearing diagnostics
  const client = new Client({ name: 'scan-to-make-discovery', version: '0.1.0' }, { capabilities: {} });
  const controller = new AbortController();
  let abortCode: DiscoveryFailure | undefined;
  const cancel = () => { abortCode = 'discovery-cancelled'; controller.abort(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { abortCode = 'discovery-timeout'; controller.abort(); }, timeoutMs);
  const requestOptions = { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs };
  client.onerror = () => { if (!abortCode) controller.abort(); };
  try {
    await client.connect(transport, requestOptions);
    const server = client.getServerVersion();
    if (!server) fail('connection-failed');
    const tools: DiscoveredTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bytes = 0;
    for (let page = 0; page < maxPages; page++) {
      const response = await client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions);
      bytes += Buffer.byteLength(JSON.stringify(response));
      if (bytes > maxCatalogBytes || tools.length + response.tools.length > maxTools) fail('catalog-limit');
      for (const tool of response.tools) {
        if (names.has(tool.name)) fail('duplicate-tool');
        names.add(tool.name);
        tools.push({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: structuredClone(tool.inputSchema) });
      }
      cursor = response.nextCursor;
      if (cursor === undefined) {
        const catalog = freeze({ server: { name: server.name, version: server.version }, tools });
        if (requirePrintValidator) createPreparedPrintValidator(catalog);
        return await operation(client, catalog, requestOptions);
      }
      if (cursors.has(cursor)) fail('cursor-cycle');
      cursors.add(cursor);
    }
    return fail('catalog-limit');
  } catch (error) {
    if (abortCode) return fail(abortCode);
    if (error instanceof McpDiscoveryError) throw error;
    return fail('connection-failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await closeAndVerify(client, transport);
  }
}

const PREPARED_KEYS = new Set(['three_mf_path', 'bambu_model', 'plate_index', 'nozzle_diameters',
  'bed_type', 'use_ams', 'ams_slots', 'ams_mapping', 'connection_mode']);
export type PreparedArgumentValidation = Readonly<{ ok: true } | { ok: false; reason: 'unsupported-argument' | 'schema-mismatch' }>;

/** Offline shape check only: does not inspect files or authorize dispatch. */
export function createPreparedPrintValidator(catalog: PrinterToolCatalog): (args: unknown) => PreparedArgumentValidation {
  const tools = catalog.tools.filter(tool => tool.name === 'print_3mf');
  if (tools.length !== 1) fail('missing-print-tool');
  let validate: ValidateFunction;
  try {
    const schema = structuredClone(tools[0]!.inputSchema);
    if (schema.type !== 'object') fail('invalid-print-schema');
    validate = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(schema);
  } catch { fail('invalid-print-schema'); }
  return (args: unknown) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)
        || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) return { ok: false, reason: 'schema-mismatch' };
    if (Object.keys(args).some(key => !PREPARED_KEYS.has(key))) return { ok: false, reason: 'unsupported-argument' };
    return validate(args) ? { ok: true } : { ok: false, reason: 'schema-mismatch' };
  };
}

/** File-only operation. The fixed tool name cannot be replaced by callers. */
export async function inspectPreparedFile(config: TrustedMcpProcess,
  input: {file_path: string; bambu_model: string; plate_index: number; nozzle_diameters: number[]; bed_type: string},
  preparedArguments: (receipt: unknown) => Record<string, unknown>, options: DiscoveryOptions = {}) {
  return withPrinterTools(config, options, async (client, catalog, requestOptions) => {
    const tool = catalog.tools.find(tool => tool.name === 'inspect_print_file');
    if (!tool) fail('invalid-inspection-schema');
    // Construct exactly the file-only argument set, ignoring any extra runtime keys.
    const args = {file_path: input.file_path, bambu_model: input.bambu_model, plate_index: input.plate_index,
      nozzle_diameters: [...input.nozzle_diameters], bed_type: input.bed_type};
    try {
      if (tool.inputSchema.type !== 'object' || !new Ajv({strict: false}).compile(structuredClone(tool.inputSchema))(args)) {
        fail('invalid-inspection-schema');
      }
    } catch { fail('invalid-inspection-schema'); }
    const result = await client.callTool({name: 'inspect_print_file', arguments: args}, undefined, requestOptions);
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) fail('inspection-limit');
    if (result.isError || !Array.isArray(result.content) || result.content.length !== 1 ||
        result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') fail('inspection-failed');
    let receipt: unknown;
    try { receipt = JSON.parse(result.content[0].text); } catch { fail('inspection-failed'); }
    // Receipt validation and slot mapping occur before schema compatibility is recorded.
    let candidate: Record<string, unknown>;
    try { candidate = preparedArguments(receipt); } catch { fail('inspection-failed'); }
    if (!createPreparedPrintValidator(catalog)(candidate).ok) fail('incompatible-print-schema');
    return {receipt, catalog};
  });
}

export const PREPARED_FILE_TOOLS = ['slice_stl', 'lay_flat', 'inspect_print_file'] as const;
export type PreparedFileTool = typeof PREPARED_FILE_TOOLS[number];
const FILE_ONLY_TOOLS = new Set<string>(PREPARED_FILE_TOOLS);
// Includes the documented names and the MCP server's credential aliases.
const PRINTER_CREDENTIAL_ENV = new Set(['PRINTER_HOST', 'BAMBU_SERIAL', 'BAMBU_TOKEN',
  'BAMBU_PRINTER_HOST', 'BAMBU_PRINTER_SERIAL', 'BAMBU_PRINTER_ACCESS_TOKEN', 'BAMBU_DEV_ID']);
export function assertCredentialFreeProcess(config: TrustedMcpProcess): void {
  if (Object.keys(config.env ?? {}).some(key => PRINTER_CREDENTIAL_ENV.has(key))) fail('credentialed-process');
}
async function callPreparedFileTool(client: Client, catalog: PrinterToolCatalog,
  name: string, args: Record<string, unknown>,
  requestOptions: {signal: AbortSignal; timeout: number; maxTotalTimeout: number}): Promise<string> {
  if (!FILE_ONLY_TOOLS.has(name)) fail('unsupported-file-tool');
  const tool = catalog.tools.find(tool => tool.name === name);
  if (!tool) fail('invalid-slice-schema');
  try {
    if (tool.inputSchema.type !== 'object' || !new Ajv({strict: false}).compile(structuredClone(tool.inputSchema))(args)) {
      fail('invalid-slice-schema');
    }
  } catch { fail('invalid-slice-schema'); }
  const result = await client.callTool({name, arguments: args}, undefined, requestOptions);
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) fail('slice-limit');
  if (result.isError || !Array.isArray(result.content) || result.content.length !== 1 ||
      result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') fail('slice-failed');
  const path = result.content[0].text;
  if (!path.startsWith('/') || path.length > 4096 || /[\0\r\n]/.test(path)) fail('slice-failed');
  return path;
}
export interface PreparedSliceInput {
  stl_path: string;
  bambu_model: string;
  nozzle_diameter: string;
  bed_type: string;
  nozzle_type: string;
  slicer_type?: string;
}
/**
 * File-only slicing through a separate credential-free bambu-printer-mcp
 * process. The fixed tool name and argument set cannot be replaced by callers.
 */
export async function slicePreparedStl(config: TrustedMcpProcess, input: PreparedSliceInput, options: DiscoveryOptions = {}) {
  assertCredentialFreeProcess(config);
  return withPrinterTools(config, options, async (client, catalog, requestOptions) => {
    const args: Record<string, unknown> = {
      stl_path: input.stl_path,
      bambu_model: input.bambu_model,
      nozzle_diameter: input.nozzle_diameter,
      bed_type: input.bed_type,
      nozzle_type: input.nozzle_type,
      use_printer_filaments: false,
      orient: true,
      arrange: true,
      ensure_on_bed: true,
      ...(input.slicer_type === undefined ? {} : {slicer_type: input.slicer_type}),
    };
    const path = await callPreparedFileTool(client, catalog, 'slice_stl', args, requestOptions);
    return {path, catalog};
  }, false);
}
/** File-only orientation through the same credential-free process pattern. */
export async function layFlatPreparedStl(config: TrustedMcpProcess, stlPath: string, options: DiscoveryOptions = {}) {
  assertCredentialFreeProcess(config);
  return withPrinterTools(config, options, async (client, catalog, requestOptions) => {
    const path = await callPreparedFileTool(client, catalog, 'lay_flat', {stl_path: stlPath}, requestOptions);
    return {path, catalog};
  }, false);
}
