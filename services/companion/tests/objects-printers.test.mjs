import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {PrinterHandoffRunner} from '@scan-to-make/printer-handoff';
import {loadPrinterCatalog} from '../dist/objects/printers.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'printer-catalog-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const current = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/ssh', args: ['printer-tunnel'], cwd: home, env: {MCP_TRANSPORT: 'stdio'}}, selection: {model: 'p1s'}};
  const put = async (file, value) => {
    const path = join(home, file);
    await mkdir(join(path, '..'), {recursive: true});
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  await put('.env', 'PRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=private-serial-one\nBAMBU_TOKEN=private-token-one\nBAMBU_MODEL=p1s\n');
  return {home, current, put, options: sourcePaths => ({homeDirectory: home, sourcePaths})};
}

test('current destination inherits metadata without rewriting its working SSH configuration', async t => {
  const f = await fixture(t);
  const catalog = await loadPrinterCatalog(f.current, f.options([]));
  assert.equal(catalog.defaultDestinationId, 'current');
  assert.deepEqual(catalog.destinations, [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', model: 'p1s', address: '192.0.2.1', source: 'current'}]);
  assert.deepEqual(catalog.resolve('current'), f.current);
  const retained = catalog.resolve('current');
  retained.process.env.MCP_TRANSPORT = 'changed';
  assert.equal(catalog.resolve('current').process.env.MCP_TRANSPORT, 'stdio');
  assert.equal(catalog.resolve('unknown'), undefined);
});

test('distinct configured MCP profiles are selectable and preserve their environment and cwd', async t => {
  const f = await fixture(t);
  const env = {PRINTER_HOST: '192.0.2.22', PRINTER_TYPE: 'klipper', API_KEY: 'generic-secret', SLICER_PROFILE: '/profiles/selected.ini'};
  const profile = {command: '/usr/local/bin/node', args: ['/opt/mcp-3D-printer-server/dist/index.js'], cwd: '/opt/printer-config', env};
  const source = await f.put('mcp.json', {mcpServers: {
    'Workshop printer': profile,
    'Upstairs Bambu': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {PRINTER_HOST: '192.0.2.23', BAMBU_SERIAL: 'private-serial-three', BAMBU_TOKEN: 'third-secret', BAMBU_MODEL: 'a1'}},
  }});
  const before = await readFile(source, 'utf8');
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  assert.equal(catalog.destinations.length, 3);
  const generic = catalog.destinations.find(d => d.name === 'Workshop printer');
  assert.equal(generic.backend, 'mcp-3d-printer-server');
  assert.equal(generic.address, '192.0.2.22');
  assert.deepEqual(catalog.resolve(generic.id), {backend: 'mcp-3d-printer-server', process: profile, selection: {printerType: 'klipper'}});
  const bambu = catalog.destinations.find(d => d.address === '192.0.2.23');
  assert.equal(bambu.model, 'a1');
  assert.equal(catalog.resolve(bambu.id).process.command, process.execPath);
  assert.deepEqual(catalog.resolve(bambu.id).selection, {model: 'a1', printerType: 'bambu'});
  assert.equal(await readFile(source, 'utf8'), before);
  assert.equal((await loadPrinterCatalog(f.current, f.options([source]))).destinations[1].id, catalog.destinations[1].id);
});

test('discovered Bambu destinations satisfy required MCP model schemas through the selected runner', async t => {
  const f = await fixture(t);
  const require = createRequire(new URL('../../printer-handoff/tests/fixtures/fixture-printer-server.mjs', import.meta.url));
  const moduleUrl = path => pathToFileURL(require.resolve(path)).href;
  // An isolated protocol peer with the real tools' required model fields; no printer implementation is loaded.
  const script = `
    import {Server} from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
    import {StdioServerTransport} from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
    import {CallToolRequestSchema, ListToolsRequestSchema} from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
    import {appendFileSync, writeFileSync} from 'node:fs';
    const names = {slice_stl: 'stl_path', inspect_print_file: 'file_path', print_3mf: 'three_mf_path'};
    const server = new Server({name: 'isolated-model-schema', version: '0.0.0'}, {capabilities: {tools: {}}});
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: Object.entries(names).map(([name, field]) => ({name,
      inputSchema: {type: 'object', additionalProperties: false, required: [field, 'bambu_model'],
        properties: {[field]: {type: 'string'}, bambu_model: {type: 'string', enum: ['a1']}}}}))}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      appendFileSync(process.env.TEST_LOG, JSON.stringify(request.params) + '\\n');
      if (request.params.name === 'slice_stl') writeFileSync(process.env.TEST_OUTPUT, 'isolated sliced artifact');
      return {content: [{type: 'text', text: request.params.name === 'slice_stl' ? process.env.TEST_OUTPUT : '{}'}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  for (const backend of ['bambu-printer-mcp', 'mcp-3D-printer-server']) {
    const entry = await f.put(`${backend}/dist/index.js`, script);
    await f.put(`${backend}/package.json`, {type: 'module'});
    const cwd = join(f.home, backend);
    await f.put(`${backend}/.env`, 'BAMBU_MODEL=a1\nPRINTER_TYPE=bambu\n');
    const log = join(cwd, 'calls.jsonl'), output = join(cwd, 'sliced.3mf');
    const env = {PRINTER_HOST: '192.0.2.90', TEST_LOG: log, TEST_OUTPUT: output};
    const source = await f.put(`${backend}-client.json`, {mcpServers: {isolated: {command: process.execPath, args: [entry], cwd, env}}});
    const catalog = await loadPrinterCatalog(f.current, f.options([source]));
    const config = catalog.resolve(catalog.destinations[1].id);
    assert.deepEqual(config.process.env, env);
    await new PrinterHandoffRunner(config).run({stlPath: await f.put(`${backend}/model.stl`, 'solid model\nendsolid model\n'), print: true});
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => [call.name, call.arguments.bambu_model]), [
      ['slice_stl', 'a1'], ['inspect_print_file', 'a1'], ['print_3mf', 'a1'],
    ]);
  }
});

test('same backend, host and serial keeps the installed route rather than its local duplicate', async t => {
  const f = await fixture(t);
  const source = await f.put('mcp.json', {mcpServers: {'Local P1S': {
    command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {
      BAMBU_PRINTER_HOST: '192.0.2.1', BAMBU_PRINTER_SERIAL: 'private-serial-one', BAMBU_PRINTER_ACCESS_TOKEN: 'other-copy', BAMBU_PRINTER_MODEL: 'p1s',
    },
  }}});
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  assert.equal(catalog.destinations.length, 1);
  assert.deepEqual(catalog.resolve(catalog.defaultDestinationId), f.current);
});

test('public destinations never include credentials, serials, or executable configuration', async t => {
  const f = await fixture(t);
  const source = await f.put('mcp.json', {mcpServers: {'Office': {
    command: 'node', args: ['/opt/mcp-3D-printer-server/dist/index.js'], env: {PRINTER_HOST: 'https://person:secret-in-url@printer.example:8443/private-token', PRINTER_TYPE: 'prusa', API_KEY: 'api-private'},
  }}});
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  assert.equal(catalog.destinations[1].address, 'printer.example:8443');
  const publicJson = JSON.stringify(catalog.destinations);
  for (const forbidden of ['private-', 'secret-', 'api-private', 'BAMBU_TOKEN', 'API_KEY', 'command', 'env', '/opt/']) assert.ok(!publicJson.includes(forbidden), forbidden);
});

test('missing files and unconfigured or unrelated server entries do not fabricate destinations', async t => {
  const f = await fixture(t);
  const source = await f.put('mcp.json', {mcpServers: {
    'bambu-printer': {command: '/bin/echo', args: ['hello'], env: {PRINTER_HOST: '192.0.2.7'}},
    'No configured printer': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js']},
    'Remote HTTP': {url: 'https://example.test/mcp'},
  }});
  const catalog = await loadPrinterCatalog(f.current, f.options([join(f.home, 'missing.json'), source]));
  assert.equal(catalog.destinations.length, 1);
});

test('Codemode configuration directories and client project entries discover existing profiles', async t => {
  const f = await fixture(t);
  await f.put('codemode/profiles/.mcp.json', {mcpServers: {'Farm': {command: '/usr/local/bin/mcp-3d-printer-server', env: {PRINTER_HOST: '192.0.2.40', PRINTER_TYPE: 'octoprint', API_KEY: 'farm-secret'}}}});
  const codemode = await f.put('codemode/codemode-config.json', {configDirectories: ['~/codemode/profiles', '~/missing']});
  const client = await f.put('claude.json', {projects: {'/project': {mcpServers: {'Second': {command: '/usr/local/bin/node', args: ['/opt/mcp-3D-printer-server/dist/index.js'], env: {PRINTER_HOST: '192.0.2.41', PRINTER_TYPE: 'duet'}}}}}});
  const catalog = await loadPrinterCatalog(f.current, f.options([codemode, client]));
  assert.deepEqual(catalog.destinations.slice(1).map(d => d.address).sort(), ['192.0.2.40', '192.0.2.41']);
});

test('process environment overrides dotenv metadata without changing either source', async t => {
  const f = await fixture(t);
  f.current.process.env = {...f.current.process.env, PRINTER_HOST: '192.0.2.70', BAMBU_MODEL: 'a1'};
  delete f.current.selection;
  const catalog = await loadPrinterCatalog(f.current, f.options([]));
  assert.equal(catalog.destinations[0].address, '192.0.2.70');
  assert.equal(catalog.destinations[0].model, 'a1');
  assert.deepEqual(catalog.resolve('current'), f.current);
});

test('same profile name in different client projects retains distinct selectable destinations', async t => {
  const f = await fixture(t);
  const profile = host => ({command: '/usr/local/bin/mcp-3d-printer-server', env: {PRINTER_HOST: host, PRINTER_TYPE: 'klipper'}});
  const source = await f.put('claude.json', {projects: {
    '/first': {mcpServers: {printer: profile('192.0.2.81')}},
    '/second': {mcpServers: {printer: profile('192.0.2.82')}},
  }});
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  const destinations = catalog.destinations.slice(1);
  assert.equal(new Set(destinations.map(d => d.id)).size, 2);
  for (const destination of destinations) assert.equal(catalog.resolve(destination.id).process.env.PRINTER_HOST, destination.address);
});
