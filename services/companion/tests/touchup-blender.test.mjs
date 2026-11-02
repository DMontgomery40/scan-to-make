import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {PrinterMcpError} from '../../printer-handoff/dist/mcp-client.js';
import {ensureBlenderMcp, resetBlenderScene, defaultBlenderLaunch, BlenderNotReadyError, BlenderBridgeUnavailableError, BlenderNotInstalledError} from '../dist/touchup/blender.js';

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
    callTool: async (name, args) => { calls.push([name, args]); return name === 'blender_mcp_status' ? status : typeof call === 'function' ? call(args) : call; },
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

test('a bridge that is set up but failing shows the MCP\'s own reason', async () => {
  const {client} = fakeClient({status: toolError('Blender MCP timed out during connect. Check the configured server command and Blender addon connection.')});
  await assert.rejects(resetBlenderScene(client), error => !(error instanceof BlenderBridgeUnavailableError) && /timed out during connect/.test(error.message));
});

test('the real client error detail survives a refused scene reset', async () => {
  const {client} = fakeClient({call: () => { throw new PrinterMcpError('tool-failed', undefined, "Counterpart won't change your open Blender session."); }});
  await assert.rejects(resetBlenderScene(client), /your open Blender session/);
  assert.equal(client.closed, 1);
});

test('the timeout names the Blender MCP addon', async () => {
  const port = await freePort();
  await assert.rejects(ensureBlenderMcp({port, timeoutMs: 300, launch: async () => {}}), /Blender MCP addon/);
});

test('Blender not installed says how to fix it', async () => {
  await assert.rejects(defaultBlenderLaunch('org.example.not-installed-blender')(), error =>
    error instanceof BlenderNotInstalledError && /blender\.org/.test(error.message));
});

test('reset preserves a user session, including its current mode and scene', async () => {
  const {client, calls} = fakeClient();
  await resetBlenderScene(client);
  const code = calls[1][1].arguments.code;
  const observed = JSON.parse(execFileSync('python3', ['-c', `
import sys, types, json
changes=[]
bpy=types.SimpleNamespace(app=types.SimpleNamespace(driver_namespace={}),
 context=types.SimpleNamespace(object=types.SimpleNamespace(mode='EDIT'), window_manager=types.SimpleNamespace(windows=[])),
 ops=types.SimpleNamespace(object=types.SimpleNamespace(mode_set=lambda **kw: changes.append('mode'))),
 data=types.SimpleNamespace(scenes=types.SimpleNamespace(new=lambda name: changes.append('scene'))))
sys.modules['bpy']=bpy
error=None
try: exec(${JSON.stringify(code)})
except Exception as e: error=str(e)
print(json.dumps({'changes':changes,'error':error}))
`], {encoding: 'utf8'}));
  assert.deepEqual(observed.changes, []);
  assert.match(observed.error, /your open Blender session/);
});

test('an outdated addon stops before any scene reset', async () => {
  const {client, calls} = fakeClient({status: result({connected: true, tools: [{name: 'get_addon_status'}]}),
    call: args => args.tool_name === 'get_addon_status' ? result({up_to_date: false, expected_protocol_version: 15}) : result({result: 'reset'})});
  await assert.rejects(resetBlenderScene(client), /addon needs an update/);
  assert.deepEqual(calls.filter(([, a]) => a.tool_name).map(([, a]) => a.tool_name), ['get_addon_status']);
  assert.equal(client.closed, 1);
});

test('a compatible addon is checked before the scene reset', async () => {
  const {client, calls} = fakeClient({status: result({connected: true, tools: [{name: 'get_addon_status'}]}),
    call: args => args.tool_name === 'get_addon_status' ? result({up_to_date: true, protocol_version: 15}) : result({result: 'reset'})});
  await resetBlenderScene(client);
  assert.deepEqual(calls.filter(([, a]) => a.tool_name).map(([, a]) => a.tool_name), ['get_addon_status', 'execute_blender_code']);
});

