import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, Image, StyleSheet, Text, TextInput } from 'react-native';
import type { ScanProcessingJob } from '@scan-to-make/contracts';
import { ScanResultsScreen } from '../src/screens/ScanResultsScreen';
import { unavailableScanServices } from '../src/screens/scanServices';
import {
  CAPTURE_ID,
  JOB_ID,
  PROJECT_ID,
  fakeScanServices,
  syntheticJob,
  syntheticTarget,
} from '../src/screens/testing/fakeScanServices';

type Tree = Renderer.ReactTestRenderer;
function texts(tree: Tree) {
  return [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ].join('\n');
}
function button(tree: Tree, name: string) {
  return tree.root.find(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === name &&
      typeof n.props.onPress === 'function',
  );
}
const hasButton = (tree: Tree, name: string) =>
  tree.root.findAll(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === name &&
      typeof n.props.onPress === 'function',
    { deep: false },
  ).length > 0;
async function press(tree: Tree, name: string) {
  await act(async () => {
    button(tree, name).props.onPress();
  });
}
async function type(tree: Tree, label: string, value: string) {
  await act(async () => {
    tree.root
      .find(
        n =>
          n.type === TextInput &&
          (n.props.accessibilityLabel ?? n.props.spokenLabel) === label,
      )
      .props.onChangeText(value);
  });
}
async function render(
  services: ReturnType<typeof fakeScanServices>['services'],
  props: Partial<React.ComponentProps<typeof ScanResultsScreen>> = {},
) {
  const handlers = {
    onBack: jest.fn(),
    onCompanion: jest.fn(),
    onCloseUps: jest.fn(),
  };
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <ScanResultsScreen
        target={syntheticTarget()}
        services={services}
        pollMs={1000}
        {...handlers}
        {...props}
      />,
    );
  });
  return { tree, ...handlers };
}
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a scan with no check yet offers to start one and shows the steps', async () => {
  const { services, calls } = fakeScanServices();
  const { tree } = await render(services);
  expect(calls).toEqual(['acknowledge']);
  const shown = texts(tree);
  expect(shown).toContain('Check your scan');
  expect(shown).toContain('Clean up the scan');
  expect(shown).toContain('Render 10 views');
  expect(button(tree, 'Check my scan').props.disabled).toBe(false);
  expect(hasButton(tree, 'Add close-up photos')).toBe(true);
  await act(async () => tree.unmount());
});

test('loading is announced while the companion is reached', async () => {
  const { services } = fakeScanServices();
  services.acknowledge = () => new Promise(() => {});
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Connecting to your companion…');
  expect(hasButton(tree, 'Check my scan')).toBe(false);
  await act(async () => tree.unmount());
});

