// #799: Export Diagnostics' companion part. The event log's tail, the printers and their printer software, and each
// printer MCP's own bundle (counterpart_diagnostics, when its counterpart_printer_info advertises it), redacted and
// size-capped; an MCP too old for it gets one line.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {DIAGNOSTICS_LIMITS, diagnosticsBundle, directorySource, redact, tail} from '../dist/diagnostics.js';
import {createControlDispatcher} from '../dist/local-control-services.js';
import {methodDeadlineMs} from '../dist/local-control.js';
import {parameters} from '../dist/local-control-protocol.js';

const ACCESS_CODE = '31415926';
const TOKEN = 'tok3nSynthetic9Value';
const EMAIL = 'tester.person@example.com';
const tool = name => ({name, inputSchema: {type: 'object', properties: name === 'counterpart_diagnostics' ? {max_bytes: {type: 'number'}} : {}}});
const info = (version, diagnostics) => ({contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version}, printer: {kind: 'bambu', host: '192.0.2.7', serial: '01P00A123456789'},
  capabilities: {progress: true, layers: true, camera: 'bambu-tcp', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true,
    ...(diagnostics === undefined ? {} : {diagnostics})}});

/** A printer's session whose MCP answers as given; `calls` records each tool call and its arguments. */
function session(id, {backend = 'bambu-printer-mcp', version = '1.1.90', diagnostics, bundle, down = false, env = {BAMBU_ACCESS_CODE: ACCESS_CODE}} = {}) {
  const calls = [];
  const tools = [tool('counterpart_printer_info'), ...(diagnostics ? [tool('counterpart_diagnostics')] : [])];
  const factory = () => ({
    catalog: undefined,
    async connect() { if (down) throw Object.assign(new Error('connection refused'), {code: 'connection-failed'}); this.catalog = {server: {name: backend, version}, tools}; return this.catalog; },
    hasTool(name) { return tools.some(item => item.name === name); },
    getTool(name) { return tools.find(item => item.name === name); },
    async callTool(name, args) {
      calls.push({name, args});
      if (name === 'counterpart_printer_info') return {content: [{type: 'text', text: JSON.stringify(info(version, diagnostics))}]};
      const value = typeof bundle === 'function' ? bundle(args) : bundle;
      return {structuredContent: value, content: [{type: 'text', text: JSON.stringify(value)}]};
    },
    async close() {},
  });
  return {calls, session: new PrinterSession(id, {backend, process: {command: '/usr/bin/true', env}}, {clientFactory: factory})};
}

