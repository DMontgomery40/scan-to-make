import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {pictureSpecs, spoolColour} from '../dist/objects/pictures.js';
import {publicObject} from '../dist/objects/http.js';
import {tempDir} from './support/temp.mjs';

const base = {id: '11111111-1111-4111-8111-111111111111', createdAtMs: 1, updatedAtMs: 2, photos: [], passes: [], state: 'ready'};
const seats = [{rotationDeg: [0, 0, 0], translationMm: [0, -19.5, 3]}];

test("a project's picture is its result in its spool, else its scan, else a photo's subject: never the room (David, Nov 10)", () => {
  const holder = {...base, kind: 'fit', scan: 'scan.usdz', capture: ['0001.heic'], current: {model: 'current/model.stl', renders: ['current/renders/1.png'], seats}};
  assert.deepEqual(pictureSpecs(holder), {
    part: {model: 'current/model.stl', zUp: true},
    together: {model: 'current/model.stl', zUp: true, object: 'scan/scan.usdz', seats: [[1, 0, 0, 0, 0, 1, 0, -19.5, 0, 0, 1, 3, 0, 0, 0, 1]]},
    scan: {model: 'scan/scan.usdz'}}, 'before a spool: the neutral part, the two together, and the scan in its own colours');
  const printed = {...holder, print: {bundleId: 'b', spools: [{colour: '#000000', material: 'PLA'}]}};
  assert.equal(pictureSpecs(printed).part.tint, '#000000', 'the spool it printed in');
  assert.equal(pictureSpecs(printed).together.tint, '#000000');
  assert.equal(spoolColour({print: {bundleId: 'b', live: {state: 'printing', activeFilament: {color: '#fec600'}}}}), '#FEC600', 'else the colour the printer reports printing it');
  assert.equal(spoolColour({print: {bundleId: 'b', spools: [{index: 1, colour: '#F5547C'}, {index: 2, colour: '#000000'}]}}), undefined, 'a print in two spools is no one colour');
  assert.deepEqual(pictureSpecs({...base, state: 'touching-up', kind: 'fit', scan: 'scan.usdz'}), {scan: {model: 'scan/scan.usdz'}}, 'before a result: the scan');
  assert.deepEqual(pictureSpecs({...base, state: 'new', kind: 'fit', capture: ['0001.heic']}), {photo: {photo: 'capture/0001.heic'}}, 'before any model: a photo, cut out');
});

// Nov 10: a 3MF with four objects (the bottle holder and three fit rings, e4d404f2) had no picture, and David couldn't
// tell what the project was. Every model file gets one; a designer's file with its own plate pictures keeps them.
test('every model file is drawn, a 3MF like an STL, in the project\'s first colour; a designer\'s own plate pictures are kept', () => {
  const plate = {...base, kind: 'published', current: {model: 'original/abc-first-plate.3mf', renders: []},
    files: {receipts: [{format: '3mf', sha256: 'a'.repeat(64), name: 'first-plate.3mf', plates: [{index: 0, name: 'Plate 1', objects: [], sliced: false}]}]}};
  assert.deepEqual(pictureSpecs(plate), {part: {model: 'original/abc-first-plate.3mf', zUp: true}}, 'the code engine\'s plain 3MF: all its objects, neutral');
  const designer = {...plate, files: {receipts: [{...plate.files.receipts[0], plates: [{index: 0, name: 'Plate 1', objects: [], sliced: false, thumbnail: 'original/plate-1.png'}]}]}};
  assert.deepEqual(pictureSpecs(designer), {}, "a designer's file keeps its own plate pictures: none drawn");
  const box = {...base, kind: 'fit', current: {model: 'current/model.3mf', renders: ['current/renders/1.png'], filaments: [{name: 'Pink', colour: '#f5547c'}, {name: 'Black', colour: '#000000'}]}};
  assert.deepEqual(pictureSpecs(box), {part: {model: 'current/model.3mf', zUp: true, tint: '#F5547C'}},
    'a multi-colour result: drawn, in the first colour the design asked for until the MCP says which part is on which filament');
  const printed = {...box, print: {bundleId: 'b', spools: [{index: 1, colour: '#5B6579'}, {index: 2, colour: '#FFFFFF'}]}};
  assert.equal(pictureSpecs(printed).part.tint, '#5B6579', 'the first spool its print recorded');
  assert.deepEqual(pictureSpecs({...base, kind: 'published', current: {model: 'original/x.stl', renders: []}}), {part: {model: 'original/x.stl', zUp: true}}, "a designer's STL too");
  assert.deepEqual(pictureSpecs({...base, kind: 'fit', state: 'failed'}), {}, 'no model: nothing to draw');
});

test('a 3MF project from before gets its picture when the list is read, without becoming news', async t => {
  const root = await tempDir('objects-pictures-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), drawn = [];
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => { drawn.push(spec.model); await writeFile(output, `png ${spec.model}`); return true; }});
  t.after(() => service.close());
  const object = await store.create(undefined, 'published');
  const dir = store.dir(object.id);
  await mkdir(join(dir, 'original'), {recursive: true});
  await writeFile(join(dir, 'original', 'abc-first-plate.3mf'), 'PK 3mf');
  await store.update(object.id, o => ({...o, state: 'printed', current: {model: 'original/abc-first-plate.3mf', renders: []},
    files: {original: ['original/abc-first-plate.3mf'], receipts: [{format: '3mf', sha256: 'a'.repeat(64), name: 'first-plate.3mf', plates: [{index: 0, name: 'Plate 1', objects: [], sliced: false}]}]}}));
  const stamp = (await store.get(object.id)).updatedAtMs;
  assert.equal((await service.get(object.id)).picture, undefined, 'none yet');
  await service.list(); await service.picturesDrawn();
  const drawnNow = await service.get(object.id);
  assert.deepEqual(drawn, ['original/abc-first-plate.3mf']);
  assert.match(drawnNow.picture, /^pictures\/part-[0-9a-f]+\.png$/);
  assert.equal(drawnNow.pictures.part, drawnNow.picture, "the project's picture is its file's");
  assert.equal(drawnNow.updatedAtMs, stamp, 'a backfilled picture keeps its place in the list');
});

