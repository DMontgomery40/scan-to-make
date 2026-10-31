// Host-only CLI over the existing Python tools. The installed companion launcher
// loads its private env file before starting this entry point.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [command, ...args] = process.argv.slice(2);
const repair = ['repair', 'measure', 'render'].includes(command);
if (!repair && !['run', 'advise', 'tools'].includes(command)) {
  console.error('Usage: cleanup.mjs repair|measure|render|run|advise|tools [tool arguments]');
  process.exit(2);
}
const script = fileURLToPath(new URL(repair ? '../../tools/scan-repair/repair.py' : '../../tools/scan-correct/correct.py', import.meta.url));
const child = spawn(process.env.SCAN_TO_MAKE_CAPTURE_PYTHON ?? 'python3', [script, command, ...args], {stdio: 'inherit'});
child.once('error', error => {console.error(error.message); process.exitCode = 1;});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code, signal) => {process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);});
