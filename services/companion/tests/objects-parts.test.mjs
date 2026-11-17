// #691: a multi-part design is drawn part by part, each in its own colour, from meshes the printer MCP makes
// (counterpart/1 `counterpart_part_meshes`). Counterpart meshes nothing itself: without the tool nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {chmod, mkdir, readFile, readdir, rm, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {PassTimings} from '../dist/touchup/stages.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
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
    for (const [index, part] of parts.entries()) {
      await writeFile(join(folder, `${index + 1}.stl`), partStl(part.name ?? part.id));
      // A size the MCP's mesh has on disk, as a sparse file: nothing that large is written or read.
      if (part.bytes) await truncate(join(folder, `${index + 1}.stl`), part.bytes);
    }
    return {parts: parts.map(({bytes: _bytes, ...part}, index) => ({...part, stlPath: join(folder, `${index + 1}.stl`)})), skipped};
  };
  return {modelParts, asked};
}

/** A part-mesh tool that waits, for the calls `slow` picks, until released: a slow MCP. */
function slowTool(answer, slow = () => true) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = partsTool(answer);
  return {asked: tool.asked, release: () => release(), modelParts: async input => {
    // As a real call does, it ends when its signal is aborted (the companion closing).
    input.signal?.throwIfAborted();
    if (slow(input.modelPath)) await Promise.race([gate, new Promise((_, reject) => input.signal?.addEventListener('abort', () => reject(input.signal.reason), {once: true}))]);
    return tool.modelParts(input);
  }};
}
/** Fails the test instead of hanging when `promise` waits on the slow MCP. */
const promptly = (promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} waited for the part meshes`)), 5000))]);

/** A service whose passes make the DAD sign as a two-part 3MF (or, with `oneColour`, an STL), and a printer MCP runner. */
async function setup(t, {runner = {}, outcomes = []} = {}) {
  const root = await tempDir('objects-parts-');
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}));
  const store = new ObjectStore(join(root, 'objects')), events = [];
  let passes = 0;
  const runTouchup = async input => {
    const outcome = outcomes[passes++] ?? {};
    input.onStage?.('working', 'code');
    const out = join(root, `pass-${passes}`, 'out');
    await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL);
    if (outcome.unchanged) {
      await writeFile(join(out, 'touched.3mf'), Buffer.from('PK\x03\x04 two parts'));
      return {status: 'unchanged', model: join(out, 'touched.stl'), parts: join(out, 'touched.3mf'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1},
        summary: 'Nothing needed changing.', partColours: [{name: 'bar', colour: '#B0855D'}, {name: 'letters and inscription', colour: '#111111'}]};
    }
    if (outcome.oneColour) return {status: 'done', model: join(out, 'touched.stl'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, summary: 'One colour now.'};
    await writeFile(join(out, 'touched.3mf'), Buffer.from('PK\x03\x04 two parts'));
    return {status: 'done', model: join(out, 'touched.stl'), parts: join(out, 'touched.3mf'), renders: [], checkpoints: [], stats: {seconds: 1, toolCalls: 1},
      summary: 'Made as the original is: black letters in a wood-colour base. Prints as one piece in two colours.',
      partColours: [{name: 'bar', colour: '#B0855D'}, {name: 'letters and inscription', colour: '#111111'}]};
  };
  const make = runner => new ObjectService({store, runTouchup, stlInfo: async () => [195.7, 19.9, 100.5], claudePath: '/unused',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, passTimings: new PassTimings(join(root, 'timings.json')),
    print: {services: {store: undefined, relay: undefined, runner: {backend: 'bambu-printer-mcp', runBundle: async () => { throw new Error('unused'); }, ...runner}}},
    runPublished: async () => ({status: 'needs_file', reason: 'test'}), events: {emit: async draft => { events.push(draft); }}});
  const service = make(runner);
  t.after(() => service.close());
  /** The companion started again over the same projects, with this printer MCP runner. */
  const restart = async next => { await service.close(); const again = make(next); t.after(() => again.close()); return again; };
  // #874 P1-1: parts are made after the project is ready; a settled project's parts have landed once partsMeshed resolves.
  const settle = async id => { await service.settled(id); await service.partsMeshed(); return service.get(id); };
  return {service, store, root, events, settle, restart};
}

// The MCP names parts and filaments (ids are its keys, never parsed); a designed 3MF from counterpart_make_3mf without
// colours carries none, so the pass's declared ones fill them in.
const DAD = [{id: '1/1', name: 'bar', filament: 1}, {id: '1/2', name: 'letters and inscription', filament: 2}];

test('a pass-made two-part 3MF yields two coloured parts in the record, each with its own mesh', async t => {
  const tool = partsTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
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
  const ready = await f.settle(object.id);
  assert.deepEqual(ready.current.parts.map(part => [part.id, part.colour, part.painted]),
    [['1/1', '#B0855D', undefined], ['1/2', '#00FF00', true], ['1/3', undefined, undefined]], 'by name (any case), then the file\'s, then none');
});

test('a part the MCP skipped means no parts: never a design drawn with a piece missing', async t => {
  const logged = [];
  t.mock.method(console, 'error', line => { logged.push(String(line)); });
  const f = await setup(t, {runner: partsTool(DAD, ['Huge base'])});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.settle(object.id);
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
  await f.service.addModelFile(object.id, 'caliper.3mf', bytes);
  await f.service.partsMeshed();
  const done = await f.service.get(object.id);
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
  await f.settle(object.id);
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
  const ready = await f.settle(object.id);
  assert.equal(ready.current.parts, undefined);
  assert.ok(logged.some(line => line.includes('couldn’t keep this design’s parts in their colours, so it shows as one piece: the MCP could not read the 3MF')));
});

test('sealing a version keeps its parts; a one-colour revision leaves current with none', async t => {
  const f = await setup(t, {runner: partsTool(DAD), outcomes: [{}, {oneColour: true}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
  await f.service.correct(object.id, 'Make it all one colour');
  await f.settle(object.id);
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
  await f.settle(object.id);
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
  await f.settle(object.id);
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

test('#874 P1-1: a slow MCP never holds a pass\'s end: the project is ready first, and its parts arrive later with an update', async t => {
  const tool = slowTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await promptly(f.service.settled(object.id), 'the pass\'s end');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.current.model, 'current/model.3mf');
  assert.equal(ready.current.parts, undefined, 'drawn as one piece until the parts arrive');
  tool.release();
  await f.service.partsMeshed();
  const later = await f.service.get(object.id);
  assert.deepEqual(later.current.parts.map(part => part.id), ['1/1', '1/2']);
  assert.ok(f.events.some(event => event.type === 'project.updated' && event.data?.keys?.includes('current')), 'clients are told to redraw');
  assert.deepEqual(later.versions.at(-1).result.parts?.map(part => part.mesh), [`versions/${later.versions.at(-1).id}/parts/part-1.stl`, `versions/${later.versions.at(-1).id}/parts/part-2.stl`],
    'the design sealed before its parts came gets them too');
});

test('#874 P1-1: a plate switch to another file returns at once; that file\'s parts arrive later', async t => {
  const tool = slowTool(path => path.endsWith('second.3mf') ? [{id: '1/1', name: 'Lid', colour: '#FFFFFF'}, {id: '1/2', name: 'Box', colour: '#000000'}] : DAD, path => path.endsWith('second.3mf'));
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('Print this', 'published', LINK);
  const file = title => Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8(`<model><metadata name="Title">${title}</metadata><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>`)}));
  await f.service.addModelFile(object.id, 'first.3mf', file('First'));
  await f.service.addModelFile(object.id, 'second.3mf', file('Second'));
  await f.service.partsMeshed();
  assert.equal((await f.service.get(object.id)).current.parts.length, 2, 'the first file\'s parts');
  const switched = await promptly(f.service.selectPlate(object.id, 1, 0), 'the plate switch');
  assert.match(switched.current.model, /second\.3mf$/);
  assert.equal(switched.current.parts, undefined, 'the first file\'s parts are not the second\'s');
  tool.release();
  await f.service.partsMeshed();
  assert.deepEqual((await f.service.get(object.id)).current.parts.map(part => part.name), ['Lid', 'Box']);
});

test('#874 P1-1: a newer model wins over a slow older job: its parts never land on the one-colour revision', async t => {
  const tool = slowTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}, outcomes: [{}, {oneColour: true}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await promptly(f.service.settled(object.id), 'the pass\'s end');
  await f.service.correct(object.id, 'Make it all one colour');
  await promptly(f.service.settled(object.id), 'the revision\'s end');
  tool.release();
  await f.service.partsMeshed();
  const revised = await f.service.get(object.id);
  assert.equal(revised.current.model, 'current/model.stl');
  assert.equal(revised.current.parts, undefined);
  assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')));
});

test('#874 P2-5: a 3MF the MCP meshes as one part records no parts (the spool rule draws it)', async t => {
  const tool = partsTool([{id: '1/1', name: 'Body', colour: '#FF0000'}]);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.settle(object.id);
  assert.equal(tool.asked.length, 1);
  assert.equal(ready.current.parts, undefined);
  assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')));
});

test('#874 P2-3: a part mesh over 64 MB, or meshes over 256 MB in all, means no parts, refused before reading', async t => {
  const MiB = 1024 * 1024;
  for (const [why, parts, said] of [
    ['one part too large', [{...DAD[0], bytes: 65 * MiB}, DAD[1]], 'is over 64 MB'],
    ['too large together', Array.from({length: 5}, (_, n) => ({id: `1/${n + 1}`, name: `part ${n + 1}`, bytes: 60 * MiB})), 'over 256 MB in all'],
  ]) {
    const logged = [];
    t.mock.method(console, 'error', line => { logged.push(String(line)); });
    const f = await setup(t, {runner: partsTool(parts)});
    const object = await f.service.create('A replica of this DAD desk thing', 'copy');
    await f.service.start(object.id);
    const ready = await f.settle(object.id);
    assert.equal(ready.current.parts, undefined, why);
    assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')), why);
    assert.ok(logged.some(line => line.includes(said)), why);
    t.mock.restoreAll();
  }
});

test('#874 P2-7: while a pass that changed nothing has its parts made again, they stay listed and on disk, then are swapped whole', async t => {
  let calls = 0;
  const tool = slowTool(DAD, () => ++calls > 1);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}, outcomes: [{}, {unchanged: true}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
  await f.service.correct(object.id, 'Check it again');
  const waiting = await promptly(f.service.settled(object.id), 'the unchanged pass\'s end');
  const dir = f.store.dir(object.id);
  assert.deepEqual(waiting.current.parts?.map(part => part.mesh), ['current/parts/part-1.stl', 'current/parts/part-2.stl'], 'still listed');
  for (const part of waiting.current.parts) assert.ok(existsSync(join(dir, part.mesh)), `${part.mesh} is still served`);
  tool.release();
  await f.service.partsMeshed();
  const landed = await f.service.get(object.id);
  assert.equal(landed.current.parts.length, 2);
  for (const part of landed.current.parts) assert.equal(await readFile(join(dir, part.mesh), 'utf8'), partStl(part.name));
});

test('#874 P3: sealing into a folder sealed before copies the parts it lacks, so a version never lists a part not on disk', async t => {
  const {sealVersion} = await import('../dist/objects/versions.js');
  const root = await tempDir('objects-parts-seal-');
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'current', 'parts'), {recursive: true});
  await writeFile(join(root, 'current', 'model.3mf'), 'PK two parts');
  await writeFile(join(root, 'current', 'model.stl'), STL);
  for (const n of [1, 2]) await writeFile(join(root, 'current', 'parts', `part-${n}.stl`), partStl(`part ${n}`));
  const object = {id: '9f0e8c6a-1111-4111-8111-111111111111', versions: []};
  const result = {model: 'current/model.3mf', renders: []};
  const first = await sealVersion(object, root, result, {startedAtMs: 1, endedAtMs: 2});
  assert.equal(first.result.parts, undefined);
  const parts = [{id: '1/1', name: 'bar', colour: '#B0855D', mesh: 'current/parts/part-1.stl'}, {id: '1/2', name: 'letters', colour: '#111111', mesh: 'current/parts/part-2.stl'}];
  const again = await sealVersion(object, root, {...result, parts}, {startedAtMs: 1, endedAtMs: 3});
  assert.equal(again.id, first.id, 'the same folder, reused');
  assert.deepEqual(again.result.parts.map(part => part.mesh), [`versions/${first.id}/parts/part-1.stl`, `versions/${first.id}/parts/part-2.stl`]);
  for (const part of again.result.parts) assert.ok(existsSync(join(root, part.mesh)), `${part.mesh} is on disk`);
});

test('#874 re-check P2-2: closing stops a part-mesh job and waits for it, with no false log and nothing left behind', async t => {
  const logged = [];
  t.mock.method(console, 'error', line => { logged.push(String(line)); });
  const tool = slowTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await promptly(f.service.settled(object.id), 'the pass\'s end');
  await promptly(f.service.close(), 'closing');
  assert.equal(tool.asked.length, 0, 'the call never finished');
  assert.ok(!logged.some(line => line.includes('couldn’t keep this design’s parts')), 'stopping is not a failure');
  assert.deepEqual((await readdir(join(f.store.dir(object.id), 'current'))).filter(name => name.startsWith('.parts-')), []);
  assert.equal((await f.store.get(object.id)).current.parts, undefined);
});

test('#874 re-check P2-2: at start, a stopped job\'s folders are swept and a 3MF design with no parts is meshed again', async t => {
  const f = await setup(t);
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
  const current = join(f.store.dir(object.id), 'current');
  for (const name of ['.parts-mcp-1', '.parts-next-2', '.parts-old-3']) { await mkdir(join(current, name)); await writeFile(join(current, name, 'part-1.stl'), STL); }
  const tool = partsTool(DAD);
  const again = await f.restart({modelParts: tool.modelParts});
  await again.resume();
  assert.deepEqual((await readdir(current)).filter(name => name.startsWith('.parts-')), [], 'swept before anything else');
  await again.partsMeshed();
  const ready = await again.get(object.id);
  assert.deepEqual(ready.current.parts.map(part => [part.id, part.colour]), [['1/1', '#B0855D'], ['1/2', '#111111']], 'meshed again, in the pass\'s colours');
  // A design that already has its parts, and an MCP without the tool, are left alone.
  const third = await f.restart({modelParts: async () => { throw new Error('not asked'); }});
  await third.resume();
  await third.partsMeshed();
  assert.equal((await third.get(object.id)).current.parts.length, 2);
});

test('#874 re-check P3-2: a build that fails clears the old parts too, so no unlisted folder stays behind', async t => {
  const logged = [];
  t.mock.method(console, 'error', line => { logged.push(String(line)); });
  let calls = 0;
  const tool = partsTool(DAD);
  const modelParts = async input => { const answer = await tool.modelParts(input); return ++calls > 1 ? {...answer, skipped: ['Huge base']} : answer; };
  const f = await setup(t, {runner: {modelParts}, outcomes: [{}, {}]});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  assert.equal((await f.settle(object.id)).current.parts.length, 2);
  await f.service.correct(object.id, 'Make the letters thicker');
  const revised = await f.settle(object.id);
  assert.equal(revised.current.parts, undefined);
  assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')), 'the first design\'s parts are gone with it');
  assert.ok(logged.some(line => line.includes('couldn’t mesh Huge base')));
  await f.service.correct(object.id, 'Once more');
  assert.ok(await f.settle(object.id), 'a later job for the project still runs');
});

test('#874 re-check P3-1: sealed copies are made before the swap, so a failure there leaves the record and the folder in agreement', async t => {
  t.mock.method(console, 'error', () => {});
  const tool = slowTool(DAD);
  const f = await setup(t, {runner: {modelParts: tool.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await promptly(f.service.settled(object.id), 'the pass\'s end');
  const version = join(f.store.dir(object.id), 'versions', ready.versions.at(-1).id);
  await chmod(version, 0o555);
  try {
    tool.release();
    await f.service.partsMeshed();
    const after = await f.store.get(object.id);
    assert.equal(after.current.parts, undefined, 'not listed');
    assert.ok(!existsSync(join(f.store.dir(object.id), 'current', 'parts')), 'and not swapped in');
    assert.equal(after.versions.at(-1).result.parts, undefined);
  } finally { await chmod(version, 0o755); }
});

/** A part-mesh tool that counts the times it is asked. */
function counted(answer) { const tool = partsTool(answer); return {...tool, calls: () => tool.asked.length}; }

test('#874 marker: a one-part design is not asked again on the next start, and the marker never reaches a client', async t => {
  const first = counted([{id: '1/1', name: 'Body', colour: '#FF0000'}]);
  const f = await setup(t, {runner: {modelParts: first.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  const ready = await f.settle(object.id);
  assert.equal(first.calls(), 1);
  assert.equal(ready.current.parts, undefined);
  const stored = await f.store.get(object.id);
  assert.equal(stored.partsChecked.model, 'current/model.3mf');
  assert.equal(stored.partsChecked.outcome, 'none');
  assert.match(stored.partsChecked.sha256, /^[0-9a-f]{64}$/);
  assert.equal(publicObject(stored).partsChecked, undefined, 'store only');
  const next = counted([{id: '1/1', name: 'Body', colour: '#FF0000'}]);
  const again = await f.restart({modelParts: next.modelParts});
  await again.resume();
  await again.partsMeshed();
  assert.equal(next.calls(), 0, 'not meshed and thrown away again');
});

test('#874 marker: a job a stop interrupted is asked again on the next start, and its parts land', async t => {
  const slow = slowTool(DAD);
  const f = await setup(t, {runner: {modelParts: slow.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await promptly(f.service.settled(object.id), 'the pass\'s end');
  await f.service.close();
  assert.equal((await f.store.get(object.id)).partsChecked, undefined, 'a stopped job writes no marker');
  const next = counted(DAD);
  const again = await f.restart({modelParts: next.modelParts});
  await again.resume();
  await again.partsMeshed();
  assert.equal(next.calls(), 1);
  assert.equal((await again.get(object.id)).current.parts.length, 2);
  assert.equal((await f.store.get(object.id)).partsChecked.outcome, 'parts');
});

test('#874 marker: a model whose bytes changed since it was checked is asked again', async t => {
  const first = counted([{id: '1/1', name: 'Body'}]);
  const f = await setup(t, {runner: {modelParts: first.modelParts}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
  // A pass that wrote a new model and stopped before its parts job landed.
  await writeFile(join(f.store.dir(object.id), 'current', 'model.3mf'), Buffer.from('PK\x03\x04 two parts, changed'));
  const next = counted(DAD);
  const again = await f.restart({modelParts: next.modelParts});
  await again.resume();
  await again.partsMeshed();
  assert.equal(next.calls(), 1);
  assert.equal((await again.get(object.id)).current.parts.length, 2);
});

test('#874 marker: a design checked against an MCP without the tool is asked again (a cheap question), so a newer MCP gets its chance', async t => {
  let asked = 0;
  const f = await setup(t, {runner: {modelParts: async () => { asked++; return undefined; }}});
  const object = await f.service.create('A replica of this DAD desk thing', 'copy');
  await f.service.start(object.id);
  await f.settle(object.id);
  assert.equal(asked, 1);
  assert.equal((await f.store.get(object.id)).partsChecked.outcome, 'unlisted');
  const next = counted(DAD);
  const again = await f.restart({modelParts: next.modelParts});
  await again.resume();
  await again.partsMeshed();
  assert.equal(next.calls(), 1, 'the MCP that now lists the tool meshes it');
  assert.equal((await again.get(object.id)).current.parts.length, 2);
});
