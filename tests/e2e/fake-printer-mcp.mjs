/**
 * Local fixture stand-in for bambu-printer-mcp / mcp-3D-printer-server.
 * No network, no secrets, no real printer. Used when the handoff package lands (KAN-120).
 */
import { createServer } from 'node:http';
import { once } from 'node:events';

const HANDOFF_TOOL = 'scan_to_make_receive_mesh';

export async function startFakePrinterMcp() {
  const received = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    if (body.method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          tools: [{ name: HANDOFF_TOOL, description: 'fixture handoff receiver' }],
        })
      );
      return;
    }
    if (body.method === 'tools/call' && body.params?.name === HANDOFF_TOOL) {
      received.push(body.params.arguments ?? {});
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'accepted' }] }));
      return;
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unsupported method' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture MCP failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    toolName: HANDOFF_TOOL,
    received,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
