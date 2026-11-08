// Add printer…'s address: a host name or address everywhere, and a web address (https://…, a reverse proxy's sub-path)
// only where the MCP's own host field says it takes one (`input: "url"`, mcp-3d-printer-server 1.2.55+: OctoPrint).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tempDir} from './support/temp.mjs';

const FIELDS = JSON.parse(readFileSync(new URL('./fixtures/setup-fields-mcp-3d-printer-server-1.2.55.json', import.meta.url), 'utf8'));
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value});

test('the address field says, in the MCP\'s words, where a web address is taken', async () => {
  const {setupOptions} = await import('../dist/printing/mcp-setup.js');
  const options = setupOptions([{package: 'mcp-3d-printer-server', label: 'mcp-3D-printer-server', setup: FIELDS, installed: true}]);
  const octoprint = options.types.find(type => type.printerType === 'octoprint');
  assert.equal(octoprint.address.url, true);
  assert.match(octoprint.address.hint, /https:\/\//);
  assert.equal(options.types.find(type => type.printerType === 'klipper').address?.url, undefined);
});

test('Check and Add take a web address only for a kind whose MCP field says so, and pass it as typed', async t => {
  const {PrinterSetup, PrinterFormSchema, webAddress} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await tempDir('printer-address-');
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'data');
  const copy = join(data, 'printers/generic/lib/node_modules/mcp-3d-printer-server');
  await mkdir(join(copy, 'dist'), {recursive: true});
  await writeFile(join(copy, 'package.json'), JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.55'}));
  await writeFile(join(copy, 'dist/index.js'), '');
  const env = {...hostEnvironment(data), home};
  const started = [];
  const setup = new PrinterSetup({env, configs: () => [], profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    client: config => {
      started.push(config);
      return {connect: async () => ({server: {name: config.backend, version: '1.2.55'}, tools: [{name: 'counterpart_setup_fields'}, {name: 'get_printer_status'}]}),
        callTool: async name => text(name === 'counterpart_setup_fields' ? FIELDS : {state: {text: 'Operational'}}), close: async () => undefined};
    }});

  for (const value of ['https://octopi.example.com', 'http://pi.lan/octoprint/', 'http://192.168.1.20:5000/octoprint']) assert.ok(webAddress(value), value);
  for (const value of ['https://user:pw@octopi.local', 'ftp://octopi.local', 'http://octopi.local/?x=1', "http://octo'pi.local", 'octopi.local']) assert.ok(!webAddress(value), value);

  const octoprint = PrinterFormSchema.parse({backend: 'mcp-3d-printer-server', printerType: 'octoprint', host: ' https://pi.example.com/octoprint ', secret: 'k'});
  assert.equal(octoprint.host, 'https://pi.example.com/octoprint');
  assert.equal((await setup.check(octoprint)).reached, true);
  assert.equal(started.at(-1).process.env.PRINTER_HOST, 'https://pi.example.com/octoprint', 'written as typed');

  const klipper = PrinterFormSchema.parse({backend: 'mcp-3d-printer-server', printerType: 'klipper', host: 'https://klipper.local'});
  await assert.rejects(setup.check(klipper), /without http:\/\/ or a path/);
  await assert.rejects(setup.add(klipper), /without http:\/\/ or a path/);
  assert.equal(PrinterFormSchema.parse({...klipper, host: 'klipper.local.'}).host, 'klipper.local', 'a plain host still loses its trailing dot');
  assert.throws(() => PrinterFormSchema.parse({...klipper, host: 'https://user:pw@klipper.local'}));
});
