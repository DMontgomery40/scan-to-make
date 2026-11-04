import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {PrinterMcpClient, PrinterMcpError} from './mcp-client.js';
import type {PrinterHandoffConfig} from './config.js';

const FUSION_TOOLS = new Set(['fusion_mcp_status', 'fusion_mcp_call', 'fusion_mcp_export']);
/** What a design pass reads to plan the print (the MCP's fdm_design guidance): the printer, its filaments and a check slice. */
const PRINTER_TOOLS = new Set(['counterpart_printer_info', 'get_printer_filaments', 'get_slice_settings', 'slice_stl']);
const TOOLS = new Set([...FUSION_TOOLS, ...PRINTER_TOOLS]);
type Upstream = Pick<PrinterMcpClient, 'catalog' | 'callTool'>;

/** A pass owns the binding; worker arguments can never select another document.
 * Uses the configured transport unchanged, including SSH forced commands. */
export function createBoundFusionServer(upstream: Upstream, documentId: string): Server {
  if (!documentId.trim()) throw new Error('A Fusion document binding is required');
  const tools = (upstream.catalog?.tools ?? []).filter(tool => TOOLS.has(tool.name));
  for (const name of ['fusion_mcp_call', 'fusion_mcp_export']) {
    if (!tools.find(tool => tool.name === name)?.inputSchema.properties?.document_id)
      throw new Error('The configured Fusion bridge does not support document binding');
  }
  const server = new Server({name: 'counterpart-fusion-document', version: '1'}, {capabilities: {tools: {}}});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: tools.map(tool => {
    const copy = structuredClone(tool);
    delete copy.inputSchema.properties?.document_id;
    return copy;
  })}));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const {name, arguments: args = {}} = request.params;
    if (!TOOLS.has(name)) throw new Error('This tool is not available in the bound Fusion pass');
    const nested = args.arguments;
    if ('document_id' in args || nested && typeof nested === 'object' && 'document_id' in nested)
      throw new Error('The pass selects the Fusion document binding');
    try {
      const bound = name === 'fusion_mcp_call' || name === 'fusion_mcp_export';
      return await upstream.callTool(name, bound ? {...args, document_id: documentId} : args, {signal: extra.signal, forwardResult: true});
    } catch (error) {
      if (!(error instanceof PrinterMcpError)) throw error;
      return {isError: true, content: [{type: 'text', text: error.detail ?? error.message}]};
    }
  });
  return server;
}

/** Lifecycle for the worker's stdio child, using the existing SDK at both ends. */
export async function serveBoundFusion(config: PrinterHandoffConfig, documentId: string): Promise<void> {
  const upstream = new PrinterMcpClient(config);
  let server: Server | undefined;
  const controller = new AbortController();
  let finish!: () => void;
  const closed = new Promise<void>(resolve => { finish = resolve; });
  const stop = () => { controller.abort(); finish(); };
  process.stdin.once('end', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await upstream.connect(controller.signal);
    server = createBoundFusionServer(upstream, documentId);
    server.onclose = finish;
    await server.connect(new StdioServerTransport());
    await closed;
  } finally {
    process.stdin.off('end', stop);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await server?.close().catch(() => undefined);
    await upstream.close();
  }
}
