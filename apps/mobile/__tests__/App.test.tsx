/**
 * @format
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Linking, Text, TextInput } from 'react-native';
import App from '../App';
import { ObjectsClient } from '../src/objects/client';
import type { ObjectsNative } from '../src/objects/native';
import type { ObjectCapture } from '../src/objects/capture';
import type { StmObject } from '../src/objects/types';

const ID = '0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11';
// Phone width unless a test opens the wide (two-pane) layout.
let mockWindowWidth = 393;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({
    width: mockWindowWidth,
    height: 852,
    scale: 3,
    fontScale: 1,
  }),
}));

/** An in-memory Mac: objects by id, and every call it was sent. */
function fakeMac(
  seed: Partial<StmObject>[] = [],
  { failWith }: { failWith?: string } = {},
) {
  const objects = new Map<string, StmObject>();
  seed.forEach((o, i) => {
    const id = o.id ?? `${ID.slice(0, -1)}${i}`;
    objects.set(id, {
      id,
      createdAtMs: i,
      updatedAtMs: i,
      state: 'new',
      photos: [],
      passes: [],
      ...o,
    });
  });
  const calls: string[] = [];
  const reply = (status: number, body: unknown) => ({
    status,
    body: JSON.stringify(body),
  });
  const update = (id: string, change: Partial<StmObject>) => {
    const next = {
      ...objects.get(id)!,
      ...change,
      updatedAtMs: objects.get(id)!.updatedAtMs + 1,
    };
    objects.set(id, next);
    return reply(200, { object: next });
  };
  const native: ObjectsNative = {
    call: jest.fn(async ({ method, path, json: body }) => {
      const json = body as { instructions?: string; note?: string } | undefined;
      calls.push(`${method} ${path}${json ? ' ' + JSON.stringify(json) : ''}`);
      if (failWith)
        throw Object.assign(new Error(failWith), { code: failWith });
      if (path === '/v1/objects' && method === 'GET')
        return reply(200, { objects: [...objects.values()].reverse() });
      if (path === '/v1/objects' && method === 'POST') {
        const id = ID;
        objects.set(id, {
          id,
          createdAtMs: 9,
          updatedAtMs: 9,
          state: 'new',
          photos: [],
          passes: [],
          ...(json?.instructions ? { instructions: json.instructions } : {}),
        });
        return reply(201, { object: objects.get(id) });
      }
      const [, , , id, action] = path.split('/');
      if (!objects.has(id)) return reply(404, { error: { code: 'not-found' } });
      if (!action) return reply(200, { object: objects.get(id) });
      if (
        action === 'start' ||
        action === 'closeup' ||
        action === 'corrections'
      )
        return update(id, {
          state: 'touching-up',
          passes: [
            ...objects.get(id)!.passes,
            { startedAtMs: 1, ...(json?.note ? { note: json.note } : {}) },
          ],
        });
      if (action === 'print') return update(id, { state: 'printing' });
      if (action === 'plate') return update(id, { plate: undefined });
      return reply(404, {});
    }),
    sendCapture: jest.fn(async ({ objectId }) => {
      calls.push(`send ${objectId}`);
      objects.set(objectId, {
        ...objects.get(objectId)!,
        scan: 'scan.usdz',
        photos: ['a.HEIC'],
      });
      return { scanSent: true, photosSent: 24 };
    }),
    pickPhotos: jest.fn(async () => ({ photosSent: 2 })),
    takePhoto: jest.fn(async () => ({ photosSent: 1 })),
    download: jest.fn(async ({ name }) => ({ uri: `file:///cache/${name}` })),
    showModel: jest.fn(async () => undefined),
  };
  return { client: new ObjectsClient(native), native, calls, objects };
}
function fakeCapture(
  lidar = true,
  runID: string | null = '11111111-2222-4333-8444-555555555555',
): ObjectCapture {
  return {
    available: jest.fn(async () => lidar),
    scan: jest.fn(async () => runID),
    finished: jest.fn(async () => null),
  };
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return [
    ...tree.root
      .findAllByType(Text)
      .map(t => [t.props.children].flat().join('')),
    // UIKit renders these titles; they are not React Native Text descendants.
    ...tree.root
      .findAll(n => String(n.type) === 'STMActionButton')
      .map(n => n.props.buttonTitle),
  ];
}
function buttons(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      (n.props.accessibilityRole === 'button' ||
        String(n.type) === 'STMActionButton') &&
      typeof n.props.onPress === 'function',
  );
}
function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
  times = 1,
) {
  const button = buttons(tree).find(
    n =>
      n.props.buttonTitle === label ||
      (n.props.accessibilityLabel ?? n.props.spokenLabel) === label ||
      n.findAllByType(Text).some(t => t.props.children === label),
  );
  if (!button)
    throw new Error(`No button "${label}" in: ${texts(tree).join(' | ')}`);
  return act(async () => {
    for (let n = 0; n < times; n++) button.props.onPress();
  });
}
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
async function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(element);
  });
  mounted.push(tree);
  return tree;
}

