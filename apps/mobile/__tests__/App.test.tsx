/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Share, Text } from 'react-native';
import App from '../App';
import { mockCaptureSource } from '../src/capture/captureSource';
import { cupWidthPatch } from '../src/fit/fitDraft';
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
import { SpikeScreen } from '../src/screens/SpikeScreen';
import { RUN_TARGET_MS, SAMPLE_INTERVAL_MS } from '../src/spike/useSpikeRun';

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

function press(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const button = tree.root.find(
    n =>
      n.props.accessibilityRole === 'button' &&
      typeof n.props.onPress === 'function' &&
      (n.props.accessibilityLabel === label ||
        n.findAllByType(Text).some(t => t.props.children === label)),
  );
  return act(async () => {
    button.props.onPress();
  });
}

test('home renders and navigates to capture', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore()} />);
  });
  expect(texts(tree)).toContain('Make it fit.');
  await press(tree, 'Open cup-holder example');
  expect(texts(tree)).toContain('Measure the fit.');
});

async function reachPreview(
  store = testStore(),
  values: Record<string, string> = {
    'Holder top, millimetres': '62',
    'Holder bottom, millimetres': '58',
    'Holder depth, millimetres': '35',
    'Cup width, millimetres': '86',
  },
) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  await press(tree, 'Open cup-holder example');
  for (const [label, value] of Object.entries(values)) {
    const input = tree.root.find(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onChangeText === 'function',
    );
    await act(async () => input.props.onChangeText(value));
  }
  await press(tree, 'Review measurements');
  return tree;
}

function pressWider(tree: ReactTestRenderer.ReactTestRenderer) {
  const wider = tree.root.find(
    n =>
      n.props.accessibilityLabel === 'Wider cup, 1 millimetre' &&
      typeof n.props.onPress === 'function',
  );
  return act(async () => wider.props.onPress());
}

test('confirmed measurements become a FitSpec revision with an editable cup width', async () => {
  const store = testStore();
  const tree = await reachPreview(store);
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['Your design study', 'Revision 0', '86 mm']),
  );
  await pressWider(tree);
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['Revision 1', '87 mm', '62 mm']),
  );
  expect((await onlyProject(store)).fit?.revision).toBe(1);
});

test('a stale preview edit is rejected and the latest revision is shown', async () => {
  const store = testStore();
  const tree = await reachPreview(store);
  const elsewhere = await onlyProject(store);
  if (elsewhere.fit?.template !== 'cup-holder-adapter') {
    throw new Error('Wrong fit');
  }
  await store.change(elsewhere.id, elsewhere.revision, {
    kind: 'patch-fit',
    patch: cupWidthPatch(elsewhere.fit, 4),
  });

  await pressWider(tree);
  const shown = texts(tree);
  expect(shown).toEqual(expect.arrayContaining(['Revision 1', '90 mm']));
  expect(shown.some(t => t.startsWith('This preview was out of date'))).toBe(
    true,
  );
  expect(
    (
      (await onlyProject(store))
        .fit as import('@scan-to-make/contracts').FitSpec
    ).dimensions.cupOuterDiameter.nominalMm,
  ).toBe(90);
});

test('spike harness runs a mock session to an inconclusive report', async () => {
  jest.useFakeTimers();
  try {
    const source = mockCaptureSource({ timeScale: 1 });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <SpikeScreen onBack={() => {}} sourceOverride={source} />,
      );
    });
    await press(tree, 'Start 2-minute run');
    await act(async () => {
      jest.advanceTimersByTime(RUN_TARGET_MS + SAMPLE_INTERVAL_MS);
    });
    const shown = texts(tree);
    expect(shown).toContain('Result');
    expect(shown).toContain('Run again');
    expect(shown).not.toContain('Pass');
  } finally {
    jest.useRealTimers();
  }
});

