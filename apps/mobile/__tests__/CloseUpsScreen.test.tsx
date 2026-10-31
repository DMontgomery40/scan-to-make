import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, Image, Text, TextInput } from 'react-native';
import type { DetailStill } from '@scan-to-make/contracts';
import { CloseUpsScreen } from '../src/screens/CloseUpsScreen';
import { unavailableScanServices } from '../src/screens/scanServices';
import {
  fakeScanServices,
  stillFrom,
  syntheticPhoto,
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
// Native buttons render a host element inside a same-named mock wrapper.
const buttons = (tree: Tree, name: string) =>
  tree.root.findAll(
    n =>
      n.props.accessibilityRole === 'button' &&
      n.props.accessibilityLabel === name &&
      typeof n.props.onPress === 'function',
    { deep: false },
  );
async function press(tree: Tree, name: string) {
  const [match] = buttons(tree, name);
  if (!match) throw Error(`No button ${name}\n${texts(tree)}`);
  await act(async () => {
    match.props.onPress();
  });
}
async function label(tree: Tree, field: string, value: string) {
  await act(async () => {
    tree.root
      .find(n => n.type === TextInput && n.props.accessibilityLabel === field)
      .props.onChangeText(value);
  });
}
async function render(
  services: ReturnType<typeof fakeScanServices>['services'],
) {
  const onCompanion = jest.fn();
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <CloseUpsScreen
        target={syntheticTarget()}
        services={services}
        onBack={() => {}}
        onCompanion={onCompanion}
      />,
    );
  });
  return { tree, onCompanion };
}
afterEach(() => jest.restoreAllMocks());

test('an empty scan explains close-ups and the limits', async () => {
  const { services, calls } = fakeScanServices();
  const { tree } = await render(services);
  const shown = texts(tree);
  expect(shown).toContain('ports, buttons and edges');
  expect(shown).toContain('No close-ups yet');
  expect(shown).toContain('0 of 24');
  expect(shown).toContain('Up to 24 photos, 25 MB each. JPEG, HEIC or PNG.');
  expect(calls).toEqual(['acknowledge', 'list']);
  await act(async () => tree.unmount());
});

