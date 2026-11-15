// #839: the companion's redactor fails closed, the same design as the MCPs' counterpart_diagnostics redesign. Every probe
// below goes through diagnosticsBundle three ways: as a line of the event log, as an MCP's file and as an MCP's note,
// with the secret not configured anywhere, and must not come out. Format-agnostic: no MCP file name or log shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrinterSession} from '@scan-to-make/printer-handoff';
import {diagnosticsBundle} from '../dist/diagnostics.js';

const ACCESS_CODE = '31415926';
const tool = name => ({name, inputSchema: {type: 'object', properties: name === 'counterpart_diagnostics' ? {max_bytes: {type: 'number'}} : {}}});

/** A printer whose MCP answers counterpart_diagnostics with `bundle`, configured with `env`. */
function mcp(bundle, env = {BAMBU_ACCESS_CODE: ACCESS_CODE}) {
  const tools = [tool('counterpart_printer_info'), tool('counterpart_diagnostics')];
  const info = {contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.96'}, printer: {kind: 'bambu', host: '192.0.2.7'},
    capabilities: {progress: true, layers: true, camera: 'bambu-tcp', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: true, diagnostics: true}};
  const factory = () => ({
    catalog: undefined,
    async connect() { this.catalog = {server: {name: 'bambu-printer-mcp', version: '1.1.96'}, tools}; return this.catalog; },
    hasTool(name) { return tools.some(item => item.name === name); },
    getTool(name) { return tools.find(item => item.name === name); },
    async callTool(name) {
      if (name === 'counterpart_printer_info') return {content: [{type: 'text', text: JSON.stringify(info)}]};
      return {structuredContent: bundle, content: [{type: 'text', text: JSON.stringify(bundle)}]};
    },
    async close() {},
  });
  return new PrinterSession('p1s', {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', env}}, {clientFactory: factory});
}

async function bundleOf(t, text, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'stm-839-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const eventsPath = join(root, 'events.ndjson');
  await writeFile(eventsPath, options.events ?? `${text}\n`);
  const session = mcp({package: 'bambu-printer-mcp', version: '1.1.96', files: [{name: 'any.log', content: text, truncated: false}], notes: options.notes ?? [text.split('\n')[0]]},
    options.env);
  return diagnosticsBundle({eventsPath, limits: options.limits, ownEnv: options.ownEnv, sessions: () => [{destinationId: 'p1s', printer: 'P1S', session}]});
}

const LEAKS = [
  // R-1: anything between a name and its value, and a value that is itself a structure.
  ['R-1 object between name and value', '{"name":"BAMBU_ACCESS_CODE","meta":{"a":1},"value":"r1secretA"}', 'r1secretA'],
  ['R-1 braces in a string between', '{"name":"BAMBU_ACCESS_CODE","note":"a {b} c","value":"r1secretB"}', 'r1secretB'],
  ['R-1 array of objects between', '{"name":"BAMBU_ACCESS_CODE","tags":[{"k":"v"}],"value":"r1secretC"}', 'r1secretC'],
  ['R-1 an object over 16384 characters', `{"name":"BAMBU_ACCESS_CODE","pad":"${'x'.repeat(17000)}","value":"r1secretD"}`, 'r1secretD'],
  ['R-1 a value that is an object', '{"name":"password","value":{"nested":"r1secretE"}}', 'r1secretE'],
  ['R-1 every element of an array value', '{"name":"tokens","value":["first1","r1SECOND"]}', 'r1SECOND'],
  // R-2: other quoting, other field names, XML attributes, unquoted lists.
  ['R-2 Python dict', "{'name': 'BAMBU_TOKEN', 'value': 'r2secretA'}", 'r2secretA'],
  ['R-2 Node inspect', "{ name: 'BAMBU_ACCESS_CODE', value: 'r2secretB' }", 'r2secretB'],
  ['R-2 value under text', '{"name":"BAMBU_TOKEN","text":"r2secretC"}', 'r2secretC'],
  ['R-2 value under v', '{"name":"BAMBU_TOKEN","v":"r2secretD"}', 'r2secretD'],
  ['R-2 value under env_value', '{"name":"BAMBU_TOKEN","env_value":"r2secretE"}', 'r2secretE'],
  ['R-2 value under setting', '{"name":"BAMBU_TOKEN","setting":"r2secretF"}', 'r2secretF'],
  ['R-2 name under label', '{"label":"BAMBU_ACCESS_CODE","value":"r2secretG"}', 'r2secretG'],
  ['R-2 name under property', '{"property":"apiToken","value":"r2secretH"}', 'r2secretH'],
  ['R-2 name under envName', '{"envName":"BAMBU_TOKEN","value":"r2secretI"}', 'r2secretI'],
  ['R-2 XML setting attributes', '<setting name="password" value="r2secretJ"/>', 'r2secretJ'],
  ['R-2 XML add key', '<add key="BambuAccessCode" value="r2secretK"/>', 'r2secretK'],
  ['R-2 string resource', '<string name="apiToken">r2secretL</string>', 'r2secretL'],
  ['R-2 unquoted list', 'tokens=[first2, r2SECOND]', 'r2SECOND'],
  ['R-2 single-quoted list', "tokens=['first3', 'r2THIRD']", 'r2THIRD'],
  // R-3: a pair inside JSON escaped in a string.
  ['R-3 escaped pair', String.raw`{"msg":"{\"name\":\"BAMBU_ACCESS_CODE\",\"value\":\"r3secretA\"}"}`, 'r3secretA'],
  // R-4: an escaped quoted secret longer than any lookahead.
  ['R-4 long escaped value', String.raw`{"msg":"{\"password\":\"` + 'Qq9 '.repeat(1300) + 'r4tail99' + String.raw`\"}"}`, 'r4tail99'],
  // R-5: spellings.
  ['R-5 pass as a JSON key', '{"pass":"r5secretA"}', 'r5secretA'],
  ['R-5 mqtt pass=', 'mqtt pass=r5secretB', 'r5secretB'],
  ['R-5 device_code', 'device_code=48291037', '48291037'],
  ['R-5 unlock_code', 'unlock_code: 73920184', '73920184'],
  ['R-5 alternating case', 'PaSsWoRd=r5secretC', 'r5secretC'],
  ['R-5 alternating case, access code', 'AcCeSsCoDe=r5secretD', 'r5secretD'],
  ['R-5 \\x escape', String.raw`\x70assword=r5secretE`, 'r5secretE'],
  ['R-5 % escape', 'pass%77ord=r5secretF', 'r5secretF'],
  // R-6: a secret split across lines.
  ['R-6 quoted value across lines', '{"password":"r6AAA\nr6BBB"}', 'r6BBB'],
  ['R-6 Digest on the next line', 'Digest\n username="r6user", response="r6response"', 'r6response'],
  ['R-6 folded header', 'Authorization: Bearer\n  r6folded', 'r6folded'],
  ['R-6 YAML folded value', 'password: >\n  r6yaml\nnext: 1', 'r6yaml'],
];

for (const [kind, text, secret] of LEAKS) {
  test(`fail closed: ${kind}`, async t => {
    const out = JSON.stringify(await bundleOf(t, text));
    assert.ok(!out.includes(secret), `${kind}: ${out.length > 800 ? `${out.slice(0, 800)}…` : out}`);
  });
}

test('R-7: long file names and measures under secret-sounding names stay', async t => {
  const text = 'wrote MyPrint2026Version3FinalAssembly.stl\ntokenCount: 5\nsessionTimeoutSec=30\npasswordMinLength = 8';
  const bundle = await bundleOf(t, text, {events: `${JSON.stringify({type: 'x', tokenCount: 5, sessionTimeoutSec: 30, passwordMinLength: 8, file: 'MyPrint2026Version3FinalAssembly.stl'})}\n`});
  assert.equal(bundle.files.find(file => file.name.endsWith('/any.log')).content, text);
  assert.deepEqual(JSON.parse(bundle.files.find(file => file.name === 'events-tail.ndjson').content),
    {type: 'x', tokenCount: 5, sessionTimeoutSec: 30, passwordMinLength: 8, file: 'MyPrint2026Version3FinalAssembly.stl'});
});

test('a withheld line keeps its time and level; generic safe shapes stay; a bare number under a secret name never does', async t => {
  const text = ['2026-11-15T10:00:00.000Z error mqtt pass=hunter2x', 'accessCodeSet: true', 'BAMBU_TOKEN=[set]', 'firmware version 01.08.02.00', 'plain line',
    'accessCode: 12345678'].join('\n');
  const content = (await bundleOf(t, text)).files.find(file => file.name.endsWith('/any.log')).content.split('\n');
  assert.deepEqual(content, ['2026-11-15T10:00:00.000Z error [line withheld: may contain a secret]', 'accessCodeSet: true', 'BAMBU_TOKEN=[set]',
    'firmware version 01.08.02.00', 'plain line', '[line withheld: may contain a secret]']);
});

test('the event log is redacted by its structure: types and names stay, a secret\'s value goes, every line stays JSON', async t => {
  const events = [
    {seq: 1, type: 'settings.updated', data: {keys: ['general.autoUpdateMcps']}},
    {seq: 2, type: 'mcp.update.failed', body: 'npm said: {"name":"NPM_TOKEN","value":"evsecret1"}'},
    {seq: 3, type: 'pass.started', passIndex: 2, words: 'Printing on P1S'},
    {seq: 4, type: 'x', detail: 'the password is evsecret2'},
  ].map(event => JSON.stringify(event)).join('\n') + '\nnot json: token=evsecret3\n';
  const bundle = await bundleOf(t, 'x', {events});
  const lines = bundle.files.find(file => file.name === 'events-tail.ndjson').content.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 4).map(line => JSON.parse(line).type), ['settings.updated', 'mcp.update.failed', 'pass.started', 'x']);
  assert.deepEqual(JSON.parse(lines[0]).data.keys, ['general.autoUpdateMcps']);
  assert.deepEqual(JSON.parse(lines[2]), {seq: 3, type: 'pass.started', passIndex: 2, words: 'Printing on P1S'});
  for (const secret of ['evsecret1', 'evsecret2', 'evsecret3']) assert.ok(!JSON.stringify(bundle).includes(secret), secret);
});

