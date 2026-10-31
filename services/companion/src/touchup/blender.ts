import {execFile} from 'node:child_process';
import {connect} from 'node:net';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {toolResultJson, type PrinterMcpClient} from '@scan-to-make/printer-handoff';

/** Port the standard Blender MCP addon listens on. */
export const BLENDER_MCP_PORT = 9876;
export const BLENDER_STARTUP_SCRIPT = fileURLToPath(new URL('../../blender/start_blender_mcp.py', import.meta.url));

export class BlenderNotReadyError extends Error {
  constructor(seconds: number) { super(`Blender didn't open its MCP connection within ${seconds} seconds.`); this.name = 'BlenderNotReadyError'; }
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

/** Opens Blender in the background (not activated, hidden) with the startup script. */
export function defaultBlenderLaunch(blenderApp = '/Applications/Blender.app', script = BLENDER_STARTUP_SCRIPT): () => Promise<void> {
  return async () => { await promisify(execFile)('/usr/bin/open', ['-g', '-j', '-n', '-a', blenderApp, '--args', '--python', script]); };
}

const RESET_CODE = `import bpy
if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.textures, bpy.data.cameras, bpy.data.lights):
    for block in list(collection):
        if block.users == 0:
            collection.remove(block)
`;

type BridgeClient = Pick<PrinterMcpClient, 'connect' | 'callTool' | 'close' | 'hasTool'>;
type ToolResult = Awaited<ReturnType<BridgeClient['callTool']>>;

/** The tool's own words for a failed call (toolResultText refuses error results by design). */
export function toolErrorText(result: ToolResult): string {
  return (result.content ?? []).flatMap(item => item.type === 'text' ? [item.text] : []).join(' ').trim() || 'no details';
}

/** Empties the Blender scene through the user's printer MCP's own Blender bridge. */
export async function resetBlenderScene(client: BridgeClient, signal?: AbortSignal): Promise<void> {
  await client.connect(signal);
  try {
    if (!client.hasTool('blender_mcp_status') || !client.hasTool('blender_mcp_call')) throw new BlenderBridgeUnavailableError();
    const status = await client.callTool('blender_mcp_status', {connect: true}, {signal});
    if (status.isError || toolResultJson<{connected?: boolean}>(status).connected !== true) throw new BlenderBridgeUnavailableError();
    const reset = await client.callTool('blender_mcp_call', {tool_name: 'execute_blender_code',
      arguments: {code: RESET_CODE, user_prompt: 'Start a fresh, empty scene for a scan touch-up'}}, {signal});
    if (reset.isError) throw new Error(`Blender couldn't start a fresh scene: ${toolErrorText(reset)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}
