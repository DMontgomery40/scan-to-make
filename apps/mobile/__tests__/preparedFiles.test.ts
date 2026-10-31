import { createHash } from 'node:crypto';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  PreparedFilesClient,
  preparedError,
  validatePreparedResponse,
  type PreparedNative,
} from '../src/prepared/preparedFiles';
const hash = async (text: string) =>
  createHash('sha256').update(text).digest('hex');
const fit = require('../../../packages/contracts/fixtures/tapered-holder.json');
async function fixture() {
  const records = new Map<string, string>();
  const repo = createSavedProjects({
    listIds: async () => [...records.keys()],
    read: async id => records.get(id) ?? null,
    compareAndSwap: async (id, old, next) => {
      if ((records.get(id) ?? null) !== old) return false;
      records.set(id, next);
      return true;
    },
  });
  await repo.create({
    id: fit.id,
    brief: { object: 'Fixture', context: 'Test', addition: 'Holder' },
    fit,
  });
  const artifact = {
    sha256: await hash('synthetic'),
    mediaType: 'model/stl',
    byteLength: 9,
  };
  await repo.change(fit.id, 0, {
    kind: 'attach-preview',
    sourceFit: fit,
    artifact,
  });
  const accepted = await repo.change(fit.id, 1, {
    kind: 'accept-preview',
    sourceFit: fit,
    artifact,
  });
  if (accepted.status !== 'ok') throw Error();
  const project = accepted.project,
    id = 'cfde3dd6-4e26-4aa2-bdf7-740d6f85b9db';
  const printable = { ...artifact, mediaType: 'model/3mf' };
  const selection = {
    printerId: 'fixture',
    model: 'p1s',
    plateIndex: 0,
    nozzleDiameters: [0.4],
    bedType: 'textured_plate',
    materials: [{ projectSlot: 0, material: 'PLA', physicalTray: 254 }],
    slicerSettingsSha256: await hash('{"fixtureSettings":true}'),
  };
  const body = {
    formatVersion: '0.1.0',
    id,
    projectId: project.id,
    projectRevision: project.revision,
    designArtifact: artifact,
    printableArtifact: printable,
    selection,
    inspection: {
      receipt: {
        receipt_version: '1',
        evidence: 'file-only',
        dispatch_authorized: false,
        artifact: {
          sha256: printable.sha256,
          byte_length: 9,
          file_format: '3mf',
        },
        selection: {
          bambu_model: 'p1s',
          plate_index: 0,
          nozzle_diameters: [0.4],
          bed_type: 'textured_plate',
        },
        inspection: {
          model: 'p1s',
          nozzleDiameters: [0.4],
          materials: ['PLA'],
          usedFilamentPositions: [0],
          plateInternalPath: 'Metadata/plate_1.gcode',
          sha256: printable.sha256,
          maxNozzleTemperature: 220,
          maxBedTemperature: 60,
          maxChamberTemperature: 0,
          bedType: 'textured pei plate',
          selectsAms: false,
        },
      },
      catalogSha256: await hash('fixture catalog'),
      server: { name: 'fixture', version: '1' },
    },
  };
  const response = {
    jobId: id,
    job: { ...body, sha256: await hash(JSON.stringify(body)) },
    intent: null,
  };
  const ack = {
    snapshot: JSON.stringify(project),
    etag: '"' + (await hash(JSON.stringify(project))) + '"',
  };
  const native: PreparedNative = {
    context: async () => 'https://fixture.ts.net|device',
    hash,
    request: jest.fn(async o => ({
      status: 200,
      etag: ack.etag,
      body: JSON.stringify(response),
      ...(o.artifact ? { file: o.artifact } : {}),
    })),
    export: jest.fn(async file => ({ ...file, path: '/isolated/export.3mf' })),
    cancel: async () => {},
  };
  return {
    repo,
    project,
    id,
    response,
    native,
    ack,
    client: new PreparedFilesClient(repo, native, async () => {}),
  };
}
test('complete job reopens and exports only the verified printable identity', async () => {
  const f = await fixture();
  expect((await f.client.open(f.project.id, f.id, f.ack)).job.id).toBe(f.id);
  expect((await f.client.export(f.project.id, f.id, f.ack)).sha256).toBe(
    f.response.job.printableArtifact.sha256,
  );
});
test('different project, revision, accepted design or job ID rejects', async () => {
  const f = await fixture();
  for (const change of [
    { projectId: 'other' },
    { projectRevision: 4 },
    {
      designArtifact: {
        ...f.response.job.designArtifact,
        sha256: '0'.repeat(64),
      },
    },
    { id: 'cfde3dd6-4e26-4aa2-bdf7-740d6f85b9dc' },
  ]) {
    const { sha256: _sha256, ...body } = { ...f.response.job, ...change };
    expect(_sha256).toHaveLength(64);
    const changed = {
      ...f.response,
      job: { ...body, sha256: await hash(JSON.stringify(body)) },
    };
    await expect(
      validatePreparedResponse(changed, f.project, f.id, hash),
    ).rejects.toThrow();
  }
});
test('tampered digest and self-consistent but mismatched inspection reject', async () => {
  const f = await fixture();
  f.response.job.sha256 = '0'.repeat(64);
  await expect(
    validatePreparedResponse(f.response, f.project, f.id, hash),
  ).rejects.toThrow();
  const { sha256: _sha256, ...body } = f.response.job;
  expect(_sha256).toHaveLength(64);
  body.inspection.receipt.inspection.model = 'a1';
  f.response.job.sha256 = await hash(JSON.stringify(body));
  await expect(
    validatePreparedResponse(f.response, f.project, f.id, hash),
  ).rejects.toThrow();
});
test('delayed response cannot export after local edits', async () => {
  const f = await fixture();
  f.native.request = jest.fn(async () => {
    await f.repo.change(f.project.id, f.project.revision, {
      kind: 'replace-brief',
      brief: { object: 'New', context: 'Kept', addition: 'Local' },
    });
    return { status: 200, etag: f.ack.etag, body: JSON.stringify(f.response) };
  });
  await expect(f.client.export(f.project.id, f.id, f.ack)).rejects.toThrow(
    'Project changed',
  );
  expect(f.native.export).not.toHaveBeenCalled();
});
test('revoked response, wrong ETag and changed pairing fail closed', async () => {
  for (const status of [401, 403, 412]) {
    const f = await fixture();
    f.native.request = jest.fn(async () => ({
      status,
      etag: f.ack.etag,
      body: '',
    }));
    await expect(f.client.open(f.project.id, f.id, f.ack)).rejects.toThrow();
  }
  const f = await fixture();
  f.native.request = jest.fn(async () => ({
    status: 200,
    etag: '"' + '0'.repeat(64) + '"',
    body: JSON.stringify(f.response),
  }));
  await expect(f.client.open(f.project.id, f.id, f.ack)).rejects.toThrow();
  const g = await fixture();
  g.native.context = jest
    .fn()
    .mockResolvedValueOnce('old')
    .mockResolvedValue('new');
  await expect(g.client.open(g.project.id, g.id, g.ack)).rejects.toThrow(
    'connection changed',
  );
});
test('only explicit GET busy responses retry, with a fixed bound', async () => {
  const f = await fixture();
  f.native.request = jest.fn(async () => ({ status: 429, etag: '', body: '' }));
  await expect(f.client.open(f.project.id, f.id, f.ack)).rejects.toThrow();
  expect(f.native.request).toHaveBeenCalledTimes(3);
});

