// The invitation stays on stdin, never argv, environment, logs or a file.
// Use the selected installation's module, including when it is a legacy release.
import {pathToFileURL} from 'node:url';

try {
  let payload = '';
  for await (const chunk of process.stdin) {
    payload += chunk;
    if (Buffer.byteLength(payload) >= 4096) throw new Error();
  }
  const url = new URL(payload);
  if (url.protocol !== 'scantomake:' || url.hostname !== 'pair') throw new Error();
  const {RemoteAuthStore} = await import(pathToFileURL(process.argv[2]).href);
  const store = await RemoteAuthStore.open(process.argv[3]);
  const active = await store.isPairingActive(url.searchParams.get('c') ?? '');
  process.stdout.write(JSON.stringify(active));
} catch {
  process.exitCode = 1;
}
