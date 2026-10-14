import React, { useState } from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { KeyboardAvoidingView, StyleSheet, TextInput } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { Button, Screen } from '../src/ui/components';

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
