/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Share, Text } from 'react-native';
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
      (n.props.accessibilityLabel === label ||
        n.findAllByType(Text).some(t => t.props.children === label)),
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
  expect(texts(tree)).toContain('Make it fit.');
  await press(tree, 'Open cup-holder example');
  expect(texts(tree)).toContain('Measure the fit.');
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
  await press(tree, 'Review measurements');
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
    expect.arrayContaining(['Your design study', 'Revision 1', '86 mm']),
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

test('project brief requires object, surroundings and addition before review', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  await press(tree, 'Describe a project');
  const review = () =>
    tree.root.find(
      n =>
        n.props.accessibilityRole === 'button' &&
        typeof n.props.onPress === 'function' &&
        n.findAllByType(Text).some(t => t.props.children === 'Review brief'),
    );
  expect(review().props.disabled).toBe(true);
  const fields = [
    'What are you working with?',
    'What’s around it?',
    'What would you like to add?',
  ];
  for (const [index, label] of fields.entries()) {
    await act(async () =>
      tree.root
        .find(
          n =>
            n.props.accessibilityLabel === label &&
            typeof n.props.onChangeText === 'function',
        )
        .props.onChangeText(index === 2 ? '   ' : 'A useful detail'),
    );
  }
  expect(review().props.disabled).toBe(true);
  await act(async () =>
    tree.root
      .find(
        n =>
          n.props.accessibilityLabel === fields[2] &&
          typeof n.props.onChangeText === 'function',
      )
      .props.onChangeText('A removable organizer'),
  );
  expect(review().props.disabled).toBe(false);
});

test('a generic brief survives navigation, edits and shares independently of the cup example', async () => {
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<App />);
    });
    await press(tree, 'Describe a project');
    const entries = {
      'What are you working with?': 'Coffee drawer',
      'What’s around it?': 'Shallow drawer with loose filters',
      'What would you like to add?': 'A removable organizer',
    };
    for (const [label, value] of Object.entries(entries)) {
      await act(async () =>
        tree.root
          .find(
            n =>
              n.props.accessibilityLabel === label &&
              typeof n.props.onChangeText === 'function',
          )
          .props.onChangeText(value),
      );
    }
    await press(tree, 'Review brief');
    await press(tree, 'Back');
    await press(tree, 'Open brief for Coffee drawer');
    expect(texts(tree)).toContain('A removable organizer');
    await press(tree, 'Edit idea');
    const addition = tree.root.find(
      n =>
        n.props.accessibilityLabel === 'What would you like to add?' &&
        typeof n.props.onChangeText === 'function',
    );
    expect(addition.props.value).toBe('A removable organizer');
    await act(async () =>
      addition.props.onChangeText('An organizer with two sections'),
    );
    await press(tree, 'Review brief');
    await press(tree, 'Share brief');
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('An organizer with two sections'),
      }),
    );
    expect(share.mock.calls[0][0].message).toContain(
      'Shallow drawer with loose filters',
    );
    expect(share.mock.calls[0][0].message).toContain(
      'no scan, generated geometry or fit verification',
    );
    await press(tree, 'Edit idea');
    await act(async () =>
      tree.root
        .find(
          n =>
            n.props.accessibilityLabel === 'What are you working with?' &&
            typeof n.props.onChangeText === 'function',
        )
        .props.onChangeText(''),
    );
    await press(tree, 'Back');
    await press(tree, 'Open brief for Untitled project');
    expect(
      tree.root.find(
        n =>
          n.props.accessibilityLabel === 'What are you working with?' &&
          typeof n.props.onChangeText === 'function',
      ).props.value,
    ).toBe('');
    expect(texts(tree)).toContain('What could work better?');
  } finally {
    share.mockRestore();
  }
});
