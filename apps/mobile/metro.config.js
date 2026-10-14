const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // Linked from ../../packages via file: dependencies; Metro must watch them.
  watchFolders: [path.resolve(__dirname, '../../packages/contracts')],
  resolver: {
    // Linked packages get Babel helpers injected; resolve those from the app.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
