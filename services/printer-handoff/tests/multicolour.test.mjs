import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync, strToU8} from 'fflate';
import {PrinterHandoffRunner, modelFilaments, modelFilamentSlotCount, modelHasPainting, modelPlateFilaments, printerHandoffConfigSchema} from '../dist/index.js';

const published = Buffer.from(zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
  'Metadata/project_settings.config': strToU8(JSON.stringify({
    filament_colour: ['#000000', '#FEC600FF', 'FFFFFFFF'],
    filament_type: ['PLA', 'PLA', 'PETG'],
  })),
  'Metadata/model_settings.config': strToU8(`<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part>
    <part id="2" subtype="normal_part"><metadata key="name" value="letters"/><metadata key="extruder" value="3"/></part></object></config>`),
}));

const designed = Buffer.from(zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
  'Metadata/model_settings.config': strToU8(`<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part>
    <part id="2" subtype="normal_part"><metadata key="name" value="letters"/><metadata key="extruder" value="2"/></part></object></config>`),
}));

test('a published 3MF names the filaments its parts use, with the designer’s colours and materials', () => {
  assert.deepEqual(modelFilaments(published), [
    {index: 1, name: 'body', colour: '#000000', material: 'PLA'},
    {index: 3, name: 'letters', colour: '#FFFFFF', material: 'PETG'},
  ]);
});

test('a designed multi-part 3MF (no project settings) still names its parts and filaments', () => {
  assert.deepEqual(modelFilaments(designed), [
    {index: 1, name: 'body'},
    {index: 2, name: 'letters'},
  ]);
});

test('the declared slot count counts unused filaments too, and a sliced plate names painted filaments', () => {
  const {zipSync: zip, strToU8: text} = {zipSync, strToU8};
  const sliced = Buffer.from(zip({
    '[Content_Types].xml': text('<Types/>'),
    '3D/3dmodel.model': text('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/project_settings.config': text(JSON.stringify({
      filament_colour: ['#000000', '#FEC600', '#FFFFFF', '#0000FF'],
      filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
    })),
    'Metadata/model_settings.config': text('<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part>'
      + '<part id="2" subtype="normal_part"><metadata key="name" value="other plate"/><metadata key="extruder" value="2"/></part></object></config>'),
    // Plate 1 paints with filament 3 and never uses filament 2: positions are 0-based, and authoritative.
    'Metadata/plate_1.json': text(JSON.stringify({filament_ids: [0, 2]})),
  }));
  assert.equal(modelFilamentSlotCount(sliced), 4);
  assert.equal(modelFilamentSlotCount(designed), 0);
  assert.deepEqual(modelFilaments(sliced).map(f => f.index), [1, 3]);
  assert.equal(modelFilaments(sliced)[1].colour, '#FFFFFF');
  // The plate's own list, on its own: authoritative when present, absent otherwise.
  assert.deepEqual(modelPlateFilaments(sliced), [1, 3]);
  assert.equal(modelPlateFilaments(designed), undefined);
  assert.equal(modelPlateFilaments(Buffer.from('not a zip')), undefined);
});

test('painting is detected from the model XML', () => {
  const painted = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'),
  }));
  assert.equal(modelHasPainting(painted), true);
  // Studio keeps the mesh in component files under 3D/Objects/: painting there counts too.
  const componentPainted = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>'),
    '3D/Objects/object_1.model': strToU8('<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/></triangles></mesh></object></resources></model>'),
  }));
  assert.equal(modelHasPainting(componentPainted), true);
  // An oversized component ahead of a painted root spends no budget: root painting still counts,
  // and a small painted component after the oversized one is still scanned. 49 MiB is past the
  // whole 48 MiB component budget, so these fail if rejected entries are ever charged against it
  // (at 33 MiB they passed on the pre-fix scan too — council R7 on #293).
  const bigFirst = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/Objects/big.model': new Uint8Array(49 * 1024 * 1024),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/></triangles></mesh></object></resources></model>'),
  }));
  assert.equal(modelHasPainting(bigFirst), true, 'root painting survives an oversized neighbour');
  const bigThenPaintedComponent = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    '3D/Objects/big.model': new Uint8Array(49 * 1024 * 1024),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources></model>'),
    '3D/Objects/object_1.model': strToU8('<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/></triangles></mesh></object></resources></model>'),
  }));
  assert.equal(modelHasPainting(bigThenPaintedComponent), true, 'a rejected oversized component spends no budget');
  assert.equal(modelHasPainting(designed), false);
  assert.equal(modelHasPainting(Buffer.from('not a zip')), false);
});

test('unreadable bytes give no filaments rather than throwing', () => {
  assert.deepEqual(modelFilaments(Buffer.from('not a zip')), []);
  assert.deepEqual(modelFilaments(Buffer.alloc(0)), []);
});

test('the slicer config takes one colour or a semicolon list, never prose', () => {
  const base = {backend: 'bambu-printer-mcp', process: {command: '/unused'}};
  assert.ok(printerHandoffConfigSchema.parse({...base, slicer: {filamentColours: '#000000'}}));
  assert.ok(printerHandoffConfigSchema.parse({...base, slicer: {filamentColours: '#000000;#FEC600;#FFFFFF'}}));
  assert.throws(() => printerHandoffConfigSchema.parse({...base, slicer: {filamentColours: 'black and yellow'}}));
  assert.throws(() => printerHandoffConfigSchema.parse({...base, slicer: {filamentColours: '#00000'}}));
});

test('a multi-colour run slices with one profile and colour per filament and prints with the AMS mapping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'multicolour-handoff-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'model.3mf');
  const sliced = join(root, 'sliced.3mf');
  await writeFile(path, designed);
  await writeFile(sliced, designed);
  const calls = [];
  const properties = Object.fromEntries(['stl_path', 'slice_plate', 'orient', 'arrange', 'ensure_on_bed', 'load_filaments', 'filament_colours',
    'bambu_model', 'plate_index', 'three_mf_path', 'use_ams', 'ams_slots', 'ams_mapping', 'auto_match_ams'].map(x => [x, {}]));
  const session = {
    hold: () => () => {}, connect: async () => ({tools: []}),
    hasTool: name => ['slice_stl', 'print_3mf'].includes(name),
    getTool: name => ({name, inputSchema: {type: 'object', properties}}),
    call: async (name, args, opts) => {
      calls.push({name, args});
      if (name === 'slice_stl') return {content: [{type: 'text', text: sliced}]};
      if (name === 'print_3mf') { await opts?.beforeDispatch?.(); return {structuredContent: {jobName: 'pick'}, content: []}; }
      throw new Error(name);
    },
  };
  const runner = new PrinterHandoffRunner(
    {backend: 'bambu-printer-mcp', process: {command: '/unused'}, selection: {model: 'p1s', printerType: 'bambu'}},
    {session});
  await runner.run({
    stlPath: path,
    selection: {useAms: true, amsMapping: [0, 1], autoMatchAms: false},
    slicer: {loadFilaments: '/p/petg.json;/p/pla.json', filamentColours: '#000000;#FEC600'},
  });
  const slice = calls.find(x => x.name === 'slice_stl');
  assert.equal(slice.args.load_filaments, '/p/petg.json;/p/pla.json');
  assert.equal(slice.args.filament_colours, '#000000;#FEC600');
  const print = calls.find(x => x.name === 'print_3mf');
  assert.equal(print.args.use_ams, true);
  assert.deepEqual(print.args.ams_mapping, [0, 1]);
  assert.equal(print.args.auto_match_ams, false);
});
