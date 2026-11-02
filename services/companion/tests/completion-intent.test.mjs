import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {reportsCompletion} from '../dist/objects/completion-intent.js';

async function worker(t, value) {
  const root = await mkdtemp(join(tmpdir(), 'completion-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'claude');
  await writeFile(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--strict-mcp-config')) process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(value))});
`, {mode: 0o700});
  return path;
}

test('classification distinguishes changes, success and uncertainty without truncating input', async t => {
  for (const [reply, expected] of [[{structured_output: {intent: 'works'}}, 'works'], [{structured_output: {intent: 'changes'}}, 'changes'], [{structured_output: {intent: 'unknown'}}, 'unknown'], [{result: 'works'}, 'unknown']]) {
    assert.equal(await reportsCompletion('DONE. mounted and working. thanks!!', await worker(t, reply)), expected);
  }
  assert.equal(await reportsCompletion('It works. ' + ' '.repeat(4000) + 'But widen the hole', await worker(t, {structured_output: {intent: 'works'}})), 'unknown');
  assert.equal(await reportsCompletion('It works, but widen the hole', '/does/not/exist'), 'unknown');
});