beforeEach(() => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach(tree => tree.unmount()));
  mockWindowWidth = 393;
  jest.restoreAllMocks();
});

const ready: Partial<StmObject> = {
  id: ID,
  scan: 'scan.usdz',
  state: 'ready',
  passes: [{ startedAtMs: 1, endedAtMs: 2, status: 'done' }],
  current: {
    model: 'current/model.stl',
    renders: ['current/renders/render_front.png'],
    sizeMm: [61.6, 75.2, 49.4],
    summary: 'Filled in the flat back.',
  },
};

test('the list starts empty with one way to start something', async () => {
  const mac = fakeMac();
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  expect(texts(tree)).toContain('Your things');
  expect(texts(tree).join(' ')).toMatch(/Nothing here yet/);
  await press(tree, 'New');
  expect(texts(tree)).toContain('What do you want to make?');
});

test('a scan is sent by itself with its photos and the page says it is being touched up', async () => {
  const mac = fakeMac();
  const capture = fakeCapture();
  const tree = await render(<App objects={mac.client} capture={capture} />);
  await press(tree, 'New');
  await press(tree, 'Scan it');
  expect(capture.scan).toHaveBeenCalledWith(ID);
  expect(mac.calls.slice(mac.calls.indexOf('POST /v1/objects {}'))).toEqual([
    'POST /v1/objects {}',
    `send ${ID}`,
    `POST /v1/objects/${ID}/start`,
    `GET /v1/objects/${ID}`,
  ]);
  expect(texts(tree)).toContain(
    "Touching up your scan. This can take a few minutes. We'll let you know when it's ready.",
  );
});

test('instructions alone are enough when they say what to make', async () => {
  const mac = fakeMac();
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'New');
  expect(texts(tree)).not.toContain('Make it from the description');
  const box = tree.root.findByType(TextInput);
  await act(async () =>
    box.props.onChangeText(
      'A mount for this mic on my monitor arm: https://example.com/mic',
    ),
  );
  await press(tree, 'Make it from the description');
  expect(mac.calls).toContain(
    'POST /v1/objects {"instructions":"A mount for this mic on my monitor arm: https://example.com/mic"}',
  );
  expect(texts(tree)).toContain(
    "Making it. This can take a few minutes. We'll let you know when it's ready.",
  );
});

test('without LiDAR there is no Scan, and the phone says why', async () => {
  const tree = await render(
    <App objects={fakeMac().client} capture={fakeCapture(false)} />,
  );
  await press(tree, 'New');
  expect(texts(tree)).not.toContain('Scan it');
  expect(texts(tree)).toContain('Scanning needs an iPhone or iPad with LiDAR.');
  expect(texts(tree)).toContain('Use photos');
});

