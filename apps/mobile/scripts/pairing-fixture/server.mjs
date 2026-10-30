// Isolated local Simulator fixture. No Tailscale, account, TLS bypass or printer.
// Run after npm ci/build in services/companion. Invitations are written to a
// private temporary directory, never stdout. Only fixed synthetic identities.
import { createServer, request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuthStore } from '../../../../services/companion/dist/remote-auth.js';
import { startGenerationServer } from '../../../../services/companion/dist/generation.js';
const root = await mkdtemp(join(tmpdir(), 'scan-pairing-fixture-'));
const auth = await RemoteAuthStore.create(join(root, 'auth'), {
  host: 'fixture.example.ts.net',
  allowedLogins: ['fixture@example.test'],
});
const nativeFaults = process.env.SCAN_NATIVE_FAULTS === '1';
const faultKey = nativeFaults ? randomBytes(32).toString('hex') : null;
if (faultKey)
  await writeFile(join(root, 'fault-key'), faultKey, { mode: 0o600 });
const preparedEnabled = process.env.SCAN_PREPARED_FIXTURE === '1';
const captureEnabled = process.env.SCAN_CAPTURE_FIXTURE === '1';
const stillsProcessingEnabled =
  process.env.SCAN_STILLS_PROCESSING_FIXTURE === '1';
let capture;
if (captureEnabled || preparedEnabled || stillsProcessingEnabled) {
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
  const fixtureHash = bytes =>
    createHash('sha256').update(bytes).digest('hex');
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
          JSON.stringify({ principalExtentsMm: [62.9, 48.7, 21.7] }),
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
      fit: null,
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
  if (preparedEnabled) {
    const { PreparedJobStore } = await import(
      '../../../../services/companion/dist/prepared-jobs.js'
    );
    const { createSavedProjects } = await import(
      '../../../../packages/contracts/dist/saved-project.js'
    );
    const { fileURLToPath } = await import('node:url');
    const fit = JSON.parse(
      await readFile(
        new URL(
          '../../../../packages/contracts/fixtures/tapered-holder.json',
          import.meta.url,
        ),
      ),
    );
    const projects = createSavedProjects(storage);
    await projects.create({
      id: fit.id,
      brief: {
        object: 'Synthetic cup',
        context: 'Protocol fixture',
        addition: 'Holder',
      },
      fit,
    });
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const settings = Buffer.from(
      JSON.stringify({
        fixture: true,
        model: 'p1s',
        nozzle: 0.4,
        material: 'PLA',
      }),
    );
    await writeFile(join(root, 'settings.json'), settings, { mode: 0o600 });
    const producedDirectory = process.env.SCAN_PRODUCED_FIXTURE_DIR;
    const design = producedDirectory
      ? await readFile(join(producedDirectory, 'source.stl'))
      : Buffer.from('synthetic accepted design identity');
    const binding = {
      sourceFit: fit,
      artifact: {
        sha256: hash(design),
        byteLength: design.length,
        mediaType: 'model/stl',
      },
    };
    await projects.change(fit.id, 0, { kind: 'attach-preview', ...binding });
    await projects.change(fit.id, 1, { kind: 'accept-preview', ...binding });
    capture.preparedJobs = new PreparedJobStore(
      storage,
      join(root, 'prepared'),
      {
        inspection: {
          process: {
            command: process.execPath,
            args: [
              fileURLToPath(
                new URL(
                  '../../../../services/companion/tests/fixtures/inspection-server.mjs',
                  import.meta.url,
                ),
              ),
              'ok',
              join(root, 'inspection.jsonl'),
            ],
          },
        },
      },
    );
    const jobs = [];
    const count = Number(process.env.SCAN_PREPARED_FIXTURE_COUNT ?? 2);
    if (!Number.isInteger(count) || count < 2 || count > 50)
      throw Error('Fixture count must be 2–50');
    for (let index = 0; index < count; index++) {
      const mediaType = index % 2 ? 'text/x.gcode' : 'model/3mf';
      // Protocol fixture bytes, not a slicer output or physical-print claim.
      const printable = Buffer.from(
        'isolated native protocol fixture ' + mediaType,
      );
      const result = await capture.preparedJobs.prepare({
        projectId: fit.id,
        projectRevision: 2,
        printable,
        printableArtifact: {
          sha256: hash(printable),
          byteLength: printable.length,
          mediaType,
        },
        selection: {
          printerId: 'synthetic',
          model: 'p1s',
          plateIndex: 0,
          nozzleDiameters: [0.4],
          bedType: 'textured_plate',
          materials: [{ projectSlot: 0, material: 'PLA', physicalTray: 254 }],
          slicerSettingsSha256: hash(settings),
        },
      });
      jobs.push({ jobId: result.jobId, job: result.job });
    }
    if (producedDirectory) {
      // Replay retained operator-produced evidence through the real read APIs.
      // This fixture does not claim to rerun slicing or inspection.
      const record = await readFile(join(producedDirectory, 'job.json'));
      const job = JSON.parse(record.toString('utf8'));
      if (
        !/^[a-f0-9-]{36}$/.test(job.id) ||
        job.projectId !== fit.id ||
        job.projectRevision !== 2 ||
        !job.production ||
        job.designArtifact?.sha256 !== binding.artifact.sha256 ||
        job.designArtifact?.mediaType !== binding.artifact.mediaType ||
        job.designArtifact?.byteLength !== binding.artifact.byteLength
      )
        throw Error('Retained produced fixture does not match its source');
      const folder = join(root, 'prepared', job.id);
      await mkdir(folder);
      await writeFile(join(folder, 'job.json'), record);
      for (const name of [
        'source.stl',
        'settings.json',
        'production.json',
        'printable.bin',
      ])
        await writeFile(
          join(folder, name),
          await readFile(join(producedDirectory, name)),
        );
      // Reopen verifies every retained source/settings/manifest/printable identity.
      await capture.preparedJobs.loadPreparedJob(job.id);
      jobs.push({ jobId: job.id, job });
    }
    const snapshot = await storage.read(fit.id);
    await writeFile(
      join(root, 'prepared.json'),
      JSON.stringify({
        project: JSON.parse(snapshot),
        snapshot,
        etag: '"' + hash(snapshot) + '"',
        jobs,
      }),
      { mode: 0o600 },
    );
  }
}
const backend = await startGenerationServer({
  port: 0,
  remoteAuth: auth,
  capture,
});
await writeFile(join(root, 'mode'), 'ok', { mode: 0o600 });
async function invite() {
  const value = await auth.createPairing(
    'fixture@example.test',
    preparedEnabled
      ? [
          'generation:health',
          'projects:read',
          'projects:write',
          'prepared-jobs:read',
          'prepared-jobs:prepare',
        ]
      : captureEnabled || stillsProcessingEnabled
      ? [
          'generation:health',
          'generation:create',
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
