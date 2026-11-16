// #691: a multi-part design is drawn part by part, each in its own colour, from meshes the printer MCP makes
// (counterpart/1, MODEL_PARTS_TOOL). Counterpart meshes nothing itself: without the tool nothing changes.
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

/** The MCP's answer, as the stub of the counterpart/1 part-mesh tool gives it: one STL per part in `outputDir`. */
function partsTool(answer) {
  const asked = [];
  const modelParts = async ({modelPath, outputDir}) => {
    asked.push(modelPath);
    const parts = typeof answer === 'function' ? answer(modelPath) : answer;
    if (parts instanceof Error) throw parts;
    for (const part of parts) await writeFile(join(outputDir, `${part.id}.stl`), partStl(part.id));
    return parts.map(part => ({...part, stlPath: join(outputDir, `${part.id}.stl`)}));
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

// The MCP names parts and filaments; a designed 3MF carries no colours, so the pass's declared ones fill them in.
const DAD = [{id: 'bar', name: 'bar', filament: 1}, {id: 'letters', name: 'letters and inscription', filament: 2}];

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
  for (const part of ready.current.parts) assert.equal(await readFile(join(f.store.dir(object.id), part.mesh), 'utf8'), partStl(part.id));
  assert.equal(ready.current.mergedMesh, 'current/model.stl', 'the merged mesh is still there for clients without parts');
});

test('the MCP\'s own colour wins over the declared one, and a part with neither stays neutral', async t => {
  const f = await setup(t, {runner: partsTool([{id: 'bar', name: 'bar', filament: 1, colour: '#a0522d'}, {id: 'trim', name: 'trim'}])});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.service.settled(object.id);
  assert.deepEqual(ready.current.parts.map(part => [part.id, part.colour]), [['bar', '#a0522d'], ['trim', undefined]]);
});

test('a published 3MF yields its parts, with their plates', async t => {
  const tool = partsTool([{id: 'body', name: 'Body', filament: 1, colour: '#FF0000', plate: 0}, {id: 'gauge', name: 'Depth gauge', filament: 2, colour: '#FFFFFF', plate: 1}]);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('Print this', 'published', LINK);
  const bytes = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>')}));
  const done = await f.service.addModelFile(object.id, 'caliper.3mf', bytes);
  assert.equal(done.current.model, done.files.original[0]);
  assert.deepEqual(tool.asked, [join(f.store.dir(object.id), done.files.original[0])], 'the designer\'s own file is meshed, as it is');
  assert.deepEqual(done.current.parts, [
    {id: 'body', name: 'Body', colour: '#FF0000', plate: 0, mesh: 'current/parts/body.stl'},
    {id: 'gauge', name: 'Depth gauge', colour: '#FFFFFF', plate: 1, mesh: 'current/parts/gauge.stl'},
  ]);
  assert.ok(existsSync(join(f.store.dir(object.id), 'current', 'parts', 'gauge.stl')));
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
    ['bar', '#B0855D', `versions/${sealed.id}/parts/bar.stl`],
    ['letters', '#111111', `versions/${sealed.id}/parts/letters.stl`],
  ]);
  for (const part of sealed.result.parts) assert.equal(await readFile(join(dir, part.mesh), 'utf8'), partStl(part.id));
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
  const current = await fetch(`${base}/current/parts/letters.stl`);
  assert.equal(current.status, 200);
  assert.equal(await current.text(), partStl('letters'));
  await writeFile(join(f.store.dir(object.id), 'current', 'parts', 'stray.stl'), STL);
  assert.equal((await fetch(`${base}/current/parts/stray.stl`)).status, 404, 'only the parts the record lists');
  await f.service.correct(object.id, 'Make it all one colour');
  await f.service.settled(object.id);
  const sealed = (await f.service.get(object.id)).versions.find(version => version.result.parts);
  assert.equal((await fetch(`${base}/${sealed.result.parts[0].mesh}`)).status, 200);
  assert.equal((await fetch(`${base}/current/parts/letters.stl`)).status, 404, 'a one-colour revision has none');
});
