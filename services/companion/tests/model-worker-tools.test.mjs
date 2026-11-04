import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installedModelWorkerTools} from '../dist/model-worker-tools.js';

test('cleanup helper reads only independent tool paths from its app-owned configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stm-worker-tools-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  await writeFile(join(root, 'companion.env'), 'SCAN_TO_MAKE_CAPTURE_PYTHON="/independent workers/.venv/bin/python3"\nSCAN_TO_MAKE_AI_JUDGE_TOOL="/independent workers/judge"\nSCAN_TO_MAKE_SCAN_BLENDER=/Applications/Blender.app/Contents/MacOS/Blender\nSCAN_TO_MAKE_MODEL_KEY=private-fixture\nHOME=/untrusted\nSCAN_TO_MAKE_AI_ENDPOINT=https://untrusted.invalid\n');
  assert.deepEqual(installedModelWorkerTools(root), {
    SCAN_TO_MAKE_CAPTURE_PYTHON:'/independent workers/.venv/bin/python3',
    SCAN_TO_MAKE_AI_JUDGE_TOOL:'/independent workers/judge',
    SCAN_TO_MAKE_SCAN_BLENDER:'/Applications/Blender.app/Contents/MacOS/Blender',
  });
});

test('fresh helper invents no judge; migrated workers retain their adjacent installed judge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stm-worker-tools-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  assert.deepEqual(installedModelWorkerTools(root), {});
  const workers = join(root, 'workers');
  await mkdir(join(workers, 'ai-tweak-judge'), {recursive:true});
  await writeFile(join(root, 'app-migration.json'), JSON.stringify({workerEnvironment:{SCAN_TO_MAKE_SCAN_REPAIR_TOOL:join(workers,'scan-repair/repair.py'),SCAN_TO_MAKE_CAPTURE_PYTHON:'/legacy/python',HOME:'/untrusted'}}));
  await writeFile(join(root, 'companion.env'), 'SCAN_TO_MAKE_CAPTURE_PYTHON=/configured/python\n');
  assert.deepEqual(installedModelWorkerTools(root), {SCAN_TO_MAKE_CAPTURE_PYTHON:'/configured/python',SCAN_TO_MAKE_AI_JUDGE_TOOL:join(workers,'ai-tweak-judge')});
  await writeFile(join(root, 'companion.env'), 'SCAN_TO_MAKE_AI_JUDGE_TOOL=relative/unsafe\n');
  assert.throws(() => installedModelWorkerTools(root), /absolute/);
});
