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
if bpy.app.driver_namespace.get("scan_to_make_owned"):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures, bpy.data.cameras, bpy.data.lights):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)
else:
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

/**
 * Starts each pass empty, through the user's printer MCP's own Blender bridge. A Blender the app launched
 * (marked by the startup script) is cleared of earlier passes; a user's own Blender only gets a new scene,
 * so their work is never touched.
 */
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

const STOP_OWNED_CODE = `import bpy
if bpy.app.driver_namespace.get("scan_to_make_owned"):
    def _counterpart_quit():
        if bpy.app.driver_namespace.get("scan_to_make_owned"):
            bpy.ops.wm.quit_blender()
        return None
    bpy.app.timers.register(_counterpart_quit, first_interval=0.2)
    print("COUNTERPART_BLENDER_STOPPING")
else:
    print("COUNTERPART_BLENDER_USER_OWNED")
`;

/** Quit only our Blender, through the same bridge used for the pass, and await its closed listener. */
export async function stopOwnedBlender(client: BridgeClient, opts: {port?: number; timeoutMs?: number} = {}): Promise<void> {
  const port = opts.port ?? BLENDER_MCP_PORT, timeoutMs = opts.timeoutMs ?? 10_000;
  if (!await listening(port)) return;
  // Cleanup must still run after the pass's own signal was cancelled.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(signal);
    if (!client.hasTool('blender_mcp_call')) throw new BlenderBridgeUnavailableError();
    const result = await client.callTool('blender_mcp_call', {tool_name: 'execute_blender_code',
      arguments: {code: STOP_OWNED_CODE, user_prompt: 'Close only the Blender Counterpart started after its last queued pass'}}, {signal, timeoutMs});
    if (result.isError) throw new Error(`Blender could not close: ${toolErrorText(result)}`);
    const words = (result.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join('\n');
    if (words.includes('COUNTERPART_BLENDER_USER_OWNED')) return;
    // Older installed add-ons return {executed:true} without Python stdout. The bridge reports this
    // exact success text; the ownership guard still runs, and only a closed listener proves shutdown.
    const legacySuccess = words.trim() === 'Code executed successfully:';
    if (!words.includes('COUNTERPART_BLENDER_STOPPING') && !legacySuccess) throw new Error('Blender did not acknowledge its shutdown.');
    while (!signal.aborted) {
      if (!await listening(port)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Blender did not close after its pass.');
  } finally {
    await client.close().catch(() => undefined);
  }
}