test('project brief requires object, surroundings and addition before review', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore()} />);
  });
  await press(tree, 'Describe a project');
  const review = () =>
    tree.root.find(
      n =>
        n.props.accessibilityRole === 'button' &&
        typeof n.props.onPress === 'function' &&
        (n.props.accessibilityLabel === 'Review brief' ||
          n.findAllByType(Text).some(t => t.props.children === 'Review brief')),
    );
  expect(review().props.disabled).toBe(true);
  const fields = [
    'What are you working with?',
    'What’s around it?',
    'What would you like to add?',
  ];
  for (const [index, label] of fields.entries()) {
    await act(async () =>
      tree.root
        .find(
          n =>
            n.props.accessibilityLabel === label &&
            typeof n.props.onChangeText === 'function',
        )
        .props.onChangeText(index === 2 ? '   ' : 'A useful detail'),
    );
  }
  expect(review().props.disabled).toBe(true);
  await act(async () =>
    tree.root
      .find(
        n =>
          n.props.accessibilityLabel === fields[2] &&
          typeof n.props.onChangeText === 'function',
      )
      .props.onChangeText('A removable organizer'),
  );
  expect(review().props.disabled).toBe(false);
});

test('a generic brief survives navigation, edits and shares independently of the cup example', async () => {
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<App repository={testStore()} />);
    });
    await press(tree, 'Describe a project');
    const entries = {
      'What are you working with?': 'Coffee drawer',
      'What’s around it?': 'Shallow drawer with loose filters',
      'What would you like to add?': 'A removable organizer',
    };
    for (const [label, value] of Object.entries(entries)) {
      await act(async () =>
        tree.root
          .find(
            n =>
              n.props.accessibilityLabel === label &&
              typeof n.props.onChangeText === 'function',
          )
          .props.onChangeText(value),
      );
    }
    await press(tree, 'Review brief');
    await press(tree, 'Back');
    await press(tree, 'Open brief for Coffee drawer');
    expect(texts(tree)).toContain('A removable organizer');
    await press(tree, 'Edit idea');
    const addition = tree.root.find(
      n =>
        n.props.accessibilityLabel === 'What would you like to add?' &&
        typeof n.props.onChangeText === 'function',
    );
    expect(addition.props.value).toBe('A removable organizer');
    await act(async () =>
      addition.props.onChangeText('An organizer with two sections'),
    );
    await press(tree, 'Review brief');
    await press(tree, 'Share brief');
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('An organizer with two sections'),
      }),
    );
    expect(share.mock.calls[0][0].message).toContain(
      'Shallow drawer with loose filters',
    );
    expect(share.mock.calls[0][0].message).toContain(
      'no scan, generated geometry or fit verification',
    );
    await press(tree, 'Edit idea');
    await act(async () =>
      tree.root
        .find(
          n =>
            n.props.accessibilityLabel === 'What are you working with?' &&
            typeof n.props.onChangeText === 'function',
        )
        .props.onChangeText(''),
    );
    await press(tree, 'Back');
    await press(tree, 'Open brief for Untitled project');
    expect(
      tree.root.find(
        n =>
          n.props.accessibilityLabel === 'What are you working with?' &&
          typeof n.props.onChangeText === 'function',
      ).props.value,
    ).toBe('');
    expect(texts(tree)).toContain('What could work better?');
  } finally {
    share.mockRestore();
  }
});

async function changeText(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
  value: string,
) {
  await act(async () =>
    tree.root
      .find(
        n =>
          n.props.accessibilityLabel === label &&
          typeof n.props.onChangeText === 'function',
      )
      .props.onChangeText(value),
  );
}

test('incomplete drafts and edits reopen through a new app and repository instance', async () => {
  const bytes = new Map<string, string>();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore(bytes)} />);
  });
  await press(tree, 'Describe a project');
  await changeText(tree, 'What are you working with?', '  Coffee drawer  ');
  await press(tree, 'Save draft');
  expect(texts(tree)).toContain('Saved on this device');
  await act(async () => tree.unmount());
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={testStore(bytes)} />);
  });
  await press(tree, 'Your saved projects');
  await press(tree, 'Open Coffee drawer');
  expect(
    tree.root.find(
      n =>
        n.props.accessibilityLabel === 'What are you working with?' &&
        n.props.onChangeText,
    ).props.value,
  ).toBe('  Coffee drawer  ');
  await changeText(tree, 'What’s around it?', 'Shallow');
  await press(tree, 'Save draft');
  const project = await onlyProject(testStore(bytes));
  expect(project.brief).toEqual({
    object: '  Coffee drawer  ',
    context: 'Shallow',
    addition: '',
  });
  expect(project.fit).toBeNull();
  expect(project.revision).toBe(1);
});

