import {createServer} from 'node:http';
import {once} from 'node:events';

/** Loopback HTTP stubs that record requests and answer like OctoPrint or Moonraker. */

const OCTOPRINT_IDLE = {
  state: {
    text: 'Operational',
    flags: {operational: true, ready: true, printing: false, paused: false, error: false},
  },
};

const KLIPPER_IDLE = {
  result: {
    status: {
      webhooks: {state: 'ready'},
      print_stats: {state: 'standby', filename: ''},
    },
  },
};

/**
 * @param {'octoprint' | 'klipper'} backend
 * @returns {Promise<{port: string, requests: Array<{method: string, url: string, body: string}>, close: () => Promise<void>}>}
 */
export async function startFakePrinter(backend) {
  const requests = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = {method: req.method, url: req.url ?? '', body: Buffer.concat(chunks).toString()};
    requests.push(record);
    const url = record.url;
    if (backend === 'octoprint') {
      if (req.method === 'GET' && url.startsWith('/api/printer') && !url.startsWith('/api/printer/')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(OCTOPRINT_IDLE));
        return;
      }
      res.writeHead(req.method === 'GET' ? 200 : 201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({done: true}));
      return;
    }
    if (backend === 'klipper') {
      if (req.method === 'GET' && url.startsWith('/printer/objects/query')) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(KLIPPER_IDLE));
        return;
      }
      res.writeHead(req.method === 'GET' ? 200 : 201, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({result: {item: {path: 'handoff.gcode', root: 'gcodes'}}}));
      return;
    }
    res.writeHead(500);
    res.end('unknown backend');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = String(http.address().port);
  return {
    port,
    requests,
    close: () => new Promise(resolve => http.close(resolve)),
  };
}

/** G-code that passes generic print-safety checks for PLA. */
export const SAFE_PLA_GCODE =
  '; filament_type = PLA\nM140 S60\nM104 S215\nM190 S60\nM109 S215\nG28\nG1 X10 Y10 E1\nM104 S0\n';
