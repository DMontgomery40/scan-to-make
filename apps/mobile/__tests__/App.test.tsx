/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, Linking, Modal, Text } from 'react-native';
import App from '../App';
import {
  createSavedProjects,
  type SavedProjectStorage,
} from '@scan-to-make/contracts/saved-project';
function testStore(bytes = new Map<string, string>()) {
  const storage: SavedProjectStorage = {
    listIds: async () => [...bytes.keys()],
    read: async id => bytes.get(id) ?? null,
    compareAndSwap: async (id, expected, next) => {
      if ((bytes.get(id) ?? null) !== expected) {
        return false;
      }
      bytes.set(id, next);
      return true;
    },
  };
  return createSavedProjects(storage);
}
async function onlyProject(store: ReturnType<typeof testStore>) {
  const listed = await store.list();
  if (listed.status !== 'ok' || listed.entries[0].result.status !== 'ok') {
    throw new Error('No project');
  }
  return listed.entries[0].result.project;
}
import {
  JOB_ID,
  PROJECT_ID,
  fakeScanServices,
  stillFrom,
  syntheticJob,
  syntheticTarget,
} from '../src/screens/testing/fakeScanServices';

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    // UIKit renders these titles; they are not React Native Text descendants.
    ...tree.root
      .findAll(
        n => typeof n.type === 'string' && String(n.type) === 'STMActionButton',
      )
      .map(n => n.props.buttonTitle),
  ];
}

function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
  times = 1,
) {
  const button = tree.root.find(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      typeof n.props.onPress === 'function' &&
      ((n.props.accessibilityLabel ?? n.props.spokenLabel) === label ||
        n.findAllByType(Text).some(t => t.props.children === label)),
  );
  // times > 1: a double tap, both before the next render.
  return act(async () => {
    for (let n = 0; n < times; n++) button.props.onPress();
  });
}

// Project cards are one button each, labelled "<name>, <status>[, <size>]".
function openProject(tree: ReactTestRenderer.ReactTestRenderer, name: string) {
  const card = tree.root.find(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      typeof n.props.onPress === 'function' &&
      typeof (n.props.accessibilityLabel ?? n.props.spokenLabel) === 'string' &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel).startsWith(
        `${name}, `,
      ),
  );
  return act(async () => {
    card.props.onPress();
  });
}

test('home is the projects grid, with the empty state and one Scan something', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore()} />);
  });
  const shown = texts(tree);
  expect(shown).toContain('Projects');
  expect(shown).toContain('Scan your first thing');
  expect(shown).toContain('Scan something');
  expect(shown).not.toContain('Scan it true.');
  expect(shown).not.toContain('Refresh projects');
  await press(tree, 'Settings');
  expect(texts(tree)).toContain('About Scan to Make');
  await press(tree, 'Back');
  expect(texts(tree)).toContain('Scan your first thing');
});

// A LiDAR scanner whose scans finish as `status` says. Like the native
// one, it keeps a draft of every scan it opens, stopped ones included.
function scanner(status: 'ready' | 'interrupted' = 'ready') {
  const made: unknown[] = [];
  const draft = (origin: { projectId: string }) => ({
    formatVersion: 1,
    runID: '14f6ca24-44fc-4984-9634-c14eef4eebc9',
    origin,
    createdAt: '2026-10-31T00:00:00Z',
    status,
    ...(status === 'ready'
      ? {
          file: {
            sha256: 'a'.repeat(64),
            byteLength: 10,
            mediaType: 'model/vnd.usdz+zip',
          },
        }
      : {}),
  });
  const start = jest.fn(async (origin: { projectId: string }) => {
    const next = draft(origin);
    made.push(next);
    return next;
  });
  const { NativeModules } = require('react-native');
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async () => null,
    cancel: async () => {},
  };
  NativeModules.NativeCaptureCoordinator = {
    status: async () => ({ supported: true, lidar: true, activeRunID: null }),
    drafts: async () => made,
    start,
    stop: async () => {},
  };
  return start;
}
function noScanner() {
  const { NativeModules } = require('react-native');
  delete NativeModules.RetainedCaptureBridge;
  delete NativeModules.NativeCaptureCoordinator;
}
const nameField = (tree: ReactTestRenderer.ReactTestRenderer) => {
  const { TextInput } = require('react-native');
  return tree.root.find(
    n =>
      n.type === TextInput &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
        'What did you scan?',
  );
};

