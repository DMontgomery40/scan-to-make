import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { NativeModules, Text, Alert } from 'react-native';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';
import { RetainedCapturesScreen } from '../src/screens/RetainedCapturesScreen';

type Status = { supported: boolean; lidar?: boolean };
async function fixture(
  status: Status | (() => Promise<Status>) = { supported: true, lidar: true },
  options: {
    // Scan something: an unnamed project, opened to scan once.
    scanFirst?: boolean;
    // How long the native draft list takes to answer.
    draftsDelay?: number;
    // The camera's own "add it to this project" choice.
    addRequested?: boolean;
  } = {},
) {
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
  const created = await repo.create({
    id: 'one',
    brief: options.scanFirst
      ? { object: '', context: '', addition: '' }
      : { object: 'Box', context: 'Desk', addition: 'Lid' },
  });
  if (created.status !== 'ok') throw Error();
  const started = jest.fn();
  const requests: string[] = [];
  const drafts: unknown[] = [];
  NativeModules.RetainedCaptureBridge = {
    context: async () => {
      throw Error('Connect your companion');
    },
    read: async () => null,
    cancel: async () => {},
    pick: async () => {
      requests.push('pick');
      throw Error('File selection cancelled');
    },
    // The first step of adding a scan to the project.
    adoptNativeOutput: async () => {
      requests.push('adopt');
      throw Error('Not adopted in this test');
    },
  };
  NativeModules.NativeCaptureCoordinator = {
    status: async () => ({
      ...(typeof status === 'function' ? await status() : status),
      activeRunID: null,
    }),
    drafts: async () => {
      if (options.draftsDelay)
        await new Promise<void>(resolve =>
          setTimeout(resolve, options.draftsDelay),
        );
      return drafts;
    },
    start: async (origin: unknown) => {
      const draft = {
        formatVersion: 1,
        runID: '14f6ca24-44fc-4984-9634-c14eef4eebc9',
        origin,
        createdAt: '2026-01-01T00:00:00Z',
        status: 'ready',
        ...(options.addRequested ? { addRequested: true } : {}),
        file: {
          sha256: 'a'.repeat(64),
          byteLength: 123,
          mediaType: 'model/vnd.usdz+zip',
        },
      };
      requests.push('scan');
      drafts.push(draft);
      return draft;
    },
    stop: async () => {},
  };
  let tree!: Renderer.ReactTestRenderer;
  // As App does: the scan request is cleared once the scan starts.
  function ScanFirst() {
    const [scanNow, setScanNow] = React.useState(true);
    return (
      <RetainedCapturesScreen
        id="one"
        repository={repo}
        onBack={() => {}}
        onCompanion={() => {}}
        scanNow={scanNow}
        onScanStarted={() => {
          started();
          setScanNow(false);
        }}
      />
    );
  }
  await act(async () => {
    tree = Renderer.create(
      options.scanFirst ? (
        <ScanFirst />
      ) : (
        <RetainedCapturesScreen
          id="one"
          repository={repo}
          onBack={() => {}}
          onCompanion={() => {}}
        />
      ),
    );
  });
  return { tree, requests, project: created.project, repo, drafts, started };
}
function button(tree: Renderer.ReactTestRenderer, name: string) {
  return tree.root.find(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === name &&
      typeof n.props.onPress === 'function',
  );
}
function text(tree: Renderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat().join(''))
    .join('\n');
}
async function press(
  tree: Renderer.ReactTestRenderer,
  name: string,
  times = 1,
) {
  // times > 1: a double tap, both before the next render.
  await act(async () => {
    const target = button(tree, name);
    for (let n = 0; n < times; n++) target.props.onPress();
  });
}
const settle = (ms: number) =>
  act(async () => new Promise<void>(done => setTimeout(done, ms)));
const nameIt = async (tree: Renderer.ReactTestRenderer, value: string) => {
  const { TextInput } = require('react-native');
  const field = tree.root.find(
    n =>
      n.type === TextInput &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
        'What did you scan?',
  );
  await act(async () => field.props.onChangeText(value));
};
afterEach(() => {
  delete NativeModules.NativeCaptureCoordinator;
  delete NativeModules.RetainedCaptureBridge;
  jest.restoreAllMocks();
});
test('unpaired project can scan locally and keep a ready draft without upload', async () => {
  const { tree, requests } = await fixture();
  await press(tree, 'Scan object');
  expect(requests).toEqual(['scan']);
  expect(text(tree)).toContain('Local scan 1');
  expect(text(tree)).toContain('Ready to add');
  expect(button(tree, 'Add scan 1 to this project')).toBeTruthy();
  await act(async () => tree.unmount());
});
const hasButton = (tree: Renderer.ReactTestRenderer, name: string) =>
  tree.root.findAll(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === name,
  ).length > 0;
