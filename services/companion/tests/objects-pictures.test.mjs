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
  assert.match(drawnNow.picture, /^pictures\/part-[0-9a-f]{8}-[0-9a-f]{8}\.png$/);
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
  assert.deepEqual(after.pictureStates, {photo: 'failed'}, 'clients are told none is coming (review B2 on #539)');
  assert.equal(events.filter(event => event.type === 'project.updated').length, 1, 'that one record, then no project.updated, so nothing feeds a reload');
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

// Review B2 and S3 on #539. A replaced 3MF (a new pass) takes its old picture down at once, before the redraw: every
// client puts the Mac's picture of a 3MF before its pass's render, so an old one would stand for the new file. The
// role says `drawing`, then `failed` if the redraw fails, and a later drawing clears it.
test("a replaced file's old picture is taken down at once; the role says drawing, then failed, then nothing once drawn", async t => {
  const root = await tempDir('objects-pictures-stale-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  let mode = 'draw', release;
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => {
      if (mode === 'hold') await new Promise(resolve => { release = resolve; });
      if (mode === 'fail') return false;
      await writeFile(output, `png ${spec.model}`); return true;
    }});
  t.after(() => service.close());
  const object = await store.create('A box', 'fit');
  const dir = store.dir(object.id);
  await mkdir(join(dir, 'current'), {recursive: true});
  const file = join(dir, 'current', 'model.3mf');
  await writeFile(file, 'PK v1 3mf');
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.3mf', renders: ['current/renders/1.png']}}));
  await service.list(); await service.picturesDrawn();
  const v1 = await service.get(object.id);
  assert.ok(v1.pictures.part);
  assert.equal(v1.pictureStates, undefined, 'drawn: no state');

  // v2: same size, same mtime, a new file (a pass writes it anew). Its drawing is held, as behind a busy queue.
  const {stat, utimes, rename: move} = await import('node:fs/promises');
  const before = await stat(file);
  await writeFile(`${file}.new`, 'PK v2 3mf'); await move(`${file}.new`, file); await utimes(file, before.atime, before.mtime);
  mode = 'hold';
  await service.list();
  for (let i = 0; i < 50 && (await store.get(object.id)).pictures?.part; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const pending = await store.get(object.id);
  assert.equal(pending.pictures.part, undefined, "v1's picture never stands for v2 while v2's is drawn");
  assert.equal(pending.picture, undefined);
  assert.deepEqual(pending.pictureStates, {part: 'drawing'});
  mode = 'fail'; release?.();
  await service.picturesDrawn();
  const failed = await service.get(object.id);
  assert.equal(failed.pictures.part, undefined, 'a failed redraw never brings the old file\'s picture back');
  assert.deepEqual(failed.pictureStates, {part: 'failed'}, 'and the clients are told none is coming');

  // v3 draws: the state goes.
  await writeFile(file, 'PK v3 3mf, longer');
  mode = 'draw';
  await service.list(); await service.picturesDrawn();
  const v3 = await service.get(object.id);
  assert.ok(v3.pictures.part);
  assert.notEqual(v3.pictures.part, v1.pictures.part);
  assert.equal(v3.pictureStates, undefined);
});

test("a 'drawing' left by a companion that stopped mid-draw is cleared once the picture is there", async t => {
  const root = await tempDir('objects-pictures-restart-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => { await writeFile(output, 'png'); return true; }});
  t.after(() => service.close());
  const object = await store.create('A holder', 'fit');
  const dir = store.dir(object.id);
  await mkdir(join(dir, 'current'), {recursive: true});
  await writeFile(join(dir, 'current', 'model.stl'), 'solid x\nendsolid x\n');
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  await service.list(); await service.picturesDrawn();
  await store.update(object.id, o => ({...o, pictureStates: {part: 'drawing'}}));
  await service.list(); await service.picturesDrawn();
  assert.equal((await service.get(object.id)).pictureStates, undefined);
});

// Review S7 on #539: one plate's own picture never stands for the others; the file is drawn whole unless every plate has one.
test("a designer's file is drawn whole unless every plate has its own picture", () => {
  const receipt = (thumbs) => ({receipts: [{format: '3mf', sha256: 'a'.repeat(64), name: 'six.3mf',
    plates: thumbs.map((thumbnail, index) => ({index, name: `Plate ${index + 1}`, objects: [], sliced: false, ...(thumbnail ? {thumbnail} : {})}))}]});
  const project = files => ({...base, kind: 'published', current: {model: 'original/abc-six.3mf', renders: []}, files});
  assert.deepEqual(pictureSpecs(project(receipt(['original/p1.png', undefined, 'original/p3.png']))), {part: {model: 'original/abc-six.3mf', zUp: true}});
  assert.deepEqual(pictureSpecs(project(receipt(['original/p1.png', 'original/p2.png']))), {});
});

// The same while the project is already queued (right after an install, every project redraws at once): the queued
// step takes the old picture down before it draws.
test("a file replaced while its project is already queued never draws with the old file's picture on the record", async t => {
  const root = await tempDir('objects-pictures-queued-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  let hold = false, release, seenDuringDraw;
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}},
    drawPicture: async (dir, spec, output) => {
      if (hold) { await new Promise(resolve => { release = resolve; }); hold = false; }
      if (spec.model?.endsWith('.3mf') && seenDuringDraw === undefined && drawing) seenDuringDraw = (await store.get(box.id)).pictures?.part ?? null;
      await writeFile(output, `png ${spec.model}`); return true;
    }});
  t.after(() => service.close());
  let drawing = false;
  // Listed newest first: the other project is queued ahead of the box.
  const box = await store.create('A box', 'fit');
  await new Promise(resolve => setTimeout(resolve, 5));
  const other = await store.create('Another', 'fit');
  for (const [object, model, body] of [[other, 'current/model.stl', 'solid x\nendsolid x\n'], [box, 'current/model.3mf', 'PK v1']]) {
    await mkdir(join(store.dir(object.id), 'current'), {recursive: true});
    await writeFile(join(store.dir(object.id), model), body);
    await store.update(object.id, o => ({...o, state: 'ready', current: {model, renders: ['current/renders/1.png']}}));
  }
  await service.list(); await service.picturesDrawn();
  const v1 = (await store.get(box.id)).pictures.part;
  assert.ok(v1);
  // Another project's drawing holds the queue; the box is queued behind it with v1 still current.
  await writeFile(join(store.dir(other.id), 'current', 'model.stl'), 'solid y\nendsolid y\n');
  hold = true;
  await service.list();
  for (let i = 0; i < 200 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release, "the other project's drawing holds the queue");
  // While queued, the box's file is replaced: a second list() finds it already pending.
  await writeFile(join(store.dir(box.id), 'current', 'model.3mf'), 'PK v2, another file');
  await service.list();
  drawing = true;
  release?.();
  await service.picturesDrawn();
  assert.equal(seenDuringDraw, null, "v1's picture was off the record before v2 was drawn");
  const after = await store.get(box.id);
  assert.ok(after.pictures.part);
  assert.notEqual(after.pictures.part, v1);
  assert.equal(after.pictureStates, undefined);
});
