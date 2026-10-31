import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { NEARBY_SERVICE_TYPE } from '@scan-to-make/contracts/nearby-pairing';

export type Spawn = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'ignore'] }) => ChildProcess;
export interface Advert {
  close(): Promise<void>;
}

const DNS_SD = '/usr/bin/dns-sd';
const MAX_RETRY_MS = 60_000;

/** At most 63 UTF-8 bytes (one DNS label), cut on a character boundary. */
export function instanceName(name: string) {
  let out = '';
  for (const char of name.replace(/[\x00-\x1f\x7f]/g, '').trim()) {
    if (Buffer.byteLength(out + char) > 63) break;
    out += char;
  }
  return out || 'Scan to Make';
}

/**
 * Advertises `_scantomake._tcp` on the local network for nearby pairing (MAC-5), on macOS
 * only, through mDNSResponder's own `dns-sd -R`. The registration lives exactly as long as
 * that child: close() ends it. The child stays in the companion's process group, so if the
 * companion dies the agent's launchd job reaps it.
 *
 * This is the first Bonjour operation the app makes, so it is what raises the macOS Local
 * Network prompt (TN3179), under the app that owns the companion's SMAppService agent. The
 * first registration can be refused before the user answers: an error line or an exit
 * re-registers after a back-off, and the child never exits by itself, so the alert has
 * time to appear (FB16131937).
 *
 * TXT is a hint only (anyone on the Wi-Fi can advertise this type): the 6-digit code is the proof.
 */
export function advertise(options: {
  name: string;
  port: number;
  txt: Record<string, string>;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  retryMs?: number;
}): Advert | undefined {
  if ((options.platform ?? process.platform) !== 'darwin') return undefined;
  const spawn = options.spawn ?? (nodeSpawn as Spawn);
  const args = ['-R', instanceName(options.name), NEARBY_SERVICE_TYPE, 'local', String(options.port),
    ...Object.entries(options.txt).map(([key, value]) => `${key}=${value}`)];
  const base = options.retryMs ?? 2_000;
  let delay = base, closed = false, child: ChildProcess | undefined, timer: NodeJS.Timeout | undefined;
  let exited: Promise<void> = Promise.resolve();

  const run = () => {
    timer = undefined;
    if (closed) return;
    const current = spawn(DNS_SD, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child = current;
    exited = new Promise<void>((resolve) => {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        if (child === current) child = undefined;
        resolve();
        if (!closed) {
          timer = setTimeout(run, delay);
          timer.unref();
          delay = Math.min(delay * 2, MAX_RETRY_MS);
        }
      };
      current.once('exit', end);
      current.once('error', end); // Not spawned (no dns-sd): retried like an exit.
    });
    if (current.stdout)
      createInterface({ input: current.stdout }).on('line', (line) => {
        // dns-sd reports a refused or lost registration and keeps running; start again.
        if (/Name now registered and active/.test(line)) delay = base;
        else if (/Error -?\d+|Name registration removed|Name in use/.test(line)) current.kill('SIGTERM');
      });
  };
  run();

  return {
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      const current = child;
      if (current && current.exitCode === null && current.signalCode === null) {
        const kill = setTimeout(() => current.kill('SIGKILL'), 2_000);
        current.kill('SIGTERM');
        await exited;
        clearTimeout(kill);
      }
    },
  };
}
