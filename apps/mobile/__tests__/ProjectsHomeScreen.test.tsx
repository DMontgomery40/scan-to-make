import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ListProjectsResult } from '@scan-to-make/contracts/saved-project';
import { POLL_MS, ProjectsHomeScreen } from '../src/screens/ProjectsHomeScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import type { CompanionNative } from '../src/companion/pairing';
import type { ProjectOverview } from '../src/screens/projectOverview';
import {
  fakeScanServices,
  syntheticJob,
} from '../src/screens/testing/fakeScanServices';

type Tree = Renderer.ReactTestRenderer;
const texts = (tree: Tree) =>
  [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ].join('\n');
const buttons = (tree: Tree) =>
  tree.root.findAll(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      typeof n.props.onPress === 'function',
    { deep: false },
  );
const labelled = (tree: Tree, label: string) =>
  buttons(tree).filter(
    n => (n.props.accessibilityLabel ?? n.props.spokenLabel) === label,
  );

const project = (id: string, object: string) => ({
  formatVersion: '0.2.0' as const,
  id,
  revision: 0,
  brief: { object, context: '', addition: '' },
  fit: null,
  preview: null,
  acceptedArtifact: null,
});
const listing = (
  ...entries: ReturnType<typeof project>[]
): ListProjectsResult => ({
  status: 'ok',
  entries: entries.map(p => ({
    id: p.id,
    result: { status: 'ok', project: p },
  })),
});

function pairing(
  check: () => Promise<unknown>,
  state = 'paired',
): CompanionNative {
  return {
    status: async () => ({ state }),
    check,
    pair: jest.fn(),
    disconnect: jest.fn(),
    cancel: jest.fn(),
  } as never;
}

async function render(
  props: Partial<React.ComponentProps<typeof ProjectsHomeScreen>> = {},
  overviews: Record<string, ProjectOverview> = {},
) {
  const { services } = fakeScanServices();
  services.overview = async p =>
    overviews[p.id] ?? { scans: 0, jobs: [], prints: [] };
  const handlers = {
    onScan: jest.fn(),
    onOpen: jest.fn(),
    onRetry: jest.fn(),
    onPair: jest.fn(),
    onSettings: jest.fn(),
  };
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <ProjectsHomeScreen
        result={listing()}
        services={services}
        pairing={pairing(async () => ({ state: 'paired' }))}
        creating={false}
        {...handlers}
        {...props}
      />,
    );
  });
  return { tree, ...handlers };
}

test('each project is one card with one status, its size and a spoken label', async () => {
  const { tree, onOpen } = await render(
    {
      result: listing(
        project('thing', 'Thing'),
        project('lamp', 'Desk lamp'),
        project('mug', 'Travel mug lid'),
      ),
    },
    {
      thing: { scans: 3, jobs: [], prints: [] },
      lamp: {
        scans: 1,
        jobs: [syntheticJob('succeeded', { measured: [46.6, 72.76, 59.02] })],
        prints: [],
      },
      mug: { scans: 1, jobs: [syntheticJob('running')], prints: [] },
    },
  );
  const shown = texts(tree);
  expect(shown).toContain('Projects');
  expect(shown).toContain('Not cleaned up yet');
  expect(shown).toContain('Ready to print');
  expect(shown).toContain('72.8 × 59.0 × 46.6 mm');
  expect(shown).toContain('Cleaning up');
  expect(labelled(tree, 'Thing, Not cleaned up yet')).toHaveLength(1);
  const lamp = labelled(
    tree,
    'Desk lamp, Ready to print, 72.8 by 59.0 by 46.6 millimetres',
  );
  expect(lamp).toHaveLength(1);
  expect(lamp[0]!.props.accessibilityHint).toBe('Opens the project.');
  await act(async () => lamp[0]!.props.onPress());
  expect(onOpen).toHaveBeenCalledWith('lamp');
  expect(shown).not.toContain('Refresh projects');
  await act(async () => tree.unmount());
});

