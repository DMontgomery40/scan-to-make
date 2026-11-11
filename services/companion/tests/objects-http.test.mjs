import test from 'node:test';
import {mcpPlates} from './support/shown-print.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, open, readFile, rm, writeFile, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {splitFitBrief, workerRequest} from '../dist/objects/fit.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {tempDir} from './support/temp.mjs';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function fixture(t, {denied = [], reconstruct, reportsCompletion, camera, printers, printerCatalog, print, mac = false} = {}) {
  const root = await tempDir('objects-http-');
  const store = new ObjectStore(join(root, 'objects'));
  const inputs = [];
  const runTouchup = async input => {
    inputs.push(input);
    const out = join(root, 'pass', 'out'); await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL); await writeFile(join(out, 'front.png'), 'png');
    return {status: 'done', summary: 'Fixed.', model: join(out, 'touched.stl'), renders: [join(out, 'front.png')], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(root, 'pass')};
  };
  const events = [];
  const service = new ObjectService({store, runTouchup, reportsCompletion, camera, printers, printerCatalog, ...(print ? {print} : {}), stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, ...(reconstruct ? {reconstruct} : {}),
    ...(mac ? {objectCaptureRebuild: true, scanToStl: async (_scan, stl) => { await writeFile(stl, STL); }} : {}),
    events: {emit: async draft => { events.push(draft); }}});
  const routes = createObjectRoutes(service);
  const scopes = [], devices = [];
  const server = createServer(async (request, response) => {
    const authorize = async scope => { scopes.push(scope); devices.push(request.headers['x-test-device']); if (denied.includes(scope)) { const e = new Error('forbidden'); e.name = 'RemoteAuthFailure'; throw e; } };
    try { await routes.handle(request, response, authorize, name => request.headers[name]); }
    catch (error) { response.statusCode = error.name === 'RemoteAuthFailure' ? 403 : 500; response.end(JSON.stringify({error: {code: String(error.message)}})); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, type = 'application/json', device = 'source-phone') => {
    const response = await fetch(base + path, {method, headers: {'content-type': type, 'x-test-device': device, 'x-scan-device': device}, ...(body !== undefined ? {body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)} : {})});
    const bytes = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    return {status: response.status, json, bytes, type: response.headers.get('content-type')};
  };
  return {call, scopes, devices, service, store, events, inputs};
}

test('create, list and get an object', async t => {
  const {call, scopes} = await fixture(t);
  const created = await call('POST', '/v1/objects', {instructions: 'A hook for a 25 mm handle.'});
  assert.equal(created.status, 201);
  const id = created.json.object.id;
  assert.equal(created.json.object.state, 'new');
  assert.deepEqual((await call('GET', '/v1/objects')).json.objects.map(o => o.id), [id]);
  assert.equal((await call('GET', `/v1/objects/${id}`)).json.object.instructions, 'A hook for a 25 mm handle.');
  assert.deepEqual(scopes, ['captures:import', 'projects:read', 'projects:read']);
});

test('an unsent scan draft can change from copy to fit before it starts', async t => {
  const {call} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {kind: 'copy'})).json.object.id;
  const changed = await call('PATCH', `/v1/objects/${id}`, {kind: 'fit', instructions: 'A pegboard holder for this bottle.'});
  assert.equal(changed.status, 200);
  assert.equal(changed.json.object.kind, 'fit');
  assert.equal(changed.json.object.instructions, 'A pegboard holder for this bottle.');
  assert.equal((await call('PATCH', `/v1/objects/${id}`, {kind: 'published'})).status, 400);
  // How the size is settled travels as fields beside the words, on create and on a draft, and never inside them.
  const fit = {sizeSource: 'measured', measured: [{id: 'longest', label: 'longest', mm: 107}]};
  const fitted = await call('PATCH', `/v1/objects/${id}`, {fit});
  assert.equal(fitted.status, 200);
  assert.deepEqual(fitted.json.object.fit, fit);
  assert.equal(fitted.json.object.instructions, 'A pegboard holder for this bottle.');
  assert.equal((await call('PATCH', `/v1/objects/${id}`, {fit: {sizeSource: 'measured'}})).status, 400);
  assert.equal((await call('PATCH', `/v1/objects/${id}`, {fit: null})).json.object.fit, undefined, 'null clears it');
  await call('PATCH', `/v1/objects/${id}`, {fit});
  assert.equal((await call('PATCH', `/v1/objects/${id}`, {kind: 'copy'})).json.object.fit, undefined, 'a draft that becomes a copy keeps no fit choice');
  const made = await call('POST', '/v1/objects', {instructions: 'A clip for this.', kind: 'fit', fit: {sizeSource: 'scan'}});
  assert.equal(made.status, 201);
  assert.deepEqual(made.json.object.fit, {sizeSource: 'scan'});
  assert.equal((await call('POST', '/v1/objects', {instructions: 'A clip.', kind: 'fit', fit: {sizeSource: 'nope'}})).status, 400);
  assert.equal((await call('POST', '/v1/objects', {kind: 'copy', fit: {sizeSource: 'scan'}})).json.object.fit, undefined, 'only a fit with words has one');
  assert.equal((await call('PATCH', `/v1/objects/${id}`, {})).status, 400);
});

// Nov 6: refusals were invisible (the companion's output went nowhere) and the apps couldn't tell a sentence for the
// person from a bare code. Each refusal is logged with its status and code; `sentence` marks the person's words.
test('a refusal written for the person says so (sentence), a bare code doesn\'t, and both are logged', async t => {
  const {call} = await fixture(t);
  const logged = [], original = console.error; console.error = (...args) => logged.push(args.join(' ')); t.after(() => { console.error = original; });
  const id = (await call('POST', '/v1/objects', {instructions: 'A hook.'})).json.object.id;
  const refused = await call('POST', `/v1/objects/${id}/print`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.sentence, refused.json.error.message);
  assert.ok(refused.json.error.sentence.endsWith('.'));
  const missing = await call('GET', `/v1/objects/${id}/nowhere`);
  assert.equal(missing.status, 404); assert.equal(missing.json.error.sentence, undefined, 'a bare code is not a sentence');
  assert.ok(logged.some(line => line.includes(`/v1/objects/${id}/print`) && line.includes('409')), logged.join('\n'));
  assert.ok(logged.some(line => line.includes('404') && line.includes('not-found')), logged.join('\n'));
});
test('retained reconstruction failures stop asserting user error without rewriting stored history', async t => {
  const {call, store, service} = await fixture(t);
  const object = await service.create();
  const old = "Your Mac couldn't build a model from these photos. Try again with the object filling more of the frame, turning it slowly.";
  await store.update(object.id, o => ({...o, state: 'failed', failure: old, passes: [{startedAtMs: 1, status: 'failed', summary: old}]}));
  for (const shown of [(await call('GET', `/v1/objects/${object.id}`)).json.object,
                       (await call('GET', '/v1/objects')).json.objects[0]]) {
    assert.equal(shown.failure, "Your Mac couldn't build a model from this capture. Your photos are saved in Inputs.");
    assert.equal(shown.passes[0].summary, shown.failure);
  }
  assert.equal((await store.get(object.id)).failure, old);
  assert.equal((await store.get(object.id)).passes[0].summary, old);
});

