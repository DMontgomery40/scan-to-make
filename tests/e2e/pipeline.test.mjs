import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FileSavedProjectStorage } from '@scan-to-make/project';
import { SCAN_VIEW_NAMES } from '@scan-to-make/contracts/scan-processing';
import { CaptureStore } from '@scan-to-make/companion/capture-import';
import { DetailStillStore } from '@scan-to-make/companion/detail-stills';
import { ScanProcessingStore, createScanRunner } from '@scan-to-make/companion/scan-processing';
import { createCaptureConverter } from '@scan-to-make/companion/capture-converter';
import { RemoteAuthStore } from '@scan-to-make/companion/remote-auth';
import { startCompanionServer } from '@scan-to-make/companion';
import { repoRoot } from './repo-root.mjs';
import { generateSyntheticUsdz } from './generate-synthetic-usdz.mjs';
import { generateSyntheticHeic } from './generate-synthetic-heic.mjs';
import { startFakePrinterMcp } from './fake-printer-mcp.mjs';
import { python } from './resolve-python.mjs';

const execFileAsync = promisify(execFile);
const blender = process.env.BLENDER;
const scanRepairTool = join(repoRoot, 'tools/scan-repair/repair.py');
const scanCorrectTool = join(repoRoot, 'tools/scan-correct/correct.py');
const sandbox = join(repoRoot, 'tools/scan-correct/sandbox.py');

const forwarded = JSON.parse(
  readFileSync(
    new URL(
      '../../services/companion/tests/fixtures/tailscale-serve-v1.94.2.json',
      import.meta.url
    ),
    'utf8'
  )
).expected;

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function blenderReady() {
  if (!blender) return false;
  try {
    await access(blender);
    const { stdout } = await execFileAsync(blender, ['--version'], {
      encoding: 'utf8',
    });
    return /^Blender 5\.0\.1/m.test(stdout);
  } catch {
    return false;
  }
}

async function pythonReady() {
  try {
    await execFileAsync(python, [
      '-c',
      'from pxr import Usd; import PIL; import pillow_heif',
    ]);
    return true;
  } catch {
    return false;
  }
}