test('the Mac pill says connected, asleep, pair again or find your Mac, and opens pairing', async () => {
  const cases: [CompanionNative | undefined, string][] = [
    [pairing(async () => ({ state: 'paired' })), 'Your Mac, connected'],
    [
      pairing(async () => {
        throw Object.assign(Error('x'), { code: 'network' });
      }),
      'Mac asleep. Your phone can’t reach it right now',
    ],
    [
      pairing(async () => {
        throw Object.assign(Error('x'), { code: 'unauthorized' });
      }),
      'Pair your Mac again',
    ],
    [pairing(async () => ({}), 'disconnected'), 'Find your Mac'],
    [undefined, 'Find your Mac'],
  ];
  for (const [native, label] of cases) {
    const { tree, onPair } = await render({ pairing: native });
    const [pill] = labelled(tree, label);
    expect(pill).toBeTruthy();
    await act(async () => pill!.props.onPress());
    expect(onPair).toHaveBeenCalled();
    await act(async () => tree.unmount());
  }
});

test('with no projects, home explains the first scan; Scan something opens the camera, not a name sheet', async () => {
  const { tree, onScan } = await render();
  const shown = texts(tree);
  expect(shown).toContain('Scan your first thing');
  expect(shown).toContain(
    'Pick something small that fits in your hand. Put it on a table with some space around it.',
  );
  for (const step of [
    'Walk around it with your iPhone',
    'Your Mac cleans it up',
    'Print it',
  ]) {
    expect(shown).toContain(step);
  }
  // Since KAN-176 cleanup fills gaps and never smooths the scanned surface.
  expect(shown).toContain('Fills the gaps the camera missed.');
  expect(shown).not.toMatch(/smooth/i);
  expect(shown.match(/Scan something/g)).toHaveLength(1);
  // P2: the camera opens first; the name is asked after the scan.
  await act(async () => labelled(tree, 'Scan something')[0]!.props.onPress());
  expect(onScan).toHaveBeenCalledTimes(1);
  expect(
    tree.root.findAllByProps({ presentationStyle: 'pageSheet' }),
  ).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('until a status arrives the card shows a quiet placeholder, never a wrong one', async () => {
  const { services } = fakeScanServices();
  let resolve!: (o: ProjectOverview) => void;
  services.overview = () => new Promise(r => (resolve = r));
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <ProjectsHomeScreen
        result={listing(project('thing', 'Thing'))}
        services={services}
        pairing={undefined}
        creating={false}
        onScan={jest.fn()}
        onOpen={jest.fn()}
        onRetry={jest.fn()}
        onPair={jest.fn()}
        onSettings={jest.fn()}
      />,
    );
  });
  expect(labelled(tree, 'Thing, Loading')).toHaveLength(1);
  expect(texts(tree)).not.toContain('Waiting for your Mac');
  await act(async () => resolve({ scans: 0, jobs: [], prints: [] }));
  expect(labelled(tree, 'Thing, Not scanned yet')).toHaveLength(1);
  await act(async () => tree.unmount());
});

// journey.md §9: words the app no longer uses.
const BANNED = [
  /companion/i,
  /\bcapture/i,
  /retained/i,
  /scan job/i,
  /object capture/i,
  /usdz/i,
  /\bmesh/i,
  /\bOBJ\b/,
  /\bSTL\b/,
  /check my scan/i,
  /scan processing/i,
  /repair job/i,
  /real size/i,
  /invitation/i,
  /one-time code/i,
  /https address/i,
  /send to printer/i,
  /dispatch/i,
  /handoff/i,
  /elicitation/i,
  /bambu-printer-mcp/i,
  /mcp-3d-printer-server/i,
  /\bMCP\b/,
  /project version/i,
  /\bsync/i,
  /\bimport/i,
  /revision/i,
  /conversion report/i,
  /coordinates/i,
  /meters per unit/i,
  /tailscale/i,
];

