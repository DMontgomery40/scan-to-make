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
  assert.equal(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp-p1s/server.json').content, '{"version":"1.1.90"}');
  assert.equal(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp-p1s/fulu/control-trace.log').truncated, true);
  assert.match(file(bundle, 'mcp/Bambu-Lab-P1S-bambu-printer-mcp-p1s/fulu/control-trace.log').content, /01P00A123456789/, 'serials stay');
  assert.ok(bundle.notes.includes('bambu-printer-mcp for Bambu Lab P1S: native helper logs: none'));
  assert.deepEqual(p1s.calls.map(call => call.name), ['counterpart_printer_info', 'counterpart_diagnostics']);
  assert.deepEqual(p1s.calls[1].args, {max_bytes: DIAGNOSTICS_LIMITS.mcpEachBytes}, 'one printer gets one MCP\'s full share; only max_bytes is passed');
});

test('an MCP whose printer info answers without capabilities.diagnostics gets the same line, and isn\'t asked', async t => {
  const {eventsPath} = await fixture(t, '');
  const listed = session('old', {version: '1.2.70', diagnostics: undefined});
  listed.session.hasTool = name => name === 'counterpart_diagnostics' || name === 'counterpart_printer_info';
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'old', printer: 'Ender', session: listed.session}]});
  assert.deepEqual(bundle.notes, ['bambu-printer-mcp 1.2.70 is too old to add its own diagnostics; update it in Settings → Printers.']);
  assert.deepEqual(listed.calls.map(call => call.name), ['counterpart_printer_info']);
});

test('an MCP that doesn\'t advertise diagnostics gets one line, and is never asked for them', async t => {
  const {eventsPath} = await fixture(t, '');
  const old = session('old', {version: '1.1.52', diagnostics: undefined});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'old', printer: 'A1 mini', session: old.session}]});
  assert.deepEqual(bundle.notes, ['bambu-printer-mcp 1.1.52 is too old to add its own diagnostics; update it in Settings → Printers.']);
  assert.deepEqual(old.calls.map(call => call.name), [], 'without the tool listed, nothing is asked');
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
  assert.ok(file(bundle, 'mcp/P1S-bambu-printer-mcp-ok/server.json'));
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
    // A line that names a secret is withheld whole (#839), its serial with it; a line that names none keeps its serial.
    files: [{name: 'fulu/control-trace.log', content: `printer serial=01P00A123456789 host=192.0.2.7 ready\nserial=01P00A123456789 host=192.0.2.7 code ${ACCESS_CODE} user ${EMAIL} bearer ${TOKEN}\nkey sk-ant-api03-mcpfilesecretabcdefghij jwt eyJhbGciOiJIUzI1NiJ9.eyJtY3AiOiJmaWxlIn0.c2lnbWNwZmlsZQ\n`, truncated: false}],
    notes: [`signed in as ${EMAIL} with ${ACCESS_CODE}`]}});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: leaky.session}]});
  const all = JSON.stringify(bundle);
  assert.ok(events.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz') && events.includes('eyJhbGciOiJIUzI1NiJ9.'), 'the fixture plants a key and a JWT');
  for (const secret of [ACCESS_CODE, TOKEN, EMAIL, 'sk-ant-api03', 'eyJhbGciOiJIUzI1NiJ9', 'eyJtY3AiOiJmaWxlIn0', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC']) assert.ok(!all.includes(secret), `${secret} leaked:\n${all}`);
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
  const stderr = file(bundle, 'mcp/P1S-bambu-printer-mcp-p1s/server-stderr.log');
  assert.equal(stderr.truncated, true);
  assert.ok(Buffer.byteLength(stderr.content) <= 40_000, 'the MCP\'s answer is held to what was asked');
  assert.match(stderr.content, /line 1999 /);
  assert.deepEqual(greedy.calls[1].args, {max_bytes: 40_000});
  // The whole reply: the largest file gives way until it fits.
  const small = await diagnosticsBundle({eventsPath, limits: {...limits, replyBytes: 20_000}, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: greedy.session}]});
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 20_000);
  assert.ok(file(small, 'events-tail.ndjson').content.length > 0, 'both still carry their newest lines');
  assert.ok(file(small, 'mcp/P1S-bambu-printer-mcp-p1s/server-stderr.log').content.length > 0);
});

test('an MCP file name that could leave its folder is left out with a note', async t => {
  const {eventsPath} = await fixture(t, '');
  const bad = session('p1s', {diagnostics: true, bundle: {package: 'bambu-printer-mcp', version: '1.1.90',
    files: [{name: '../../etc/passwd', content: 'x', truncated: false}, {name: '/abs.log', content: 'x', truncated: false}, {name: 'ok.log', content: 'fine', truncated: false}], notes: []}});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: bad.session}]});
  assert.deepEqual(bundle.files.map(item => item.name), ['events-tail.ndjson', 'mcp/P1S-bambu-printer-mcp-p1s/ok.log']);
  assert.deepEqual(bundle.notes.filter(note => note.includes('this export can\'t use')), ['bambu-printer-mcp for P1S named 2 files this export can\'t use; they were left out.']);
});