test('starting follows queued and running progress to results, then stops polling', async () => {
  jest.useFakeTimers();
  const { services, calls } = fakeScanServices({
    jobs: [
      syntheticJob('queued'),
      syntheticJob('running'),
      syntheticJob('succeeded'),
    ],
  });
  const { tree, onCloseUps } = await render(services);
  await press(tree, 'Check my scan');
  expect(texts(tree)).toContain('Waiting for your companion');
  expect(await services.jobs.load(PROJECT_ID, CAPTURE_ID)).toBe(JOB_ID);
  await advance(1000);
  expect(texts(tree)).toContain('Step 2 of 3: measure it');
  expect(hasButton(tree, 'Stop checking')).toBe(true);
  await advance(1000);
  const shown = texts(tree);
  expect(shown).toContain('Ready');
  expect(shown).toContain('Preview only.');
  expect(shown).toContain('61.4 × 46.0 × 21.7 mm');
  expect(shown).toContain('Add the real size below');
  await advance(10000);
  expect(calls.filter(c => c.startsWith('status'))).toHaveLength(2);
  await press(tree, 'Add close-up photos');
  expect(onCloseUps).toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('a known product reference is sent with the check and compared per side', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  const { tree } = await render(services);
  await press(tree, 'Use AirPods Pro 2 case, 60.6 by 45.2 by 21.7 millimetres');
  await press(tree, 'Check my scan');
  expect(calls).toContain('start with reference');
  const shown = texts(tree);
  expect(shown).toContain('HOW CLOSE IS IT?');
  expect(shown).toContain('Close');
  expect(shown).toContain('Every side is within 1.5 mm of the real size.');
  expect(shown).toContain('+0.8 mm');
  expect(
    tree.root.findAll(
      n =>
        (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
        'Longest side: scan 61.4 mm, real 60.6 mm, 0.8 mm larger',
    ).length,
  ).toBeGreaterThan(0);
  await act(async () => tree.unmount());
});

test('changing the real size after results compares again without a new check', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded', { measured: [62.9, 48.7, 21.7] })],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(calls).not.toContain('start');
  await type(tree, 'Length', '45,2');
  await type(tree, 'Width', '60.6');
  await type(tree, 'Height', '21.7');
  let shown = texts(tree);
  expect(shown).toContain('Noticeably off');
  expect(shown).toContain(
    'The middle side is 3.5 mm larger than the real size.',
  );
  await type(tree, 'Height', 'abc');
  shown = texts(tree);
  expect(shown).toContain('Use a number of millimetres, like 45.2');
  expect(shown).not.toContain('HOW CLOSE IS IT?');
  await act(async () => tree.unmount());
});

test('an incomplete reference blocks starting until it is fixed or cleared', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('queued')],
  });
  const { tree } = await render(services);
  await type(tree, 'Length', '60');
  await press(tree, 'Check my scan');
  expect(calls).not.toContain('start');
  expect(texts(tree)).toContain('Enter a size');
  await press(tree, 'Clear real size');
  await press(tree, 'Check my scan');
  expect(calls).toContain('start');
  await act(async () => tree.unmount());
});

test('a failed check explains what happened and can be started again', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('failed'), syntheticJob('queued')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(texts(tree)).toContain('This scan couldn’t be checked');
  await press(tree, 'Check again');
  expect(calls).toContain('start');
  expect(texts(tree)).toContain('Waiting for your companion');
  await act(async () => tree.unmount());
});

test.each([
  ['cancelled', 'You stopped this check'],
  ['interrupted', 'Your companion restarted'],
] as const)(
  'a %s job has its own plain explanation',
  async (failure, title) => {
    const { services } = fakeScanServices({
      jobs: [syntheticJob('failed', { failure })],
    });
    await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
    const { tree } = await render(services);
    expect(texts(tree)).toContain(title);
    await act(async () => tree.unmount());
  },
);

test('an unconfirmed start is never retried without explicit confirmation', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('queued')],
  });
  const start = services.processing.start;
  services.processing.start = async () => {
    services.processing.start = start;
    throw Object.assign(Error('lost'), { code: 'ambiguous-start' });
  };
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(services);
  await press(tree, 'Check my scan');
  expect(texts(tree)).toContain('We couldn’t confirm the check started');
  expect(calls).not.toContain('start');
  await press(tree, 'Start a new check');
  expect(calls).not.toContain('start');
  const buttons = alert.mock.calls[0][2]!;
  await act(async () => {
    buttons.find(b => b.text === 'Start a new check')!.onPress!();
  });
  expect(calls).toContain('start');
  await act(async () => tree.unmount());
});

test('a busy companion leaves the user ready to try again', async () => {
  const { services } = fakeScanServices();
  services.processing.start = async () => {
    throw Object.assign(Error('busy'), { status: 429, code: 'busy' });
  };
  const { tree } = await render(services);
  await press(tree, 'Check my scan');
  expect(texts(tree)).toContain('Your companion is busy with another scan.');
  expect(button(tree, 'Check my scan').props.disabled).toBe(false);
  await act(async () => tree.unmount());
});

test('a missing or revoked connection asks to connect the companion', async () => {
  const { services } = fakeScanServices();
  services.acknowledge = async () => {
    throw Object.assign(Error('expired'), { status: 401 });
  };
  const { tree, onCompanion } = await render(services);
  expect(texts(tree)).toContain('Connect your companion');
  await press(tree, 'Connect companion');
  expect(onCompanion).toHaveBeenCalled();
  expect(hasButton(tree, 'Check my scan')).toBe(false);
  await act(async () => tree.unmount());
});

