/**
 * @format
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Linking, Modal, Text } from 'react-native';
import App from '../App';

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map(t => [t.props.children].flat().join(''));
}
async function render() {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  return tree;
}
afterEach(() => jest.restoreAllMocks());

test('the shell shows the native app, and says what it needs where there is none', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  const tree = await render();
  // Jest has no native SwiftUI view, so the shell's fallback shows.
  expect(texts(tree)).toContain('Counterpart needs an iPhone or iPad.');
  expect(tree.root.findAllByType(Modal)).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('a pairing link opens the pairing screen over the app', async () => {
  jest
    .spyOn(Linking, 'getInitialURL')
    .mockResolvedValue(
      'scantomake://pair?v=1&u=https%3A%2F%2F192.168.1.2%3A9077&c=' +
        'A'.repeat(32) +
        '&e=9999999999999&f=' +
        'b'.repeat(64),
    );
  const tree = await render();
  expect(tree.root.findAllByType(Modal)).toHaveLength(1);
  await act(async () => tree.unmount());
});
