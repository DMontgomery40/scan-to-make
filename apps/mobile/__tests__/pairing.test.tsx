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
  expect(tree.root.findAllByType(TextInput).length).toBe(3);
  await act(async () => tree.unmount());
});
it('clears invitation after a failed exchange and permits retry without clearing pairing', async () => {
  const native = nativeMock();
  let tree!: Renderer.ReactTestRenderer;
  (native.status as jest.Mock).mockResolvedValue({ state: 'disconnected' as const });
  (native.pair as jest.Mock).mockRejectedValue({ code: 'network' });
  await act(async () => {
    tree = Renderer.create(
      <CompanionScreen onBack={() => {}} native={native} />,
    );
  });
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
