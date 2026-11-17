// #858, #691 (the beta 8 DAD replay, Nov 17): parts that land after a design is ready redraw its picture part by part in
// their colours, and a copy whose parts carry their colours leads with that picture, not its scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {copyLeadsWithScan, leadPicture, macDrawPicture} from '../dist/objects/pictures.js';
import {tempDir} from './support/temp.mjs';

const STL = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mNgYGAAAAAEAAHI6uv5AAAAAElFTkSuQmCC', 'base64');
const until = async (check, what) => { for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error(`timed out: ${what}`); };
const gallery = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/project-gallery.json', import.meta.url), 'utf8'));

/** A stand-in for `mac-reconstruct picture`: records its arguments and writes a PNG where it is told. */
async function fakeReconstruct(root) {
  const bin = join(root, 'mac-reconstruct'), log = join(root, 'picture-calls.ndjson');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nfs.writeFileSync(process.argv[3], Buffer.from(${JSON.stringify(PNG.toString('base64'))}, 'base64'));\n`);
  await chmod(bin, 0o755);
  return {bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))};
}

test('parts that land after ready, while the picture is drawn from the 3MF\'s one colour, redraw it part by part with --part and --part-tint (the DAD replay)', async t => {
  const root = await tempDir('objects-part-pictures-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [], reconstruct = await fakeReconstruct(root);
  // The first drawing (the tint from the 3MF's first filament) is still running when the parts land, as in the replay.
  let releaseDraw, releaseParts, drawing = 0;
  const firstDraw = new Promise(resolve => { releaseDraw = resolve; }), partsCall = new Promise(resolve => { releaseParts = resolve; });
  const mac = macDrawPicture(reconstruct.bin);
  const drawPicture = async (dir, spec, output) => { if (++drawing === 1) await firstDraw; return mac(dir, spec, output); };
  const modelParts = async ({outputDir}) => {
    await partsCall;
    const folder = join(outputDir, 'model-parts-1');
    await mkdir(folder);
    for (const n of [1, 2]) await writeFile(join(folder, `${n}.stl`), STL);
    return {parts: [{id: '1/1', name: 'Bar', filament: 1, colour: '#C9A26B', stlPath: join(folder, '1.stl')},
      {id: '1/2', name: 'Letters and inscription', filament: 2, colour: '#1A1A1A', stlPath: join(folder, '2.stl')}], skipped: []};
  };
  const runTouchup = async input => {
    input.onStage?.('working', 'code');
    const out = join(root, 'pass', 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    await writeFile(join(out, 'touched.3mf'), Buffer.from('PK\x03\x04 two parts'));
    return {status: 'done', model: join(out, 'touched.stl'), parts: join(out, 'touched.3mf'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1},
      summary: 'Made as the original is: black letters in a wood-colour base. Prints as one piece in two colours.',
      partColours: [{name: 'Bar', colour: '#C9A26B'}, {name: 'Letters and inscription', colour: '#1A1A1A'}]};
  };
  const service = new ObjectService({store, runTouchup, drawPicture, stlInfo: async () => [194.3, 19.6, 102.1], claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, passTimings: new PassTimings(join(root, 'timings.json')),
    print: {services: {store: undefined, relay: undefined, runner: {backend: 'bambu-printer-mcp', runBundle: async () => { throw new Error('unused'); }, modelParts}}},
    events: {emit: async draft => { events.push(draft); }}});
  t.after(() => service.close());
  const object = await service.create('A replica of this DAD desk thing', 'copy');
  await service.start(object.id);
  await service.settled(object.id);
  await until(() => drawing >= 1, 'the first drawing starts');
  releaseParts();
  await service.partsMeshed();
  assert.equal((await store.get(object.id)).current.parts.length, 2, 'the parts landed while the first picture was drawn');
  releaseDraw();
  const drawn = await until(async () => {
    const now = await store.get(object.id);
    return (await reconstruct.calls()).some(args => args.includes('--part')) && now.pictures?.part && now.versions?.at(-1)?.pictures?.part ? now : undefined;
  }, 'the part picture drawn again');
  await service.picturesDrawn();
  const calls = await reconstruct.calls(), dir = store.dir(object.id);
  const parts = calls.filter(args => args.includes('--part'));
  assert.ok(parts.length >= 1);
  const project = parts.find(args => args[1].startsWith(join(dir, 'pictures')));
  assert.ok(project, 'the project\'s part picture is drawn part by part');
  assert.deepEqual(project.filter((arg, i) => project[i - 1] === '--part'), [join(dir, 'current/parts/part-1.stl'), join(dir, 'current/parts/part-2.stl')]);
  assert.deepEqual(project.filter((arg, i) => project[i - 1] === '--part-tint'), ['C9A26B', '1A1A1A']);
  assert.ok(!project.includes('--tint'), 'not the one-colour tint');
  const final = await store.get(object.id);
  assert.equal(final.pictures.part, `pictures/${project[1].split('/pictures/')[1].replace(/\.drawing\.png$/, '')}`, 'the record names the picture drawn part by part');
  const version = parts.find(args => args[1].includes(`/versions/${final.versions.at(-1).id}/pictures/`));
  assert.ok(version, 'the sealed design\'s picture is drawn part by part too');
  assert.deepEqual(version.filter((arg, i) => version[i - 1] === '--part-tint'), ['C9A26B', '1A1A1A']);
  assert.ok(events.some(event => event.type === 'project.updated' && event.data?.keys?.includes('picture')), 'an event says the picture changed');
  // The copy's parts carry their colours: it leads with that picture, not its scan.
  assert.equal(final.picture, final.pictures.part);
  assert.ok(drawn);
});

test('a copy leads with its scan until its result is drawn in its real colours: a spool, or parts with colours (#858)', () => {
  const names = {part: 'pictures/part-a.png', scan: 'pictures/scan-b.png'};
  const copy = {kind: 'copy', current: {model: 'current/model.3mf', renders: []}};
  assert.equal(leadPicture(names, copy), names.scan, 'one colour, no spool: the scan in its own colours');
  const parts = [{id: '1/1', colour: '#C9A26B', mesh: 'current/parts/part-1.stl'}, {id: '1/2', colour: '#1A1A1A', mesh: 'current/parts/part-2.stl'}];
  assert.equal(leadPicture(names, {...copy, current: {...copy.current, parts}}), names.part, 'parts in their colours');
  assert.equal(leadPicture(names, {...copy, current: {...copy.current, parts: parts.map(({colour: _c, ...part}) => part)}}), names.scan, 'parts with no colour are neutral');
  assert.equal(leadPicture(names, {...copy, print: {bundleId: 'b', spools: [{index: 1, colour: '#FF0000'}]}}), names.part, 'a spool is chosen');
  assert.equal(leadPicture(names, {kind: 'fit', current: copy.current}), names.part, 'a fit leads with its part');
  assert.equal(leadPicture({scan: names.scan}, {...copy, current: {...copy.current, parts}}), names.scan, 'no part picture yet: the scan');
});

test('the gallery fixture\'s copies lead as the companion\'s picture does (project-gallery.json)', () => {
  const copies = gallery.cases.filter(item => item.project.kind === 'copy' && item.entries.some(entry => entry.kind === 'scan'));
  assert.ok(copies.some(item => item.project.current?.parts?.length), 'a copy drawn part by part is a case');
  for (const item of copies) assert.equal(item.entries[0].kind === 'scan', copyLeadsWithScan(item.project), item.name);
});