test('stale brief saves retain draft and newer bytes; saving a copy leaves the original intact', async () => {
  const bytes = new Map<string, string>();
  const store = testStore(bytes);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  await press(tree, 'Describe a project');
  await changeText(tree, 'What are you working with?', 'Drawer');
  await press(tree, 'Save draft');
  const old = await onlyProject(store);
  await store.change(old.id, old.revision, {
    kind: 'replace-brief',
    brief: { ...old.brief, object: 'Newer drawer' },
  });
  const newerBytes = bytes.get(old.id);
  await changeText(tree, 'What are you working with?', 'My unsaved drawer');
  await press(tree, 'Save draft');
  expect(
    texts(tree).some(t => t.startsWith('A newer saved version exists')),
  ).toBe(true);
  expect(
    tree.root.find(
      n =>
        n.props.accessibilityLabel === 'What are you working with?' &&
        n.props.onChangeText,
    ).props.value,
  ).toBe('My unsaved drawer');
  expect(bytes.get(old.id)).toBe(newerBytes);
  await press(tree, 'Save draft as separate project');
  expect(bytes.size).toBe(2);
  expect(bytes.get(old.id)).toBe(newerBytes);
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
    fit: null,
  });
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  await press(tree, 'Your saved projects');
  expect(texts(tree)).toContain('This project couldn’t be read.');
  expect(texts(tree)).toContain('This project needs a newer app.');
  await press(tree, 'Open Good drawer');
  expect(texts(tree)).toContain('What could work better?');
  expect(bytes.get('broken')).toBe('{');
});

test('hydration blocks edits and a failed save retains text without a saved claim', async () => {
  const store = testStore();
  let release!: (value: Awaited<ReturnType<typeof store.list>>) => void;
  const delayed = new Promise<Awaited<ReturnType<typeof store.list>>>(
    resolve => {
      release = resolve;
    },
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <App
        repository={{
          ...store,
          list: () => delayed,
          create: async () => ({ status: 'storage-error' }),
        }}
      />,
    );
  });
  expect(texts(tree)).toContain('Loading saved data…');
  expect(texts(tree)).not.toContain('Describe a project');
  await act(async () => release({ status: 'ok', entries: [] }));
  await press(tree, 'Describe a project');
  await changeText(tree, 'What are you working with?', 'Unsaved idea');
  await press(tree, 'Save draft');
  expect(texts(tree).some(t => t.startsWith('Couldn’t confirm the save'))).toBe(
    true,
  );
  expect(texts(tree)).not.toContain('Saved on this device');
  expect(
    tree.root.find(
      n =>
        n.props.accessibilityLabel === 'What are you working with?' &&
        n.props.onChangeText,
    ).props.value,
  ).toBe('Unsaved idea');
});

test('a measured project reopens with provenance and protected edits preserve its brief', async () => {
  const store = testStore();
  let tree = await reachPreview(store);
  const original = await onlyProject(store);
  await act(async () => tree.unmount());
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  await press(tree, 'Your saved projects');
  await press(tree, 'Open Cup holder & cup');
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['62 mm', '58 mm', '35 mm', '86 mm']),
  );
  await press(tree, 'Edit measurements');
  await changeText(tree, 'Holder top, millimetres', '63');
  await press(tree, 'Review measurements');
  const next = await onlyProject(store);
  expect(next.brief).toEqual(original.brief);
  expect(next.revision).toBe(original.revision + 1);
  expect(next.fit?.revision).toBe(original.fit!.revision + 1);
  if (next.fit?.template !== 'cup-holder-adapter') {
    throw new Error('Wrong template');
  }
  expect(next.fit.dimensions.holderInnerTopDiameter.nominalMm).toBe(63);
  expect(next.fit.dimensions.holderInnerTopDiameter.source).toBe('manual');
  expect(next.fit.dimensions.cupOuterDiameter).toEqual(
    (original.fit as import('@scan-to-make/contracts').FitSpec).dimensions
      .cupOuterDiameter,
  );
});