test('safe markers stay: [set], empty values and whether a credential is set (a "won\'t connect" report needs them)', () => {
  const settings = '{\n  "BAMBU_ACCESS_CODE": "[set]",\n  "BAMBU_TOKEN": "",\n  "accessCodeSet": true,\n  "password": null\n}\nLAN_PASSWORD=\nNEXT_LINE=kept';
  assert.equal(redact(settings), settings);
  assert.ok(!redact('"BAMBU_ACCESS_CODE": "12345678"').includes('12345678'), 'an all-digit access code still goes');
  assert.ok(!redact('"accessCode": 12345678').includes('12345678'));
});

test('an MCP that lists counterpart_diagnostics but whose printer info can\'t be read (a printer that\'s away) is still asked', async t => {
  const {eventsPath} = await fixture(t, '');
  const away = session('p1s', {diagnostics: true, bundle: {package: 'mcp-3d-printer-server', version: '1.2.76', files: [{name: 'server.json', content: '{}', truncated: false}], notes: []}});
  const original = away.session.call.bind(away.session);
  // Its printer info times out asking the printer (mcp-3D-printer-server #117 with an OctoPrint that isn't there).
  away.session.call = async (name, args, options) => name === 'counterpart_printer_info' ? Promise.reject(Object.assign(new Error('MCP error -32001: Request timed out'), {code: 'tool-failed'})) : original(name, args, options);
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: away.session}]});
  assert.ok(!bundle.notes.some(note => note.includes('too old')), bundle.notes.join('\n'));
  assert.ok(bundle.notes.some(note => note.includes('printer info couldn\'t be read, so Counterpart asked for its diagnostics without it')), bundle.notes.join('\n'));
  assert.ok(file(bundle, 'mcp/P1S-bambu-printer-mcp-p1s/server.json'));
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

// #813 review: the reviewer's adversarial corpus, run against the redactor itself. Every case's secret must go.
test('the review\'s adversarial probes: no secret survives', async () => {
  const {readFileSync} = await import('node:fs');
  const {cases} = JSON.parse(readFileSync(new URL('./fixtures/redaction-probes.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 44);
  const leaks = cases.filter(({input, mustNotSurvive}) => redact(input, ['31415926'], '/Users/davidm').includes(mustNotSurvive));
  assert.deepEqual(leaks.map(item => `${item.label}: ${redact(item.input, ['31415926'], '/Users/davidm')}`), []);
});

test('secret names by their words: the codebase\'s own keys count, ordinary words don\'t', async () => {
  const {isSecretName} = await import('../dist/diagnostics.js');
  for (const name of ['SCAN_TO_MAKE_MODEL_KEY', 'SCAN_TO_MAKE_AI_KEY', 'SCAN_TO_MAKE_LAN_TLS_KEY', 'session_key', 'PAIRING_PIN', 'passphrase', 'X-Api-Key', 'accessToken', 'otp', '\\u0070assword', 'lan_code'])
    assert.ok(isSecretName(name), name);
  assert.ok(isSecretName('apiKeys'));
  assert.equal(redact('{"type":"settings.updated","data":{"keys":["general.autoUpdateMcps"]}}'), '{"type":"settings.updated","data":{"keys":["general.autoUpdateMcps"]}}');
  for (const name of ['keys', 'mapping', 'keyboard', 'authenticate', 'passIndex', 'spinning', 'hotplate', 'model', 'serial', 'host', 'code'])
    assert.ok(!isSecretName(name), name);
});

test('the companion\'s own secret values are swept wherever they appear, unlabelled', async t => {
  const MODEL_KEY = 'hf9f8e7d6c5b4a39281706';
  const {eventsPath} = await fixture(t, `{"type":"ai.failed","detail":"provider said ${MODEL_KEY} is invalid"}\n`);
  const bundle = await diagnosticsBundle({eventsPath, ownEnv: {SCAN_TO_MAKE_MODEL_KEY: MODEL_KEY, SCAN_TO_MAKE_LAN_TLS_KEY: '/k/p.key', HOME: '/Users/x'}});
  assert.ok(!JSON.stringify(bundle).includes(MODEL_KEY));
});

test('two printers with the same name on the same MCP keep their own folders', async t => {
  const {eventsPath} = await fixture(t, '');
  const answer = {package: 'bambu-printer-mcp', version: '1.1.90', files: [{name: 'server.json', content: '{}', truncated: false}], notes: []};
  const a = session('a', {diagnostics: true, bundle: answer}), b = session('b', {diagnostics: true, bundle: answer});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'a', printer: 'Bambu Lab P1S', session: a.session}, {destinationId: 'b', printer: 'Bambu Lab P1S', session: b.session}]});
  const names = bundle.files.map(item => item.name).filter(name => name.startsWith('mcp/'));
  assert.deepEqual(names, ['mcp/Bambu-Lab-P1S-bambu-printer-mcp-a/server.json', 'mcp/Bambu-Lab-P1S-bambu-printer-mcp-b/server.json']);
});

