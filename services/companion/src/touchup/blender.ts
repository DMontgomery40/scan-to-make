import {execFile} from 'node:child_process';
import {connect} from 'node:net';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {toolResultJson, type PrinterMcpClient} from '@scan-to-make/printer-handoff';

/** Port the standard Blender MCP addon listens on. */
export const BLENDER_MCP_PORT = 9876;
export const BLENDER_STARTUP_SCRIPT = fileURLToPath(new URL('../../blender/start_blender_mcp.py', import.meta.url));

export class BlenderNotReadyError extends Error {
  constructor(seconds: number) { super(`Blender didn't start its MCP connection within ${seconds} seconds. Make sure the Blender MCP addon is installed and enabled in Blender.`); this.name = 'BlenderNotReadyError'; }
}
export class BlenderNotInstalledError extends Error {
  constructor() { super("Blender isn't installed. Install it from blender.org."); this.name = 'BlenderNotInstalledError'; }
}
export class BlenderBridgeUnavailableError extends Error {
  constructor() { super("Blender isn't set up in your printer MCP. Add BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS to its config."); this.name = 'BlenderBridgeUnavailableError'; }
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({port, host: '127.0.0.1'});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Makes sure Blender is running with its MCP addon server, launching it if needed. */
export async function ensureBlenderMcp(opts: {port?: number; launch: () => Promise<void>; timeoutMs?: number}): Promise<'already-running' | 'launched'> {
  const port = opts.port ?? BLENDER_MCP_PORT, timeoutMs = opts.timeoutMs ?? 60000;
  if (await listening(port)) return 'already-running';
  await opts.launch();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await listening(port)) return 'launched';
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new BlenderNotReadyError(Math.round(timeoutMs / 1000));
}

/** Opens Blender wherever it's installed, in the background (not activated, hidden), with the startup script. */
export function defaultBlenderLaunch(bundleId = 'org.blenderfoundation.blender', script = BLENDER_STARTUP_SCRIPT): () => Promise<void> {
  return async () => {
    try { await promisify(execFile)('/usr/bin/open', ['-g', '-j', '-n', '-b', bundleId, '--args', '--python', script]); }
    catch { throw new BlenderNotInstalledError(); }
  };
}

const RESET_CODE = `import bpy, time
if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')
scene = bpy.data.scenes.new('Scan to Make ' + time.strftime('%Y-%m-%d %H:%M:%S'))
windows = bpy.context.window_manager.windows
if windows:
    windows[0].scene = scene
`;

type BridgeClient = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;
type ToolResult = Awaited<ReturnType<BridgeClient['callTool']>>;

/** The tool's own words for a failed call (toolResultText refuses error results by design). */
export function toolErrorText(result: ToolResult): string {
  return (result.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join(' ').trim() || 'no details';
}

/** Starts a fresh, empty scene through the user's printer MCP's own Blender bridge. The user's own scenes and objects are never touched. */
export async function resetBlenderScene(client: BridgeClient, signal?: AbortSignal): Promise<void> {
  await client.connect(signal);
  try {
    if (!client.hasTool('blender_mcp_status') || !client.hasTool('blender_mcp_call')) throw new BlenderBridgeUnavailableError();
    const status = await client.callTool('blender_mcp_status', {connect: true}, {signal});
    if (status.isError) {
      const reason = toolErrorText(status);
      if (/No Blender (MCP server|connection) configured/i.test(reason)) throw new BlenderBridgeUnavailableError();
      throw new Error(`Blender isn't reachable through your printer MCP: ${reason}`);
    }
    if (toolResultJson<{connected?: boolean}>(status).connected !== true) throw new BlenderBridgeUnavailableError();
    const reset = await client.callTool('blender_mcp_call', {tool_name: 'execute_blender_code',
      arguments: {code: RESET_CODE, user_prompt: 'Start a fresh, empty scene for a scan touch-up'}}, {signal});
    if (reset.isError) throw new Error(`Blender couldn't start a fresh scene: ${toolErrorText(reset)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}
