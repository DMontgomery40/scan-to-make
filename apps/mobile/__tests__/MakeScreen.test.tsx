import React, { useState } from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { MakeScreen, type MakeIdea } from '../src/screens/MakeScreen';

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
const option = (tree: Tree, name: string) =>
  tree.root.find(
    n =>
      n.props.accessibilityRole === 'radio' &&
      n.props.accessibilityLabel === name &&
      typeof n.props.onPress === 'function',
  );
const notes = (tree: Tree) => tree.root.findAll(n => n.type === TextInput);

function Host({ seen }: { seen: (idea: MakeIdea | null) => void }) {
  const [idea, setIdea] = useState<MakeIdea | null>(null);
  seen(idea);
  return <MakeScreen idea={idea} onChange={setIdea} onBack={() => {}} />;
}

test('choosing what to make keeps the choice and free text, with no fake result', async () => {
  let latest: MakeIdea | null = null;
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(<Host seen={idea => (latest = idea)} />);
  });
  let shown = texts(tree);
  expect(shown).toContain('Stand or cradle');
  expect(shown).toContain('Drawer tray');
  expect(shown).toContain('Cup holder adapter');
  expect(shown).toContain('Something else');
  expect(shown).toContain('Design generation is coming soon.');
  expect(shown).toContain('Nothing has been designed yet.');
  expect(notes(tree)).toHaveLength(0);
  const create = tree.root.find(
    n =>
      String(n.type) === 'STMActionButton' &&
      n.props.buttonTitle === 'Create design',
  );
  expect(create.props.disabled).toBe(true);

  await act(async () => {
    option(tree, 'Stand or cradle').props.onPress();
  });
  expect(option(tree, 'Stand or cradle').props.accessibilityState).toEqual({
    checked: true,
  });
  await act(async () => {
    notes(tree)[0].props.onChangeText('Tilted back, room for the cable');
  });
  // Switching keeps what the user already wrote.
  await act(async () => {
    option(tree, 'Something else').props.onPress();
  });
  expect(latest).toEqual({
    kind: 'custom',
    notes: 'Tilted back, room for the cable',
  });
  expect(notes(tree)[0].props.accessibilityLabel).toBe(
    'Describe what you’d like to make',
  );
  await act(async () => {
    notes(tree)[0].props.onChangeText('   ');
    notes(tree)[0].props.onBlur();
  });
  shown = texts(tree);
  expect(shown).toContain('Describe your idea in a few words.');
  await act(async () => tree.unmount());
});

test('a saved idea reopens selected with its words', async () => {
  let tree!: Tree;
  await act(async () => {
    tree = Renderer.create(
      <MakeScreen
        idea={{ kind: 'tray', notes: 'Two cable slots' }}
        onChange={() => {}}
        onBack={() => {}}
      />,
    );
  });
  expect(option(tree, 'Drawer tray').props.accessibilityState).toEqual({
    checked: true,
  });
  expect(notes(tree)[0].props.value).toBe('Two cable slots');
  await act(async () => tree.unmount());
});
