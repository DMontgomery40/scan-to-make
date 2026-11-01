// Isolated local Simulator fixture. No Tailscale, account, TLS bypass or printer.
// Run after npm ci/build in services/companion. Invitations are written to a
// private temporary directory, never stdout. Only fixed synthetic identities.
import { createServer, request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuthStore } from '../../../../services/companion/dist/remote-auth.js';
import { startCompanionServer } from '../../../../services/companion/dist/server.js';
const root = await mkdtemp(join(tmpdir(), 'scan-pairing-fixture-'));
const auth = await RemoteAuthStore.create(join(root, 'auth'), {
  host: 'fixture.example.ts.net',
  allowedLogins: ['fixture@example.test'],
});
const nativeFaults = process.env.SCAN_NATIVE_FAULTS === '1';
const faultKey = nativeFaults ? randomBytes(32).toString('hex') : null;
if (faultKey)
  await writeFile(join(root, 'fault-key'), faultKey, { mode: 0o600 });
const captureEnabled = process.env.SCAN_CAPTURE_FIXTURE === '1';
const stillsProcessingEnabled =
  process.env.SCAN_STILLS_PROCESSING_FIXTURE === '1';
let capture;
if (captureEnabled || stillsProcessingEnabled) {
  const { FileSavedProjectStorage } = await import(
    '../../../../services/project/dist/index.js'
  );
  const { CaptureStore } = await import(
    '../../../../services/companion/dist/capture-import.js'
  );
  const { createCaptureConverter } = await import(
    '../../../../services/companion/dist/capture-converter.js'
  );
  const storage = new FileSavedProjectStorage(join(root, 'projects'));
  // The stills/processing fixture seeds its capture with the same synthetic
  // converter as the companion scan-processing tests, so it needs no USD
  // toolchain. Other modes keep the real converter.
  const fixtureHash = bytes => createHash('sha256').update(bytes).digest('hex');
  const fixtureCube = Buffer.from(
    'v 0 0 0\nv .06 0 0\nv .06 .04 0\nv 0 .04 0\nv 0 0 .02\nv .06 0 .02\nv .06 .04 .02\nv 0 .04 .02\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n',
  );
  const fixtureConverter = {
    async convert(original) {
      return {
        derived: fixtureCube,
        report: Buffer.from(
          JSON.stringify({
            tool: 'capture-mesh-convert',
            toolVersion: '0.3.0',
            source: { sha256: fixtureHash(original), bytes: original.length },
            output: {
              sha256: fixtureHash(fixtureCube),
              bytes: fixtureCube.length,
              format: 'obj',
            },
            metersPerUnit: 1,
            unitsAuthored: true,
            upAxis: 'Y',
            metricQualified: true,
            metricQualifiedReason: null,
            outputBasis: {
              coordinates: 'world',
              units: 'native stage units (unrescaled)',
              metersPerUnit: 1,
              upAxis: 'Y',
            },
            contributingLayers: [
              {
                identifier: 'synthetic.usdc',
                sha256: 'a'.repeat(64),
                bytes: 30,
              },
            ],
            unsupportedFeatures: [],
            provesCompleteCapture: false,
            provesPhysicalFit: false,
          }),
        ),
      };
    },
  };
  const captures = new CaptureStore(
    storage,
    join(root, 'captures'),
    stillsProcessingEnabled
      ? fixtureConverter
      : createCaptureConverter({
          executable: process.env.SCAN_TO_MAKE_CAPTURE_PYTHON || 'python3',
          temporaryRoot: join(root, 'workers'),
        }),
  );
  capture = {
    storage,
    ...(captureEnabled || stillsProcessingEnabled ? { captures } : {}),
  };
  if (stillsProcessingEnabled) {
    const { DetailStillStore } = await import(
      '../../../../services/companion/dist/detail-stills.js'
    );
    const { ScanProcessingStore } = await import(
      '../../../../services/companion/dist/scan-processing.js'
    );
    const { SCAN_VIEW_NAMES } = await import(
      '../../../../packages/contracts/dist/scan-processing.js'
    );
    const { createSavedProjects } = await import(
      '../../../../packages/contracts/dist/saved-project.js'
    );
    const fixturePng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    const fakeRunner = {
      async run(stage, input, output) {
        await mkdir(output, { recursive: true });
        if (stage === 'repair') {
          await writeFile(join(output, 'repaired.obj'), fixtureCube);
          await writeFile(join(output, 'repaired.stl'), 'synthetic stl');
          await writeFile(join(output, 'report.json'), '{}');
        }
        if (stage === 'render')
          for (const name of SCAN_VIEW_NAMES)
            await writeFile(join(output, name), fixturePng);
        return Buffer.from(
          JSON.stringify({
            principalExtentsMm: [62.9, 48.7, 21.7],
            boxExtentsMm: [62.9, 48.7, 21.7],
          }),
        );
      },
    };
    capture.detailStills = new DetailStillStore(
      storage,
      join(root, 'captures'),
    );
    capture.scanProcessing = new ScanProcessingStore(
      storage,
      captures,
      join(root, 'captures'),
      fakeRunner,
    );
    const projects = createSavedProjects(storage);
    await projects.create({
      id: 'scan-fixture',
      brief: {
        object: 'Synthetic box',
        context: 'Protocol fixture',
        addition: 'Cradle',
      },
    });
    const { captureId } = await captures.importCapture({
      projectId: 'scan-fixture',
      projectRevision: 0,
      source: Buffer.from('synthetic source'),
    });
    const snapshot = await storage.read('scan-fixture');
    await writeFile(
      join(root, 'stills-processing.json'),
      JSON.stringify({
        project: JSON.parse(snapshot),
        snapshot,
        etag: '"' + fixtureHash(snapshot) + '"',
        captureId,
        png: {
          sha256: fixtureHash(fixturePng),
          byteLength: fixturePng.length,
          mediaType: 'image/png',
        },
      }),
      { mode: 0o600 },
    );
  }
}
// Objects (KAN-204): a real object service whose touch-up is a fixture that
// writes a known model and render, so the phone's objects bridge can be
// proven end to end without Claude, Blender or a printer.
let objects;
if (process.env.SCAN_OBJECTS_FIXTURE === '1') {
  const { ObjectStore } = await import(
    '../../../../services/companion/dist/objects/store.js'
  );
  const { ObjectService } = await import(
    '../../../../services/companion/dist/objects/service.js'
  );
  const fixtureStl =
    'solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid fixture\n';
  // A real picture for looking at the app; the native test uses the default bytes.
  const fixtureRender = process.env.SCAN_OBJECTS_FIXTURE_RENDER
    ? await readFile(process.env.SCAN_OBJECTS_FIXTURE_RENDER)
    : Buffer.from('fixture render png');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  let passes = 0;
  objects = new ObjectService({
    store: new ObjectStore(join(root, 'objects')),
    claudePath: '/fixture/claude',
    handoff: {
      backend: 'bambu-printer-mcp',
      process: { command: '/usr/bin/true' },
    },
    stlInfo: async () => [10, 10, 0],
    runTouchup: async input => {
      const passDir = join(root, 'passes', String(++passes)),
        out = join(passDir, 'out');
      await mkdir(out, { recursive: true });
      await writeFile(join(out, 'model.stl'), fixtureStl);
      await writeFile(join(out, 'render_front.png'), fixtureRender);
      await writeFile(
        join(root, `pass-${passes}.json`),
        JSON.stringify({
          scan: input.scan.length,
          photos: input.photos.length,
          note: input.note ?? null,
        }),
      );
      return {
        status: 'done',
        summary: 'Fixture touch-up.',
        model: join(out, 'model.stl'),
        renders: [join(out, 'render_front.png')],
        checkpoints: [],
        stats: { seconds: 0, toolCalls: 0 },
        passDir,
      };
    },
  });
  await writeFile(
    join(root, 'objects.json'),
    JSON.stringify({
      stl: {
        sha256: sha(Buffer.from(fixtureStl)),
        byteLength: Buffer.byteLength(fixtureStl),
      },
      render: { sha256: sha(fixtureRender), byteLength: fixtureRender.length },
    }),
    { mode: 0o600 },
  );
}
const backend = await startCompanionServer({
  port: 0,
  remoteAuth: auth,
  capture,
  ...(objects ? { objects } : {}),
});
await writeFile(join(root, 'mode'), 'ok', { mode: 0o600 });
async function invite() {
  const value = await auth.createPairing(
    'fixture@example.test',
    captureEnabled || stillsProcessingEnabled
      ? [
          'generation:health',
          'projects:read',
          'projects:write',
          'captures:read',
          'captures:import',
        ]
      : undefined,
  );
  await writeFile(
    join(root, 'invitation.json'),
    JSON.stringify({
      version: 1,
      baseUrl: 'http://127.0.0.1:9078',
      code: value.code,
      expiresAt: value.expiresAt,
    }),
    { mode: 0o600 },
  );
}
await invite();
process.on('SIGUSR1', () => invite().catch(() => {}));
process.on('SIGUSR2', () =>
  auth
    .listDevices()
    .then(devices => Promise.all(devices.map(d => auth.revoke(d.deviceId))))
    .catch(() => {}),
);
const proxy = createServer(async (req, res) => {
  if (nativeFaults && req.url?.startsWith('/__fixture/mode/')) {
    const selected = req.url.slice('/__fixture/mode/'.length);
    const allowed = [
      'ok',
      'wrong-hash',
      'wrong-type',
      'wrong-bytes',
      'oversized',
      'delayed',
    ];
    if (
      req.method !== 'POST' ||
      req.headers['x-fixture-key'] !== faultKey ||
      !allowed.includes(selected)
    ) {
      res.writeHead(403).end();
      return;
    }
    await writeFile(join(root, 'mode'), selected, { mode: 0o600 });
    res.writeHead(204).end();
    return;
  }
  const mode = (await readFile(join(root, 'mode'), 'utf8')).trim();
  if (mode === 'offline') {
    req.socket.destroy();
    return;
  }
  if (mode === 'redirect') {
    res.writeHead(302, { Location: 'https://other.example.ts.net/healthz' });
    res.end();
    return;
  }
  if (mode === 'forbidden') {
    res.writeHead(403);
    res.end('{"error":{"code":"forbidden","message":"Fixture denial"}}');
    return;
  }
  const upstream = request(
    `${backend.url}${req.url}`,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: auth.host,
        'x-forwarded-host': auth.host,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': 'fixture@example.test',
      },
    },
    response => {
      // Fault injection only after the real authenticated artifact route succeeds.
      const fault =
        nativeFaults &&
        response.statusCode === 200 &&
        req.url?.includes('/artifacts/') &&
        mode !== 'ok';
      if (!fault) {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        let bytes = Buffer.concat(chunks);
        const headers = { ...response.headers };
        if (mode === 'wrong-hash') headers['x-content-sha256'] = '0'.repeat(64);
        if (mode === 'wrong-type') headers['content-type'] = 'text/plain';
        if (mode === 'wrong-bytes') {
          bytes = Buffer.from(bytes);
          bytes[0] ^= 1;
        }
        if (mode === 'oversized') {
          delete headers['content-length'];
          bytes = Buffer.concat([bytes, Buffer.from('x')]);
        }
        res.writeHead(200, headers);
        if (mode === 'delayed') {
          res.write(bytes.subarray(0, 1));
          const timer = setTimeout(() => res.end(bytes.subarray(1)), 2000);
          res.on('close', () => clearTimeout(timer));
        } else res.end(bytes);
      });
      response.on('error', () => res.destroy());
    },
  );
  upstream.on('error', () => {
    res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
});
proxy.listen(9078, '127.0.0.1', () =>
  console.log(
    JSON.stringify({
      fixture: true,
      directory: root,
      port: 9078,
      pid: process.pid,
    }),
  ),
);
const shutdown = async () => {
  proxy.close();
  await backend.close();
  process.exit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
