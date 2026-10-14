module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // zod 4 (via @scan-to-make/contracts) ships `export * as ns` in its ESM build.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
