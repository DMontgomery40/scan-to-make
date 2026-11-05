import {lstat, mkdir, realpath} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  McpError, ErrorCode, type CallToolResult, type ListResourcesResult, type ServerCapabilities, type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {PrinterMcpError} from './mcp-client.js';
import type {PrinterSession} from './session.js';
import type {ElicitationRelay} from './elicitation.js';
import type {PrinterHandoffConfig} from './config.js';
import {routeArgs} from './counterpart.js';

/**
 * `/v1/mcp` (docs/design/remote-mcp.md): one paired remote device's view of one printer MCP.
 * Tools are classed, arguments are checked, and every tool call runs on the destination's
 * shared session under its mutex, tagged with the device, so its questions never borrow the
 * app's context and never reach the remote client.
 */
export const REMOTE_CLASSES = ['read', 'design', 'control', 'print', 'raw'] as const;
export type RemoteClass = typeof REMOTE_CLASSES[number];
const RANK: Record<RemoteClass, number> = {read: 0, design: 1, control: 2, print: 3, raw: 4};

/**
 * What the printer MCP declares for remote devices, per tool, in `_meta["counterpart/remote"]` (bambu-printer-mcp
 * 1.1.64+, mcp-3d-printer-server 1.2.42+): the least scope that may call it, the arguments that raise that scope,
 * and the arguments that are not plain values. Counterpart keeps no tool or argument names of its own (PRD §8.0):
 * a tool without a declaration (an older MCP) is raw, so only a device trusted with everything sees it.
 */
export const REMOTE_META_KEY = 'counterpart/remote';
export type ArgumentKind = 'config' | 'config-top' | 'path' | 'output';
export interface RemoteDeclaration {scope: RemoteClass; raisedBy: Record<string, RemoteClass>; arguments: Record<string, ArgumentKind>}
const KINDS: readonly ArgumentKind[] = ['config', 'config-top', 'path', 'output'];
const isClass = (value: unknown): value is RemoteClass => typeof value === 'string' && (REMOTE_CLASSES as readonly string[]).includes(value);

type DeclaredTool = Pick<Tool, 'name'> & {_meta?: Tool['_meta']};
export function remoteDeclaration(tool: DeclaredTool): RemoteDeclaration {
  const declared = tool._meta?.[REMOTE_META_KEY] as {scope?: unknown; raisedBy?: unknown; arguments?: unknown} | undefined;
  const entries = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  return {
    scope: isClass(declared?.scope) ? declared.scope : 'raw',
    raisedBy: Object.fromEntries(entries(declared?.raisedBy).filter(([, scope]) => isClass(scope))) as Record<string, RemoteClass>,
    arguments: Object.fromEntries(entries(declared?.arguments).filter(([, kind]) => KINDS.includes(kind as ArgumentKind))) as Record<string, ArgumentKind>,
  };
}

export function toolClass(tool: DeclaredTool): RemoteClass {
  return remoteDeclaration(tool).scope;
}

/** The class of one call: the tool's class, raised by a true argument the MCP declares (`fusion_mcp_status` `launch`). */
export function callClass(tool: DeclaredTool, args: Record<string, unknown>): RemoteClass {
  const {scope, raisedBy} = remoteDeclaration(tool);
  let cls = scope;
  for (const [key, raised] of Object.entries(raisedBy)) if (args[key] === true && RANK[raised] > RANK[cls]) cls = raised;
  return cls;
}

/**
 * Filled from the destination's own config, never the caller (whose values for these arguments are refused):
 * the printer model and nozzle, and the printer target Counterpart's own calls send (`routeArgs`).
 */
export function injectedArguments(tool: Pick<Tool, 'inputSchema'>, config: Pick<PrinterHandoffConfig, 'backend' | 'selection' | 'process'>): Record<string, unknown> {
  const properties = tool.inputSchema.properties ?? {};
  const selection = config.selection;
  const nozzle = selection?.nozzleDiameterMm;
  return {
    ...Object.fromEntries(Object.entries(routeArgs(config as PrinterHandoffConfig)).filter(([key, value]) => value !== undefined && key in properties)),
    ...('bambu_model' in properties && selection?.model ? {bambu_model: selection.model} : {}),
    ...('nozzle_diameter' in properties && nozzle !== undefined ? {nozzle_diameter: String(nozzle)} : {}),
  };
}

