// Add printer…'s "Approve in OctoPrint": a form field the MCP can fetch for the person (`obtain` on its setup field,
// mcp-3d-printer-server 1.2.51+). The fixture is mcp-3d-printer-server 1.2.55's own counterpart_setup_fields answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const FIELDS = JSON.parse(readFileSync(new URL('./fixtures/setup-fields-mcp-3d-printer-server-1.2.55.json', import.meta.url), 'utf8'));
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value});

async function fixture(t, answers) {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-obtain-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'data');
  const copy = join(data, 'printers/generic/lib/node_modules/mcp-3d-printer-server');
  await mkdir(join(copy, 'dist'), {recursive: true});
  await writeFile(join(copy, 'package.json'), JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.53'}));
  await writeFile(join(copy, 'dist/index.js'), '');
  const env = {...hostEnvironment(data), home};
  const started = [], calls = [];
  let closed = 0;
  const setup = new PrinterSetup({env, configs: () => [], profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    client: config => {
      started.push(config);
      return {
        connect: async () => ({server: {name: config.backend, version: '1.2.53'}, tools: [{name: 'counterpart_setup_fields'}, {name: 'octoprint_request_api_key'}]}),
        callTool: async (name, args) => {
          calls.push([name, args]);
          if (name === 'counterpart_setup_fields') return text(FIELDS);
          if (name === 'octoprint_request_api_key') return text(answers.shift());
          throw new Error(`unexpected ${name}`);
        },
        close: async () => { closed++; },
      };
    }});
  t.after(() => setup.closeObtaining());
  return {setup, started, calls, closed: () => closed};
}

const form = {backend: 'mcp-3d-printer-server', printerType: 'octoprint', host: 'octopi.local', field: 'secret'};

test('Add printer… offers the MCP\'s own "Approve in OctoPrint" on OctoPrint\'s key, in its words', async () => {
  const {setupOptions} = await import('../dist/printing/mcp-setup.js');
  const options = setupOptions([{package: 'mcp-3d-printer-server', label: 'mcp-3D-printer-server', setup: FIELDS, installed: true}]);
  const octoprint = options.types.find(type => type.printerType === 'octoprint');
  assert.deepEqual(octoprint.secret.obtain, {label: 'Approve in OctoPrint', hint: 'OctoPrint asks you to allow this app in its web page', backends: ['mcp-3d-printer-server']});
  assert.equal(options.types.find(type => type.printerType === 'klipper').secret.obtain, undefined, 'only where the MCP declares it');
});

test('printers.obtain starts the approval, keeps that MCP copy running while the person answers, and fills only the field', async t => {
  const {ObtainRequestSchema} = await import('../dist/printing/setup.js');
  const {setup, started, calls, closed} = await fixture(t, [
    {status: 'pending', request_id: 'r-1', approve_url: 'http://octopi.local/plugin/appkeys/auth/tok', message: 'Open OctoPrint and click Allow.'},
    {status: 'pending', request_id: 'r-1', approve_url: 'http://octopi.local/plugin/appkeys/auth/tok', message: 'Open OctoPrint and click Allow.'},
    {status: 'approved', request_id: 'r-1', api_key: 'KEY-123', env: {API_KEY: 'KEY-123', PRINTER_TYPE: 'klipper'}, message: 'OctoPrint allowed this app.'},
  ]);
  const first = await setup.obtain(ObtainRequestSchema.parse(form));
  assert.equal(first.status, 'pending');
  assert.equal(first.approveUrl, 'http://octopi.local/plugin/appkeys/auth/tok');
  assert.match(first.session, /^[0-9a-f-]{36}$/);
  const obtainCalls = () => calls.filter(([name]) => name === 'octoprint_request_api_key');
  assert.deepEqual(obtainCalls()[0][1], {host: 'octopi.local', app: 'Counterpart'}, 'no port unless the form has one; the MCP uses OctoPrint\'s own');
  const runs = started.filter(config => !config.process.env);
  const kept = runs.length;
  const second = await setup.obtain(ObtainRequestSchema.parse({...form, session: first.session}));
  assert.equal(second.status, 'pending');
  assert.deepEqual(obtainCalls()[1][1], {host: 'octopi.local', request_id: 'r-1', wait_ms: 20000});
  assert.equal(started.filter(config => !config.process.env).length, kept, 'the same MCP copy answers: it holds the request');
  const done = await setup.obtain(ObtainRequestSchema.parse({...form, session: first.session}));
  assert.deepEqual(done, {status: 'approved', message: 'OctoPrint allowed this app.', value: 'KEY-123'}, 'only the field\'s own variable (API_KEY)');
  assert.ok(closed() >= 1, 'the copy stops once answered');
  assert.equal((await setup.obtain(ObtainRequestSchema.parse({...form, session: first.session}))).status, 'failed', 'an answered approval is closed');
});

test('printers.obtain: another printer\'s session, a field without obtain, a denied answer and an unusable link', async t => {
  const {ObtainRequestSchema} = await import('../dist/printing/setup.js');
  const {setup} = await fixture(t, [
    {status: 'pending', request_id: 'r', approve_url: 'javascript:alert(1)', message: 'Click Allow.'},
    {status: 'denied', request_id: 'r', message: 'OctoPrint said no.'},
  ]);
  const first = await setup.obtain(ObtainRequestSchema.parse(form));
  assert.equal(first.approveUrl, undefined, 'only an http or https page is offered');
  assert.equal((await setup.obtain(ObtainRequestSchema.parse({...form, host: 'other.local', session: first.session}))).status, 'failed', 'a session is for its own printer');
  assert.deepEqual(await setup.obtain(ObtainRequestSchema.parse({...form, session: first.session})), {status: 'failed', message: 'OctoPrint said no.'});
  await assert.rejects(setup.obtain(ObtainRequestSchema.parse({...form, printerType: 'klipper'})), /can’t fetch that/);
  assert.throws(() => ObtainRequestSchema.parse({...form, host: 'https://user:pw@octopi.local'}), 'a host is checked as the form checks it');
});

test('printers.obtain: an abandoned approval never blocks a new one (Codex review on #386)', async t => {
  const {ObtainRequestSchema} = await import('../dist/printing/setup.js');
  const pending = {status: 'pending', request_id: 'r', approve_url: 'http://octopi.local/a', message: 'Click Allow.'};
  const {setup, closed} = await fixture(t, Array.from({length: 12}, () => ({...pending})));
  // The same printer again replaces its approval: starting over never piles up.
  assert.equal((await setup.obtain(ObtainRequestSchema.parse(form))).status, 'pending');
  const before = closed(); // the setup-fields probe has closed by now
  for (let i = 0; i < 5; i++) assert.equal((await setup.obtain(ObtainRequestSchema.parse(form))).status, 'pending');
  assert.equal(closed() - before, 5, 'each new start for the printer stopped the one before');
  // Four other printers fill the limit; once they go unasked for 45 s they are let go.
  for (const host of ['a.local', 'b.local', 'c.local']) await setup.obtain(ObtainRequestSchema.parse({...form, host}));
  await assert.rejects(setup.obtain(ObtainRequestSchema.parse({...form, host: 'd.local'})), /Finish or close/);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 46_000;
  assert.equal((await setup.obtain(ObtainRequestSchema.parse({...form, host: 'd.local'}))).status, 'pending');
});
