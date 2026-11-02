import {appendFileSync} from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const log = value => appendFileSync(process.argv[2], `${JSON.stringify(value)}\n`);
const server = new Server({name: 'configured-fusion-peer', version: '1'}, {capabilities: {tools: {}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: ['fusion_mcp_call', 'fusion_mcp_export'].map(name => ({name, inputSchema: {type: 'object', properties: {document_id: {type: 'string'}, tool_name: {type: 'string'}, arguments: {type: 'object'}}, additionalProperties: false}}))}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  log(request.params);
  if (request.params.arguments?.tool_name === 'broken_profile') return {isError: true, content: [{type: 'text', text: 'PROFILE_NOT_CLOSED: close the loop before extruding.'}]};
  if (request.params.arguments?.tool_name === 'render_view') return {content: [{type: 'image', mimeType: 'image/png', data: Buffer.alloc(1024 * 1024).toString('base64')}]};
  return {content: [{type: 'text', text: 'done'}]};
});
process.stdin.once('end', () => {log({closed: true}); void server.close();});
await server.connect(new StdioServerTransport());