test('a scan from an earlier project version is not checked', async () => {
  const { services, calls } = fakeScanServices({ revision: 3 });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(texts(tree)).toContain('This scan is from an earlier version');
  expect(calls).toEqual(['acknowledge']);
  await act(async () => tree.unmount());
});

test('a remembered job the companion no longer has is forgotten', async () => {
  const { services } = fakeScanServices();
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(texts(tree)).toContain(
    'Your last check is no longer on your companion.',
  );
  expect(await services.jobs.load(PROJECT_ID, CAPTURE_ID)).toBeNull();
  expect(hasButton(tree, 'Check my scan')).toBe(true);
  await act(async () => tree.unmount());
});

test('repeated status failures pause polling until the user checks again', async () => {
  jest.useFakeTimers();
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('running'), syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  const status = services.processing.status;
  services.processing.status = async () => {
    calls.push('status failed');
    throw Error('Couldn’t reach your companion.');
  };
  await advance(1000);
  await advance(2000);
  await advance(3000);
  expect(texts(tree)).toContain('We lost touch with your companion.');
  await advance(60000);
  expect(calls.filter(c => c === 'status failed')).toHaveLength(3);
  services.processing.status = status;
  await press(tree, 'Check progress again');
  await advance(1000);
  expect(texts(tree)).toContain('Ready');
  await act(async () => tree.unmount());
});

test('stopping a running check asks first, then shows it was stopped', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('running')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(services, { pollMs: 60000 });
  await press(tree, 'Stop checking');
  expect(calls).not.toContain('cancel');
  await act(async () => {
    alert.mock.calls[0][2]!.find(b => b.text === 'Stop')!.onPress!();
  });
  expect(calls).toContain('cancel');
  expect(texts(tree)).toContain('You stopped this check');
  await act(async () => tree.unmount());
});

test('the view gallery shows each render and shares the model', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(calls.filter(c => c.startsWith('download'))).toHaveLength(10);
  const hero = () => tree.root.findAllByType(Image)[0].props.source.uri;
  const angle = hero();
  expect(angle).toMatch(/^file:\/\/\/synthetic\//);
  await press(tree, 'Show Top view');
  expect(hero()).not.toBe(angle);
  await press(tree, 'View 3D model');
  await press(tree, 'Share STL file');
  expect(calls).toContain('open repaired.obj');
  expect(calls).toContain('share repaired.stl');
  await act(async () => tree.unmount());
});

test('the hero view fits the gallery it is in, not the whole window', async () => {
  const { services } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  const hero = () =>
    StyleSheet.flatten(
      tree.root.findAll(
        n =>
          (n.props.accessibilityLabel ?? n.props.spokenLabel)?.startsWith?.(
            'Cleaned-up scan,',
          ) && typeof n.props.onPress === 'function',
        { deep: false },
      )[0]!.props.style,
    );
  // The innermost view that measures itself around the hero is the gallery.
  const gallery = tree.root
    .findAll(
      n =>
        typeof n.props.onLayout === 'function' &&
        n.findAll(c =>
          c.props.accessibilityLabel?.startsWith?.('Cleaned-up scan,'),
        ).length > 0,
    )
    .pop()!;
  // A folded iPhone Duo's side system bar narrows the column.
  await act(async () => {
    gallery.props.onLayout({ nativeEvent: { layout: { width: 338 } } });
  });
  expect(hero()).toMatchObject({ width: 338, height: 338 });
  await act(async () => {
    gallery.props.onLayout({ nativeEvent: { layout: { width: 640 } } });
  });
  expect(hero()).toMatchObject({ width: 520, height: 520 });
  await act(async () => tree.unmount());
});