test('a device without LiDAR says scanning needs LiDAR and keeps Files import', async () => {
  const { tree, requests } = await fixture({ supported: false, lidar: false });
  expect(hasButton(tree, 'Scan object')).toBe(false);
  expect(text(tree)).toContain('Scanning needs LiDAR');
  expect(text(tree)).toContain('This device has no LiDAR scanner');
  await press(tree, 'Choose USDZ capture');
  expect(requests).toEqual(['pick']);
  await act(async () => tree.unmount());
});
test('a LiDAR device without Object Capture support is not told it lacks LiDAR', async () => {
  for (const status of [
    { supported: false, lidar: true },
    { supported: false },
  ]) {
    const { tree } = await fixture(status);
    expect(hasButton(tree, 'Scan object')).toBe(false);
    expect(text(tree)).toContain('Scanning isn’t available here');
    expect(text(tree)).not.toContain('no LiDAR');
    await act(async () => tree.unmount());
  }
});
test('scanning stays off when the device check fails, and can be retried', async () => {
  let fail = true;
  const { tree, requests } = await fixture(async () => {
    if (fail) throw Error('bridge unavailable');
    return { supported: true, lidar: true };
  });
  expect(hasButton(tree, 'Scan object')).toBe(false);
  expect(text(tree)).toContain('Couldn’t check for LiDAR');
  fail = false;
  await press(tree, 'Check again');
  expect(text(tree)).not.toContain('Couldn’t check for LiDAR');
  await press(tree, 'Scan object');
  expect(requests).toEqual(['scan']);
  await act(async () => tree.unmount());
});
test('scanning is not offered before the device check finishes', async () => {
  let finish!: (status: Status) => void;
  const { tree } = await fixture(
    () => new Promise<Status>(resolve => (finish = resolve)),
  );
  expect(button(tree, 'Scan object').props.disabled).toBe(true);
  expect(text(tree)).not.toContain('Scanning needs LiDAR');
  await act(async () => finish({ supported: true, lidar: true }));
  expect(button(tree, 'Scan object').props.disabled).toBe(false);
  await act(async () => tree.unmount());
});
test('choosing a changed destination requires explicit confirmation before import', async () => {
  const { tree, requests } = await fixture();
  await press(tree, 'Scan object');
  NativeModules.RetainedCaptureBridge.context = async () => 'host|new-device';
  const prompt = jest.spyOn(Alert, 'alert');
  await press(tree, 'Choose destination for scan 1');
  expect(prompt).toHaveBeenCalled();
  expect(requests).toEqual(['scan']);
  await act(async () => tree.unmount());
});

