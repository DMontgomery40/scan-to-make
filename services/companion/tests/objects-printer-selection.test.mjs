import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {HandoffBundleStore, InMemoryElicitationRelay} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {createObjectRoutes, publicObject} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {showing, showingRunner} from './support/shown-print.mjs';
import {tempDir} from './support/temp.mjs';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']};
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('timed out'); };

async function fixture(t, {printers} = {}) {
  const root = await tempDir('object-printers-');
  t.after(() => rm(root, {recursive: true, force: true}));
  const current = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/ssh', args: ['retained-route'], env: {TOKEN: 'private-current-token'}}};
  const second = {backend: 'mcp-3d-printer-server', process: {command: '/absolute/other-mcp', args: ['serve'], env: {API_KEY: 'private-other-key'}}, selection: {host: 'second.local'}};
  const destinations = [
    {id: 'current', name: 'Current printer', backend: current.backend, source: 'current'},
    {id: 'second', name: 'Other printer', backend: second.backend, source: 'mcp-profile', address: 'second.local'},
  ];
  const catalog = {destinations, defaultDestinationId: 'current', resolve: id => id === 'current' ? structuredClone(current) : id === 'second' ? structuredClone(second) : undefined,
    canonical: id => ['current', 'second'].includes(id) ? id : undefined};
  const calls = [], answers = [], routes = new Map();
  for (const destination of destinations) {
    const config = catalog.resolve(destination.id), relay = new InMemoryElicitationRelay({timeoutMs: 2000});
    routes.set(destination.id, {store: new HandoffBundleStore(join(root, 'bundles')), relay, selection: config.selection,
      runner: showingRunner({backend: config.backend, runBundle: async (bundles, id, options = {}) => {
        const bundle = await bundles.read(id);
        calls.push({destination: destination.id, backend: bundle.backend, selection: bundle.selection, ...(options.slicer ? {slicer: options.slicer} : {})});
        const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'Check the selected printer.', requestedSchema: CONFIRM}}, {bundleId: id});
        answers.push({destination: destination.id, answer});
        if (answer.action !== 'accept') throw new Error('declined');
        return {bundleId: id};
      }})});
  }
  const store = new ObjectStore(join(root, 'objects'));
  const service = showing(new ObjectService({store, handoff: current, printerCatalog: catalog, claudePath: '/unused', ...(printers ? {printers} : {}),
    runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined,
    print: {services: routes.get('current'), destinations: routes}}));
  t.after(() => service.close());
  const object = await service.create('A hook.');
  await mkdir(join(store.dir(object.id), 'current'));
  await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  return {service, store, object, calls, answers, catalog, routes};
}

test('selected printer dispatches through its own runner and confirmation relay; a running job cannot be retargeted', async t => {
  const {service, store, object, calls, answers} = await fixture(t);
  await service.selectPrinter(object.id, 'second');
  const printing = await service.print(object.id);
  assert.deepEqual(printing.print.destination, {id: 'second', name: 'Other printer'});
  await until(async () => (await service.get(object.id)).printConfirmation);
  await assert.rejects(service.selectPrinter(object.id, 'current'), InvalidStateError);
  await service.answerPrintConfirmation(object.id, (await service.get(object.id)).printConfirmation.id, {action: 'accept', content: {confirmed: true}});
  const finished = await service.settled(object.id);
  assert.equal(finished.state, 'sent'); // A fake printer reports nothing: dispatched, not proven printed.
  assert.deepEqual(calls, [{destination: 'second', backend: 'mcp-3d-printer-server', selection: {host: 'second.local'}}]);
  assert.equal(answers[0].destination, 'second');
  assert.equal(answers[0].answer.action, 'accept');
  assert.deepEqual(finished.print.destination, printing.print.destination);
  assert.equal((await store.get(object.id)).printerDestinationId, 'second');
  await service.selectPrinter(object.id, 'current');
  await service.print(object.id, {checked: true});
  await until(async () => (await service.get(object.id)).printConfirmation);
  await service.answerPrintConfirmation(object.id, (await service.get(object.id)).printConfirmation.id, {action: 'accept', content: {confirmed: true}});
  await service.settled(object.id);
  assert.deepEqual(calls.map(call => call.destination), ['second', 'current']);
});

