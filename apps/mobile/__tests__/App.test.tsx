/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import App from '../App';
import { mockCaptureSource } from '../src/capture/captureSource';
import { cupWidthPatch } from '../src/fit/fitDraft';
import { memoryFitSpecStore } from '../src/project/fitSpecStore';
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
  await press(tree, 'Open cup-holder example');
  expect(texts(tree)).toContain('Confirm measurements');
});

async function reachPreview(store = memoryFitSpecStore()) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App store={store} />);
  });
  await press(tree, 'Open cup-holder example');
  const values: Record<string, string> = {
    'Holder top, millimetres': '62',
    'Holder bottom, millimetres': '58',
    'Holder depth, millimetres': '35',
    'Cup width, millimetres': '86',
  };
  for (const [label, value] of Object.entries(values)) {
    const input = tree.root.find(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onChangeText === 'function',
    );
    await act(async () => input.props.onChangeText(value));
  }
  await press(tree, 'Review design');
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
  const store = memoryFitSpecStore();
  const tree = await reachPreview(store);
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['Your design', 'Revision 1', '86 mm']),
  );
  await pressWider(tree);
  expect(texts(tree)).toEqual(
    expect.arrayContaining(['Revision 2', '87 mm', '62 mm']),
  );
  expect((await store.get('draft-cup-adapter'))?.revision).toBe(2);
});

test('a stale preview edit is rejected and the latest revision is shown', async () => {
  const store = memoryFitSpecStore();
  const tree = await reachPreview(store);
  const elsewhere = (await store.get('draft-cup-adapter'))!;
  await store.applyPatch(elsewhere.id, cupWidthPatch(elsewhere, 4));

  await pressWider(tree);
  const shown = texts(tree);
  expect(shown).toEqual(expect.arrayContaining(['Revision 2', '90 mm']));
  expect(shown.some(t => t.startsWith('This preview was out of date'))).toBe(
    true,
  );
  expect(
    (await store.get('draft-cup-adapter'))?.dimensions.cupOuterDiameter
      .nominalMm,
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
