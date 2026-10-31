import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { TextInput, Text } from 'react-native';
import { CompanionScreen } from '../src/screens/CompanionScreen';
import {
  invitation,
  pairingError,
  type CompanionNative,
  type PairingStatus,
} from '../src/companion/pairing';
import { Button } from '../src/ui/components';
const paired: PairingStatus = {
  state: 'paired',
  baseUrl: 'https://host.example.ts.net',
  deviceId: 'id',
  expiresAt: 2000000000000,
};
function nativeMock(): CompanionNative {
  return {
    status: jest.fn(async () => paired),
    pair: jest.fn(async () => paired),
    check: jest.fn(async () => paired),
    disconnect: jest.fn(async () => ({ state: 'disconnected' as const })),
    cancel: jest.fn(async () => {}),
  };
}
async function press(tree: Renderer.ReactTestRenderer, label: string) {
  await act(async () =>
    tree.root
      .findAllByType(Button)
      .find(x => x.props.label === label)!
      .props.onPress(),
  );
}
function text(tree: Renderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(Text)
    .map(x => x.props.children)
    .flat()
    .join(' ');
}
it('rejects expired and cross-host invitations before native exchange', () => {
  const json = JSON.stringify({
    version: 1,
    baseUrl: paired.baseUrl,
    code: 'A'.repeat(32),
    expiresAt: 2000,
  });
  expect(() => invitation(json, '', 2000)).toThrow();
  expect(() =>
    invitation(json, 'https://other.example.ts.net', 1000),
  ).toThrow();
  expect(invitation(json, '', 1000)).toEqual({
    baseUrl: paired.baseUrl,
    code: 'A'.repeat(32),
  });
});
it('does not expose arbitrary server errors or secrets in recovery copy', () => {
  expect(
    pairingError({ code: 'unauthorized', message: 'secret' }),
  ).not.toContain('secret');
  expect(pairingError({ code: 'certificate' })).toContain(
    'Certificate checks stay enabled',
  );
  expect(pairingError({ code: 'wrong-host' })).toContain('not forwarded');
});
it('hydrates native metadata, shows revoked recovery, and disconnects explicitly', async () => {
  const native = nativeMock();
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen onBack={() => {}} native={native} />,
    );
  });
  expect(native.check).not.toHaveBeenCalled();
  expect(text(tree)).toContain(paired.baseUrl);
  (native.check as jest.Mock).mockRejectedValue({ code: 'unauthorized' });
  await press(tree, 'Check connection');
  expect(text(tree)).toContain('revoked');
  expect(native.disconnect).not.toHaveBeenCalled();
  await press(tree, 'Disconnect this device');
  expect(native.disconnect).toHaveBeenCalledTimes(1);
  expect(text(tree)).toContain('projects and drafts are unchanged');
  expect(tree.root.findAllByType(TextInput).length).toBe(0);
  await press(tree, 'Enter code instead');
  expect(tree.root.findAllByType(TextInput).length).toBe(3);
  await act(async () => tree.unmount());
});
it('clears invitation after a failed exchange and permits retry without clearing pairing', async () => {
  const native = nativeMock();
  let tree!: Renderer.ReactTestRenderer;
  (native.status as jest.Mock).mockResolvedValue({
    state: 'disconnected' as const,
  });
  (native.pair as jest.Mock).mockRejectedValue({ code: 'network' });
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen onBack={() => {}} native={native} />,
    );
  });
  await press(tree, 'Enter code instead');
  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: 'Companion HTTPS address' })
      .props.onChangeText(paired.baseUrl);
    tree.root
      .findByProps({ accessibilityLabel: 'Pairing code or invitation' })
      .props.onChangeText('A'.repeat(32));
  });
  await press(tree, 'Pair companion');
  expect(native.pair).toHaveBeenCalledWith(
    paired.baseUrl,
    'A'.repeat(32),
    'My phone',
  );
  expect(
    tree.root.findByProps({ accessibilityLabel: 'Pairing code or invitation' })
      .props.value,
  ).toBe('');
  expect(native.disconnect).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Couldn’t reach');
  await act(async () => tree.unmount());
});