const runtimeFixture = process.env.NATIVE_PREPARED_CONTRACT;
(runtimeFixture ? test : test.skip)(
  'actual native fixture GET payloads validate against their exact portable project',
  async () => {
    const data = JSON.parse(
      require('node:fs').readFileSync(runtimeFixture!, 'utf8'),
    );
    for (const result of data.jobs) {
      expect(
        (
          await validatePreparedResponse(
            { ...result, intent: null },
            data.project,
            result.jobId,
            hash,
          )
        ).id,
      ).toBe(result.jobId);
    }
  },
);

test('discovery accepts an empty page with continuation and rejects unverified semantics', async () => {
  const f = await fixture();
  f.native.request = jest.fn(async () => ({
    status: 200,
    etag: f.ack.etag,
    body: JSON.stringify({
      jobs: [],
      nextCursor: 'opaque_next',
      unreadable: 2,
      requiresVerifiedGet: true,
    }),
  }));
  expect(await f.client.list(f.project.id, f.ack)).toMatchObject({
    jobs: [],
    nextCursor: 'opaque_next',
    unreadable: 2,
  });
  f.native.request = jest.fn(async () => ({
    status: 200,
    etag: f.ack.etag,
    body: JSON.stringify({
      jobs: [],
      nextCursor: null,
      unreadable: 0,
      requiresVerifiedGet: false,
    }),
  }));
  await expect(f.client.list(f.project.id, f.ack)).rejects.toThrow();
});
test('discovery preserves cursor-stale and rejects changed local state', async () => {
  const f = await fixture();
  f.native.request = jest.fn(async () => ({
    status: 409,
    etag: '',
    body: JSON.stringify({
      error: { code: 'cursor-stale', message: 'cursor-stale' },
    }),
  }));
  await expect(
    f.client.list(f.project.id, f.ack, 'opaque'),
  ).rejects.toMatchObject({ code: 'cursor-stale' });
  f.native.request = jest.fn(async () => {
    await f.repo.change(f.project.id, f.project.revision, {
      kind: 'replace-brief',
      brief: { object: 'New', context: 'Kept', addition: 'Local' },
    });
    return {
      status: 200,
      etag: f.ack.etag,
      body: JSON.stringify({
        jobs: [],
        nextCursor: null,
        unreadable: 0,
        requiresVerifiedGet: true,
      }),
    };
  });
  await expect(f.client.list(f.project.id, f.ack)).rejects.toThrow(
    'Project changed',
  );
});
test('verified detail and export must match the selected discovery handle', async () => {
  const f = await fixture();
  const summary = {
    jobId: f.id,
    jobSha256: '0'.repeat(64),
    printableArtifact: f.response.job.printableArtifact,
    model: 'p1s',
    plateIndex: 0,
  };
  await expect(
    f.client.open(f.project.id, f.id, f.ack, summary),
  ).rejects.toThrow('Refresh');
  await expect(
    f.client.export(f.project.id, f.id, f.ack, summary),
  ).rejects.toThrow('Refresh');
  expect(f.native.export).not.toHaveBeenCalled();
});