test('exact capture depth requires write scope, stays separate from photo media, and rejects unsafe names', async t => {
  const {call, scopes, service} = await fixture(t);
  const object = await service.create();
  const path = `/v1/objects/${object.id}/capture-depth`;
  const payload = Buffer.concat([Buffer.from('bplist00'), Buffer.from([1, 2, 0, 255])]);
  const saved = await call('POST', path + '?name=0000.depth.plist', payload, 'application/octet-stream');
  assert.equal(saved.status, 200);
  assert.equal(scopes.at(-1), 'captures:import');
  assert.deepEqual(saved.json.object.captureDepth, ['0000.depth.plist']);
  assert.equal(saved.json.object.capture, undefined);
  assert.equal((await call('GET', `/v1/objects/${object.id}/capture/0000.depth.plist`)).status, 404);
  assert.equal((await call('POST', path + '?name=../0000.depth.plist', payload)).status, 400);
  assert.equal((await call('POST', path + '?name=0000.depth.plist', Buffer.from('bad'))).status, 400);
  assert.equal((await call('POST', path + '?name=0001.depth.plist', Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
  const denied = await fixture(t, {denied: ['captures:import']});
  const other = await denied.service.create();
  assert.equal((await denied.call('POST', `/v1/objects/${other.id}/capture-depth?name=0000.depth.plist`, payload)).status, 403);
});

test('another authorized phone cannot start an uploaded pair prefix and the source can resume and complete it', async t => {
  let builds = 0;
  const release = Promise.withResolvers();
  const {call, service, devices, scopes} = await fixture(t, {reconstruct: async input => {
    builds += 1;
    await release.promise;
    await writeFile(input.output, 'usdz');
  }});
  t.after(() => release.resolve());
  const id = (await call('POST', '/v1/objects', {instructions: 'Copy this.'})).json.object.id;
  const path = `/v1/objects/${id}`;
  const full = {captureManifest: {version: 1, images: ['0000.heic', '0001.heic'], depthRequired: true}};
  const sendPair = async stem => {
    assert.equal((await call('POST', `${path}/capture-depth?name=${stem}.depth.plist`, Buffer.from('bplist00'))).status, 200);
    assert.equal((await call('POST', `${path}/capture?name=${stem}.heic`, Buffer.from('rgb'))).status, 200);
  };
  await sendPair('0000');
  assert.equal((await call('GET', path, undefined, undefined, 'other-paired-phone')).json.object.capture.length, 1);
  const premature = await call('POST', path + '/start', undefined, undefined, 'other-paired-phone');
  assert.equal(premature.status, 409);
  assert.match(premature.json.error.message, /phone that recorded it/);
  assert.equal((await call('POST', path + '/start', full)).status, 409, 'manifest does not hide a missing trailing pair');
  assert.equal((await service.get(id)).state, 'new');
  assert.equal(builds, 0);
  await sendPair('0001');
  const started = await call('POST', path + '/start', full);
  assert.equal(started.status, 200);
  assert.equal(started.json.object.state, 'touching-up');
  assert.equal((await call('POST', path + '/start', full)).json.object.state, 'touching-up');
  release.resolve();
  assert.equal((await service.settled(id)).state, 'ready');
  assert.equal((await call('POST', path + '/start', full)).json.object.state, 'ready');
  assert.equal(builds, 1, 'manifest retries do not replay a completed start');
  assert.ok(devices.includes('source-phone') && devices.includes('other-paired-phone'));
  assert.equal(scopes.at(-1), 'captures:import');
});

test('a walk-around declares its images before any frame, marks its preview, and no other phone can start it early', async t => {
  const builds = [];
  const {call, service} = await fixture(t, {mac: true, reconstruct: async input => { builds.push(input); await writeFile(input.output, 'usdz'); return {status: 'done'}; }});
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  const path = `/v1/objects/${id}`;
  const manifest = {version: 1, images: ['0001.heic', '0002.heic'], depthRequired: false, source: 'object-capture'};
  assert.equal((await call('POST', `${path}/capture-manifest`, {...manifest, cameraMetadataRequired: false})).status, 400, 'exactly four fields');
  assert.equal((await call('POST', `${path}/capture-manifest`, {...manifest, images: ['00041.732011084.HEIC']})).status, 400);
  assert.equal((await call('POST', `${path}/capture-manifest`, manifest)).status, 200);
  assert.equal((await call('POST', `${path}/capture?name=0001.heic`, Buffer.from('a'))).status, 200);
  assert.equal((await call('POST', `${path}/capture?name=0003.heic`, Buffer.from('c'))).status, 409, 'not one of the declared images');
  const early = await call('POST', path + '/start', undefined, undefined, 'other-paired-phone');
  assert.equal(early.status, 409);
  assert.match(early.json.error.message, /phone that recorded it/);
  assert.equal(builds.length, 0);
  assert.equal((await call('POST', `${path}/capture?name=0002.heic`, Buffer.from('b'))).status, 200);
  assert.equal((await call('PUT', `${path}/scan?preview=true`, Buffer.from('usdz'), 'model/vnd.usdz+zip')).status, 200);
  assert.equal((await service.get(id)).scanSource, 'phone-preview');
  assert.equal((await call('POST', path + '/start', {captureManifest: manifest})).status, 200);
  assert.equal((await service.settled(id)).state, 'ready');
  assert.equal(builds.length, 1);
  assert.equal(builds[0].objectCapture, true);

  // A computer without Apple's rebuild (Linux) refuses an iPhone walk-around in words.
  const linux = await fixture(t);
  const other = (await linux.call('POST', '/v1/objects', {})).json.object.id;
  const refused = await linux.call('POST', `/v1/objects/${other}/capture-manifest`, manifest);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.message, 'Scans from iPhone are rebuilt on a Mac. Pair this iPhone with a Mac to use Scan it.');
});

test('start validates the bounded manifest and requires capture import scope', async t => {
  const {call, service} = await fixture(t);
  const object = await service.create();
  const path = `/v1/objects/${object.id}/start`;
  const valid = {version: 1, images: ['0000.heic'], depthRequired: true};
  for (const captureManifest of [null, [], {}, {...valid, version: 2}, {...valid, depthRequired: 'true'},
    {...valid, images: []}, {...valid, images: ['../0000.heic']}, {...valid, images: ['0000.HEIC']},
    {...valid, images: ['0000.heic', '0000.heic']}, {...valid, images: Array(10001).fill('0000.heic')}]) {
    assert.equal((await call('POST', path, {captureManifest})).status, 400, JSON.stringify(captureManifest).slice(0, 160));
  }
  assert.equal((await call('POST', path, 'null')).status, 400);
  const maximum = {captureManifest: {...valid, images: Array.from({length: 10000}, (_, i) => `${String(i).padStart(4, '0')}.heic`)}};
  assert.equal((await call('POST', path, maximum)).status, 409, 'valid10,000-name manifest reaches file validation beyond16KiB');
  assert.equal((await call('POST', path, ' '.repeat(128 * 1024 + 1))).status, 413);
  const denied = await fixture(t, {denied: ['captures:import']});
  const other = await denied.service.create();
  assert.equal((await denied.call('POST', `/v1/objects/${other.id}/start`, {captureManifest: valid})).status, 403);
});

test('original scan export preserves every supported retained model format', async t => {
  const {call, service} = await fixture(t);
  for (const [extension, type] of [['stl', 'model/stl'], ['3mf', 'model/3mf'], ['usdz', 'model/vnd.usdz+zip']]) {
    const project = await service.create();
    await service.addScan(project.id, `scan.${extension}`, Buffer.from(`original ${extension}`));
    const response = await call('GET', `/v1/objects/${project.id}/scan/scan.${extension}`);
    assert.equal(response.status, 200);
    assert.equal(response.type, type);
    assert.equal(response.bytes.toString(), `original ${extension}`);
    assert.equal((await call('GET', `/v1/objects/${project.id}/scan/unrecorded.${extension}`)).status, 404);
  }
});

test('scan, photos, start, then the ready model and renders download', async t => {
  const {call, service} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'Copy this.'})).json.object.id;   // asked for: a touch-up runs
  assert.equal((await call('PUT', `/v1/objects/${id}/scan`, Buffer.from('usdz'), 'model/vnd.usdz+zip')).status, 200);
  assert.equal((await call('POST', `/v1/objects/${id}/photos?name=IMG_0001.HEIC`, Buffer.from('heic'), 'image/heic')).status, 200);
  const started = await call('POST', `/v1/objects/${id}/start`);
  assert.equal(started.json.object.state, 'touching-up');
  await service.settled(id);
  const ready = (await call('GET', `/v1/objects/${id}`)).json.object;
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.current.sizeMm, [60.6, 45.2, 21.7]);
  const original = await call('GET', `/v1/objects/${id}/scan/${ready.scan}`);
  assert.equal(original.bytes.toString(), 'usdz');
  assert.equal(original.type, 'model/vnd.usdz+zip');
  assert.equal((await call('GET', `/v1/objects/${id}/scan/unrecorded.usdz`)).status, 404);
  assert.equal((await call('GET', `/v1/objects/${id}/scan/%2e%2e%2fobject.json`)).status, 404);
  assert.equal((await call('GET', `/v1/objects/${id}/model.stl`)).bytes.toString(), STL);
  assert.equal((await call('GET', `/v1/objects/${id}/renders/front.png`)).bytes.toString(), 'png');
  assert.equal(JSON.stringify(ready).includes(tmpdir()), false, 'no Mac file paths reach the phone');
});

