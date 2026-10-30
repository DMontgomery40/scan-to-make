import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  ScanProcessingClient,
  type ScanProcessingNative,
  type ScanProcessingJob,
} from '../src/processing/scanProcessing';

const captureId = '11111111-1111-4111-8111-111111111111';
const jobId = '44444444-4444-4444-8444-444444444444';
const etag = '"' + 'a'.repeat(64) + '"';
const repairParams = {
  weldMm: 0.01,
  componentFraction: 0.01,
  componentMetric: 'area',
  holeMaxEdges: 0,
  voxelSizeMm: 0.3,
  forceVoxel: false,
  denoiseIterations: 1,
  denoiseFactor: 0.1,
  denoiseMaxMm: 0.05,
  sharpAngleDeg: 30,
  deviationSamples: 10000,
};
function stages(status: string) {
  return [
    { kind: 'repair', status, params: repairParams },
    { kind: 'measure', status, params: { units: 'mm' } },
    { kind: 'render', status, params: { units: 'mm', resolution: 512 } },
  ];
}
function job(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'scan-to-make.scan-processing/0.1',
    jobId,
    projectId: 'one',
    captureId,
    projectRevision: 0,
    status: 'queued',
    previewOnly: true,
    stages: stages('queued'),
    ...overrides,
  };
}
function succeededJob() {
  const ref = (mediaType: string) => ({
    sha256: 'c'.repeat(64),
    byteLength: 100,
    mediaType,
  });
  const artifacts: Record<string, unknown> = {
    'repaired.stl': ref('model/stl'),
    'repaired.obj': ref('model/obj'),
    'report.json': ref('application/json'),
  };
  for (const name of [
    'pos_x.png',
    'pos_y.png',
    'pos_z.png',
    'neg_x.png',
    'neg_y.png',
    'neg_z.png',
    'iso_pp.png',
    'iso_np.png',
    'iso_nn.png',
    'iso_pn.png',
  ])
    artifacts[name] = ref('image/png');
  return job({
    status: 'succeeded',
    stages: stages('succeeded'),
    measuredPrincipalExtentsMm: [60, 45, 21],
    artifacts,
  });
}
function harness() {
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
  const native: ScanProcessingNative = {
    context: async () => 'host/device',
    request: jest.fn(async () => ({ status: 404, body: '', etag: '' })),
    present: jest.fn(),
    cancel: jest.fn(),
  };
  const client = new ScanProcessingClient(repo, native, async () => {});
  const create = async () => {
    const r = await repo.create({
      id: 'one',
      brief: { object: 'Mug', context: 'Desk', addition: 'Handle' },
      fit: null,
    });
    if (r.status !== 'ok') throw Error();
    return { etag, snapshot: JSON.stringify(r.project) };
  };
  return { repo, native, client, create };
}
const calls = (h: ReturnType<typeof harness>) =>
  (h.native.request as jest.Mock).mock.calls.map(([o]) => o);

test('start posts an empty JSON request and returns the queued job', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 202,
    body: JSON.stringify({ job: job() }),
    etag,
  }));
  const result = await h.client.start('one', captureId, ack);
  expect(result.jobId).toBe(jobId);
  expect(result.status).toBe('queued');
  expect(calls(h)).toEqual([
    {
      context: 'host/device',
      method: 'POST',
      path: `/v1/saved-projects/one/captures/${captureId}/scan-processing?projectRevision=0`,
      etag,
      body: '{}',
    },
  ]);
});

test('start sends reference dimensions and requires the job to echo them', async () => {
  const h = harness();
  const ack = await h.create();
  const reference = {
    dimensionsMm: [60.6, 45.2, 21.7] as const,
    source: 'Manufacturer published spec',
  };
  h.native.request = jest.fn(async () => ({
    status: 202,
    body: JSON.stringify({ job: job({ reference }) }),
    etag,
  }));
  await h.client.start('one', captureId, ack, { ...reference, dimensionsMm: [60.6, 45.2, 21.7] });
  expect(JSON.parse(calls(h)[0].body)).toEqual({ reference });
  h.native.request = jest.fn(async () => ({
    status: 202,
    body: JSON.stringify({ job: job() }),
    etag,
  }));
  await expect(
    h.client.start('one', captureId, ack, {
      dimensionsMm: [60.6, 45.2, 21.7],
    }),
  ).rejects.toThrow('reference mismatch');
});

test('invalid reference dimensions reject before any request', async () => {
  const h = harness();
  const ack = await h.create();
  await expect(
    h.client.start('one', captureId, ack, {
      dimensionsMm: [0, 45.2, 21.7] as never,
    }),
  ).rejects.toThrow();
  expect(h.native.request).not.toHaveBeenCalled();
});

test('lost or 5xx start reply is ambiguous and never retried; busy is explicit', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => {
    throw Error('disconnected');
  });
  await expect(h.client.start('one', captureId, ack)).rejects.toMatchObject({
    code: 'ambiguous-start',
    message: expect.stringContaining('will not be retried automatically'),
  });
  expect(h.native.request).toHaveBeenCalledTimes(1);
  h.native.request = jest.fn(async () => ({ status: 503, body: '', etag }));
  await expect(h.client.start('one', captureId, ack)).rejects.toMatchObject({
    code: 'ambiguous-start',
    status: 503,
  });
  h.native.request = jest.fn(async () => ({ status: 429, body: '', etag }));
  await expect(h.client.start('one', captureId, ack)).rejects.toThrow('busy');
  expect(h.native.request).toHaveBeenCalledTimes(1);
});