const qrCode = 'Q'.repeat(20) + 'r_-'.repeat(4);
// Built the way the companion builds it (URLSearchParams).
function qrLink(expiresAt = Date.now() + 300_000) {
  const params = new URLSearchParams({
    v: '1',
    u: paired.baseUrl!,
    c: qrCode,
    e: String(expiresAt),
  });
  return `scantomake://pair?${params.toString()}`;
}
async function unpaired(
  props: Partial<React.ComponentProps<typeof CompanionScreen>> = {},
) {
  const native = nativeMock();
  (native.status as jest.Mock).mockResolvedValue({ state: 'disconnected' });
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen onBack={() => {}} native={native} {...props} />,
    );
  });
  return { tree, native };
}

it('scanning the companion QR pairs straight away, without typing', async () => {
  const scanner = { scan: jest.fn(async () => qrLink()) };
  const { tree, native } = await unpaired({ scanner });
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  await press(tree, 'Scan QR code');
  expect(native.pair).toHaveBeenCalledWith(paired.baseUrl, qrCode, 'My phone');
  expect(text(tree)).toContain('Paired with your computer.');
  await act(async () => tree.unmount());
});

it('a cancelled scan changes nothing, and a refused camera says what to do', async () => {
  const scanner = { scan: jest.fn() };
  const { tree, native } = await unpaired({ scanner });
  scanner.scan.mockRejectedValueOnce({
    code: 'cancelled',
    message: 'Scanning cancelled.',
  });
  await press(tree, 'Scan QR code');
  expect(text(tree)).not.toContain('Scanning cancelled.');
  scanner.scan.mockRejectedValueOnce({
    code: 'camera-denied',
    message:
      'Camera access is off for Scan to Make. Turn it on in Settings, or enter the code instead.',
  });
  await press(tree, 'Scan QR code');
  expect(text(tree)).toContain('Camera access is off for Scan to Make.');
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

it('an expired or foreign QR is refused before any exchange', async () => {
  const scanner = { scan: jest.fn() };
  const { tree, native } = await unpaired({ scanner });
  scanner.scan.mockResolvedValueOnce(qrLink(Date.now() - 1));
  await press(tree, 'Scan QR code');
  expect(text(tree)).toContain('This invitation has expired.');
  scanner.scan.mockResolvedValueOnce('https://example.com/menu');
  await press(tree, 'Scan QR code');
  expect(text(tree)).toContain('Use the HTTPS address and fresh pairing code');
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

it('a pairing link from the Camera app pairs once when the screen opens', async () => {
  const onLinkUsed = jest.fn();
  const { tree, native } = await unpaired({ link: qrLink(), onLinkUsed });
  expect(onLinkUsed).toHaveBeenCalledTimes(1);
  expect(native.pair).toHaveBeenCalledTimes(1);
  expect(native.pair).toHaveBeenCalledWith(paired.baseUrl, qrCode, 'My phone');
  await act(async () => tree.unmount());
});

it('a link while already paired asks before replacing the pairing', async () => {
  const native = nativeMock();
  const onLinkUsed = jest.fn();
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen
        onBack={() => {}}
        native={native}
        link={qrLink()}
        onLinkUsed={onLinkUsed}
      />,
    );
  });
  expect(native.pair).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Pair with a new computer?');
  await press(tree, 'Keep current pairing');
  expect(text(tree)).not.toContain('Pair with a new computer?');
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => {
    tree.update(
      <CompanionScreen
        onBack={() => {}}
        native={native}
        link={qrLink(Date.now() + 400_000)}
        onLinkUsed={onLinkUsed}
      />,
    );
  });
  await press(tree, 'Pair with this one');
  expect(native.pair).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

it('a link waits while the stored pairing cannot be read', async () => {
  const native = nativeMock();
  (native.status as jest.Mock).mockRejectedValue({
    code: 'storage-unavailable',
  });
  let tree!: Renderer.ReactTestRenderer;
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen onBack={() => {}} native={native} link={qrLink()} />,
    );
  });
  expect(native.pair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