test('home and settings use only the plain words', async () => {
  const { tree } = await render(
    {
      result: listing(project('thing', 'Thing')),
      pairing: pairing(async () => {
        throw Object.assign(Error('x'), { code: 'network' });
      }),
    },
    { thing: { scans: 1, jobs: [syntheticJob('failed')], prints: [] } },
  );
  const empty = await render();
  await act(async () =>
    labelled(empty.tree, 'Scan something')[0]!.props.onPress(),
  );
  let settings!: Tree;
  await act(async () => {
    settings = Renderer.create(
      <SettingsScreen onPair={jest.fn()} onBack={jest.fn()} />,
    );
  });
  const all = [tree, empty.tree, settings]
    .map(t =>
      [
        texts(t),
        ...t.root
          .findAll(
            n =>
              typeof (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
              'string',
          )
          .map(n => n.props.accessibilityLabel ?? n.props.spokenLabel),
        ...t.root
          .findAll(n => typeof n.props.accessibilityHint === 'string')
          .map(n => n.props.accessibilityHint),
      ].join('\n'),
    )
    .join('\n');
  for (const word of BANNED) expect(all).not.toMatch(word);
  for (const t of [tree, empty.tree, settings])
    await act(async () => t.unmount());
});

test('a card that is cleaning up is looked at again until it finishes', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  try {
    const { services } = fakeScanServices();
    const answers: ProjectOverview[] = [
      { scans: 1, jobs: [syntheticJob('running')], prints: [] },
      { scans: 1, jobs: [syntheticJob('running')], prints: [] },
      { scans: 1, jobs: [syntheticJob('succeeded')], prints: [] },
    ];
    let reads = 0;
    services.overview = async () => answers[Math.min(reads++, 2)]!;
    let tree!: Tree;
    await act(async () => {
      tree = Renderer.create(
        <ProjectsHomeScreen
          result={listing(project('thing', 'Thing'))}
          services={services}
          pairing={undefined}
          creating={false}
          onScan={jest.fn()}
          onOpen={jest.fn()}
          onRetry={jest.fn()}
          onPair={jest.fn()}
          onSettings={jest.fn()}
        />,
      );
    });
    expect(labelled(tree, 'Thing, Cleaning up')).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        jest.advanceTimersByTime(POLL_MS);
      });
    }
    expect(
      labelled(tree, 'Thing, Ready to print, 61.4 by 46.0 by 21.7 millimetres'),
    ).toHaveLength(1);
    const settled = reads;
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS * 3);
    });
    expect(reads).toBe(settled);
    await act(async () => tree.unmount());
  } finally {
    jest.useRealTimers();
  }
});

test('opening pairing cancels home’s own check first, and no check starts while it is open', async () => {
  let cancelled = 0;
  let checks = 0;
  const native = {
    status: async () => ({ state: 'paired' }),
    check: () => {
      checks++;
      return new Promise(() => {});
    },
    pair: jest.fn(),
    disconnect: jest.fn(),
    cancel: async () => {
      cancelled++;
    },
  } as never as CompanionNative;
  const { tree, onPair } = await render({ pairing: native });
  expect(checks).toBe(1);
  await act(async () => labelled(tree, 'Your Mac')[0]!.props.onPress());
  expect(cancelled).toBe(1);
  expect(onPair).toHaveBeenCalled();
  await act(async () => tree.unmount());
  const paused = await render({ pairing: native, paused: true });
  expect(checks).toBe(1);
  await act(async () => paused.tree.unmount());
});