test('Scan something opens the camera first and names the project after the scan', async () => {
  const start = scanner();
  const bytes = new Map<string, string>();
  const store = testStore(bytes);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={store} />);
    });
    await press(tree, 'Scan something');
    expect(start).toHaveBeenCalledTimes(1);
    expect(texts(tree).join(' ')).not.toContain('What are you scanning?');
    expect(texts(tree)).toContain('Scan finished');
    await act(async () => nameField(tree).props.onChangeText('  Desk lamp  '));
    await press(tree, 'Continue');
    expect(texts(tree)).not.toContain('Scan finished');
    const project = await onlyProject(store);
    expect(project.brief).toEqual({
      object: 'Desk lamp',
      context: '',
      addition: '',
    });
    expect(project.fit).toBeNull();
    expect(bytes.size).toBe(1);

    await press(tree, 'Back');
    expect(texts(tree)).toContain('Desk lamp');
    // Opening the project again never starts another scan by itself.
    await openProject(tree, 'Desk lamp');
    expect(texts(tree)).toContain('Project captures');
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    if (tree) await act(async () => tree.unmount());
    noScanner();
  }
});

test('a stopped scan leaves one Untitled project, which the next Scan something uses again', async () => {
  const start = scanner('interrupted');
  const bytes = new Map<string, string>();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore(bytes)} />);
    });
    await press(tree, 'Scan something');
    expect(texts(tree)).not.toContain('Scan finished');
    await press(tree, 'Back');
    expect(texts(tree)).toContain('Untitled project');
    await press(tree, 'Scan something');
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][0].projectId).toBe(
      start.mock.calls[0][0].projectId,
    );
    expect(bytes.size).toBe(1);
  } finally {
    if (tree) await act(async () => tree.unmount());
    noScanner();
  }
});

test('a failed create says so and keeps the other projects', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const store = testStore();
  await store.create({
    id: 'kept',
    brief: { object: 'Phone case', context: '', addition: '' },
  });
  const failing = {
    ...store,
    create: async () => ({ status: 'storage-error' as const }),
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={failing} />);
  });
  await press(tree, 'Scan something');
  expect(alert).toHaveBeenCalledWith(
    'Couldn’t start a scan',
    'The project couldn’t be saved. Your other projects are unchanged.',
  );
  expect(texts(tree)).toContain('Phone case');
  expect(texts(tree)).not.toContain('Project captures');
  await act(async () => tree.unmount());
  alert.mockRestore();
});

test('projects saved with earlier fit data still list and open their scans', async () => {
  const { NativeModules } = require('react-native');
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async () => null,
    cancel: async () => {},
  };
  const legacy = {
    formatVersion: '0.2.0',
    id: 'drawer-study',
    revision: 2,
    brief: { object: 'Kitchen drawer', context: '', addition: 'Tray' },
    fit: {
      schemaVersion: '0.2.0',
      template: 'drawer-tray',
      id: 'drawer-study',
      revision: 1,
    },
    preview: null,
    acceptedArtifact: null,
  };
  const bytes = new Map([['drawer-study', JSON.stringify(legacy)]]);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore(bytes)} />);
    });
    await openProject(tree, 'Kitchen drawer');
    expect(texts(tree)).toContain('Project captures');
    expect(bytes.get('drawer-study')).toBe(JSON.stringify(legacy));
  } finally {
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
  }
});

test('corrupt and future records remain visible alongside healthy projects', async () => {
  const bytes = new Map([
    ['broken', '{'],
    ['future', JSON.stringify({ formatVersion: '99.0' })],
  ]);
  const store = testStore(bytes);
  await store.create({
    id: 'healthy',
    brief: { object: 'Good drawer', context: '', addition: '' },
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  expect(texts(tree)).toContain('Can’t be read');
  expect(texts(tree)).toContain('Needs a newer app');
  expect(texts(tree)).toContain('Good drawer');
  expect(bytes.get('broken')).toBe('{');
});

test('a retained capture leads to scan results and close-ups, and back', async () => {
  const { NativeModules } = require('react-native');
  const store = testStore();
  await store.create({
    id: PROJECT_ID,
    brief: { object: 'Synthetic case', context: 'Desk', addition: 'Stand' },
  });
  const capture = syntheticTarget().capture;
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async () => JSON.stringify({ captures: [capture] }),
    cancel: async () => {},
  };
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(
        <App repository={store} scanServices={services} />,
      );
    });
    await openProject(tree, 'Synthetic case');
    expect(texts(tree)).toContain('Capture 1');
    await press(tree, 'See scan results for capture 1');
    expect(texts(tree)).toContain('Scan results');
    await press(tree, 'Check my scan');
    expect(calls).toContain('start');
    expect(texts(tree)).toContain('Ready');

    await press(tree, 'Add close-up photos');
    expect(texts(tree)).toContain('Close-ups');
    await press(tree, 'Back');
    // Results reopen from the remembered job, without a second start.
    expect(texts(tree)).toContain('Ready');
    expect(calls.filter(c => c === 'start')).toHaveLength(1);

    await press(tree, 'Back');
    expect(texts(tree)).toContain('Project captures');
  } finally {
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
  }
});