async function fixture(t, events) {
  const root = await mkdtemp(join(tmpdir(), 'stm-diag-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const eventsPath = join(root, 'events.ndjson');
  if (events !== undefined) await writeFile(eventsPath, events);
  return {root, eventsPath};
}

const SOFTWARE = [{package: 'bambu-printer-mcp', label: 'bambu-printer-mcp', description: 'x', installed: true, version: '1.1.90', latestVersion: '1.1.92', available: '1.1.92',
  appMcpId: 'mcp-0123456789abcdef', installs: [{kind: 'app', path: '/Users/tester/Library/Application Support/Scan to Make/printers/bambu', version: '1.1.90'}],
  uses: [{destinationId: 'p1s', printerId: 'p1s', printer: 'P1S', mcpId: 'mcp-0123456789abcdef', kind: 'app', version: '1.1.90', canMove: false, managed: true, words: 'P1S uses Counterpart’s copy (1.1.90).'}],
  moves: [], usedBy: ['P1S']},
  {package: 'mcp-3d-printer-server', label: 'mcp-3D-printer-server', description: 'y', installed: false, appMcpId: 'mcp-fedcba9876543210', installs: [], uses: [], moves: [], usedBy: [], upToDate: true}];
const file = (bundle, name) => bundle.files.find(item => item.name === name);

test('the bundle has the event log tail, the printers and the printer software, and an advertised MCP bundle', async t => {
  const {eventsPath} = await fixture(t, '{"seq":1,"type":"print.started","words":"Printing on P1S"}\n{"seq":2,"type":"print.finished"}\n');
  const p1s = session('p1s', {diagnostics: true, bundle: {package: 'bambu-printer-mcp', version: '1.1.90',
    files: [{name: 'server.json', content: '{"version":"1.1.90"}', truncated: false}, {name: 'fulu/control-trace.log', content: 'mqtt connected serial=01P00A123456789\n', truncated: true}],
    notes: ['native helper logs: none']}});
  const directory = {catalog: {destinations: [{id: 'p1s', name: 'P1S', backend: 'bambu-printer-mcp', model: 'p1s', address: '192.0.2.7'}]},
    nameOf: () => 'Bambu Lab P1S', lastState: () => 'ready', capabilities: () => ({server: {version: '1.1.90'}, contract: 'counterpart/1'}),
    session: id => id === 'p1s' ? p1s.session : undefined};
  const bundle = await diagnosticsBundle({eventsPath, home: '/Users/tester', software: async () => SOFTWARE, ...directorySource(directory)});

  assert.match(file(bundle, 'events-tail.ndjson').content, /print\.finished/);
  const printers = JSON.parse(file(bundle, 'printers.json').content);
  assert.deepEqual(printers, [{id: 'p1s', name: 'Bambu Lab P1S', model: 'p1s', address: '192.0.2.7', state: 'ready', mcp: 'bambu-printer-mcp', mcpVersion: '1.1.90', contract: 'counterpart/1'}]);
  const software = JSON.parse(file(bundle, 'printer-software.json').content);
  assert.deepEqual(software.map(item => [item.package, item.version, item.updateAvailable, item.usedBy]),
    [['bambu-printer-mcp', '1.1.90', '1.1.92', ['P1S']], ['mcp-3D-printer-server', undefined, undefined, []]]);
  assert.equal(software[0].installs[0].path, '~/Library/Application Support/Scan to Make/printers/bambu', 'the home folder reads ~');
  assert.equal(software[0].uses[0].words, 'P1S uses Counterpart’s copy (1.1.90).');
  // The MCP's own files, under its printer's folder, named as the MCP named them.
  assert.equal(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp/server.json').content, '{"version":"1.1.90"}');
  assert.equal(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp/fulu/control-trace.log').truncated, true);
  assert.match(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp/fulu/control-trace.log').content, /01P00A123456789/, 'serials stay');
  assert.ok(bundle.notes.includes('bambu-printer-mcp for Bambu Lab P1S: native helper logs: none'));
  assert.deepEqual(p1s.calls.map(call => call.name), ['counterpart_printer_info', 'counterpart_diagnostics']);
  assert.deepEqual(p1s.calls[1].args, {max_bytes: DIAGNOSTICS_LIMITS.mcpEachBytes}, 'one printer gets one MCP\'s full share; only max_bytes is passed');
});

test('an MCP that doesn\'t advertise diagnostics gets one line, and is never asked for them', async t => {
  const {eventsPath} = await fixture(t, '');
  const old = session('old', {version: '1.1.52', diagnostics: undefined});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'old', printer: 'A1 mini', session: old.session}]});
  assert.deepEqual(bundle.notes, ['bambu-printer-mcp 1.1.52 is too old to add its own diagnostics; update it in Settings → Printers.']);
  assert.deepEqual(old.calls.map(call => call.name), ['counterpart_printer_info']);
  assert.ok(!bundle.files.some(item => item.name.startsWith('mcp/')));
});

test('a printer MCP that can\'t start, or a missing event log, is a note and the rest of the bundle still comes', async t => {
  const {eventsPath} = await fixture(t); // no events.ndjson
  const down = session('down', {backend: 'mcp-3d-printer-server', down: true});
  const ok = session('ok', {diagnostics: true, bundle: {package: 'bambu-printer-mcp', version: '1.1.90', files: [{name: 'server.json', content: '{}', truncated: false}], notes: []}});
  const bundle = await diagnosticsBundle({eventsPath, software: async () => { throw new Error('npm is slow'); },
    sessions: () => [{destinationId: 'down', printer: 'Ender', session: down.session}, {destinationId: 'ok', printer: 'P1S', session: ok.session}]});
  assert.ok(bundle.notes.includes('There is no event log yet.'));
  assert.ok(bundle.notes.some(note => note.startsWith('mcp-3D-printer-server for Ender (down) didn\'t give its diagnostics: ')), bundle.notes.join('\n'));
  assert.ok(bundle.notes.includes('The printer software list couldn\'t be read (npm is slow).'));
  assert.ok(file(bundle, 'mcp/P1S-bambu-printer-mcp/server.json'));
  assert.deepEqual(ok.calls[1].args, {max_bytes: DIAGNOSTICS_LIMITS.mcpEachBytes}, '3 MiB shared by two printers is 1.5 MiB each');
});

test('no access code, token or email comes out, from the event log, the MCP\'s files or its notes; hosts and serials stay', async t => {
  const events = [
    `{"seq":1,"type":"pairing.created","data":{"login":"${EMAIL}"}}`,
    `{"seq":2,"type":"mcp.log","detail":"connect mqtts://bblp:${ACCESS_CODE}@192.0.2.7:8883 code ${ACCESS_CODE}"}`,
    `{"seq":3,"type":"auth","detail":"Authorization: Bearer ${TOKEN}","token":"${TOKEN}","refresh_token":"${TOKEN}"}`,
    `token=${TOKEN} api_key=${TOKEN} accessCode: ${ACCESS_CODE} owner ${EMAIL}`,
    `{"escaped":"{\\"accessCode\\":\\"${ACCESS_CODE}\\",\\"apiKey\\":\\"${TOKEN}\\"}"}`,
    `Cookie: session=${TOKEN}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  ].join('\n') + '\n';
  const {eventsPath} = await fixture(t, events);
  const leaky = session('p1s', {diagnostics: true, env: {BAMBU_ACCESS_CODE: ACCESS_CODE, BAMBU_TOKEN: TOKEN}, bundle: {package: 'bambu-printer-mcp', version: '1.1.90',
    files: [{name: 'fulu/control-trace.log', content: `serial=01P00A123456789 host=192.0.2.7 code ${ACCESS_CODE} user ${EMAIL} bearer ${TOKEN}\n`, truncated: false}],
    notes: [`signed in as ${EMAIL} with ${ACCESS_CODE}`]}});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: leaky.session}]});
  const all = JSON.stringify(bundle);
  for (const secret of [ACCESS_CODE, TOKEN, EMAIL, 'sk-ant-api03', 'eyJhbGciOiJIUzI1NiJ9', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC']) assert.ok(!all.includes(secret), `${secret} leaked:\n${all}`);
  for (const kept of ['01P00A123456789', '192.0.2.7', 'pairing.created', 'mqtts://']) assert.ok(all.includes(kept), `${kept} should stay`);
});

test('redact keeps ordinary words and numbers', () => {
  const line = '{"seq":12,"type":"pass.started","passIndex":2,"layer":40,"words":"Printing on P1S"} host=192.0.2.7 version 1.1.90';
  assert.equal(redact(line), line);
  // A real event's words (Nov 14 real-data check): "authenticate:" is prose, not a key.
  const prose = '"body":"Failed to authenticate: Claude login reached its time limit"';
  assert.equal(redact(prose), prose);
  for (const secret of ['auth: s3cretvalue', 'AUTH_TOKEN=s3cretvalue', '"auth":"s3cretvalue"', 'authKey=s3cretvalue', 'Authorization: s3cretvalue'])
    assert.ok(!redact(secret).includes('s3cretvalue'), secret);
});

test('size caps: the event log keeps its newest whole lines, an MCP past max_bytes is cut, and the whole answer fits', async t => {
  const line = n => `{"seq":${n},"type":"x","words":"${'w'.repeat(80)}"}`;
  const {eventsPath} = await fixture(t, Array.from({length: 4000}, (_, i) => line(i)).join('\n') + '\n');
  const greedy = session('p1s', {diagnostics: true, bundle: args => ({package: 'bambu-printer-mcp', version: '1.1.90',
    files: [{name: 'server-stderr.log', content: Array.from({length: 2000}, (_, i) => `line ${i} ${'s'.repeat(90)}`).join('\n') + '\n', truncated: false}],
    notes: [`asked for ${args.max_bytes}`]})});
  const limits = {eventsBytes: 50_000, mcpBytes: 40_000, mcpEachBytes: 40_000, mcpMinBytes: 1000, replyBytes: 1_000_000};
  const bundle = await diagnosticsBundle({eventsPath, limits, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: greedy.session}]});
  const events = file(bundle, 'events-tail.ndjson');
  assert.equal(events.truncated, true);
  assert.ok(Buffer.byteLength(events.content) <= 50_000);
  assert.match(events.content, /^\{"seq":\d+,/, 'starts at a whole line');
  assert.match(events.content, /"seq":3999,/, 'keeps the newest');
  const stderr = file(bundle, 'mcp/P1S-bambu-printer-mcp/server-stderr.log');
  assert.equal(stderr.truncated, true);
  assert.ok(Buffer.byteLength(stderr.content) <= 40_000, 'the MCP\'s answer is held to what was asked');
  assert.match(stderr.content, /line 1999 /);
  assert.deepEqual(greedy.calls[1].args, {max_bytes: 40_000});
  // The whole reply: the largest file gives way until it fits.
  const small = await diagnosticsBundle({eventsPath, limits: {...limits, replyBytes: 20_000}, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: greedy.session}]});
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 20_000);
  assert.ok(file(small, 'events-tail.ndjson').content.length > 0, 'both still carry their newest lines');
  assert.ok(file(small, 'mcp/P1S-bambu-printer-mcp/server-stderr.log').content.length > 0);
});

test('an MCP file name that could leave its folder is left out with a note', async t => {
  const {eventsPath} = await fixture(t, '');
  const bad = session('p1s', {diagnostics: true, bundle: {package: 'bambu-printer-mcp', version: '1.1.90',
    files: [{name: '../../etc/passwd', content: 'x', truncated: false}, {name: '/abs.log', content: 'x', truncated: false}, {name: 'ok.log', content: 'fine', truncated: false}], notes: []}});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: bad.session}]});
  assert.deepEqual(bundle.files.map(item => item.name), ['events-tail.ndjson', 'mcp/P1S-bambu-printer-mcp/ok.log']);
  assert.equal(bundle.notes.filter(note => note.includes('named a file this export can\'t use')).length, 2);
});

test('tail starts at a whole line', () => {
  assert.deepEqual(tail('aaa\nbbb\nccc\n', 6), {content: 'ccc\n', truncated: true});
  assert.deepEqual(tail('short', 100), {content: 'short', truncated: false});
});

test('diagnostics.bundle is a control method with its own 45 s deadline, answered by the companion\'s bundle', async () => {
  assert.ok(Object.hasOwn(parameters, 'diagnostics.bundle'));
  assert.equal(methodDeadlineMs('diagnostics.bundle', {}), 45_000);
  const expected = {files: [{name: 'events-tail.ndjson', content: '', truncated: false}], notes: []};
  const dispatch = createControlDispatcher({auth: {}, companionVersion: '0.1.0', diagnostics: async () => expected});
  assert.deepEqual(await dispatch('diagnostics.bundle', {}), expected);
  const without = createControlDispatcher({auth: {}, companionVersion: '0.1.0'});
  await assert.rejects(without('diagnostics.bundle', {}), error => error.code === 'unavailable');
});
