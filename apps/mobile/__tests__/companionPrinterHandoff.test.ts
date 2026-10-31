import {
  companionPrinterHandoff,
  type PrinterHandoffNative,
} from '../src/printing/companionPrinterHandoff';
import { ackFor } from '../src/screens/testing/fakeScanServices';
import { HARDWARE_CONFIRMATION } from '../src/screens/testing/fakePrinterHandoff';

const ID = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607';
const Q = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const MODEL = { sha256: 'a'.repeat(64), byteLength: 2048, mediaType: 'model/stl', uri: 'file:///x' };
const manifest = { id: ID, backend: 'bambu-printer-mcp', status: 'ready', prompt: '' };

function native(replies: { status: number; body: unknown }[]) {
  const requests: Record<string, unknown>[] = [];
  const queue = [...replies];
  const bridge: PrinterHandoffNative = {
    context: async () => 'ctx',
    request: async options => {
      requests.push(options);
      const reply = queue.shift() ?? { status: 500, body: {} };
      return { status: reply.status, body: JSON.stringify(reply.body) };
    },
    cancel: async () => {},
  };
  return { bridge, requests };
}

test('create uploads exactly the verified model identity with the request and backend', async () => {
  const { bridge, requests } = native([{ status: 201, body: { bundle: { ...manifest, prompt: 'Add a base' } } }]);
  const handoff = await companionPrinterHandoff(bridge).create('p', 'c', ackFor(), {
    prompt: 'Add a base',
    backend: 'mcp-3d-printer-server',
    model: MODEL,
  });
  expect(requests[0]).toEqual({
    context: 'ctx',
    method: 'POST',
    path: '/v1/printer-handoff/bundles',
    source: { sha256: MODEL.sha256, byteLength: 2048, mediaType: 'model/stl' },
    prompt: 'Add a base',
    backend: 'mcp-3d-printer-server',
  });
  expect(handoff).toEqual({ id: ID, backend: 'bambu-printer-mcp', status: 'ready', prompt: 'Add a base' });
});

test('without a chosen backend the companion picks, and a missing route says to update it', async () => {
  const { bridge, requests } = native([{ status: 404, body: { error: { code: 'not-found' } } }]);
  await expect(
    companionPrinterHandoff(bridge).create('p', 'c', ackFor(), { prompt: '', backend: null, model: MODEL }),
  ).rejects.toMatchObject({ code: 'not-available', message: expect.stringContaining('Update it') });
  expect(requests[0]).not.toHaveProperty('backend');
});

test('status, print and the printer list read the companion’s routes', async () => {
  const { bridge, requests } = native([
    { status: 200, body: { bundle: { ...manifest, status: 'failed', failure: 'tool-failed' }, printing: false } },
    { status: 202, body: { bundleId: ID, printing: true } },
    { status: 200, body: { backends: ['bambu-printer-mcp', { backend: 'mcp-3d-printer-server', selection: { printerType: 'klipper' } }] } },
    { status: 404, body: { error: { code: 'not-found' } } },
    { status: 200, body: { elicitations: [] } },
    { status: 404, body: { error: { code: 'not-found' } } },
    { status: 404, body: { error: { code: 'not-found' } } },
  ]);
  const client = companionPrinterHandoff(bridge);
  expect(await client.status('p', 'c', ackFor(), ID)).toEqual({
    id: ID,
    backend: 'bambu-printer-mcp',
    status: 'failed',
    failure: 'tool-failed',
    printing: false,
  });
  await client.print(ID);
  expect(await client.backends(ackFor())).toEqual([
    { backend: 'bambu-printer-mcp' },
    { backend: 'mcp-3d-printer-server', selection: { printerType: 'klipper' } },
  ]);
  // A companion without the listing route runs its one configured server…
  expect(await client.backends(ackFor())).toBeNull();
  // …and one without the handoff routes can't print at all.
  await expect(client.backends(ackFor())).rejects.toMatchObject({ code: 'not-available' });
  expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([
    `GET /v1/printer-handoff/bundles/${ID}`,
    `POST /v1/printer-handoff/bundles/${ID}/print`,
    'GET /v1/printer-handoff/backends',
    'GET /v1/printer-handoff/backends',
    'GET /v1/printer-handoff/elicitations',
    'GET /v1/printer-handoff/backends',
    'GET /v1/printer-handoff/elicitations',
  ]);
});

