import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  DetailStillsClient,
  type DetailStillNative,
} from '../src/stills/detailStills';

const captureId = '11111111-1111-4111-8111-111111111111';
const stillId = '22222222-2222-4222-8222-222222222222';
const etag = '"' + 'a'.repeat(64) + '"';
const source = {
  sha256: 'b'.repeat(64),
  byteLength: 50,
  mediaType: 'image/jpeg',
};
function still(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'scan-to-make.detail-still/0.1',
    id: stillId,
    projectId: 'one',
    captureId,
    projectRevision: 0,
    mediaType: 'image/jpeg',
    byteLength: 50,
    sha256: 'b'.repeat(64),
    ordinal: 0,
    ...overrides,
  };
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
  const native: DetailStillNative = {
    context: async () => 'host/device',
    request: jest.fn(async () => ({ status: 404, body: '', etag: '' })),
    present: jest.fn(),
    cancel: jest.fn(),
  };
  const client = new DetailStillsClient(repo, native, async () => {});
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

test('upload posts the exact source with If-Match ack and validates the returned still', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 201,
    body: JSON.stringify({ still: still({ label: 'USB-C port' }) }),
    etag,
  }));
  const result = await h.client.upload(
    'one',
    captureId,
    ack,
    source,
    'USB-C port',
  );
  expect(result.id).toBe(stillId);
  expect(calls(h)).toEqual([
    {
      context: 'host/device',
      method: 'POST',
      path: `/v1/saved-projects/one/captures/${captureId}/detail-stills?projectRevision=0&label=USB-C%20port`,
      etag,
      source,
    },
  ]);
});

test('lost upload reply is ambiguous and never retried', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => {
    throw Error('disconnected');
  });
  await expect(
    h.client.upload('one', captureId, ack, source),
  ).rejects.toMatchObject({
    code: 'ambiguous-upload',
    message: expect.stringContaining('will not be retried automatically'),
  });
  expect(h.native.request).toHaveBeenCalledTimes(1);
});

test('5xx upload reply is ambiguous; explicit still-limit and media rejections are not', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({ status: 503, body: '', etag }));
  await expect(
    h.client.upload('one', captureId, ack, source),
  ).rejects.toMatchObject({ code: 'ambiguous-upload', status: 503 });
  h.native.request = jest.fn(async () => ({
    status: 409,
    body: JSON.stringify({ error: { code: 'still-limit', message: 'x' } }),
    etag,
  }));
  await expect(
    h.client.upload('one', captureId, ack, source),
  ).rejects.toThrow('maximum number of detail photos');
  h.native.request = jest.fn();
  await expect(
    h.client.upload('one', captureId, ack, {
      ...source,
      mediaType: 'image/gif',
    }),
  ).rejects.toThrow('Only JPEG, HEIC or PNG');
  expect(h.native.request).not.toHaveBeenCalled();
});

test('upload rejects a still bound to another revision or with different bytes', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 201,
    body: JSON.stringify({ still: still({ projectRevision: 1 }) }),
    etag,
  }));
  await expect(
    h.client.upload('one', captureId, ack, source),
  ).rejects.toThrow('different project version');
  h.native.request = jest.fn(async () => ({
    status: 201,
    body: JSON.stringify({ still: still({ sha256: 'c'.repeat(64) }) }),
    etag,
  }));
  await expect(
    h.client.upload('one', captureId, ack, source),
  ).rejects.toThrow('identity mismatch');
});

test('list returns stills in order and retries explicit busy a bounded number of times', async () => {
  const h = harness();
  const ack = await h.create();
  let n = 0;
  h.native.request = jest.fn(async () =>
    ++n < 3
      ? { status: 429, body: '', etag }
      : {
          status: 200,
          body: JSON.stringify({ captureId, stills: [still()] }),
          etag,
        },
  );
  expect(await h.client.list('one', captureId, ack)).toHaveLength(1);
  expect(h.native.request).toHaveBeenCalledTimes(3);
  h.native.request = jest.fn(async () => ({ status: 429, body: '', etag }));
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow('busy');
  expect(h.native.request).toHaveBeenCalledTimes(3);
});

test('list rejects stills from another capture', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({
      captureId,
      stills: [still({ captureId: '33333333-3333-4333-8333-333333333333' })],
    }),
    etag,
  }));
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow();
});

test('download verifies exact bytes before presentation; mismatch never presents', async () => {
  const h = harness();
  const ack = await h.create();
  const record = still() as never;
  h.native.request = jest.fn(async o => ({
    status: 200,
    body: '',
    etag,
    file: o.artifact,
  }));
  await h.client.openFile('one', captureId, ack, record, true);
  expect(h.native.present).toHaveBeenCalledWith(source, true);
  expect(calls(h)[0].path).toBe(
    `/v1/saved-projects/one/captures/${captureId}/detail-stills/${stillId}?projectRevision=0`,
  );
  h.native.request = jest.fn(async o => ({
    status: 200,
    body: '',
    etag,
    file: {
      sha256: 'f'.repeat(64),
      byteLength: o.artifact?.byteLength ?? 0,
      mediaType: o.artifact?.mediaType ?? 'image/jpeg',
    },
  }));
  await expect(
    h.client.openFile('one', captureId, ack, record, true),
  ).rejects.toThrow('verification failed');
  expect(h.native.present).toHaveBeenCalledTimes(1);
});

test('remove deletes once; a lost reply is ambiguous, never retried', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({ captureId, stillId, deleted: true }),
    etag,
  }));
  await h.client.remove('one', captureId, ack, stillId);
  expect(calls(h)[0].method).toBe('DELETE');
  h.native.request = jest.fn(async () => {
    throw Error('disconnected');
  });
  await expect(
    h.client.remove('one', captureId, ack, stillId),
  ).rejects.toMatchObject({ code: 'ambiguous-delete' });
  expect(h.native.request).toHaveBeenCalledTimes(1);
});

test('a changed local project or pairing stops requests and results', async () => {
  const h = harness();
  const ack = await h.create();
  await h.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { object: 'Mug', context: 'Desk', addition: 'Edited' },
  });
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow(
    'Project changed',
  );
  expect(h.native.request).not.toHaveBeenCalled();
});

test('pairing change during a request discards the result', async () => {
  const h = harness();
  const ack = await h.create();
  let contexts = 0;
  h.native.context = async () => (++contexts === 1 ? 'host/device' : 'other');
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({ captureId, stills: [] }),
    etag,
  }));
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow(
    'Companion connection changed',
  );
});

test('revoked or wrong-scope credentials map to reconnection guidance', async () => {
  const h = harness();
  const ack = await h.create();
  h.native.request = jest.fn(async () => ({ status: 401, body: '', etag }));
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow(
    'expired or was revoked',
  );
  h.native.request = jest.fn(async () => ({ status: 403, body: '', etag }));
  await expect(h.client.list('one', captureId, ack)).rejects.toThrow(
    'capture permission',
  );
});