test('a slow card isn’t cut off by the next look at a card that is cleaning up', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  try {
    const { services } = fakeScanServices();
    const reads: string[] = [];
    services.overview = async p => {
      reads.push(p.id);
      if (p.id === 'slow') {
        await new Promise<void>(r => setTimeout(r, POLL_MS * 1.5));
        return { scans: 0, jobs: [], prints: [] };
      }
      return { scans: 1, jobs: [syntheticJob('running')], prints: [] };
    };
    let tree!: Tree;
    await act(async () => {
      tree = Renderer.create(
        <ProjectsHomeScreen
          result={listing(project('busy', 'Busy'), project('slow', 'Slow'))}
          services={services}
          pairing={undefined}
          creating={false}
          onScan={jest.fn()}
          onOpen={jest.fn()}
          onRetry={jest.fn()}
          onPair={jest.fn()}
          onSettings={jest.fn()}
        />,
      );
    });
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(POLL_MS / 2);
      });
    }
    expect(labelled(tree, 'Slow, Not scanned yet')).toHaveLength(1);
    expect(reads).toEqual(['busy', 'slow']);
    await act(async () => tree.unmount());
  } finally {
    jest.useRealTimers();
  }
});

test('one lost reply while cleaning up keeps the card and keeps looking', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  try {
    const { services } = fakeScanServices();
    const answers: ProjectOverview[] = [
      { scans: 1, jobs: [syntheticJob('running')], prints: [] },
      {
        scans: 1,
        jobs: [],
        prints: [],
        partial: true,
        unread: { jobs: [syntheticJob('running').captureId], prints: [] },
      },
      { scans: 1, jobs: [syntheticJob('succeeded')], prints: [] },
    ];
    let reads = 0;
    services.overview = async () => answers[Math.min(reads++, 2)]!;
    let tree!: Tree;
    await act(async () => {
      tree = Renderer.create(
        <ProjectsHomeScreen
          result={listing(project('thing', 'Thing'))}
          services={services}
          pairing={undefined}
          creating={false}
          onScan={jest.fn()}
          onOpen={jest.fn()}
          onRetry={jest.fn()}
          onPair={jest.fn()}
          onSettings={jest.fn()}
        />,
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    expect(labelled(tree, 'Thing, Cleaning up')).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
    });
    expect(
      labelled(tree, 'Thing, Ready to print, 61.4 by 46.0 by 21.7 millimetres'),
    ).toHaveLength(1);
    await act(async () => tree.unmount());
  } finally {
    jest.useRealTimers();
  }
});

test('a check still waiting behind a card read never starts once pairing opens', async () => {
  const { services } = fakeScanServices();
  let finish!: () => void;
  services.overview = () =>
    new Promise(r => {
      finish = () => r({ scans: 0, jobs: [], prints: [] });
    });
  let checks = 0;
  const native = {
    status: async () => ({ state: 'paired' }),
    check: async () => {
      checks++;
      return { state: 'paired' };
    },
    pair: jest.fn(),
    disconnect: jest.fn(),
    cancel: async () => {},
  } as never as CompanionNative;
  const onPair = jest.fn();
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <ProjectsHomeScreen
        result={listing(project('thing', 'Thing'))}
        services={services}
        pairing={native}
        creating={false}
        onScan={jest.fn()}
        onOpen={jest.fn()}
        onRetry={jest.fn()}
        onPair={onPair}
        onSettings={jest.fn()}
      />,
    );
  });
  await act(async () => labelled(tree, 'Your Mac')[0]!.props.onPress());
  await act(async () => finish());
  expect(onPair).toHaveBeenCalled();
  expect(checks).toBe(0);
  await act(async () => tree.unmount());
});

