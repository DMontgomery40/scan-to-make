import { ObjectsClient, ObjectsError } from '../src/objects/client';
import type { ObjectsNative } from '../src/objects/native';

const id = '0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11';
const object = {
  id,
  createdAtMs: 1,
  updatedAtMs: 2,
  state: 'new',
  photos: [],
  passes: [],
};

function native(
  reply: (options: {
    method: string;
    path: string;
    json?: unknown;
  }) => { status: number; body: unknown } | Error,
) {
  const calls: Array<{ method: string; path: string; json?: unknown }> = [];
  const fake: ObjectsNative = {
    call: jest.fn(async options => {
      calls.push(options);
      const result = reply(options);
      if (result instanceof Error) throw result;
      return { status: result.status, body: JSON.stringify(result.body) };
    }),
    sendCapture: jest.fn(async () => ({ scanSent: true, photosSent: 24 })),
    pickPhotos: jest.fn(async () => ({ photosSent: 2 })),
    takePhoto: jest.fn(async () => ({ photosSent: 1 })),
    download: jest.fn(async () => ({ uri: 'file:///cache/front.png' })),
    showModel: jest.fn(async () => undefined),
  };
  return { fake, calls };
}
const coded = (code: string) => Object.assign(new Error(code), { code });

it('creates with the instructions exactly as written and lists newest first', async () => {
  const { fake, calls } = native(o =>
    o.method === 'POST'
      ? { status: 201, body: { object } }
      : { status: 200, body: { objects: [object] } },
  );
  const client = new ObjectsClient(fake);
  expect(
    (await client.create('A mount for this mic: https://example.com/mic')).id,
  ).toBe(id);
  expect(calls[0]).toEqual({
    method: 'POST',
    path: '/v1/objects',
    json: { instructions: 'A mount for this mic: https://example.com/mic' },
  });
  expect((await client.list()).map(o => o.id)).toEqual([id]);
  expect(calls[1]).toEqual({ method: 'GET', path: '/v1/objects' });
});

it('blank instructions are left out, so the touch-up makes a plain copy', async () => {
  const { fake, calls } = native(() => ({ status: 201, body: { object } }));
  await new ObjectsClient(fake).create('   ');
  expect(calls[0]).toEqual({ method: 'POST', path: '/v1/objects', json: {} });
});

it('every action goes to its own route', async () => {
  const { fake, calls } = native(() => ({ status: 200, body: { object } }));
  const client = new ObjectsClient(fake);
  await client.start(id);
  await client.correct(id, 'make it 2 mm thicker');
  await client.bestGuess(id);
  await client.sendCloseups(id);
  await client.print(id);
  await client.plateClear(id);
  expect(calls).toEqual([
    { method: 'POST', path: `/v1/objects/${id}/start` },
    {
      method: 'POST',
      path: `/v1/objects/${id}/corrections`,
      json: { note: 'make it 2 mm thicker' },
    },
    {
      method: 'POST',
      path: `/v1/objects/${id}/closeup`,
      json: { bestGuess: true },
    },
    {
      method: 'POST',
      path: `/v1/objects/${id}/closeup`,
      json: { bestGuess: false },
    },
    { method: 'POST', path: `/v1/objects/${id}/print` },
    { method: 'POST', path: `/v1/objects/${id}/plate`, json: { clear: true } },
  ]);
});

it('a capture is sent with its photos, then the touch-up starts', async () => {
  const { fake, calls } = native(() => ({ status: 200, body: { object } }));
  const client = new ObjectsClient(fake);
  await client.sendCapture(id, 'run-1');
  expect(fake.sendCapture).toHaveBeenCalledWith({
    objectId: id,
    runID: 'run-1',
    maxPhotos: 24,
  });
  expect(calls).toEqual([{ method: 'POST', path: `/v1/objects/${id}/start` }]);
});

it('a capture that sent nothing never starts an empty touch-up', async () => {
  const { fake, calls } = native(() => ({ status: 200, body: { object } }));
  (fake.sendCapture as jest.Mock).mockResolvedValueOnce({
    scanSent: false,
    photosSent: 0,
  });
  await expect(
    new ObjectsClient(fake).sendCapture(id, 'run-1'),
  ).rejects.toMatchObject({ kind: 'nothing-sent' });
  expect(calls).toEqual([]);
});

it('errors come back as one sentence the screen can show', async () => {
  const conflict = native(() => ({
    status: 409,
    body: {
      error: {
        code: 'invalid-state',
        message: 'Wait until the current step finishes.',
      },
    },
  }));
  await expect(
    new ObjectsClient(conflict.fake).print(id),
  ).rejects.toMatchObject({
    kind: 'conflict',
    message: 'Wait until the current step finishes.',
  });
  const pairing = native(() => coded('pairing-required'));
  await expect(new ObjectsClient(pairing.fake).list()).rejects.toMatchObject({
    kind: 'pairing',
  });
  const certificate = native(() => coded('certificate-changed'));
  await expect(
    new ObjectsClient(certificate.fake).list(),
  ).rejects.toMatchObject({ kind: 'pairing' });
  const offline = native(() => coded('offline'));
  const error = await new ObjectsClient(offline.fake).list().catch(e => e);
  expect(error).toBeInstanceOf(ObjectsError);
  expect(error.kind).toBe('unreachable');
  expect(error.message).toBe(
    "Your Mac isn't answering. Check it's on and awake, then try again.",
  );
  const missing = native(() => ({
    status: 404,
    body: { error: { code: 'not-found' } },
  }));
  await expect(new ObjectsClient(missing.fake).get(id)).rejects.toMatchObject({
    kind: 'not-found',
  });
  const off = native(() => ({
    status: 404,
    body: { error: { code: 'not-found' } },
  }));
  await expect(new ObjectsClient(off.fake).list()).rejects.toMatchObject({
    kind: 'not-set-up',
  });
});

it('renders download once per version and come back as file URIs', async () => {
  const { fake } = native(() => ({ status: 200, body: { object } }));
  const client = new ObjectsClient(fake);
  const uri = await client.renderUri(
    {
      ...object,
      state: 'ready',
      current: {
        model: 'current/model.stl',
        renders: ['current/renders/front.png'],
      },
    } as never,
    'current/renders/front.png',
  );
  expect(uri).toBe('file:///cache/front.png');
  expect(fake.download).toHaveBeenCalledWith({
    objectId: id,
    name: 'renders/front.png',
    version: 2,
  });
});
