// The capture companion's front proxy, which can make a run's Mac behave as a real one does on a bad day. Every
// ux_screens capture talked to a companion on loopback that answered instantly and never refused, so the app was never
// seen waiting for a 2–192 MB scan or being refused one. David, Nov 10, after "What you scanned" stayed blank on his
// phone: "you are STILL ALLLOWING BAD UX TO MAKE IT THROUGH THE GATE, UNREAL".
//
// Only the proxy the tool owns changes behaviour; the companion and the app run their shipping code unchanged.
// A reply is a file when its content type isn't JSON (models, scans, pictures); everything else is the JSON API.
//
//   node conditions.mjs --target http://127.0.0.1:<port> --condition slow [--port 0]   (prints {"port": n})
import {createServer, request} from 'node:http';
import {pathToFileURL} from 'node:url';

export const CONDITIONS = {
  none: 'replies as the companion gives them',
  slow: 'every reply waits 1.5 s, and files arrive at about 1 MB/s (a 16 MB scan takes 16 s)',
  refusing: 'file downloads answer 413 (models and scans) or 404 (pictures); the JSON API works',
  away: 'the project list loads once; after that nothing answers',
};

const sleep = ms => new Promise(done => setTimeout(done, ms));
const isJson = headers => /json/i.test(headers['content-type'] ?? '');
const isList = url => /^\/v1\/objects\/?(\?.*)?$/.test(url);

/** Writes `from` to `to` at about `bytesPerSecond`, in 64 KiB slices. */
function trickle(from, to, bytesPerSecond) {
  const started = Date.now();
  let sent = 0;
  from.on('data', data => {
    from.pause();
    (async () => {
      for (let i = 0; i < data.length; i += 65536) {
        const slice = data.subarray(i, i + 65536);
        if (!to.write(slice)) await new Promise(done => to.once('drain', done));
        sent += slice.length;
        const wait = started + (sent / bytesPerSecond) * 1000 - Date.now();
        if (wait > 0) await sleep(wait);
      }
      from.resume();
    })().catch(() => from.destroy());
  });
  from.on('end', () => to.end());
  from.on('error', () => to.destroy());
}

const check = name => {
  if (!Object.hasOwn(CONDITIONS, name)) throw new Error(`Unknown condition ${name}; choose from ${Object.keys(CONDITIONS).join(', ')}`);
  return name;
};

/** An http.Server that forwards to `target` under a condition, changed with `setCondition` (the runner pairs and checks
 * the list under `none` first). `headers` rewrites the request headers. */
export function conditionedProxy({target, condition = 'none', headers = h => h, delayMs = 1500, bytesPerSecond = 1_000_000}) {
  check(condition);
  let away = false;
  const server = createServer((req, res) => {
    if (away) { req.socket.destroy(); return; }
    const upstream = request(`${target}${req.url}`, {method: req.method, headers: headers(req.headers)}, async response => {
      if (condition === 'away' && req.method === 'GET' && isList(req.url) && response.statusCode === 200) away = true;
      if (condition === 'refusing' && req.method === 'GET' && response.statusCode === 200 && !isJson(response.headers)) {
        response.resume();
        const picture = /^image\//i.test(response.headers['content-type'] ?? '');
        const body = JSON.stringify({error: {code: picture ? 'not-found' : 'too-large', message: `ux_screens condition "refusing"`}});
        res.writeHead(picture ? 404 : 413, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)});
        res.end(body);
        return;
      }
      if (condition === 'slow') await sleep(delayMs);
      res.writeHead(response.statusCode, response.headers);
      if (condition === 'slow' && !isJson(response.headers)) trickle(response, res, bytesPerSecond);
      else response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(503); res.end(); } else res.destroy(); });
    req.pipe(upstream);
  });
  server.setCondition = name => { condition = check(name); away = false; };
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
    value.startsWith('--') ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
  const proxy = conditionedProxy({target: args.target, condition: args.condition ?? 'none',
    ...(args['delay-ms'] ? {delayMs: Number(args['delay-ms'])} : {}), ...(args.rate ? {bytesPerSecond: Number(args.rate)} : {})});
  proxy.listen(Number(args.port ?? 0), '127.0.0.1', () => process.stdout.write(JSON.stringify({port: proxy.address().port}) + '\n'));
  process.on('SIGTERM', () => { proxy.close(); process.exit(0); });
}