test('production wiring drives the real clients through the native bridges', async () => {
  const { NativeModules } = require('react-native');
  const store = testStore();
  await store.create({
    id: PROJECT_ID,
    brief: { object: 'Synthetic case', context: 'Desk', addition: 'Stand' },
  });
  const capture = syntheticTarget().capture;
  const etag = `"${'f'.repeat(64)}"`;
  const history = new Map<string, string>([
    [
      JSON.stringify(['host', PROJECT_ID]),
      JSON.stringify({ captures: [capture] }),
    ],
  ]);
  const requests: string[] = [];
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async (key: string) => history.get(key) ?? null,
    write: async (key: string, value: string) => {
      history.set(key, value);
    },
    cancel: async () => {},
    request: async (o: { method: string; path: string; body?: string }) => {
      requests.push(`${o.method} project`);
      return o.method === 'GET'
        ? { status: 404, body: '{}', etag: '' }
        : { status: 201, body: o.body!, etag };
    },
  };
  const photo = {
    sha256: 'c'.repeat(64),
    byteLength: 2048,
    mediaType: 'image/jpeg',
  };
  const stills: unknown[] = [];
  const statuses = [syntheticJob('running'), syntheticJob('succeeded')];
  NativeModules.StillsProcessingBridge = {
    context: async () => 'host|device',
    cancel: async () => {},
    present: async () => {},
    pickImage: async () => photo,
    request: async (o: {
      method: string;
      path: string;
      etag: string;
      body?: string;
      source?: typeof photo;
      artifact?: object;
    }) => {
      const kind = o.path.includes('/detail-stills') ? 'still' : 'scan';
      // The collection route lists kept checks; none exist yet.
      if (kind === 'scan' && o.artifact) {
        // Verified render downloads for the gallery.
        requests.push('GET artifact');
        return { status: 200, etag, body: '', file: o.artifact };
      }
      if (
        kind === 'scan' &&
        o.method === 'GET' &&
        /\/scan-processing\?/.test(o.path)
      ) {
        requests.push('LIST scan');
        return { status: 200, etag, body: JSON.stringify({ jobs: [] }) };
      }
      requests.push(`${o.method} ${kind}`);
      expect(o.path).toContain('projectRevision=0');
      expect(o.etag).toBe(etag);
      if (kind === 'scan' && o.method === 'POST') {
        const { reference } = JSON.parse(o.body!);
        return {
          status: 202,
          etag,
          body: JSON.stringify({ job: syntheticJob('queued', { reference }) }),
        };
      }
      if (kind === 'scan') {
        return {
          status: 200,
          etag,
          body: JSON.stringify({ job: statuses.shift() }),
        };
      }
      if (o.method === 'POST') {
        const still = stillFrom(o.source!, 0, 'USB-C port');
        stills.push(still);
        return { status: 201, etag, body: JSON.stringify({ still }) };
      }
      return {
        status: 200,
        etag,
        body: JSON.stringify({ captureId: capture.captureId, stills }),
      };
    },
  };
  // Fake only the clock the screen polls with; the clients' promise chains
  // must keep running on real microtasks (Node 22 stalls otherwise).
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'],
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={store} />);
    });
    await openProject(tree, 'Synthetic case');
    await press(tree, 'See scan results for capture 1');
    expect(requests).toEqual(['GET project', 'PUT project', 'LIST scan']);
    await act(async () => {
      tree.root
        .find(
          n =>
            (n.props.accessibilityRole === 'button' ||
              String(n.type) === 'STMActionButton') &&
            (n.props.accessibilityLabel ?? n.props.spokenLabel)?.startsWith(
              'Use AirPods Pro 2 case',
            ) &&
            typeof n.props.onPress === 'function',
        )
        .props.onPress();
    });
    await press(tree, 'Check my scan');
    expect(texts(tree)).toContain('Waiting for your companion');
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
    }
    expect(texts(tree)).toContain('HOW CLOSE IS IT?');
    expect(texts(tree)).toContain('Close');
    expect(requests.filter(r => r === 'GET scan')).toHaveLength(2);

    await press(tree, 'Add close-up photos');
    await press(tree, 'Choose a photo');
    await act(async () => {
      tree.root
        .find(
          n =>
            (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
              'What does photo 1 show?' &&
            typeof n.props.onChangeText === 'function',
        )
        .props.onChangeText('USB-C port');
    });
    await press(tree, 'Add 1 photo to scan');
    expect(texts(tree)).toContain('1 of 24');
    expect(texts(tree)).toContain('USB-C port');
    const from = requests.lastIndexOf('PUT project');
    // Sync, list, upload; then at most a thumbnail read for the new still.
    expect(requests.slice(from, from + 3)).toEqual([
      'PUT project',
      'GET still',
      'POST still',
    ]);
    expect(requests.slice(from + 3).every(r => r === 'GET still')).toBe(true);
  } finally {
    jest.useRealTimers();
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
    delete NativeModules.StillsProcessingBridge;
  }
});

