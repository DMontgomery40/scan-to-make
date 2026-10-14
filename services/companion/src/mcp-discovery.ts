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
  | 'missing-print-tool' | 'invalid-print-schema' | 'cleanup-failed';
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
        createPreparedPrintValidator(catalog);
        return catalog;
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
  'bed_type', 'use_ams', 'ams_slots', 'connection_mode']);
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