export class ArgumentRefused extends Error {
  constructor(readonly argument: string, reason: string) { super(`Argument ${argument} refused: ${reason}`); }
}

/** The destination's configuration chooses this argument: a device may not set it. */
const refused = (kinds: Record<string, ArgumentKind>, key: string, depth: number) =>
  kinds[key] === 'config' || (depth === 0 && kinds[key] === 'config-top');

/**
 * The tool as a remote device sees it: arguments it may not set (refused, or filled from the destination)
 * are left out of the schema and its `required`, so a client that follows the schema is never refused for it.
 */
export function remoteTool(tool: Tool): Tool {
  const copy = structuredClone(tool);
  const schema = copy.inputSchema;
  const kinds = remoteDeclaration(tool).arguments;
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) if (refused(kinds, key, 0)) delete schema.properties[key];
    if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => key in schema.properties!);
  }
  return copy;
}
const pathLike = (value: string) => /[\\/]/.test(value) || value.startsWith('~') || value.includes('..') || value.includes('\0');

export interface ArgumentPolicy {
  /** The companion's bundle store (realpath'd on use). */
  bundleRoot: string;
  /** The device's own write folder, `<bundleRoot>/remote/<deviceId>`. */
  deviceId: string;
}

function inside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

async function confinedPath(argument: string, value: string, roots: string[], own: string, others?: string): Promise<void> {
  if (!value || !isAbsolute(value) || value.includes('\0') || value.startsWith('~')) throw new ArgumentRefused(argument, 'paths must be absolute');
  if (value.split(/[\\/]/).includes('..')) throw new ArgumentRefused(argument, 'paths may not contain ..');
  let parent: string;
  try { parent = await realpath(dirname(value)); }
  catch { throw new ArgumentRefused(argument, 'its folder does not exist'); }
  const full = join(parent, basename(value));
  if (!roots.some(root => inside(full, root)) || (others && inside(full, others) && !inside(full, own)))
    throw new ArgumentRefused(argument, 'outside the folders this device may use');
  const info = await lstat(full).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new ArgumentRefused(argument, 'symbolic links are not followed');
}

/**
 * Checks a tool's (or prompt's) arguments before anything reaches the MCP, by the kinds the MCP declares for it.
 * Writes, and every path a non-read tool uses, stay in the device's own folder; read tools may also read the bundle
 * store. A value that looks like a path is refused in any argument not declared a path.
 */
export async function checkRemoteArguments(kinds: Record<string, ArgumentKind>, cls: RemoteClass, args: unknown, policy: ArgumentPolicy): Promise<void> {
  // The bundle store is created lazily by the phone's first handoff; a remote device may come first.
  await mkdir(policy.bundleRoot, {recursive: true, mode: 0o700});
  const store = await realpath(policy.bundleRoot);
  const deviceDir = join(store, 'remote', policy.deviceId);
  await mkdir(deviceDir, {recursive: true, mode: 0o700});
  const own = await realpath(deviceDir);
  const visit = async (value: unknown, key: string, depth: number, where: string): Promise<void> => {
    if (Array.isArray(value)) { for (const [i, item] of value.entries()) await visit(item, key, depth, `${where}[${i}]`); return; }
    if (value && typeof value === 'object') {
      for (const [child, item] of Object.entries(value)) {
        const at = where ? `${where}.${child}` : child;
        if (refused(kinds, child, depth))
          throw new ArgumentRefused(at, 'the printer configuration on the Mac chooses this');
        await visit(item, child, depth + 1, at);
      }
      return;
    }
    if (typeof value !== 'string') return;
    if (key && (kinds[key] === 'path' || kinds[key] === 'output')) {
      const roots = cls === 'read' && kinds[key] !== 'output' ? [own, store] : [own];
      for (const part of value.split(/[;|]/)) await confinedPath(where, part.trim(), roots, own, join(store, 'remote'));
    } else if (pathLike(value)) throw new ArgumentRefused(where, 'file paths go only in path arguments');
  };
  await visit(args ?? {}, '', 0, '');
}

export interface RemoteCaller {
  deviceId: string;
  deviceName: string;
  /** The classes this device's scopes allow. */
  classes: ReadonlySet<RemoteClass>;
  /** Fails if the device was revoked or lost a scope since the request began. */
  reauthorize(cls: RemoteClass): Promise<void>;
}