test('a corrections note runs another pass', async t => {
  const {call, service} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'A hook.'})).json.object.id;
  await call('POST', `/v1/objects/${id}/start`);
  await service.settled(id);
  const corrected = await call('POST', `/v1/objects/${id}/corrections`, {note: 'make it 2 mm thicker'});
  assert.equal(corrected.status, 200);
  assert.equal(corrected.json.object.state, 'touching-up');
  await service.settled(id);
});

// Nov 10, "Guitar pick": one note was recorded twice, 98 seconds apart, and each copy started a design pass. The
// reply to the first send never reached the phone, so the words stayed in the box and were sent again.
test('a note sent again with the same message id is recorded once and starts one pass', async t => {
  const {call, service} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'A hook.'})).json.object.id;
  await call('POST', `/v1/objects/${id}/start`);
  await service.settled(id);
  const messageId = '6F1C0E0A-3B0E-4B55-9B0C-1D3E5A7C9E11';
  const note = {note: 'make it 2 mm thicker', messageId};
  const first = await call('POST', `/v1/objects/${id}/corrections`, note);
  assert.equal(first.status, 200);
  assert.equal(first.json.object.state, 'touching-up');
  // The repeat while its own pass is running: not "Wait until the current step finishes", just the project.
  const during = await call('POST', `/v1/objects/${id}/corrections`, note);
  assert.equal(during.status, 200);
  assert.equal(during.json.object.messages.length, 1);
  await service.settled(id);
  const passes = (await call('GET', `/v1/objects/${id}`)).json.object.passes.length;
  // The repeat after the pass ended, which is when a queued copy is sent.
  const after = await call('POST', `/v1/objects/${id}/corrections`, note);
  assert.equal(after.status, 200);
  assert.equal(after.json.object.state, 'ready');
  assert.equal(after.json.object.messages.length, 1);
  assert.equal(after.json.object.passes.length, passes);
  assert.equal(JSON.stringify(after.json.object).includes(messageId), false, 'the id stays in the companion');
  // The same words on purpose are a new message: a new id, or none (a client from before this).
  const again = await call('POST', `/v1/objects/${id}/corrections`, {note: note.note, messageId: '0B1D2F3A-4C5E-4F60-8A9B-0C1D2E3F4A5B'});
  assert.equal(again.json.object.state, 'touching-up');
  assert.equal(again.json.object.messages.length, 2);
  await service.settled(id);
  const old = await call('POST', `/v1/objects/${id}/corrections`, {note: note.note});
  assert.equal(old.json.object.messages.length, 3);
  await service.settled(id);
  for (const bad of ['short', 'has spaces in it', 7, 'x'.repeat(65)])
    assert.equal((await call('POST', `/v1/objects/${id}/corrections`, {note: 'x', messageId: bad})).status, 400);
});

test('bad names, unknown objects and wrong states get clear errors', async t => {
  const {call} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  assert.equal((await call('POST', `/v1/objects/${id}/photos?name=..%2Fobject.json`, Buffer.from('x'), 'image/jpeg')).status, 400);
  assert.equal((await call('GET', '/v1/objects/00000000-0000-4000-8000-000000000000')).status, 404);
  const noModel = await call('POST', `/v1/objects/${id}/print`);
  assert.equal(noModel.status, 409);
  assert.equal(noModel.json.error.code, 'invalid-state');
});

test('printing needs the printer scope', async t => {
  const {call} = await fixture(t, {denied: ['printer-handoff:use']});
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  assert.equal((await call('POST', `/v1/objects/${id}/print`)).status, 403);
});

test('there are no plate routes: no plate photo, no plate answer (PRD §5.6)', async t => {
  const {call, store} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  await writeFile(join(store.dir(id), 'plate.jpg'), 'jpeg');
  assert.equal((await call('GET', `/v1/objects/${id}/plate.jpg`)).status, 404);
  assert.equal((await call('POST', `/v1/objects/${id}/plate`, {clear: true})).status, 404);
  // An older companion's saved plate observation is dropped on load.
  const {readFile: read, writeFile: write} = await import('node:fs/promises');
  const path = join(store.dir(id), 'object.json');
  await write(path, JSON.stringify({...JSON.parse(await read(path, 'utf8')), plate: {item: 'a spool', photo: true}}));
  assert.equal('plate' in (await store.get(id)), false);
  assert.equal('plate' in (await call('GET', `/v1/objects/${id}`)).json.object, false);
});

test('printing again after an uncertain print says the user checked', async t => {
  const {call, store} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  await store.update(id, o => ({...o, state: 'failed', current: {model: 'current/model.stl', renders: []}, print: {bundleId: 'b', uncertain: true}}));
  const refused = await call('POST', `/v1/objects/${id}/print`);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error.message, /Check the printer/);
});

test('DELETE removes an object, and the event names the phone that deleted it', async t => {
  const {call, events} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'A hook.'})).json.object.id;
  const deleted = await call('DELETE', `/v1/objects/${id}`, undefined, 'application/json', 'phone-device-7');
  assert.equal(deleted.status, 200);
  assert.equal((await call('GET', `/v1/objects/${id}`)).status, 404);
  assert.deepEqual(events.filter(event => event.type === 'project.deleted').map(event => [event.projectId, event.data]), [[id, {by: 'phone-device-7'}]]);
});

test('retained photos and capture images download with their image types and read scope', async t => {
  const {call, service, scopes} = await fixture(t);
  const object = await service.create('A hook.');
  for (const [kind, name, type] of [
    ['photos', 'front view.JPEG', 'image/jpeg'], ['photos', 'side.png', 'image/png'],
    ['capture', '0001.HEIC', 'image/heic'],
  ]) {
    const bytes = Buffer.from(`${kind}:${name}`);
    if (kind === 'photos') await service.addPhoto(object.id, name, bytes);
    else await service.addCapturePhoto(object.id, name, bytes);
    const reply = await call('GET', `/v1/objects/${object.id}/${kind}/${encodeURIComponent(name)}`);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.bytes, bytes);
    assert.equal(reply.type, type);
  }
  assert.deepEqual(scopes, ['projects:read', 'projects:read', 'projects:read']);
});

test('retained images require authorization, including capture images', async t => {
  const {call, service} = await fixture(t, {denied: ['projects:read']});
  const object = await service.create('A hook.');
  await service.addPhoto(object.id, 'front.jpg', Buffer.from('private photo'));
  await service.addCapturePhoto(object.id, '0001.heic', Buffer.from('private capture'));
  for (const path of ['photos/front.jpg', 'capture/0001.heic']) {
    const reply = await call('GET', `/v1/objects/${object.id}/${path}`);
    assert.equal(reply.status, 403);
    assert.equal(reply.bytes.includes(Buffer.from('private')), false);
  }
});

test('image routes deny traversal, unlisted files and non-image files', async t => {
  const {call, service, store} = await fixture(t);
  const object = await service.create('A hook.');
  await service.addPhoto(object.id, 'front.jpg', Buffer.from('photo'));
  await store.addFile(object.id, 'photos', 'unlisted.jpg', Buffer.from('private'));
  await service.addPhoto(object.id, 'page.html', Buffer.from('<script>private</script>'));
  for (const suffix of ['photos/unlisted.jpg', 'capture/front.jpg', 'photos/page.html',
    'photos/..%2Fobject.json', 'photos/%2Fobject.json', 'photos/%252e%252e%252fobject.json', 'photos/%ZZ']) {
    assert.equal((await call('GET', `/v1/objects/${object.id}/${suffix}`)).status, 404, suffix);
  }
});

