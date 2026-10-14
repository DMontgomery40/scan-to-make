/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createSavedProjects,
  type SavedProjectStorage,
} from '@scan-to-make/contracts/saved-project';
import {
  acceptArtifact,
  encodeBytes,
  generateAndAttach,
  shareArtifact,
  type ArtifactNative,
} from '../src/design/artifacts';
import { drawerExample } from '../src/fit/drawerDraft';

function harness() {
  const records = new Map<string, string>();
  const storage: SavedProjectStorage = {
    listIds: async () => [...records.keys()],
    read: async id => records.get(id) ?? null,
    compareAndSwap: async (id, expected, next) => {
      if ((records.get(id) ?? null) !== expected) {
        return false;
      }
      records.set(id, next);
      return true;
    },
  };
  const repository = createSavedProjects(storage);
  const bytes = readFileSync(
    '../../tools/templates/drawer-organizer/examples/drawer-tray.stl',
  );
  const digest = createHash('sha256').update(bytes).digest('hex');
  const native: ArtifactNative = {
    generate: jest.fn(async body => ({
      status: 200,
      body: JSON.stringify({
        formatVersion: '0.1.0',
        receipt: {
          sourceFit: JSON.parse(body).sourceFit,
          artifact: {
            sha256: digest,
            byteLength: bytes.length,
            mediaType: 'model/stl',
          },
          geometry: {
            encoding: 'binary',
            triangleCount: 364,
            boundsMm: { min: [-148.9, -198.9, 0], max: [148.9, 198.9, 40] },
          },
          generator: { name: 'drawer-tray', version: '0.1.0' },
          assumptions: { cornerRadiusAssumedMm: 0 },
          status: 'preview-only',
        },
        stlBase64: bytes.toString('base64'),
      }),
    })),
    cancel: jest.fn(async () => {}),
    hashBase64: jest.fn(async encoded =>
      createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex'),
    ),
    cache: jest.fn(async () => '/verified-cache.stl'),
    verifyCache: jest.fn(async () => '/verified-cache.stl'),
    share: jest.fn(async () => ({
      completed: true,
      path: '/export.stl',
      sha256: digest,
      byteLength: bytes.length,
    })),
  };
  const create = async () => {
    const result = await repository.create({
      id: 'drawer',
      brief: { object: 'Drawer', context: 'Synthetic', addition: 'Tray' },
      fit: drawerExample('drawer'),
    });
    if (result.status !== 'ok') {
      throw new Error('create failed');
    }
    return result.project;
  };
  return { repository, native, create, bytes };
}

test('base64 adapter preserves exact bytes including padding', () => {
  for (let length = 0; length < 100; length++) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97) % 256);
    expect(encodeBytes(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  }
});

test('verified generation attaches, explicit acceptance persists, and share passes only exact identity', async () => {
  const { repository, native, create, bytes } = harness();
  const project = await create();
  const attached = await generateAndAttach(project, repository, native, {
    cancelled: false,
  });
  expect(attached.acceptedArtifact).toBeNull();
  expect(attached.fit?.revision).toBe(0);
  expect(attached.revision).toBe(1);
  expect(native.cache).toHaveBeenCalledWith(
    bytes.toString('base64'),
    attached.preview!.artifact.sha256,
    bytes.length,
  );
  await expect(
    shareArtifact(project.id, attached.preview!, repository, native),
  ).rejects.toThrow('no longer accepted');
  const accepted = await acceptArtifact(
    project.id,
    attached.preview!,
    repository,
    native,
  );
  expect(accepted.revision).toBe(2);
  expect(accepted.fit?.revision).toBe(0);
  await shareArtifact(project.id, attached.preview!, repository, native);
  expect(native.share).toHaveBeenCalledWith(
    attached.preview!.artifact.sha256,
    bytes.length,
    expect.stringContaining('drawer-r0-'),
  );
  expect(await repository.load(project.id)).toEqual({
    status: 'ok',
    project: accepted,
  });
});

