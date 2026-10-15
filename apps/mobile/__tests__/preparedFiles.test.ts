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
