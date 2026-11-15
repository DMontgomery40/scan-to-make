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

// ---------------------------------------------------------------------------------------------------------------------
// The adversarial review of #841 (C-1 to C-6): narrow breaks around R-1 to R-7. Each failed before its fix.

const C_LEAKS = [
  // C-1: a rescued line that leaves a quote open, or is followed by an indented line, keeps its continuation withheld.
  ['C-1 rescued line with an open quote', 'password: "true\nzq482910x"', 'zq482910x'],
  ['C-1 rescued line with an indented continuation', 'token: true\n  zq482910y', 'zq482910y'],
  // C-2: name/value shapes: a spaced name, a setting field, Object.entries pairs (as a whole JSON file and as one line).
  ['C-2 spaced name', '{"name":"Access Code","value":"zq2spaced"}', 'zq2spaced'],
  ['C-2 setting field', '{"setting":"PRINTER_TOKEN","value":"zq2setting"}', 'zq2setting'],
  ['C-2 pairs in a document', '{"env":[["PRINTER_TOKEN","zq2tuple"],["MODEL","p1s"]]}', 'zq2tuple'],
  ['C-2 a pair as a line', 'first line\n["PRINTER_TOKEN","zq2line"]', 'zq2line'],
  // C-5: continuations that are not indented, and open structures past the 200-line cap.
  ['C-5 multipart part named like a secret', '--b1\nContent-Disposition: form-data; name="password"\n\nzq5multi\n--b1--', 'zq5multi'],
  ['C-5 single quotes across lines', "password='zq48\n2910x'", '2910x'],
  ['C-5 an open bracket past 200 lines', 'dump {"tokens":[\n' + '  "x",\n'.repeat(250) + '  "zq5deep"\n]}', 'zq5deep'],
  ['C-5 Authorization wrapped unindented', 'Authorization: Bearer\nzq5wrapped', 'zq5wrapped'],
  ['C-5 YAML block with a blank line', 'password: >\n  zq5first\n\n  zq5second\nnext: 1', 'zq5second'],
  // C-6: HTML entities and \u{…} in a secret's name.
  ['C-6 HTML entity', 'passw&#111;rd=zq6html', 'zq6html'],
  ['C-6 hex HTML entity', 'passw&#x6f;rd=zq6hexent', 'zq6hexent'],
  ['C-6 Rust \\u{…}', String.raw`\u{70}assword=zq6rust`, 'zq6rust'],
];
for (const [kind, text, secret] of C_LEAKS) {
  test(`review: ${kind}`, async t => {
    const out = JSON.stringify(await bundleOf(t, text));
    assert.ok(!out.includes(secret), `${kind}: ${out.length > 800 ? `${out.slice(0, 800)}…` : out}`);
  });
}

test('review C-2: a pair whose name is no secret stays, and the secret\'s name stays readable', async t => {
  const bundle = await bundleOf(t, '{"env":[["PRINTER_TOKEN","zq2tuple"],["MODEL","p1s"]]}');
  const env = JSON.parse(bundle.files.find(file => file.name.endsWith('/any.log')).content).env;
  assert.deepEqual(env, [['PRINTER_TOKEN', '[redacted]'], ['MODEL', 'p1s']]);
});

test('review C-3: a configured secret goes in other encoders\' spellings, by decoding each line and searching it', async t => {
  for (const [secret, carrier] of [['hun ter+9', 'q=hun+ter%2B9&x=1'], ['ab/cd9z', 'path=ab%2fcd9z'], ['ab<cd9z', String.raw`{"v":"ab<cd9z"}`],
    ['zq482910x', String.raw`got zq482910x ok`], ['ab/cd9z', String.raw`{"p":"ab\/cd9z"}`], ['ab<cd9z', 'v=ab&#60;cd9z;'], ['ab<cd9z', String.raw`v=ab\u{3c}cd9z`]]) {
    const out = JSON.stringify(await bundleOf(t, `innocent line\n${carrier}\nnext`, {env: {PRINTER_PASSWORD: secret}}));
    assert.ok(!out.includes(carrier), `${secret} in ${carrier}: ${out.slice(0, 600)}`);
    assert.match(out, /innocent line/);
  }
});

test('review C-4: a short configured secret in base64 at each offset leaves no decodable part', async t => {
  const secret = 'Kx9!pq2';
  for (const before of ['', 'x', 'xx', 'xxx:']) {
    const carrier = Buffer.from(`${before}${secret}`).toString('base64');
    const out = JSON.stringify(await bundleOf(t, `blob ${carrier} end`, {env: {PRINTER_PASSWORD: secret}}));
    for (const run of out.match(/[A-Za-z0-9+/]{4,}={0,2}/g) ?? []) {
      const decoded = Buffer.from(run, 'base64').toString('latin1');
      for (const piece of ['Kx9', 'x9!', '9!p', '!pq', 'pq2']) assert.ok(!decoded.includes(piece), `offset ${before.length}: ${run} decodes to ${JSON.stringify(decoded)}`);
    }
  }
});