test('snapshot permission errors explain project access in the inspected-files flow', () => {
  expect(
    preparedError(
      Error(
        'This connection does not have capture permission. Connect with a capture invitation.',
      ),
    ),
  ).toBe(
    'This connection cannot synchronize saved projects. Connect with project access, then refresh.',
  );
  expect(preparedError(new SyntaxError('private response bytes'))).toBe(
    'The companion returned an unreadable file record. Try refreshing.',
  );
});

async function producedFixture() {
  const f = await fixture();
  const job = JSON.parse(JSON.stringify(f.response.job));
  job.printableArtifact.mediaType = 'text/x.gcode';
  job.inspection.receipt.artifact.file_format = 'gcode';
  delete job.inspection.receipt.inspection.plateInternalPath;
  job.production = {
    requestSha256: '1'.repeat(64),
    producerIdentity: '2'.repeat(64),
    sourceArtifact: job.designArtifact,
    settingsArtifact: {
      sha256: job.selection.slicerSettingsSha256,
      mediaType: 'application/json',
      byteLength: 42,
    },
    manifestArtifact: {
      sha256: '3'.repeat(64),
      mediaType: 'application/json',
      byteLength: 50,
    },
    slicer: { version: '02.08.02.61', binarySha256: '4'.repeat(64) },
  };
  const body = Object.fromEntries(
    Object.entries(job).filter(([key]) => key !== 'sha256'),
  );
  job.sha256 = await hash(JSON.stringify(body));
  return { ...f, job };
}
test('produced metadata verifies in canonical digest order and preserves retained settings identity', async () => {
  const f = await producedFixture();
  expect(
    await validatePreparedResponse(
      { jobId: f.id, job: f.job },
      f.project,
      f.id,
      hash,
    ),
  ).toMatchObject({ production: f.job.production });
});
test('gated production records validate with the sealed printability verdict', async () => {
  const f = await producedFixture();
  f.job.production.printability = {
    profileId: 'p1s-04',
    verdict: 'printable-with-supports',
    allowSupports: true,
    reportArtifact: {
      sha256: '5'.repeat(64),
      mediaType: 'application/json',
      byteLength: 123,
    },
  };
  const body = Object.fromEntries(
    Object.entries(f.job).filter(([key]) => key !== 'sha256'),
  );
  f.job.sha256 = await hash(JSON.stringify(body));
  expect(
    await validatePreparedResponse(
      { jobId: f.id, job: f.job },
      f.project,
      f.id,
      hash,
    ),
  ).toMatchObject({
    production: { printability: f.job.production.printability },
  });
});
test('self-consistent produced metadata cannot substitute source/settings or exceed bounds', async () => {
  const f = await producedFixture();
  const changes = [
    (j: any) => (j.production.sourceArtifact.sha256 = '9'.repeat(64)),
    (j: any) => (j.production.settingsArtifact.sha256 = '9'.repeat(64)),
    (j: any) =>
      (j.production.settingsArtifact.byteLength = 8 * 1024 * 1024 + 1),
    (j: any) => (j.production.sourceArtifact.byteLength = 0),
    (j: any) => (j.production.manifestArtifact.mediaType = 'text/plain'),
    (j: any) => (j.production.slicer.version = 'x'.repeat(129)),
    (j: any) => (j.production.extra = 'unknown'),
    (j: any) => (j.printableArtifact.mediaType = 'model/3mf'),
  ];
  for (const change of changes) {
    const job = JSON.parse(JSON.stringify(f.job));
    change(job);
    const body = Object.fromEntries(
      Object.entries(job).filter(([key]) => key !== 'sha256'),
    );
    job.sha256 = await hash(JSON.stringify(body));
    await expect(
      validatePreparedResponse({ jobId: f.id, job }, f.project, f.id, hash),
    ).rejects.toThrow();
  }
});
test('discovery opts into production and falls back only once on an explicit first-page unsupported query', async () => {
  const f = await fixture(),
    paths: string[] = [];
  f.native.request = async o => {
    paths.push(o.path);
    return o.path.includes('productionVersion=1')
      ? { status: 400, etag: '', body: '{"error":{"code":"invalid-request"}}' }
      : {
          status: 200,
          etag: f.ack.etag,
          body: '{"jobs":[],"nextCursor":"next","unreadable":0,"requiresVerifiedGet":true}',
        };
  };
  const first = await f.client.list(f.project.id, f.ack);
  expect(paths).toHaveLength(2);
  expect(paths[0]).toContain('&limit=20&productionVersion=1');
  expect(paths[1]).not.toContain('productionVersion');
  expect(first.mode).toBe('legacy');
  await f.client.list(f.project.id, f.ack, 'page2', first.mode);
  expect(paths[2]).toContain('&limit=20&cursor=page2');
});
test('discovery never downgrades auth, stale, malformed success or a pagination failure', async () => {
  for (const response of [
    { status: 403, etag: '', body: '{"error":{"code":"invalid-request"}}' },
    { status: 412, etag: '', body: '{}' },
    { status: 400, etag: '', body: '{"error":{"code":"unavailable"}}' },
    { status: 200, etag: 'wrong', body: '{}' },
    { status: 200, etag: 'current', body: 'not-json' },
    {
      status: 200,
      etag: 'current',
      body: '{"error":{"code":"invalid-request"}}',
    },
  ]) {
    const f = await fixture();
    let calls = 0;
    f.native.request = async () => {
      calls++;
      return {
        ...response,
        etag: response.etag === 'current' ? f.ack.etag : response.etag,
      };
    };
    await expect(f.client.list(f.project.id, f.ack)).rejects.toThrow();
    expect(calls).toBe(1);
  }
  const f = await fixture();
  let calls = 0;
  f.native.request = async () => {
    calls++;
    return {
      status: 400,
      etag: '',
      body: '{"error":{"code":"invalid-request"}}',
    };
  };
  await expect(
    f.client.list(f.project.id, f.ack, 'next', 'production-v1'),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test('an unsupported first page never loops compatibility retries', async () => {
  const f = await fixture();
  let calls = 0;
  f.native.request = async () => {
    calls++;
    return {
      status: 400,
      etag: '',
      body: '{"error":{"code":"invalid-request"}}',
    };
  };
  await expect(f.client.list(f.project.id, f.ack)).rejects.toThrow();
  expect(calls).toBe(2);
});

const productionProfile = {
  id: 'p1s-04',
  bambuModel: 'p1s',
  displayName: 'Bambu P1S 0.4',
  bedMm: { x: 256, y: 256 },
  excludeZonesMm: [],
  nozzleDiameterMm: 0.4,
  nozzleCount: 1,
  nozzleType: 'stainless_steel',
  bedType: 'textured_plate',
};
const summary = {
  verdict: 'printable' as const,
  reasonCodes: [],
  reasons: [],
  warnings: [],
  profile: productionProfile,
};
function runningView(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    jobId: f.id,
    status: 'running' as const,
    profile: {
      displayName: 'Bambu P1S',
      nozzleDiameterMm: 0.4,
      bedType: 'textured_plate',
    },
  };
}
test('startProduction streams the accepted STL identity, flags supports, and never retries an ambiguous transport', async () => {
  const f = await fixture();
  const seen: unknown[] = [];
  f.native.request = jest.fn(async o => {
    seen.push(o);
    return {
      status: 202,
      etag: f.ack.etag,
      body: JSON.stringify({ production: runningView(f) }),
    };
  });
  const view = await f.client.startProduction(f.project.id, f.ack, {
    jobId: f.id,
    allowSupports: true,
  });
  expect(view.status).toBe('running');
  const sent = seen[0] as {
    method: string;
    path: string;
    source: { mediaType: string };
  };
  expect(sent.method).toBe('POST');
  expect(sent.path).toContain(`/prepared-jobs/${f.id}/production?`);
  expect(sent.path).toContain('&allowSupports=1');
  expect(sent.source).toMatchObject({ mediaType: 'model/stl' });
  // A transport failure may hide a started production: surface ambiguity
  // and never reissue the mutation.
  let calls = 0;
  f.native.request = jest.fn(async () => {
    calls++;
    throw Error('connection lost');
  });
  await expect(
    f.client.startProduction(f.project.id, f.ack, { jobId: f.id }),
  ).rejects.toMatchObject({ code: 'production-ambiguous' });
  expect(calls).toBe(1);
});
test('productionStatus parses the finished view with printability and job identity', async () => {
  const f = await fixture();
  const succeeded = {
    jobId: f.id,
    status: 'succeeded' as const,
    job: {
      jobId: f.id,
      jobSha256: f.response.job.sha256,
      printableArtifact: f.response.job.printableArtifact,
      selection: f.response.job.selection,
    },
    printability: summary,
    profile: runningView(f).profile,
  };
  f.native.request = jest.fn(async () => ({
    status: 200,
    etag: f.ack.etag,
    body: JSON.stringify({ production: succeeded }),
  }));
  const view = await f.client.productionStatus(f.project.id, f.id, f.ack);
  expect(view.job?.jobSha256).toBe(f.response.job.sha256);
  expect(view.printability?.verdict).toBe('printable');
  // A view for a different job is an identity mismatch, not a fallback.
  f.native.request = jest.fn(async () => ({
    status: 200,
    etag: f.ack.etag,
    body: JSON.stringify({
      production: {
        ...succeeded,
        jobId: 'cfde3dd6-4e26-4aa2-bdf7-740d6f85b9dc',
      },
    }),
  }));
  await expect(
    f.client.productionStatus(f.project.id, f.id, f.ack),
  ).rejects.toThrow('Production identity mismatch');
});
test('claimIntent sends only the job digest and confirmation; approval errors keep their codes', async () => {
  const f = await fixture();
  const seen: unknown[] = [];
  f.native.request = jest.fn(async o => {
    seen.push(o);
    return {
      status: 201,
      etag: f.ack.etag,
      body: JSON.stringify({
        intent: {
          kind: 'intent',
          intentId: f.id,
          jobId: f.id,
          jobSha256: f.response.job.sha256,
          atMs: 1_790_000_000_000,
          approval: {
            jobSha256: f.response.job.sha256,
            actorId: 'cfde3dd6-4e26-4aa2-bdf7-740d6f85b9db',
            confirmed: true,
            expiresAtMs: 1_790_000_300_000,
          },
        },
      }),
    };
  });
  const intent = await f.client.claimIntent(
    f.project.id,
    f.id,
    f.ack,
    f.response.job.sha256,
  );
  expect(intent.intentId).toBe(f.id);
  expect(JSON.parse((seen[0] as { body: string }).body)).toEqual({
    jobSha256: f.response.job.sha256,
    confirmed: true,
  });
  for (const [status, code] of [
    [409, 'already-approved'],
    [409, 'approval-expired'],
    [404, 'not-available'],
  ] as const) {
    f.native.request = jest.fn(async () => ({
      status,
      etag: f.ack.etag,
      body: JSON.stringify({ error: { code } }),
    }));
    await expect(
      f.client.claimIntent(f.project.id, f.id, f.ack, f.response.job.sha256),
    ).rejects.toMatchObject({ code });
  }
  // Transport ambiguity never replays an approval.
  f.native.request = jest.fn(async () => {
    throw Error('connection lost');
  });
  await expect(
    f.client.claimIntent(f.project.id, f.id, f.ack, f.response.job.sha256),
  ).rejects.toMatchObject({ code: 'ambiguous-intent' });
});
test('attemptStatus reports approval with no linked dispatch, and printability failures carry the summary', async () => {
  const f = await fixture();
  f.native.request = jest.fn(async o => {
    if (o.path.includes('/attempt?'))
      return {
        status: 200,
        etag: f.ack.etag,
        body: JSON.stringify({
          attempt: {
            jobId: f.id,
            intent: { intentId: f.id, atMs: 1_790_000_000_000 },
            linkedAttempt: null,
          },
        }),
      };
    return {
      status: 422,
      etag: f.ack.etag,
      body: JSON.stringify({
        error: {
          code: 'printability-failed',
          printability: {
            ...summary,
            verdict: 'not-printable',
            reasonCodes: ['overhang'],
          },
        },
      }),
    };
  });
  const attempt = await f.client.attemptStatus(f.project.id, f.id, f.ack);
  expect(attempt.linkedAttempt).toBeNull();
  expect(attempt.intent?.intentId).toBe(f.id);
  await expect(
    f.client.startProduction(f.project.id, f.ack, { jobId: f.id }),
  ).rejects.toMatchObject({
    code: 'printability-failed',
    printability: { verdict: 'not-printable' },
  });
  expect(
    preparedError(Object.assign(Error('x'), { code: 'supports-required' })),
  ).toContain('needs supports');
});
