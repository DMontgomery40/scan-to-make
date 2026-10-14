/* eslint-env jest */
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// React Native exposes components through lazy getters. Resolve the app's core
// components during environment setup so cold-cache transforms are not charged
// to the first interaction test's timeout on slower CI workers.
const native = require('react-native');
[
  'View',
  'Text',
  'Pressable',
  'ScrollView',
  'KeyboardAvoidingView',
  'TextInput',
  'StatusBar',
].forEach(component => native[component]);
