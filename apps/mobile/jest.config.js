module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Linked packages get Babel helpers injected; resolve those from the app.
  modulePaths: ['<rootDir>/node_modules'],
  // The contracts package only exports an ESM "import" condition, which the
  // React Native Jest resolver does not request.
  moduleNameMapper: {
    '^@scan-to-make/contracts/capture$':
      '<rootDir>/../../packages/contracts/dist/capture.js',
    '^@scan-to-make/contracts/generation$':
      '<rootDir>/../../packages/contracts/dist/generation.js',
    '^@scan-to-make/contracts/detail-still$':
      '<rootDir>/../../packages/contracts/dist/detail-still.js',
    '^@scan-to-make/contracts/saved-project$':
      '<rootDir>/../../packages/contracts/dist/saved-project.js',
    '^@scan-to-make/contracts/scan-processing$':
      '<rootDir>/../../packages/contracts/dist/scan-processing.js',
    '^@scan-to-make/contracts$':
      '<rootDir>/../../packages/contracts/dist/index.js',
  },
};
