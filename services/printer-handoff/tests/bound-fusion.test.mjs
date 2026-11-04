import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createBoundFusionServer} from '../dist/bound-fusion.js';

async function session(t, legacy = false) {
  const calls = [];
  const tools = ['fusion_mcp_status', 'fusion_mcp_call', 'fusion_mcp_export', 'fusion_mcp_new_design', 'blender_mcp_call', 'get_printer_filaments', 'slice_stl', 'print_3mf'].map(name => ({name, inputSchema: {type: 'object', properties: {...(!legacy ? {document_id: {type: 'string'}} : {}), tool_name: {type: 'string'}, arguments: {type: 'object'}, output_dir: {type: 'string'}, name: {type: 'string'}}, additionalProperties: false}}));
  const upstream = {catalog: {server: {name: 'configured-ssh-peer', version: '1'}, tools}, async callTool(name, args) {calls.push({name, args}); return {content: [{type: 'text', text: 'done'}]};}};
  const server = createBoundFusionServer(upstream, 'trusted-document');
  const client = new Client({name: 'worker', version: '1'});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {await client.close(); await server.close();});
  return {client, calls};
}

test('worker calls bind the configured document over the existing MCP transport', async t => {
  const {client, calls} = await session(t);
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['fusion_mcp_status', 'fusion_mcp_call', 'fusion_mcp_export', 'get_printer_filaments', 'slice_stl']);
  assert.ok(tools.every(t => !t.inputSchema.properties.document_id));
  await client.callTool({name: 'fusion_mcp_call', arguments: {tool_name: 'extrude', arguments: {distance: 1}}});
  await client.callTool({name: 'fusion_mcp_export', arguments: {output_dir: '/pass/out', name: 'touched'}});
  assert.deepEqual(calls, [
    {name: 'fusion_mcp_call', args: {tool_name: 'extrude', arguments: {distance: 1}, document_id: 'trusted-document'}},
    {name: 'fusion_mcp_export', args: {output_dir: '/pass/out', name: 'touched', document_id: 'trusted-document'}},
  ]);
});

test('worker cannot change the configured binding or create an unbound design', async t => {
  const {client, calls} = await session(t);
  for (const request of [
    {name: 'fusion_mcp_call', arguments: {tool_name: 'extrude', document_id: 'user-doc'}},
    {name: 'fusion_mcp_call', arguments: {tool_name: 'extrude', arguments: {document_id: 'user-doc'}}},
    {name: 'fusion_mcp_new_design', arguments: {}},
    {name: 'blender_mcp_call', arguments: {}},
    {name: 'print_3mf', arguments: {}},
  ]) await assert.rejects(client.callTool(request));
  assert.deepEqual(calls, []);
});

test('worker refuses a configured bridge that cannot carry the binding', async t => {
  await assert.rejects(session(t, true), /document binding/);
});

test('a Fusion pass reads the printer to plan the print: filaments and a check slice, never bound to the document', async t => {
  const {client, calls} = await session(t);
  await client.callTool({name: 'get_printer_filaments', arguments: {}});
  await client.callTool({name: 'slice_stl', arguments: {name: 'checkpoint'}});
  assert.deepEqual(calls, [{name: 'get_printer_filaments', args: {}}, {name: 'slice_stl', args: {name: 'checkpoint'}}]);
});