test('real-size edits survive moving to close-ups and back', async () => {
  const { NativeModules, TextInput } = require('react-native');
  const store = testStore();
  await store.create({
    id: PROJECT_ID,
    brief: { object: 'Synthetic case', context: 'Desk', addition: 'Stand' },
  });
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async () => JSON.stringify({ captures: [syntheticTarget().capture] }),
    cancel: async () => {},
  };
  const { services } = fakeScanServices({
    jobs: [
      syntheticJob('succeeded', {
        reference: { dimensionsMm: [60.6, 45.2, 21.7] },
      }),
    ],
  });
  await services.jobs.save(
    PROJECT_ID,
    syntheticTarget().capture.captureId,
    JOB_ID,
  );
  const field = (label: string) =>
    tree.root.find(
      n =>
        n.type === TextInput &&
        (n.props.accessibilityLabel ?? n.props.spokenLabel) === label,
    );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(
        <App repository={store} scanServices={services} />,
      );
    });
    await openProject(tree, 'Synthetic case');
    await press(tree, 'See scan results for capture 1');
    // The job's own reference fills the form until the user edits it.
    expect(field('Height').props.value).toBe('21.7');
    await act(async () => {
      field('Height').props.onChangeText('20');
    });
    expect(texts(tree)).toContain('Somewhat off');

    await press(tree, 'Add close-up photos');
    await press(tree, 'Back');
    expect(field('Height').props.value).toBe('20');
    expect(texts(tree)).toContain('Somewhat off');

    expect(field('Length').props.value).toBe('60.6');
    expect(field('Height').props.value).toBe('20');

    // Clearing is an edit too: reopening does not bring the old sizes back.
    await press(tree, 'Clear real size');
    await press(tree, 'Back');
    await press(tree, 'See scan results for capture 1');
    expect(field('Height').props.value).toBe('');
    expect(texts(tree)).toContain(
      'Add the real size below to see how close your scan is.',
    );
  } finally {
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
  }
});

