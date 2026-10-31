import React, { useState } from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { Button, READABLE_WIDTH, Screen } from '../src/ui/components';

function Draft() {
  const [text, setText] = useState('');
  return <TextInput value={text} onChangeText={setText} />;
}

test.each([false, true])(
  'resizing protects every safe-area edge and keeps the draft (footer=%s)',
  async footer => {
    const render = (insets: {
      top: number;
      left: number;
      right: number;
      bottom: number;
    }) => (
      <SafeAreaInsetsContext.Provider value={insets}>
        <Screen
          title="Draft"
          footer={
            footer ? <Button label="Save" onPress={() => {}} /> : undefined
          }
        >
          <Draft />
        </Screen>
      </SafeAreaInsetsContext.Provider>
    );
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        render({ top: 20, left: 0, right: 0, bottom: 34 }),
      );
    });
    await act(async () => {
      tree.root
        .findByType(TextInput)
        .props.onChangeText('Keep my drawer dimensions');
      tree.update(render({ top: 0, left: 12, right: 68, bottom: 21 }));
    });
    const padding = () =>
      StyleSheet.flatten(
        tree.root.findByType(KeyboardAvoidingView).props.style,
      );
    expect(padding()).toMatchObject({
      paddingTop: 0,
      paddingLeft: 12,
      paddingRight: 68,
      paddingBottom: 21,
    });
    expect(tree.root.findByType(TextInput).props.value).toBe(
      'Keep my drawer dimensions',
    );
    await act(async () => {
      tree.update(render({ top: 10, left: 68, right: 12, bottom: 0 }));
    });
    expect(padding()).toMatchObject({
      paddingTop: 10,
      paddingLeft: 68,
      paddingRight: 12,
      paddingBottom: 0,
    });
    expect(tree.root.findByType(TextInput).props.value).toBe(
      'Keep my drawer dimensions',
    );
    await act(async () => tree.unmount());
  },
);

test('short iOS windows keep actions in the scrollable form without resetting a draft', async () => {
  const native = require('react-native');
  let height = 852;
  const dimensions = jest
    .spyOn(native, 'useWindowDimensions')
    .mockImplementation(() => ({
      width: height < 500 ? 852 : 393,
      height,
      scale: 3,
      fontScale: 1,
    }));
  const render = () => (
    <SafeAreaInsetsContext.Provider
      value={{ top: 0, left: 59, right: 59, bottom: 21 }}
    >
      <Screen
        title="Draft"
        footer={<Button label="Save draft" onPress={() => {}} />}
      >
        <Draft />
      </Screen>
    </SafeAreaInsetsContext.Provider>
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(render());
    });
    await act(async () => {
      tree.root
        .findByType(TextInput)
        .props.onChangeText('Unsaved while rotating');
      height = 393;
      tree.update(render());
    });
    expect(
      tree.root.findByType(native.ScrollView).findAllByType(Button),
    ).toHaveLength(1);
    expect(tree.root.findByType(TextInput).props.value).toBe(
      'Unsaved while rotating',
    );
    await act(async () => {
      height = 852;
      tree.update(render());
    });
    expect(tree.root.findByType(TextInput).props.value).toBe(
      'Unsaved while rotating',
    );
    expect(
      tree.root.findByType(native.ScrollView).findAllByType(Button),
    ).toHaveLength(0);
  } finally {
    if (tree) {
      await act(async () => tree.unmount());
    }
    dimensions.mockRestore();
  }
});

test('on a wide window, content and the Save action stay in one centred, readable column', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Screen title="Wide" footer={<Button label="Save" onPress={() => {}} />}>
        <Draft />
      </Screen>,
    );
  });
  const column = {
    width: '100%',
    maxWidth: READABLE_WIDTH + 48,
    alignSelf: 'center',
  };
  expect(
    StyleSheet.flatten(
      tree.root.findByType(ScrollView).props.contentContainerStyle,
    ),
  ).toMatchObject(column);
  const actions = tree.root
    .findAllByType(View)
    .filter(
      v =>
        StyleSheet.flatten(v.props.style)?.maxWidth === READABLE_WIDTH + 48 &&
        v.findAll(n => n.props.accessibilityLabel === 'Save').length > 0,
    );
  expect(actions.length).toBeGreaterThan(0);
  // On a 1366 pt iPad window the Save action stays a phone-like width.
  expect(
    StyleSheet.flatten(actions[actions.length - 1]!.props.style).maxWidth,
  ).toBeLessThan(1366 * 0.6);
  await act(async () => tree.unmount());
});
