import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService} from '../dist/objects/service.js';
import {createObjectRoutes} from '../dist/objects/http.js';

const STL = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';

async function fixture(t, {denied = []} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-http-'));
  const store = new ObjectStore(join(root, 'objects'));
  const runTouchup = async () => {
    const out = join(root, 'pass', 'out'); await mkdir(out, {recursive: true});
    await writeFile(join(out, 'touched.stl'), STL); await writeFile(join(out, 'front.png'), 'png');
    return {status: 'done', summary: 'Fixed.', model: join(out, 'touched.stl'), renders: [join(out, 'front.png')], checkpoints: [], stats: {seconds: 1, toolCalls: 1}, passDir: join(root, 'pass')};
  };
  const service = new ObjectService({store, runTouchup, stlInfo: async () => [60.6, 45.2, 21.7], claudePath: '/c', handoff: {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}}});
  const routes = createObjectRoutes(service);
  const scopes = [];
  const server = createServer(async (request, response) => {
    const authorize = async scope => { scopes.push(scope); if (denied.includes(scope)) { const e = new Error('forbidden'); e.name = 'RemoteAuthFailure'; throw e; } };
    try { await routes.handle(request, response, authorize, name => request.headers[name]); }
    catch (error) { response.statusCode = error.name === 'RemoteAuthFailure' ? 403 : 500; response.end(JSON.stringify({error: {code: String(error.message)}})); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, type = 'application/json') => {
    const response = await fetch(base + path, {method, ...(body !== undefined ? {body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers: {'content-type': type}} : {})});
    const bytes = Buffer.from(await response.arrayBuffer());
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    return {status: response.status, json, bytes};
  };
  return {call, scopes, service, store};
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

test('the plate photo downloads only while the plate check is waiting', async t => {
  const {call, store} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  assert.equal((await call('GET', `/v1/objects/${id}/plate.jpg`)).status, 404);
  await writeFile(join(store.dir(id), 'plate.jpg'), 'jpeg');
  await store.update(id, o => ({...o, state: 'printing', plate: {item: 'a spool', photo: true}}));
  const photo = await call('GET', `/v1/objects/${id}/plate.jpg`);
  assert.equal(photo.status, 200);
  assert.equal(photo.bytes.toString(), 'jpeg');
});

test('printing again after an uncertain print says the user checked', async t => {
  const {call, store} = await fixture(t);
  const id = (await call('POST', '/v1/objects', {})).json.object.id;
  await store.update(id, o => ({...o, state: 'failed', current: {model: 'current/model.stl', renders: []}, print: {bundleId: 'b', uncertain: true}}));
  const refused = await call('POST', `/v1/objects/${id}/print`);
  assert.equal(refused.status, 409);
  assert.match(refused.json.error.message, /Check the printer/);
});