test('fit edit during generation rejects late output; brief edit alone does not', async () => {
  const h = harness();
  const project = await h.create();
  const generate = h.native.generate;
  h.native.generate = async body => {
    await h.repository.change(project.id, project.revision, {
      kind: 'patch-fit',
      patch: {
        template: 'drawer-tray',
        expectedRevision: 0,
        dimensions: {},
        parameters: { dividersAcross: 3 },
      },
    });
    return generate(body);
  };
  await expect(
    generateAndAttach(project, h.repository, h.native, { cancelled: false }),
  ).rejects.toThrow('project changed');
  const latest = await h.repository.load(project.id);
  expect(latest.status === 'ok' && latest.project.preview).toBeNull();
  const other = harness();
  const original = await other.create();
  const actual = other.native.generate;
  other.native.generate = async body => {
    await other.repository.change(original.id, 0, {
      kind: 'replace-brief',
      brief: { ...original.brief, addition: 'Keep this idea' },
    });
    return actual(body);
  };
  expect(
    (
      await generateAndAttach(original, other.repository, other.native, {
        cancelled: false,
      })
    ).brief.addition,
  ).toBe('Keep this idea');
});

test('wrong digest/source and cancellation never cache or attach output', async () => {
  for (const defect of ['digest', 'source', 'cancel'] as const) {
    const h = harness();
    const project = await h.create();
    const actual = h.native.generate;
    const token = { cancelled: false };
    h.native.generate = async body => {
      const response = await actual(body);
      const payload = JSON.parse(response.body);
      if (defect === 'digest') {
        payload.receipt.artifact.sha256 = '0'.repeat(64);
      }
      if (defect === 'source') {
        payload.receipt.sourceFit.revision = 99;
      }
      if (defect === 'cancel') {
        token.cancelled = true;
      }
      return { ...response, body: JSON.stringify(payload) };
    };
    await expect(
      generateAndAttach(project, h.repository, h.native, token),
    ).rejects.toThrow();
    expect(h.native.cache).not.toHaveBeenCalled();
    const loaded = await h.repository.load(project.id);
    expect(loaded.status === 'ok' && loaded.project.preview).toBeNull();
  }
});

test('cache failure prevents attachment; missing cached bytes prevent acceptance and sharing', async () => {
  const h = harness();
  const project = await h.create();
  h.native.cache = jest.fn(async () => {
    throw new Error('Disk full');
  });
  await expect(
    generateAndAttach(project, h.repository, h.native, { cancelled: false }),
  ).rejects.toThrow('Disk full');
  expect(await h.repository.load(project.id)).toEqual({
    status: 'ok',
    project,
  });
  h.native.cache = async () => '/cache';
  const attached = await generateAndAttach(project, h.repository, h.native, {
    cancelled: false,
  });
  h.native.verifyCache = async () => {
    throw new Error('Missing or corrupt');
  };
  await expect(
    acceptArtifact(project.id, attached.preview!, h.repository, h.native),
  ).rejects.toThrow('Missing or corrupt');
  await expect(
    shareArtifact(project.id, attached.preview!, h.repository, h.native),
  ).rejects.toThrow('Missing or corrupt');
  expect(h.native.share).not.toHaveBeenCalled();
});

test('effective edit clears acceptance and blocks sharing an old artifact; no-op preserves review', async () => {
  const h = harness();
  let project = await h.create();
  project = await generateAndAttach(project, h.repository, h.native, {
    cancelled: false,
  });
  const binding = project.preview!;
  project = await acceptArtifact(project.id, binding, h.repository, h.native);
  const noop = await h.repository.change(project.id, project.revision, {
    kind: 'patch-fit',
    patch: { template: 'drawer-tray', expectedRevision: 0, dimensions: {} },
  });
  expect(noop).toEqual({ status: 'ok', project });
  await h.repository.change(project.id, project.revision, {
    kind: 'patch-fit',
    patch: {
      template: 'drawer-tray',
      expectedRevision: 0,
      dimensions: {},
      parameters: { dividersAlong: 2 },
    },
  });
  await expect(
    shareArtifact(project.id, binding, h.repository, h.native),
  ).rejects.toThrow('no longer accepted');
  const latest = await h.repository.load(project.id);
  expect(latest.status === 'ok' && latest.project.acceptedArtifact).toBeNull();
});
