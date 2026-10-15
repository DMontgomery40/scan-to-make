import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileSavedProjectStorage } from '../dist/saved-project-storage.js';
import { createSavedProjects } from '@scan-to-make/contracts/saved-project';

let directory;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'saved-project-store-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const recordFile = async () => (await readdir(directory)).find(name => name.endsWith('.json'));
const draft = { id: 'retained-capture', brief: { object: 'Bottle', context: 'Drawer', addition: 'A fitted holder' }, fit: null };

test('portable project survives a fresh store and retains its exact draft and revision', async () => {
  const projects = createSavedProjects(new FileSavedProjectStorage(directory));
  assert.equal((await projects.create(draft)).status, 'ok');
  const brief = { ...draft.brief, addition: 'A fitted holder with an open side' };
  const change = await projects.change(draft.id, 0, { kind: 'replace-brief', brief });
  assert.equal(change.status, 'ok');
  const reopened = await createSavedProjects(new FileSavedProjectStorage(directory)).load(draft.id);
  assert.deepEqual(reopened, change);
  assert.equal(reopened.project.revision, 1);
  assert.deepEqual(reopened.project.brief, brief);
  assert.equal((await stat(join(directory, await recordFile()))).mode & 0o777, 0o600);
});

test('CAS compares exact persisted bytes and stale replacement leaves the record unchanged', async () => {
  const store = new FileSavedProjectStorage(directory);
  const raw = '{ "formatVersion": "future", "untouched": true }\n';
  assert.equal(await store.compareAndSwap('opaque', null, raw), true);
  assert.equal(await store.compareAndSwap('opaque', null, 'replacement'), false);
  assert.equal(await store.compareAndSwap('opaque', JSON.stringify(JSON.parse(raw)), 'replacement'), false);
  assert.equal(await store.read('opaque'), raw);
  assert.equal(await store.compareAndSwap('opaque', raw, 'exact next bytes'), true);
  assert.equal(await new FileSavedProjectStorage(directory).read('opaque'), 'exact next bytes');
});

test('independent writers cannot both replace the same bytes', async () => {
  const store = new FileSavedProjectStorage(directory);
  await store.compareAndSwap('race', null, 'before');
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
    new FileSavedProjectStorage(directory).compareAndSwap('race', 'before', 'after-' + i)));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled' && x.value === true).length, 1);
  assert.match(await store.read('race'), /^after-[0-7]$/);
  assert.equal((await readdir(directory)).length, 1);
  assert.ok((await recordFile()).endsWith('.json'));
});

test('interrupted write lock blocks replacement and is retained for inspection', async () => {
  const store = new FileSavedProjectStorage(directory);
  await store.compareAndSwap('locked', null, 'original');
  const lockName = (await recordFile()).replace(/\.json$/, '.lock');
  await mkdir(join(directory, lockName));
  await writeFile(join(directory, 'locked.abandoned.tmp'), 'partial');
  await assert.rejects(store.compareAndSwap('locked', 'original', 'replacement'), /interrupted/);
  assert.equal(await store.read('locked'), 'original');
  assert.equal((await stat(join(directory, lockName))).isDirectory(), true);
  assert.equal(await readFile(join(directory, 'locked.abandoned.tmp'), 'utf8'), 'partial');
  assert.deepEqual(await store.listIds(), ['locked']);
});

test('separate OS processes share the same CAS boundary', async () => {
  const storage = new FileSavedProjectStorage(directory);
  await storage.compareAndSwap('process-race', null, 'before');
  const moduleUrl = new URL('../dist/saved-project-storage.js', import.meta.url).href;
  const script = `import {FileSavedProjectStorage} from ${JSON.stringify(moduleUrl)};
    const store = new FileSavedProjectStorage(process.argv[1]);
    try { console.log(await store.compareAndSwap('process-race', 'before', process.argv[2])); }
    catch (error) { if (!error.message.includes('busy')) throw error; console.log('busy'); }`;
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, directory, 'writer-' + i])));
  assert.equal(results.filter(x => x.stdout.trim() === 'true').length, 1);
  assert.match(await storage.read('process-race'), /^writer-[0-3]$/);
});

test('missing directory is empty, invalid identifiers cannot escape, and oversized data never commits', async () => {
  const missing = new FileSavedProjectStorage(join(directory, 'new'));
  assert.deepEqual(await missing.listIds(), []);
  assert.equal(await missing.read('missing'), null);
  for (const id of ['../outside', '/tmp/outside', '', '.', 'a/b', 123]) {
    await assert.rejects(missing.read(id));
    await assert.rejects(missing.compareAndSwap(id, null, '{}'));
  }
  const bounded = new FileSavedProjectStorage(directory, { maxBytes: 12 });
  await assert.rejects(bounded.compareAndSwap('large', null, 'é'.repeat(7)), /limit/);
  await assert.rejects(bounded.compareAndSwap('unicode', null, '\ud800'), /Unicode/);
  assert.equal(await bounded.read('large'), null);
  await bounded.compareAndSwap('large', null, 'short');
  await writeFile(join(directory, await recordFile()), 'x'.repeat(13));
  await assert.rejects(bounded.read('large'), /limit/);
});

test('corrupt and future project bytes are surfaced without repair or data loss', async () => {
  const storage = new FileSavedProjectStorage(directory);
  await storage.compareAndSwap('broken', null, '{bad');
  await storage.compareAndSwap('future', null, '{"formatVersion":"9.0.0"}');
  const projects = createSavedProjects(storage);
  assert.equal((await projects.load('broken')).status, 'corrupt');
  assert.equal((await projects.load('future')).status, 'unsupported-version');
  assert.equal((await projects.change('broken', 0, {kind:'replace-brief',brief:draft.brief})).status, 'corrupt');
  assert.equal(await storage.read('broken'), '{bad');
  assert.deepEqual(await storage.listIds(), ['broken', 'future']);
});

test('a leading BOM stays in the exact bytes used for comparison', async () => {
  const store = new FileSavedProjectStorage(directory);
  const original = '\uFEFF{"untouched":true}';
  await store.compareAndSwap('bom', null, original);
  assert.equal(await store.read('bom'), original);
  assert.equal(await store.compareAndSwap('bom', original.slice(1), 'wrong'), false);
  assert.equal(await store.compareAndSwap('bom', original, 'right'), true);
});

test('case-distinct IDs and maximum-length IDs remain independent on the host filesystem', async () => {
  const store = new FileSavedProjectStorage(directory);
  const ids = ['CaseId', 'caseid', 'A'.repeat(128), 'a'.repeat(128)];
  for (const id of ids) assert.equal(await store.compareAndSwap(id, null, id + '-content'), true);
  for (const id of ids) assert.equal(await store.read(id), id + '-content');
  assert.deepEqual(await store.listIds(), [...ids].sort());
  const results = await Promise.all(ids.map(id => store.compareAndSwap(id, id + '-content', id + '-next')));
  assert.deepEqual(results, ids.map(() => true));
});