test('editing an unsent prompt persists it, but starting makes the prompt immutable', async t => {
  const {call, service, scopes} = await fixture(t);
  const object = await service.create('Original request.');
  const path = `/v1/objects/${object.id}`;
  assert.equal((await call('PATCH', path, {instructions: '  Edited request.  '})).status, 200);
  assert.equal((await service.get(object.id)).instructions, 'Edited request.');
  assert.equal(scopes.at(-1), 'captures:import');
  assert.equal((await call('PATCH', path, {instructions: 'x'.repeat(8001)})).status, 400);
  assert.equal((await call('PATCH', path, {})).status, 400);
  await service.start(object.id);
  assert.equal((await call('PATCH', path, {instructions: 'Too late.'})).status, 409);
  await service.settled(object.id);
  assert.equal((await call('PATCH', path, {instructions: 'Still too late.'})).status, 409);
  assert.equal((await service.get(object.id)).instructions, 'Edited request.');
});

test('large activity histories stay out of list and detail replies and every pass remains readable', async t => {
  const {call, service, store, scopes} = await fixture(t);
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  const passes = Array.from({length: 11}, (_, index) => ({startedAtMs: index + 1, endedAtMs: index + 2,
    status: 'done', summary: `Pass ${index}`, note: `Request ${index}`, dir: `/private/passes/${index}`,
    activity: Array.from({length: 200}, (_, entry) => ({atMs: entry + 1, kind: entry % 2 ? 'tool' : 'message',
      text: `${index}/${entry}: `.padEnd(2000, 'x')}))}));
  passes.push({startedAtMs: 20, status: 'failed', summary: 'Legacy pass without recorded activity.'});
  const ids = [];
  for (let project = 0; project < 2; project++) {
    const object = await service.create(`Project ${project}`); ids.push(object.id);
    await store.update(object.id, o => ({...o, state: 'ready', passes}));
    assert.ok(Buffer.byteLength(JSON.stringify(await service.get(object.id))) > 4 * 1024 * 1024);
    const detail = await call('GET', `/v1/objects/${object.id}`);
    const local = await dispatch('objects.get', {id: object.id});
    for (const reply of [detail.json, local]) {
      assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 4 * 1024 * 1024);
      assert.equal(reply.object.passes[0].activity, undefined);
      assert.equal(reply.object.passes[0].activityCount, 200);
      assert.equal(reply.object.passes[0].summary, 'Pass 0');
      assert.equal(reply.object.passes.at(-1).activityCount, 0);
    }
    for (let index = 0; index < passes.length; index++) {
      const reply = await call('GET', `/v1/objects/${object.id}/passes/${index}/activity`);
      assert.equal(reply.status, 200);
      assert.equal(scopes.at(-1), 'projects:read');
      assert.ok(reply.bytes.length < 4 * 1024 * 1024);
      assert.deepEqual(reply.json.activity, passes[index].activity ?? []);
      assert.deepEqual(await dispatch('objects.passActivity', {id: object.id, index}), reply.json);
    }
    assert.deepEqual((await service.get(object.id)).passes, passes, 'reads must not discard stored history');
  }
  for (const list of [(await call('GET', '/v1/objects')).json, await dispatch('objects.list', {})]) {
    assert.equal(list.objects.length, ids.length);
    assert.ok(Buffer.byteLength(JSON.stringify(list)) < 4 * 1024 * 1024);
    assert.ok(list.objects.every(object => object.passes.every(pass => pass.activity === undefined)));
  }
});

test('per-pass activity requires read scope and refuses malformed or unknown indexes', async t => {
  const {call, service} = await fixture(t);
  const object = await service.create('A hook.');
  for (const index of ['-1', '1.5', '01', '1e1', '9007199254740992', 'NaN']) {
    assert.equal((await call('GET', `/v1/objects/${object.id}/passes/${index}/activity`)).status, 400, index);
  }
  assert.equal((await call('GET', `/v1/objects/${object.id}/passes/0/activity`)).status, 404);
  assert.equal((await call('GET', '/v1/objects/00000000-0000-4000-8000-000000000000/passes/0/activity')).status, 404);
  assert.equal((await call('POST', `/v1/objects/${object.id}/passes/0/activity`)).status, 405);
  const denied = await fixture(t, {denied: ['projects:read']});
  const privateObject = await denied.service.create('Private.');
  await denied.store.update(privateObject.id, o => ({...o, passes: [{startedAtMs: 1, activity: [{atMs: 2, kind: 'message', text: 'private activity'}]}]}));
  const reply = await denied.call('GET', `/v1/objects/${privateObject.id}/passes/0/activity`);
  assert.equal(reply.status, 403);
  assert.equal(reply.bytes.includes(Buffer.from('private activity')), false);
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  for (const index of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(dispatch('objects.passActivity', {id: object.id, index}), error => error.code === 'invalid-request');
  }
  await assert.rejects(dispatch('objects.passActivity', {id: object.id, index: 0}), error => error.code === 'not-found');
});

test('Status is set by hand: works makes the project confirmed ("It works"), and every app is told', async t => {
  const {call, store} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'A mic mount'})).json.object.id;
  assert.deepEqual((await call('GET', `/v1/objects/${id}/settings`)).json, {settings: {status: 'not-printed', archived: false}});
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {status: 'works'})).status, 409, 'no model yet');
  await store.update(id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  const works = await call('PATCH', `/v1/objects/${id}/settings`, {status: 'works'});
  assert.equal(works.status, 200);
  assert.deepEqual(works.json.settings, {status: 'works', archived: false});
  assert.equal(works.json.object.state, 'confirmed');
  assert.deepEqual(works.json.object.status, {phase: 'confirmed', text: 'Done · it works', symbol: 'checkmark.circle.fill', tint: 'green'});
  assert.deepEqual(works.json.object.settings, {status: 'works', archived: false});
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {status: 'done'})).status, 400);
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {status: 'works', name: 'x'})).status, 400);
  for (const status of ['needs-changes', 'printed', 'not-printed']) {
    const changed = await call('PATCH', `/v1/objects/${id}/settings`, {status});
    assert.equal(changed.json.settings.status, status, status);
  }
  // Hidden from Home is a flag of its own: the status underneath stays exactly, `sent` included.
  await store.update(id, o => ({...o, state: 'sent'}));
  const hidden = await call('PATCH', `/v1/objects/${id}/settings`, {archived: true});
  assert.deepEqual(hidden.json.settings, {status: 'printed', archived: true});
  assert.equal(hidden.json.object.state, 'sent');
  const shown = await call('PATCH', `/v1/objects/${id}/settings`, {archived: false});
  assert.deepEqual([shown.json.settings.archived, shown.json.object.state], [false, 'sent']);
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {archived: 'yes'})).status, 400);
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {})).status, 400);
  await store.update(id, o => ({...o, state: 'ready'}));
  assert.equal((await store.get(id)).state, 'ready');
  // A state the label hides still changes: a sent print marked printed; a failed one with a model marked not printed.
  await store.update(id, o => ({...o, state: 'sent'}));
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {status: 'printed'})).json.object.state, 'printed');
  await store.update(id, o => ({...o, state: 'failed'}));
  assert.equal((await call('PATCH', `/v1/objects/${id}/settings`, {status: 'not-printed'})).json.object.state, 'ready');
  // A draft without a model can be archived and brought back, staying a draft.
  const draft = (await call('POST', '/v1/objects', {instructions: 'A hook'})).json.object.id;
  assert.equal((await call('PATCH', `/v1/objects/${draft}/settings`, {status: 'archived'})).json.settings.archived, true, 'the old status value still hides it');
  const back = await call('PATCH', `/v1/objects/${draft}/settings`, {archived: false});
  assert.deepEqual([back.status, back.json.settings.status, back.json.settings.archived, back.json.object.state], [200, 'not-printed', false, 'new']);
});