test('loading is shown until the list arrives', async () => {
  const { services } = fakeScanServices();
  services.stills.list = () => new Promise(() => {});
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Loading your close-ups…');
  expect(buttons(tree, 'Choose a photo')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('chosen photos get optional labels and are added one by one', async () => {
  const port = syntheticPhoto({ mediaType: 'image/jpeg' });
  const button = syntheticPhoto();
  const { services, calls } = fakeScanServices({
    picks: [{ photos: [port, button], rejected: [] }],
  });
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  expect(calls).toContain('pick 24');
  expect(texts(tree)).toContain('READY TO ADD');
  expect(tree.root.findAllByType(Image).map(i => i.props.source.uri)).toEqual([
    port.uri,
    button.uri,
  ]);
  await label(tree, 'What does photo 1 show?', '  USB-C port ');
  await press(tree, 'Add 2 photos to scan');
  expect(calls.filter(c => c.startsWith('upload'))).toEqual([
    `upload ${port.sha256.slice(-4)} "USB-C port"`,
    `upload ${button.sha256.slice(-4)}`,
  ]);
  const shown = texts(tree);
  expect(shown).toContain('ADDED TO THIS SCAN');
  expect(shown).toContain('USB-C port');
  expect(shown).toContain('Close-up 2');
  expect(shown).toContain('2 of 24');
  expect(shown).not.toContain('READY TO ADD');
  await act(async () => tree.unmount());
});

test('only the remaining room is offered, and a full scan stops picking', async () => {
  const existing = Array.from({ length: 23 }, (_, i) =>
    stillFrom(syntheticPhoto(), i),
  );
  const { services, calls } = fakeScanServices({
    stills: existing,
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  expect(calls).toContain('pick 1');
  expect(buttons(tree, 'Choose another photo')[0].props.disabled).toBe(true);
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('That’s the limit');
  expect(texts(tree)).toContain('24 of 24');
  expect(buttons(tree, 'Choose another photo')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('the companion limit is explained if it is reached during upload', async () => {
  const { services } = fakeScanServices({
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  services.stills.upload = async () => {
    throw Object.assign(Error('limit'), { code: 'still-limit', status: 409 });
  };
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('This scan already has 24 close-ups.');
  await act(async () => tree.unmount());
});

test('photos over 25 MB or in other formats are explained and not added', async () => {
  const ok = syntheticPhoto();
  const { services } = fakeScanServices({
    picks: [
      {
        photos: [
          ok,
          syntheticPhoto({ byteLength: 26 * 1024 * 1024 }),
          syntheticPhoto({ mediaType: 'image/gif' }),
          ok,
        ],
        rejected: [{ reason: 'too-large', byteLength: 40_000_000 }],
      },
    ],
  });
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  const shown = texts(tree);
  expect(shown).toContain(
    '3 photos weren’t added: 2 are over 25 MB, 1 isn’t a JPEG, HEIC or PNG photo.',
  );
  expect(shown).toContain('1 photo was already here.');
  expect(buttons(tree, 'Add 1 photo to scan')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a lost upload reply is checked against the list before any retry', async () => {
  const landed = syntheticPhoto();
  const lost = syntheticPhoto();
  const { services, calls, stills } = fakeScanServices({
    picks: [{ photos: [landed, lost], rejected: [] }],
  });
  const upload = services.stills.upload;
  services.stills.upload = async (_p, _c, _a, source) => {
    if (source.sha256 === landed.sha256) {
      stills.push(stillFrom(landed, 99));
    }
    calls.push('upload unconfirmed');
    throw Object.assign(Error('lost'), { code: 'ambiguous-upload' });
  };
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  await press(tree, 'Add 2 photos to scan');
  let shown = texts(tree);
  // The first upload did land, so it is listed; the second stays unconfirmed.
  expect(shown).toContain('1 of 24');
  expect(shown).toContain('Not confirmed');
  expect(shown).toContain('We couldn’t confirm this photo was added');
  expect(buttons(tree, 'Add 0 photos to scan')[0].props.disabled).toBe(true);
  services.stills.upload = upload;
  await press(tree, 'Check the list again');
  shown = texts(tree);
  expect(shown).toContain('Not in the list. You can add it again.');
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('2 of 24');
  await act(async () => tree.unmount());
});

test('a rejected upload stays ready to retry with the reason', async () => {
  const { services } = fakeScanServices({
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  services.stills.upload = async () => {
    throw Object.assign(
      Error('Only JPEG, HEIC or PNG photos can be attached.'),
      { status: 415 },
    );
  };
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('Not added');
  expect(texts(tree)).toContain('Only JPEG, HEIC or PNG');
  expect(buttons(tree, 'Add 1 photo to scan')).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('removing a close-up asks first and updates the list', async () => {
  const { services, calls } = fakeScanServices({
    stills: [stillFrom(syntheticPhoto(), 0, 'Power button')],
  });
  const alert = jest.spyOn(Alert, 'alert');
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Power button');
  await press(tree, 'View close-up 1');
  // A verified thumbnail opens inline; Quick Look stays the fallback.
  expect(texts(tree)).toContain('Done');
  expect(calls.some(c => c.startsWith('view'))).toBe(false);
  await press(tree, 'Done');
  await press(tree, 'Remove close-up 1');
  expect(calls.some(c => c.startsWith('remove'))).toBe(false);
  await act(async () => {
    alert.mock.calls[0][2]!.find(b => b.text === 'Remove')!.onPress!();
  });
  expect(calls.some(c => c.startsWith('remove'))).toBe(true);
  expect(texts(tree)).toContain('No close-ups yet');
  await act(async () => tree.unmount());
});

test('discarding a chosen photo removes its local copy', async () => {
  const { services, calls } = fakeScanServices({
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  await press(tree, 'Don’t add photo 1');
  expect(calls).toContain('discard 1');
  expect(texts(tree)).toContain('No close-ups yet');
  await act(async () => tree.unmount());
});

test('a revoked connection asks to connect, keeping chosen photos', async () => {
  const { services } = fakeScanServices({
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  const { tree, onCompanion } = await render(services);
  await press(tree, 'Choose a photo');
  services.stills.upload = async () => {
    throw Object.assign(Error('revoked'), { status: 401 });
  };
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('Connect your companion');
  await press(tree, 'Connect companion');
  expect(onCompanion).toHaveBeenCalled();
  services.stills.upload = fakeScanServices().services.stills.upload;
  await press(tree, 'Try again');
  expect(texts(tree)).toContain('READY TO ADD');
  await act(async () => tree.unmount());
});

test('a list failure is shown with a way to try again', async () => {
  const { services } = fakeScanServices();
  const list = services.stills.list;
  services.stills.list = async () => {
    throw Error('The companion could not complete this request (503).');
  };
  const { tree } = await render(services);
  expect(texts(tree)).toContain('Couldn’t load close-ups');
  services.stills.list = list;
  await press(tree, 'Try again');
  expect(texts(tree)).toContain('No close-ups yet');
  await act(async () => tree.unmount());
});

test('without the companion transport close-ups say they are unavailable', async () => {
  const { tree } = await render(unavailableScanServices());
  expect(texts(tree)).toContain('Not available here');
  expect(buttons(tree, 'Choose a photo')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a failed list check keeps an unconfirmed upload from being retried', async () => {
  const photo = syntheticPhoto();
  const { services, calls } = fakeScanServices({
    picks: [{ photos: [photo], rejected: [] }],
  });
  const list = services.stills.list;
  const upload = services.stills.upload;
  services.stills.upload = async () => {
    throw Object.assign(Error('lost'), { code: 'ambiguous-upload' });
  };
  const { tree } = await render(services);
  await press(tree, 'Choose a photo');
  services.stills.list = async () => {
    throw Error('Couldn’t reach your companion.');
  };
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('the list couldn’t be checked');
  expect(buttons(tree, 'Add 0 photos to scan')[0].props.disabled).toBe(true);

  // Checking again while the list still fails must not offer a retry.
  await press(tree, 'Check the list again');
  let shown = texts(tree);
  expect(shown).toContain('Not confirmed');
  expect(shown).not.toContain('Not in the list');
  expect(buttons(tree, 'Add 0 photos to scan')[0].props.disabled).toBe(true);

  // Only a successful list without the photo allows adding it again.
  services.stills.list = list;
  services.stills.upload = upload;
  await press(tree, 'Check the list again');
  shown = texts(tree);
  expect(shown).toContain('Not in the list. You can add it again.');
  await press(tree, 'Add 1 photo to scan');
  expect(texts(tree)).toContain('1 of 24');
  expect(calls.filter(c => c.startsWith('upload'))).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('stored close-ups get verified thumbnails, downloading only uncached ones', async () => {
  const onDevice = stillFrom(syntheticPhoto(), 0, 'USB-C port');
  const remote = stillFrom(syntheticPhoto(), 1);
  const { services, calls } = fakeScanServices({
    stills: [onDevice, remote],
    cachedStills: [onDevice.sha256],
  });
  const { tree } = await render(services);
  expect(calls).toContain('still uri 0');
  expect(calls).not.toContain('download still 0');
  expect(calls).toEqual(
    expect.arrayContaining(['still uri 1', 'download still 1']),
  );
  expect(tree.root.findAllByType(Image)).toHaveLength(2);
  await act(async () => {
    tree.root
      .find(
        n =>
          n.props.accessibilityRole === 'imagebutton' &&
          n.props.accessibilityLabel === 'Close-up 2' &&
          typeof n.props.onPress === 'function',
      )
      .props.onPress();
  });
  expect(texts(tree)).toContain('Close-up 2 · 2 of 2');
  await act(async () => tree.unmount());
});

test('a close-up without a display copy opens in Quick Look', async () => {
  const { services, calls } = fakeScanServices({
    stills: [stillFrom(syntheticPhoto(), 0)],
  });
  delete services.stills.imageUri;
  const { tree } = await render(services);
  expect(tree.root.findAllByType(Image)).toHaveLength(0);
  await press(tree, 'View close-up 1');
  expect(calls.some(c => c.startsWith('view'))).toBe(true);
  await act(async () => tree.unmount());
});

test('choosing photos waits for a thumbnail request already in flight', async () => {
  const { services, calls } = fakeScanServices({
    stills: [stillFrom(syntheticPhoto(), 0)],
    picks: [{ photos: [syntheticPhoto()], rejected: [] }],
  });
  let finish!: () => void;
  const download = services.stills.download!;
  services.stills.download = (...args) =>
    new Promise(resolve => {
      finish = () => resolve(download(...args));
    });
  const { tree } = await render(services);
  await act(async () => {
    buttons(tree, 'Choose a photo')[0].props.onPress();
  });
  // The companion serves one request at a time.
  expect(calls.some(c => c.startsWith('pick'))).toBe(false);
  await act(async () => finish());
  expect(calls.some(c => c.startsWith('pick'))).toBe(true);
  expect(texts(tree)).toContain('READY TO ADD');
  await act(async () => tree.unmount());
});

test('thumbnails work with a client whose methods rely on this', async () => {
  const stored = stillFrom(syntheticPhoto(), 0, 'USB-C port');
  const { services } = fakeScanServices({ stills: [stored] });
  const base = services.stills;
  // Like DetailStillsClient: methods read instance state through `this`.
  class ClientLikeStills {
    private readonly root = 'file:///client/';
    list = base.list;
    upload = base.upload;
    openFile = base.openFile;
    remove = base.remove;
    async imageUri(still: DetailStill) {
      return `${this.root}${still.sha256.slice(-6)}.jpg`;
    }
  }
  services.stills = new ClientLikeStills();
  const { tree } = await render(services);
  expect(tree.root.findAllByType(Image).map(i => i.props.source.uri)).toEqual([
    `file:///client/${stored.sha256.slice(-6)}.jpg`,
  ]);
  await act(async () => tree.unmount());
});

test('a close-up not on this device is downloaded when the cache lookup rejects', async () => {
  const stored = stillFrom(syntheticPhoto(), 0, 'Hinge');
  const { services, calls } = fakeScanServices({ stills: [stored] });
  const { tree } = await render(services);
  // The first lookup rejects (cache miss); the verified download follows.
  expect(calls.filter(c => /still/.test(c))).toEqual([
    'still uri 0',
    'download still 0',
    'still uri 0',
  ]);
  expect(tree.root.findAllByType(Image).map(i => i.props.source.uri)).toEqual([
    `file:///synthetic/still-${stored.sha256.slice(-6)}.jpg`,
  ]);
  expect(texts(tree)).not.toContain('The preview couldn’t be loaded');
  await act(async () => tree.unmount());
});

test('a failed preview download is shown and can be retried', async () => {
  const stored = stillFrom(syntheticPhoto(), 0);
  const { services, calls } = fakeScanServices({ stills: [stored] });
  const download = services.stills.download!;
  services.stills.download = async () => {
    calls.push('download failed');
    throw Error('Couldn’t reach your companion.');
  };
  const { tree } = await render(services);
  expect(texts(tree)).toContain('The preview couldn’t be loaded.');
  expect(tree.root.findAllByType(Image)).toHaveLength(0);
  services.stills.download = download;
  await press(tree, 'Retry preview for close-up 1');
  expect(tree.root.findAllByType(Image)).toHaveLength(1);
  expect(texts(tree)).not.toContain('The preview couldn’t be loaded.');
  expect(calls.filter(c => c === 'download failed')).toHaveLength(1);
  await act(async () => tree.unmount());
});
