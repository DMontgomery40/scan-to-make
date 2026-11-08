#!/usr/bin/env node
// Runs `node --test <files…>` with a private TMPDIR and fails if anything is
// left in it afterwards, so a test that creates a temp folder without
// removing it fails the suite instead of filling /tmp (2026-11-08: ~61,000
// leftover test folders filled a 9 GB tmpfs and broke other gates).
// Suites use it as their test runner (see the services/*/package.json and
// packages/contracts/package.json `test` scripts).
import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Node's own compile cache lives in TMPDIR; it is not a test leak.
const keep = new Set(['node-compile-cache']);

const dir = await mkdtemp(join(tmpdir(), 'stm-test-tmp-'));
let code = 1;
try {
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)],
      {stdio: 'inherit', env: {...process.env, TMPDIR: dir}});
    child.on('error', reject);
    child.on('close', value => resolve(value ?? 1));
  });
  const left = (await readdir(dir)).filter(name => !keep.has(name));
  if (left.length) {
    console.error(`temp-guard: ${left.length} leftover(s) in the suite's private TMPDIR:`);
    for (const name of left.sort()) console.error(`  ${name}`);
    console.error('A test created a temp folder it did not remove. Remove it with '
      + 't.after(() => rm(dir, {recursive: true, force: true})) right after creating it, '
      + 'or use a tracked temp helper where no test context is at hand.');
    code = 1;
  }
} finally {
  await rm(dir, {recursive: true, force: true});
}
process.exit(code);