test('listJobs recovers retained jobs after a relaunch and validates bindings', async () => {
  const h = harness();
  const ack = await h.create();
  const earlier = job({ jobId: '33333333-3333-4333-8333-333333333333' });
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({ jobs: [earlier, succeededJob()] }),
    etag,
  }));
  const jobs = await h.client.listJobs('one', captureId, ack);
  expect(jobs.map(j => j.jobId)).toEqual([earlier.jobId, jobId]);
  expect(calls(h)[0].path).toBe(
    `/v1/saved-projects/one/captures/${captureId}/scan-processing?projectRevision=0`,
  );
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      jobs: [job({ captureId: '55555555-5555-4555-8555-555555555555' })],
    }),
    etag,
  }));
  await expect(h.client.listJobs('one', captureId, ack)).rejects.toThrow(
    'different project version',
  );
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({ jobs: [succeededJob(), earlier] }),
    etag,
  }));
  await expect(h.client.listJobs('one', captureId, ack)).rejects.toThrow(
    'invalid scan job list',
  );
});

test('listJobs maps an older companion without the listing route to not-available', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({ status: 405, body: '', etag }));
  await expect(h.client.listJobs('one', captureId, ack)).rejects.toMatchObject(
    { code: 'not-available', status: 405 },
  );
});

test('imageUri resolves only verified PNG views through the transport', async () => {
  const h = harness();
  await h.create();
  const png = {
    sha256: 'c'.repeat(64),
    byteLength: 100,
    mediaType: 'image/png',
  };
  expect(await h.client.imageUri(png)).toBeNull();
  h.native.imageUri = jest.fn(
    async (f: typeof png) => `file:///private/${f.sha256}.png`,
  );
  expect(await h.client.imageUri(png)).toBe(
    `file:///private/${'c'.repeat(64)}.png`,
  );
  expect(
    await h.client.imageUri({ ...png, mediaType: 'model/stl' }),
  ).toBeNull();
  expect(h.native.imageUri).toHaveBeenCalledTimes(1);
  h.native.imageUri = jest.fn(async () => 'https://example.test/view.png');
  await expect(h.client.imageUri(png)).rejects.toThrow('display path');
});

test('status reads one job and rejects a job for another capture', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      job: job({ status: 'running', stages: stages('running') }),
    }),
    etag,
  }));
  expect((await h.client.status('one', captureId, ack, jobId)).status).toBe(
    'running',
  );
  expect(calls(h)[0].path).toBe(
    `/v1/saved-projects/one/captures/${captureId}/scan-processing/${jobId}?projectRevision=0`,
  );
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      job: job({ captureId: '55555555-5555-4555-8555-555555555555' }),
    }),
    etag,
  }));
  await expect(
    h.client.status('one', captureId, ack, jobId),
  ).rejects.toThrow('different project version');
  h.native.request = jest.fn(async () => ({ status: 404, body: '', etag }));
  await expect(
    h.client.status('one', captureId, ack, jobId),
  ).rejects.toThrow('no longer available');
});

test('cancel returns the terminal job; a lost reply is ambiguous', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      job: job({
        status: 'failed',
        failure: 'cancelled',
        stages: stages('failed'),
      }),
    }),
    etag,
  }));
  const result = await h.client.cancel('one', captureId, ack, jobId);
  expect(result.failure).toBe('cancelled');
  expect(calls(h)[0].method).toBe('DELETE');
  h.native.request = jest.fn(async () => {
    throw Error('disconnected');
  });
  await expect(
    h.client.cancel('one', captureId, ack, jobId),
  ).rejects.toMatchObject({ code: 'ambiguous-cancel' });
  expect(h.native.request).toHaveBeenCalledTimes(1);
});

test('artifact download verifies the sealed identity, including PNG views', async () => {
  const h = harness();
  const ack = await h.create();
  const done = succeededJob() as unknown as ScanProcessingJob;
  h.native.request = jest.fn(async o => ({
    status: 200,
    body: '',
    etag,
    file: o.artifact,
  }));
  const file = await h.client.downloadArtifact(
    'one',
    captureId,
    ack,
    done,
    'iso_pp.png',
  );
  expect(file.mediaType).toBe('image/png');
  expect(calls(h)[0].path).toBe(
    `/v1/saved-projects/one/captures/${captureId}/scan-processing/${jobId}/artifacts/iso_pp.png?projectRevision=0`,
  );
  await h.client.openArtifact('one', captureId, ack, done, 'repaired.stl', false);
  expect(h.native.present).toHaveBeenCalledWith(
    expect.objectContaining({ mediaType: 'model/stl' }),
    false,
  );
  h.native.request = jest.fn(async o => ({
    status: 200,
    body: '',
    etag,
    file: {
      sha256: o.artifact?.sha256 ?? '',
      byteLength: 101,
      mediaType: o.artifact?.mediaType ?? 'application/json',
    },
  }));
  await expect(
    h.client.downloadArtifact('one', captureId, ack, done, 'report.json'),
  ).rejects.toThrow('verification failed');
});

test('artifacts of an unfinished job are not downloadable', async () => {
  const h = harness();
  const ack = await h.create();
  await expect(
    h.client.downloadArtifact(
      'one',
      captureId,
      ack,
      job() as unknown as ScanProcessingJob,
      'pos_x.png',
    ),
  ).rejects.toThrow('not available yet');
  expect(h.native.request).not.toHaveBeenCalled();
});

test('a changed local project stops requests before they start', async () => {
  const h = harness();
  const ack = await h.create();
  await h.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { object: 'Mug', context: 'Desk', addition: 'Edited' },
  });
  await expect(h.client.start('one', captureId, ack)).rejects.toThrow(
    'Project changed',
  );
  expect(h.native.request).not.toHaveBeenCalled();
});