test('property: the review\'s syntaxes (multipart, single-quote splits, form-url, Go escapes, pairs, spaced names) never leak', async t => {
  let seed = 0x841;
  const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = list => list[rand(list.length)];
  const WORDS = ['password', 'Access Code', 'api key', 'token', 'Pairing Code', 'secret', 'passphrase', 'session'];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const SYNTAX = [
    (w, s) => ['--xyz', `Content-Disposition: form-data; name="${w}"`, '', s, '--xyz--'].join('\n'),
    (w, s) => `${w.replace(/ /g, '_')}='${s.slice(0, 5)}\n${s.slice(5)}'`,
    (w, s) => `${encodeURIComponent(w).replace(/%20/g, '+')}=${s}&next=1`,
    (w, s) => String.raw`{"<${w}>":"${s}"}`,
    (w, s) => JSON.stringify({env: [[w, s], ['model', 'p1s']]}),
    (w, s) => JSON.stringify({name: w, note: 'n', value: s}),
    (w, s) => JSON.stringify([w, s]),
    (w, s) => `${w}: |\n  ${s.slice(0, 6)}\n\n  ${s.slice(6)}\nafter: 1`,
  ];
  const cases = Array.from({length: 160}, (_, i) => {
    const secret = Array.from({length: 12}, () => alphabet[rand(alphabet.length)]).join('');
    const syntax = rand(SYNTAX.length);
    return {i, syntax, secret, text: `before ${i}\n${SYNTAX[syntax](pick(WORDS), secret)}\nafter ${i}`};
  });
  for (let at = 0; at < cases.length; at += 8) {
    const group = cases.slice(at, at + 8);
    const out = JSON.stringify(await bundleOf(t, group.map(item => item.text).join('\n'), {notes: group.map(item => item.text)}));
    for (const {i, syntax, secret, text} of group) {
      for (const piece of [secret, secret.slice(0, 5), secret.slice(6)]) assert.ok(!out.includes(piece), `case ${i} (syntax ${syntax}) leaked ${piece}: ${JSON.stringify(text)}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Auth-state lines (a usefulness regression the regression watcher caught on a real event log, Nov 15): a line whose
// only secret words say a credential's state is the most actionable failure a tester sends, so it stays readable. An
// allowlist: any value-shaped neighbour still withholds it.

// The real pass.failed body of Nov 14 (Claude Code's own sentence), withheld whole before this.
const CLAUDE_LOGIN_EXPIRED = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs';
const AUTH_KEPT = [CLAUDE_LOGIN_EXPIRED, 'cloud token refresh failed; sign in again', 'Access code is wrong', '401 Unauthorized', 'Model access token expired',
  'invalid access code for this printer', 'password not set'];

test('auth state stays readable in a pass.failed event, an MCP file and an MCP note', async t => {
  const events = AUTH_KEPT.map((body, seq) => JSON.stringify({v: 1, seq, type: 'pass.failed', title: 'A replica didn\'t finish', body})).join('\n') + '\n';
  const bundle = await bundleOf(t, AUTH_KEPT.join('\n'), {events, notes: AUTH_KEPT});
  const bodies = bundle.files.find(file => file.name === 'events-tail.ndjson').content.trimEnd().split('\n').map(line => JSON.parse(line).body);
  assert.deepEqual(bodies, AUTH_KEPT);
  assert.equal(bundle.files.find(file => file.name.endsWith('/any.log')).content, AUTH_KEPT.join('\n'));
  for (const line of AUTH_KEPT) assert.ok(bundle.notes.some(note => note.endsWith(line)), line);
});

const AUTH_WITHHELD = [
  ['token expired with its value', 'token expired: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl', 'eyJzdWIiOiIxMjM0In0'],
  ['password is a value', 'password is hunter2x', 'hunter2x'],
  ['code next to its value', 'access code 48291037 rejected', '48291037'],
  ['token= then a state', 'token=abc9f8e7d6 expired', 'abc9f8e7d6'],
  ['URL credentials', 'auth failed for user:pqzz77@host.example', 'pqzz77'],
  ['a quoted value', 'token "zq7quoted" expired', 'zq7quoted'],
  ['was a value', 'the session was zq7session then expired', 'zq7session'],
  ['a continuation', 'token expired\n  zq7continued', 'zq7continued'],
  ['a secret-shaped run on a rescued line', 'refresh failed for token after ab12cd34ef56ab12cd34ef56 expired', 'ab12cd34ef56ab12cd34ef56'],
];
for (const [kind, text, secret] of AUTH_WITHHELD) {
  test(`auth near-miss stays withheld: ${kind}`, async t => {
    const out = JSON.stringify(await bundleOf(t, text));
    assert.ok(!out.includes(secret), `${kind}: ${out.slice(0, 600)}`);
  });
}