test('real clients reopen a kept check and upload camera-roll photos by identity', async () => {
  const { NativeModules } = require('react-native');
  const store = testStore();
  await store.create({
    id: PROJECT_ID,
    brief: { object: 'Synthetic case', context: 'Desk', addition: 'Stand' },
  });
  const capture = syntheticTarget().capture;
  const etag = `"${'f'.repeat(64)}"`;
  const history = new Map<string, string>([
    [
      JSON.stringify(['host', PROJECT_ID]),
      JSON.stringify({ captures: [capture] }),
    ],
  ]);
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async (key: string) => history.get(key) ?? null,
    write: async (key: string, value: string) => {
      history.set(key, value);
    },
    cancel: async () => {},
    request: async (o: { method: string; body?: string }) =>
      o.method === 'GET'
        ? { status: 404, body: '{}', etag: '' }
        : { status: 201, body: o.body!, etag },
  };
  const photo = {
    sha256: 'c'.repeat(64),
    byteLength: 2048,
    mediaType: 'image/heic',
    uri: 'file:///app/ScanMediaFiles/picked.heic',
  };
  const sources: object[] = [];
  // A close-up stored on the companion but not on this device yet.
  const stored = stillFrom(
    { sha256: 'd'.repeat(64), byteLength: 3000, mediaType: 'image/jpeg' },
    5,
    'Hinge',
  );
  const stills: unknown[] = [stored];
  const onDevice = new Set<string>([photo.sha256]);
  const kept = syntheticJob('succeeded');
  NativeModules.StillsProcessingBridge = {
    context: async () => 'host|device',
    cancel: async () => {},
    present: async () => {},
    // Like StillsProcessingBridge: a cache miss rejects.
    imageUri: async (file: { sha256: string }) => {
      if (!onDevice.has(file.sha256)) {
        throw Object.assign(Error('Not on this device.'), {
          code: 'verification-failed',
        });
      }
      return `file:///app/ScanMediaFiles/${file.sha256.slice(0, 8)}`;
    },
    pickImages: async (limit: number) => {
      expect(limit).toBe(23); // one close-up is already stored
      return {
        photos: [photo],
        rejected: [{ reason: 'too-large', byteLength: 30_000_000 }],
      };
    },
    request: async (o: {
      method: string;
      path: string;
      etag: string;
      source?: object;
      artifact?: object;
    }) => {
      expect(o.etag).toBe(etag);
      if (o.artifact) {
        // A verified download leaves the bytes on the device.
        onDevice.add((o.artifact as { sha256: string }).sha256);
        return { status: 200, etag, body: '', file: o.artifact };
      }
      if (o.path.includes('/detail-stills')) {
        if (o.method === 'POST') {
          sources.push(o.source!);
          const still = stillFrom(photo, 0);
          stills.push(still);
          return { status: 201, etag, body: JSON.stringify({ still }) };
        }
        return {
          status: 200,
          etag,
          body: JSON.stringify({ captureId: capture.captureId, stills }),
        };
      }
      // The collection route lists every kept check after a relaunch.
      return {
        status: 200,
        etag,
        body: JSON.stringify({ jobs: [kept] }),
      };
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={store} />);
    });
    await openProject(tree, 'Synthetic case');
    await press(tree, 'See scan results for capture 1');
    expect(texts(tree)).toContain('Ready');
    expect(
      tree.root.findAll(
        n =>
          n.props.source?.uri ===
          `file:///app/ScanMediaFiles/${'09'.repeat(4)}`,
      ).length,
    ).toBeGreaterThan(0);

    await press(tree, 'Add close-up photos');
    // The stored close-up's lookup rejects, so it's downloaded, then shown.
    expect(
      tree.root.findAll(
        n =>
          n.props.source?.uri === `file:///app/ScanMediaFiles/${'d'.repeat(8)}`,
      ).length,
    ).toBeGreaterThan(0);
    await press(tree, 'Choose a photo');
    expect(
      texts(tree).some(t =>
        t.includes('1 photo wasn’t added: 1 is over 25 MB'),
      ),
    ).toBe(true);
    await press(tree, 'Add 1 photo to scan');
    // The display path stays on the phone; only the identity is sent.
    expect(sources).toEqual([
      { sha256: photo.sha256, byteLength: 2048, mediaType: 'image/heic' },
    ]);
    expect(Object.keys(sources[0]).sort()).toEqual([
      'byteLength',
      'mediaType',
      'sha256',
    ]);
    expect(texts(tree)).toContain('2 of 24');
  } finally {
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
    delete NativeModules.StillsProcessingBridge;
  }
});