test('a ready object shows its size, prints once on a double tap, and takes corrections', async () => {
  const mac = fakeMac([ready]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Ready to print');
  const shown = texts(tree);
  expect(shown).toContain('62 × 75 × 49 mm');
  expect(shown).toContain('Ready to print');
  expect(shown).toContain('Filled in the flat back.');
  await press(tree, 'Print', 2);
  expect(mac.calls.filter(c => c.endsWith('/print'))).toHaveLength(1);
  expect(texts(tree)).toContain('Printing');
});

test('corrections go back for another touch-up', async () => {
  const mac = fakeMac([ready]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Ready to print');
  const box = tree.root.findAll(
    n =>
      n.type === TextInput && n.props.accessibilityLabel === 'Anything to fix?',
  )[0];
  await act(async () => box.props.onChangeText('it is 70 mm long'));
  await press(tree, 'Send changes');
  expect(mac.calls).toContain(
    `POST /v1/objects/${ID}/corrections {"note":"it is 70 mm long"}`,
  );
  expect(texts(tree)).toContain(
    "Making your changes. This can take a few minutes. We'll let you know when it's ready.",
  );
});

test('a close-up question offers the camera, photos, or a best guess', async () => {
  const mac = fakeMac([
    {
      ...ready,
      state: 'needs-closeup',
      question: { closeup: 'the underside' },
    },
  ]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(
    tree,
    "Copy of your scan. Can you send me a close-up of the underside? I can't see what's happening there.",
  );
  expect(texts(tree)).toEqual(
    expect.arrayContaining([
      'Open camera',
      'Attach photos',
      'Make your best guess',
    ]),
  );
  await press(tree, 'Open camera');
  expect(mac.native.takePhoto).toHaveBeenCalledWith({ objectId: ID });
  expect(mac.calls).toContain(
    `POST /v1/objects/${ID}/closeup {"bestGuess":false}`,
  );
});

test('something on the plate shows the photo and the override', async () => {
  const mac = fakeMac([
    { ...ready, state: 'printing', plate: { item: 'a spool', photo: true } },
  ]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(
    tree,
    "Copy of your scan. Looks like there's a spool on your plate. Can you take it off first?",
  );
  expect(mac.native.download).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'plate.jpg' }),
  );
  await press(tree, 'It’s actually clear');
  expect(mac.calls).toContain(`POST /v1/objects/${ID}/plate {"clear":true}`);
});

test('a lost pairing says to connect again, not an error code', async () => {
  const tree = await render(
    <App
      objects={fakeMac([], { failWith: 'pairing-required' }).client}
      capture={fakeCapture()}
    />,
  );
  expect(texts(tree)).toContain('Connect to your Mac again.');
  expect(texts(tree)).toContain('Connect to your Mac');
});

test('a Mac that is asleep gets one sentence and Try again', async () => {
  const tree = await render(
    <App
      objects={fakeMac([], { failWith: 'unreachable' }).client}
      capture={fakeCapture()}
    />,
  );
  expect(texts(tree)).toContain(
    "Your Mac isn't answering. Check it's on and awake, then try again.",
  );
  expect(texts(tree)).toContain('Try again');
});

test('a wide window shows the list and the page side by side', async () => {
  mockWindowWidth = 900;
  const mac = fakeMac([ready]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Ready to print');
  const shown = texts(tree);
  expect(shown).toContain('Your things');
  expect(shown).toContain('62 × 75 × 49 mm');
  expect(shown).not.toContain('‹ Back');
});

test('a scan that only partly reached the Mac finishes sending by itself', async () => {
  const mac = fakeMac([{ id: ID, scan: 'scan.usdz', state: 'new' }]);
  const capture = fakeCapture();
  (capture.finished as jest.Mock).mockResolvedValue(
    '11111111-2222-4333-8444-555555555555',
  );
  const tree = await render(<App objects={mac.client} capture={capture} />);
  await press(tree, 'Copy of your scan. Sending to your Mac…');
  expect(mac.native.sendCapture).toHaveBeenCalledWith(
    expect.objectContaining({ objectId: ID }),
  );
  expect(mac.calls).toContain(`POST /v1/objects/${ID}/start`);
});

test('a stuck send offers to finish sending when the scan is not on this phone', async () => {
  const mac = fakeMac([{ id: ID, scan: 'scan.usdz', state: 'new' }]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Sending to your Mac…');
  await press(tree, 'Finish sending');
  expect(mac.calls).toContain(`POST /v1/objects/${ID}/start`);
});

test('when the Mac stops answering, the page says so next to what it last showed', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  try {
    const mac = fakeMac([{ ...ready, state: 'touching-up' }]);
    const tree = await render(
      <App objects={mac.client} capture={fakeCapture()} />,
    );
    await press(
      tree,
      "Copy of your scan. Touching up your scan. This can take a few minutes. We'll let you know when it's ready.",
    );
    (mac.native.call as jest.Mock).mockRejectedValue(
      Object.assign(new Error('x'), { code: 'unreachable' }),
    );
    await act(async () => {
      jest.advanceTimersByTime(3100);
    });
    const shown = texts(tree);
    expect(shown).toContain(
      "Your Mac isn't answering. Check it's on and awake, then try again.",
    );
    expect(shown).toContain('62 × 75 × 49 mm');
  } finally {
    jest.useRealTimers();
  }
});

test('in the wide layout the list follows what happens on the page', async () => {
  mockWindowWidth = 900;
  const mac = fakeMac([ready]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Ready to print');
  await press(tree, 'Print');
  const rows = buttons(tree)
    .map(n => n.props.accessibilityLabel)
    .filter(Boolean);
  expect(rows).toContain('Copy of your scan. Printing');
});

test('renders fit the space they are given, not the whole window', async () => {
  mockWindowWidth = 900;
  const mac = fakeMac([ready]);
  const tree = await render(
    <App objects={mac.client} capture={fakeCapture()} />,
  );
  await press(tree, 'Copy of your scan. Ready to print');
  const plate = tree.root.find(n => n.props.testID === 'render-plate');
  await act(async () =>
    plate.props.onLayout({
      nativeEvent: { layout: { width: 420, height: 420 } },
    }),
  );
  const image = tree.root.find(n => n.props.testID === 'render-image');
  expect(image.props.style).toMatchObject({ width: 420, height: 420 });
});

test('after connecting again, an open page loads by itself', async () => {
  const { ObjectScreen } = require('../src/screens/ObjectScreen');
  const mac = fakeMac([ready], { failWith: 'pairing-required' });
  const capture = fakeCapture();
  const tree = await render(
    <ObjectScreen
      client={mac.client}
      capture={capture}
      id={ID}
      onPair={() => {}}
      refreshKey={0}
    />,
  );
  expect(texts(tree)).toContain('Connect to your Mac again.');
  (mac.native.call as jest.Mock).mockImplementation(async () => ({
    status: 200,
    body: JSON.stringify({ object: mac.objects.get(ID) }),
  }));
  await act(async () =>
    tree.update(
      <ObjectScreen
        client={mac.client}
        capture={capture}
        id={ID}
        onPair={() => {}}
        refreshKey={1}
      />,
    ),
  );
  expect(texts(tree)).toContain('62 × 75 × 49 mm');
});