const firstMeasurements = {
  'Holder top, millimetres': '70',
  'Holder bottom, millimetres': '60',
  'Holder depth, millimetres': '40',
  'Cup width, millimetres': '90',
};

test('first measured save is one create containing user dimensions, with no intermediate seed write', async () => {
  const bytes = new Map<string, string>();
  const cas = jest.fn(
    async (id: string, expected: string | null, next: string) => {
      if (expected !== null) {
        throw new Error('Updates unavailable');
      }
      if (bytes.has(id)) {
        return false;
      }
      bytes.set(id, next);
      return true;
    },
  );
  const store = createSavedProjects({
    listIds: async () => [...bytes.keys()],
    read: async id => bytes.get(id) ?? null,
    compareAndSwap: cas,
  });
  let tree = await reachPreview(store, firstMeasurements);
  expect(texts(tree)).toContain('Your design study');
  expect(cas).toHaveBeenCalledTimes(1);
  const saved = await onlyProject(store);
  expect(saved.fit?.template).toBe('cup-holder-adapter');
  if (saved.fit?.template !== 'cup-holder-adapter') {
    throw new Error('Wrong template');
  }
  const keys = [
    'holderInnerTopDiameter',
    'holderInnerBottomDiameter',
    'insertionDepth',
    'cupOuterDiameter',
  ] as const;
  keys.forEach((key, index) => {
    expect(
      (saved.fit as import('@scan-to-make/contracts').FitSpec).dimensions[key]
        .nominalMm,
    ).toBe([70, 60, 40, 90][index]);
    expect(
      (saved.fit as import('@scan-to-make/contracts').FitSpec).dimensions[key]
        .sourceId,
    ).toMatch(/^manual-entry-/);
  });
  await act(async () => tree.unmount());
  await act(async () => {
    tree = ReactTestRenderer.create(<App repository={store} />);
  });
  await press(tree, 'Your saved projects');
  await press(tree, 'Open Cup holder & cup');
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['70 mm', '60 mm', '40 mm', '90 mm']),
  );
});

test('failed first measured create leaves no synthetic project, retains entries and can retry', async () => {
  const bytes = new Map<string, string>();
  let fail = true;
  const store = createSavedProjects({
    listIds: async () => [...bytes.keys()],
    read: async id => bytes.get(id) ?? null,
    compareAndSwap: async (id, expected, next) => {
      if (fail) {
        throw new Error('Disk unavailable');
      }
      if ((bytes.get(id) ?? null) !== expected) {
        return false;
      }
      bytes.set(id, next);
      return true;
    },
  });
  const tree = await reachPreview(store, firstMeasurements);
  expect(bytes.size).toBe(0);
  expect(
    texts(tree).some(t =>
      t.startsWith('These measurements could not be saved'),
    ),
  ).toBe(true);
  for (const [label, value] of Object.entries(firstMeasurements)) {
    expect(
      tree.root.find(
        n => n.props.accessibilityLabel === label && n.props.onChangeText,
      ).props.value,
    ).toBe(value);
  }
  fail = false;
  await press(tree, 'Review measurements');
  expect(texts(tree)).toContain('Your design study');
  expect(bytes.size).toBe(1);
});