test('the Mac sets Status over the control socket; project.updated tells the apps; the flag says so', async t => {
  const {mkdtemp: temp, rm: remove, mkdir: makeDir, writeFile: write} = await import('node:fs/promises');
  const {tmpdir: tmp} = await import('node:os');
  const {ObjectStore: Store} = await import('../dist/objects/store.js');
  const {createControlDispatcher} = await import('../dist/local-control-services.js');
  const root = await temp(join(tmp(), 'objects-status-'));
  t.after(() => remove(root, {recursive: true, force: true}));
  const store = new Store(join(root, 'objects')), events = [];
  const service = new ObjectService({store, runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined, claudePath: '/c',
    handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, events: {emit: async draft => { events.push(draft); }}});
  t.after(() => service.close());
  const object = await store.create('A mic mount');
  await makeDir(join(store.dir(object.id), 'current'), {recursive: true});
  await write(join(store.dir(object.id), 'current', 'model.stl'), 'solid x');
  await store.update(object.id, o => ({...o, state: 'printed', current: {model: 'current/model.stl', renders: []}}));
  const dispatch = createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: service});
  assert.deepEqual(await dispatch('objects.settings.get', {id: object.id}), {settings: {status: 'printed', archived: false}});
  assert.deepEqual((await dispatch('objects.settings.set', {id: object.id, archived: true})).settings, {status: 'printed', archived: true});
  assert.deepEqual((await dispatch('objects.settings.set', {id: object.id, archived: false})).settings, {status: 'printed', archived: false});
  events.length = 0;
  const set = await dispatch('objects.settings.set', {id: object.id, status: 'works'});
  assert.deepEqual([set.settings.status, set.object.state, set.object.status.phase], ['works', 'confirmed', 'confirmed']);
  assert.deepEqual(events.map(event => [event.type, event.data]), [['project.updated', {keys: ['status']}]]);
  assert.equal((await dispatch('status.get', {})).capabilities.projectSettings, true);
  assert.equal((await dispatch('status.get', {})).capabilities.projectRename, true);
  await assert.rejects(dispatch('objects.settings.set', {id: object.id, status: 'done'}));
});


test('a name set on either device persists and does not start or stop a pass', async t => {
  const {call, store, service, events} = await fixture(t);
  const object = await service.create('A mic mount');
  await store.update(object.id, o => ({...o, state: 'touching-up', passes: [{startedAtMs: 1, note: 'Tighten the clip'}]}));
  const renamed = await call('PATCH', `/v1/objects/${object.id}/settings`, {title: '  Studio microphone mount  '});
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.object.title, 'Studio microphone mount');
  assert.equal(renamed.json.object.state, 'touching-up');
  assert.equal(renamed.json.object.passes.length, 1);
  const dispatch = createControlDispatcher({auth: {transport: 'lan', listDevices: async () => []}, companionVersion: 'test', objects: service});
  assert.equal((await dispatch('objects.get', {id: object.id})).object.title, 'Studio microphone mount');
  const changed = await dispatch('objects.settings.set', {id: object.id, title: 'Desk mount'});
  assert.equal(changed.object.title, 'Desk mount');
  assert.equal((await call('GET', `/v1/objects/${object.id}`)).json.object.title, 'Desk mount');
  assert.equal((await store.get(object.id)).title, 'Desk mount');
  assert.deepEqual(events.filter(e => e.type === 'project.updated').map(e => e.data), [{keys: ['title']}, {keys: ['title']}]);
  for (const title of ['', '   ', 'x'.repeat(121), 'hidden\u0000name', 42]) {
    assert.equal((await call('PATCH', `/v1/objects/${object.id}/settings`, {title})).status, 400);
    await assert.rejects(dispatch('objects.settings.set', {id: object.id, title}));
  }
  assert.equal((await store.get(object.id)).title, 'Desk mount');
});


test('Done-only messages mark Works without a pass; undo and mixed requests still work', async t => {
  const classified = [];
  const {call, service, store} = await fixture(t, {reportsCompletion: async note => { classified.push(note); return note === 'DONE. mounted and working. thanks!!' ? 'works' : 'changes'; }});
  const project = await service.create('A mic mount');
  await service.start(project.id); await service.settled(project.id);
  const before = await store.get(project.id);
  const done = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'DONE. mounted and working. thanks!!'});
  assert.equal(done.status, 200);
  assert.equal(done.json.object.state, 'confirmed');
  assert.equal(done.json.object.passes.length, before.passes.length);
  assert.deepEqual(done.json.object.current, before.current);
  assert.equal(done.json.object.completion.note, 'DONE. mounted and working. thanks!!');
  assert.equal(done.json.object.completion.previousStatus, 'not-printed');
  await call('PATCH', `/v1/objects/${project.id}/settings`, {status: done.json.object.completion.previousStatus});
  assert.equal((await service.get(project.id)).state, 'ready');
  const changed = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'It works, but widen the flange'});
  assert.equal(changed.json.object.state, 'touching-up');
  await service.settled(project.id);
  assert.equal((await service.get(project.id)).passes.length, before.passes.length + 1);
  assert.deepEqual(classified, ['DONE. mounted and working. thanks!!', 'It works, but widen the flange']);
});


test('unavailable or uncertain classification saves the note without changing the model or starting a pass', async t => {
  for (const [index, reportsCompletion] of [async () => 'unknown', async () => { throw new Error('timed out'); }].entries()) {
    const {call, service, store} = await fixture(t, {reportsCompletion});
    const project = await service.create('A mic mount');
    await service.start(project.id); await service.settled(project.id);
    if (index === 1) await service.setStatus(project.id, 'works');
    const before = await store.get(project.id);
    const logged = t.mock.method(console, 'error', () => {});
    const reply = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'DONE. mounted and working. thanks!!'});
    logged.mock.restore();
    assert.equal(reply.status, 409);
    assert.match(reply.json.error.message, /message is saved/);
    if (index === 0) {
      assert.match(reply.json.error.message, /couldn't tell whether/, 'a real "unknown" answer is uncertainty');
      // Only the refusal itself is logged (Nov 6), never a "could not run" for a real answer.
      const lines = logged.mock.calls.map(call => String(call.arguments[0]));
      assert.deepEqual(lines.filter(line => !line.startsWith('http ')), []);
      assert.ok(lines.some(line => line.includes('/corrections refused: 409')), lines.join('\n'));
    } else {
      // Nov 4: a check that couldn't run (here a timeout) used to read as "couldn't tell" and left no trace.
      assert.match(reply.json.error.message, /AI couldn't check .*\(it took too long\)/);
      assert.match(String(logged.mock.calls[0].arguments[0]), new RegExp(`completion check for ${project.id} could not run: timed out`));
    }
    const after = await store.get(project.id);
    assert.equal(after.pendingFollowup, 'DONE. mounted and working. thanks!!');
    assert.equal(after.state, before.state);
    assert.deepEqual(after.current, before.current);
    assert.deepEqual(after.passes, before.passes);
    await service.setStatus(project.id, 'works');
    assert.equal((await store.get(project.id)).pendingFollowup, undefined);
    assert.equal((await store.get(project.id)).pendingMessageId, undefined);
    assert.equal((await store.get(project.id)).completion.messageId, after.messages[0].id);
  }
});

test('message photos stay with their follow-up and a finished-part photo does not start a pass', async t => {
  const {call, service, store} = await fixture(t, {reportsCompletion: async note => note === 'DONE' ? 'works' : 'changes'});
  const project = await service.create('A mount');
  await service.addPhoto(project.id, 'initial.jpg', Buffer.from('photo'));
  await service.start(project.id); await service.settled(project.id);
  await service.addPhoto(project.id, 'change.jpg', Buffer.from('photo'));
  await service.addPhoto(project.id, 'finished.jpg', Buffer.from('photo'));
  const change = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'Widen it', photoNames: ['change.jpg']});
  assert.equal(change.status, 200);
  await service.settled(project.id);
  const before = await store.get(project.id);
  assert.deepEqual(before.requestPhotos, ['initial.jpg']);
  assert.deepEqual(before.passes.at(-1).photos, ['change.jpg']);
  assert.deepEqual(before.pendingPhotos, ['finished.jpg']);
  const done = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'DONE', photoNames: ['finished.jpg']});
  assert.equal(done.status, 200);
  assert.equal(done.json.object.state, 'confirmed');
  assert.deepEqual(done.json.object.current, before.current);
  assert.equal(done.json.object.passes.length, before.passes.length);
  assert.deepEqual(done.json.object.messages.map(message => [message.text, message.photos]), [['Widen it', ['change.jpg']], ['DONE', ['finished.jpg']]]);
  assert.equal(done.json.object.completion.messageId, done.json.object.messages.at(-1).id);
});

