import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {reportsCompletion} from '../dist/objects/completion-intent.js';
import {tempDir} from './support/temp.mjs';

async function worker(t, value) {
  const root = await tempDir('completion-test-');
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
  // A model that can't be asked is not an uncertain answer: the caller logs it and says why.
  await assert.rejects(reportsCompletion('It works, but widen the hole', '/does/not/exist'), /ENOENT|does\/not\/exist/);
});

 test('selected worker failures are unavailable, while genuine uncertainty stays unknown', async () => {
  for (const result of [{exitCode: 1}, {exitCode: 0, resultEvent: {is_error: true}}, {exitCode: 0}]) {
    await assert.rejects(reportsCompletion('Widen it', '', async () => result), /no answer/);
  }
  await assert.rejects(reportsCompletion('Widen it', '', async () => { throw new Error('AI is off'); }), /AI is off/);
  assert.equal(await reportsCompletion('Widen it', '', async () => ({exitCode: 0, resultEvent: {structured_output: {intent: 'unknown'}}})), 'unknown');
});