test('startup preserves the right listener and rebinds only an owned listener on the wrong port', async () => {
  const {BLENDER_STARTUP_SCRIPT} = await import('../dist/touchup/blender.js');
  const script = await readFile(BLENDER_STARTUP_SCRIPT, 'utf8');
  for (const port of [9876, 9877]) {
    const observed = JSON.parse(execFileSync('python3', ['-c', `
import sys,types,json
calls=[];callbacks=[]
server=types.SimpleNamespace(running=True,port=${port})
def stop():
 calls.append('stop');server.running=False
server.stop=stop
addon_utils=types.SimpleNamespace(modules=lambda:[types.SimpleNamespace(__name__='addon',bl_info={'name':'MCP for Blender'})],
 check=lambda name:(True,True),enable=lambda *a,**kw:calls.append('reenable'))
bpy=types.SimpleNamespace(app=types.SimpleNamespace(driver_namespace={},timers=types.SimpleNamespace(register=lambda f,**kw:callbacks.append(f))),
 types=types.SimpleNamespace(blendermcp_server=server),
 context=types.SimpleNamespace(scene=types.SimpleNamespace(blendermcp_port=9876)),
 ops=types.SimpleNamespace(blendermcp=types.SimpleNamespace(start_server=lambda:calls.append('restart'))))
sys.modules['addon_utils']=addon_utils;sys.modules['bpy']=bpy
exec(${JSON.stringify(script)})
for callback in callbacks:callback()
print(json.dumps({'calls':calls,'port':server.port}))
`], {encoding: 'utf8'}).trim().split('\n').at(-1));
    assert.deepEqual(observed.calls, port === 9876 ? [] : ['stop', 'restart']);
    assert.equal(observed.port, 9876);
  }
});

test('the startup script marks the Blender it launches as app-owned', async () => {
  const {readFile} = await import('node:fs/promises');
  const {BLENDER_STARTUP_SCRIPT} = await import('../dist/touchup/blender.js');
  assert.match(await readFile(BLENDER_STARTUP_SCRIPT, 'utf8'), /driver_namespace\["scan_to_make_owned"\] = True/);
});

for (const owned of [false, true]) for (const legacy of [false, true]) {
  test(`idle cleanup ${owned ? 'closes Counterpart’s Blender' : 'leaves the user’s Blender open'}${legacy ? ' with a legacy addon that drops stdout' : ''}`, async t => {
    const {stopOwnedBlender} = await import('../dist/touchup/blender.js');
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const server = await listen();
    t.after(() => server.close());
    const {client, calls} = fakeClient();
    client.callTool = async (name, args) => {
      calls.push([name, args]);
      // Execute the actual Python sent to Blender against its small ownership/timer surface.
      const python = `import sys, types, json
callbacks, quit_calls = [], []
bpy = types.ModuleType('bpy')
bpy.app = types.SimpleNamespace(driver_namespace={'scan_to_make_owned': ${owned ? 'True' : 'False'}}, timers=types.SimpleNamespace(register=lambda callback, **kwargs: callbacks.append(callback)))
bpy.ops = types.SimpleNamespace(wm=types.SimpleNamespace(quit_blender=lambda: quit_calls.append('quit')))
sys.modules['bpy'] = bpy
exec(sys.argv[1])
for callback in callbacks: callback()
print(json.dumps({'quit': quit_calls}))`;
      const {stdout} = await promisify(execFile)('python3', ['-c', python, args.arguments.code]);
      assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)).quit, owned ? ['quit'] : []);
      if (owned) setTimeout(() => server.close(), 20);
      return {content: [{type: 'text', text: legacy ? 'Code executed successfully: ' : stdout}]};
    };
    // Positive cases include starting Python; shared CI measured 640–799 ms before its reply.
    // Keep the negative deadline assertion short without making process startup its subject.
    const stopping = stopOwnedBlender(client, {port: server.address().port, timeoutMs: owned ? 2000 : 250});
    if (legacy && !owned) await assert.rejects(stopping, /did not close/);
    else await stopping;
    assert.equal(server.listening, !owned);
    assert.equal(client.closed, 1);
    assert.equal(calls.length, 1);
  });
}

test('shutdown does not claim success while the owned Blender listener remains open', async t => {
  const {stopOwnedBlender} = await import('../dist/touchup/blender.js');
  const server = await listen();
  t.after(() => server.close());
  const {client} = fakeClient({call: result('COUNTERPART_BLENDER_STOPPING')});
  await assert.rejects(stopOwnedBlender(client, {port: server.address().port, timeoutMs: 100}), /did not close/);
  assert.equal(client.closed, 1);
});

test('shutdown closes the bridge even when connecting failed', async t => {
  const {stopOwnedBlender} = await import('../dist/touchup/blender.js');
  const server = await listen();
  t.after(() => server.close());
  const {client} = fakeClient();
  client.connect = async () => { throw Error('disconnected'); };
  await assert.rejects(stopOwnedBlender(client, {port: server.address().port}), /disconnected/);
  assert.equal(client.closed, 1);
});