test('the companion draws each picture once, records it on the project, and serves only those files', async t => {
  const root = await tempDir('objects-pictures-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), drawn = [];
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => { drawn.push(spec); await writeFile(output, `png ${JSON.stringify(spec)}`); return true; }});
  t.after(() => service.close());
  const object = await store.create('A holder', 'fit');
  const dir = store.dir(object.id);
  await mkdir(join(dir, 'current'), {recursive: true}); await mkdir(join(dir, 'scan'), {recursive: true});
  await writeFile(join(dir, 'current', 'model.stl'), 'solid x\nendsolid x\n'); await writeFile(join(dir, 'scan', 'scan.usdz'), 'usdz');
  await store.update(object.id, o => ({...o, state: 'ready', scan: 'scan.usdz', current: {model: 'current/model.stl', renders: [], seats}}));
  const stamp = (await store.get(object.id)).updatedAtMs;
  await service.list();
  await service.picturesDrawn();
  const first = await service.get(object.id);
  assert.equal(first.updatedAtMs, stamp, "a drawn picture isn't news: the project keeps its place on Home");
  assert.deepEqual(Object.keys(first.pictures).sort(), ['part', 'scan', 'together']);
  assert.equal(first.picture, first.pictures.part, "the project's picture is its result");
  assert.equal(publicObject(first).picture, first.picture, 'every client reads the same name');
  assert.equal(drawn.length, 3);
  await service.list(); await service.picturesDrawn();
  assert.equal(drawn.length, 3, 'drawn once');
  await store.update(object.id, o => ({...o, state: 'printed', print: {bundleId: 'b', spools: [{colour: '#FEC600'}]}}));
  await service.list(); await service.picturesDrawn();
  const printed = await service.get(object.id);
  assert.notEqual(printed.pictures.part, first.pictures.part, 'a new spool is a new picture, so every client\'s cache refreshes');
  assert.equal(printed.pictures.scan, first.pictures.scan, 'the scan picture is unchanged');
  assert.equal(drawn.length, 5);
  assert.match(await readFile(join(dir, printed.picture), 'utf8'), /FEC600/);
  await assert.rejects(readFile(join(dir, first.pictures.part)), {code: 'ENOENT'}, 'old pictures go');
});

// Review of #451, blocker 3: a picture that can't be drawn is tried once per set of inputs, writes nothing and sends
// no event after that, and a redraw that fails keeps the picture the role had.
test('a photo whose subject cannot be cut out is tried once: no writes and no events after that', async t => {
  const root = await tempDir('objects-pictures-fail-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [];
  let attempts = 0;
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, events: {emit: async event => { events.push(event); }},
    drawPicture: async () => { attempts++; return false; }});
  t.after(() => service.close());
  const object = await store.create('A clip', 'fit');
  await store.addFile(object.id, 'photos', 'room.jpg', Buffer.from('jpeg'));
  await store.update(object.id, o => ({...o, photos: ['room.jpg']}));
  const stamp = (await store.get(object.id)).updatedAtMs;
  for (let i = 0; i < 4; i++) { await service.list(); await service.picturesDrawn(); }
  assert.equal(attempts, 1, 'one attempt for these inputs');
  const after = await store.get(object.id);
  assert.equal(after.updatedAtMs, stamp, 'never rewritten');
  assert.equal(after.picture, undefined);
  assert.equal(events.filter(event => event.type === 'project.updated').length, 0, 'no project.updated, so nothing feeds a reload');
  // A new photo is new inputs: tried again, once.
  await store.addFile(object.id, 'photos', 'clip.jpg', Buffer.from('jpeg2'));
  await store.update(object.id, o => ({...o, photos: ['clip.jpg', 'room.jpg']}));
  await service.list(); await service.picturesDrawn(); await service.list(); await service.picturesDrawn();
  assert.equal(attempts, 2);
});

test('a redraw that fails keeps the picture the role had, file and name', async t => {
  const root = await tempDir('objects-pictures-keep-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  let working = true;
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => { if (!working) return false; await writeFile(output, `png ${JSON.stringify(spec)}`); return true; }});
  t.after(() => service.close());
  const object = await store.create('A holder', 'fit');
  const dir = store.dir(object.id);
  await mkdir(join(dir, 'current'), {recursive: true});
  await writeFile(join(dir, 'current', 'model.stl'), 'solid x\nendsolid x\n');
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  await service.list(); await service.picturesDrawn();
  const first = await service.get(object.id);
  assert.ok(first.pictures.part);
  working = false;
  await store.update(object.id, o => ({...o, state: 'printed', print: {bundleId: 'b', spools: [{colour: '#FEC600'}]}}));
  await service.list(); await service.picturesDrawn();
  const after = await service.get(object.id);
  assert.equal(after.pictures.part, first.pictures.part, 'the old picture stays');
  assert.equal(after.picture, first.picture);
  assert.match(await readFile(join(dir, first.pictures.part), 'utf8'), /^png/, 'and its file is still there');
});
