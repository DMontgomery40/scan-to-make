import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// Discovery only: no tools/call, printer credentials or physical operations.
for (const command of ['bambu-printer-mcp', 'mcp-3d-printer-server']) {
  const child = spawn(command, [], {stdio: ['pipe', 'pipe', 'inherit'], env: {...process.env, MCP_TRANSPORT: 'stdio'}});
  const lines = createInterface({input: child.stdout});
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${command}: initialize timed out`)), 15000);
    child.once('error', reject);
    child.once('exit', code => {clearTimeout(timer); reject(new Error(`${command}: exited ${code}`));});
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.error) throw new Error(JSON.stringify(message.error));
        if (message.id === 1) {
          assert.ok(message.result.serverInfo.name);
          send({jsonrpc: '2.0', method: 'notifications/initialized'});
          send({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
        } else if (message.id === 2) {
          assert.ok(message.result.tools.some(tool => tool.name === 'slice_stl'));
          clearTimeout(timer);
          resolve(message.result.tools.length);
        }
      } catch (error) {clearTimeout(timer); reject(error);}
    });
    send({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'companion-package-smoke', version: '1.0.0'},
    }});
  });
  try {console.log(`${command}: initialized; ${await result} tools`);}
  finally {lines.close(); child.stdin.end(); child.kill('SIGKILL');}
}
