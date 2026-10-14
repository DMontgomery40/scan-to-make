import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectStore } from '@scan-to-make/project';
import { exportAcceptedStl } from '../dist/stl-export.js';

const spec = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/tapered-holder.json', import.meta.url), 'utf8'));
const ascii = Buffer.from('solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 1\nendloop\nendfacet\nendsolid fixture\n');
const artifact = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mediaType: 'model/stl' });
function binary() {
  const b = Buffer.alloc(134); b.write('solid binary header'); b.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 1].forEach((n, i) => b.writeFloatLE(n, 84 + i * 4));
  return b;
}
let dir, projects, source, output;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'accepted-stl-')); projects = new ProjectStore(join(dir, 'projects')); source = join(dir, 'source.stl'); output = join(dir, 'export.stl'); await projects.create(spec); });
afterEach(async () => rm(dir, { recursive: true, force: true }));
async function accept(bytes, ref = artifact(bytes)) { await writeFile(source, bytes); await projects.attachPreview(spec.id, 0, ref); await projects.acceptPreview(spec.id, 0, ref); }
function request(store = projects) { return exportAcceptedStl(store, { projectId: spec.id, expectedRevision: 0, sourcePath: source, outputPath: output }); }

for (const [name, bytes] of [['ASCII', ascii], ['binary with solid header', binary()]]) test(`exports accepted ${name} bytes with scoped geometry receipt`, async () => {
  await accept(bytes); const receipt = await request();
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(receipt.artifact, artifact(bytes));
  assert.equal(receipt.specRevision, 0); assert.equal(receipt.geometry.triangleCount, 1);
  assert.deepEqual(receipt.geometry.boundsMm, { min: [0, 0, 0], max: [10, 10, 1] });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.ok(Object.isFrozen(receipt.geometry.boundsMm.min));
  assert.equal(receipt.printable, undefined);
});

test('changed source digest rejects before output exists', async () => {
  await accept(ascii); await writeFile(source, Buffer.from(ascii.toString().replace('10 0 0', '11 0 0')));
  await assert.rejects(request(), /artifact bytes/); await assert.rejects(access(output), { code: 'ENOENT' });
});
test('wrong length rejects before output exists', async () => {
  await accept(ascii, { ...artifact(ascii), byteLength: ascii.length + 1 });
  await assert.rejects(request(), /artifact bytes/); await assert.rejects(access(output), { code: 'ENOENT' });
});
test('requires current accepted STL and exact expected revision', async () => {
  await assert.rejects(request(), /accepted/);
  await accept(ascii, { ...artifact(ascii), mediaType: 'application/octet-stream' });
  await assert.rejects(request(), /STL/);
  await accept(ascii); await projects.applyPatch(spec.id, { expectedRevision: 0, dimensions: { cupSupportHeight: { ...spec.dimensions.cupSupportHeight, nominalMm: 50, lowerMm: 50, upperMm: 50 } } });
  await assert.rejects(request(), /revision|accepted/); await assert.rejects(access(output), { code: 'ENOENT' });
});
test('a project edit during preparation rejects and cleans its private temporary file', async () => {
  await accept(ascii); let reads = 0;
  const store = { load: async id => {
    if (++reads === 2) await projects.applyPatch(id, { expectedRevision: 0, dimensions: { cupSupportHeight: { ...spec.dimensions.cupSupportHeight, nominalMm: 50, lowerMm: 50, upperMm: 50 } } });
    return projects.load(id);
  } };
  await assert.rejects(request(store), /revision|accepted/);
  await assert.rejects(access(output), { code: 'ENOENT' });
  assert.deepEqual((await readdir(dir)).filter(x => x.endsWith('.tmp')), []);
});
test('reaccepting another artifact at the same revision during preparation rejects', async () => {
  await accept(ascii); let reads = 0;
  const store = { load: async id => { if (++reads === 2) { const ref = artifact(binary()); await projects.attachPreview(id, 0, ref); await projects.acceptPreview(id, 0, ref); } return projects.load(id); } };
  await assert.rejects(request(store), /acceptance/); await assert.rejects(access(output), { code: 'ENOENT' });
});
test('existing destination bytes are never overwritten', async () => {
  await accept(ascii); await writeFile(output, 'keep me');
  await assert.rejects(request(), { code: 'EEXIST' }); assert.equal(await readFile(output, 'utf8'), 'keep me');
  assert.deepEqual((await readdir(dir)).filter(x => x.endsWith('.tmp')), []);
});
test('two concurrent exports to one path cannot both succeed', async () => {
  await accept(ascii); const results = await Promise.allSettled([request(), request()]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.deepEqual(await readFile(output), ascii);
});
test('symlink source cannot substitute another local file', async () => {
  await accept(ascii); const actual = join(dir, 'actual.stl'); await writeFile(actual, ascii); await rm(source); await symlink(actual, source);
  await assert.rejects(request()); await assert.rejects(access(output), { code: 'ENOENT' });
});
const malformed = [
  ['nonfinite binary vertex', () => { const b = binary(); b.writeFloatLE(NaN, 96); return b; }],
  ['nonfinite ASCII normal', () => Buffer.from(ascii.toString().replace('normal 0', 'normal NaN'))],
  ['degenerate triangle', () => Buffer.from(ascii.toString().replace('vertex 0 10 1', 'vertex 5 0 0'))],
  ['truncated binary', () => binary().subarray(0, 130)],
  ['extra binary bytes', () => Buffer.concat([binary(), Buffer.from('garbage')])],
  ['ASCII trailing executable text', () => Buffer.concat([ascii, Buffer.from('G1 X1 Y1 E1')])],
  ['empty mesh', () => Buffer.from('solid empty\nendsolid empty\n')],
];
for (const [name, make] of malformed) test(`rejects accepted but structurally invalid STL: ${name}`, async () => {
  await accept(make()); await assert.rejects(request(), /STL|geometry/); await assert.rejects(access(output), { code: 'ENOENT' });
});
test('artifact resource ceiling rejects before reading a huge file', async () => {
  await accept(ascii, { ...artifact(ascii), byteLength: 64 * 1024 * 1024 });
  await assert.rejects(request(), /limit/); await assert.rejects(access(output), { code: 'ENOENT' });
});

test('caller path mutation during an await cannot redirect the authorized output', async () => {
  await accept(ascii);
  const input = { projectId: spec.id, expectedRevision: 0, sourcePath: source, outputPath: output };
  const elsewhere = join(dir, 'elsewhere.stl');
  const store = { load: async id => { input.outputPath = elsewhere; return projects.load(id); } };
  const receipt = await exportAcceptedStl(store, input);
  assert.equal(receipt.outputPath, output); await assert.rejects(access(elsewhere), { code: 'ENOENT' });
});

test('malformed long ASCII number rejects promptly without quadratic parser backtracking', async () => {
  await accept(Buffer.from('solid fixture\nfacet normal ' + '9'.repeat(100000) + '\nendsolid fixture\n'));
  const start = performance.now();
  await assert.rejects(request(), /STL|geometry/);
  assert.ok(performance.now() - start < 1500, 'a 100KB malformed field must not stall the companion');
  await assert.rejects(access(output), { code: 'ENOENT' });
});