test('opening close-ups waits for a gallery download the results screen left running', async () => {
  const { NativeModules } = require('react-native');
  const store = testStore();
  await store.create({
    id: PROJECT_ID,
    brief: { object: 'Synthetic case', context: 'Desk', addition: 'Stand' },
  });
  NativeModules.RetainedCaptureBridge = {
    context: async () => 'host|device',
    read: async () => JSON.stringify({ captures: [syntheticTarget().capture] }),
    cancel: async () => {},
  };
  const { services } = fakeScanServices({ jobs: [syntheticJob('succeeded')] });
  await services.jobs.save(
    PROJECT_ID,
    syntheticTarget().capture.captureId,
    JOB_ID,
  );
  // The native bridge serves one request at a time: record any overlap.
  let active = 0;
  const overlaps: string[] = [];
  const track =
    <A extends unknown[], R>(name: string, call: (...a: A) => Promise<R>) =>
    async (...args: A) => {
      if (active) overlaps.push(name);
      active++;
      try {
        return await call(...args);
      } finally {
        active--;
      }
    };
  let release!: () => void;
  let held = false;
  const download = services.processing.downloadArtifact;
  services.processing.downloadArtifact = track('download', (...args) => {
    if (held) return download(...args);
    held = true;
    return new Promise(resolve => {
      release = () => resolve(download(...args));
    });
  });
  services.acknowledge = track('acknowledge', services.acknowledge);
  services.processing.status = track('status', services.processing.status);
  services.stills.list = track('list stills', services.stills.list);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(
        <App repository={store} scanServices={services} />,
      );
    });
    await openProject(tree, 'Synthetic case');
    await press(tree, 'See scan results for capture 1');
    expect(held).toBe(true);
    await press(tree, 'Add close-up photos');
    expect(overlaps).toEqual([]);
    await act(async () => release());
    expect(overlaps).toEqual([]);
    expect(texts(tree)).toContain('0 of 24');
  } finally {
    if (tree) await act(async () => tree.unmount());
    delete NativeModules.RetainedCaptureBridge;
  }
});

test('a scantomake://pair link opens Find your Mac', async () => {
  const link =
    'scantomake://pair?v=1&u=https%3A%2F%2Fhost.example.ts.net&c=' +
    'Q'.repeat(32) +
    '&e=' +
    (Date.now() + 300_000);
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(link);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore()} />);
  });
  expect(texts(tree)).toContain(
    'Pairing with your Mac works in the iPhone and iPad app.',
  );
  await act(async () => tree.unmount());
  jest.restoreAllMocks();
});

test('a pairing link delivered twice at launch pairs only once', async () => {
  const link =
    'scantomake://pair?v=1&u=https%3A%2F%2Fhost.example.ts.net&c=' +
    'Q'.repeat(32) +
    '&e=' +
    (Date.now() + 300_000);
  const handlers: ((event: { url: string }) => void)[] = [];
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(link);
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (event: { url: string }) => void,
  ) => {
    handlers.push(handler);
    return { remove: () => {} };
  }) as never);
  const pair = jest.fn(
    () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              state: 'paired',
              baseUrl: 'https://host.example.ts.net',
            }),
          0,
        ),
      ),
  );
  const native = require('react-native').NativeModules;
  native.CompanionPairing = {
    status: async () => ({ state: 'disconnected' }),
    pair,
    check: async () => ({ state: 'paired' }),
    disconnect: async () => ({ state: 'disconnected' }),
    cancel: async () => {},
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore()} />);
  });
  await act(async () => {
    handlers.forEach(handler => handler({ url: link }));
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  });
  try {
    expect(pair).toHaveBeenCalledTimes(1);
    // The repeat is dropped, not held as a second link to replace the pairing.
    expect(texts(tree).join(' ')).not.toContain('Pair with another Mac?');
    expect(texts(tree).join(' ')).toContain('Connected to your Mac');
    // The phone is paired now, as the native pairing reports.
    native.CompanionPairing.status = async () => ({
      state: 'paired',
      baseUrl: 'https://host.example.ts.net',
    });
    await press(tree, 'Open projects');
    expect(texts(tree).join(' ')).toContain('Projects');
    // Opening the same link again later is a deliberate retry, and asks first.
    pair.mockClear();
    const later = Date.now() + 5000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await act(async () => {
      handlers.forEach(handler => handler({ url: link }));
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    });
    expect(texts(tree).join(' ')).toContain('Pair with another Mac?');
    expect(pair).not.toHaveBeenCalled();
  } finally {
    await act(async () => tree.unmount());
    delete native.CompanionPairing;
    jest.restoreAllMocks();
  }
});

test('a create that throws still lets you try again', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const store = testStore();
  const failing = {
    ...store,
    create: async () => {
      throw Error('disk gone');
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={failing} />);
  });
  await press(tree, 'Scan something');
  await press(tree, 'Scan something');
  expect(alert).toHaveBeenCalledTimes(2);
  expect(alert).toHaveBeenLastCalledWith(
    'Couldn’t start a scan',
    'The project couldn’t be saved. Your other projects are unchanged.',
  );
  await act(async () => tree.unmount());
  alert.mockRestore();
});