test('uncertain message retries preserve photo ownership and message identity', async t => {
  let intent = 'unknown';
  const {call, service, store} = await fixture(t, {reportsCompletion: async () => intent});
  const project = await service.create('A mount');
  await service.start(project.id); await service.settled(project.id);
  await service.addPhoto(project.id, 'finished.jpg', Buffer.from('photo'));
  assert.equal((await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'DONE'})).status, 409);
  const saved = await store.get(project.id);
  await service.addPhoto(project.id, 'next-change.jpg', Buffer.from('photo'));
  intent = 'works';
  const done = await call('POST', `/v1/objects/${project.id}/corrections`, {note: 'DONE'});
  assert.equal(done.status, 200);
  assert.equal(done.json.object.messages.length, 1);
  assert.equal(done.json.object.messages[0].id, saved.messages[0].id);
  assert.deepEqual(done.json.object.messages[0].photos, ['finished.jpg']);
  assert.deepEqual(done.json.object.pendingPhotos, ['next-change.jpg'], 'retry must not claim a later message’s upload');
});

test('Mac local photo evidence is copied and attached before marking Done without a pass', async t => {
  const {service, store} = await fixture(t, {reportsCompletion: async () => 'works'});
  const project = await service.create('A mount');
  await service.start(project.id); await service.settled(project.id);
  const before = await store.get(project.id);
  const evidence = join(store.dir(project.id), 'finished.jpg');
  await writeFile(evidence, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  const done = await service.correct(project.id, 'DONE', [evidence]);
  assert.equal(done.state, 'confirmed');
  assert.equal(done.passes.length, before.passes.length);
  assert.deepEqual(done.current, before.current);
  assert.deepEqual(done.messages[0].photos, ['finished.jpg']);
});


test('Ask photo selection is validated before consuming the question through HTTP and local control', async t => {
  const {call, service, store} = await fixture(t);
  const dispatch = createControlDispatcher({objects: service});
  for (const local of [false, true]) {
    const object = await service.create('A mount', 'fit');
    await store.update(object.id, o => ({...o, state: 'needs-closeup', ask: {id: 'ask', question: 'Underside?', answers: ['photos'], status: 'open', askedAtMs: 1}}));
    await service.addPhoto(object.id, 'queued.jpg', Buffer.from('queue'));
    await service.addPhoto(object.id, 'answer.jpg', Buffer.from('answer'));
    const before = await store.get(object.id);
    if (local) {
      await assert.rejects(dispatch('objects.answerCloseup', {id: object.id, bestGuess: false, photoNames: ['missing.jpg']}), /not in this project/);
      await assert.rejects(dispatch('objects.answerCloseup', {id: object.id, bestGuess: false, photoNames: [4]}));
    } else {
      assert.equal((await call('POST', `/v1/objects/${object.id}/closeup`, {photoNames: ['missing.jpg']})).status, 409);
      assert.equal((await call('POST', `/v1/objects/${object.id}/closeup`, {photoNames: [4]})).status, 400);
    }
    assert.deepEqual(await store.get(object.id), before);
    if (local) await dispatch('objects.answerCloseup', {id: object.id, bestGuess: false, photoNames: ['answer.jpg']});
    else assert.equal((await call('POST', `/v1/objects/${object.id}/closeup`, {photoNames: ['answer.jpg']})).status, 200);
    const after = await service.settled(object.id);
    assert.deepEqual(after.messages.at(-1).photos, ['answer.jpg']);
    assert.deepEqual(after.pendingPhotos, ['queued.jpg']);
  }
});


test('local photo upload returns its exact renamed receipt without selecting other pending evidence', async t => {
  const {service, store} = await fixture(t);
  const dispatch = createControlDispatcher({objects: service});
  const project = await service.create('A mount', 'fit');
  await store.update(project.id, o => ({...o, state: 'needs-closeup', ask: {id: 'ask', question: 'Underside?', answers: ['photos'], status: 'open', askedAtMs: 1}}));
  await service.addPhoto(project.id, 'answer.jpg', Buffer.from('other message'));
  await service.addPhoto(project.id, 'queued.jpg', Buffer.from('queued'));
  const local = join(store.dir(project.id), 'answer.jpg');
  await writeFile(local, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  const uploaded = await dispatch('objects.addFile', {id: project.id, kind: 'photos', path: local});
  assert.equal(uploaded.photoName, 'answer-2.jpg');
  await service.addPhoto(project.id, 'later.jpg', Buffer.from('later'));
  await dispatch('objects.answerCloseup', {id: project.id, bestGuess: false, photoNames: [uploaded.photoName]});
  const after = await service.settled(project.id);
  assert.deepEqual(after.messages.at(-1).photos, ['answer-2.jpg']);
  assert.deepEqual(after.pendingPhotos, ['answer.jpg', 'queued.jpg', 'later.jpg']);
});


test('HTTP and local photo uploads preserve explicit message intent after an initial failure', async t => {
  const {call, service, store} = await fixture(t);
  const dispatch = createControlDispatcher({objects: service});
  for (const local of [false, true]) {
    const project = await service.create('A mount', 'fit');
    await store.update(project.id, o => ({...o, state: 'failed', failure: 'Initial work failed'}));
    if (local) {
      const file = join(store.dir(project.id), 'queued.jpg');
      await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
      const receipt = await dispatch('objects.addFile', {id: project.id, kind: 'photos', path: file, forMessage: true});
      assert.equal(receipt.photoName, 'queued.jpg');
      await dispatch('objects.addFile', {id: project.id, kind: 'photos', path: file});
    } else {
      assert.equal((await call('POST', `/v1/objects/${project.id}/photos?name=queued.jpg&forMessage=true`, Buffer.from('queue'), 'image/jpeg')).status, 200);
      assert.equal((await call('POST', `/v1/objects/${project.id}/photos?name=retry.jpg`, Buffer.from('retry'), 'image/jpeg')).status, 200);
      assert.equal((await call('POST', `/v1/objects/${project.id}/photos?name=invalid.jpg&forMessage=yes`, Buffer.from('bad'), 'image/jpeg')).status, 400);
    }
    const after = await store.get(project.id);
    assert.deepEqual(after.pendingPhotos, ['queued.jpg']);
    assert.deepEqual(after.requestPhotos, [local ? 'queued-2.jpg' : 'retry.jpg']);
  }
});

test('printer and printing-project metadata reads never start camera work without a viewer', async t => {
  let snapshots = 0;
  const frame = {bytes: Buffer.from([0xff, 0xd8, 0xff]), capturedAt: new Date().toISOString()};
  const session = {config: {selection: {model: 'p1s'}}};
  const camera = {warm: () => { snapshots++; }, frame: async () => { snapshots++; return frame; }, close: () => {}};
  const printers = {list: () => ({destinations: [{id: 'current', capabilities: {camera: 'bambu-tcp'}}]}), session: () => session};
  const printerCatalog = {canonical: id => id, destinations: [], defaultDestinationId: 'current'};
  const {service, store, call} = await fixture(t, {camera, printers, printerCatalog});
  const project = await service.create('A mount');
  await store.update(project.id, o => ({...o, state: 'printing', print: {destinationId: 'current'}}));
  assert.equal((await call('GET', '/v1/objects/printers')).status, 200);
  assert.equal((await call('GET', `/v1/objects/${project.id}`)).status, 200);
  assert.equal(snapshots, 0, 'status and event refreshes are not camera viewers');
  assert.equal((await call('GET', '/v1/objects/printers/current/camera.jpg')).status, 200);
  assert.equal(snapshots, 1, 'an explicit camera request still obtains a frame');
});

test('project preferences persist across both transports without starting work', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create('A mount', 'fit');
  const defaults = {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}, copies: 3};
  const saved = await call('PATCH', `/v1/objects/${project.id}/settings`, {printDefaults: defaults, designEngine: 'blender', notifications: 'problems'});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.settings.printDefaults, defaults);
  assert.equal(saved.json.object.state, 'new');
  assert.equal(saved.json.object.passes.length, 0);
  const dispatch = createControlDispatcher({objects: service});
  assert.equal((await dispatch('objects.settings.get', {id: project.id})).settings.designEngine, 'blender');
  await dispatch('objects.settings.set', {id: project.id, notifications: 'all'});
  assert.deepEqual((await store.get(project.id)).preferences, {printDefaults: defaults, designEngine: 'blender', notifications: 'all'});
  const before = await store.get(project.id);
  assert.equal((await call('PATCH', `/v1/objects/${project.id}/settings`, {title: 'Must not save', printerDestinationId: 'missing'})).status, 409);
  assert.deepEqual(await store.get(project.id), before, 'invalid printer does not partially rename or save defaults');
  assert.equal((await call('PATCH', `/v1/objects/${project.id}/settings`, {printDefaults: {copies: 0}})).status, 400);
  assert.equal((await call('PATCH', `/v1/objects/${project.id}/settings`, {unexpected: true})).status, 400);
});