function wire(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      baseUrl + path,
      { method, headers: { ...forwarded, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function waitCompanionSlot(baseUrl, authHeaders) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await wire(baseUrl, '/v1/saved-projects/e2e-phone', {
      headers: authHeaders,
    });
    if (result.status !== 429) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('companion request slot stayed busy');
}

async function runPython(args, { cwd = repoRoot, env = process.env } = {}) {
  const run = await execFileAsync(python, ['-I', sandbox, python, ...args], {
    cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 600_000,
  });
  return run.stdout;
}

test(
  'synthetic USDZ → companion import → scan-repair → advise → scripted scan-correct',
  {
    skip:
      (await blenderReady()) && (await pythonReady())
        ? false
        : 'Requires Blender 5.0.1 (BLENDER), pxr/Pillow/pillow-heif (python3 on PATH or CAPTURE_TEST_PYTHON)',
    timeout: 900_000,
  },
  async (t) => {
    const { path: usdzPath, outDir: usdzTemp } = generateSyntheticUsdz('two_layer');
    t.after(() => rm(usdzTemp, { recursive: true, force: true }));

    const {
      bytes: heicBytes,
      outDir: heicTemp,
      sha256: heicSha256,
    } = generateSyntheticHeic();
    t.after(() => rm(heicTemp, { recursive: true, force: true }));

    const root = await mkdtemp(join(tmpdir(), 'e2e-pipeline-'));
    t.after(() => rm(root, { recursive: true, force: true }));

    const remoteAuth = await RemoteAuthStore.create(join(root, 'auth'), {
      host: 'companion.example-tail.ts.net',
      allowedLogins: ['alice@example.test'],
    });
    const invitation = await remoteAuth.createPairing('alice@example.test', [
      'projects:read',
      'projects:write',
      'captures:read',
      'captures:import',
    ]);
    const phone = await remoteAuth.exchange('alice@example.test', {
      code: invitation.code,
      deviceName: 'E2E',
    });
    const authHeaders = {
      authorization: `Bearer ${phone.token}`,
      'x-scan-device': phone.deviceId,
    };

    const storage = new FileSavedProjectStorage(join(root, 'projects'));
    const captures = new CaptureStore(
      storage,
      join(root, 'captures'),
      createCaptureConverter({
        executable: python,
        temporaryRoot: join(root, 'workers'),
      })
    );
    const scanProcessing = new ScanProcessingStore(
      storage,
      captures,
      join(root, 'captures'),
      createScanRunner({
        blender: blender,
        toolPath: scanRepairTool,
        python,
      })
    );
    const server = await startCompanionServer({
      port: 0,
      remoteAuth,
      capture: { storage, captures, scanProcessing, detailStills: new DetailStillStore(storage, join(root, 'captures')) },
    });
    t.after(() => server.close());

    const project = {
      formatVersion: '0.2.0',
      id: 'e2e-phone',
      revision: 0,
      brief: { object: 'Synthetic', context: 'CI', addition: 'E2E' },
      fit: null,
      preview: null,
      acceptedArtifact: null,
    };

    const sync = await wire(server.url, '/v1/saved-projects/e2e-phone', {
      method: 'PUT',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        'if-none-match': '*',
      },
      body: JSON.stringify(project),
    });
    assert.equal(sync.status, 201, sync.bytes.toString());
    const etag = sync.headers.etag;
    await waitCompanionSlot(server.url, authHeaders);

    const usdzBytes = await readFile(usdzPath);
    const imported = await wire(
      server.url,
      '/v1/saved-projects/e2e-phone/captures?projectRevision=0',
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'model/vnd.usdz+zip',
          'if-match': etag,
        },
        body: usdzBytes,
      }
    );
    assert.equal(imported.status, 201, imported.bytes.toString());
    const { captureId } = JSON.parse(imported.bytes.toString());
    assert.match(captureId, /^[0-9a-f-]{36}$/i);
    await waitCompanionSlot(server.url, authHeaders);

    const bindingPath = join(root, 'captures', captureId, 'binding.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(binding.capture.provenance.unitsAuthored, true);
    assert.equal(binding.capture.evidence.physicalFit, 'unknown');

    const stillBase = `/v1/saved-projects/e2e-phone/captures/${captureId}/detail-stills`;
    const heicUpload = await wire(
      server.url,
      `${stillBase}?projectRevision=0&label=${encodeURIComponent('synthetic closeup')}`,
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'image/heic',
          'if-match': etag,
        },
        body: heicBytes,
      }
    );
    assert.equal(heicUpload.status, 201, heicUpload.bytes.toString());
    const { still: heicStill } = JSON.parse(heicUpload.bytes.toString());
    assert.equal(heicStill.mediaType, 'image/heic');
    assert.equal(heicStill.sha256, heicSha256);
    assert.equal(heicStill.sha256, sha(heicBytes));
    await waitCompanionSlot(server.url, authHeaders);

    const heicDownload = await wire(
      server.url,
      `${stillBase}/${heicStill.id}?projectRevision=0`,
      { headers: { ...authHeaders, 'if-match': etag } }
    );
    assert.equal(heicDownload.status, 200);
    assert.equal(heicDownload.headers['content-type'], 'image/heic');
    assert.equal(heicDownload.headers['x-content-sha256'], heicSha256);
    assert.deepEqual(heicDownload.bytes, heicBytes);

    const heicStillPath = join(
      root,
      'captures',
      captureId,
      'detail-stills',
      `${heicStill.id}.img`
    );
    await access(heicStillPath);

    const scanBase = `/v1/saved-projects/e2e-phone/captures/${captureId}/scan-processing`;
    const queued = await wire(server.url, `${scanBase}?projectRevision=0`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        'if-match': etag,
      },
      body: '{}',
    });
    assert.equal(queued.status, 202, queued.bytes.toString());
    const { job } = JSON.parse(queued.bytes.toString());
    assert.match(job.jobId, /^[0-9a-f-]{36}$/i);
    // BE-2: the import already started this job; the POST dedupes onto it,
    // so it may be queued or already running rather than freshly queued.
    assert(['queued', 'running'].includes(job.status), job.status);
    assert.equal(job.trigger, 'capture-import');

    await scanProcessing.wait();
    await waitCompanionSlot(server.url, authHeaders);

    const status = await wire(
      server.url,
      `${scanBase}/${job.jobId}?projectRevision=0`,
      { headers: { ...authHeaders, 'if-match': etag } }
    );
    assert.equal(status.status, 200, status.bytes.toString());
    const savedJob = JSON.parse(status.bytes.toString()).job;
    assert.equal(savedJob.status, 'succeeded');
    assert.equal(savedJob.previewOnly, true);
    assert.equal(savedJob.stages.length, 3);
    assert.deepEqual(
      savedJob.stages.map((s) => s.kind),
      ['repair', 'measure', 'render']
    );
    assert(savedJob.stages.every((s) => s.status === 'succeeded'));
    assert.equal(Object.keys(savedJob.artifacts ?? {}).length, 13);
    for (const view of SCAN_VIEW_NAMES) {
      assert(savedJob.artifacts[view], view);
    }

    const repairedObj = await wire(
      server.url,
      `${scanBase}/${job.jobId}/artifacts/repaired.obj?projectRevision=0`,
      { headers: { ...authHeaders, 'if-match': etag } }
    );
    assert.equal(repairedObj.status, 200);
    assert.equal(repairedObj.headers['x-content-sha256'], sha(repairedObj.bytes));
    assert(repairedObj.bytes.length > 0);

    const toolOut = join(root, 'tool-stages');
    await rm(toolOut, { recursive: true, force: true });

    const adviseStdout = await runPython([
      scanCorrectTool,
      'advise',
      join(root, 'captures', captureId, 'scan-processing', job.jobId, 'repaired.obj'),
      '--units',
      'mm',
      '--out',
      join(toolOut, 'advise'),
      '--max-targets',
      '2',
      '--resolution',
      '64',
    ]);
    const adviseReport = JSON.parse(adviseStdout);
    assert.ok(adviseReport.closeupAdvice);
    assert.ok(Array.isArray(adviseReport.closeupAdvice.targets));
    assert.equal(
      (await readFile(join(toolOut, 'advise', 'advice.json'), 'utf8')).length > 10,
      true
    );

    const scriptPath = join(toolOut, 'scripted-model.json');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(
        scriptPath,
        JSON.stringify([{ name: 'measure', arguments: {} }])
      )
    );
    const correctStdout = await runPython([
      scanCorrectTool,
      'run',
      join(root, 'captures', captureId, 'scan-processing', job.jobId, 'repaired.obj'),
      '--units',
      'mm',
      '--out',
      join(toolOut, 'correct'),
      '--adapter',
      'scripted',
      '--script',
      scriptPath,
      '--still',
      heicStillPath,
      '--max-steps',
      '4',
      '--max-seconds',
      '120',
    ]);
    const correctReport = JSON.parse(correctStdout);
    assert.equal(correctReport.status, 'complete');
    assert.ok(correctReport.final?.boxExtentsMm?.length === 3);
    assert.equal(correctReport.detailStills?.length, 1);
    assert.equal(correctReport.detailStills[0].sourceMediaType, 'image/heic');
    await access(join(toolOut, 'correct', 'corrected.stl'));
  }
);

test(
  'printer handoff package to fixture MCP server',
  {
    skip:
      'KAN-120 (Muse): printer handoff package not on main. KAN-132 (Muse): companion handoff route wiring not on main. TODO: import deliverPrintHandoff and POST corrected mesh to fake-printer-mcp fixture.',
  },
  async (t) => {
    const fixture = await startFakePrinterMcp();
    t.after(() => fixture.close());
    assert.ok(fixture.url);
  }
);