test('with no Mac paired the app opens on Find your Mac; otherwise on Projects', async () => {
  const native = require('react-native').NativeModules;
  const cases: [() => Promise<unknown>, string][] = [
    [
      async () => ({ state: 'disconnected' }),
      'Point at the code in Scan to Make on your Mac',
    ],
    [
      async () => ({ state: 'expired' }),
      'Point at the code in Scan to Make on your Mac',
    ],
    [
      async () => ({ state: 'paired', baseUrl: 'https://mac.example.ts.net' }),
      'Scan your first thing',
    ],
    // A pairing that can't be read never locks anyone out of their projects.
    [
      async () => {
        throw { code: 'secure-storage' };
      },
      'Scan your first thing',
    ],
  ];
  try {
    for (const [status, shown] of cases) {
      native.CompanionPairing = {
        status,
        pair: jest.fn(),
        check: async () => ({ state: 'paired' }),
        disconnect: jest.fn(),
        cancel: async () => {},
      };
      let tree!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        tree = ReactTestRenderer.create(<App repository={testStore()} />);
      });
      expect(texts(tree)).toContain(shown);
      await act(async () => tree.unmount());
    }
  } finally {
    delete native.CompanionPairing;
  }
});

const macLink = () =>
  `scantomake://pair?${new URLSearchParams({
    v: '1',
    u: 'https://mac.example.ts.net',
    c: 'Q'.repeat(32),
    e: String(Date.now() + 300_000),
  })}`;
const viewfinders = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n => String(n.type) === 'STMQRScannerView');
// Linking.getInitialURL is React Native's own jest.fn, so a value set by an
// earlier test outlives restoreAllMocks. Say what each launch opens with.
const launchLink = (url: string | null) =>
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(url as string);

test('Scan something after pairing opens the camera once, not on every return home', async () => {
  const { NativeModules } = require('react-native');
  const mac = { state: 'paired', baseUrl: 'https://mac.example.ts.net' };
  let paired = false;
  NativeModules.CompanionPairing = {
    status: async () => (paired ? mac : { state: 'disconnected' }),
    pair: jest.fn(async () => {
      paired = true;
      return mac;
    }),
    check: async () => mac,
    disconnect: jest.fn(),
    cancel: async () => {},
  };
  launchLink(null);
  // A LiDAR iPhone, so Connected offers Scan something.
  const start = scanner();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await act(async () =>
      viewfinders(tree)[0].props.onCode({ nativeEvent: { value: macLink() } }),
    );
    expect(texts(tree)).toContain('Connected to your Mac');
    // A double tap still scans once.
    await press(tree, 'Scan something', 2);
    await act(async () => new Promise<void>(done => setTimeout(done, 20)));
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => nameField(tree).props.onChangeText('Mug'));
    await press(tree, 'Continue');
    await press(tree, 'Back');
    // Home unmounts for Settings; coming back must not scan again.
    await press(tree, 'Settings');
    await press(tree, 'Back');
    expect(texts(tree)).toContain('Mug');
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => tree.unmount());
    delete NativeModules.CompanionPairing;
    noScanner();
    jest.restoreAllMocks();
  }
});

test('pairing another Mac from Settings comes back to Settings', async () => {
  const { NativeModules } = require('react-native');
  const mac = { state: 'paired', baseUrl: 'https://mac.example.ts.net' };
  NativeModules.CompanionPairing = {
    status: async () => mac,
    pair: jest.fn(async () => mac),
    check: async () => mac,
    disconnect: jest.fn(),
    cancel: async () => {},
  };
  launchLink(null);
  // Confirms "Pair another Mac?".
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.[1]?.onPress?.(),
    );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await press(tree, 'Settings');
    await press(tree, 'Pair or forget your Mac');
    await press(tree, 'Pair another Mac');
    await act(async () =>
      viewfinders(tree)[0].props.onCode({ nativeEvent: { value: macLink() } }),
    );
    expect(texts(tree)).toContain('Connected to your Mac');
    expect(texts(tree)).not.toContain('Open projects');
    await press(tree, 'Done');
    expect(texts(tree)).toContain('About Scan to Make');
    expect(viewfinders(tree)).toHaveLength(0);
  } finally {
    await act(async () => tree.unmount());
    delete NativeModules.CompanionPairing;
    jest.restoreAllMocks();
  }
});

