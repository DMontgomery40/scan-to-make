import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {zipSync, strToU8} from 'fflate';
import {HandoffBundleStore, inspectModelFile} from '../dist/index.js';

const MiB = 1024 * 1024;

/** A two-part 3MF as `counterpart_make_3mf` writes one: the whole mesh as XML, here at least `meshBytes` of it (#858). */
export function passMade3mf(meshBytes) {
  const triangle = '<vertex x="12.345678" y="23.456789" z="34.567891"/><vertex x="45.678912" y="56.789123" z="67.891234"/><vertex x="78.912345" y="89.123456" z="91.234567"/>';
  const count = Math.ceil(meshBytes / triangle.length);
  const vertices = triangle.repeat(count);
  const object = id => `<object id="${id}" type="model"><mesh><vertices>${vertices}</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">DAD sign</metadata><resources>${object(1)}${object(2)}<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources><build><item objectid="3"/></build></model>`;
  const settings = '<config><object id="3"><metadata key="name" value="DAD sign"/><part id="1" subtype="normal_part"><metadata key="name" value="bar"/><metadata key="extruder" value="1"/></part>'
    + '<part id="2" subtype="normal_part"><metadata key="name" value="letters and inscription"/><metadata key="extruder" value="2"/></part></object></config>';
  return Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(xml), 'Metadata/model_settings.config': strToU8(settings)}));
}

/** Rewrites the unpacked size an entry's central directory record declares, without inflating anything that large. */
function declaring(bytes, name, size) {
  const copy = Buffer.from(bytes);
  for (let at = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0; at = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
    const length = copy.readUInt16LE(at + 28);
    if (copy.subarray(at + 46, at + 46 + length).toString() === name) { copy.writeUInt32LE(size, at + 24); return copy; }
  }
  throw new Error(`no ${name}`);
}

test('a pass-made 3MF whose mesh unpacks past 8 MB is read, and an import that size is still refused (#858)', () => {
  const bytes = passMade3mf(9 * MiB);
  assert.ok(bytes.length < 2 * MiB, 'the archive itself is small: the mesh compresses well');
  assert.throws(() => inspectModelFile(bytes, '3mf'), /mesh is too large to read/, 'a file a person brings keeps the zip bomb limits');
  const info = inspectModelFile(bytes, '3mf', {origin: 'pass'});
  assert.equal(info.title, 'DAD sign');
  assert.deepEqual(info.plates, [{index: 0, name: 'Plate 1', objects: [], sliced: false}]);
  assert.equal(info.byteLength, bytes.length);
});

test('a pass-made 3MF still has limits: the mesh at 256 MB, and every other entry as an import', () => {
  const bytes = passMade3mf(64 * 1024);
  assert.throws(() => inspectModelFile(declaring(bytes, '3D/3dmodel.model', 257 * MiB), '3mf', {origin: 'pass'}), /over 256 MB unpacked/);
  const settings = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config': new Uint8Array(9 * MiB)}));
  assert.throws(() => inspectModelFile(settings, '3mf', {origin: 'pass'}), /metadata is too large/);
});

test('a mesh read in windows still finds geometry that straddles a window, and still needs geometry', () => {
  // The build item lands across the 4 MB window boundary.
  const pad = 4 * MiB - 40;
  const xml = `<model>${' '.repeat(pad)}<resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>`;
  const ok = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(xml.padEnd(9 * MiB, ' '))}));
  assert.equal(inspectModelFile(ok, '3mf', {origin: 'pass'}).plates.length, 1);
  const empty = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8('<model><resources/><build/></model>'.padEnd(9 * MiB, ' '))}));
  assert.throws(() => inspectModelFile(empty, '3mf', {origin: 'pass'}), /no model or printable plate/);
});

test('Print hands a pass-made 3MF with a large mesh to the printer service', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pass-model-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const store = new HandoffBundleStore(join(root, 'bundles')), bytes = passMade3mf(9 * MiB);
  await assert.rejects(store.create({model: {bytes, format: '3mf'}, prompt: '', backend: 'bambu-printer-mcp'}), /mesh is too large/);
  const manifest = await store.create({model: {bytes, format: '3mf', origin: 'pass'}, prompt: '', backend: 'bambu-printer-mcp'});
  assert.equal(manifest.sourceModel.format, '3mf');
  assert.equal(manifest.sourceModel.byteLength, bytes.length);
});