test('configured secrets go in every encoded form, and before every cut', async t => {
  const forms = [Buffer.from(`bblp:${ACCESS_CODE}`).toString('base64'), Buffer.from(ACCESS_CODE).toString('base64'), encodeURIComponent(`x${ACCESS_CODE}&`),
    JSON.stringify(`"${ACCESS_CODE}"`)];
  const text = forms.map(form => `got ${form} ok`).join('\n');
  const out = JSON.stringify(await bundleOf(t, text));
  assert.ok(!out.includes(ACCESS_CODE), out);
  for (const form of forms.slice(0, 2)) assert.ok(!out.includes(form), form);
  // A secret straddling the start of the event log's tail, or the cut of an MCP file, leaves no part of itself.
  const pad = 'p'.repeat(60);
  const lines = Array.from({length: 200}, (_, i) => `{"seq":${i},"note":"${pad}${ACCESS_CODE}${pad}"}`).join('\n');
  for (const eventsBytes of [1000, 1031, 1063, 1077]) {
    const cut = JSON.stringify(await bundleOf(t, lines, {events: `${lines}\n`, limits: {eventsBytes, mcpBytes: 3000, mcpEachBytes: 3000, mcpMinBytes: 1000}}));
    for (const piece of [ACCESS_CODE.slice(0, 4), ACCESS_CODE.slice(4)]) assert.ok(!cut.includes(`${pad}${piece}`) && !cut.includes(`${piece}${pad}`), `${eventsBytes}: ${piece}`);
  }
});