test('a duplicate never inherits the last print\'s layer pauses as a default', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create('A magnet box', 'fit');
  await service.start(project.id); await service.settled(project.id);
  await store.update(project.id, o => ({...o, print: {bundleId: 'b', settings: {quality: 'fine', pauseBeforeLayers: [12]}}}));
  const copied = (await call('POST', `/v1/objects/${project.id}/duplicate`, {})).json.object;
  assert.equal(copied.preferences.printDefaults.quality, 'fine');
  assert.equal(copied.preferences.printDefaults.pauseBeforeLayers, undefined, 'a hidden stop would close the cavities on a print that shows none');
});

test('duplicate copies the current model and defaults, never the source outcome or active work', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create('A mount', 'copy');
  // A copy has something it copies (here, its scan); a request alone would be a new design.
  await mkdir(join(store.dir(project.id), 'scan'), {recursive: true});
  await writeFile(join(store.dir(project.id), 'scan', 'scan.usdz'), 'the scanned mount');
  await store.update(project.id, o => ({...o, scan: 'scan.usdz'}));
  await service.start(project.id); await service.settled(project.id);
  await service.setProjectSettings(project.id, {title: 'Original mount', status: 'works', archived: true,
    printDefaults: {quality: 'fine', copies: 2}, notifications: 'problems', designEngine: 'blender'});
  await writeFile(join(store.dir(project.id), 'current', 'design.f3d'), 'editable Fusion design');
  await writeFile(join(store.dir(project.id), 'current', 'parameters.json'), '{}');
  await store.update(project.id, o => ({...o, current: {...o.current, design: {f3d: 'current/design.f3d', parameters: 'current/parameters.json'}}}));
  const source = await store.get(project.id);
  const result = await call('POST', `/v1/objects/${project.id}/duplicate`, {});
  assert.equal(result.status, 200);
  const copied = result.json.object;
  assert.notEqual(copied.id, source.id);
  assert.equal(copied.title, 'Original mount copy');
  assert.equal(copied.state, 'ready');
  assert.equal(copied.kind, 'copy');
  assert.equal(copied.scan, 'scan.usdz', 'a copy keeps the scan it copies');
  assert.equal(await readFile(join(store.dir(copied.id), 'scan', 'scan.usdz'), 'utf8'), 'the scanned mount');
  assert.equal(copied.settings.status, 'not-printed');
  assert.equal(copied.settings.archived, false);
  assert.deepEqual(copied.preferences, source.preferences);
  assert.deepEqual(copied.passes, []);
  assert.equal(copied.print, undefined);
  assert.equal(copied.pendingFollowup, undefined);
  const originalPath = join(store.dir(source.id), source.current.model), copyPath = join(store.dir(copied.id), copied.current.model);
  const originalBytes = await readFile(originalPath);
  assert.deepEqual(await readFile(copyPath), originalBytes);
  assert.equal(await readFile(join(store.dir(copied.id), copied.current.design.f3d), 'utf8'), 'editable Fusion design');
  await writeFile(copyPath, 'changed independently');
  assert.deepEqual(await readFile(originalPath), originalBytes);
  assert.deepEqual(await store.get(source.id), source);
});


test('original model export reads only recorded model files with read authorization', async t => {
  const {call, service, store, scopes} = await fixture(t);
  const project = await service.create('Published model');
  await mkdir(join(store.dir(project.id), 'original'), {recursive: true});
  await writeFile(join(store.dir(project.id), 'original', 'part.3mf'), 'original designer model');
  await store.update(project.id, o => ({...o, files: {original: ['original/part.3mf', '../private.stl', '/private.stl', 'object.json']}}));
  const response = await call('GET', `/v1/objects/${project.id}/original/0`);
  assert.equal(response.status, 200);
  assert.equal(response.type, 'model/3mf');
  assert.equal(response.bytes.toString(), 'original designer model');
  assert.equal(scopes.at(-1), 'projects:read');
  for (const index of [1, 2, 3, 4, 999999999999999999999]) {
    assert.equal((await call('GET', `/v1/objects/${project.id}/original/${index}`)).status, 404);
  }
  const denied = await fixture(t, {denied: ['projects:read']});
  assert.equal((await denied.call('GET', `/v1/objects/${project.id}/original/0`)).status, 403);
});

test('a duplicated fit project keeps how its size is settled, whichever way the source stored it', async t => {
  const {call, service, store} = await fixture(t);
  const fit = {sizeSource: 'measured', measured: [{id: 'a', label: 'width at the waist', mm: 53}, {id: 'b', label: 'height to the cap tip', mm: 107}]};
  const fields = await service.create('A pegboard holder for this bottle.', 'fit', undefined, fit);
  const legacy = await service.create('A pegboard holder for this bottle.', 'fit');
  for (const project of [fields, legacy]) { await service.start(project.id); await service.settled(project.id); }
  // A project from before the field: the request with the block a client appended.
  const worker = workerRequest(await store.get(fields.id));
  await store.update(legacy.id, o => ({...o, instructions: worker}));
  for (const project of [fields, legacy]) {
    const copied = (await call('POST', `/v1/objects/${project.id}/duplicate`, {})).json.object;
    assert.equal(copied.instructions, 'A pegboard holder for this bottle.');
    assert.deepEqual(copied.fit, project === fields ? fit : splitFitBrief(worker).fit);
    const stored = await store.get(copied.id);
    assert.equal(stored.instructions, 'A pegboard holder for this bottle.', 'the copy is stored as fields');
    // A change asked of the copy is designed from the same brief as the source, after what was said there.
    const request = workerRequest(stored);
    assert.ok(request.endsWith(`\n\n${worker}`), request);
    assert.match(request, /^What was asked and answered for the project this came from: “A pegboard holder/);
    assert.deepEqual(stored.inherited.fit, copied.fit, 'the sizes travel as measured, not as the person\'s words');
  }
});

test('duplicate keeps legacy print defaults and removes only its own partial copy on failure', async t => {
  const {service, store} = await fixture(t);
  const project = await service.create('Legacy project', 'fit');
  await service.start(project.id); await service.settled(project.id);
  await store.update(project.id, o => ({...o, print: {bundleId: 'old', settings: {quality: 'fine', copies: 1}}}));
  const duplicate = await service.duplicate(project.id);
  assert.deepEqual(duplicate.preferences.printDefaults, {quality: 'fine', copies: 1});
  assert.equal(duplicate.print, undefined);
  await store.update(project.id, o => ({...o, current: {...o.current, renders: ['missing.png']}}));
  const before = await store.list();
  await assert.rejects(service.duplicate(project.id));
  assert.deepEqual(await store.list(), before);
});


