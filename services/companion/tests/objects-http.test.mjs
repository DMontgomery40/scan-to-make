import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function fixture(t, {denied = [], reconstruct} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-http-'));
  const store = new ObjectStore(join(root, 'objects'));
  const runTouchup = async () => {
    const out = join(root, 'pass', 'out'); await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL); await writeFile(join(out, 'front.png'), 'png');
    return {status: 'done', summary: 'Fixed.', model: join(out, 'touched.stl'), renders: [join(out, 'front.png')], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(root, 'pass')};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}, ...(reconstruct ? {reconstruct} : {})});
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
    const response = await fetch(base + path, {method, headers: {'content-type': type, 'x-test-device': device}, ...(body !== undefined ? {body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)} : {})});
    const bytes = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    return {status: response.status, json, bytes, type: response.headers.get('content-type')};
  };
  return {call, scopes, devices, service, store};
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
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
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

test('scan, photos, start, then the ready model and renders download', async t => {
  const {call, service} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  assert.equal((await call('PUT', `/v1/objects/${id}/scan`, Buffer.from('usdz'), 'model/vnd.usdz+zip')).status, 200);
  assert.equal((await call('POST', `/v1/objects/${id}/photos?name=IMG_0001.HEIC`, Buffer.from('heic'), 'image/heic')).status, 200);
  const started = await call('POST', `/v1/objects/${id}/start`);
  assert.equal(started.json.object.state, 'touching-up');
  await service.settled(id);
  const ready = (await call('GET', `/v1/objects/${id}`)).json.object;
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.current.sizeMm, [60.6, 45.2, 21.7]);
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

test('DELETE removes an object', async t => {
  const {call} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {instructions: 'A hook.'})).json.object.id;
  const deleted = await call('DELETE', `/v1/objects/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal((await call('GET', `/v1/objects/${id}`)).status, 404);
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