test('an MCP that hangs is a note after its timeout, and the bundle still comes', async t => {
  const {eventsPath} = await fixture(t, '');
  const hung = session('p1s', {diagnostics: true, bundle: () => new Promise(() => {})});
  const started = Date.now();
  const bundle = await diagnosticsBundle({eventsPath, limits: {mcpTimeoutMs: 200}, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: hung.session}]});
  assert.ok(Date.now() - started < 5000);
  assert.ok(bundle.notes.some(note => note.startsWith('bambu-printer-mcp for P1S (p1s) didn\'t give its diagnostics')), bundle.notes.join('\n'));
});

test('an MCP answer that doesn\'t match counterpart/1 is a note, never files', async t => {
  const {eventsPath} = await fixture(t, '');
  const odd = session('p1s', {diagnostics: true, bundle: {package: 7, files: 'nope'}});
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: odd.session}]});
  assert.ok(!bundle.files.some(item => item.name.startsWith('mcp/')));
  assert.ok(bundle.notes.some(note => note.includes('didn\'t give its diagnostics')), bundle.notes.join('\n'));
});

test('at the schema\'s maximum (8 printers × 512 files and 512 notes of control characters) the reply stays under 6 MiB', async t => {
  const {eventsPath} = await fixture(t, 'x'.repeat(100) + '\n');
  const huge = () => ({package: 'bambu-printer-mcp', version: '1.1.90',
    files: Array.from({length: 512}, (_, i) => ({name: `${'n'.repeat(500)}${i}`, content: 'c'.repeat(4000), truncated: false})),
    notes: Array.from({length: 512}, () => '\u0001'.repeat(8192))});
  const printers = Array.from({length: 8}, (_, i) => ({destinationId: `p${i}`, printer: `Printer ${i}`, session: session(`p${i}`, {diagnostics: true, bundle: huge}).session}));
  const bundle = await diagnosticsBundle({eventsPath, sessions: () => printers});
  const size = Buffer.byteLength(JSON.stringify(bundle));
  assert.ok(size <= DIAGNOSTICS_LIMITS.replyBytes, `${size} bytes`);
  assert.ok(size < 8 * 1024 * 1024);
  assert.ok(bundle.notes.every(note => !/[\x00-\x1f]/.test(note) && note.length <= 1000));
  assert.ok(bundle.notes.some(note => note.includes('left out to keep the export small')));
});

// #813 re-review (comment 6886880432): N2, N3, N4, N6, N11 cases are probes in the fixture; these are kept exactly.
test('printer error codes, content hashes and settings names stay exactly as they are', () => {
  const hash = 'ab12'.repeat(16);
  for (const line of ['printer said HMS code 05004043 (heatbreak fan)', 'failed with code 1234', `{"type":"objects.updated","detail":"model ${hash} kept"}`,
    '{"type":"settings.updated","data":{"keys":["general.autoUpdateMcps"]}}', '{"seq":12,"passIndex":2}'])
    assert.equal(redact(line), line);
});

test('one MCP\'s files and notes, Counterpart\'s lines about it included, stay within the max_bytes it was asked for', async t => {
  const {eventsPath} = await fixture(t, '');
  const max = 20_000;
  const noisy = session('p1s', {diagnostics: true, bundle: {package: 'bambu-printer-mcp', version: '1.1.90',
    files: [...Array.from({length: 40}, (_, i) => ({name: `../bad${i}`, content: 'x', truncated: false})),
      ...Array.from({length: 40}, (_, i) => ({name: `log${i}.log`, content: 'l'.repeat(3000), truncated: false}))],
    notes: Array.from({length: 200}, (_, i) => `note ${i} ${'n'.repeat(200)}`)}});
  const limits = {mcpBytes: max, mcpEachBytes: max, mcpMinBytes: 1000};
  const bundle = await diagnosticsBundle({eventsPath, limits, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session: noisy.session}]});
  const mcp = bundle.files.filter(file => file.name.startsWith('mcp/'));
  const cost = mcp.reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file)), 0) + bundle.notes.reduce((sum, note) => sum + Buffer.byteLength(JSON.stringify(note)), 0);
  assert.ok(cost <= max, `${cost} bytes for a ${max}-byte share`);
  assert.ok(bundle.notes.some(note => note.includes('named 40 files')) && bundle.notes.some(note => note.includes('more of its notes were left out')));
});