test('exports refuse recorded final and intermediate symlinks that leave the project', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create('Private exports');
  const outside = await tempDir('outside-project-');
  await writeFile(join(outside, 'secret.3mf'), 'private');
  await writeFile(join(outside, 'scan.usdz'), 'private scan');
  await mkdir(join(store.dir(project.id), 'original'), {recursive: true});
  await mkdir(join(store.dir(project.id), 'scan'), {recursive: true});
  await symlink(join(outside, 'secret.3mf'), join(store.dir(project.id), 'original', 'linked.3mf'));
  await symlink(outside, join(store.dir(project.id), 'external'));
  await symlink(join(outside, 'scan.usdz'), join(store.dir(project.id), 'scan', 'scan.usdz'));
  await store.update(project.id, o => ({...o, scan: 'scan.usdz', files: {original: ['original/linked.3mf', 'external/secret.3mf']}}));
  for (const file of ['original/0', 'original/1', 'scan/scan.usdz']) {
    assert.equal((await call('GET', `/v1/objects/${project.id}/${file}`)).status, 404);
  }
});


// Nov 10: every "What you scanned" on David's phone was blank. A full-detail rebuild (192 MB) was refused with 413 and the
// phone had nothing else to draw. The project says which scan files there are and how big; the phone's own model kept
// beside a rebuild is served; over the limit nothing is read; and a file is streamed, not read whole first.
test('the project lists its scan files and their sizes, serves the phone\'s own model, and refuses an oversized scan unread', async t => {
  const {call, service, store} = await fixture(t);
  const project = await service.create('Copy this bottle', 'copy');
  const dir = join(store.dir(project.id), 'scan');
  await mkdir(dir, {recursive: true});
  const preview = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  await writeFile(join(dir, 'phone-preview.usdz'), preview);
  // A sparse file: 65 MB on paper, nothing on disk, so the test stays fast.
  const big = await open(join(dir, 'scan.usdz'), 'w'); await big.truncate(65 * 1024 * 1024); await big.close();
  await store.update(project.id, o => ({...o, scan: 'scan.usdz', scanSource: 'mac'}));
  const listed = (await call('GET', `/v1/objects/${project.id}`)).json.object;
  assert.deepEqual(listed.scanFiles, [{name: 'scan.usdz', bytes: 65 * 1024 * 1024}, {name: 'phone-preview.usdz', bytes: preview.length}]);
  assert.deepEqual((await call('GET', '/v1/objects')).json.objects.find(o => o.id === project.id).scanFiles, listed.scanFiles, 'the list says the same');
  const served = await call('GET', `/v1/objects/${project.id}/scan/phone-preview.usdz`);
  assert.equal(served.status, 200);
  assert.equal(served.type, 'model/vnd.usdz+zip');
  assert.ok(served.bytes.equals(preview), 'the whole file, streamed');
  assert.equal((await call('GET', `/v1/objects/${project.id}/scan/scan.usdz`)).status, 413, 'over 64 MB: refused before a byte is read');
  assert.equal((await call('GET', `/v1/objects/${project.id}/scan/other.usdz`)).status, 404, 'only the files the project lists');
  // The rebuild replaced by a smaller one, and the preview gone: the list follows the files.
  await writeFile(join(dir, 'scan.usdz'), Buffer.alloc(1024, 1));
  await rm(join(dir, 'phone-preview.usdz'));
  assert.deepEqual((await call('GET', `/v1/objects/${project.id}`)).json.object.scanFiles, [{name: 'scan.usdz', bytes: 1024}]);
  assert.equal((await call('GET', `/v1/objects/${project.id}/scan/phone-preview.usdz`)).status, 404);
});

test('saved project engine reaches the next worker and copies reject Fusion', async t => {
  const {service, inputs, store} = await fixture(t);
  const fit = await service.create('A clip', 'fit');
  await service.setProjectSettings(fit.id, {designEngine: 'blender'});
  await service.start(fit.id); await service.settled(fit.id);
  assert.equal(inputs[0].preferredEngine, 'blender');
  const copy = await service.create('Copy the clip', 'copy');
  await store.update(copy.id, o => ({...o, scan: 'scan.usdz'}));
  await assert.rejects(service.setProjectSettings(copy.id, {designEngine: 'fusion'}), /cleaned up by the code design engine, or Blender without it/);
  // Nothing scanned: the request is a new design, which may use Fusion.
  const unscanned = await service.create('A guitar pick that says Vivi', 'copy');
  await service.setProjectSettings(unscanned.id, {designEngine: 'fusion'});
});


test('duplicate inherits historical colour only for the same effective printer', async t => {
  const printerCatalog = {defaultDestinationId: 'printer-b', canonical: id => id === 'old-b-alias' ? 'printer-b' : id, destinations: []};
  const {service, store, call} = await fixture(t, {printerCatalog});
  const project = await service.create('Legacy defaults', 'fit');
  await service.start(project.id); await service.settled(project.id);
  const independent = {quality: 'fine', strength: 'strong', copies: 2};
  const history = {...independent, colour: {amsSlot: 3}};
  const cases = [
    {name: 'changed printer', chosen: 'printer-b', previous: {destinationId: 'printer-a'}, expected: independent},
    {name: 'changed default printer', previous: {destinationId: 'printer-a'}, expected: independent},
    {name: 'same selected printer', chosen: 'printer-a', previous: {destinationId: 'printer-a'}, expected: history},
    {name: 'same default printer', previous: {destinationId: 'printer-b'}, expected: history},
    {name: 'legacy destination and canonical alias', previous: {destination: {id: 'old-b-alias'}}, expected: history},
    {name: 'unknown historical printer', expected: independent},
    {name: 'explicit profile colour', previous: {destinationId: 'printer-b'}, saved: independent, expected: independent},
    {name: 'explicit empty defaults', previous: {destinationId: 'printer-b'}, saved: {}, expected: {}},
    {name: 'explicit colour for new printer', previous: {destinationId: 'printer-a'}, saved: {colour: {amsSlot: 1}}, expected: {colour: {amsSlot: 1}}},
  ];
  for (const item of cases) {
    await store.update(project.id, o => ({...o, printerDestinationId: item.chosen,
      preferences: item.saved === undefined ? undefined : {printDefaults: item.saved},
      print: {bundleId: 'old', ...item.previous, settings: history}}));
    const before = await store.get(project.id);
    const response = await call('POST', `/v1/objects/${project.id}/duplicate`, {});
    assert.equal(response.status, 200, item.name);
    assert.deepEqual(response.json.object.preferences.printDefaults, item.expected, item.name);
    assert.deepEqual(await store.get(project.id), before, 'duplicating does not rewrite the source history');
  }
});

test('phone plate selection stays authorized and exposes all retained plates', async t => {
  // A printer whose MCP lists the file's plates (list_3mf_plates).
  const f=await fixture(t, {print: {services: {runner: {backend: 'bambu-printer-mcp', modelPlates: mcpPlates, runBundle: async () => { throw Error('unused'); }}}}});
  const {createRequire}=await import('node:module');
  const {zipSync,strToU8}=createRequire(new URL('../../printer-handoff/package.json',import.meta.url))('fflate');
  const bytes=Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types/>'),
    '3D/3dmodel.model':strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config':strToU8('<config><plate><metadata key="plater_id" value="1"/></plate><plate><metadata key="plater_id" value="2"/></plate></config>')}));
  const object=await f.service.create('Platform','published','https://makerworld.com/en/models/1531561');
  await f.service.addModelFile(object.id,'platform.3mf',bytes);
  const result=await f.call('POST',`/v1/objects/${object.id}/plate-selection`,{fileIndex:0,plateIndex:1});
  assert.equal(result.status,200);
  assert.equal(result.json.object.publishedSelection.plateIndex,1);
  assert.equal(result.json.object.plates.length,2);
  assert.deepEqual(f.scopes,['captures:import']);
  assert.equal((await f.call('POST',`/v1/objects/${object.id}/plate-selection`,{fileIndex:0,plateIndex:-1})).status,400);
  assert.equal((await f.call('POST',`/v1/objects/${object.id}/plate-selection`,{fileIndex:0,plateIndex:1,id:object.id})).status,400);
  assert.equal((await f.call('POST',`/v1/objects/${object.id}/plate-selection`,{fileIndex:0,plateIndex:8})).status,409);
});
