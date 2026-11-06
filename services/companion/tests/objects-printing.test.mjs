import {createRequire} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {HandoffBundleStore, InMemoryElicitationRelay, PrinterMcpError, PrinterSession} from '@scan-to-make/printer-handoff';
import {ObjectStore} from '../dist/objects/store.js';
import {ObjectService, InvalidStateError} from '../dist/objects/service.js';
import {PrinterDirectory} from '../dist/printing/directory.js';
import {CameraFrames} from '../dist/printing/camera.js';
import {CompanionSettingsStore} from '../dist/settings.js';
import {createObjectRoutes} from '../dist/objects/http.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {showing, showingRunner, shownSlice} from './support/shown-print.mjs';
import {createHash} from 'node:crypto';

const STL = Buffer.from('solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n' + ' '.repeat(40));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
const CONFIRM = {type: 'object', properties: {confirmed: {type: 'boolean'}}, required: ['confirmed']};
const JOB = 'checked-1b2c-sliced';
const tool = (name, properties = {}) => ({name, inputSchema: {type: 'object', properties}});
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async check => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out'); };

/**
 * A P1S behind a fake MCP session, a fake print runner, and a monitor clock the
 * test steps by hand: every printer report and every wait is scripted.
 */
async function setup(t, {tools = ['counterpart_printer_info', 'counterpart_print_progress', 'camera_snapshot', 'get_printer_filaments', 'pause_print', 'resume_print', 'cancel_print', 'slice_stl'], sliceArgs = false, copies = false, controlsRoute = false, reports = [], route, backend = 'bambu-printer-mcp', info, slots, controlEnds = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objects-printing-'));
  let service;
  t.after(async () => { await service?.close(); await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 20}); });
  const calls = [], events = [], runs = [];
  let endControl;
  const queue = [...reports];
  const relay = new InMemoryElicitationRelay({timeoutMs: 5000});
  // Copies come from the MCP's own capabilities.slicing (bambu-printer-mcp 1.1.58+), as the real servers report it.
  // Every capability comes from counterpart_printer_info (PRD §8.0 item 4): this is what bambu-printer-mcp answers for a P1S with an AMS.
  info ??= {contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.58'}, printer: {kind: 'bambu', host: '192.0.2.1'},
    capabilities: {progress: true, layers: true, camera: 'bambu-tcp', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true,
      ...(copies ? {slicing: {supports: true, copies: true, orient: true}} : {})}};
  const catalogTools = [...tools, ...(route ? ['counterpart_print_route'] : []), ...(info && !tools.includes('counterpart_printer_info') ? ['counterpart_printer_info'] : [])].map(name => name === 'slice_stl' && (sliceArgs || copies)
    ? tool(name, {...(sliceArgs ? {quality: {}, strength: {}, layer_height: {}, wall_loops: {}, sparse_infill_density: {}} : {}), ...(copies ? {repetitions: {}} : {})}) : tool(name, controlsRoute && ['cancel_print', 'pause_print', 'resume_print'].includes(name) ? {connection_mode: {}, connection_type: {}} : {}));
  const factory = () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.46'}, tools: catalogTools}; return this.catalog; },
    hasTool(name) { return catalogTools.some(item => item.name === name); },
    getTool(name) { return catalogTools.find(item => item.name === name); },
    async callTool(name, args, options = {}) {
      calls.push({name, args, context: options.elicitationContext, timeoutMs: options.timeoutMs});
      if (name === 'counterpart_print_progress') {
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw Object.assign(new Error('down'), {code: 'tool-failed'});
        const report = {contract: 'counterpart/1', observedAt: new Date().toISOString(), ...next};
        return {content: [{type: 'text', text: JSON.stringify(report)}], structuredContent: report};
      }
      if (name === 'camera_snapshot') return {content: [{type: 'text', text: JSON.stringify({format: 'jpeg', base64: JPEG.toString('base64')})}]};
      if (name === 'counterpart_printer_info' && info) return {content: [{type: 'text', text: JSON.stringify(info)}], structuredContent: info};
      if (name === 'get_printer_filaments' && slots) return {content: [{type: 'text', text: JSON.stringify({slots})}]};
      if (name === 'counterpart_print_route') {
        // As both MCPs answer since Nov 3: lan and cloud through FULU, developer straight to a Developer Mode printer.
        if (args?.route) route = args.route === 'cloud' ? {mode: 'bambu_network', type: 'cloud'} : args.route === 'developer' ? {mode: 'lan_mqtt_ftps', type: 'lan'} : {mode: 'bambu_network', type: 'lan'};
        const id = route.mode === 'lan_mqtt_ftps' ? 'developer' : route.mode === 'bambu_network' && route.type === 'cloud' ? 'cloud' : 'lan';
        const options = route.legacy ? undefined : [
          {id: 'lan', label: 'Local network', available: true, controls: 'Printers with authorization control refuse Pause, Resume and Stop sent this way.'},
          {id: 'cloud', label: 'Bambu Cloud', available: true, controls: 'Printers with authorization control refuse Pause, Resume and Stop sent this way.'},
          {id: 'developer', label: 'Local network, Developer Mode', available: true, controls: 'Pause, Resume and Stop go straight to the printer.'}];
        return {content: [{type: 'text', text: JSON.stringify({route: id, mode: route.mode, type: route.type,
          choices: route.legacy ? ['lan', 'cloud'] : ['lan', 'cloud', 'developer'], ...(options ? {options} : {}), savedTo: '/Users/x/bambu-printer-mcp/.env'})}]};
      }
      if (['pause_print', 'resume_print', 'cancel_print'].includes(name)) {
        if (controlEnds) {
          // The call ends (a client timeout) while its question is still open.
          relay.request({method: 'elicitation/create', params: {mode: 'form', message: `Confirm ${name}`, requestedSchema: CONFIRM}}, options.elicitationContext).catch(() => undefined);
          await new Promise(resolve => { endControl = resolve; });
          throw Object.assign(new Error('MCP error -32001: Request timed out'), {code: 'tool-failed'});
        }
        const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: `Confirm ${name}`, requestedSchema: CONFIRM}}, options.elicitationContext);
        if (answer.action !== 'accept') return {isError: true, content: [{type: 'text', text: 'Not confirmed. Nothing was sent.'}]};
        return {content: [{type: 'text', text: '{"status":"success"}'}]};
      }
      return {content: [{type: 'text', text: '{}'}]};
    },
    async close() {},
  });
  const config = {backend, process: {command: '/usr/bin/true'}, selection: {model: 'p1s', material: 'PLA'}};
  let directory;
  const session = new PrinterSession('current', config, {clientFactory: factory, relay, onConnect: catalog => directory?.connected('current', catalog)});
  const catalog = {defaultDestinationId: 'current', destinations: [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', source: 'current', origin: 'printer-handoff'}],
    resolve: id => id === 'current' ? structuredClone(config) : undefined, canonical: id => id === 'current' ? 'current' : undefined};
  directory = new PrinterDirectory(catalog, id => id === 'current' ? session : undefined);
  await session.connect();
  const bundles = new HandoffBundleStore(join(root, 'bundles'));
  const runner = {
    backend: 'bambu-printer-mcp', session,
    filaments: async () => ({trays: [
      {slot: 0, loaded: true, tray_color: '000000FF', tray_type: 'PETG', tray_info_idx: 'GFG00', resolved_profile_path: '/p/petg.json'},
      {slot: 1, loaded: true, tray_color: 'FEC600FF', tray_type: 'PLA', tray_info_idx: 'GFA00', resolved_profile_path: '/p/pla.json'},
      {slot: 254, loaded: true, tray_color: 'FFFFFFFF', tray_type: 'PLA', tray_info_idx: 'GFA00', resolved_profile_path: '/p/ext.json'}]}),
    estimate: async input => { runs.push({estimate: input}); return {estimate: {seconds: 3420, grams: 19.2}, settings: {layers: 183, layerHeightMm: input.slicer?.quality === 'fine' ? 0.12 : 0.2, infillPercent: 15, wallLoops: 2}}; }, // as the MCP's slice reports it
    runBundle: async (store, id, options = {}) => {
      runs.push({id, options, selection: (await store.read(id)).selection});
      for (const phase of ['slicing', 'checking-printer']) await options.onProgress?.({phase});
      await options.beforePrint?.();
      const answer = await relay.request({method: 'elicitation/create', params: {mode: 'form', message: 'Printer: P1S. Plate clear?', requestedSchema: CONFIRM}},
        {bundleId: id});
      if (answer.action !== 'accept') throw new Error('declined');
      await store.setStatus(id, 'printed');
      return {manifest: await store.read(id), result: {dispatch: {jobName: JOB}}};
    },
  };
  showingRunner(runner);
  const services = {store: bundles, relay, runner, selection: config.selection};
  const store = new ObjectStore(join(root, 'objects'));
  const pending = [];
  const clock = {t: Date.now(), now() { return this.t; }, sleep(ms, signal) {
    return new Promise(resolve => { pending.push({ms, resolve}); signal.addEventListener('abort', resolve, {once: true}); });
  }};
  // Releases the monitor's next wait; when the monitor has ended there is none, and that's fine.
  const tick = async ms => { if (!await until(() => pending.length > 0).then(() => true, () => false)) return; const entry = pending.shift(); clock.t += ms ?? entry.ms; entry.resolve(); await flush(); };
  const settings = new CompanionSettingsStore(join(root, 'settings.json'));
  await settings.load();
  const deps = {store, handoff: config, printerCatalog: catalog, printers: directory, claudePath: '/unused', runTouchup: async () => { throw new Error('unused'); }, stlInfo: async () => undefined,
    print: {services, destinations: new Map([['current', services]])}, settings, camera: new CameraFrames(),
    events: {emit: async draft => { events.push(draft); }}, monitorClock: clock};
  service = showing(new ObjectService(deps));
  const object = await store.create('A mic mount for the stand');
  await mkdir(join(store.dir(object.id), 'current'));
  await writeFile(join(store.dir(object.id), 'current', 'model.stl'), STL);
  await store.update(object.id, o => ({...o, state: 'ready', current: {model: 'current/model.stl', renders: []}}));
  const approve = async () => {
    const question = await until(async () => (await service.get(object.id)).printConfirmation);
    return service.answerPrintConfirmation(object.id, question.id, {action: 'accept', content: {confirmed: true}});
  };
  return {service, store, object, calls, events, runs, relay, session, directory, queue, tick, clock, approve, deps, settings, root, slots, endControl: () => endControl?.()};
}
// The printer's report as counterpart_print_progress gives it (the MCP maps Bambu's gcode_state, minutes and HMS codes).
const STATES = {IDLE: 'idle', PREPARE: 'preparing', RUNNING: 'printing', PAUSE: 'paused', FINISH: 'finished', FAILED: 'failed'};
const status = (state, progress, {name = JOB, problems = []} = {}) => ({state: STATES[state],
  job: {name, id: '0', progress, ...(['PREPARE', 'RUNNING', 'PAUSE'].includes(state) ? {remainingSec: Math.max(0, 40 - progress) * 60} : {}), layer: progress, totalLayers: 100},
  problems});
/** HMS 0300_0D00_0002_0001 (attr 0x03000D00, code 0x00020001), with no words of its own. */
const HMS = {code: '0300_0D00_0002_0001', severity: 'error', message: 'The printer reported problem 0300_0D00_0002_0001.'};
const reset = f => f.store.update(f.object.id, o => ({...o, state: 'ready', print: undefined}));

test('a design in several colours prints its multi-part 3MF, not a one-spool STL', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  const {zipSync, strToU8} = createRequire(new URL('../../printer-handoff/package.json', import.meta.url))('fflate');
  const parts = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object><object id="2"><mesh/></object></resources><build><item objectid="1"/><item objectid="2"/></build></model>')}));
  await writeFile(join(f.store.dir(f.object.id), 'current', 'model.3mf'), parts);
  await f.store.update(f.object.id, o => ({...o, kind: 'fit', current: {model: 'current/model.3mf', renders: []}}));
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  const manifest = await f.deps.print.services.store.read(f.runs[0].id);
  assert.equal(manifest.sourceModel?.format, '3mf', 'the parts and their filaments reach the printer service');
  assert.equal(manifest.cleanStl, undefined);
});

