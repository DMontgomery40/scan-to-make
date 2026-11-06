import test from 'node:test';
import {platesResult} from './support/plates-tool.mjs';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zipSync, strToU8} from 'fflate';
import {PrinterHandoffRunner, modelPlatesFrom, printerHandoffConfigSchema} from '../dist/index.js';

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

// Which filaments a plate prints is the MCP's to say (list_3mf_plates `filaments`, PRD §8.0): Counterpart reads no
// project filament metadata itself. The answer is checked field by field; an MCP without it is older, not wrong.
test('the MCP\u2019s per-plate filaments are read as it gives them, and a malformed list is no answer', () => {
  const listed = modelPlatesFrom({plates: [
    {index: 0, name: 'Screws', objects: [], sliced: false, filaments: [{index: 3, colour: '#ff0000', material: 'PLA', filament_id: 'GFA00', name: 'Gear'}]},
    {index: 1, name: 'Board', objects: [], sliced: false, filaments: [{index: 2}]}],
  project_filaments: [{index: 1, colour: '#5F6478'}, {index: 2}, {index: 3, colour: '#FF0000'}]});
  assert.deepEqual(listed.plates.map(plate => plate.filaments), [[{index: 3, colour: '#FF0000', material: 'PLA', filamentId: 'GFA00', name: 'Gear'}], [{index: 2}]]);
  assert.deepEqual(listed.projectFilaments.map(filament => filament.index), [1, 2, 3]);
  const older = modelPlatesFrom({plates: [{index: 0, name: 'Plate 1', objects: [], sliced: false}]});
  assert.equal(older.plates[0].filaments, undefined, 'an older MCP lists no filaments: Update, never a guess');
  assert.equal(older.projectFilaments, undefined);
  for (const filaments of [[{index: 0}], [{index: 65}], [{index: 1}, {index: 1}], 'all', [{index: 1.5}]])
    assert.equal(modelPlatesFrom({plates: [{index: 0, name: 'P', objects: [], sliced: false, filaments}]}), undefined, JSON.stringify(filaments));
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
    hold: () => () => {}, connect: async () => ({tools: []}), config: {backend: 'bambu-printer-mcp'},
    hasTool: name => ['slice_stl', 'print_3mf', 'counterpart_printer_info', 'list_3mf_plates'].includes(name),
    getTool: name => ({name, inputSchema: {type: 'object', properties}}),
    call: async (name, args, opts) => {
      if (name === 'counterpart_printer_info') return {content: [{type: 'text', text: JSON.stringify({contract: 'counterpart/1', server: {name: 'x', version: '1'},
        printer: {kind: 'bambu', host: 'h'}, capabilities: {progress: true, layers: true, camera: 'none', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true}})}]};
      if (name === 'list_3mf_plates') return platesResult(args.three_mf_path);
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