// The real importer against a companion that makes a new capture per POST.
function connect(
  { requests, project }: Awaited<ReturnType<typeof fixture>>,
  { loseReplies = false, history = new Map<string, string>() } = {},
) {
  const ref = (c: string, mediaType: string) => ({
    sha256: c.repeat(64),
    byteLength: 123,
    mediaType,
  });
  const original = ref('a', 'model/vnd.usdz+zip');
  const retained = {
    captureId: 'native-capture-1',
    binding: {
      projectId: 'one',
      projectRevision: 0,
      capture: {
        formatVersion: '0.1.0',
        original,
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
  Object.assign(NativeModules.RetainedCaptureBridge, {
    context: async () => 'host|device',
    read: async (key: string) => history.get(key) ?? null,
    write: async (key: string, value: string) => {
      history.set(key, value);
    },
    adoptNativeOutput: async () => original,
    request: async (options: { method: string; path: string }) => {
      requests.push(options.method);
      if (options.method === 'POST' && loseReplies) throw Error('reply lost');
      return {
        status: options.method === 'POST' ? 201 : 200,
        body: JSON.stringify(
          options.path.includes('/captures') ? retained : project,
        ),
        etag: '"' + 'a'.repeat(64) + '"',
      };
    },
  });
  return history;
}
test('ordinary screen hands a completed native draft through real importer and verified reopen', async () => {
  const f = await fixture();
  const { tree, requests } = f;
  const history = connect(f);
  await press(tree, 'Scan object');
  expect(requests).toEqual(['scan']);
  // Two quick taps send the scan once.
  await act(async () => {
    const add = button(tree, 'Add scan 1 to this project');
    add.props.onPress();
    add.props.onPress();
  });
  expect(requests).toEqual(['scan', 'GET', 'POST', 'GET']);
  // An added scan can't be added again, so the companion never gets a copy.
  expect(text(tree)).toContain('Added to this project as capture 1');
  expect(hasButton(tree, 'Add scan 1 to this project')).toBe(false);
  expect(hasButton(tree, 'Choose destination for scan 1')).toBe(false);
  expect(text(tree)).toContain('Review capture');
  expect(text(tree)).toContain('Capture imported and verified.');
  expect(button(tree, 'Review converted mesh')).toBeTruthy();
  expect(button(tree, 'Export original USDZ')).toBeTruthy();
  expect(
    [...history.values()].some(
      value =>
        JSON.parse(value).captures?.[0]?.captureId === 'native-capture-1',
    ),
  ).toBe(true);
  await act(async () => tree.unmount());
});

type AlertButton = { text: string; onPress?: () => unknown };
async function answer(prompt: jest.SpyInstance, label: string) {
  const buttons: AlertButton[] = prompt.mock.calls.at(-1)[2];
  await act(async () => {
    await buttons.find(b => b.text === label)!.onPress!();
  });
}
test('an added scan can be added again once the project has a newer version', async () => {
  const f = await fixture();
  connect(f);
  await press(f.tree, 'Scan object');
  await press(f.tree, 'Add scan 1 to this project');
  expect(hasButton(f.tree, 'Add scan 1 to this project')).toBe(false);
  await f.repo.change('one', 0, {
    kind: 'replace-brief',
    brief: { ...f.project.brief, addition: 'Edited' },
  });
  await press(f.tree, 'Refresh local scans');
  expect(text(f.tree)).toContain('Ready to add');
  expect(hasButton(f.tree, 'Choose destination for scan 1')).toBe(true);
  await act(async () => f.tree.unmount());
});
test('answering the destination question right away still adds the scan', async () => {
  const f = await fixture();
  connect(f);
  await press(f.tree, 'Scan object');
  const prompt = jest.spyOn(Alert, 'alert');
  await press(f.tree, 'Choose destination for scan 1');
  await answer(prompt, 'Add to this version');
  expect(f.requests).toEqual(['scan', 'GET', 'POST', 'GET']);
  expect(text(f.tree)).toContain('Added to this project as capture 1');
  await act(async () => f.tree.unmount());
});
test('after a lost reply is set aside, adding the same scan asks before sending it again', async () => {
  const f = await fixture();
  const history = connect(f, { loseReplies: true });
  await press(f.tree, 'Scan object');
  await press(f.tree, 'Add scan 1 to this project');
  expect(text(f.tree)).toContain('Import unconfirmed');
  const prompt = jest.spyOn(Alert, 'alert');
  await press(f.tree, 'Review unconfirmed import');
  await answer(prompt, 'Allow a new import');
  connect(f, { history });
  await press(f.tree, 'Add scan 1 to this project');
  expect(f.requests.filter(r => r === 'POST')).toHaveLength(1);
  expect(prompt).toHaveBeenLastCalledWith(
    'Add this scan again?',
    expect.stringContaining('may already be on your companion'),
    expect.anything(),
  );
  // The question is in the alert; the status line doesn't repeat it as an error.
  expect(text(f.tree)).toContain(
    'Nothing was sent. Choose whether to add it again.',
  );
  expect(text(f.tree)).not.toContain('may already be on your companion');
  await answer(prompt, 'Add again');
  expect(f.requests.filter(r => r === 'POST')).toHaveLength(2);
  expect(text(f.tree)).toContain('Added to this project as capture 1');
  await act(async () => f.tree.unmount());
});

test('a scan kept from before its project had a name is named before it is added', async () => {
  const { tree, requests, repo, drafts } = await fixture(undefined, {
    scanFirst: true,
  });
  // The camera opened once, then Not now: the scan stays on this phone.
  expect(requests).toEqual(['scan']);
  expect(text(tree)).toContain('Scan finished');
  await press(tree, 'Not now');
  expect(text(tree)).not.toContain('Scan finished');
  expect(drafts).toHaveLength(1);
  // Adding it later, by either button, asks for the name first.
  await press(tree, 'Add scan 1 to this project');
  expect(text(tree)).toContain('Scan finished');
  await press(tree, 'Not now');
  await press(tree, 'Choose destination for scan 1');
  expect(text(tree)).toContain('Scan finished');
  await press(tree, 'Not now');
  // So does a USDZ file, before it's even chosen.
  await press(tree, 'Choose USDZ capture');
  expect(text(tree)).toContain('Name this project');
  expect(requests).toEqual(['scan']);
  const project = await repo.load('one');
  expect(project.status === 'ok' && project.project.brief.object).toBe('');
  await act(async () => tree.unmount());
});

test('Scan something waits out a running check, then opens the camera once', async () => {
  let checks = 0;
  const { tree, requests, started } = await fixture(
    async () => {
      if (checks++ === 0) throw Error('not yet');
      return { supported: true, lidar: true };
    },
    { scanFirst: true, draftsDelay: 20 },
  );
  expect(text(tree)).toContain('Couldn’t check for LiDAR');
  expect(requests).toEqual([]);
  await press(tree, 'Check again');
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 60)));
  expect(started).toHaveBeenCalledTimes(1);
  expect(requests).toEqual(['scan']);
  await act(async () => new Promise<void>(resolve => setTimeout(resolve, 60)));
  await act(async () => tree.unmount());
});