const fflate = () => createRequire(new URL('../../printer-handoff/package.json', import.meta.url))('fflate');
const twoPart3mf = (projectSettings) => {
  const {zipSync, strToU8} = fflate();
  return Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part>'
      + '<part id="2" subtype="normal_part"><metadata key="name" value="letters"/><metadata key="extruder" value="2"/></part></object></config>'),
    ...(projectSettings ? {'Metadata/project_settings.config': strToU8(JSON.stringify(projectSettings))} : {})}));
};
async function multipart(f, {bytes, filaments, kind = 'fit', publishedSelection} = {}) {
  await writeFile(join(f.store.dir(f.object.id), 'current', 'model.3mf'), bytes);
  await f.store.update(f.object.id, o => ({...o, kind, ...(publishedSelection ? {publishedSelection} : {}),
    current: {model: 'current/model.3mf', renders: [], ...(filaments ? {filaments} : {})}}));
}

test('a multi-colour design prints each part from the nearest loaded spool', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{name: 'body', colour: '#111111'}, {name: 'letters', colour: '#FFD200'}]});
  const mapping = await f.service.colourMapping(f.object.id);
  assert.deepEqual(mapping.filaments.map(x => [x.index, x.name, x.colour, x.slot]), [[1, 'body', '#111111', 0], [2, 'letters', '#FFD200', 1]]);
  assert.equal(mapping.trays.length, 3);
  assert.ok(mapping.trays.every(tray => !('profile' in tray)), 'trays reach the sheet without slicer paths');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.deepEqual(f.runs[0].selection.amsMapping, [0, 1], 'black body on the black spool, yellow letters on the yellow one');
  assert.equal(f.runs[0].selection.useAms, true);
  assert.equal(f.runs[0].selection.autoMatchAms, false);
  assert.equal(f.runs[0].selection.amsSlots, undefined);
  assert.equal(f.runs[0].options.slicer.loadFilaments, '/p/petg.json;/p/pla.json');
  assert.equal(f.runs[0].options.slicer.filamentColours, '#000000;#FEC600');
});

test('the sheet shows the MCP’s proposal in its words: a white part with no white on the AMS says where white is (caliper card, Nov 4)', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{name: 'body', colour: '#000000', material: 'PLA'}, {name: 'letters', colour: '#FFFFFF', material: 'PLA'}]});
  const mapping = await f.service.colourMapping(f.object.id);
  assert.deepEqual(mapping.filaments.map(x => [x.name, x.slot, x.verdict]), [['body', 0, 'same-colour'], ['letters', 1, 'closest']]);
  assert.equal(mapping.filaments[1].note, '#FFFFFF is loaded on External, but one print feeds from one source. Closest here: A2 PLA.',
    'never a quiet yellow: the MCP says white is on the external spool');
  assert.deepEqual(mapping.trays.map(tray => [tray.slot, tray.label, tray.feed]), [[0, 'A1', 'ams'], [1, 'A2', 'ams'], [254, 'External', 'external']],
    'each tray carries the MCP\'s feed, so the sheet can say when two choices can\'t print together (Codex, PR #341)');
  // The person's override goes to the MCP, which checks it against what is loaded now.
  const calls = [];
  const proposed = f.deps.print.services.runner.proposeFilaments;
  f.deps.print.services.runner.proposeFilaments = async function (input) { calls.push(input); return proposed.call(this, input); };
  const external = mapping.trays.find(tray => tray.slot === 254);
  await f.service.estimate(f.object.id, {filaments: [external, external], filamentsModelVersion: mapping.modelVersion});
  assert.deepEqual(calls.at(-1).chosen, [{index: 1, slot: 254, colour: '#FFFFFF', material: 'PLA', filamentId: 'GFA00'}, {index: 2, slot: 254, colour: '#FFFFFF', material: 'PLA', filamentId: 'GFA00'}]);
  assert.equal(f.runs.at(-1).estimate.slicer.loadFilaments, '/p/ext.json;/p/ext.json');
});

test('an MCP without the spool proposal asks for its update; its refusals reach the person in its words', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const {modelVersion, trays} = await f.service.colourMapping(f.object.id);
  const runner = f.deps.print.services.runner;
  runner.proposeFilaments = async () => { throw new PrinterMcpError('filament-proposal-unavailable'); };
  await assert.rejects(f.service.colourMapping(f.object.id), /Update bambu-printer-mcp in Settings → Printers so Counterpart can match each colour/);
  delete runner.proposeFilaments;
  await assert.rejects(f.service.colourMapping(f.object.id), /Update bambu-printer-mcp in Settings → Printers/);
  // With no spools chosen (Android, Linux, a print from elsewhere) the colours are never silently dropped either (Codex, #341).
  await assert.rejects(f.service.estimate(f.object.id, {}), /Update bambu-printer-mcp in Settings → Printers so Counterpart can match each colour/);
  await assert.rejects(f.service.print(f.object.id), /Update bambu-printer-mcp in Settings → Printers so Counterpart can match each colour/);
  runner.proposeFilaments = async () => ({contract: 'counterpart/1', trays: [], proposal: [], problems: [{code: 'mixed-feeds', message: 'One print feeds from one source (in the MCP’s words).'}]});
  await assert.rejects(f.service.estimate(f.object.id, {filaments: [trays[0], trays[1]], filamentsModelVersion: modelVersion}), /in the MCP’s words/);
  runner.proposeFilaments = async () => ({not: 'a proposal'});
  await assert.rejects(f.service.estimate(f.object.id, {filaments: [trays[0], trays[1]], filamentsModelVersion: modelVersion}), /Update bambu-printer-mcp/);
});

test('the sheet’s spools override the suggestion, and a spool that changed since is refused', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const {modelVersion} = await f.service.colourMapping(f.object.id);
  const choices = await f.service.filaments(f.object.id);
  const bySlot = slot => choices.find(choice => choice.slot === slot);
  await assert.rejects(f.service.print(f.object.id, {filaments: [{...bySlot(1), colour: '#123456'}, bySlot(0)], filamentsModelVersion: modelVersion}), /changed/);
  await assert.rejects(f.service.print(f.object.id, {filaments: [bySlot(1)], filamentsModelVersion: modelVersion}), /every colour/);
  await assert.rejects(f.service.print(f.object.id, {filaments: [bySlot(1), bySlot(254)], filamentsModelVersion: modelVersion}), /One print feeds from one source/);
  await f.service.print(f.object.id, {filaments: [bySlot(1), bySlot(0)], filamentsModelVersion: modelVersion});
  await f.approve();
  await f.service.settled(f.object.id);
  assert.deepEqual(f.runs.at(-1).selection.amsMapping, [1, 0]);
  assert.equal(f.runs.at(-1).options.slicer.loadFilaments, '/p/pla.json;/p/petg.json');
});

test('a published multi-colour 3MF maps its designer colours to loaded spools; a sliced one keeps its slicing and its material', async t => {
  const bytes = twoPart3mf({filament_colour: ['#000000', '#FFFFFF'], filament_type: ['PLA', 'PLA']});
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes, kind: 'published'});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  // One feed source per print: white follows the nearest AMS spool automatically, not the external one.
  assert.deepEqual(f.runs[0].selection.amsMapping, [0, 1], 'black to the black spool (PETG, re-sliced with it), white to the nearest AMS spool');
  assert.equal(f.runs[0].options.slicer.loadFilaments, '/p/petg.json;/p/pla.json');

  const g = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(g, {bytes, kind: 'published', publishedSelection: {fileIndex: 0, plateIndex: 0, sliced: true}});
  await g.service.print(g.object.id);
  await g.approve();
  await g.service.settled(g.object.id);
  // Sliced for PLA: the black PETG spool is not eligible at all (the MCP would refuse it at dispatch).
  assert.deepEqual(g.runs[0].selection.amsMapping, [1, 1]);
  assert.equal(g.runs[0].options.slicer?.loadFilaments, undefined, 'an already-sliced file is never re-sliced with new profiles');
});

test('profiles and mapping cover every declared slot, and choices for an older model are refused', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  const bytes = twoPart3mf({filament_colour: ['#000000', '#FEC600', '#FFFFFF', '#0000FF'], filament_type: ['PLA', 'PLA', 'PLA', 'PLA']});
  await multipart(f, {bytes, kind: 'published'});
  const mapping = await f.service.colourMapping(f.object.id);
  assert.ok(mapping.modelVersion);
  await assert.rejects(f.service.print(f.object.id, {filaments: [mapping.trays[0], mapping.trays[1]], filamentsModelVersion: 'stale'}), /model changed/);
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.equal(f.runs.at(-1).selection.amsMapping.length, 4, 'one mapping entry per declared slot');
  assert.equal(f.runs.at(-1).options.slicer.loadFilaments.split(';').length, 4, 'one profile per declared slot (the MCP refuses fewer)');
  assert.equal(f.runs.at(-1).options.slicer.filamentColours.split(';').length, 4);
});

test('a sliced plate is not blocked by a declared material it never uses, but a painted one with no plate list still refuses', async t => {
  const {zipSync, strToU8} = fflate();
  const build = plate => Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part></object></config>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify({filament_colour: ['#FEC600', '#000000'], filament_type: ['PLA', 'ABS']})),
    ...(plate ? {'Metadata/plate_1.json': strToU8(JSON.stringify({filament_ids: [0]}))} : {})}));
  const selection = {fileIndex: 0, plateIndex: 0, sliced: true};
  // Plate 1 uses only filament 1 (PLA, loaded): the unused ABS slot must not block it.
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: build(true), kind: 'published', publishedSelection: selection});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.equal(f.runs[0].selection.amsMapping.length, 2, 'the mapping still covers every declared slot');
  assert.equal(f.runs[0].selection.amsMapping[0], 1, 'the PLA part prints from the loaded PLA spool');
  // No plate list: slot 2 may be painted, and no ABS spool is loaded — refuse, don't guess.
  const g = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(g, {bytes: build(false), kind: 'published', publishedSelection: selection});
  await assert.rejects(g.service.print(g.object.id), /painted part of this file was sliced for ABS/);
});