export interface RemoteMcpOptions {
  bundleRoot: string;
  /** The destination's relay: this device's questions are cancelled after `questionMs`. */
  relay?: ElicitationRelay;
  /**
   * How long a remote question waits for the owner before it is answered `cancel` (default 0: at once).
   * No phone or Mac screen shows questions without a project yet, so waiting would only hold the
   * session's mutex, and the owner's Pause and Stop wait on it (docs/design/remote-mcp.md).
   */
  questionMs?: number;
  /** A remote tool call's limit (default 120 s); a call that overruns ends its connection, as any abandoned call does. */
  toolTimeoutMs?: number;
  /** PRD §8.10: admits printer work; throws while the MCP updates. Held for every call above read. */
  admit?: () => () => void;
  /** How long a remote call waits for the session's mutex (default 30 s). */
  lockTimeoutMs?: number;
}

const MAX_RESOURCE_PAGES = 10;
/**
 * A JSON-RPC error for the remote client. The SDK server sends `code` and `message` as they are; an
 * McpError's message already carries "MCP error <code>:", which the client would prefix again.
 */
function rpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), {code, ...(data === undefined ? {} : {data})});
}
const failure = (text: string): CallToolResult => ({isError: true, content: [{type: 'text', text}]});

/** An SDK server for one request: the caller's view of one destination's MCP. */
export async function createRemoteMcpServer(session: PrinterSession, caller: RemoteCaller, options: RemoteMcpOptions): Promise<Server> {
  const catalog = await session.connect({failFast: true});
  const upstream: ServerCapabilities = catalog.capabilities ?? {};
  const visible = () => (session.catalog ?? catalog).tools.filter(tool => caller.classes.has(toolClass(tool)));
  const capabilities: ServerCapabilities = {tools: {},
    ...(upstream.prompts ? {prompts: {}} : {}), ...(upstream.resources ? {resources: {}} : {})};
  const server = new Server({name: `counterpart-remote-${catalog.server.name}`, version: catalog.server.version}, {capabilities});
  const policy = {bundleRoot: options.bundleRoot, deviceId: caller.deviceId};
  const context = {remoteDeviceId: caller.deviceId, remoteDeviceName: caller.deviceName};
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  /** Answers this device's questions `cancel` after `questionMs`, so none holds the mutex waiting for a screen that isn't there. */
  const watchQuestions = () => {
    const relay = options.relay;
    if (!relay) return () => undefined;
    const timers = new Set<NodeJS.Timeout>();
    const unsubscribe = relay.subscribe(pending => {
      if (pending.remoteDeviceId !== caller.deviceId) return;
      const timer = setTimeout(() => { timers.delete(timer); relay.respond(pending.id, {action: 'cancel'}); }, options.questionMs ?? 0);
      timers.add(timer);
    });
    return () => { unsubscribe(); for (const timer of timers) clearTimeout(timer); };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await caller.reauthorize('read').catch(() => { throw rpcError(ErrorCode.InvalidRequest, 'This device is no longer allowed to do that.'); });
    return {tools: visible().map(remoteTool)};
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const {name, arguments: args = {}} = request.params;
    const tool = visible().find(candidate => candidate.name === name);
    const cls = tool ? callClass(tool, args) : undefined;
    if (!tool || !cls || !caller.classes.has(cls)) return failure(`Tool ${name} is not available to this device.`);
    const kinds = remoteDeclaration(tool).arguments;
    try { await checkRemoteArguments(kinds, cls, args, policy); }
    catch (error) { if (error instanceof ArgumentRefused) return failure(error.message); throw error; }
    let release: (() => void) | undefined;
    const stopQuestions = watchQuestions();
    try {
      // Like the app's own design passes and prints (PRD §8.10): no MCP update swaps files under this call.
      if (cls !== 'read') release = options.admit?.();
      // No signal: a dispatched call runs to its own timeout even if the remote client goes away,
      // so a closed socket never quarantines the session the app shares.
      return await session.call(name, {...args, ...injectedArguments(tool, session.config)}, {
        exclusive: true, forwardResult: true, lockTimeoutMs, timeoutMs: options.toolTimeoutMs ?? 120_000, elicitationContext: context,
        // After the mutex and right before dispatch: the device, and its paths (nothing may have moved since).
        beforeDispatch: async () => { await caller.reauthorize(cls); await checkRemoteArguments(kinds, cls, args, policy); },
      }) as CallToolResult;
    } catch (error) {
      if (error instanceof ArgumentRefused) return failure(error.message);
      if (error instanceof PrinterMcpError) return failure(error.code === 'printer-busy'
        ? 'The printer is busy with another request. Try again shortly.' : error.detail ?? error.message);
      if (error instanceof Error && error.name === 'PrinterUpdatingError') return failure(error.message);
      if (error && typeof error === 'object' && 'status' in error) return failure('This device is no longer allowed to do that.');
      throw error;
    } finally { stopQuestions(); release?.(); }
  });

  const passthrough = async <T>(work: () => Promise<T>): Promise<T> => {
    const stopQuestions = watchQuestions();
    try { return await work(); }
    catch (error) {
      if (error instanceof PrinterMcpError) {
        // The server's own JSON-RPC error (an unknown prompt, a failed read) passes through as it is.
        if (error.cause instanceof McpError) {
          const cause = error.cause;
          throw rpcError(cause.code, cause.message.replace(/^(?:MCP error -?\d+: )+/, ''), cause.data);
        }
        throw rpcError(ErrorCode.InternalError, error.detail ?? error.message);
      }
      if (error && typeof error === 'object' && 'status' in error) throw rpcError(ErrorCode.InvalidRequest, 'This device is no longer allowed to do that.');
      throw error;
    } finally { stopQuestions(); }
  };
  // Prompts and resources run under the mutex with this device's tag too: a question asked meanwhile is its own.
  const upstreamRequest = (request: Parameters<PrinterSession['passthrough']>[0], check?: () => Promise<void>) =>
    session.passthrough(request, {elicitationContext: context, lockTimeoutMs, timeoutMs: options.toolTimeoutMs ?? 120_000,
      // Checked after the mutex, right before the request, as for tools.
      beforeDispatch: async () => { await caller.reauthorize('read'); await check?.(); }});
  const checkPromptArgs = async (args: Record<string, string> | undefined) => {
    try { await checkRemoteArguments({}, 'read', args ?? {}, policy); }
    catch (error) { if (error instanceof ArgumentRefused) throw rpcError(ErrorCode.InvalidParams, error.message); throw error; }
  };
  if (upstream.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, request => passthrough(() =>
      upstreamRequest({method: 'prompts/list', ...(request.params?.cursor ? {cursor: request.params.cursor} : {})})) as never);
    server.setRequestHandler(GetPromptRequestSchema, async request => {
      await checkPromptArgs(request.params.arguments);
      return passthrough(() => upstreamRequest({method: 'prompts/get', name: request.params.name,
        ...(request.params.arguments ? {arguments: request.params.arguments} : {})}, () => checkPromptArgs(request.params.arguments))) as never;
    });
  }
  if (upstream.resources) {
    const listed = async (): Promise<Set<string>> => {
      const uris = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_RESOURCE_PAGES; page++) {
        const result = await upstreamRequest({method: 'resources/list', ...(cursor ? {cursor} : {})}) as ListResourcesResult;
        for (const resource of result.resources ?? []) uris.add(resource.uri);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return uris;
    };
    server.setRequestHandler(ListResourcesRequestSchema, request => passthrough(async () => {
      const result = await upstreamRequest({method: 'resources/list', ...(request.params?.cursor ? {cursor: request.params.cursor} : {})}) as ListResourcesResult & {templates?: unknown};
      // Some servers put templates beside resources; templates let a caller choose the host, so they stay behind.
      const {templates: _templates, ...rest} = result;
      return rest;
    }) as never);
    // Templates (`printer://{host}/…`) would let a caller choose the host: none are passed through.
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      await caller.reauthorize('read').catch(() => { throw rpcError(ErrorCode.InvalidRequest, 'This device is no longer allowed to do that.'); });
      return {resourceTemplates: []};
    });
    server.setRequestHandler(ReadResourceRequestSchema, request => passthrough(async () => {
      if (!(await listed()).has(request.params.uri)) throw rpcError(ErrorCode.InvalidParams, 'Only listed resources can be read.');
      return upstreamRequest({method: 'resources/read', uri: request.params.uri});
    }) as never);
  }
  return server;
}

/** Answers one stateless Streamable HTTP request (JSON responses, no server-initiated stream), then closes the server. */
export async function serveRemoteMcpRequest(server: Server, request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
