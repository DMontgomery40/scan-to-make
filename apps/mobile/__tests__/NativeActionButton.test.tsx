import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Platform, StyleSheet } from 'react-native';
import { Button, Screen } from '../src/ui/components';

function nativeButton(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.find(
    n => typeof n.type === 'string' && String(n.type) === 'STMActionButton',
  );
}

test('native actions retain their label, hint, emphasis and disabled gate', async () => {
  const press = jest.fn();
  const render = (disabled: boolean) => (
    <Button
      label="Save this project"
      accessibilityHint="Keeps your changes on this device"
      onPress={press}
      disabled={disabled}
    />
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(render(false));
  });
  expect(nativeButton(tree).props).toMatchObject({
    buttonTitle: 'Save this project',
    spokenLabel: 'Save this project',
    hint: 'Keeps your changes on this device',
    primary: true,
    disabled: false,
  });
  await act(async () => {
    nativeButton(tree).props.onPress();
  });
  expect(press).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.update(render(true));
  });
  await act(async () => {
    nativeButton(tree).props.onPress();
  });
  expect(press).toHaveBeenCalledTimes(1);
  expect(nativeButton(tree).props.disabled).toBe(true);
  await act(async () => {
    tree.unmount();
  });
});

test('measured native text height grows and shrinks without replacing the action', async () => {
  const press = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Button
        label="Save the revised drawer organizer"
        variant="secondary"
        onPress={press}
      />,
    );
  });
  expect(nativeButton(tree).props.primary).toBe(false);
  for (const height of [148, 56]) {
    await act(async () => {
      nativeButton(tree).props.onSizeChange({ nativeEvent: { height } });
    });
    expect(StyleSheet.flatten(nativeButton(tree).props.style).height).toBe(
      height,
    );
  }
  await act(async () => {
    nativeButton(tree).props.onSizeChange({
      nativeEvent: { height: Number.NaN },
    });
  });
  expect(StyleSheet.flatten(nativeButton(tree).props.style).height).toBe(56);
  await act(async () => {
    nativeButton(tree).props.onPress();
  });
  expect(press).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.unmount();
  });
});

test('native back action preserves the spoken Back label and navigation callback', async () => {
  const back = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Screen title="Project" onBack={back}>
        {null}
      </Screen>,
    );
  });
  expect(nativeButton(tree).props).toMatchObject({
    spokenLabel: 'Back',
    compact: true,
    primary: false,
  });
  await act(async () => {
    nativeButton(tree).props.onPress();
  });
  expect(back).toHaveBeenCalledTimes(1);
  await act(async () => {
    tree.unmount();
  });
});

test('Android keeps its existing action control', async () => {
  const original = Platform.OS;
  Platform.OS = 'android';
  let tree!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = ReactTestRenderer.create(
        <Button label="Save" onPress={() => {}} />,
      );
    });
    expect(
      tree.root.findAll(
        n => typeof n.type === 'string' && String(n.type) === 'STMActionButton',
      ),
    ).toHaveLength(0);
    expect(
      tree.root.find(n => n.props.accessibilityRole === 'button').props
        .disabled,
    ).toBeUndefined();
  } finally {
    await act(async () => {
      tree.unmount();
    });
    Platform.OS = original;
  }
});

test('only the native UIButton is an accessibility element (KAN-187)', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <Button
        label="Scan something"
        systemImage="viewfinder"
        onPress={() => {}}
      />,
    );
  });
  const host = nativeButton(tree).props;
  // Role, label and state on this wrapper made VoiceOver and XCUITest find
  // the same button three times; the UIButton carries them natively.
  expect(host.accessible).toBe(false);
  expect(host.accessibilityRole).toBeUndefined();
  expect(host.accessibilityLabel).toBeUndefined();
  expect(host.accessibilityState).toBeUndefined();
  expect(host).toMatchObject({
    buttonTitle: 'Scan something',
    spokenLabel: 'Scan something',
    systemImage: 'viewfinder',
  });
  await act(async () => {
    tree.unmount();
  });
});