test('a cleaned-up scan offers Send to printer only when printing is set up', async () => {
  for (const onPrint of [undefined, jest.fn()]) {
    const { services } = fakeScanServices({
      jobs: [syntheticJob('succeeded')],
    });
    await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
    const { tree } = await render(services, { onPrint });
    const send = tree.root.findAll(
      n =>
        (n.props.accessibilityRole === 'button' ||
          String(n.type) === 'STMActionButton') &&
        (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
          'Send to printer' &&
        typeof n.props.onPress === 'function',
      { deep: false },
    );
    expect(send).toHaveLength(onPrint ? 1 : 0);
    if (onPrint) {
      await press(tree, 'Send to printer');
      // The finished check is what gets sent.
      expect(onPrint).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: JOB_ID, status: 'succeeded' }),
      );
    }
    await act(async () => tree.unmount());
  }
});

test('without displayable images each view opens on its own', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  delete services.imageUri;
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(tree.root.findAllByType(Image)).toHaveLength(0);
  await press(tree, 'Open Bottom view');
  expect(calls).toContain('open neg_z.png');
  await act(async () => tree.unmount());
});

test('large text stacks the comparison so numbers stay readable', async () => {
  const native = require('react-native');
  jest.spyOn(native, 'useWindowDimensions').mockReturnValue({
    width: 393,
    height: 852,
    scale: 3,
    fontScale: 2,
  });
  const { services } = fakeScanServices({
    jobs: [
      syntheticJob('succeeded', {
        reference: { dimensionsMm: [60.6, 45.2, 21.7] },
      }),
    ],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  const shown = texts(tree);
  expect(shown).toContain('Scan 61.4 mm');
  expect(shown).toContain('Real 60.6 mm');
  expect(shown).not.toContain('DIFF');
  await act(async () => tree.unmount());
});

test('the app default reports that scan checks are not available yet', async () => {
  const { tree } = await render(unavailableScanServices());
  const shown = texts(tree);
  expect(shown).toContain('Not available here');
  expect(shown).toContain('available in the iPhone app');
  expect(hasButton(tree, 'Connect companion')).toBe(false);
  await act(async () => tree.unmount());
});

test('stopping waits for an in-flight progress check, then cancels once', async () => {
  jest.useFakeTimers();
  const { services, calls } = fakeScanServices();
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  let reads = 0;
  let inFlight = false;
  let release!: (job: ScanProcessingJob) => void;
  services.processing.status = async () => {
    reads++;
    if (reads === 1) return syntheticJob('running');
    inFlight = true;
    return new Promise<ScanProcessingJob>(resolve => {
      release = job => {
        inFlight = false;
        resolve(job);
      };
    });
  };
  // Like the native bridge: one request at a time, so an overlapping
  // cancel comes back unconfirmed.
  services.processing.cancel = async () => {
    calls.push(inFlight ? 'cancel during read' : 'cancel');
    if (inFlight) {
      throw Object.assign(Error('busy'), { code: 'ambiguous-cancel' });
    }
    return syntheticJob('failed', { failure: 'cancelled' });
  };
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(services);
  await advance(1000);
  expect(inFlight).toBe(true);
  await press(tree, 'Stop checking');
  await act(async () => {
    alert.mock.calls[0][2]!.find(b => b.text === 'Stop')!.onPress!();
  });
  expect(calls.filter(c => c.startsWith('cancel'))).toEqual([]);
  expect(texts(tree)).toContain('Stopping…');
  // The earlier read still says running; it must not win over the stop.
  await act(async () => {
    release(syntheticJob('running'));
  });
  expect(calls.filter(c => c.startsWith('cancel'))).toEqual(['cancel']);
  let shown = texts(tree);
  expect(shown).toContain('You stopped this check');
  expect(shown).not.toContain('We couldn’t confirm the check stopped');
  await advance(10000);
  expect(reads).toBe(2);
  shown = texts(tree);
  expect(shown).toContain('You stopped this check');
  expect(hasButton(tree, 'Stop checking')).toBe(false);
  await act(async () => tree.unmount());
});

test('an unconfirmed stop keeps following the check', async () => {
  jest.useFakeTimers();
  const { services } = fakeScanServices({
    jobs: [syntheticJob('running'), syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  services.processing.cancel = async () => {
    throw Object.assign(Error('lost'), { code: 'ambiguous-cancel' });
  };
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(services);
  await press(tree, 'Stop checking');
  await act(async () => {
    alert.mock.calls[0][2]!.find(b => b.text === 'Stop')!.onPress!();
  });
  expect(texts(tree)).toContain('We couldn’t confirm the check stopped.');
  await advance(1000);
  expect(texts(tree)).toContain('Ready');
  await act(async () => tree.unmount());
});

const STOPPED_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const DONE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const AIRPODS = {
  dimensionsMm: [60.6, 45.2, 21.7] as [number, number, number],
  productName: 'AirPods Pro 2 case',
};

test('after a relaunch the companion’s list reopens a finished check', async () => {
  const { services, calls } = fakeScanServices({
    listed: [
      syntheticJob('failed', { failure: 'cancelled', jobId: STOPPED_ID }),
      syntheticJob('succeeded', { jobId: DONE_ID, reference: AIRPODS }),
    ],
  });
  const { tree } = await render(services);
  expect(calls).toContain('list jobs');
  expect(calls.some(c => c.startsWith('status'))).toBe(false);
  let shown = texts(tree);
  expect(shown).toContain('Ready');
  expect(shown).toContain('HOW CLOSE IS IT?');
  expect(shown).toContain('Other checks of this scan');
  expect(shown).toContain('Stopped check');
  expect(await services.jobs.load(PROJECT_ID, CAPTURE_ID)).toBe(DONE_ID);
  await press(tree, 'Open Stopped check, Check aaaaaaaa');
  shown = texts(tree);
  expect(shown).toContain('You stopped this check');
  expect(shown).toContain('Finished check');
  expect(shown).toContain('Compared with AirPods Pro 2 case · Check bbbbbbbb');
  expect(await services.jobs.load(PROJECT_ID, CAPTURE_ID)).toBe(STOPPED_ID);
  await act(async () => tree.unmount());
});

test('a running check in the list is the one shown and followed', async () => {
  const { services } = fakeScanServices({
    listed: [
      syntheticJob('succeeded', { jobId: DONE_ID }),
      syntheticJob('running', { jobId: STOPPED_ID }),
    ],
  });
  const { tree } = await render(services, { pollMs: 60000 });
  const shown = texts(tree);
  expect(shown).toContain('Step 2 of 3: measure it');
  // Switching away from a running check isn't offered.
  expect(shown).not.toContain('Other checks of this scan');
  await act(async () => tree.unmount());
});

test('without the listing route the remembered check is reopened', async () => {
  const { services, calls } = fakeScanServices({
    listed: 'not-available',
    jobs: [syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(calls.slice(0, 3)).toEqual([
    'acknowledge',
    'list jobs',
    `status ${JOB_ID}`,
  ]);
  expect(texts(tree)).toContain('Ready');
  await act(async () => tree.unmount());
});

test('a remembered check the companion no longer lists is explained', async () => {
  const { services } = fakeScanServices({ listed: [] });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(texts(tree)).toContain(
    'Your last check is no longer on your companion.',
  );
  expect(hasButton(tree, 'Check my scan')).toBe(true);
  expect(await services.jobs.load(PROJECT_ID, CAPTURE_ID)).toBeNull();
  await act(async () => tree.unmount());
});

test('the gallery opens each view full screen', async () => {
  const { services } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  await press(tree, 'Cleaned-up scan, Angle 1 view');
  expect(texts(tree)).toContain('Angle 1 view · 1 of 10');
  await press(tree, 'Done');
  expect(texts(tree)).not.toContain('Angle 1 view · 1 of 10');
  await act(async () => tree.unmount());
});

test('views without a display copy open one at a time instead', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  services.imageUri = async () => null;
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Some views couldn’t be loaded.');
  await press(tree, 'Open Top view');
  expect(calls).toContain('open pos_z.png');
  await act(async () => tree.unmount());
});

test('switching checks never shows the previous check’s renders', async () => {
  const first = 'aaaaaaaa-0000-4000-8000-0000000000aa';
  const second = 'bbbbbbbb-0000-4000-8000-0000000000bb';
  const { services } = fakeScanServices({
    listed: [
      syntheticJob('succeeded', { jobId: first }),
      syntheticJob('succeeded', { jobId: second }),
    ],
  });
  const download = services.processing.downloadArtifact;
  services.processing.downloadArtifact = async (p, c, a, job, name) => {
    if (job.jobId === second) throw Error('Couldn’t reach your companion.');
    return download(p, c, a, job, name);
  };
  const { tree } = await render(services);
  expect(tree.root.findAllByType(Image).length).toBeGreaterThan(0);
  await press(tree, 'Open Finished check, No real size · Check bbbbbbbb');
  // The second check's views failed, so none of the first one's may linger.
  expect(tree.root.findAllByType(Image)).toHaveLength(0);
  expect(texts(tree)).toContain('Some views couldn’t be loaded.');
  await act(async () => tree.unmount());
});

test('viewing the model waits for a gallery download already in flight', async () => {
  const { services, calls } = fakeScanServices({
    jobs: [syntheticJob('succeeded')],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  let inFlight = false;
  let release!: () => void;
  const download = services.processing.downloadArtifact;
  let first = true;
  services.processing.downloadArtifact = async (...args) => {
    if (!first) return download(...args);
    first = false;
    inFlight = true;
    await new Promise<void>(resolve => {
      release = resolve;
    });
    inFlight = false;
    return download(...args);
  };
  const open = services.processing.openArtifact;
  services.processing.openArtifact = async (...args) => {
    // The native bridge serves one request at a time.
    if (inFlight) calls.push('open during download');
    return open(...args);
  };
  const { tree } = await render(services);
  expect(inFlight).toBe(true);
  await press(tree, 'View 3D model');
  expect(calls).not.toContain('open repaired.obj');
  await act(async () => release());
  expect(calls).toContain('open repaired.obj');
  expect(calls).not.toContain('open during download');
  await act(async () => tree.unmount());
});

test('an AI result opens Compare versions: pictures, the one picked, the reason, and the scan as captured', async () => {
  const reason =
    'B rounds the eyes and smooths the sign while keeping the stitches.';
  const { services, calls } = fakeScanServices({
    jobs: [
      syntheticJob('succeeded', {
        previews: [1, 2],
        aiTweak: {
          access: { kind: 'codex-cli' },
          attempts: [
            { index: 1, outcome: 'changed', wallMs: 1, veto: 'smoothed' },
            { index: 2, outcome: 'changed', wallMs: 1 },
          ],
          pick: { choice: 'attempt-2', decidedBy: 'judge', reason },
        },
      }),
    ],
  });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  let shown = texts(tree);
  expect(shown).toContain('AI try 2 was closest to your photos.');
  expect(shown).not.toContain('WHY THIS ONE');
  await press(tree, 'Compare versions');
  shown = texts(tree);
  for (const line of [
    'The scan as captured',
    'AI try 1',
    'AI try 2',
    'Picked',
    'This is the model you print.',
    'Not used: it smoothed away detail your scan caught.',
    'WHY THIS ONE',
    reason,
  ])
    expect(shown).toContain(line);
  expect(calls).toEqual(
    expect.arrayContaining([
      'download ai-attempt-1-preview.png',
      'download ai-attempt-2-preview.png',
    ]),
  );
  expect(
    tree.root
      .findAllByType(Image)
      .some(i => i.props.accessibilityLabel === 'Picture of ai try 2'),
  ).toBe(true);
  expect(hasButton(tree, 'Open ai try 1 in 3D')).toBe(false);
  await press(tree, 'Open the scan as captured in 3D');
  expect(calls).toContain('open captured scan');
  await press(tree, 'Open ai try 2 in 3D');
  expect(calls).toContain('open repaired.obj');
  await press(tree, 'Hide versions');
  expect(texts(tree)).not.toContain('WHY THIS ONE');
  await act(async () => tree.unmount());
});

test('a result without the AI step has no Compare versions door', async () => {
  const { services } = fakeScanServices({ jobs: [syntheticJob('succeeded')] });
  await services.jobs.save(PROJECT_ID, CAPTURE_ID, JOB_ID);
  const { tree } = await render(services);
  expect(hasButton(tree, 'Compare versions')).toBe(false);
  await act(async () => tree.unmount());
});