test('a scan made before pairing, named after pairing, still asks to use the current destination', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const { tree } = await fixture(undefined, { scanFirst: true });
  await press(tree, 'Not now');
  // The phone was paired after the scan, so the scan's pairing differs.
  NativeModules.RetainedCaptureBridge.context = async () => 'host|device';
  await press(tree, 'Choose destination for scan 1');
  expect(text(tree)).toContain('Scan finished');
  const { TextInput } = require('react-native');
  const field = tree.root.find(
    n =>
      n.type === TextInput &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
        'What did you scan?',
  );
  await act(async () => field.props.onChangeText('Box'));
  await press(tree, 'Continue');
  expect(alert).toHaveBeenCalledWith(
    'Use the current project version?',
    expect.stringContaining('project version'),
    expect.anything(),
  );
  expect(text(tree)).not.toContain('destination changed');
  await act(async () => tree.unmount());
});

test('naming a scan while the screen is still catching up still adds it', async () => {
  const { tree, requests } = await fixture(undefined, {
    scanFirst: true,
    addRequested: true,
    // The read after the scan is slow.
    draftsDelay: 40,
  });
  // Continue as soon as the sheet shows.
  for (let i = 0; i < 30 && !text(tree).includes('Scan finished'); i++)
    await act(async () => new Promise<void>(done => setTimeout(done, 5)));
  expect(text(tree)).toContain('Scan finished');
  const { TextInput } = require('react-native');
  const field = tree.root.find(
    n =>
      n.type === TextInput &&
      (n.props.accessibilityLabel ?? n.props.spokenLabel) ===
        'What did you scan?',
  );
  await act(async () => field.props.onChangeText('Box'));
  await press(tree, 'Continue');
  await act(async () => new Promise<void>(done => setTimeout(done, 120)));
  expect(requests).toContain('adopt');
  await act(async () => tree.unmount());
});

// Every way into scanning, naming and adding holds its guard until it hands
// off: a double tap while a slow read is still running does it once.
describe('double taps while the screen catches up', () => {
  test('Scan object starts one scan', async () => {
    const { tree, requests } = await fixture(undefined, { draftsDelay: 30 });
    await press(tree, 'Scan object', 2);
    await settle(120);
    expect(requests.filter(r => r === 'scan')).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  test('Continue names once and adds once', async () => {
    const { tree, requests, repo, project } = await fixture(undefined, {
      scanFirst: true,
      addRequested: true,
      draftsDelay: 30,
    });
    await settle(80);
    await nameIt(tree, 'Box');
    await press(tree, 'Continue', 2);
    await settle(150);
    expect(requests.filter(r => r === 'adopt')).toHaveLength(1);
    const named = await repo.load('one');
    expect(named.status === 'ok' && named.project.revision).toBe(
      project.revision + 1,
    );
    await act(async () => tree.unmount());
  });

  test('Add scan adds once', async () => {
    const { tree, requests } = await fixture(undefined, { draftsDelay: 30 });
    await press(tree, 'Scan object');
    await settle(80);
    await press(tree, 'Add scan 1 to this project', 2);
    await settle(150);
    expect(requests.filter(r => r === 'adopt')).toHaveLength(1);
    expect(text(tree)).not.toContain('Still working on the last request');
    await act(async () => tree.unmount());
  });

  test('Choose destination asks once', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { tree } = await fixture(undefined, { draftsDelay: 30 });
    NativeModules.RetainedCaptureBridge.context = async () => 'host|device';
    await press(tree, 'Scan object');
    await settle(80);
    await press(tree, 'Choose destination for scan 1', 2);
    await settle(80);
    expect(
      alert.mock.calls.filter(c => c[0] === 'Use the current project version?'),
    ).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  test('Choose USDZ capture picks once', async () => {
    const { tree, requests } = await fixture(undefined, { draftsDelay: 30 });
    await press(tree, 'Choose USDZ capture', 2);
    await settle(120);
    expect(requests.filter(r => r === 'pick')).toHaveLength(1);
    expect(text(tree)).not.toContain('Still working on the last request');
    await act(async () => tree.unmount());
  });
});
