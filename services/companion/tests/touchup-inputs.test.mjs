import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, writeFile, copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass, NoPhotosError} from '../dist/touchup/inputs.js';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const fixture = name => join(fixtures, name);
const temp = prefix => mkdtemp(join(tmpdir(), prefix));

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    const rel = path.slice(base.length + 1);
    if (entry.isDirectory()) out.push(rel + '/', ...await walk(path, base));
    else out.push(rel);
  }
  return out.sort();
}
function pixelSize(path) {
  const report = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path]).toString();
  return [...report.matchAll(/pixel(?:Width|Height): (\d+)/g)].map(match => Number(match[1]));
}

test('copies only the given files', async () => {
  const source = await temp('touchup-src-'), root = await temp('touchup-root-');
  for (const name of ['scan.obj', 'scan.mtl', 'scan_tex.png', 'photo.jpg']) await copyFile(fixture(name), join(source, name));
  await writeFile(join(source, 'earlier-run.jsonl'), '{"not":"an input"}');
  const pass = await prepareTouchupPass({root, objectId: 'obj-1',
    scan: [join(source, 'scan.obj'), join(source, 'scan.mtl'), join(source, 'scan_tex.png')],
    photos: [join(source, 'photo.jpg')]});
  assert.deepEqual(await walk(pass.dir),
    ['out/', 'out/checkpoints/', 'photos/', 'photos/photo-01.jpg', 'scan/', 'scan/scan.mtl', 'scan/scan.obj', 'scan/scan_tex.png']);
  assert.ok(pass.dir.startsWith(join(root, 'obj-1') + '/'));
  assert.deepEqual(pass.scanPaths, ['scan.obj', 'scan.mtl', 'scan_tex.png'].map(name => join(pass.scanDir, name)));
  assert.deepEqual(pass.photoPaths, [join(pass.photosDir, 'photo-01.jpg')]);
  assert.equal(pass.checkpointsDir, join(pass.outDir, 'checkpoints'));
});

test('converts HEIC and caps size', async () => {
  const source = await temp('touchup-src-'), root = await temp('touchup-root-');
  const wide = join(source, 'wide.jpg');
  execFileSync('/usr/bin/sips', ['-z', '300', '4000', fixture('photo.jpg'), '--out', wide], {stdio: 'ignore'});
  const pass = await prepareTouchupPass({root, objectId: 'obj-2', scan: [fixture('scan.obj')], photos: [fixture('photo.heic'), wide]});
  assert.deepEqual((await readdir(pass.photosDir)).sort(), ['photo-01.jpg', 'photo-02.jpg']);
  for (const path of pass.photoPaths) {
    const [width, height] = pixelSize(path);
    assert.ok(Math.max(width, height) <= 2048, `${path} is ${width}x${height}`);
    assert.match(execFileSync('/usr/bin/file', ['-b', path]).toString(), /^JPEG/);
  }
  assert.deepEqual(pixelSize(pass.photoPaths[0]), [32, 24], 'small photos are never upscaled');
});

test('refuses zero photos', async () => {
  const root = await temp('touchup-root-');
  await assert.rejects(prepareTouchupPass({root, objectId: 'obj-3', scan: [fixture('scan.obj')], photos: []}), NoPhotosError);
  assert.equal(existsSync(join(root, 'obj-3')), false);
});

test('each pass gets a new folder', async () => {
  const root = await temp('touchup-root-');
  const input = {root, objectId: 'obj-4', scan: [fixture('scan.obj')], photos: [fixture('photo.jpg')]};
  const [first, second] = await Promise.all([prepareTouchupPass(input), prepareTouchupPass(input)]);
  assert.notEqual(first.dir, second.dir);
});
