// A printer MCP stand-in for /v1/mcp tests: annotated, unannotated, raw-named and eliciting tools, a prompt
// and a resource with a host template. Every request it receives is logged to argv[2].
import {appendFileSync} from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const log = value => appendFileSync(process.argv[2], `${JSON.stringify(value)}\n`);
const open = {type: 'object', properties: {
  stl_path: {type: 'string'}, output_path: {type: 'string'}, save_path: {type: 'string'}, three_mf_path: {type: 'string'},
  slicer_profile: {type: 'string'}, note: {type: 'string'}, host: {type: 'string'}, bridge_command: {type: 'string'},
  ms: {type: 'number'}, ask: {type: 'boolean'}, nested: {type: 'object'},
  bambu_model: {type: 'string'}, nozzle_diameter: {type: 'string'}, launch: {type: 'boolean'}, type: {type: 'string'}, port: {type: 'string'}, source_f3d: {type: 'string'},
}};
const required = {...open, required: ['stl_path', 'bambu_model']};
// The argument kinds and scopes the printer MCPs declare (_meta["counterpart/remote"], bambu-printer-mcp 1.1.63+).
const ARGUMENTS = {stl_path: 'path', output_path: 'output', save_path: 'output', three_mf_path: 'path', slicer_profile: 'path', source_f3d: 'path',
  host: 'config', port: 'config', bridge_command: 'config', bambu_model: 'config', nozzle_diameter: 'config', type: 'config-top'};
const declare = (scope, extra = {}) => ({_meta: {'counterpart/remote': {scope, arguments: ARGUMENTS, ...extra}}});
const tools = [
  {name: 'slice_stl', inputSchema: required, ...declare('design')},
  {name: 'get_printer_status', inputSchema: open, ...declare('read')},
  {name: 'peek', inputSchema: open, annotations: {readOnlyHint: true}, ...declare('read')},
  {name: 'shape', inputSchema: open, annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false}, ...declare('design')},
  // Annotations are hints for other clients; the declared scope is what Counterpart offers it at.
  {name: 'set_light', inputSchema: open, annotations: {readOnlyHint: true}, ...declare('control')},
  {name: 'print_3mf', inputSchema: open, ...declare('print')},
  // An MCP from before the declarations: no scope, so only a raw device sees it.
  {name: 'mystery', inputSchema: open},
  {name: 'bambu_network_call', inputSchema: open, annotations: {readOnlyHint: true}, ...declare('raw')},
  {name: 'ask', inputSchema: open, annotations: {readOnlyHint: true}, ...declare('read')},
  {name: 'fusion_mcp_status', inputSchema: open, ...declare('read', {raisedBy: {launch: 'design'}})},
];
const server = new Server({name: 'remote-mcp-peer', version: '1.0.0'},
  {capabilities: {tools: {}, prompts: {}, resources: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const {name, arguments: args = {}} = request.params;
  log({tool: name, args});
  if (args.ms) await new Promise(resolve => setTimeout(resolve, args.ms));
  if (name === 'ask' || args.ask) {
    const answer = await server.elicitInput({message: `May ${name} go ahead?`,
      requestedSchema: {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']}});
    log({answer});
    if (answer.action !== 'accept' || answer.content?.confirmed !== true) return {isError: true, content: [{type: 'text', text: 'Declined; nothing was sent.'}]};
  }
  if (name === 'mystery') return {isError: true, content: [{type: 'text', text: 'raw error passes through'}]};
  return {content: [{type: 'text', text: `${name} ok`}], structuredContent: {tool: name}};
});
server.setRequestHandler(ListPromptsRequestSchema, async () => ({prompts: [{name: 'fdm_guide', description: 'Call slice_stl after lay_flat.', arguments: [{name: 'topic'}]}, {name: 'ask_prompt'}, {name: 'slow_prompt'}]}));
server.setRequestHandler(GetPromptRequestSchema, async request => {
  log({prompt: request.params.name, args: request.params.arguments});
  if (request.params.name === 'slow_prompt') await new Promise(resolve => setTimeout(resolve, 2000));
  if (!['fdm_guide', 'ask_prompt', 'slow_prompt'].includes(request.params.name)) throw new Error(`Prompt ${request.params.name} not found`);
  if (request.params.name === 'ask_prompt') {
    const answer = await server.elicitInput({message: 'Which topic?', requestedSchema: {type: 'object', properties: {confirmed: {type: 'boolean'}}}});
    log({answer});
  }
  return {messages: [{role: 'user', content: {type: 'text', text: `Guide on ${request.params.arguments?.topic ?? 'all'}: call slice_stl.`}}]};
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{uri: 'printer://10.0.0.5/status', name: 'Status', mimeType: 'application/json'}, {uri: 'printer://10.0.0.5/broken', name: 'Broken'}],
  templates: [{uriTemplate: 'printer://{host}/status', name: 'Status'}],
}));
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  log({resource: request.params.uri});
  if (request.params.uri.endsWith('/broken')) throw new Error('printer offline');
  return {contents: [{uri: request.params.uri, mimeType: 'application/json', text: '{"state":"IDLE"}'}]};
});
process.stdin.once('end', () => { void server.close(); });
await server.connect(new StdioServerTransport());
