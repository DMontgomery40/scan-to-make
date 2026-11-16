// #691: a multi-part design is drawn part by part, each in its own colour, from meshes the printer MCP makes
// (counterpart/1 `counterpart_part_meshes`). Counterpart meshes nothing itself: without the tool nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {tempDir} from './support/temp.mjs';

const {zipSync, strToU8} = createRequire(new URL('../../printer-handoff/package.json', import.meta.url))('fflate');
const STL = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n';
const partStl = name => STL.replace(/solid x/g, `solid ${name}`);
const LINK = 'https://makerworld.com/en/models/123456';
const fixture = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/project-parts.json', import.meta.url), 'utf8'));

/** The runner's modelParts, as counterpart_part_meshes answers through it: one STL per part in a new folder it makes. */
function partsTool(answer, skipped = []) {
  const asked = [];
  const modelParts = async ({modelPath, outputDir}) => {
    asked.push(modelPath);
    const parts = typeof answer === 'function' ? answer(modelPath) : answer;
    if (parts instanceof Error) throw parts;
    const folder = join(outputDir, 'model-parts-1');
    await mkdir(folder);
    for (const [index, part] of parts.entries()) await writeFile(join(folder, `${index + 1}.stl`), partStl(part.name ?? part.id));
    return {parts: parts.map((part, index) => ({...part, stlPath: join(folder, `${index + 1}.stl`)})), skipped};
  };
  return {modelParts, asked};
}

/** A service whose passes make the DAD sign as a two-part 3MF (or, with `oneColour`, an STL), and a printer MCP runner. */
async function setup(t, {runner = {}, outcomes = []} = {}) {
  const root = await tempDir('objects-parts-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects'));
  let passes = 0;
  const runTouchup = async input => {
    const outcome = outcomes[passes++] ?? {};
    input.onStage?.('working', 'code');
    const out = join(root, `pass-${passes}`, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    if (outcome.oneColour) return {status: 'done', model: join(out, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, summary: 'One colour now.'};
    await writeFile(join(out, 'touched.3mf'), Buffer.from('PK\x03\x04 two parts'));
    return {status: 'done', model: join(out, 'touched.stl'), parts: join(out, 'touched.3mf'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1},
      summary: 'Made as the original is: black letters in a wood-colour base. Prints as one piece in two colours.',
      partColours: [{name: 'bar', colour: '#B0855D'}, {name: 'letters and inscription', colour: '#111111'}]};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [195.7, 19.9, 100.5], claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, passTimings: new PassTimings(join(root, 'timings.json')),
    print: {services: {store: undefined, relay: undefined, runner: {backend: 'bambu-printer-mcp', runBundle: async () => { throw new Error('unused'); }, ...runner}}},
    runPublished: async () => ({status: 'needs_file', reason: 'test'})});
  t.after(() => service.close());
  return {service, store, root};
}

// The MCP names parts and filaments (ids are its keys, never parsed); a designed 3MF from counterpart_make_3mf without
// colours carries none, so the pass's declared ones fill them in.
const DAD = [{id: '1/1', name: 'bar', filament: 1}, {id: '1/2', name: 'letters and inscription', filament: 2}];

test('a pass-made two-part 3MF yields two coloured parts in the record, each with its own mesh', async t => {
  const tool = partsTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  const ready = await f.service.get(object.id);
  assert.equal(ready.current.model, 'current/model.3mf');
  assert.deepEqual(ready.current.parts, fixture.cases.find(c => c.name === 'a pass-made sign in two colours').object.current.parts, 'the shared fixture is what the companion writes');
  assert.deepEqual(tool.asked, [join(f.store.dir(object.id), 'current', 'model.3mf')], 'the MCP meshes the project\'s own 3MF, once');
  for (const part of ready.current.parts) assert.equal(await readFile(join(f.store.dir(object.id), part.mesh), 'utf8'), partStl(part.name));
  assert.equal(ready.current.mergedMesh, 'current/model.stl', 'the merged mesh is still there for clients without parts');
});

test('the colour the pass declared wins, the 3MF\'s own fills the rest, and a part with neither stays neutral', async t => {
  const f = await setup(t, {runner: partsTool([{id: '1/1', name: 'Bar', filament: 1, colour: '#A0522D'}, {id: '1/2', name: 'trim', filament: 3, colour: '#00FF00', painted: true}, {id: '1/3', name: 'base'}])});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.deepEqual(ready.current.parts.map(part => [part.id, part.colour, part.painted]),
    [['1/1', '#B0855D', undefined], ['1/2', '#00FF00', true], ['1/3', undefined, undefined]], 'by name (any case), then the file\'s, then none');
});

test('a part the MCP skipped means no parts: never a design drawn with a piece missing', async t => {
  const logged = [];
  t.mock.method(console, 'error', line => { logged.push(String(line)); });
  const f = await setup(t, {runner: partsTool(DAD, ['Huge base'])});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.equal(ready.current.parts, undefined);
  assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')));
  assert.ok(logged.some(line => line.includes('so it shows as one piece: the printer service couldn’t mesh Huge base')));
});

test('a published 3MF yields its parts, with their plates', async t => {
  const tool = partsTool([{id: '1/1', name: 'Body', filament: 1, colour: '#FF0000', plate: 0}, {id: '2/1', name: 'Depth gauge', filament: 2, colour: '#FFFFFF', plate: 1}]);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('Print this', 'published', LINK);
  const bytes = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>')}));
  const done = await f.service.addModelFile(object.id, 'caliper.3mf', bytes);
  assert.equal(done.current.model, done.files.original[0]);
  assert.deepEqual(tool.asked, [join(f.store.dir(object.id), done.files.original[0])], 'the designer\'s own file is meshed, as it is');
  assert.deepEqual(done.current.parts, [
    {id: '1/1', name: 'Body', colour: '#FF0000', plate: 0, mesh: 'current/parts/part-1.stl'},
    {id: '2/1', name: 'Depth gauge', colour: '#FFFFFF', plate: 1, mesh: 'current/parts/part-2.stl'},
  ]);
  assert.ok(existsSync(join(f.store.dir(object.id), 'current', 'parts', 'part-2.stl')));
});