test('pairing opens only after home’s own check has really stopped', async () => {
  let release!: () => void;
  const native = {
    status: async () => ({ state: 'paired' }),
    check: () => new Promise(() => {}),
    pair: jest.fn(),
    disconnect: jest.fn(),
    cancel: () => new Promise<void>(r => (release = r)),
  } as never as CompanionNative;
  const { tree, onPair } = await render({ pairing: native });
  await act(async () => {
    labelled(tree, 'Your Mac')[0]!.props.onPress();
  });
  expect(onPair).not.toHaveBeenCalled();
  await act(async () => release());
  expect(onPair).toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('opening pairing while home is still reading the pairing stops its check', async () => {
  let readStatus!: () => void;
  let checks = 0;
  const native = {
    status: () =>
      new Promise(r => {
        readStatus = () => r({ state: 'paired' });
      }),
    check: async () => {
      checks++;
      return { state: 'paired' };
    },
    pair: jest.fn(),
    disconnect: jest.fn(),
    cancel: async () => {},
  } as never as CompanionNative;
  const { tree, onPair } = await render({ pairing: native });
  await act(async () => labelled(tree, 'Your Mac')[0]!.props.onPress());
  expect(onPair).toHaveBeenCalled();
  await act(async () => readStatus());
  expect(checks).toBe(0);
  await act(async () => tree.unmount());
});

test('cards aren’t read while the pairing screen is open', async () => {
  const { services } = fakeScanServices();
  let reads = 0;
  services.overview = async () => {
    reads++;
    return { scans: 0, jobs: [], prints: [] };
  };
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <ProjectsHomeScreen
        result={listing(project('thing', 'Thing'))}
        services={services}
        pairing={undefined}
        paused
        creating={false}
        onScan={jest.fn()}
        onOpen={jest.fn()}
        onRetry={jest.fn()}
        onPair={jest.fn()}
        onSettings={jest.fn()}
      />,
    );
  });
  expect(reads).toBe(0);
  await act(async () => tree.unmount());
});

const captureStatus = (
  status: { supported: boolean; lidar?: boolean } | Error,
) =>
  ({
    status: jest.fn(async () => {
      if (status instanceof Error) throw status;
      return { ...status, activeRunID: null };
    }),
    drafts: jest.fn(async () => []),
    start: jest.fn(),
    stop: jest.fn(),
  } as never);

test('a device without LiDAR gets no Scan something and says why, once (KAN-186)', async () => {
  const { tree } = await render({
    capture: captureStatus({ supported: false, lidar: false }),
  });
  let shown = texts(tree);
  expect(shown).toContain('This iPhone can’t scan.');
  expect(shown).toContain(
    'It has no LiDAR. Scanning needs an iPhone Pro or iPad Pro.',
  );
  expect(shown).not.toContain('Scan something');
  // The first-scan steps would promise something this phone can't do.
  expect(shown).not.toContain('Scan your first thing');
  await act(async () => labelled(tree, 'Hide this note')[0]!.props.onPress());
  shown = texts(tree);
  expect(shown).not.toContain('It has no LiDAR');
  expect(shown).toContain('No projects yet.');
  await act(async () =>
    labelled(tree, 'Why this iPhone can’t scan')[0]!.props.onPress(),
  );
  expect(texts(tree)).toContain('It has no LiDAR');
});

test('a device that can scan keeps Scan something, with its icon', async () => {
  const { tree } = await render({
    capture: captureStatus({ supported: true, lidar: true }),
  });
  const scan = tree.root.find(
    n =>
      String(n.type) === 'STMActionButton' &&
      n.props.buttonTitle === 'Scan something',
  );
  expect(scan.props.systemImage).toBe('viewfinder');
  expect(texts(tree)).not.toContain('can’t scan');
});

test('a status that can’t be read keeps the scan flow, which checks again itself', async () => {
  const { tree } = await render({ capture: captureStatus(new Error('busy')) });
  expect(texts(tree)).toContain('Scan something');
  expect(texts(tree)).not.toContain('can’t scan');
});

test('settings is one glass icon button named Settings', async () => {
  const { tree, onSettings } = await render();
  const gear = tree.root.findAll(
    n =>
      String(n.type) === 'STMActionButton' &&
      n.props.spokenLabel === 'Settings',
  );
  expect(gear).toHaveLength(1);
  expect(gear[0]!.props).toMatchObject({
    buttonTitle: '',
    systemImage: 'gearshape',
  });
  await act(async () => gear[0]!.props.onPress());
  expect(onSettings).toHaveBeenCalledTimes(1);
});
