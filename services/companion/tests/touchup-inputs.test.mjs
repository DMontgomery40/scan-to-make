import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tempDir} from './support/temp.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareTouchupPass, NoPhotosError} from '../dist/touchup/inputs.js';

const fixtures = fileURLToPath(new URL('./fixtures/touchup/', import.meta.url));
const fixture = name => join(fixtures, name);
const temp = tempDir;

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
    ['out/', 'out/checkpoints/', 'photos/', 'photos/overview-01.jpg', 'photos/photo-01.jpg', 'scan/', 'scan/scan.mtl', 'scan/scan.obj', 'scan/scan_tex.png']);
  assert.ok(pass.dir.startsWith(join(root, 'obj-1') + '/'));
  assert.deepEqual(pass.scanPaths, ['scan.obj', 'scan.mtl', 'scan_tex.png'].map(name => join(pass.scanDir, name)));
  assert.deepEqual(pass.photoPaths, [join(pass.photosDir, 'photo-01.jpg')]);
  assert.equal(pass.checkpointsDir, join(pass.outDir, 'checkpoints'));
});

const HAS_SIPS = existsSync('/usr/bin/sips');

test('converts HEIC and caps size', {skip: !HAS_SIPS && 'needs macOS sips'}, async () => {
  const source = await temp('touchup-src-'), root = await temp('touchup-root-');
  const wide = join(source, 'wide.jpg');
  execFileSync('/usr/bin/sips', ['-z', '300', '4000', fixture('photo.jpg'), '--out', wide], {stdio: 'ignore'});
  const pass = await prepareTouchupPass({root, objectId: 'obj-2', scan: [fixture('scan.obj')], photos: [fixture('photo.heic'), wide]});
  assert.deepEqual((await readdir(pass.photosDir)).sort(), ['overview-01.jpg', 'photo-01.jpg', 'photo-02.jpg']);
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

test('photos are optional when the user gave instructions', async () => {
  const root = await temp('touchup-root-');
  const pass = await prepareTouchupPass({root, objectId: 'obj-5', scan: [], photos: [], requirePhotos: false});
  assert.deepEqual(await walk(pass.dir), ['out/', 'out/checkpoints/', 'photos/', 'scan/']);
  assert.deepEqual(pass.photoPaths, []);
  assert.deepEqual(pass.scanPaths, []);
});

test('a relative root still gives absolute pass paths', async () => {
  const {relative} = await import('node:path');
  const root = await temp('touchup-root-');
  const pass = await prepareTouchupPass({root: relative(process.cwd(), root), objectId: 'obj-6', scan: [fixture('scan.obj')], photos: [fixture('photo.jpg')]});
  assert.ok(pass.dir.startsWith('/'));
  assert.ok(pass.scanPaths.every(path => path.startsWith('/')));
});

test('without sips (Linux), JPEG and PNG photos are used as they are and HEIC says it needs a Mac', async () => {
  const root = await temp('touchup-root-');
  const pass = await prepareTouchupPass({root, objectId: 'obj-7', scan: [fixture('scan.obj')], photos: [fixture('photo.jpg'), fixture('scan_tex.png')], photoTool: 'copy'});
  assert.deepEqual((await readdir(pass.photosDir)).sort(), ['overview-01.jpg', 'photo-01.jpg', 'photo-02.png']);
  await assert.rejects(prepareTouchupPass({root, objectId: 'obj-8', scan: [fixture('scan.obj')], photos: [fixture('photo.heic')], photoTool: 'copy'}), /needs a Mac/);
});

test('numbered overview includes every supplied photo across bounded pages without changing originals', async t => {
  const {readFile, rm} = await import('node:fs/promises');
  const root = await temp('touchup-overview-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const python = process.env.CAPTURE_TEST_PYTHON || process.env.SCAN_TO_MAKE_CAPTURE_PYTHON || 'python3';
  const photos = Array.from({length: 25}, (_, i) => join(root, `${i}.png`));
  execFileSync(python, ['-c', 'from PIL import Image\nimport sys\nfor i,p in enumerate(sys.argv[1:]): Image.new("RGB",(40,30),(i*10,30,200)).save(p)', ...photos]);
  const original = await Promise.all(photos.map(path => readFile(path)));
  const pass = await prepareTouchupPass({root, objectId: 'overview', scan: [], photos, photoTool: 'copy'});
  assert.equal(pass.photoOverviewPaths.length, 2);
  assert.equal(pass.photoPaths.length, 25);
  for (const [i, path] of photos.entries()) assert.deepEqual(await readFile(path), original[i]);
  const report = JSON.parse(execFileSync(python, ['-c', `from PIL import Image\nimport json,sys\na,b=[Image.open(p) for p in sys.argv[1:]]\nprint(json.dumps({'sizes':[a.size,b.size],'lastFirstPage':a.getpixel((1344,1754)),'lastPage':b.getpixel((192,170))}))`, ...pass.photoOverviewPaths]));
  assert.deepEqual(report.sizes, [[1536,1896],[384,316]]);
  assert.ok(Math.abs(report.lastFirstPage[0] - 230) < 5, 'photo 24 occupies the final cell on page 1');
  assert.ok(Math.abs(report.lastPage[0] - 240) < 5, 'photo 25 is present on page 2');
});

test('inputs that share a name each keep their own copy (the working current/model.3mf and a designer\'s model.3mf)', async () => {
  // Codex on #318: both were copied to scan/model.3mf, so the designer's original overwrote the working copy.
  const root = await temp('touchup-root-'), current = await temp('touchup-current-'), original = await temp('touchup-scan-');
  await writeFile(join(current, 'model.3mf'), 'PK working');
  await writeFile(join(original, 'model.3mf'), 'PK designer');
  await writeFile(join(original, 'model-2.3mf'), 'PK third');
  const pass = await prepareTouchupPass({root, objectId: 'obj-1', scan: [join(current, 'model.3mf'), join(original, 'model.3mf'), join(original, 'model-2.3mf')],
    photos: [], requirePhotos: false});
  assert.equal(new Set(pass.scanPaths).size, 3);
  assert.deepEqual(await Promise.all(pass.scanPaths.map(path => readFile(path, 'utf8'))), ['PK working', 'PK designer', 'PK third']);
  assert.equal(pass.scanPaths[0], join(pass.scanDir, 'model.3mf'), 'the first keeps its name');
});
