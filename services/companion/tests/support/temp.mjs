// Temp folders for tests, removed when the test file finishes — pass or fail.
// Test helpers that run without a test context (setup/input/pass/…) use these
// instead of mkdtemp(join(tmpdir(), …)): the bare form leaked about 300
// folders per companion run into /tmp (2026-11-08: /tmp filled with them).
import {after} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dirs = new Set();
after(() => { for (const dir of dirs) rmSync(dir, {recursive: true, force: true}); });

export async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

export function tempDirSync(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}
