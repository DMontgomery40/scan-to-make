import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ElicitRequestSchema, type CallToolResult, type Tool} from '@modelcontextprotocol/sdk/types.js';
import {Ajv, type ValidateFunction} from 'ajv';
import {appOwnedPrinterProcess} from './node-runtime.js';
import {timeoutsFor, type PrinterHandoffConfig} from './config.js';
import type {ElicitationContext, ElicitationRelay} from './elicitation.js';

export class PrinterMcpError extends Error {
  readonly code: string;
  readonly detail?: string;
  constructor(code: string, cause?: unknown, detail?: string) {
    super(`Printer MCP failed: ${code}`);
    this.code = code;
    this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}
function fail(code: string, cause?: unknown, detail?: string): never { throw new PrinterMcpError(code, cause, detail); }

/** The server's user-facing failure, bounded and stripped of configured credentials. */
function failureDetail(result: CallToolResult, config: PrinterHandoffConfig): string | undefined {
  let text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join(' ').slice(0, 4096);
  for (const [key, value] of Object.entries(config.process.env ?? {})) {
    if (/token|secret|password|access.?code|api.?key/i.test(key) && typeof value === 'string' && value.length >= 4)
      text = text.split(value).join('[redacted]');
  }
  text = text.replace(/((?:access[_ -]?(?:token|code)|password|api[_ -]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\x00-\x1f]/g, ' ').trim();
  return text ? text.slice(0, 1000) : undefined;
}

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
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return !alive(pid);
}

export interface PrinterMcpClientOptions {
  relay?: ElicitationRelay;
  /** Receives bounded chunks of the MCP server's stderr, for field diagnosis. */
  onStderr?: (chunk: string) => void;
}

/** One stdio MCP session against the operator-configured printer server. */
export class PrinterMcpClient {
  readonly #config: PrinterHandoffConfig;
  readonly #relay?: ElicitationRelay;
  #client?: Client;
  #transport?: StdioClientTransport;
  #catalog?: PrinterToolCatalog;
  #elicitationContext: ElicitationContext = {};
  #declinedElicitations = 0;
  readonly #validators = new Map<Tool, ValidateFunction>();
  readonly #ajv = new Ajv({strict: false});
  readonly #onStderr?: (chunk: string) => void;
  readonly #outstandingElicitations = new Set<string>();

  constructor(config: PrinterHandoffConfig, options: PrinterMcpClientOptions = {}) {
    this.#config = structuredClone(config);
    this.#relay = options.relay;
    this.#onStderr = options.onStderr;
  }

  get catalog(): PrinterToolCatalog | undefined { return this.#catalog; }
  setElicitationContext(context: ElicitationContext): void { this.#elicitationContext = context; }
  clearElicitationContext(): void { this.#elicitationContext = {}; }

  async connect(signal?: AbortSignal): Promise<PrinterToolCatalog> {
    if (this.#catalog) return this.#catalog;
    if (signal?.aborted) fail('cancelled');
    const timeouts = timeoutsFor(this.#config);
    const processConfig = await appOwnedPrinterProcess(this.#config.process);
    const transport = new StdioClientTransport({
      command: processConfig.command,
      args: [...(processConfig.args ?? [])],
      cwd: processConfig.cwd,
      env: {...processConfig.env},
      stderr: 'pipe',
    });
    this.#transport = transport;
    transport.stderr?.on('data', (chunk: Buffer) => this.#onStderr?.(chunk.toString('utf8', 0, Math.min(chunk.length, 4096))));
    const client = new Client(
      {name: 'scan-to-make-printer-handoff', version: '0.1.0'},
      {capabilities: this.#relay ? {elicitation: {form: {}, url: {}}} : {}},
    );
    this.#client = client;
    if (this.#relay) {
      const relay = this.#relay;
      client.setRequestHandler(ElicitRequestSchema, request => {
        // Registration is synchronous, so the new pending id is visible
        // immediately; track it so close() can cancel this session's prompts.
        const before = new Set(relay.pending().map(item => item.id));
        const answer = relay.request(request, this.#elicitationContext);
        const tracked = relay.pending().map(item => item.id).filter(id => !before.has(id));
        for (const id of tracked) this.#outstandingElicitations.add(id);
        return answer.then(result => {
          if (result.action !== 'accept') this.#declinedElicitations++;
          return result;
        }).finally(() => { for (const id of tracked) this.#outstandingElicitations.delete(id); });
      });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), timeouts.connectMs);
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
      try { compiled = this.#ajv.compile(structuredClone(tool.inputSchema)); }
      catch (error) { fail('invalid-tool-schema', error); }
      this.#validators.set(tool, compiled);
    }
    if (!compiled(args)) fail('invalid-tool-arguments');
  }

  async callTool(name: string, args: Record<string, unknown> = {}, options: {signal?: AbortSignal; timeoutMs?: number; dispatchSensitive?: boolean; beforeDispatch?: () => Promise<void>} = {}): Promise<CallToolResult> {
    if (!this.#client || !this.#catalog) fail('not-connected');
    const tool = this.getTool(name);
    this.#validate(tool, args);
    const timeout = options.timeoutMs ?? timeoutsFor(this.#config).toolMs;
    const declinedBefore = this.#declinedElicitations;
    if (options.signal?.aborted) fail('cancelled');
    await options.beforeDispatch?.();
    if (options.signal?.aborted) fail('cancelled');
    let result: CallToolResult;
    try {
      result = await this.#client.callTool({name, arguments: args}, undefined, {
        signal: options.signal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true,
      }) as CallToolResult;
    } catch (error) {
      fail(options.dispatchSensitive && this.#declinedElicitations === declinedBefore
        ? 'dispatch-uncertain' : options.signal?.aborted ? 'cancelled' : 'tool-failed', error,
        failureDetail({content:[{type:'text',text:error instanceof Error ? error.message : String(error)}]}, this.#config));
    }
    // This exact Bambu rejection is emitted by the idle-state preflight before
    // upload/dispatch. Preserve the actionable refusal instead of inventing uncertainty.
    if (result.isError && this.#config.backend === 'bambu-printer-mcp' && name === 'print_3mf') {
      const detail = failureDetail(result, this.#config);
      if (/^(?:Error: )?Printer state (?:FAILED|RUNNING|PAUSE|PREPARE|SLICING|UNKNOWN) is not safely idle\.$/.test(detail ?? ''))
        fail('printer-not-ready', undefined, detail);
    }
    // Unstructured tool errors can include a lost post-dispatch acknowledgement.
    // A declined confirmation is known not to dispatch; other ambiguous results
    // must be reconciled at the printer before another print is attempted.
    if (options.dispatchSensitive && this.#declinedElicitations === declinedBefore
      && (result.isError || Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)) fail('dispatch-uncertain', undefined, failureDetail(result, this.#config));
    if (result.isError) fail('tool-failed', undefined, failureDetail(result, this.#config));
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) fail('result-limit');
    return structuredClone(result);
  }

  async close(): Promise<void> {
    const client = this.#client, transport = this.#transport, pid = transport?.pid ?? null;
    this.#client = undefined; this.#transport = undefined; this.#catalog = undefined;
    this.#elicitationContext = {};
    // Cancel this session's unanswered prompts so no stale confirmation (or
    // its ref'd expiry timer) outlives the connection on abort/timeout.
    for (const id of [...this.#outstandingElicitations]) {
      try { this.#relay?.respond(id, {action: 'cancel'}); } catch { /* Already answered. */ }
    }
    this.#outstandingElicitations.clear();
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
