import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import {
  CaptureClient,
  type CaptureNative,
} from '../src/capture/retainedCaptures';
import {
  NativeObjectCaptureClient,
  type ObjectCaptureNative,
  type NativeCaptureDraft,
} from '../src/capture/nativeObjectCapture';

const file = {
  sha256: 'a'.repeat(64),
  byteLength: 123,
  mediaType: 'model/vnd.usdz+zip',
};
async function harness() {
  const records = new Map<string, string>();
  const metadata = new Map<string, string>();
  const repo = createSavedProjects({
    listIds: async () => [...records.keys()],
    read: async id => records.get(id) ?? null,
    compareAndSwap: async (id, old, next) => {
      if ((records.get(id) ?? null) !== old) return false;
      records.set(id, next);
      return true;
    },
  });
  const result = await repo.create({
    id: 'one',
    brief: { object: 'Box', context: 'Desk', addition: 'Lid' },
  });
  if (result.status !== 'ok') throw Error();
  const origin = {
    projectId: 'one',
    revision: 0,
    snapshot: JSON.stringify(result.project),
    context: 'host|device',
  };
  const draft: NativeCaptureDraft = {
    formatVersion: 1,
    runID: '14f6ca24-44fc-4984-9634-c14eef4eebc9',
    origin,
    createdAt: '2026-01-01T00:00:00Z',
    status: 'ready',
    file,
  };
  const calls: string[] = [];
  const bridge: ObjectCaptureNative = {
    status: async () => ({ supported: true, activeRunID: null }),
    drafts: async () => [draft],
    start: async destination => {
      calls.push('start');
      return { ...draft, origin: destination };
    },
    stop: async () => {},
  };
  const native: CaptureNative = {
    context: async () => 'host|device',
    read: async k => metadata.get(k) ?? null,
    write: async (k, b) => {
      metadata.set(k, b);
    },
    pick: jest.fn(),
    present: jest.fn(),
    cancel: jest.fn(),
    adoptNativeOutput: async () => {
      calls.push('adopt');
      return file;
    },
    request: async o => {
      calls.push(o.method);
      if (o.method === 'POST') throw Error('reply lost');
      return {
        status: 200,
        body: JSON.stringify(result.project),
        etag: '"' + 'a'.repeat(64) + '"',
      };
    },
  };
  const captures = new CaptureClient(repo, native, async () => {});
  return {
    repo,
    native,
    bridge,
    draft,
    calls,
    captures,
    client: new NativeObjectCaptureClient(captures, bridge),
  };
}
test('local scan starts unpaired and returns a retained draft without importing', async () => {
  const h = await harness();
  h.native.context = async () => {
    throw Error('pairing required');
  };
  const draft = await h.client.start('one');
  expect(draft.origin.context).toBeNull();
  expect(h.calls).toEqual(['start']);
});
test('local draft list stays available without a companion and filters other projects', async () => {
  const h = await harness();
  h.native.context = async () => {
    throw Error('unpaired');
  };
  expect(await h.client.drafts('one')).toEqual([h.draft]);
  expect(await h.client.drafts('other')).toEqual([]);
});
test('explicit add uses secure adoption and existing uncertain POST safeguard without repeating upload', async () => {
  const h = await harness();
  await expect(h.client.add('one', h.draft)).rejects.toThrow(
    'may have finished',
  );
  expect(h.calls).toEqual(['adopt', 'GET', 'POST']);
  await expect(h.client.add('one', h.draft)).rejects.toThrow('unconfirmed');
  expect(h.calls.filter(x => x === 'POST')).toHaveLength(1);
  expect((await h.client.drafts('one'))[0].file).toEqual(file);
});
test('adoption identity mismatch and oversize never reach importer', async () => {
  const h = await harness();
  h.native.adoptNativeOutput = async () => ({
    ...file,
    sha256: 'f'.repeat(64),
  });
  await expect(h.client.add('one', h.draft)).rejects.toThrow('identity');
  expect(h.calls).toEqual([]);
  await expect(
    h.client.add('one', {
      ...h.draft,
      file: { ...file, byteLength: 33554433 },
    }),
  ).rejects.toThrow('32');
  expect(h.calls).toEqual([]);
});
test('changed destination needs a new explicit selection, never implicit rebinding', async () => {
  const h = await harness();
  h.native.context = async () => 'host|replacement';
  await expect(h.client.add('one', h.draft)).rejects.toThrow(
    'destination changed',
  );
  expect(h.calls.filter(x => ['GET', 'POST', 'PUT'].includes(x))).toEqual([]);
  const selected = await h.captures.destination('one');
  await expect(h.client.add('one', h.draft, selected)).rejects.toThrow(
    'may have finished',
  );
  expect(h.calls.filter(x => x === 'POST')).toHaveLength(1);
});
test('a scan started before its project was named follows it to the named version; any other change still needs choosing', async () => {
  const h = await harness();
  await h.repo.create({
    id: 'two',
    brief: { object: '', context: '', addition: '' },
  });
  h.native.request = async o => {
    h.calls.push(o.method);
    if (o.method === 'POST') throw Error('reply lost');
    const now = await h.repo.load('two');
    if (now.status !== 'ok') throw Error();
    return {
      status: 200,
      body: JSON.stringify(now.project),
      etag: '"' + 'a'.repeat(64) + '"',
    };
  };
  const draft = await h.client.start('two');
  const brief = async (next: {
    object: string;
    context: string;
    addition: string;
  }) => {
    const project = await h.repo.load('two');
    if (project.status !== 'ok') throw Error();
    await h.repo.change('two', project.project.revision, {
      kind: 'replace-brief',
      brief: next,
    });
  };
  // More than the name changed: the scan waits for an explicit choice.
  await brief({ object: 'Desk lamp', context: 'Kitchen', addition: '' });
  await expect(h.client.add('two', draft)).rejects.toThrow(
    'destination changed',
  );
  expect(h.calls).not.toContain('POST');
  // Only the name: it goes to the named version.
  await brief({ object: 'Desk lamp', context: '', addition: '' });
  await expect(h.client.add('two', draft)).rejects.toThrow('may have finished');
  expect(h.calls.filter(x => x === 'POST')).toHaveLength(1);
});