test('a link at launch, before the pairing is read, runs one camera only', async () => {
  const { NativeModules } = require('react-native');
  // The pairing is read after the link arrives, so the sheet opens first.
  NativeModules.CompanionPairing = {
    status: () =>
      new Promise(resolve =>
        setTimeout(() => resolve({ state: 'disconnected' }), 10),
      ),
    pair: () => new Promise(() => {}),
    check: jest.fn(),
    disconnect: jest.fn(),
    cancel: async () => {},
  };
  launchLink(macLink());
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await act(
      async () => new Promise<void>(resolve => setTimeout(resolve, 30)),
    );
    // Find your Mac is the first screen and the sheet is over it.
    expect(viewfinders(tree)).toHaveLength(2);
    expect(viewfinders(tree).filter(v => v.props.active).length).toBe(0);
  } finally {
    await act(async () => tree.unmount());
    delete NativeModules.CompanionPairing;
    launchLink(null);
    jest.restoreAllMocks();
  }
});

test('a link after forgetting the Mac in Settings still reaches Find your Mac', async () => {
  const { NativeModules } = require('react-native');
  const mac = { state: 'paired', baseUrl: 'https://mac.example.ts.net' };
  let paired = true;
  NativeModules.CompanionPairing = {
    status: async () => (paired ? mac : { state: 'disconnected' }),
    pair: jest.fn(async () => {
      paired = true;
      return mac;
    }),
    check: async () => mac,
    disconnect: jest.fn(async () => {
      paired = false;
      return { state: 'disconnected' };
    }),
    cancel: async () => {},
  };
  launchLink(null);
  const handlers: ((event: { url: string }) => void)[] = [];
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (event: { url: string }) => void,
  ) => {
    handlers.push(handler);
    return { remove: () => {} };
  }) as never);
  // Confirms "Forget this Mac?".
  jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) =>
      buttons?.[1]?.onPress?.(),
    );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await press(tree, 'Settings');
    await press(tree, 'Pair or forget your Mac');
    await press(tree, 'Forget this Mac');
    await act(async () => {});
    // Close the sheet: Settings stays on screen, and nothing is paired now.
    await act(async () => tree.root.findByType(Modal).props.onRequestClose());
    expect(texts(tree)).toContain('About Scan to Make');
    expect(viewfinders(tree)).toHaveLength(0);
    await act(async () => {
      handlers.forEach(handler => handler({ url: macLink() }));
    });
    expect(NativeModules.CompanionPairing.pair).toHaveBeenCalledTimes(1);
    expect(texts(tree)).toContain('Connected to your Mac');
  } finally {
    await act(async () => tree.unmount());
    delete NativeModules.CompanionPairing;
    jest.restoreAllMocks();
  }
});

test('the credential refresh at launch waits its turn with the Mac check, so the pill is right', async () => {
  const { NativeModules } = require('react-native');
  // As on iOS: one request to the Mac at a time, or "busy".
  let inFlight = false;
  const one = () =>
    new Promise((resolve, reject) => {
      if (inFlight) return reject({ code: 'busy' });
      inFlight = true;
      setTimeout(() => {
        inFlight = false;
        resolve(mac);
      }, 5);
    });
  const mac = {
    state: 'paired',
    baseUrl: 'https://mac.example.ts.net',
    expiresAt: Date.now() + 3 * 86_400_000,
  };
  const refresh = jest.fn(one);
  NativeModules.CompanionPairing = {
    status: async () => mac,
    pair: jest.fn(),
    check: jest.fn(one),
    refresh,
    disconnect: jest.fn(),
    cancel: async () => {},
  };
  launchLink(null);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await act(async () => new Promise<void>(done => setTimeout(done, 40)));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(texts(tree)).not.toContain('Pair again');
  } finally {
    await act(async () => tree.unmount());
    delete NativeModules.CompanionPairing;
    jest.restoreAllMocks();
  }
});

test('Scan something tapped twice during a slow reload makes one project and opens the camera once', async () => {
  const start = scanner();
  const bytes = new Map<string, string>();
  const store = testStore(bytes);
  let slow = false;
  const slowStore = {
    ...store,
    list: async () => {
      if (slow) await new Promise<void>(done => setTimeout(done, 30));
      return store.list();
    },
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={slowStore} />);
    });
    slow = true;
    // A double tap, then another tap once the project exists but the list
    // is still reloading.
    await press(tree, 'Scan something', 2);
    await act(async () => new Promise<void>(done => setTimeout(done, 10)));
    await press(tree, 'Scan something');
    await act(async () => new Promise<void>(done => setTimeout(done, 150)));
    expect(bytes.size).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(texts(tree)).toContain('Scan finished');
  } finally {
    if (tree) await act(async () => tree.unmount());
    noScanner();
  }
});
