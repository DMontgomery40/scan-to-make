import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {ensureBlenderMcp, resetBlenderScene, BlenderNotReadyError, BlenderBridgeUnavailableError} from '../dist/touchup/blender.js';

const listen = (port = 0) => new Promise(resolve => {
  const server = createServer(socket => socket.end());
  server.listen(port, '127.0.0.1', () => resolve(server));
});
const freePort = async () => { const server = await listen(); const {port} = server.address(); await new Promise(r => server.close(r)); return port; };
const result = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const toolError = text => ({isError: true, content: [{type: 'text', text}]});

function fakeClient({status = result({configured: true, connected: true}), tools = ['blender_mcp_status', 'blender_mcp_call'], call = result({result: 'ok'})} = {}) {
  const calls = [];
  const client = {
    connected: 0, closed: 0,
    connect: async () => { client.connected++; return {tools: tools.map(name => ({name}))}; },
    hasTool: name => tools.includes(name),
    callTool: async (name, args) => { calls.push([name, args]); return name === 'blender_mcp_status' ? status : call; },
    close: async () => { client.closed++; },
  };
  return {client, calls};
}

test('already running', async () => {
  const server = await listen();
  let launched = false;
  try {
    assert.equal(await ensureBlenderMcp({port: server.address().port, launch: async () => { launched = true; }}), 'already-running');
    assert.equal(launched, false);
  } finally { server.close(); }
});

test('launches and waits', async () => {
  const port = await freePort();
  let server;
  const state = await ensureBlenderMcp({port, timeoutMs: 5000, launch: async () => { setTimeout(async () => { server = await listen(port); }, 200); }});
  assert.equal(state, 'launched');
  server.close();
});

test('times out', async () => {
  const port = await freePort();
  await assert.rejects(ensureBlenderMcp({port, timeoutMs: 500, launch: async () => {}}), BlenderNotReadyError);
});

test('reset goes through the bridge', async () => {
  const {client, calls} = fakeClient();
  await resetBlenderScene(client);
  assert.deepEqual(calls.map(([name]) => name), ['blender_mcp_status', 'blender_mcp_call']);
  assert.deepEqual(calls[0][1], {connect: true});
  assert.equal(calls[1][1].tool_name, 'execute_blender_code');
  assert.equal(calls[1][1].arguments.user_prompt, 'Start a fresh, empty scene for a scan touch-up');
  assert.match(calls[1][1].arguments.code, /bpy\.data\.objects\.remove/);
  assert.equal(client.connected, 1);
  assert.equal(client.closed, 1);
});

test('bridge not configured', async () => {
  const notConfigured = fakeClient({status: toolError('No Blender MCP server configured. Set BLENDER_MCP_COMMAND ...')});
  await assert.rejects(resetBlenderScene(notConfigured.client), error =>
    error instanceof BlenderBridgeUnavailableError && error.message === "Blender isn't set up in your printer MCP. Add BLENDER_MCP_COMMAND and BLENDER_MCP_ARGS to its config.");
  assert.deepEqual(notConfigured.calls.map(([name]) => name), ['blender_mcp_status']);
  assert.equal(notConfigured.client.closed, 1);

  const disconnected = fakeClient({status: result({configured: true, connected: false})});
  await assert.rejects(resetBlenderScene(disconnected.client), BlenderBridgeUnavailableError);

  const noTools = fakeClient({tools: ['get_printer_status']});
  await assert.rejects(resetBlenderScene(noTools.client), BlenderBridgeUnavailableError);
  assert.deepEqual(noTools.calls, []);
});

test('a failed scene reset is an error, not a silent pass', async () => {
  const {client} = fakeClient({call: toolError('Blender is in Edit Mode')});
  await assert.rejects(resetBlenderScene(client), /Blender is in Edit Mode/);
  assert.equal(client.closed, 1);
});
