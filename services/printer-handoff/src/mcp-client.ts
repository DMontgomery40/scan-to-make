import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema, type CallToolResult, type Tool} from '@modelcontextprotocol/sdk/types.js';
import {Ajv, type ValidateFunction} from 'ajv';
import {timeoutsFor, type PrinterHandoffConfig} from './config.js';
import type {ElicitationContext, ElicitationRelay} from './elicitation.js';

export class PrinterMcpError extends Error {
  readonly code: string;
  constructor(code: string, cause?: unknown) {
    super(`Printer MCP failed: ${code}`);
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
function fail(code: string, cause?: unknown): never { throw new PrinterMcpError(code, cause); }

export interface PrinterToolCatalog {
  server: {name: string; version: string};
  tools: Tool[];
}

const MAX_PAGES = 20;
const MAX_TOOLS = 256;
const MAX_RESULT_BYTES = 1024 * 1024;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10).unref());
  return !alive(pid);
}

export interface PrinterMcpClientOptions {
  relay?: ElicitationRelay;
}

/** One stdio MCP session against the operator-configured printer server. */
export class PrinterMcpClient {
  readonly #config: PrinterHandoffConfig;
  readonly #relay?: ElicitationRelay;
  #client?: Client;
  #transport?: StdioClientTransport;
  #catalog?: PrinterToolCatalog;
  #elicitationContext: ElicitationContext = {};
  readonly #validators = new Map<Tool, ValidateFunction>();

  constructor(config: PrinterHandoffConfig, options: PrinterMcpClientOptions = {}) {
    this.#config = structuredClone(config);
    this.#relay = options.relay;
  }

  get catalog(): PrinterToolCatalog | undefined { return this.#catalog; }
  setElicitationContext(context: ElicitationContext): void { this.#elicitationContext = context; }
  clearElicitationContext(): void { this.#elicitationContext = {}; }

  async connect(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    if (this.#catalog) return this.#catalog;
    if (signal?.aborted) fail('cancelled');
    const timeouts = timeoutsFor(this.#config);
    const processConfig = this.#config.process;
    const transport = new StdioClientTransport({
      command: processConfig.command,
      args: [...(processConfig.args ?? [])],
      cwd: processConfig.cwd,
      env: {...processConfig.env},
      stderr: 'pipe',
    });
    this.#transport = transport;
    transport.stderr?.on('data', () => undefined);
    const client = new Client(
      {name: 'scan-to-make-printer-handoff', version: '0.1.0'},
      {capabilities: this.#relay ? {elicitation: {form: {}, url: {}}} : {}},
    );
    this.#client = client;
    if (this.#relay) {
      const relay = this.#relay;
      client.setRequestHandler(ElicitRequestSchema, request => relay.request(request, this.#elicitationContext));
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), timeouts.connectMs).unref();
    try {
      await client.connect(transport, {signal: controller.signal, timeout: timeouts.connectMs, maxTotalTimeout: timeouts.connectMs});
      const server = client.getServerVersion();
      if (!server?.name || !server?.version) fail('invalid-server');
      const tools: Tool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.listTools(cursor ? {cursor} : {}, {
          signal: controller.signal, timeout: timeouts.connectMs, maxTotalTimeout: timeouts.connectMs,
        });
        for (const tool of structuredClone(result.tools)) {
          if (seen.has(tool.name)) fail('duplicate-tool');
          seen.add(tool.name);
          tools.push(tool);
          if (tools.length > MAX_TOOLS) fail('catalog-limit');
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === MAX_PAGES - 1) fail('catalog-limit');
      }
      this.#catalog = freeze({server: {name: server.name, version: server.version}, tools});
      return this.#catalog;
    } catch (error) {
      await this.close().catch(() => undefined);
      if (error instanceof PrinterMcpError) throw error;
      return fail(signal?.aborted ? 'cancelled' : 'connection-failed', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  getTool(name: string): Tool {
    const tool = this.#catalog?.tools.find(candidate => candidate.name === name);
    if (!tool) fail('missing-tool');
    return tool;
  }
  hasTool(name: string): boolean { return this.#catalog?.tools.some(tool => tool.name === name) ?? false; }

  #validate(tool: Tool, args: Record<string, unknown>): void {
    let compiled = this.#validators.get(tool);
    if (!compiled) {
      try { compiled = new Ajv({strict: false}).compile(structuredClone(tool.inputSchema)); }
      catch (error) { fail('invalid-tool-schema', error); }
      this.#validators.set(tool, compiled);
    }
    if (!compiled(args)) fail('invalid-tool-arguments');
  }

  async callTool(name: string, args: Record<string, unknown> = {}, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<CallToolResult> {
    if (!this.#client || !this.#catalog) fail('not-connected');
    const tool = this.getTool(name);
    this.#validate(tool, args);
    const timeout = options.timeoutMs ?? timeoutsFor(this.#config).toolMs;
    let result: CallToolResult;
    try {
      result = await this.#client.callTool({name, arguments: args}, undefined, {
        signal: options.signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true,
      }) as CallToolResult;
    } catch (error) {
      fail(options.signal?.aborted ? 'cancelled' : 'tool-failed', error);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) fail('result-limit');
    return structuredClone(result);
  }

  async close(): Promise<void> {
    const client = this.#client, transport = this.#transport, pid = transport?.pid ?? null;
    this.#client = undefined; this.#transport = undefined; this.#catalog = undefined;
    this.#elicitationContext = {};
    try { await client?.close(); } catch { /* Transport close below still runs. */ }
    try { await transport?.close(); } catch { /* Process check below still runs. */ }
    if (pid !== null && alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* Already gone. */ }
      if (!await waitForExit(pid, 1000)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ }
        await waitForExit(pid, 1000);
      }
    }
  }
}

export function toolResultText(result: CallToolResult): string {
  if (result.isError) fail('tool-failed');
  const texts = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text);
  if (texts.length !== 1 || !texts[0]) fail('invalid-tool-result');
  return texts[0];
}
export function toolResultJson<T = Record<string, unknown>>(result: CallToolResult): T {
  if (result.isError) fail('tool-failed');
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as T;
  try { return JSON.parse(toolResultText(result)) as T; }
  catch (error) { return fail('invalid-tool-result', error); }
}
