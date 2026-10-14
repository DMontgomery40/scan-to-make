// Metro entry that runs CORE_PROBES outside the app, e.g. in the Hermes CLI.
// It imports the same modules the spike harness uses; no React Native runtime.
import { runCoreProbes } from '../src/spike/runtimeProbes';

declare const print: ((line: string) => void) | undefined;

const result = runCoreProbes();
const line = JSON.stringify(result);
if (typeof print === 'function') {
  print(line);
} else {
  console.log(line);
}