test('phone and Mac confirmation answers use the selected destination and reject legacy or stale approval', async t => {
  const {service, object, answers} = await fixture(t);
  await service.selectPrinter(object.id, 'second');
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  await dispatch('objects.print', {id: object.id});
  await until(async () => (await service.get(object.id)).printConfirmation);
  const question = (await dispatch('objects.get', {id: object.id})).object.printConfirmation;
  assert.equal(question.message, 'Check the selected printer.');
  // There is no plate answer any more (PRD §5.6).
  await assert.rejects(dispatch('objects.answerPlate', {id: object.id}));
  await assert.rejects(dispatch('objects.answerPrintConfirmation', {id: object.id, confirmationId: '00000000-0000-4000-8000-000000000001', answer: {action: 'accept', content: {confirmed: true}}}), error => error.code === 'conflict');
  await dispatch('objects.answerPrintConfirmation', {id: object.id, confirmationId: question.id, answer: {action: 'accept', content: {confirmed: true}}});
  await service.settled(object.id);
  assert.equal(answers[0].destination, 'second');
  assert.deepEqual(answers[0].answer.content, {confirmed: true});

  await service.print(object.id, {checked: true});
  await until(async () => (await service.get(object.id)).printConfirmation);
  const next = (await service.get(object.id)).printConfirmation;
  const scopes = [], routes = createObjectRoutes(service);
  const server = createServer(async (request, response) => {
    try { await routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined); }
    catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/objects/${object.id}/print-confirmation`;
  const post = body => fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post({confirmationId: question.id, answer: {action: 'accept', content: {confirmed: true}}})).status, 409);
  // An answer that doesn't fit the question is refused with the field's reason.
  const extra = await post({confirmationId: next.id, answer: {action: 'accept', content: {confirmed: true, other: true}}});
  assert.equal(extra.status, 400);
  assert.match((await extra.json()).error.message, /"other" isn't part of the printer's question/);
  assert.equal(answers.length, 1);
  assert.equal((await post({confirmationId: next.id, answer: {action: 'cancel'}})).status, 200);
  assert.equal((await service.settled(object.id)).state, 'ready');
  assert.equal(answers[1].destination, 'second');
  assert.equal(answers[1].answer.action, 'cancel');
  assert.deepEqual(scopes, ['printer-handoff:use', 'printer-handoff:use', 'printer-handoff:use']);
});

test('unknown printers and changes during a touch-up are rejected without changing the selection', async t => {
  const {service, store, object} = await fixture(t);
  await assert.rejects(service.selectPrinter(object.id, 'unknown'), InvalidStateError);
  assert.equal((await service.get(object.id)).printerDestinationId, undefined);
  await store.update(object.id, o => ({...o, state: 'touching-up'}));
  await assert.rejects(service.selectPrinter(object.id, 'second'), InvalidStateError);
  assert.equal((await service.get(object.id)).printerDestinationId, undefined);
});

test('a printer without an inventory explains that material must be chosen in its slicer', async t => {
  const {service, object} = await fixture(t);
  await service.selectPrinter(object.id, 'second');
  await assert.rejects(service.filaments(object.id), /Open the model in your slicer/);
});

test('changing printer after an uncertain print preserves the original printer warning', async t => {
  const {service, store, object} = await fixture(t);
  await store.update(object.id, o => ({...o, state:'failed', print:{bundleId:'prior', uncertain:true, destination:{id:'current', name:'Current printer'}}}));
  const updated = await service.selectPrinter(object.id, 'second');
  assert.equal(updated.printerDestinationId, 'second');
  assert.deepEqual(updated.print.destination, {id:'current', name:'Current printer'});
  assert.equal(updated.print.uncertain, true);
  await assert.rejects(service.print(object.id), /Check the printer/);
});

test('the phone and local control expose the same destination ids without MCP configuration or credentials', async t => {
  const {service, object, catalog} = await fixture(t);
  catalog.destinations.find(d => d.id === 'second').aliases = ['old-duplicate'];
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: service});
  assert.deepEqual(await dispatch('objects.printers', {}), {destinations: catalog.destinations, defaultDestinationId: 'current'});
  assert.equal((await dispatch('objects.selectPrinter', {id: object.id, destinationId: 'second'})).object.printerDestinationId, 'second');
  await assert.rejects(dispatch('objects.selectPrinter', {id: object.id, destinationId: 'missing'}), error => error.code === 'conflict');
  const scopes = [], routes = createObjectRoutes(service);
  const server = createServer(async (request, response) => {
    try { await routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined); }
    catch { response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects`;
  const list = await fetch(`${base}/printers`);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {destinations: catalog.destinations, defaultDestinationId: 'current'});
  const selected = await fetch(`${base}/${object.id}/printer`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({destinationId: 'current'})});
  assert.equal(selected.status, 200);
  assert.equal((await selected.json()).object.printerDestinationId, 'current');
  assert.deepEqual(scopes, ['projects:read', 'printer-handoff:use']);
  const publicData = JSON.stringify({catalog: await service.printers(), object: publicObject(await service.get(object.id))});
  for (const privateValue of ['private-current-token', 'private-other-key', '/usr/bin/ssh', '/absolute/other-mcp', 'process', 'args']) assert.equal(publicData.includes(privateValue), false);
});