test('drawer study saves edited reference sizes once, reopens, and keeps a general brief', async () => {
  const store = testStore();
  await store.create({id: 'general', fit: null, brief: {object: 'Kitchen drawer', context: 'Under the counter', addition: 'Tea compartments'}});
  const loaded = await store.load('general');
  if (loaded.status !== 'ok') throw new Error('load');
  const { DrawerScreen } = require('../src/screens/DrawerScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {tree = ReactTestRenderer.create(<DrawerScreen initial={loaded.project} repository={store} onProject={() => {}} onBack={() => {}} />);});
  const input = tree.root.find(n => n.props.accessibilityLabel === 'Drawer width, millimetres' && typeof n.props.onChangeText === 'function');
  await act(async () => input.props.onChangeText('320'));
  await press(tree, 'Add divider across');
  await press(tree, 'Save drawer sizes');
  const saved = await onlyProject(store);
  expect(saved.brief).toEqual(loaded.project.brief);
  expect(saved.fit?.template).toBe('drawer-tray');
  expect(saved.fit?.revision).toBe(0);
  expect(saved.revision).toBe(1);
  if (saved.fit?.template !== 'drawer-tray') throw new Error('drawer');
  expect(saved.fit.dimensions.drawerInnerWidth.nominalMm).toBe(320);
  expect(saved.fit.dimensions.drawerInnerWidth.source).toBe('reference');
  expect(saved.fit.parameters.dividersAcross).toBe(3);
  expect(saved.preview).toBeNull();
  await act(async () => tree.unmount());
  await act(async () => {tree = ReactTestRenderer.create(<DrawerScreen initial={saved} repository={store} onProject={() => {}} onBack={() => {}} />);});
  expect(tree.root.find(n => n.props.accessibilityLabel === 'Drawer width, millimetres' && typeof n.props.onChangeText === 'function').props.value).toBe('320');
});

test('failed first drawer save leaves no synthetic seed and retains entered sizes', async () => {
  const store = testStore();
  const failed = {...store, create: jest.fn(async () => ({status: 'storage-error' as const}))};
  const { DrawerScreen } = require('../src/screens/DrawerScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {tree = ReactTestRenderer.create(<DrawerScreen initial={null} repository={failed} onProject={() => {}} onBack={() => {}} />);});
  const input = tree.root.find(n => n.props.accessibilityLabel === 'Drawer width, millimetres' && typeof n.props.onChangeText === 'function');
  await act(async () => input.props.onChangeText('321'));
  await press(tree, 'Save drawer sizes');
  expect((await store.list())).toEqual({status:'ok',entries:[]});
  expect(input.props.value).toBe('321');
  expect(texts(tree)).toContain('These sizes could not be saved. Your entries are still here.');
});


async function returnToBriefAfterDrawerSave() {
  const store = testStore();
  await store.create({id: 'navigation-project', fit: null, brief: {
    object: 'Kitchen drawer', context: 'Under counter', addition: 'Tea compartments',
  }});
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { tree = ReactTestRenderer.create(<App repository={store} />); });
  await press(tree, 'Your saved projects');
  await press(tree, 'Open Kitchen drawer');
  await press(tree, 'Try a drawer design study');
  const width = tree.root.find(n => n.props.accessibilityLabel === 'Drawer width, millimetres' && typeof n.props.onChangeText === 'function');
  await act(async () => width.props.onChangeText('321'));
  await press(tree, 'Save drawer sizes');
  await press(tree, 'Back');
  await press(tree, 'Open brief for Kitchen drawer');
  return {tree, store};
}

test('returning through the brief reopens the saved drawer sizes', async () => {
  const {tree, store} = await returnToBriefAfterDrawerSave();
  await press(tree, 'Try a drawer design study');
  expect(tree.root.find(n => n.props.accessibilityLabel === 'Drawer width, millimetres' && typeof n.props.onChangeText === 'function').props.value).toBe('321');
  await press(tree, 'Add divider across');
  await press(tree, 'Save drawer sizes');
  await press(tree, 'Back');
  await press(tree, 'Open brief for Kitchen drawer');
  await press(tree, 'Try a drawer design study');
  const saved = await onlyProject(store);
  expect(saved.fit?.revision).toBe(1);
  expect(saved.revision).toBe(2);
  expect(texts(tree)).toContain('3');
});

test('brief edits after drawer attachment save at the current revision and preserve the fit', async () => {
  const {tree, store} = await returnToBriefAfterDrawerSave();
  const before = await onlyProject(store);
  await press(tree, 'Edit idea');
  const addition = tree.root.find(n => n.props.accessibilityLabel === 'What would you like to add?' && typeof n.props.onChangeText === 'function');
  await act(async () => addition.props.onChangeText('Tea and coffee compartments'));
  await press(tree, 'Save draft');
  const after = await onlyProject(store);
  expect(after.brief.addition).toBe('Tea and coffee compartments');
  expect(after.fit).toEqual(before.fit);
  expect(after.revision).toBe(before.revision + 1);
  expect(texts(tree)).toContain('Saved on this device');
});
