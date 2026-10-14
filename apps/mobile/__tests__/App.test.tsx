/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import App from '../App';
import { mockCaptureSource } from '../src/capture/captureSource';
import { SpikeScreen } from '../src/screens/SpikeScreen';
import { RUN_TARGET_MS, SAMPLE_INTERVAL_MS } from '../src/spike/useSpikeRun';

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map(t => [t.props.children].flat().join(''));
}

function press(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const button = tree.root.find(
    n =>
      n.props.accessibilityRole === 'button' &&
      typeof n.props.onPress === 'function' &&
      n.findAllByType(Text).some(t => t.props.children === label),
  );
  return act(async () => {
    button.props.onPress();
  });
}

test('home renders and navigates to capture', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  expect(texts(tree)).toContain('Cup holder adapter');
  await press(tree, 'Start');
  expect(texts(tree)).toContain('Confirm measurements');
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