test('the companion\'s own secret-named values are swept, encoded too', async t => {
  // Short enough that its base64 is no long random run: only the encoded-form sweep removes it.
  const key = 'mk9f8e7d6c5b';
  const out = JSON.stringify(await bundleOf(t, `provider said ${Buffer.from(key).toString('base64')} and ${encodeURIComponent(key)}`, {ownEnv: {SCAN_TO_MAKE_MODEL_KEY: key}}));
  assert.ok(!out.includes(Buffer.from(key).toString('base64')) && !out.includes(key), out);
});

test('property: a secret under any secret word, in any syntax, never comes out of the bundle', async t => {
  let seed = 0x839;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rand(list.length)];
  const WORDS = ['password', 'pass', 'passwd', 'secret', 'token', 'apiKey', 'access_code', 'lanCode', 'pairing-code', 'deviceCode', 'unlock_code',
    'auth', 'cookie', 'session', 'credential', 'privateKey', 'passphrase', 'client_secret', 'refreshToken', 'x-api-key'];
  const spell = word => {
    const cased = [...word].map(c => (rand(2) ? c.toUpperCase() : c.toLowerCase())).join('');
    return pick([word, cased, word.toUpperCase(), cased.replace(/^./, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)]);
  };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const SYNTAX = [
    (w, s) => JSON.stringify({outer: {inner: {[w]: s}}}),
    (w, s) => JSON.stringify({name: w.toUpperCase(), note: 'n', meta: {a: [1, {b: 2}]}, value: s}),
    (w, s) => `{'${w}': '${s}'}`,
    (w, s) => `<${w.replace(/[^A-Za-z]/g, '')}>${s}</${w.replace(/[^A-Za-z]/g, '')}>`,
    (w, s) => `<add key="${w}" value="${s}"/>`,
    (w, s) => `${w}: ${s}`,
    (w, s) => JSON.stringify({msg: JSON.stringify({[w]: s})}),
    (w, s) => JSON.stringify({msg: JSON.stringify({name: w, value: s})}),
    (w, s) => `${w} = "${s.slice(0, 6)}\n${s.slice(6)}"`,
    (w, s) => `${w}:\n  ${s}`,
    (w, s) => `2026-11-15T10:00:00.000Z warn ${w}=${s} more`,
    (w, s) => `--${w} ${s}`,
  ];
  const cases = Array.from({length: 240}, (_, i) => {
    const secret = Array.from({length: 12}, () => alphabet[rand(alphabet.length)]).join('');
    const syntax = rand(SYNTAX.length);
    return {i, syntax, secret, text: `before ${i}\n${SYNTAX[syntax](spell(pick(WORDS)), secret)}\nafter ${i}`};
  });
  // Eight cases per bundle: as event lines, as one MCP file and as MCP notes, all at once.
  for (let at = 0; at < cases.length; at += 8) {
    const group = cases.slice(at, at + 8);
    const text = group.map(item => item.text).join('\n');
    const out = JSON.stringify(await bundleOf(t, text, {notes: group.map(item => item.text)}));
    for (const {i, syntax, secret, text: one} of group) {
      for (const piece of [secret, secret.slice(0, 6), secret.slice(6)]) {
        assert.ok(!out.includes(piece), `case ${i} (syntax ${syntax}) leaked ${piece}: ${JSON.stringify(one)}`);
      }
    }
  }
});