test('a painted unsliced model shows its painted filament as a colour row; without painting it stays an unused preset', async t => {
  const {zipSync, strToU8} = fflate();
  const build = painted => Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8(`<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2"${painted ? ' paint_color="8"' : ''}/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part></object></config>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify({filament_colour: ['#FEC600', '#000000'], filament_type: ['PLA', 'PLA']}))}));
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: build(true), kind: 'published'});
  const mapping = await f.service.colourMapping(f.object.id);
  assert.deepEqual(mapping.filaments.map(x => x.index), [1, 2], 'the painted filament is a row the person can change');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.deepEqual(f.runs[0].selection.amsMapping, [1, 0], 'body on the yellow PLA spool, painted black on the black spool');
  const g = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(g, {bytes: build(false), kind: 'published'});
  assert.deepEqual((await g.service.colourMapping(g.object.id)).filaments.map(x => x.index), [1], 'no painting: the second declared slot is just an unused preset');
  // Studio layout: painting only in a component file under 3D/Objects/ still earns its row.
  const componentPainted = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><components><component p:path="/3D/Objects/object_1.model" objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>'),
    '3D/Objects/object_1.model': strToU8('<model><resources><object id="1"><mesh><triangles><triangle v1="0" v2="1" v3="2" paint_color="8"/></triangles></mesh></object></resources></model>'),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="name" value="Pick"/><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="name" value="body"/><metadata key="extruder" value="1"/></part></object></config>'),
    'Metadata/project_settings.config': strToU8(JSON.stringify({filament_colour: ['#FEC600', '#000000'], filament_type: ['PLA', 'PLA']}))}));
  const h = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(h, {bytes: componentPainted, kind: 'published'});
  assert.deepEqual((await h.service.colourMapping(h.object.id)).filaments.map(x => x.index), [1, 2], 'component-file painting earns its row too');
});

test('spool choices for a 3MF whose filaments cannot be read are refused, never dropped', async t => {
  const {zipSync, strToU8} = fflate();
  const bare = Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>')}));
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: bare});
  const tray = {slot: 1, colour: '#FEC600', material: 'PLA', filamentId: 'GFA00', destinationId: 'current', name: 'PLA'};
  await assert.rejects(f.service.print(f.object.id, {filaments: [tray], filamentsModelVersion: 'from-the-old-model'}), /model changed since you chose its spools/);
  await assert.rejects(f.service.estimate(f.object.id, {filaments: [tray], filamentsModelVersion: 'from-the-old-model'}), /model changed since you chose its spools/);
});

test('when the inventory cannot be read, a multi-part print falls back to the MCP defaults as before', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf({filament_colour: ['#000000', '#FFFFFF'], filament_type: ['PLA', 'PLA']}), kind: 'published'});
  f.deps.print.services.runner.filaments = async () => { throw new Error('offline'); };
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.equal(f.runs[0].selection.amsMapping, undefined);
});

test('a spool swapped while slicing stops the dispatch before anything is sent', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const real = f.deps.print.services.runner.filaments;
  let reads = 0;
  f.deps.print.services.runner.filaments = async () => {
    const inventory = await real();
    reads++;
    // The print sheet's estimate reads the spools once and Print once more; the swap comes after both.
    if (reads < 3) return inventory;
    return {trays: inventory.trays.map(tray => tray.slot === 1 ? {...tray, tray_color: 'FF0000FF'} : tray)};
  };
  await f.service.print(f.object.id);
  const failed = await f.service.settled(f.object.id);
  assert.equal(failed.state, 'failed');
  assert.match(failed.failure ?? '', /changed before printing started/);
});

test('a spool swapped while the printer’s question waits is caught before the acceptance is forwarded', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const real = f.deps.print.services.runner.filaments;
  let swapped = false;
  f.deps.print.services.runner.filaments = async () => {
    const inventory = await real();
    return swapped ? {trays: inventory.trays.map(tray => tray.slot === 1 ? {...tray, tray_color: 'FF0000FF'} : tray)} : inventory;
  };
  await f.service.print(f.object.id);
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  swapped = true;
  await assert.rejects(f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}}), /changed before printing started/);
  const settled = await f.service.settled(f.object.id);
  // A safety-check refusal, like the dispatch one: failed, the reason kept, and the phone
  // hears print.not-started so its Live Activity ends instead of cancelling quietly.
  assert.equal(settled.state, 'failed', 'the declined print settles as not started, nothing sent');
  assert.match(settled.failure, /changed before printing started/);
  assert.ok(f.events.some(event => event.type === 'print.not-started'), 'the refusal is announced, not quiet');
});

test('the estimate for a multi-colour model slices with the mapped spools’ profiles', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const estimate = await f.service.estimate(f.object.id);
  assert.equal(estimate.seconds, 3420);
  assert.equal(f.runs[0].estimate.slicer.loadFilaments, '/p/petg.json;/p/pla.json');
  assert.equal(f.runs[0].estimate.slicer.filamentColours, '#000000;#FEC600');
  // The sheet's edited spools slice the estimate too, not the suggestions.
  const {modelVersion} = await f.service.colourMapping(f.object.id);
  const choices = await f.service.filaments(f.object.id);
  const bySlot = slot => choices.find(choice => choice.slot === slot);
  await f.service.estimate(f.object.id, {filaments: [bySlot(254), bySlot(254)], filamentsModelVersion: modelVersion});
  assert.equal(f.runs.at(-1).estimate.slicer.loadFilaments, '/p/ext.json;/p/ext.json');
});

test('an estimate for another printer reads that printer’s spools, not the saved printer’s', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#111111'}, {colour: '#FFD200'}]});
  const base = f.deps.print.services;
  const otherRunner = {...base.runner,
    filaments: async () => ({trays: [{slot: 0, loaded: true, tray_color: 'FFFFFFFF', tray_type: 'PLA', tray_info_idx: 'OTHER', resolved_profile_path: '/p/other.json'}]}),
    estimate: async input => { f.runs.push({estimate: input, other: true}); return {estimate: {seconds: 60, grams: 1}, settings: {layers: 10}}; }};
  f.deps.print.destinations.set('other', {...base, runner: otherRunner});
  f.deps.printerCatalog.canonical = id => ['current', 'other'].includes(id) ? id : undefined;
  // The other printer's MCP reports an AMS too (counterpart_printer_info), as the saved one's does.
  const capabilities = f.directory.capabilities.bind(f.directory);
  f.directory.capabilities = id => capabilities(id === 'other' ? 'current' : id);
  const {modelVersion} = await f.service.colourMapping(f.object.id);
  // Automatic matching uses the requested printer's inventory.
  await f.service.estimate(f.object.id, {destinationId: 'other'});
  assert.equal(f.runs.at(-1).other, true);
  assert.equal(f.runs.at(-1).estimate.slicer.loadFilaments, '/p/other.json;/p/other.json');
  assert.equal(f.runs.at(-1).estimate.slicer.filamentColours, '#FFFFFF;#FFFFFF');
  // Explicit choices from that printer validate against its trays, not the saved printer's.
  const tray = {slot: 0, colour: '#FFFFFF', material: 'PLA', filamentId: 'OTHER', destinationId: 'other', name: 'PLA'};
  await f.service.estimate(f.object.id, {destinationId: 'other', filaments: [tray, tray], filamentsModelVersion: modelVersion});
  assert.equal(f.runs.at(-1).estimate.slicer.loadFilaments, '/p/other.json;/p/other.json');
});

test('the mapping and per-colour spools cross both transports (Mac socket and phone HTTP)', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{name: 'body', colour: '#111111'}, {name: 'letters', colour: '#FFD200'}]});
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: f.service});
  const viaSocket = await dispatch('objects.colourMapping', {id: f.object.id});
  assert.deepEqual(viaSocket.filaments.map(x => x.slot), [0, 1]);
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const viaHttp = await (await fetch(`${base}/objects/${f.object.id}/colour-mapping`)).json();
  assert.deepEqual(viaHttp, viaSocket);
  const printed = await (await fetch(`${base}/objects/${f.object.id}/print`, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({filaments: [viaSocket.trays.find(x => x.slot === 1), viaSocket.trays.find(x => x.slot === 0)], filamentsModelVersion: viaSocket.modelVersion})})).json();
  assert.equal(printed.object.state, 'printing');
  await f.approve();
  await f.service.settled(f.object.id);
  assert.deepEqual(f.runs.at(-1).selection.amsMapping, [1, 0]);
});

test('"printed" means printed: Print leaves the project printing until the printer reports this job done', async t => {
  const f = await setup(t, {reports: [status('FINISH', 100, {name: 'old job'}), status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  const started = await f.service.print(f.object.id);
  assert.match(started.print.printId, /^[0-9a-f-]{36}$/);
  await f.approve();
  const dispatched = await f.service.settled(f.object.id);
  assert.equal(dispatched.state, 'printing');
  assert.equal(dispatched.print.jobName, JOB);
  assert.ok(dispatched.print.dispatchedAt);
  assert.equal(dispatched.print.monitor.phase, 'starting');
  assert.equal(dispatched.print.destinationId, 'current');
  assert.ok(f.events.some(e => e.type === 'print.preparing'));
  assert.equal(f.events.find(e => e.type === 'print.confirm').data.confirmationId.length, 36);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.monitor.endState, 'done');
  assert.equal(done.print.live.state, 'finished');
  assert.equal(done.print.printerStatus.state, 'FINISH');
  await until(() => f.events.some(e => e.type === 'print.done'));
  const types = f.events.map(e => e.type).filter(type => !['print.preparing', 'print.confirm', 'print.status'].includes(type));
  assert.deepEqual(types, ['print.started', 'print.first-layer', 'print.milestone', 'print.done']);
  const frame = f.events.find(e => e.type === 'print.done').frame;
  assert.deepEqual(await readFile(join(f.service.dir(f.object.id), frame)), JPEG);
  await until(async () => (await f.service.get(f.object.id)).print.events.some(e => e.message === 'Done. Take it off the plate.'));
  await until(() => f.session.health().holders === 0);
});

test('a companion restart resumes the monitor of a dispatched print instead of failing it', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 60), status('FINISH', 100)]});
  const printId = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
  await f.store.update(f.object.id, o => ({...o, state: 'printing', print: {bundleId: '00000000-0000-4000-8000-000000000001', printId, destinationId: 'current',
    destination: {id: 'current', name: 'Bambu Lab P1S'}, dispatchedAt: new Date(f.clock.t - 600_000).toISOString(), jobName: JOB,
    monitor: {phase: 'watching', startedAt: new Date(f.clock.t - 600_000).toISOString(), lastReportAt: new Date(f.clock.t - 5000).toISOString(), milestonesSent: [50], firstLayerSent: true}}}));
  await f.store.recoverInterrupted();
  assert.equal((await f.store.get(f.object.id)).state, 'printing');
  await f.service.resume();
  await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.printId, printId);
  await until(() => f.events.some(e => e.type === 'print.done'));
  assert.equal(f.events.filter(e => e.type === 'print.milestone').length, 0, 'no milestone sent twice');
});

test('a print still being prepared at a restart is interrupted, and flagged when it may have reached the printer', async t => {
  const f = await setup(t);
  const bundle = await f.deps.print.services.store.create({stl: STL, prompt: '', backend: 'bambu-printer-mcp'});
  await f.deps.print.services.store.setStatus(bundle.id, 'uncertain', 'dispatch-uncertain');
  await f.store.update(f.object.id, o => ({...o, state: 'printing', print: {bundleId: bundle.id, destinationId: 'current'}}));
  await f.store.recoverInterrupted({keepPrinting: true});
  await f.service.resume();
  const object = await f.service.get(f.object.id);
  assert.equal(object.state, 'failed');
  assert.equal(object.print.uncertain, true);
  await assert.rejects(f.service.print(f.object.id), InvalidStateError);
});

test('print settings reach the slicer and printer; an MCP without them is refused before anything is sliced', async t => {
  const f = await setup(t, {sliceArgs: true, reports: [status('IDLE', 0)]});
  await f.service.print(f.object.id, {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}});
  const run = await until(() => f.runs.at(-1));
  // The person's choice goes to the MCP as chosen; the MCP picks its slicer's numbers (PRD §8.0).
  assert.deepEqual(run.options.slicer, {loadFilaments: '/p/pla.json', filamentColours: '#FEC600', quality: 'fine', strength: 'strong'});
  assert.deepEqual(run.selection, {model: 'p1s', material: 'PLA', useAms: true, amsSlots: [1], autoMatchAms: false});
  assert.deepEqual((await f.service.get(f.object.id)).print.settings, {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}});
  await f.approve(); await f.service.settled(f.object.id); await f.service.close();
  const g = await setup(t, {reports: [status('IDLE', 0)]});
  await g.service.print(g.object.id, {colour: {auto: true}});
  assert.deepEqual((await until(() => g.runs.at(-1))).selection, {model: 'p1s', material: 'PLA', useAms: true, autoMatchAms: true});
  await g.approve(); await g.service.settled(g.object.id); await g.service.close(); await reset(g);
  const h = await setup(t, {reports: [status('IDLE', 0)]});
  await h.service.print(h.object.id, {colour: {external: true}});
  assert.equal((await until(() => h.runs.at(-1))).selection.useAms, false);
  assert.equal(h.runs.at(-1).options.slicer.loadFilaments, '/p/ext.json');
  await h.approve(); await h.service.settled(h.object.id); await h.service.close();
  const empty = await setup(t);
  await assert.rejects(empty.service.print(empty.object.id, {colour: {amsSlot: 3}}), /empty now/);
  const old = await setup(t);
  await assert.rejects(old.service.print(old.object.id, {quality: 'draft'}), /Update bambu-printer-mcp to choose quality/);
  await assert.rejects(old.service.estimate(old.object.id, {strength: 'max'}), /Update bambu-printer-mcp to choose strength/);
  assert.equal(old.runs.length, 0);
  // Standard is always offered: the preset's own values, nothing sent.
  await old.service.print(old.object.id, {quality: 'standard', strength: 'standard'});
  assert.equal((await until(() => old.runs.at(-1))).options.slicer, undefined);
  await old.approve();
});

test('an estimate slices exactly as Print would, is shared by identical requests, and is cached per model', async t => {
  const f = await setup(t, {sliceArgs: true});
  const [a, b] = await Promise.all([f.service.estimate(f.object.id, {quality: 'fine'}), f.service.estimate(f.object.id, {quality: 'fine'})]);
  assert.deepEqual(a, b);
  assert.equal(f.runs.filter(run => run.estimate).length, 1);
  assert.equal(a.seconds, 3420);
  assert.equal(a.layerHeightMm, 0.12);
  assert.equal(a.quality, 'fine');
  assert.equal(a.strength, 'standard');
  assert.deepEqual(f.runs.find(run => run.estimate).estimate.slicer, {quality: 'fine'});
  await f.service.estimate(f.object.id, {quality: 'fine'});
  assert.equal(f.runs.filter(run => run.estimate).length, 1);
  await writeFile(join(f.service.dir(f.object.id), 'current', 'model.stl'), Buffer.concat([STL, Buffer.from(' ')]));
  await f.service.estimate(f.object.id, {quality: 'fine'});
  assert.equal(f.runs.filter(run => run.estimate).length, 2, 'a new model is sliced again');
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: f.service});
  assert.equal((await dispatch('objects.estimate', {id: f.object.id, quality: 'fine'})).grams, 19.2);
});

test("a designer's 3MF prints with its own settings: the last print's quality and strength never carry over (Nov 5)", async t => {
  // Nov 5, caliper card 1f1c5515: "It shouldn't have changed a single thing about the physical print, just a cosmetic
  // bit of logo". Whether the file carries its own settings is the printer MCP's to say (get_slice_settings own_process).
  const f = await setup(t, {sliceArgs: true});
  const runner = f.deps.print.services.runner, asked = [];
  let own = true;
  runner.ownProcess = async input => { asked.push(input.modelPath); return own; };
  await multipart(f, {bytes: twoPart3mf({layer_height: '0.16', sparse_infill_density: '100%', wall_loops: '2'}), kind: 'copy'});
  // The last print (or a saved default) asked for Draft and Strong.
  await f.store.update(f.object.id, o => ({...o, scan: 'scan.3mf', preferences: {printDefaults: {quality: 'draft', strength: 'strong'}}}));
  assert.equal((await f.service.get(f.object.id)).current.ownSettings, undefined, 'not asked yet');
  await f.service.list();
  const listed = await until(async () => (await f.service.get(f.object.id)).current.ownSettings === true ? f.service.get(f.object.id) : undefined);
  assert.equal(listed.current.ownSettings, true);
  assert.deepEqual(asked, [join(f.store.dir(f.object.id), 'current', 'model.3mf')], 'the project file itself, asked once');
  assert.ok(f.events.some(e => e.type === 'project.updated' && e.projectId === f.object.id && e.data.keys.includes('current')), 'the sheets hear it');
  await f.service.list();
  assert.equal(asked.length, 1, 'once per file');
  // A sheet that names nothing slices the file's own settings: no layer height, wall or infill override.
  const estimate = await f.service.estimate(f.object.id, {});
  assert.equal(estimate.quality, 'standard');
  assert.equal(estimate.strength, 'standard');
  const sliced = f.runs.find(run => run.estimate).estimate.slicer ?? {};
  for (const key of ['quality', 'strength', 'layerHeightMm', 'wallLoops', 'sparseInfillDensity']) assert.equal(sliced[key], undefined, key);
  // A choice the person makes still applies.
  await f.service.estimate(f.object.id, {quality: 'fine'});
  assert.equal(f.runs.filter(run => run.estimate).at(-1).estimate.slicer.quality, 'fine');
  // A new file is asked again; an MCP that doesn't say leaves it unknown and the saved defaults apply as before.
  own = undefined;
  await writeFile(join(f.store.dir(f.object.id), 'current', 'model.3mf'), twoPart3mf());
  await f.store.update(f.object.id, o => ({...o, current: {model: 'current/model.3mf', renders: []}}));
  await f.service.list();
  await until(() => asked.length === 2);
  assert.equal((await f.service.get(f.object.id)).current.ownSettings, undefined);
  await f.service.estimate(f.object.id, {});
  const {quality, strength} = f.runs.filter(run => run.estimate).at(-1).estimate.slicer;
  assert.deepEqual({quality, strength}, {quality: 'draft', strength: 'strong'}, "an MCP that doesn't say: today's behaviour");
});

test("the own-settings answer belongs to its printer, and another plate of the same file keeps it", async t => {
  const f = await setup(t, {sliceArgs: true});
  const runner = f.deps.print.services.runner, asked = [];
  runner.ownProcess = async input => { asked.push(input.modelPath); return true; };
  await multipart(f, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  await f.store.update(f.object.id, o => ({...o, scan: 'scan.3mf', preferences: {printDefaults: {quality: 'draft', strength: 'strong'}}}));
  await f.service.list();
  await until(async () => (await f.service.get(f.object.id)).current.ownSettings === true);
  const mine = (await f.service.get(f.object.id)).current.ownSettingsFor;
  assert.match(mine, /^current(@|$)/, 'this printer, with its MCP version');
  // An answer recorded for another printer is not this printer's: the estimate settles this printer's first (from
  // what it already knows about this file, without asking again), and slices with it.
  await f.store.update(f.object.id, o => ({...o, current: {...o.current, ownSettingsFor: 'garage'}}));
  await f.service.estimate(f.object.id, {});
  assert.equal((await f.service.get(f.object.id)).current.ownSettingsFor, mine);
  const {quality} = f.runs.filter(run => run.estimate).at(-1).estimate.slicer;
  assert.equal(quality, undefined, 'this printer\'s answer, settled before the slice, keeps the designer\'s settings');
  assert.equal(asked.length, 1, 'the answer for this file and printer is remembered, not asked again');
  // Updating the MCP (Settings → Printers) may change its decision: the updated MCP is asked again (Codex on #336).
  const capabilities = f.deps.printers.capabilities.bind(f.deps.printers);
  f.deps.printers.capabilities = id => ({...capabilities(id), server: {name: 'bambu-printer-mcp', version: '9.9.9'}});
  await f.service.estimate(f.object.id, {});
  assert.equal(asked.length, 2, 'the updated MCP is asked');
  assert.equal((await f.service.get(f.object.id)).current.ownSettingsFor, 'current@9.9.9');
});

test("the first estimate waits for the own-settings answer; an MCP that can't answer says to update it; a failure or a replaced file is asked again", async t => {
  // Codex on #336: a slice made before the answer used saved Draft/Strong, then Print (with the answer) refused it.
  const f = await setup(t, {sliceArgs: true});
  const runner = f.deps.print.services.runner;
  let answer = () => true, asks = 0;
  runner.ownProcess = async () => { asks++; await new Promise(resolve => setTimeout(resolve, 30)); return answer(); };
  await multipart(f, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  await f.store.update(f.object.id, o => ({...o, scan: 'scan.3mf', preferences: {printDefaults: {quality: 'draft', strength: 'strong'}}}));
  // The session connects for the question, and only then does the directory know the MCP's version (Codex on #336).
  let known = null;
  const capabilities = f.deps.printers.capabilities.bind(f.deps.printers);
  f.deps.printers.capabilities = id => known ? {...capabilities(id), server: {name: 'bambu-printer-mcp', version: known}} : capabilities(id);
  answer = () => { known = '1.1.65'; return true; };
  const first = await f.service.estimate(f.object.id, {});
  const {quality, strength} = f.runs.filter(run => run.estimate).at(-1).estimate.slicer;
  assert.deepEqual({quality, strength}, {quality: undefined, strength: undefined}, 'the first slice already keeps the designer\'s settings');
  assert.equal(first.ownSettingsUpdate, undefined);
  // An MCP that can't answer: today's behaviour, plus the sheet's line to update it; nothing is recorded.
  const g = await setup(t, {sliceArgs: true});
  g.deps.print.services.runner.ownProcess = async () => 'unsupported';
  await multipart(g, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  let version = '1.1.61';
  g.deps.printers.capabilities = () => ({server: {name: 'bambu-printer-mcp', version}});
  const old = await g.service.estimate(g.object.id, {});
  assert.equal(old.ownSettingsUpdate, "Update bambu-printer-mcp in Settings → Printers so Counterpart can keep a designer's settings for this file.");
  assert.equal((await g.service.get(g.object.id)).current.ownSettings, undefined);
  // After the person updates the MCP, its answer is asked for again, not the old one's 'unsupported'.
  version = '1.1.65';
  g.deps.print.services.runner.ownProcess = async () => true;
  const updated = await g.service.estimate(g.object.id, {});
  assert.equal(updated.ownSettingsUpdate, undefined);
  assert.equal((await g.service.get(g.object.id)).current.ownSettings, true);
  // A failed call is asked again, never recorded as an answer.
  const h = await setup(t, {sliceArgs: true});
  let fail = true, calls = 0;
  h.deps.print.services.runner.ownProcess = async () => { calls++; if (fail) throw new Error('printer service unreachable'); return true; };
  await multipart(h, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  await h.service.estimate(h.object.id, {});
  assert.equal((await h.service.get(h.object.id)).current.ownSettings, undefined);
  fail = false;
  await h.service.estimate(h.object.id, {});
  assert.equal(calls, 2);
  assert.equal((await h.service.get(h.object.id)).current.ownSettings, true);
  // A pass that replaces the file while the question is out: the old file's answer is not written onto the new one.
  const k = await setup(t, {sliceArgs: true});
  let release;
  k.deps.print.services.runner.ownProcess = () => new Promise(resolve => { release = resolve; });
  await multipart(k, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  await k.service.list();
  await until(() => release);
  await writeFile(join(k.store.dir(k.object.id), 'current', 'model.3mf'), Buffer.concat([twoPart3mf(), Buffer.from(' ')]));
  release(true);
  await flush();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await k.service.get(k.object.id)).current.ownSettings, undefined, 'the replaced file is asked about itself');
});

test("an estimate for another printer asks that printer's MCP about the designer's settings, and keeps the saved printer's answer", async t => {
  // Codex on #336: the question, the defaults and the update notice all follow the printer this slice is for.
  const f = await setup(t, {sliceArgs: true});
  const base = f.deps.print.services;
  base.runner.ownProcess = async () => 'unsupported';
  const otherRunner = {...base.runner, ownProcess: async () => true,
    estimate: async input => { f.runs.push({estimate: input, other: true}); return {estimate: {seconds: 60, grams: 1}, settings: {layers: 10}}; }};
  f.deps.print.destinations.set('other', {...base, runner: otherRunner});
  f.deps.printerCatalog.canonical = id => ['current', 'other'].includes(id) ? id : undefined;
  const capabilities = f.directory.capabilities.bind(f.directory);
  f.directory.capabilities = id => capabilities(id === 'other' ? 'current' : id);
  await multipart(f, {bytes: twoPart3mf({layer_height: '0.16'}), kind: 'copy'});
  await f.store.update(f.object.id, o => ({...o, scan: 'scan.3mf', preferences: {printDefaults: {quality: 'draft', strength: 'strong'}}}));
  const other = await f.service.estimate(f.object.id, {destinationId: 'other'});
  const {quality} = f.runs.filter(run => run.other).at(-1).estimate.slicer ?? {};
  assert.equal(quality, undefined, "the other printer's MCP keeps the designer's settings");
  assert.equal(other.ownSettingsUpdate, undefined, "no update notice for a printer whose MCP answers");
  assert.equal((await f.service.get(f.object.id)).current.ownSettings, undefined, "the project's own printer's answer isn't replaced");
  const saved = await f.service.estimate(f.object.id, {});
  assert.match(saved.ownSettingsUpdate, /Update bambu-printer-mcp/, "the saved printer's MCP can't answer: its notice");
});

test('another plate of the same file keeps its own-settings answer; another file clears it', async () => {
  const {selectingPlate} = await import('../dist/objects/plates.js');
  const receipt = (sha256, path) => ({sha256, path, name: path, plates: [{index: 0, name: 'A', sliced: false}, {index: 1, name: 'B', sliced: false}]});
  const object = {id: 'p', kind: 'published', state: 'ready', photos: [], passes: [], files: {original: [], receipts: [receipt('a', 'original/a.3mf'), receipt('b', 'original/b.3mf')]},
    publishedSelection: {fileIndex: 0, plateIndex: 0, sliced: false},
    current: {model: 'original/a.3mf', renders: [], ownSettings: true, ownSettingsFor: 'current'}};
  const samefile = selectingPlate(object, 0, 1);
  assert.equal(samefile.current.ownSettings, true);
  assert.equal(samefile.current.ownSettingsFor, 'current');
  const other = selectingPlate(object, 1, 0);
  assert.equal(other.current.ownSettings, undefined);
  assert.equal(other.current.ownSettingsFor, undefined);
});

test('pause, resume and stop go through the printer\'s mutex and relay its own confirmation to the project', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const pausing = f.service.control(f.object.id, 'pause');
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  assert.equal(question.message, 'Confirm pause_print');
  // A second control while the first one's question is open is refused, never queued behind it.
  await assert.rejects(f.service.control(f.object.id, 'cancel'), /still answering the last Pause, Resume or Stop/);
  await f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}});
  const paused = await pausing;
  assert.equal(paused.printConfirmation, undefined);
  assert.deepEqual(f.calls.find(c => c.name === 'pause_print').context, {bundleId: paused.print.bundleId});
  assert.ok(paused.print.events.some(e => e.message === 'Pause sent.'));
  // A declined confirmation is reported in words; nothing pretends it resumed.
  const resuming = f.service.control(f.object.id, 'resume').then(() => assert.fail('resumed'), error => error);
  const second = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  await f.service.answerPrintConfirmation(f.object.id, second.id, {action: 'decline'});
  assert.match((await resuming).message, /didn't resume: Not confirmed/);
  await assert.rejects(f.service.control((await f.store.create()).id, 'cancel'), /Nothing of this project is printing/);
});

// Nov 3: a Resume's question outlived its 2-minute call; the dead question then hid Resume until the print ended.
test('a control waits as long as its question can, and a question whose call ended never stays on the project', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)], controlEnds: true});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const resuming = f.service.control(f.object.id, 'resume').then(() => assert.fail('resumed'), error => error);
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  assert.ok(f.calls.find(c => c.name === 'resume_print').timeoutMs > 600000, 'the call outlasts the 10-minute question');
  f.endControl();
  assert.match((await resuming).message, /didn't resume/);
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);
  // A question an older companion left behind: answering it takes it off the project.
  await f.store.update(f.object.id, o => ({...o, printConfirmation: question}));
  await assert.rejects(f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}}), /no longer waiting/);
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);  // An expired one can't be answered at all; a restart takes it away.
  await f.store.update(f.object.id, o => ({...o, printConfirmation: {...question, expiresAtMs: Date.now() - 1}}));
  await f.service.resume();
  assert.equal((await f.service.get(f.object.id)).printConfirmation, undefined);
});

test('the camera route serves one frame per 3 s to every viewer, and 404s a printer without a camera', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)]});
  const routes = createObjectRoutes(f.service);
  const server = createServer((request, response) => void routes.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const [one, two] = await Promise.all([fetch(`${base}/objects/${f.object.id}/camera.jpg`), fetch(`${base}/objects/printers/current/camera.jpg`)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(one.headers.get('content-type'), 'image/jpeg');
  assert.ok(Date.parse(one.headers.get('x-captured-at')));
  assert.deepEqual(Buffer.from(await one.arrayBuffer()), JPEG);
  assert.equal(f.calls.filter(c => c.name === 'camera_snapshot').length, 1);
  assert.equal((await fetch(`${base}/objects/printers/nope/camera.jpg`)).status, 404);
  const settings = await fetch(`${base}/settings`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({milestones: '25-50-75'})});
  assert.deepEqual(await settings.json(), {settings: {milestones: '25-50-75', notifications: {mac: {}, devices: {}}, general: {}}});
  assert.deepEqual(await (await fetch(`${base}/settings`)).json(), {settings: {milestones: '25-50-75', notifications: {mac: {}, devices: {}}, general: {}}});
  assert.equal((await fetch(`${base}/settings`, {method: 'PATCH', headers: {'content-type': 'application/json'}, body: JSON.stringify({milestones: '33'})})).status, 400);
  const blind = await setup(t, {tools: ['counterpart_printer_info', 'counterpart_print_progress']});
  await assert.rejects(blind.service.camera(blind.object.id), error => error.reason === 'no-camera');
});

test('a print whose job the printer can\'t identify is "sent", never "printed"; one named after our file is adopted', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)]});
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {}}}; };
  await f.service.print(f.object.id);
  const sent = await f.service.settled(f.object.id);
  assert.equal(sent.state, 'sent');
  assert.ok(sent.print.dispatchedAt);
  assert.equal(sent.print.uncertain, true, 'printing it again needs a check');
  assert.equal(sent.print.monitor, undefined);
  assert.equal(f.events.at(-1).type, 'print.sent');
  await assert.rejects(f.service.print(f.object.id), InvalidStateError);

  const named = await setup(t, {reports: [status('IDLE', 0, {name: 'old'}), {state: 'printing', job: {name: 'checked-77-sliced', progress: 2}, problems: []},
    {state: 'finished', job: {name: 'checked-77-sliced', progress: 100}, problems: []}]});
  named.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {fileBase: 'sliced'}}}; };
  await named.service.print(named.object.id);
  const watching = await named.service.settled(named.object.id);
  assert.equal(watching.state, 'printing');
  assert.equal(watching.print.fileBase, 'sliced');
  for (let i = 0; i < 2; i++) await named.tick();
  const done = await until(async () => { const o = await named.service.get(named.object.id); return o.state === 'printed' ? o : undefined; });
  assert.equal(done.print.jobName, 'checked-77-sliced');

  const never = await setup(t, {reports: [status('IDLE', 0, {name: 'old'})]});
  never.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {fileBase: 'sliced'}}}; };
  await never.service.print(never.object.id);
  await never.service.settled(never.object.id);
  for (let i = 0; i < 70 && (await never.service.get(never.object.id)).print.monitor.phase !== 'ended'; i++) await never.tick();
  const ended = await until(async () => { const o = await never.service.get(never.object.id); return o.state === 'sent' ? o : undefined; });
  assert.equal(ended.print.monitor.endState, 'sent');
  assert.ok(never.events.some(e => e.type === 'print.sent'));
  assert.equal(never.events.some(e => e.type === 'print.not-started'), false, 'no identity: not seeing it proves nothing');
});

test('a print handed to Bambu Connect is "sent" at once: the person finishes it on the Mac', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)], route: {mode: 'bambu_connect', type: 'cloud'}});
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {jobName: 'x', fileBase: 'x'}}}; };
  await f.service.print(f.object.id);
  const sent = await f.service.settled(f.object.id);
  assert.equal(sent.state, 'sent');
  assert.equal(sent.print.sentVia, 'bambu-connect');
});

test('Stop, Pause and Resume carry no route: the printer service controls over the connection it printed with', async t => {
  const f = await setup(t, {controlsRoute: true, reports: [status('RUNNING', 10)], route: {mode: 'bambu_network', type: 'lan'}});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const stopping = f.service.control(f.object.id, 'cancel');
  await f.approve();
  await stopping;
  const args = f.calls.find(c => c.name === 'cancel_print').args;
  assert.equal(args.connection_mode, undefined);
  assert.equal(args.connection_type, undefined);
});

test('a Bambu Connect choice copied into printer-handoff.json no longer decides anything: the MCP\'s route does', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 1)], route: {mode: 'bambu_network', type: 'lan'}});
  f.deps.print.services.selection = {...f.deps.print.services.selection, connectionMode: 'bambu_connect'};
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'printed'); return {manifest: await store.read(id), result: {dispatch: {jobName: 'x', fileBase: 'x'}}}; };
  await f.service.print(f.object.id);
  const settled = await f.service.settled(f.object.id);
  assert.notEqual(settled.print.sentVia, 'bambu-connect');
});

test('Settings -> Printers reads and changes the MCP\'s own route, and has none to show for an MCP without one', async t => {
  const f = await setup(t, {route: {mode: 'bambu_network', type: 'lan'}});
  const read = await f.service.printRoute('current');
  assert.equal(read.route, 'lan');
  assert.deepEqual(read.options.map(option => option.label), ['Local network', 'Bambu Cloud', 'Local network, Developer Mode'], 'the MCP words each connection');
  const cloud = await f.service.printRoute('current', 'cloud');
  assert.deepEqual([cloud.route, cloud.mode, cloud.type], ['cloud', 'bambu_network', 'cloud']);
  // Developer Mode is a route Counterpart never had to know about: the MCP names and words it.
  const developer = await f.service.printRoute('current', 'developer');
  assert.deepEqual([developer.route, developer.mode], ['developer', 'lan_mqtt_ftps']);
  assert.match(developer.options.find(option => option.id === 'developer').controls, /straight to the printer/);
  assert.deepEqual(f.calls.filter(c => c.name === 'counterpart_print_route').map(c => c.args?.route), [undefined, 'cloud', 'developer']);
  await assert.rejects(f.service.printRoute('elsewhere'));
  const none = await setup(t, {});
  assert.equal(await none.service.printRoute('current'), undefined);
  // An MCP from before options still shows its two choices.
  const older = await setup(t, {route: {mode: 'bambu_network', type: 'lan', legacy: true}});
  const legacy = await older.service.printRoute('current');
  assert.deepEqual([legacy.route, legacy.choices, legacy.options], ['lan', ['lan', 'cloud'], undefined]);
});

// The phone's Settings -> Printers: the same printers.route and printers.chooseMcp the Mac uses, over HTTPS.
test('the phone reads and changes a printer\'s connection and MCP, never while it prints, and only with settings scope', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)], route: {mode: 'bambu_network', type: 'lan'}});
  const chosen = [];
  let setupBusy = false;
  const {PrinterSetupError} = await import('../dist/printing/setup.js');
  const printerSetup = {async chooseMcp(destinationId, backend) {
    if (destinationId !== 'current') throw new PrinterSetupError('not-found', 'That printer is no longer there.');
    if (setupBusy) throw new PrinterSetupError('conflict', 'This printer is printing. Change its MCP when the print finishes.');
    chosen.push(backend); return {destinationId: 'clone-1'};
  }};
  const routes = createObjectRoutes(f.service, {printerSetup});
  const scopes = [];
  let denied = [];
  const server = createServer((request, response) => void routes.handle(request, response, async scope => {
    scopes.push(scope);
    if (denied.includes(scope)) throw Object.assign(new Error('forbidden'), {name: 'RemoteAuthFailure'});
  }, () => undefined).catch(error => { response.statusCode = error.name === 'RemoteAuthFailure' ? 403 : 500; response.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/printers`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {method, headers: {'content-type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    const text = await response.text();
    return {status: response.status, json: text ? JSON.parse(text) : undefined};
  };

  const read = await call('GET', '/current/route');
  assert.equal(read.status, 200);
  assert.equal(read.json.route.route, 'lan');
  assert.deepEqual(read.json.route.options.map(option => option.id), ['lan', 'cloud', 'developer'], 'the MCP\'s own options, as on the Mac');
  assert.deepEqual(scopes, ['printer-handoff:use']);
  scopes.length = 0;
  const cloud = await call('PUT', '/current/route', {route: 'cloud'});
  assert.equal(cloud.status, 200);
  assert.deepEqual([cloud.json.route.route, cloud.json.route.type], ['cloud', 'cloud']);
  assert.deepEqual(scopes, ['printer-handoff:use', 'projects:write'], 'a change needs settings as well as printing');
  // Bad bodies, extra keys, and a token that can print but not change settings.
  for (const body of [{}, {route: 'Cloud!'}, {route: 'cloud', destinationId: 'current'}, {route: 'cloud', extra: 1}, []])
    assert.equal((await call('PUT', '/current/route', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('POST', '/current/route', {route: 'lan'})).status, 200, 'the existing Android POST alias remains supported');
  denied = ['projects:write'];
  assert.equal((await call('PUT', '/current/route', {route: 'lan'})).status, 403);
  assert.equal((await call('PUT', '/current/mcp', {backend: 'mcp-3d-printer-server'})).status, 403);
  denied = [];
  assert.equal((await call('GET', '/elsewhere/route')).status, 404);

  // A project printing there: the connection stays as it is (409), and the MCP call is never made.
  await f.store.update(f.object.id, o => ({...o, state: 'printing'}));
  const before = f.calls.filter(c => c.name === 'counterpart_print_route').length;
  const refused = await call('PUT', '/current/route', {route: 'lan'});
  assert.equal(refused.status, 409);
  assert.match(refused.json.error.message, /printing/);
  assert.equal(f.calls.filter(c => c.name === 'counterpart_print_route').length, before);
  await f.store.update(f.object.id, o => ({...o, state: 'ready'}));
  // A print started outside Counterpart since the last read (the cache still says ready): the change reads the
  // printer live and is refused too, without calling the MCP's route tool.
  assert.equal(await f.directory.printing('current'), false);
  f.queue.splice(0, f.queue.length, status('RUNNING', 4));
  const outside = f.calls.filter(c => c.name === 'counterpart_print_route').length;
  assert.equal((await call('PUT', '/current/route', {route: 'lan'})).status, 409);
  assert.equal(f.calls.filter(c => c.name === 'counterpart_print_route').length, outside);
  f.queue.splice(0, f.queue.length, status('IDLE', 0));
  assert.equal((await call('PUT', '/current/route', {route: 'cloud'})).status, 200, 'and allowed once it is idle again');

  // Printer MCP: the companion's own chooseMcp, its refusals as HTTP statuses.
  const mcp = await call('PUT', '/current/mcp', {backend: 'mcp-3d-printer-server'});
  assert.deepEqual([mcp.status, mcp.json, chosen], [200, {destinationId: 'clone-1'}, ['mcp-3d-printer-server']]);
  setupBusy = true;
  assert.equal((await call('PUT', '/current/mcp', {backend: 'bambu-printer-mcp'})).status, 409);
  setupBusy = false;
  assert.equal((await call('PUT', '/elsewhere/mcp', {backend: 'bambu-printer-mcp'})).status, 404);
  assert.equal((await call('PUT', '/current/mcp', {backend: 'octoprint'})).status, 400);
  assert.equal((await call('GET', '/current/mcp')).status, 405);

  // An MCP without the choice: null to read, and nothing to change.
  const none = await setup(t, {});
  const plain = createObjectRoutes(none.service);
  const other = createServer((request, response) => void plain.handle(request, response, async () => {}, () => undefined));
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const otherBase = `http://127.0.0.1:${other.address().port}/v1/objects/printers/current`;
  assert.deepEqual(await (await fetch(`${otherBase}/route`)).json(), {route: null});
  assert.equal((await fetch(`${otherBase}/route`, {method: 'PUT', body: JSON.stringify({route: 'cloud'})})).status, 409);
  assert.equal((await fetch(`${otherBase}/mcp`, {method: 'PUT', body: JSON.stringify({backend: 'bambu-printer-mcp'})})).status, 503, 'a companion without printer setup says so');

  // The Mac's own path refuses mid-print the same way.
  await f.store.update(f.object.id, o => ({...o, state: 'printing'}));
  await assert.rejects(f.service.printRoute('current', 'lan'), InvalidStateError);
  assert.equal((await f.service.printRoute('current')).route, 'cloud', 'reading is fine while it prints');
});

test('status.get says whether this companion has the phone\'s printer choices', async t => {
  const f = await setup(t, {});
  const auth = {transport: 'lan', listDevices: async () => []};
  const without = createControlDispatcher({auth, companionVersion: 'test', objects: f.service});
  assert.equal((await without('status.get', {})).capabilities.printerChoices, false);
  const withSetup = createControlDispatcher({auth, companionVersion: 'test', objects: f.service, printerSetup: {chooseMcp: async () => ({destinationId: 'current'})}});
  assert.equal((await withSetup('status.get', {})).capabilities.printerChoices, true);
});

// Nov 3: Bambu Handy resumed a pick after Counterpart's Resume was refused, and the activity said "Printing again."
test('a resume Counterpart did not send is logged as outside Counterpart; its own Resume keeps "Printing again."', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  const lines = async () => (await f.service.get(f.object.id)).print.events.map(e => e.message);
  const step = async (report, line) => {
    const before = (await lines()).length;
    f.queue.length = 0; f.queue.push(report);
    // The second pause must be observed before Resume; the first pause's identical text is not a receipt.
    await until(async () => { await f.tick(); return (await lines()).slice(before).includes(line) ? true : undefined; });
  };
  await step(status('PAUSE', 20), 'The printer paused it.');
  await step(status('RUNNING', 30), 'Resumed outside Counterpart (on the printer or another app).');
  assert.equal((await lines()).includes('Printing again.'), false);

  await step(status('PAUSE', 40), 'The printer paused it.');
  const resuming = f.service.control(f.object.id, 'resume');
  const question = await until(async () => (await f.service.get(f.object.id)).printConfirmation);
  await f.service.answerPrintConfirmation(f.object.id, question.id, {action: 'accept', content: {confirmed: true}});
  await resuming;
  await step(status('RUNNING', 50), 'Printing again.');
});

test('an MCP that reports AMS trays in the counterpart/1 slots shape (mcp-3D-printer-server) gets filament choices like bambu-printer-mcp', async t => {
  const info = {contract: 'counterpart/1', server: {name: 'mcp-3d-printer-server', version: '1.2.26'}, printer: {kind: 'bambu', host: '192.0.2.1', model: 'P1S'},
    capabilities: {progress: true, layers: true, camera: 'none', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true}};
  const profile = '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament/Bambu PLA Basic @BBL P1S 0.4 nozzle.json';
  const f = await setup(t, {backend: 'mcp-3d-printer-server', info, tools: ['counterpart_print_progress', 'get_printer_filaments', 'counterpart_printer_info', 'slice_stl'], slots: [
    {id: '0', material: 'PLA', color: '#000000', name: 'PLA Basic PLA #000000', source: 'printer', profile},
    {id: '1', material: 'PLA', color: '#FEC600', name: 'PLA Basic PLA #fec600', source: 'printer', profile},
    {id: '9', material: 'PLA', color: 'yellow', source: 'printer', profile},
    {id: 'ext', material: 'PETG', color: '#FFFFFF', source: 'unknown', profile: 'relative.json'}]});
  // The runner reads get_printer_filaments through the MCP; here it answers in the contract's slots shape.
  const runner = f.deps.print.services.runner;
  runner.backend = 'mcp-3d-printer-server';
  runner.filaments = async () => ({slots: f.slots});
  const choices = await f.service.filaments(f.object.id);
  assert.deepEqual(choices.map(choice => [choice.slot, choice.colour, choice.material, !!choice.suggested]), [[0, '#000000', 'PLA', true], [1, '#FEC600', 'PLA', false]],
    'well-formed trays only: a colour name or a relative profile is dropped');
});

test('a spool the MCP names with an eight-digit colour round-trips as the same spool; nothing loaded refuses in the MCP\'s words (Codex, #341)', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await multipart(f, {bytes: twoPart3mf(), filaments: [{colour: '#000000'}, {colour: '#FEC600'}]});
  const runner = f.deps.print.services.runner;
  runner.filaments = async () => ({slots: [
    {id: '0', material: 'PLA', color: '#000000FF', name: 'Black PLA Basic', label: 'A1', source: 'printer', profile: '/p/pla.json'},
    {id: '1', material: 'PLA', color: '#FEC600FF', name: 'Sunflower Yellow PLA Basic', label: 'A2', source: 'printer', profile: '/p/pla.json'}]});
  const mapping = await f.service.colourMapping(f.object.id);
  assert.deepEqual(mapping.trays.map(tray => tray.colour), ['#000000FF', '#FEC600FF'], 'the MCP\'s colour, unchanged, is the spool\'s identity');
  await f.service.estimate(f.object.id, {filaments: [mapping.trays[0], mapping.trays[1]], filamentsModelVersion: mapping.modelVersion});
  assert.equal(f.runs.at(-1).estimate.slicer.filamentColours, '#000000;#FEC600', 'the slicer still gets #RRGGBB');
  // The same spools through the requests the clients send (control socket and phone HTTP share these schemas).
  const dispatch = createControlDispatcher({auth: {}, companionVersion: 'test', objects: f.service});
  // The request schema refuses invalid parameters with `invalid-request` before the service sees them.
  const viaSocket = await dispatch('objects.estimate', {id: f.object.id, filaments: [mapping.trays[0], mapping.trays[1]], filamentsModelVersion: mapping.modelVersion});
  assert.equal(viaSocket.seconds, 3420, 'an eight-digit spool is a valid choice through the request schema');
  await assert.rejects(dispatch('objects.estimate', {id: f.object.id, filaments: [{...mapping.trays[0], colour: 'black'}, mapping.trays[1]], filamentsModelVersion: mapping.modelVersion}),
    /Invalid local control request/, 'only a colour in the MCP\'s hex format');
  // The MCP's refusal is never read by its code to fall back: it reaches the person as the MCP says it.
  runner.filaments = async () => ({slots: []});
  await assert.rejects(f.service.estimate(f.object.id, {}), /No filament is loaded/);
});

test('a control is sent only while the printer is still printing this project\'s job', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await until(() => f.events.some(e => e.type === 'print.started'));
  f.queue.length = 0;
  f.queue.push({state: 'printing', job: {name: 'someone else', progress: 3}, problems: []});
  await assert.rejects(f.service.control(f.object.id, 'cancel'), /isn't printing A mic mount for the stand any more, so nothing was sent/);
  assert.equal(f.calls.filter(c => c.name === 'cancel_print').length, 0);
});

test('"What\'s loaded?" on Bambu prints from a spool of that material with its profile, and never slices it with another material\'s', async t => {
  const f = await setup(t);
  // A loaded PETG spool: print from it with its own profile.
  await f.service.print(f.object.id, {colour: {material: 'petg'}});
  const run = await until(() => f.runs.at(-1));
  assert.deepEqual(run.selection, {model: 'p1s', material: 'PETG', useAms: true, amsSlots: [0], autoMatchAms: false});
  assert.equal(run.options.slicer.loadFilaments, '/p/petg.json');
  await f.approve();
  await f.service.settled(f.object.id);
  // No spool reports ASA: refused with what to do, nothing sliced or sent (the preset would slice it as PLA).
  const g = await setup(t);
  await assert.rejects(g.service.print(g.object.id, {colour: {material: 'ASA'}}), /doesn't report a ASA spool\. Set the external spool to ASA on the printer/);
  assert.equal(g.runs.length, 0);
  assert.equal((await g.service.get(g.object.id)).state, 'ready');
  assert.equal(g.directory.capabilities('current').materialChoice, true);
});

test('an event\'s frame is served from the project folder, and every object carries its status line', async t => {
  const f = await setup(t);
  const eventId = '00000000-0000-4000-8000-000000000011', printId = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
  await mkdir(join(f.service.dir(f.object.id), 'prints', printId, 'frames'), {recursive: true});
  await writeFile(join(f.service.dir(f.object.id), 'prints', printId, 'frames', `${eventId}.jpg`), JPEG);
  const routes = createObjectRoutes(f.service);
  const scopes = [];
  const server = createServer((request, response) => void routes.handle(request, response, async scope => { scopes.push(scope); }, () => undefined));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/objects/${f.object.id}`;
  const frame = await fetch(`${base}/prints/${printId}/frames/${eventId}.jpg`);
  assert.equal(frame.status, 200);
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), JPEG);
  assert.equal((await fetch(`${base}/prints/${printId}/frames/00000000-0000-4000-8000-000000000012.jpg`)).status, 404);
  assert.equal((await fetch(`${base}/prints/../frames/x.jpg`)).status, 404);
  assert.deepEqual(scopes, ['projects:read', 'projects:read']);
  const {object} = await (await fetch(base)).json();
  assert.deepEqual(object.status, {phase: 'ready', text: 'Ready to print', symbol: 'checkmark.seal', tint: 'accent'});
});

test('a Done project prints again without "checked", with copies, and comes back Done; hiding keeps Done', async t => {
  const f = await setup(t, {copies: true, reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  // It was printed elsewhere (or sent) and marked Works by hand: an old uncertain flag doesn't stop a reprint.
  await f.store.update(f.object.id, o => ({...o, state: 'sent', print: {bundleId: 'old', uncertain: true}}));
  const marked = await f.service.setStatus(f.object.id, 'works');
  assert.deepEqual([marked.state, marked.print.uncertain], ['confirmed', undefined]);
  const {objectStatus} = await import('../dist/events/words.js');
  assert.equal(objectStatus(marked).text, 'Done · it works');
  // Hide from Home keeps Done, and showing it again leaves it Done.
  const {projectStatus} = await import('../dist/objects/service.js');
  const hidden = await f.service.setArchived(f.object.id, true);
  assert.deepEqual([hidden.archived, hidden.state, projectStatus(hidden)], [true, 'confirmed', 'works']);
  const shown = await f.service.setArchived(f.object.id, false);
  assert.deepEqual([shown.archived, shown.state], [undefined, 'confirmed']);
  // Print two more.
  const printing = await f.service.print(f.object.id, {copies: 2});
  assert.equal(printing.state, 'printing');
  const run = await until(() => f.runs.find(entry => entry.id === printing.print.bundleId));
  assert.equal(run.options.slicer.repetitions, 2);
  assert.equal(printing.print.settings.copies, 2);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.equal(done.state, 'confirmed', 'a known-good part is still known-good');
  assert.equal(projectStatus(done), 'works');
});

test('after changes, the next finished print asks "Did it fit?" again: needs-changes ends with it', async t => {
  const f = await setup(t, {reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  await f.store.update(f.object.id, o => ({...o, state: 'printed'}));
  const marked = await f.service.setStatus(f.object.id, 'needs-changes');
  const {projectStatus} = await import('../dist/objects/service.js');
  assert.equal(projectStatus(marked), 'needs-changes');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 4; i++) await f.tick();
  const done = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.deepEqual([done.state, done.outcome, projectStatus(done)], ['printed', undefined, 'printed']);
});

test('copies reach the estimate and the print only where the MCP takes them, and the flag says so', async t => {
  const f = await setup(t, {sliceArgs: true});
  // This fixture's slice_stl has no repetitions: refused with the update, before anything is sliced.
  await assert.rejects(f.service.estimate(f.object.id, {copies: 2}), /copies/);
  await assert.rejects(f.service.print(f.object.id, {copies: 2}), /copies/);
  assert.equal(f.service.printCopiesAvailable, false);
  const estimate = await f.service.estimate(f.object.id, {});
  assert.equal('copies' in estimate, false);
  // An MCP that takes repetitions: the estimate covers every copy.
  const g = await setup(t, {copies: true});
  assert.equal(g.service.printCopiesAvailable, true);
  const two = await g.service.estimate(g.object.id, {copies: 2});
  assert.equal(two.copies, 2);
  assert.equal(g.runs.at(-1).estimate.slicer.repetitions, 2);
});

test('one copy named is sent as repetitions 1, so it overrides a printer profile set to 3, on Print and on Estimate', async t => {
  // The printer-handoff runner merges the profile's slicer under these overrides (printer-handoff.test.mjs checks that 1 wins).
  const f = await setup(t, {copies: true, reports: [status('PREPARE', 0), status('RUNNING', 3), status('FINISH', 100)]});
  await f.service.estimate(f.object.id, {copies: 1});
  assert.equal(f.runs.at(-1).estimate.slicer.repetitions, 1);
  // Not the cached answer for "nothing named": that one is the profile's own count.
  await f.service.estimate(f.object.id, {});
  assert.equal(f.runs.at(-1).estimate.slicer?.repetitions, undefined);
  const printing = await f.service.print(f.object.id, {copies: 1});
  const run = await until(() => f.runs.find(entry => entry.id === printing.print.bundleId));
  assert.equal(run.options.slicer.repetitions, 1);
  assert.equal(printing.print.settings?.copies, 1, 'an explicit one survives reprinting and saved defaults');
  await f.approve();
  await f.service.settled(f.object.id);
  // An MCP without repetitions: one copy is still fine (it slices one), never refused.
  const g = await setup(t, {sliceArgs: true});
  await g.service.estimate(g.object.id, {copies: 1});
  assert.equal(g.runs.at(-1).estimate.slicer.repetitions, 1);
  const plain = await g.service.print(g.object.id, {copies: 1});
  assert.equal(plain.state, 'printing');
  await g.approve();
  await g.service.settled(g.object.id);
});

test('the stove gap filler, end to end: "Getting ready" while it levels, then the printer stops it; failed in its own words, and prints again', async t => {
  // HMS 0300_0D00_0002_0001 at layer 0 of 52, 3 %, then the job is gone (the real abort of 2026-11-02, as counterpart_print_progress reports it).
  const levelling = {state: 'printing', job: {name: JOB, id: '0', progress: 3, remainingSec: 175 * 60, layer: 0, totalLayers: 52}, problems: [HMS]};
  const f = await setup(t, {reports: [status('PREPARE', 0), levelling, levelling, {state: 'idle', problems: [HMS]}]});
  const {objectStatus, eventWords} = await import('../dist/events/words.js');
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  await f.tick(); await f.tick();
  const getting = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.live?.job?.layer === 0 ? o : undefined; });
  assert.deepEqual([objectStatus(getting).phase, objectStatus(getting).text], ['preparing', 'Getting ready']);
  assert.equal(getting.print.printerStatus.percent, undefined, 'no percent while it gets ready');
  for (let i = 0; i < 2; i++) await f.tick();
  const failed = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  // The state really flips to failed, in the printer's own words (this report has only the code).
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'The printer stopped (0300_0D00_0002_0001).');
  assert.deepEqual(objectStatus(failed), {phase: 'failed', text: failed.failure, symbol: 'exclamationmark.triangle', tint: 'red'});
  const event = f.events.find(item => item.type === 'print.failed');
  assert.ok(event?.frame, 'with the camera frame');
  assert.equal(eventWords(event.type, event.data, {title: 'Stove gap filler', printer: 'Bambu Lab P1S'}).notify, 'timeSensitive');
  assert.equal(eventWords(event.type, event.data, {title: 'Stove gap filler', printer: 'Bambu Lab P1S'}).body, 'The printer stopped (0300_0D00_0002_0001).');
  // Print Again: a failed project with its model prints again.
  const again = await f.service.print(f.object.id);
  assert.equal(again.state, 'printing');
});

test('the failure sentence and code come from the report that ended the print (Codex repro: preparing, then idle with the code)', async t => {
  const f = await setup(t, {reports: [status('PREPARE', 0), {state: 'idle', problems: [HMS]}]});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  for (let i = 0; i < 2; i++) await f.tick();
  const failed = await until(async () => { const o = await f.service.get(f.object.id); return o.print?.monitor?.phase === 'ended' ? o : undefined; });
  assert.deepEqual([failed.state, failed.failure], ['failed', 'The printer stopped (0300_0D00_0002_0001).']);
  // The saved record is that ending report too, not the last one while it got ready.
  assert.deepEqual(failed.print.live.problems.map(problem => problem.code), ['0300_0D00_0002_0001']);
});


test('saved project defaults reach Print, and explicit Standard overrides a saved Fine default', async t => {
  const defaults = {quality: 'fine', strength: 'strong', colour: {amsSlot: 1}, copies: 3};
  const f = await setup(t, {sliceArgs: true, copies: true, reports: [status('IDLE', 0)]});
  await f.service.setProjectSettings(f.object.id, {printDefaults: defaults});
  assert.equal(f.runs.length, 0, 'saving defaults never starts a print');
  await f.service.print(f.object.id);
  const run = await until(() => f.runs.at(-1));
  assert.equal(run.options.slicer.quality, 'fine');
  assert.equal(run.options.slicer.strength, 'strong');
  assert.equal(run.options.slicer.layerHeightMm, undefined, 'no slicer numbers from the app');
  assert.equal(run.options.slicer.repetitions, 3);
  assert.deepEqual(run.selection.amsSlots, [1]);
  await f.approve(); await f.service.settled(f.object.id);
  const g = await setup(t, {sliceArgs: true, copies: true, reports: [status('IDLE', 0)]});
  await g.service.setProjectSettings(g.object.id, {printDefaults: defaults});
  await g.service.print(g.object.id, {quality: 'standard', strength: 'standard', copies: 1, colour: {auto: true}});
  const overridden = await until(() => g.runs.at(-1));
  assert.equal(overridden.options.slicer.quality, undefined, 'Standard sends nothing');
  assert.equal(overridden.options.slicer.strength, undefined);
  assert.equal(overridden.options.slicer.repetitions, 1);
  assert.equal(overridden.selection.autoMatchAms, true);
  await g.approve(); await g.service.settled(g.object.id);
});

test('problems-only projects retain print events without routine notification alerts', async t => {
  const f = await setup(t, {reports: [status('PREPARE', 0), status('RUNNING', 3), status('RUNNING', 51), status('FINISH', 100)]});
  await f.service.setProjectSettings(f.object.id, {notifications: 'problems'});
  await f.service.print(f.object.id); await f.approve(); await f.service.settled(f.object.id);
  for (let i = 0; i < 3; i++) await f.tick();
  await until(() => f.events.some(event => event.type === 'print.done'));
  for (const type of ['print.started', 'print.milestone', 'print.done']) {
    const event = f.events.find(event => event.type === type);
    assert.ok(event, type + ' remains in history');
    assert.equal(event.notify, 'none');
  }
  assert.equal(f.events.find(event => event.type === 'print.confirm').notify, undefined, 'questions still need an answer');
});


test('a one-copy-only destination can override an old saved count for Print and Estimate', async t => {
  const f = await setup(t, {sliceArgs: true, reports: [status('IDLE', 0)]});
  await f.service.setProjectSettings(f.object.id, {printDefaults: {copies: 3}});
  await f.service.estimate(f.object.id, {copies: 1});
  assert.equal(f.runs.at(-1).estimate.slicer.repetitions, 1);
  await f.service.print(f.object.id, {copies: 1});
  const run = await until(() => f.runs.find(entry => entry.options));
  assert.equal(run.options.slicer.repetitions, 1);
  assert.equal((await f.service.get(f.object.id)).preferences.printDefaults.copies, 3, 'the default remains available for a capable printer');
  await f.approve(); await f.service.settled(f.object.id);
});

test('a print the printer service refuses reaches the phone as an event (review item 23): "didn\'t start" with the reason, or a project update when it may have reached the printer', async t => {
  const f = await setup(t);
  const refusal = 'Error: Printer nozzle 0 type is unknown or does not match the job. Suggestion: A safety check stopped this before anything reached the printer.';
  // Refused before the print call: nothing can have reached the printer.
  f.deps.print.services.runner.runBundle = async () => { throw new PrinterMcpError('tool-failed', undefined, refusal); };
  await f.service.print(f.object.id);
  const refused = await f.service.settled(f.object.id);
  assert.deepEqual([refused.state, refused.failure], ['failed', refusal]);
  const event = f.events.find(item => item.type === 'print.not-started');
  assert.deepEqual([event?.projectId, event?.printId, event?.destinationId, event?.detail?.reason], [f.object.id, refused.print.printId, 'current', refusal]);
  // The print call was made and its answer is unclear: the phone is told the project changed, never that it didn't start.
  await reset(f);
  f.events.length = 0;
  f.deps.print.services.runner.runBundle = async (store, id) => { await store.setStatus(id, 'uncertain', 'dispatch-uncertain'); throw new PrinterMcpError('tool-failed', undefined, refusal); };
  await f.service.print(f.object.id);
  const unclear = await f.service.settled(f.object.id);
  assert.equal(unclear.state, 'failed');
  assert.equal(unclear.print.uncertain, true);
  assert.equal(f.events.some(item => item.type === 'print.not-started'), false);
  assert.deepEqual(f.events.filter(item => item.type === 'project.updated').map(item => [item.projectId, item.data]), [[f.object.id, {keys: ['print']}]]);
});

test('Print and Estimate leave reusing a slice to the printer MCP: Counterpart keeps no slice cache of its own', async t => {
  const f = await setup(t, {reports: [status('IDLE', 0)]});
  await f.service.estimate(f.object.id).catch(() => undefined);
  assert.equal('sliceCache' in (f.runs.find(run => run.estimate)?.estimate ?? {}), false);
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  assert.equal('sliceCache' in (f.runs.find(run => run.options)?.options ?? {}), false);
  // Only the slice the sheet showed is kept (slices/shown, what will print); no cache entries beside it.
  const kept = existsSync(join(f.store.dir(f.object.id), 'slices')) ? await readdir(join(f.store.dir(f.object.id), 'slices')) : [];
  assert.deepEqual(kept.filter(name => name !== 'shown'), []);
});

// A design pass from before Counterpart kept colour parts (#293): its out/ holds the merged touched.stl and a 3MF.
async function legacyPass(f, {model = STL, threeMf} = {}) {
  const dir = join(f.root, `pass-${Math.random().toString(16).slice(2)}`);
  await mkdir(join(dir, 'out'), {recursive: true});
  await writeFile(join(dir, 'out', 'touched.stl'), model);
  if (threeMf) await writeFile(join(dir, 'out', 'pick_2color.3mf'), threeMf);
  await f.store.update(f.object.id, o => ({...o, kind: 'fit', passes: [...o.passes, {startedAtMs: Date.now(), endedAtMs: Date.now(), status: 'improved', dir}]}));
}
const oneFilamentAssembly = () => {
  const {zipSync, strToU8} = fflate();
  return Buffer.from(zipSync({'[Content_Types].xml': strToU8('<Types/>'),
    '3D/3dmodel.model': strToU8('<model><resources><object id="1"><mesh/></object></resources><build><item objectid="1"/></build></model>'),
    'Metadata/model_settings.config': strToU8('<config><object id="3"><metadata key="extruder" value="1"/>'
      + '<part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part><part id="2" subtype="normal_part"><metadata key="extruder" value="1"/></part></object></config>')}));
};

test('a colour design from before colour parts asks before printing; making it again sends nothing and starts that pass', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)]});
  await legacyPass(f, {threeMf: twoPart3mf()});
  await f.service.print(f.object.id);
  await f.approve();
  await f.service.settled(f.object.id);
  const ask = f.runs[0].options.ask;
  assert.equal(ask?.proceed, 'one-colour', 'Print asks first, and only "one colour" prints the merged model');
  assert.deepEqual(ask.choices.map(choice => choice.value), ['one-colour', 'remake']);
  assert.match(ask.message, /several colours.*one colour/);
  assert.equal((await f.deps.print.services.store.read(f.runs[0].id)).cleanStl?.file, 'clean.stl', 'the merged STL is what prints when the person chooses it');

  // "Make it again in colour": nothing is sliced or sent, the phone hears why, and the person's message starts the pass.
  const g = await setup(t);
  await legacyPass(g, {threeMf: twoPart3mf()});
  const touchups = [];
  g.deps.runTouchup = async input => { touchups.push(input); throw new Error('test: stop the pass here'); };
  g.deps.print.services.runner.runBundle = async (_store, _id, options) => { g.runs.push({options}); throw new PrinterMcpError('print-choice', undefined, 'remake'); };
  await g.service.print(g.object.id);
  await g.service.settled(g.object.id);
  const stopped = g.events.find(event => event.type === 'print.not-started');
  assert.equal(stopped?.detail?.reason, 'Not printed. Making it again in colour.');
  const remade = await until(async () => (await g.service.get(g.object.id)).messages?.find(message => /again in the colours it was designed with/.test(message.text)));
  assert.ok(remade, 'the choice is sent as the person\'s own change request');
  await until(() => touchups.length > 0);
  assert.equal(touchups.length, 1, 'one design pass, started by the choice');
});

test('no colour question for a one-colour assembly, or once a later redesign made the model', async t => {
  const assembly = await setup(t, {reports: [status('RUNNING', 10)]});
  await legacyPass(assembly, {threeMf: oneFilamentAssembly()});
  await assembly.service.print(assembly.object.id);
  await assembly.approve();
  await assembly.service.settled(assembly.object.id);
  assert.equal(assembly.runs[0].options.ask, undefined, 'parts on one filament are an ordinary one-colour model');

  const redesigned = await setup(t, {reports: [status('RUNNING', 10)]});
  await legacyPass(redesigned, {model: Buffer.concat([STL, Buffer.from(' ')]), threeMf: twoPart3mf()});
  await legacyPass(redesigned, {});
  await redesigned.service.print(redesigned.object.id);
  await redesigned.approve();
  await redesigned.service.settled(redesigned.object.id);
  assert.equal(redesigned.runs[0].options.ask, undefined, 'only the pass that made the current model counts');
});

test('Print sends exactly the file the sheet previewed; without that preview, or with changed settings, nothing is sent (Nov 5)', async t => {
  const f = await setup(t, {reports: [status('RUNNING', 10)], sliceArgs: true});
  await assert.rejects(f.service.printUnshown(f.object.id), /Open Print to see what will print/);
  assert.equal(f.runs.filter(run => run.id).length, 0, 'nothing dispatched without a preview');
  const shown = await f.service.estimate(f.object.id);
  assert.match(shown.sliceSha256, /^[0-9a-f]{64}$/);
  assert.equal(shown.preview.sha256, shown.sliceSha256);
  assert.deepEqual(shown.preview.views.map(view => view.name), ['top', 'bed_side']);
  await assert.rejects(f.service.printUnshown(f.object.id, {quality: 'fine', sliceSha256: shown.sliceSha256}), /settings changed since the preview/);
  await assert.rejects(f.service.printUnshown(f.object.id, {sliceSha256: 'f'.repeat(64)}), /Open Print to see what will print/);
  assert.equal(f.runs.filter(run => run.id).length, 0);
  await f.service.printUnshown(f.object.id, {sliceSha256: shown.sliceSha256});
  await f.approve();
  await f.service.settled(f.object.id);
  const dispatched = f.runs.find(run => run.id);
  assert.equal(dispatched.options.expectedSha256, shown.sliceSha256, 'the printer gets the previewed file, checked by its hash');
  assert.equal(createHash('sha256').update(dispatched.options.presliced.bytes).digest('hex'), shown.sliceSha256);
});

test('an MCP that cannot draw what will print is asked to update; nothing is sent', async t => {
  const f = await setup(t);
  showingRunner(f.deps.print.services.runner, {preview: false});
  const shown = await f.service.estimate(f.object.id);
  assert.equal(shown.preview, undefined);
  await assert.rejects(f.service.printUnshown(f.object.id, {sliceSha256: shown.sliceSha256}), /Update bambu-printer-mcp in Settings → Printers so Counterpart can show you what will print/);
  assert.equal(f.runs.filter(run => run.id).length, 0);
});

// David's kit (Nov 6): a MakerWorld STL holding six plates of parts, wider than his P1S. The MCP puts it on plates
// (slice_stl split_to_plates); its project 3MF joins the project with the MCP's plates, plate 1 is chosen, and the
// estimate the sheet gets is plate 1's. Choosing the STL again reuses the same file.
test('a downloaded model bigger than the bed joins the project as the MCP’s plates, and the estimate is plate 1’s', async t => {
  const f = await setup(t);
  const dir = f.store.dir(f.object.id);
  await mkdir(join(dir, 'original'), {recursive: true});
  await writeFile(join(dir, 'original', 'kit.stl'), STL);
  const stlSha = createHash('sha256').update(STL).digest('hex');
  const credit = {url: 'https://makerworld.com/en/models/1531561', designer: 'Kass 3D', site: 'MakerWorld', title: '3D scan platform'};
  await f.store.update(f.object.id, o => ({...o, kind: 'published', current: {model: 'original/kit.stl', renders: []},
    files: {original: ['original/kit.stl'], current: 'original/kit.stl', receipts: [{format: 'stl', sha256: stlSha, byteLength: STL.length, plates: [], path: 'original/kit.stl', name: 'kit.stl', credit}]},
    publishedSelection: {fileIndex: 0, plateIndex: 0, sliced: false}}));
  const plates3mf = Buffer.from('PK\x03\x04 the MCP\'s plates');
  const plates = [{index: 0, name: 'Plate 1', objects: ['Part 1']}, {index: 1, name: 'Plate 2', objects: ['Part 2', 'Part 3']}];
  const runner = f.deps.print.services.runner, seen = [];
  runner.estimate = async input => {
    seen.push({model: input.stlPath.slice(-4), splitToPlates: input.splitToPlates});
    if (input.stlPath.endsWith('.stl')) return {settings: {}, previewSupported: true,
      split: {bytes: plates3mf, plates, message: 'This model is bigger than the P1S bed (256 × 256 mm, 250 mm tall), so its 3 parts are arranged on 2 plates. Each plate prints on its own.'}};
    return {...shownSlice('plate 1'), estimate: {seconds: 3600, grams: 40}, settings: {layers: 10}, previewSupported: true};
  };
  const estimate = await f.service.estimate(f.object.id);
  assert.equal(estimate.seconds, 3600, "plate 1's estimate");
  assert.deepEqual(seen, [{model: '.stl', splitToPlates: true}, {model: '.3mf', splitToPlates: undefined}]);
  const object = await f.service.get(f.object.id);
  assert.equal(object.files.receipts.length, 2);
  const receipt = object.files.receipts[1];
  assert.deepEqual(receipt.plates, plates.map(plate => ({...plate, sliced: false})));
  assert.equal(receipt.name, 'kit (2 plates).3mf');
  assert.deepEqual(receipt.credit, credit, "the designer's credit stays with their parts");
  assert.deepEqual(await readFile(join(dir, receipt.path)), plates3mf);
  assert.equal(object.current.model, receipt.path);
  assert.deepEqual(object.publishedSelection, {fileIndex: 1, plateIndex: 0, sliced: false});
  // Each plate is offered in the project's plate list.
  const {projectPlates} = await import('../dist/objects/plates.js');
  assert.deepEqual(projectPlates(object).filter(plate => plate.fileIndex === 1).map(plate => [plate.name, plate.selected]), [['Plate 1', true], ['Plate 2', false]]);
  // The STL chosen again: the same plates file, selected again, never a second copy.
  await f.service.selectPlate(f.object.id, 0, 0);
  await f.service.estimate(f.object.id);
  const again = await f.service.get(f.object.id);
  assert.equal(again.files.receipts.length, 2);
  assert.deepEqual(again.publishedSelection, {fileIndex: 1, plateIndex: 0, sliced: false});
});

test('a part bigger than the bed reaches the sheet as the MCP’s sentence', async t => {
  const f = await setup(t);
  const sentence = 'Part 2 is 300 × 120 mm and 40 mm tall, larger than the P1S bed (256 × 256 mm, 250 mm tall), so it can\'t be printed on it as it is. Scale it down or cut it into pieces that fit.';
  f.deps.print.services.runner.estimate = async () => { throw new PrinterMcpError('slicer-error', new Error('raw words'), sentence); };
  await assert.rejects(f.service.estimate(f.object.id), error => error.name === 'SlicerRefusedError' && error.message === sentence);
});