test('an MCP without the part-mesh tool changes nothing: the merged mesh in the neutral material, as before', async t => {
  const f = await setup(t);
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  const ready = await f.service.get(object.id);
  assert.equal(ready.current.model, 'current/model.3mf');
  assert.equal(ready.current.parts, undefined);
  assert.equal(ready.current.mergedMesh, 'current/model.stl');
  assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')));
  assert.deepEqual(ready.current, {...fixture.cases.find(c => c.name === 'an MCP without the part-mesh tool').object.current, renders: ready.current.renders,
    sizeMm: ready.current.sizeMm, summary: ready.current.summary, engine: ready.current.engine});
});

test('a part-mesh answer that fails leaves no parts, and says so in the log', async t => {
  const logged = [];
  t.mock.method(console, 'error', line => { logged.push(String(line)); });
  const f = await setup(t, {runner: partsTool(new Error('the MCP could not read the 3MF'))});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.equal(ready.current.parts, undefined);
  assert.ok(logged.some(line => line.includes('couldn’t keep this design’s parts in their colours, so it shows as one piece: the MCP could not read the 3MF')));
});

test('sealing a version keeps its parts; a one-colour revision leaves current with none', async t => {
  const f = await setup(t, {runner: partsTool(DAD), outcomes: [{}, {oneColour: true}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  await f.service.correct(object.id, 'Make it all one colour');
  await f.service.settled(object.id);
  const revised = await f.service.get(object.id), dir = f.store.dir(object.id);
  assert.equal(revised.current.model, 'current/model.stl');
  assert.equal(revised.current.parts, undefined, 'a one-colour model has no parts');
  assert.ok(!existsSync(join(dir, 'current', 'parts')), 'and no stale part meshes');
  const sealed = revised.versions.find(version => version.result.model.endsWith('model.3mf'));
  assert.ok(sealed, 'the two-colour design is a version');
  assert.deepEqual(sealed.result.parts.map(part => [part.id, part.colour, part.mesh]), [
    ['1/1', '#B0855D', `versions/${sealed.id}/parts/part-1.stl`],
    ['1/2', '#111111', `versions/${sealed.id}/parts/part-2.stl`],
  ]);
  for (const part of sealed.result.parts) assert.equal(await readFile(join(dir, part.mesh), 'utf8'), partStl(part.name));
  // #869: the shared fixture's sealed version is shaped as this one is, so every client decodes it as a real one.
  const shared = fixture.cases.find(c => c.name.startsWith('a sealed')).object.versions[0];
  for (const key of ['id', 'sealedAtMs', 'modelSha256', 'result']) assert.ok(key in shared, `the fixture's version has ${key}`);
  for (const [key, value] of Object.entries(shared)) assert.equal(typeof value, typeof sealed[key], `${key} is what the companion writes`);
  assert.match(shared.modelSha256, /^[0-9a-f]{64}$/);
  assert.match(sealed.modelSha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(shared.result.renders) && Array.isArray(sealed.result.renders));
});

test('each part\'s mesh is served beside the project, for the current design and a sealed one; nothing else under parts/ is', async t => {
  const f = await setup(t, {runner: partsTool(DAD), outcomes: [{}, {oneColour: true}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.service.settled(object.id);
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/${object.id}`;
  const current = await fetch(`${base}/current/parts/part-2.stl`);
  assert.equal(current.status, 200);
  assert.equal(await current.text(), partStl('letters and inscription'));
  await writeFile(join(f.store.dir(object.id), 'current', 'parts', 'stray.stl'), STL);
  assert.equal((await fetch(`${base}/current/parts/stray.stl`)).status, 404, 'only the parts the record lists');
  await f.service.correct(object.id, 'Make it all one colour');
  await f.service.settled(object.id);
  const sealed = (await f.service.get(object.id)).versions.find(version => version.result.parts);
  assert.equal((await fetch(`${base}/${sealed.result.parts[0].mesh}`)).status, 200);
  assert.equal((await fetch(`${base}/current/parts/part-2.stl`)).status, 404, 'a one-colour revision has none');
});

test('the parts fixture names the merged mesh as project-gallery.json does (#869)', async () => {
  const gallery = JSON.parse(await readFile(new URL('../../../packages/contracts/fixtures/project-gallery.json', import.meta.url), 'utf8'));
  const drawn = test => gallery.cases.find(c => test(c.project.current ?? {}) && c.entries?.[0]?.kind === 'part')?.entries[0].drawing.model;
  // An STL design turns as the companion's alias for its current model; a 3MF design as its merged mesh.
  const stl = drawn(current => current.model === 'current/model.stl' && !current.mergedMesh);
  const merged = drawn(current => current.model === 'current/model.3mf' && current.mergedMesh);
  assert.equal(stl, 'model.stl');
  assert.equal(merged, 'current/model.stl');
  assert.deepEqual(fixture.cases.find(c => c.name.startsWith('a sealed')).draw, [{mesh: stl, colour: 'neutral'}]);
  assert.deepEqual(fixture.cases.find(c => c.name === 'an MCP without the part-mesh tool').draw, [{mesh: merged, colour: 'neutral'}]);
  for (const c of fixture.cases) assert.ok(Array.isArray(c.object.current.renders), `${c.name}: current has its renders, as a real record does`);
});