test('a print recorded against a destination that became a duplicate still reads its printer through the winner', async t => {
  // Each printer's last counterpart_print_progress report, as the printer directory keeps it.
  const printers = {lastReport: id => ({observedAt: new Date().toISOString(), state: 'printing', job: {name: `job on ${id}`, progress: 10}, problems: [], source: 'counterpart'}),
    capabilities: () => undefined, session: () => undefined, record() {}, refresh: async () => {}, printing: async () => false, list: () => ({destinations: []})};
  const {service, store, object, catalog} = await fixture(t, {printers});
  catalog.canonical = id => id === 'old-duplicate' ? 'second' : ['current', 'second'].includes(id) ? id : undefined;
  await store.update(object.id, o => ({...o, state: 'printing', print: {bundleId: '00000000-0000-4000-8000-000000000001', destination: {id: 'old-duplicate', name: 'Old'}}}));
  const loaded = await service.get(object.id);
  assert.equal(loaded.print.printerStatus.job, 'job on second');
  assert.equal(loaded.print.destination.id, 'old-duplicate', 'history is not rewritten');
});

test('on mcp-3D-printer-server the chosen material is sliced with the profile its filament report gives, or is the configured one', async t => {
  const {service, object, calls, routes} = await fixture(t);
  await service.selectPrinter(object.id, 'second');
  const answer = async () => {
    await until(async () => (await service.get(object.id)).printConfirmation);
    const question = (await service.get(object.id)).printConfirmation;
    await service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}});
    await service.settled(object.id);
  };
  // No profile for it and not the configured material: refused, never sliced with the preset's filament.
  await assert.rejects(service.print(object.id, {colour: {material: 'PETG'}}), /doesn't give a slicing profile for PETG on this printer.*Update mcp-3D-printer-server/);
  assert.equal(calls.length, 0);
  // The configured material needs no profile: the MCP's own preset is for it.
  routes.get('second').selection = {...routes.get('second').selection, material: 'PLA'};
  await service.print(object.id, {colour: {material: 'pla'}});
  await answer();
  assert.equal(calls.at(-1).selection.material, 'PLA');
  assert.equal(calls.at(-1).slicer, undefined);
  // A report with a profile for it: sliced with that profile.
  routes.get('second').runner.filaments = async () => ({slots: [{id: 'ext', material: 'PETG', profile: '/profiles/petg.ini', source: 'spoolman'}]});
  await service.print(object.id, {checked: true, colour: {material: 'petg'}});
  await answer();
  assert.deepEqual(calls.at(-1).slicer, {loadFilaments: '/profiles/petg.ini'});
});