test('confirmations keep a valid camera photo and drop anything else', async () => {
  const pending = {
    id: Q,
    mode: 'form',
    message: 'Confirm the print.',
    requestedSchema: HARDWARE_CONFIRMATION,
    createdAtMs: 1,
    expiresAtMs: 600001,
  };
  const { bridge } = native([
    { status: 200, body: { elicitations: [{ ...pending, cameraSnapshot: { format: 'jpeg', base64: '/9j/4A==', savedTo: '/tmp/x' } }] } },
    { status: 200, body: { elicitations: [{ ...pending, cameraSnapshot: { format: 'svg', base64: 'PHN2Zz4=' } }] } },
  ]);
  const client = companionPrinterHandoff(bridge);
  expect(await client.confirmations()).toEqual([
    {
      id: Q,
      mode: 'form',
      message: 'Confirm the print.',
      requestedSchema: HARDWARE_CONFIRMATION,
      cameraSnapshot: { mediaType: 'image/jpeg', base64: '/9j/4A==' },
      createdAtMs: 1,
      expiresAtMs: 600001,
    },
  ]);
  expect((await client.confirmations())[0]).not.toHaveProperty('cameraSnapshot');
});

test('answers go to the confirmation’s respond route as JSON', async () => {
  const { bridge, requests } = native([
    { status: 200, body: { id: Q, answered: true } },
    { status: 404, body: { error: { code: 'elicitation-not-pending' } } },
  ]);
  const client = companionPrinterHandoff(bridge);
  await client.answer(Q, { action: 'accept', content: { confirmed: true } });
  expect(requests[0]).toMatchObject({
    method: 'POST',
    path: `/v1/printer-handoff/elicitations/${Q}/respond`,
    body: '{"action":"accept","content":{"confirmed":true}}',
  });
  await expect(client.answer(Q, { action: 'decline' })).rejects.toMatchObject({
    status: 404,
    message: 'That question has already ended.',
  });
});

test('find matches a lost send by its model, request, backend and time', async () => {
  const at = 1_800_000_000_000;
  const bundle = (id: string, overrides: Record<string, unknown>) => ({
    ...manifest,
    id,
    createdAtMs: at,
    cleanStl: { file: 'clean.stl', sha256: MODEL.sha256, byteLength: 2048 },
    ...overrides,
  });
  const other = '0b1c2d3e-4f50-4a61-8b72-c3d4e5f60718';
  const { bridge, requests } = native([
    {
      status: 200,
      body: {
        bundles: [
          bundle(other, { cleanStl: { file: 'clean.stl', sha256: 'b'.repeat(64), byteLength: 1 } }),
          bundle(ID, {}),
          bundle(Q, { createdAtMs: at - 3_600_000 }),
        ],
      },
    },
    { status: 200, body: { bundles: [bundle(ID, { prompt: 'Add a base' })] } },
  ]);
  const client = companionPrinterHandoff(bridge);
  const lost = { startedAtMs: at, prompt: '', backend: 'bambu-printer-mcp' as const, model: MODEL.sha256 };
  expect(await client.find('p', 'c', ackFor(), lost)).toMatchObject({ id: ID, status: 'ready' });
  expect(await client.find('p', 'c', ackFor(), lost)).toBeNull();
  expect(requests[0]).toMatchObject({ method: 'GET', path: '/v1/printer-handoff/bundles' });
});

test('cancel reports whether the companion could stop the job', async () => {
  const { bridge } = native([
    { status: 200, body: {} },
    { status: 404, body: { error: { code: 'not-found' } } },
    { status: 409, body: { error: { code: 'print-busy' } } },
  ]);
  const client = companionPrinterHandoff(bridge);
  expect(await client.cancel(ID)).toBe(true);
  expect(await client.cancel(ID)).toBe(false);
  await expect(client.cancel(ID)).rejects.toMatchObject({ code: 'print-busy', status: 409 });
});

