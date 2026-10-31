import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  CaptureClient,
  type CaptureNative,
} from '../src/capture/retainedCaptures';

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
  const metadata = new Map<string, string>();
  const native: CaptureNative = {
    context: async () => 'host/device',
    read: async key => metadata.get(key) ?? null,
    write: async (key, body) => {
      metadata.set(key, body);
    },
    request: jest.fn(async () => ({ status: 404, body: '', etag: '' })),
    pick: jest.fn(),
    present: jest.fn(),
    cancel: jest.fn(),
  };
  const client = new CaptureClient(repo, native, async () => {});
  const create = async () => {
    const r = await repo.create({
      id: 'one',
      brief: { object: 'Drawer', context: 'Kitchen', addition: 'Tray' },
    });
    if (r.status !== 'ok') throw Error();
    return r.project;
  };
  return { repo, native, client, create, metadata };
}
test('delayed sync acknowledges sent bytes without overwriting newer local edits', async () => {
  const h = harness();
  const p = await h.create();
  h.native.request = jest.fn(async options => {
    if (options.method === 'GET') return { status: 404, body: '', etag: '' };
    await h.repo.change('one', 0, {
      kind: 'replace-brief',
      brief: { ...p.brief, addition: 'Keep my edit' },
    });
    return {
      status: 201,
      body: options.body!,
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  await h.client.sync('one');
  expect(await h.repo.load('one')).toMatchObject({
    project: { revision: 1, brief: { addition: 'Keep my edit' } },
  });
  expect((await h.client.state('one')).snapshot).toBe(JSON.stringify(p));
});
test('unknown divergent remote snapshot is a conflict, never an overwrite', async () => {
  const h = harness();
  const p = await h.create();
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify({ ...p, revision: 1 }),
    etag: '"' + 'a'.repeat(64) + '"',
  }));
  await expect(h.client.sync('one')).rejects.toThrow('different version');
  expect(h.native.request).toHaveBeenCalledTimes(1);
});
test('only GET retries explicit busy and retries are bounded', async () => {
  const h = harness();
  await h.create();
  h.native.request = jest.fn(async () => ({ status: 429, body: '', etag: '' }));
  await expect(h.client.sync('one')).rejects.toThrow('busy');
  expect(h.native.request).toHaveBeenCalledTimes(3);
});
test('failed POST records ambiguous import durably and is never retried', async () => {
  const h = harness();
  const p = await h.create();
  h.native.request = jest.fn(async options => {
    if (options.method === 'POST') throw Error('disconnected');
    return {
      status: 200,
      body: JSON.stringify(p),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  await expect(
    h.client.import('one', {
      sha256: 'b'.repeat(64),
      byteLength: 50,
      mediaType: 'model/vnd.usdz+zip',
    }),
  ).rejects.toThrow('may have finished');
  expect((await h.client.state('one')).pending).toBeTruthy();
  expect(
    (h.native.request as jest.Mock).mock.calls.filter(
      ([o]) => o.method === 'POST',
    ),
  ).toHaveLength(1);
  await expect(
    h.client.import('one', {
      sha256: 'b'.repeat(64),
      byteLength: 50,
      mediaType: 'model/vnd.usdz+zip',
    }),
  ).rejects.toThrow('unconfirmed');
});
test('scope denial does not modify local project or acknowledge sync', async () => {
  const h = harness();
  const p = await h.create();
  h.native.request = jest.fn(async () => ({ status: 403, body: '', etag: '' }));
  await expect(h.client.sync('one')).rejects.toThrow('permission');
  expect(await h.repo.load('one')).toEqual({ status: 'ok', project: p });
  expect(h.metadata.size).toBe(0);
});

function captureFixture() {
  const ref = (c: string, mediaType: string) => ({
    sha256: c.repeat(64),
    byteLength: 123,
    mediaType,
  });
  return {
    captureId: 'capture-1',
    binding: {
      projectId: 'one',
      projectRevision: 0,
      capture: {
        formatVersion: '0.1.0',
        original: ref('a', 'model/vnd.usdz+zip'),
        derived: ref('b', 'model/obj'),
        conversionReport: ref('c', 'application/json'),
        converter: { name: 'capture-mesh-convert', version: '0.1.0' },
        provenance: {
          metersPerUnit: 1,
          unitsAuthored: true,
          upAxis: 'Y',
          coordinates: 'world',
          transformPolicy: 'composed-once-native-unrescaled',
          contributingLayers: [
            {
              identifier: 'root.usdc',
              artifact: ref('d', 'application/octet-stream'),
            },
          ],
        },
        qualification: { status: 'qualified', reasons: [] },
        evidence: {
          metricAccuracy: 'unknown',
          surfaceCompleteness: 'unknown',
          physicalFit: 'unknown',
        },
      },
    },
  };
}
test('import persists handle across client restart, verifies reopen and exact export without acceptance', async () => {
  const h = harness();
  const p = await h.create();
  const fixture = captureFixture();
  h.native.request = jest.fn(async o => ({
    status: o.method === 'POST' ? 201 : 200,
    body: JSON.stringify(o.path.includes('/captures') ? fixture : p),
    etag: '"' + 'a'.repeat(64) + '"',
    file: o.artifact,
  }));
  const imported = await h.client.import(
    'one',
    fixture.binding.capture.original,
  );
  const restarted = new CaptureClient(h.repo, h.native, async () => {});
  expect((await restarted.state('one')).captures).toEqual([imported]);
  await restarted.openFile('one', imported, 'derived', true);
  expect(h.native.present).toHaveBeenCalledWith(
    fixture.binding.capture.derived,
    true,
  );
  expect(await h.repo.load('one')).toEqual({ status: 'ok', project: p });
  await h.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { ...p.brief, addition: 'Edited' },
  });
  await expect(restarted.reopen('one', imported)).rejects.toThrow(
    'earlier project',
  );
});
test('download identity mismatch cannot reach native presentation', async () => {
  const h = harness();
  const p = await h.create();
  const fixture = captureFixture();
  h.native.request = jest.fn(async o => ({
    status: o.method === 'POST' ? 201 : 200,
    body: JSON.stringify(o.path.includes('/captures') ? fixture : p),
    etag: '"' + 'a'.repeat(64) + '"',
    file: o.artifact ? { ...o.artifact, sha256: 'f'.repeat(64) } : undefined,
  }));
  const imported = await h.client.import(
    'one',
    fixture.binding.capture.original,
  );
  await expect(
    h.client.openFile('one', imported, 'original', true),
  ).rejects.toThrow('verification');
  expect(h.native.present).not.toHaveBeenCalled();
});

test('empty native sidecar may resolve undefined through the iOS promise bridge', async () => {
  const h = harness();
  h.native.read = jest.fn(async () => undefined as unknown as null);
  expect(await h.client.state('one')).toEqual({ captures: [] });
});

test('replacing credentials at the same origin retains handles; another origin does not', async () => {
  const h = harness();
  const p = await h.create();
  h.native.context = async () => 'https://fixture.ts.net|first-device';
  h.native.request = jest.fn(async () => ({
    status: 200,
    body: JSON.stringify(p),
    etag: '"' + 'a'.repeat(64) + '"',
  }));
  await h.client.sync('one');
  h.native.context = async () => 'https://fixture.ts.net|replacement-device';
  expect((await h.client.state('one')).snapshot).toBe(JSON.stringify(p));
  h.native.context = async () => 'https://other.ts.net|replacement-device';
  expect((await h.client.state('one')).snapshot).toBeUndefined();
});

const nativeSource = {
  sha256: 'a'.repeat(64),
  byteLength: 123,
  mediaType: 'model/vnd.usdz+zip',
};
test('native handoff refuses a project changed since scanning before any network request', async () => {
  const h = harness();
  const p = await h.create();
  await h.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { ...p.brief, addition: 'Changed' },
  });
  await expect(
    h.client.import('one', nativeSource, {
      projectId: 'one',
      revision: 0,
      snapshot: JSON.stringify(p),
      context: 'host/device',
    }),
  ).rejects.toThrow('capture destination changed');
  expect(h.native.request).not.toHaveBeenCalled();
  expect((await h.client.state('one')).pending).toBeUndefined();
});
test('native handoff refuses replacement pairing before syncing or uploading', async () => {
  const h = harness();
  const p = await h.create();
  await expect(
    h.client.import('one', nativeSource, {
      projectId: 'one',
      revision: 0,
      snapshot: JSON.stringify(p),
      context: 'previous/device',
    }),
  ).rejects.toThrow('capture destination changed');
  expect(h.native.request).not.toHaveBeenCalled();
});
test('native handoff rechecks its originating revision after asynchronous sync', async () => {
  const h = harness();
  const p = await h.create();
  h.native.request = jest.fn(async () => {
    await h.repo.change('one', 0, {
      kind: 'replace-brief',
      brief: { ...p.brief, addition: 'Changed during sync' },
    });
    return {
      status: 200,
      body: JSON.stringify(p),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  await expect(
    h.client.import('one', nativeSource, {
      projectId: 'one',
      revision: 0,
      snapshot: JSON.stringify(p),
      context: 'host/device',
    }),
  ).rejects.toThrow('capture destination changed');
  expect(
    (h.native.request as jest.Mock).mock.calls.some(
      ([o]) => o.method === 'POST',
    ),
  ).toBe(false);
});

test('pairing changed between handoff precheck and sync cannot send project bytes to the new companion', async () => {
  const h = harness();
  const p = await h.create();
  let reads = 0;
  h.native.context = async () =>
    ++reads <= 2 ? 'host/device' : 'other/device';
  await expect(
    h.client.import('one', nativeSource, {
      projectId: 'one',
      revision: 0,
      snapshot: JSON.stringify(p),
      context: 'host/device',
    }),
  ).rejects.toThrow('capture destination changed');
  expect(h.native.request).not.toHaveBeenCalled();
});

// David's "Thing" reached the companion three times: the same 7 MB scan,
// added again 10 and 15 seconds later, each POST making a new capture.
test('bytes already imported for this project version are never sent again', async () => {
  const h = harness();
  const p = await h.create();
  const fixture = captureFixture();
  let made = 0;
  // A companion that makes a new capture for every POST, as it does today.
  h.native.request = jest.fn(async o => {
    const project = await h.repo.load('one');
    if (project.status !== 'ok') throw Error();
    const revision = project.project.revision;
    return {
      status: o.method === 'POST' ? 201 : 200,
      body:
        o.method === 'POST'
          ? JSON.stringify({
              captureId: `capture-${++made}`,
              binding: {
                ...fixture.binding,
                projectRevision: revision,
                capture: { ...fixture.binding.capture, original: o.source },
              },
            })
          : o.method === 'PUT'
          ? o.body!
          : JSON.stringify(revision === 0 ? p : project.project),
      etag: '"' + String(revision).repeat(64) + '"',
    };
  });
  const posts = () =>
    (h.native.request as jest.Mock).mock.calls.filter(
      ([o]) => o.method === 'POST',
    ).length;
  const source = fixture.binding.capture.original;
  const first = await h.client.import('one', source);
  const restarted = new CaptureClient(h.repo, h.native, async () => {});
  expect(await restarted.import('one', source)).toEqual(first);
  expect(await h.client.import('one', { ...source })).toEqual(first);
  expect(posts()).toBe(1);
  expect((await h.client.state('one')).captures).toHaveLength(1);
  // Other bytes, or the same bytes for a newer project version, are new captures.
  await h.client.import('one', { ...source, sha256: 'e'.repeat(64) });
  expect(posts()).toBe(2);
  await h.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { ...p.brief, addition: 'Edited' },
  });
  expect((await h.client.import('one', source)).captureId).toBe('capture-3');
  expect(posts()).toBe(3);
});
test('a second import while one is running is refused without a request', async () => {
  const h = harness();
  const p = await h.create();
  const fixture = captureFixture();
  let reply!: () => void;
  h.native.request = jest.fn(async o => {
    if (o.method === 'POST') await new Promise<void>(r => (reply = r));
    return {
      status: o.method === 'POST' ? 201 : 200,
      body: JSON.stringify(o.path.includes('/captures') ? fixture : p),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  const source = fixture.binding.capture.original;
  const first = h.client.import('one', source);
  await expect(
    h.client.import('one', { ...source, sha256: 'e'.repeat(64) }),
  ).rejects.toThrow('already running');
  while (!reply) await new Promise<void>(r => setImmediate(r));
  reply();
  await first;
  expect(
    (h.native.request as jest.Mock).mock.calls.filter(
      ([o]) => o.method === 'POST',
    ),
  ).toHaveLength(1);
});

// A companion that makes a new capture for every POST, as it does today.
function companion(h: ReturnType<typeof harness>, p: unknown) {
  const fixture = captureFixture();
  let made = 0;
  let lose = false;
  h.native.request = jest.fn(async o => {
    if (o.method === 'POST') {
      made++;
      if (lose) throw Error('reply lost');
    }
    return {
      status: o.method === 'POST' ? 201 : 200,
      body:
        o.method === 'POST'
          ? JSON.stringify({
              captureId: `capture-${made}`,
              binding: {
                ...fixture.binding,
                capture: { ...fixture.binding.capture, original: o.source },
              },
            })
          : JSON.stringify(p),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  return {
    source: fixture.binding.capture.original,
    posts: () => made,
    loseReplies: (value: boolean) => (lose = value),
  };
}
test('after an unconfirmed import is set aside, the same bytes need an explicit yes', async () => {
  const h = harness();
  const p = await h.create();
  const c = companion(h, p);
  c.loseReplies(true);
  await expect(h.client.import('one', c.source)).rejects.toThrow(
    'may have finished',
  );
  await h.client.acknowledgeUnknown('one');
  c.loseReplies(false);
  await expect(h.client.import('one', c.source)).rejects.toMatchObject({
    code: 'maybe-imported',
  });
  expect(c.posts()).toBe(1);
  // Other bytes go straight through; the same bytes only when asked again.
  await h.client.import('one', { ...c.source, sha256: 'e'.repeat(64) });
  expect(c.posts()).toBe(2);
  const again = await h.client.import('one', c.source, undefined, true);
  expect(c.posts()).toBe(3);
  expect(await h.client.import('one', c.source)).toEqual(again);
  expect(c.posts()).toBe(3);
});
test('a held capture is returned even while another import is unconfirmed', async () => {
  const h = harness();
  const p = await h.create();
  const c = companion(h, p);
  const held = await h.client.import('one', c.source);
  c.loseReplies(true);
  await expect(
    h.client.import('one', { ...c.source, sha256: 'e'.repeat(64) }),
  ).rejects.toThrow('may have finished');
  expect(await h.client.import('one', c.source)).toEqual(held);
  await expect(
    h.client.import('one', { ...c.source, sha256: 'f'.repeat(64) }),
  ).rejects.toThrow('unconfirmed');
  expect(c.posts()).toBe(2);
});
test('a held capture never bypasses a changed destination', async () => {
  const h = harness();
  const p = await h.create();
  const c = companion(h, p);
  await h.client.import('one', c.source);
  await expect(
    h.client.import('one', c.source, {
      projectId: 'one',
      revision: 0,
      snapshot: JSON.stringify(p),
      context: 'host/other-device',
    }),
  ).rejects.toThrow('capture destination changed');
});
test('clients on the same bridge take turns: one import at a time, and sync never overwrites it', async () => {
  const h = harness();
  const p = await h.create();
  const fixture = captureFixture();
  let reply!: () => void;
  h.native.request = jest.fn(async o => {
    if (o.method === 'POST') await new Promise<void>(r => (reply = r));
    return {
      status: o.method === 'POST' ? 201 : 200,
      body: JSON.stringify(o.path.includes('/captures') ? fixture : p),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  });
  const other = new CaptureClient(h.repo, h.native, async () => {});
  const first = h.client.import('one', fixture.binding.capture.original);
  while (!reply) await new Promise<void>(r => setImmediate(r));
  await expect(
    other.import('one', {
      ...fixture.binding.capture.original,
      sha256: 'e'.repeat(64),
    }),
  ).rejects.toThrow('already running');
  let synced = false;
  const sync = other.sync('one').then(() => (synced = true));
  await new Promise<void>(r => setImmediate(r));
  expect(synced).toBe(false);
  reply();
  await first;
  await sync;
  expect((await other.state('one')).captures).toHaveLength(1);
  expect((await other.state('one')).pending).toBeUndefined();
});
test('unconfirmed uploads are never forgotten until their bytes are held', async () => {
  const h = harness();
  const p = await h.create();
  const c = companion(h, p);
  c.loseReplies(true);
  const file = (n: number) => ({
    ...c.source,
    sha256: n.toString(16).padStart(64, '0'),
  });
  for (let n = 0; n < 25; n++) {
    await expect(h.client.import('one', file(n))).rejects.toThrow(
      'may have finished',
    );
    await h.client.acknowledgeUnknown('one');
  }
  c.loseReplies(false);
  await expect(h.client.import('one', file(0))).rejects.toMatchObject({
    code: 'maybe-imported',
  });
  await h.client.import('one', file(0), undefined, true);
  const state = await h.client.state('one');
  expect(state.unconfirmed).toHaveLength(24);
  expect(state.unconfirmed?.some(u => u.source.sha256 === file(0).sha256)).toBe(
    false,
  );
});
