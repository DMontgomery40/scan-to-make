import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {runTouchupWorker} from '../dist/touchup/runner.js';
import {prepareTouchupPass} from '../dist/touchup/inputs.js';
import {publicObject} from '../dist/objects/http.js';

test('worker activity contains public text and tool names, never thinking, arguments or credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-worker-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const pass = await prepareTouchupPass({root, objectId: 'test', scan: [], photos: [], requirePhotos: false});
  const events = [
    {type: 'assistant', message: {content: [
      {type: 'thinking', thinking: 'private reasoning'},
      {type: 'text', text: 'Inspecting the reference photos.'},
      {type: 'tool_use', name: 'Read', input: {secret: 'private argument'}},
    ]}},
    {type: 'assistant', message: {content: [{type: 'text', text: 'key example-private-key and Bearer bearer-secret-value'}]}},
    {type: 'result', is_error: true, result: 'Stopped before making a model.'},
  ];
  const script = `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`;
  const activity = [];
  await runTouchupWorker({command: process.execPath, args: ['-e', script], env: {PATH: process.env.PATH}, cwd: pass.dir,
    mcpConfigPath: join(root, 'mcp.json'), mcpConfig: {mcpServers: {printer: {command: '/usr/bin/true', args: [], env: {API_KEY: 'example-private-key'}}}}}, pass,
    {onProgress: progress => activity.push(...(progress.activity ?? []))});
  assert.deepEqual(activity.map(({kind, text}) => ({kind, text})), [
    {kind: 'message', text: 'Inspecting the reference photos.'},
    {kind: 'tool', text: 'Read'},
    {kind: 'message', text: 'key [redacted] and Bearer [redacted]'},
  ]);
  assert.ok(activity.every(item => Number.isFinite(item.atMs) && item.atMs > 0));
  const serialized = JSON.stringify(activity);
  for (const secret of ['private reasoning', 'private argument', 'example-private-key', 'bearer-secret-value']) assert.equal(serialized.includes(secret), false);
});

test('worker progress persists in event order before failure and survives the next pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-activity-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = new ObjectStore(root), changes = [];
  let attempt = 0;
  const service = new ObjectService({store, claudePath: '/unused', stlInfo: async () => undefined,
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    onChange: object => changes.push(object),
    runTouchup: async input => {
      attempt++;
      input.onProgress?.({seconds: 1, toolCalls: 1, activity: [
        {atMs: 101, kind: 'message', text: `Looking at the photos, pass ${attempt}.`},
        {atMs: 102, kind: 'tool', text: 'Read'},
      ]});
      input.onProgress?.({seconds: 2, toolCalls: 1, activity: [{atMs: 103, kind: 'message', text: 'Checking the fit.'}]});
      throw new Error(`Worker stopped ${attempt}.`);
    }});
  const object = await service.create('A hook.');
  await service.start(object.id);
  const first = await service.settled(object.id);
  assert.equal(first.state, 'failed');
  assert.equal(first.progress, undefined);
  assert.equal(first.failure, 'Worker stopped 1.');
  assert.deepEqual(first.passes[0].activity?.map(item => item.text), [
    'Looking at the photos, pass 1.', 'Read', 'Checking the fit.', 'Worker stopped 1.',
  ]);
  assert.ok(changes.some(value => value.state === 'touching-up' && value.progress === 'Checking the fit.'));
  assert.ok(first.passes[0].endedAtMs);
  await service.start(object.id);
  await service.settled(object.id);
  const persisted = await new ObjectStore(root).get(object.id);
  assert.deepEqual(persisted.passes[0], first.passes[0]);
  assert.equal(persisted.passes.length, 2);
  assert.equal(persisted.passes[1].activity.at(-1).text, 'Worker stopped 2.');
});

test('a long worker pass keeps bounded activity and the final failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-activity-bounds-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const service = new ObjectService({store: new ObjectStore(root), claudePath: '/unused', stlInfo: async () => undefined,
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    runTouchup: async input => {
      input.onProgress?.({seconds: 1, toolCalls: 0, activity: Array.from({length: 500}, (_, i) => ({atMs: i, kind: 'message', text: `${i}: ${'x'.repeat(5000)}`}))});
      return {status: 'failed', reason: 'Could not finish.', renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 0}, passDir: root};
    }});
  const object = await service.create('A hook.');
  await service.start(object.id);
  const final = await service.settled(object.id), activity = final.passes[0].activity;
  assert.ok(activity.length <= 200);
  assert.ok(activity.every(item => item.text.length <= 2000));
  assert.equal(activity.at(-1).text, 'Could not finish.');
  assert.ok(activity.slice(0, -1).every((entry, i, all) => i === 0 || entry.atMs >= all[i - 1].atMs));
});

test('tool progress uses plain language while retained activity keeps exact tool names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-progress-words-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const changes = [], names = ['mcp__printer__blender_mcp_call', 'Read', 'WebSearch', 'WebFetch', 'Bash'];
  const service = new ObjectService({store: new ObjectStore(root), claudePath: '/unused', stlInfo: async () => undefined,
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, onChange: object => changes.push(object),
    runTouchup: async input => {
      names.forEach((name, index) => input.onProgress?.({seconds: index, toolCalls: index + 1,
        activity: [{atMs: index + 1, kind: 'tool', text: name}]}));
      throw new Error('Synthetic stop.');
    }});
  const object = await service.create('A hook.');
  await service.start(object.id);
  const result = await service.settled(object.id);
  assert.deepEqual(changes.filter(object => object.progress).map(object => object.progress), [
    'Working on the model in Blender.', 'Checking the reference material.', 'Checking the reference material.',
    'Checking the reference material.', 'Working on your project.',
  ]);
  assert.deepEqual(result.passes[0].activity.filter(entry => entry.kind === 'tool').map(entry => entry.text), names);
});

test('final worker messages and thrown errors are redacted everywhere in the public project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objects-public-results-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const model = join(root, 'result.stl');
  await writeFile(model, 'solid result\nendsolid result\n');
  for (const status of ['done', 'failed', 'needs_closeup', 'throws']) {
    await t.test(status, async () => {
      const secret = 'synthetic-result-credential';
      const service = new ObjectService({store: new ObjectStore(join(root, status)), claudePath: '/unused', stlInfo: async () => undefined,
        handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', env: {API_KEY: secret}}},
        runTouchup: async input => {
          input.onProgress?.({seconds: 1, toolCalls: 0, activity: [{atMs: 101, kind: 'message', text: `Checking with ${secret}.`}]});
          if (status === 'throws') throw new Error(`Worker stopped using ${secret}.`);
          return {status, model: status === 'done' ? model : undefined, summary: `Worker summary using ${secret}.`,
            closeup: `Show the underside; token=synthetic-closeup-token`, reason: `Worker stopped using ${secret}.`,
            renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 0}, passDir: root};
        }});
      const object = await service.create('A hook.');
      await service.start(object.id);
      const finished = await service.settled(object.id);
      const serialized = JSON.stringify(publicObject(finished));
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes('synthetic-closeup-token'), false);
      assert.ok(serialized.includes('[redacted]'));
      assert.deepEqual(await new ObjectStore(join(root, status)).get(object.id), JSON.parse(JSON.stringify(finished)));
    });
  }
});