test('companion errors become plain messages, and malformed replies are refused', async () => {
  const { bridge } = native([
    { status: 409, body: { error: { code: 'print-busy' } } },
    { status: 403, body: {} },
    { status: 200, body: { bundle: { ...manifest, status: 'exploded' } } },
  ]);
  const client = companionPrinterHandoff(bridge);
  await expect(client.print(ID)).rejects.toThrow('already printing another job');
  await expect(client.print(ID)).rejects.toThrow('Scan a new QR code from your companion');
  await expect(client.status('p', 'c', ackFor(), ID)).rejects.toMatchObject({ code: 'invalid-response' });
});

// Codex P2 on #132: "Send again" within ten minutes, then a lost reply,
// must not take the earlier identical job for the new one.
test('a lost send matches only jobs that weren’t on the companion before it, whatever the clocks say', async () => {
  const at = 1_800_000_000_000;
  const earlier = '0b1c2d3e-4f50-4a61-8b72-c3d4e5f60718';
  const job = (id: string, createdAtMs: number) => ({
    ...manifest,
    id,
    status: 'printed',
    createdAtMs,
    cleanStl: { file: 'clean.stl', sha256: MODEL.sha256, byteLength: 2048 },
  });
  const { bridge } = native([
    { status: 200, body: { bundles: [job(earlier, at - 60_000)] } },
    { status: 200, body: { bundles: [job(earlier, at - 60_000)] } },
    // The new job, stamped by a companion clock an hour behind the phone.
    { status: 200, body: { bundles: [job(earlier, at - 60_000), job(ID, at - 3_600_000)] } },
  ]);
  const client = companionPrinterHandoff(bridge);
  const before = await client.bundleIds(ackFor());
  expect(before).toEqual([earlier]);
  const lost = { startedAtMs: at, prompt: '', backend: 'bambu-printer-mcp' as const, model: MODEL.sha256, before };
  expect(await client.find('p', 'c', ackFor(), lost)).toBeNull();
  expect(await client.find('p', 'c', ackFor(), lost)).toMatchObject({ id: ID });
});

test('a job the printer software may have started is uncertain, and printing it again is refused', async () => {
  const { bridge } = native([
    { status: 200, body: { bundle: { ...manifest, status: 'uncertain', failure: 'dispatch-uncertain' }, printing: false } },
    { status: 409, body: { error: { code: 'dispatch-uncertain', message: 'dispatch-uncertain' } } },
    { status: 409, body: { error: { code: 'already-printed', message: 'already-printed' } } },
  ]);
  const client = companionPrinterHandoff(bridge);
  expect(await client.status('p', 'c', ackFor(), ID)).toMatchObject({ status: 'uncertain', failure: 'dispatch-uncertain' });
  await expect(client.print(ID)).rejects.toMatchObject({
    code: 'dispatch-uncertain',
    status: 409,
    message: expect.stringContaining('Check your printer'),
  });
  await expect(client.print(ID)).rejects.toMatchObject({ code: 'already-printed', message: expect.stringContaining('already sent') });
});

test('listing jobs before a send skips entries this app can’t read', async () => {
  const { bridge } = native([
    { status: 200, body: { bundles: [{ id: ID, status: 'from-the-future' }, { nope: true }, null, { id: Q }] } },
  ]);
  expect(await companionPrinterHandoff(bridge).bundleIds(ackFor())).toEqual([ID, Q]);
});

// MAC-6: a Bambu Connect job ends as `handed-off`. Phones that didn't know it
// rejected the whole list as an invalid response.
test('a job handed off to Bambu Connect reads as handed-off, not as an invalid reply', async () => {
  const handedOff = {
    ...manifest,
    id: ID,
    status: 'handed-off',
    createdAtMs: 1_800_000_000_000,
    cleanStl: { file: 'clean.stl', sha256: MODEL.sha256, byteLength: 2048 },
  };
  const { bridge } = native([{ status: 200, body: { bundle: handedOff, printing: false } }]);
  const client = companionPrinterHandoff(bridge);
  expect(await client.status('p', 'c', ackFor(), ID)).toMatchObject({ id: ID, status: 'handed-off', printing: false });
});
