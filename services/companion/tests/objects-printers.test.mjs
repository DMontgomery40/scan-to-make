import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {PrinterHandoffRunner} from '@scan-to-make/printer-handoff';
import {loadPrinterCatalog} from '../dist/objects/printers.js';
import {SETUP_FIELDS, withSetupMcp, writeSetupFieldsCache} from './support/setup-mcp.mjs';

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

test('a host-generated empty installation remains downloadable without appearing as a printer', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js');
  const current = {backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [entry]}};
  const catalog = await loadPrinterCatalog(current, {...f.options([]), placeholderEntryPoint: entry});
  assert.deepEqual(catalog.destinations, []);
  assert.deepEqual(catalog.entries(), [{id: 'current', backend: current.backend, config: current}]);
  assert.deepEqual(catalog.resolve('current'), current);
});

test('the first configured printer becomes default instead of the empty host installation', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js');
  const current = {backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [entry]}};
  const source = await f.put('mcp.json', {mcpServers: {'Workshop': {
    command: process.execPath, args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {PRINTER_HOST: '192.0.2.22'},
  }}});
  const catalog = await loadPrinterCatalog(current, {...f.options([source]), placeholderEntryPoint: entry});
  assert.equal(catalog.destinations.length, 1);
  assert.equal(catalog.destinations[0].name, 'Workshop');
  assert.equal(catalog.defaultDestinationId, catalog.destinations[0].id);
});

test('two OctoPrints behind one reverse proxy at different sub-paths stay two printers; the same address is one (Codex review on #389)', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'printers/generic/lib/node_modules/mcp-3d-printer-server/dist/index.js');
  const current = {backend: 'mcp-3d-printer-server', process: {command: process.execPath, args: [entry]}};
  const octo = (host) => ({command: process.execPath, args: ['/opt/mcp-3d-printer-server/dist/index.js'], env: {PRINTER_TYPE: 'octoprint', PRINTER_HOST: host, API_KEY: 'k'}});
  const source = await f.put('mcp.json', {mcpServers: {
    'Printer A': octo('https://pi.lan/printer-a/'), 'Printer B': octo('https://pi.lan/printer-b'), 'Printer A again': octo('https://PI.lan/printer-a'),
  }});
  const catalog = await loadPrinterCatalog(current, {...f.options([source]), placeholderEntryPoint: entry});
  const configured = catalog.destinations.filter(item => item.id !== 'current');
  assert.deepEqual(configured.map(item => item.name).sort(), ['Printer A', 'Printer B'], 'printer-b is its own printer; the two printer-a entries are one');
  assert.ok(configured.every(item => item.address === 'pi.lan'), 'shown by host, told apart by path');
});

test('placeholder detection preserves customized local configurations and remote SSH printers', async t => {
  const f = await fixture(t);
  const entry = join(f.home, 'printers/bambu/lib/node_modules/bambu-printer-mcp/dist/index.js');
  const empty = {backend: 'bambu-printer-mcp', process: {command: process.execPath, args: [entry]}};
  const variants = [
    {...empty, process: {...empty.process, env: {PRINTER_HOST: '192.0.2.22'}}},
    {...empty, process: {...empty.process, cwd: f.home}},
    {...empty, selection: {host: '192.0.2.22'}},
    {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/ssh', args: ['printer-tunnel']}},
  ];
  for (const current of variants) {
    const catalog = await loadPrinterCatalog(current, {...f.options([]), placeholderEntryPoint: entry});
    assert.equal(catalog.destinations[0]?.id, 'current');
  }
  assert.equal((await loadPrinterCatalog(empty, f.options([]))).destinations[0]?.id, 'current');
});

test('current destination inherits metadata without rewriting its working SSH configuration', async t => {
  const f = await fixture(t);
  const catalog = await loadPrinterCatalog(f.current, f.options([]));
  assert.equal(catalog.defaultDestinationId, 'current');
  assert.deepEqual(catalog.destinations, [{id: 'current', name: 'Bambu Lab P1S', backend: 'bambu-printer-mcp', model: 'p1s', address: '192.0.2.1', source: 'current', origin: 'printer-handoff'}]);
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
    // counterpart/1, as both MCPs answer it for a Bambu printer: what it prints with comes from here, not the package name.
    const info = {contract: 'counterpart/1', server: {name: 'isolated-model-schema', version: '0.0.0'}, printer: {kind: 'bambu', host: '192.0.2.90'},
      capabilities: {progress: true, layers: true, camera: 'none', filaments: 'single', pause: true, resume: true, cancel: true, print3mf: true, gcode: true}};
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [...Object.entries(names).map(([name, field]) => ({name,
      inputSchema: {type: 'object', additionalProperties: false, required: [field, 'bambu_model'],
        properties: {[field]: {type: 'string'}, bambu_model: {type: 'string', enum: ['a1']}}}})),
      {name: 'counterpart_printer_info', inputSchema: {type: 'object', properties: {}}}]}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name === 'counterpart_printer_info') return {content: [{type: 'text', text: JSON.stringify(info)}]};
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

test("Codex's config.toml profiles are read: enabled stdio servers only, with their env tables", async t => {
  const f = await fixture(t);
  const node = process.execPath;
  const source = await f.put('.codex/config.toml', `model = "gpt"
[projects."/Users/x"]
trust_level = 'trusted'

[mcp_servers.voron]
command = "/usr/local/bin/mcp-3d-printer-server"
args = []
cwd = "/opt/voron"

[mcp_servers.voron.env]
PRINTER_HOST = "voron.local"
PRINTER_PORT = "7125"
PRINTER_TYPE = "klipper"

[mcp_servers.bambu]
command = "${node}"
args = ["/x/lib/node_modules/npm/bin/npx-cli.js", "-y", "bambu-printer-mcp"]
env = { BAMBU_PRINTER_HOST = "192.0.2.90", BAMBU_PRINTER_SERIAL = "serial-90", BAMBU_PRINTER_MODEL = "a1" }

[mcp_servers.off]
command = "/usr/local/bin/mcp-3d-printer-server"
enabled = false
env = { PRINTER_HOST = "off.local", PRINTER_TYPE = "octoprint" }

[mcp_servers.relative]
command = "/usr/local/bin/mcp-3d-printer-server"
cwd = "."
env = { PRINTER_HOST = "relative.local" }

[mcp_servers.remote]
url = "https://example.test/mcp"

[[skills.config]]
path = "/x"
`);
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  const listed = catalog.destinations.slice(1);
  assert.deepEqual(listed.map(d => [d.name, d.backend, d.address, d.origin]), [
    ['voron', 'mcp-3d-printer-server', 'voron.local', 'codex'],
    ['bambu', 'bambu-printer-mcp', '192.0.2.90', 'codex'],
  ]);
  assert.deepEqual(catalog.resolve(listed[0].id).process, {command: '/usr/local/bin/mcp-3d-printer-server', args: [], cwd: '/opt/voron',
    env: {PRINTER_HOST: 'voron.local', PRINTER_PORT: '7125', PRINTER_TYPE: 'klipper'}});
  assert.equal((await loadPrinterCatalog(f.current, f.options([await f.put('broken.toml', 'a = "unterminated')]))).destinations.length, 1);
});

test('one printer is one destination: keyed by Bambu serial, else host and port, routed to the right MCP', async t => {
  const f = await fixture(t);
  const generic = '/usr/local/bin/mcp-3d-printer-server';
  const claude = await f.put('.claude.json', {mcpServers: {
    // The current P1S again through mcp-3D-printer-server: bambu-printer-mcp (current) keeps it.
    'P1S via generic': {command: generic, env: {PRINTER_HOST: '192.0.2.1', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'PRIVATE-SERIAL-ONE'}},
    // A second Bambu printer only mcp-3D-printer-server knows: it is used.
    'A1 via generic': {command: generic, env: {PRINTER_HOST: '192.0.2.50', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'serial-50'}},
    'Voron': {command: generic, env: {PRINTER_HOST: 'Voron.local', PRINTER_PORT: '7125', PRINTER_TYPE: 'klipper'}},
    'Octo on same host': {command: generic, env: {PRINTER_HOST: 'voron.local', PRINTER_PORT: '80', PRINTER_TYPE: 'octoprint'}},
  }});
  const cursor = await f.put('.cursor/mcp.json', {mcpServers: {
    'Voron again': {command: generic, env: {PRINTER_HOST: 'voron.local', PRINTER_PORT: '7125', PRINTER_TYPE: 'klipper'}},
    // bambu-printer-mcp later reaches the A1 too: it wins over the earlier generic profile.
    'A1': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {BAMBU_PRINTER_HOST: '192.0.2.50', BAMBU_PRINTER_SERIAL: 'SERIAL-50', BAMBU_PRINTER_MODEL: 'a1'}},
  }});
  const catalog = await loadPrinterCatalog(f.current, f.options([claude, cursor]));
  assert.deepEqual(catalog.destinations.map(d => [d.name, d.backend, d.origin]), [
    ['Bambu Lab P1S', 'bambu-printer-mcp', 'printer-handoff'],
    ['Voron', 'mcp-3d-printer-server', 'claude-code'],
    ['Octo on same host', 'mcp-3d-printer-server', 'claude-code'],
    ['A1', 'bambu-printer-mcp', 'cursor'],
  ]);
  const idOf = name => catalog.destinations.find(d => d.name === name)?.id;
  // Losing profiles still resolve, and stand for their printer's winner.
  assert.equal(catalog.canonical('current'), 'current');
  assert.equal(catalog.canonical(idOf('A1')), idOf('A1'));
  assert.equal(catalog.canonical('nope'), undefined);
});

test('when another profile wins over the Mac app\'s own config, the default follows it and old choices still resolve', async t => {
  const f = await fixture(t);
  const current = {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/mcp-3d-printer-server', env: {PRINTER_HOST: '192.0.2.60', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'S60'}}};
  const source = await f.put('mcp.json', {mcpServers: {'X1C': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'],
    env: {BAMBU_PRINTER_HOST: '192.0.2.60', BAMBU_PRINTER_SERIAL: 's60', BAMBU_PRINTER_MODEL: 'x1c'}}}});
  const catalog = await loadPrinterCatalog(current, f.options([source]));
  assert.equal(catalog.destinations.length, 1);
  assert.equal(catalog.destinations[0].name, 'X1C');
  assert.equal(catalog.defaultDestinationId, catalog.destinations[0].id);
  assert.equal(catalog.canonical('current'), catalog.destinations[0].id);
  assert.equal(catalog.resolve('current').backend, 'mcp-3d-printer-server');
});

test('a shared address never merges two printers with different serials, and the configured printer type counts', async t => {
  const f = await fixture(t);
  const source = await f.put('mcp.json', {mcpServers: {
    // An old profile still has the current P1S's IP, but its own serial: a different printer.
    'Old A1': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {BAMBU_PRINTER_HOST: '192.0.2.1', BAMBU_PRINTER_SERIAL: 'another-serial', BAMBU_PRINTER_MODEL: 'a1'}},
  }});
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  assert.equal(catalog.destinations.length, 2);
  // A generic default whose selection says Bambu yields to bambu-printer-mcp at the same address.
  const generic = {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/mcp-3d-printer-server', env: {PRINTER_HOST: '192.0.2.77'}}, selection: {printerType: 'bambu'}};
  const bambu = await f.put('bambu.json', {mcpServers: {'P1P': {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {BAMBU_PRINTER_HOST: '192.0.2.77', BAMBU_PRINTER_MODEL: 'p1p'}}}});
  const routed = await loadPrinterCatalog(generic, f.options([bambu]));
  assert.deepEqual(routed.destinations.map(d => d.name), ['P1P']);
  assert.equal(routed.canonical('current'), routed.destinations[0].id);
});

test('Add printer: found MCP folders and the printers each MCP finds; Check; Add (a folder as is, a form into its own .env, both by the MCP\'s own fields); Printer MCP choice; Remove', async t => {
  const {PrinterSetup, envFor} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const {stat} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'printer-setup-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  // The Mac's own P1S (bambu-printer-mcp), and a clone of mcp-3D-printer-server set up for the same P1S, in no MCP config.
  await put('.env', 'PRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_TOKEN=55550000\nBAMBU_MODEL=p1s\n');
  const clone = join(home, 'mcp-3D-printer-server');
  await put('mcp-3D-printer-server/.env', 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_TOKEN=55550000\nBAMBU_MODEL=p1s\n');
  await put('mcp-3D-printer-server/dist/index.js', '');
  await put('mcp-3D-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.17'}));
  // The app's own copy of mcp-3D-printer-server (a Download).
  const data = join(home, 'Library/Application Support/Scan to Make');
  await put('Library/Application Support/Scan to Make/printers/generic/lib/node_modules/mcp-3d-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.17'}));
  await put('Library/Application Support/Scan to Make/printers/generic/lib/node_modules/mcp-3d-printer-server/dist/index.js', '');
  const env = {...hostEnvironment(data), home};
  const profilesPath = join(env.appPrinters, 'profiles.json');
  const current = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/ssh', args: ['printer-tunnel'], cwd: home}};
  const catalog = await loadPrinterCatalog(current, {homeDirectory: home, sourcePaths: [], profilesPath});
  const busy = new Set(), clients = [];
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64');
  let cameraFormat = 'image/jpeg';
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, reload: () => catalog.reload(), profilesPath,
    node: '/usr/local/bin/node', busy: async id => busy.has(id),
    folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.2.17', hasEnv: true}],
    // Only mcp-3D-printer-server is on this Mac: it finds the Bambu printers and the OctoPrint host itself.
    client: withSetupMcp(config => {
      const calls = [];
      clients.push({config, calls});
      return {connect: async () => ({server: {name: 'x', version: '1'}, tools: [{name: 'get_printer_status'}, {name: 'camera_snapshot'}]}),
        callTool: async (name, args) => {
          calls.push(name);
          if (config.process.env?.PRINTER_HOST === '192.0.2.99') throw new Error('connect ECONNREFUSED 192.0.2.99 token=12345678');
          return {content: [{type: 'text', text: JSON.stringify(name === 'camera_snapshot' ? {format: cameraFormat, base64: jpeg} : {connected: true, status: 'idle', model: 'Bambu Lab P1S', raw: {secret: 'x'}})}]};
        }, close: async () => undefined};
    }, {announced: () => [{kind: 'bambu', source: 'ssdp', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', name: 'Workshop P1S'},
      {kind: 'bambu', source: 'ssdp', host: '192.0.2.9', serial: '03900A000000001', model: 'a1', name: 'A1'},
      {kind: 'octoprint', source: 'bonjour', name: 'OctoPi', host: 'octopi.local', port: 80}]})});

  // Found first: the clone (one click), the P1S already a printer, the new A1, the OctoPrint. No secret anywhere.
  const discovery = await setup.discover();
  assert.deepEqual(discovery.found.map(item => [item.source, item.name, item.added]), [
    ['folder', 'Bambu Lab P1S', false], ['ssdp', 'Workshop P1S', true], ['ssdp', 'A1', false], ['bonjour', 'OctoPi', false]]);
  assert.deepEqual(discovery.found[0], {id: `folder:${clone}`, source: 'folder', name: 'Bambu Lab P1S', backend: 'mcp-3d-printer-server',
    printerType: 'bambu', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', folder: clone, added: false});
  assert.ok(!JSON.stringify(discovery).includes('55550000'), 'never an access code');
  // The brand list, models and serial table are the MCP's own (counterpart_setup_fields), never the app's.
  assert.deepEqual(discovery.options.types.map(type => type.printerType), SETUP_FIELDS['mcp-3d-printer-server'].kinds.map(kind => kind.kind));
  assert.deepEqual(discovery.options.models['mcp-3d-printer-server'], SETUP_FIELDS['mcp-3d-printer-server'].kinds[0].fields.find(item => item.name === 'model').choices);
  assert.equal(discovery.options.models['bambu-printer-mcp'], undefined, 'an MCP this Mac doesn\'t have offers nothing');
  assert.equal(discovery.options.slicer['mcp-3d-printer-server'].fields[0].env, 'SLICER_TYPE', 'and the slicer settings it declares');
  assert.deepEqual(discovery.found.find(item => item.source === 'bonjour'), {id: 'bonjour:octopi.local:80', source: 'bonjour', name: 'OctoPi',
    backend: 'mcp-3d-printer-server', printerType: 'octoprint', host: 'octopi.local', port: '80', added: false});

  // Check runs the chosen MCP with these settings (nothing written) and only status and camera; never a print.
  const form = {backend: 'mcp-3d-printer-server', printerType: 'octoprint', host: 'octopi.local.', port: '80', secret: 'octo-key'};
  const {PrinterFormSchema} = await import('../dist/printing/setup.js');
  const a1 = {backend: 'mcp-3d-printer-server', printerType: 'bambu', host: '192.0.2.9', serial: '03900A000000001', model: 'a1', secret: '87654321'};
  const checked = await setup.check(PrinterFormSchema.parse(a1));
  assert.deepEqual(checked, {reached: true, camera: 'connected', image: {mimeType: 'image/jpeg', base64: jpeg}});
  assert.deepEqual(clients.at(-1).calls, ['get_printer_status', 'camera_snapshot']);
  assert.deepEqual(clients.at(-1).config.process.env, {MCP_TRANSPORT: 'stdio', PRINTER_HOST: '192.0.2.9', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: '03900A000000001', BAMBU_MODEL: 'a1', BAMBU_TOKEN: '87654321'});
  assert.equal(clients.at(-1).config.process.cwd, join(env.appPrinters, 'profiles'), 'a folder with no .env of its own');
  cameraFormat = 'jpeg';
  assert.deepEqual(await setup.check(PrinterFormSchema.parse(a1)), checked, 'both MCP JPEG format names display the camera');
  // A printer with no camera tool is checked by status alone.
  await setup.check(PrinterFormSchema.parse(form));
  assert.deepEqual(clients.at(-1).calls, ['get_printer_status']);
  await assert.rejects(setup.check(PrinterFormSchema.parse({...a1, backend: 'bambu-printer-mcp'})), /Download bambu-printer-mcp first/);
  const unreachable = await setup.check(PrinterFormSchema.parse({...form, host: '192.0.2.99'}));
  assert.deepEqual(unreachable, {reached: false, camera: 'not-supported'}, 'the MCP\'s own words (and the key) never come back');
  // A found folder is checked as it runs: its own .env, nothing passed.
  await setup.check({folder: clone});
  assert.deepEqual(clients.at(-1).config.process, {command: '/usr/local/bin/node', args: [join(clone, 'dist/index.js')], cwd: clone});

  // Add the clone: it runs where it is. It is the same P1S, so the rule keeps bambu-printer-mcp and Settings offers the choice.
  const viaClone = await setup.add({folder: clone});
  assert.equal(viaClone.destinationId, 'current');
  assert.equal(viaClone.sameAs, 'current');
  const saved = JSON.parse(await readFile(profilesPath, 'utf8'));
  assert.deepEqual(saved.profiles[0].process, {command: '/usr/local/bin/node', args: [join(clone, 'dist/index.js')], cwd: clone});
  assert.equal(saved.profiles[0].owned, false);
  assert.deepEqual(catalog.destinations.find(item => item.id === 'current').mcps, [{backend: 'bambu-printer-mcp', destinationId: 'current'}, {backend: 'mcp-3d-printer-server', destinationId: viaClone.id}]);
  await assert.rejects(setup.add({folder: clone}), /one of your printers already/);
  assert.equal((await setup.discover()).found.filter(item => item.source === 'folder').length, 0, 'an added folder isn\'t offered again');

  // Printer MCP: this printer only now uses mcp-3D-printer-server; a project that chose `current` follows it.
  busy.add('current');
  await assert.rejects(setup.chooseMcp('current', 'mcp-3d-printer-server'), /printing/);
  busy.delete('current');
  assert.deepEqual(await setup.chooseMcp('current', 'mcp-3d-printer-server'), {destinationId: viaClone.id});
  assert.equal(catalog.canonical('current'), viaClone.id);
  assert.ok(catalog.destinations.find(item => item.id === viaClone.id).aliases.includes('current'));
  assert.equal(catalog.defaultDestinationId, viaClone.id);
  const listed = catalog.destinations.find(item => item.id === viaClone.id);
  assert.deepEqual([listed.origin, listed.backend, listed.folder, listed.mcps.map(item => item.backend)], ['counterpart', 'mcp-3d-printer-server', clone, ['mcp-3d-printer-server', 'bambu-printer-mcp']]);
  assert.deepEqual(JSON.parse(await readFile(profilesPath, 'utf8')).choices, {'serial:01P00A123456789': 'mcp-3d-printer-server'});
  await setup.chooseMcp(viaClone.id, 'bambu-printer-mcp');
  assert.equal(catalog.canonical(viaClone.id), 'current');
  assert.ok(catalog.destinations.find(item => item.id === 'current').aliases.includes(viaClone.id));

  // Add from the form: its own folder and .env (0600) with exactly the MCP's variables, running the app's copy.
  const octo = await setup.add(PrinterFormSchema.parse(form));
  const folder = join(env.appPrinters, 'profiles', octo.id);
  assert.equal(octo.destinationId, octo.id);
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), "# Written by Counterpart (Settings → Printers → Add printer…). The printer MCP reads it; edit it here for anything advanced.\n" +
    "MCP_TRANSPORT='stdio'\nPRINTER_TYPE='octoprint'\nPRINTER_HOST='octopi.local'\nPRINTER_PORT='80'\nAPI_KEY='octo-key'\n");
  assert.equal((await stat(join(folder, '.env'))).mode & 0o777, 0o600);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  const added = catalog.destinations.find(item => item.id === octo.id);
  assert.deepEqual([added.name, added.backend, added.address, added.origin, added.folder], ['OctoPrint at octopi.local', 'mcp-3d-printer-server', 'octopi.local', 'counterpart', folder]);
  assert.deepEqual(catalog.resolve(octo.id).process, {command: '/usr/local/bin/node', args: [join(env.appPrinters, 'generic/lib/node_modules/mcp-3d-printer-server/dist/index.js')], cwd: folder});
  assert.ok(!(await readFile(profilesPath, 'utf8')).includes('octo-key'), 'the list keeps no settings');
  // Bambu through bambu-printer-mcp needs that MCP on this Mac first.
  await assert.rejects(setup.add(PrinterFormSchema.parse({backend: 'bambu-printer-mcp', printerType: 'bambu', host: '192.0.2.9', serial: '03900A000000001', model: 'a1', secret: '87654321'})), /Download bambu-printer-mcp first/);
  // The form refuses what the MCP can't use, by the MCP's own fields.
  await assert.rejects(setup.check(PrinterFormSchema.parse({...form, printerType: 'makerbot'})), /doesn’t drive that kind of printer/);
  await assert.rejects(setup.check(PrinterFormSchema.parse({...a1, model: 'x2d'})), /doesn’t know that model/);
  await assert.rejects(setup.add(PrinterFormSchema.parse({...a1, slicer: 'cura-classic'})), /doesn’t use that slicer/);
  // A web address only where the MCP's own host field takes one (`input: "url"`; this MCP version declares none), and
  // never with credentials, a query or a second line.
  await assert.rejects(setup.check(PrinterFormSchema.parse({...form, host: 'http://evil/x'})), /without http:\/\/ or a path/);
  for (const host of ['http://user:pw@evil/x', 'http://evil/x?PRINTER_HOST=y', 'http://evil/x\nPRINTER_HOST=evil', "http://evil/x'"])
    assert.equal(PrinterFormSchema.safeParse({...form, host}).success, false, host);
  assert.equal(PrinterFormSchema.safeParse({...form, secret: "a'\nPRINTER_HOST=evil"}).success, false);
  const bambuKind = SETUP_FIELDS['mcp-3d-printer-server'].kinds.find(kind => kind.kind === 'bambu'), slicer = SETUP_FIELDS['mcp-3d-printer-server'].slicer;
  assert.deepEqual(envFor(PrinterFormSchema.parse({backend: 'mcp-3d-printer-server', printerType: 'bambu', host: '192.0.2.9', serial: '03900a000000001', model: 'a1', secret: '87654321'}), bambuKind, slicer),
    {MCP_TRANSPORT: 'stdio', PRINTER_HOST: '192.0.2.9', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: '03900A000000001', BAMBU_MODEL: 'a1', BAMBU_TOKEN: '87654321'});
  // Where Bambu Studio is, when it isn't where the MCP looks (the Linux desktop, Nov 5): written as the MCP's own setting.
  assert.equal(envFor(PrinterFormSchema.parse({...form, slicerPath: '/opt/bambu/bin/bambu-studio'}), SETUP_FIELDS['mcp-3d-printer-server'].kinds[1], slicer).SLICER_PATH, '/opt/bambu/bin/bambu-studio');
  assert.equal(PrinterFormSchema.safeParse({...form, slicerPath: 'relative/bambu-studio'}).success, false);
  // A folder may be named "José"; only what would break the .env line is refused (Codex review on #346).
  const unicode = envFor(PrinterFormSchema.parse({...form, slicerPath: '/Users/José/Applications/BambuStudio.app/Contents/MacOS/BambuStudio'}), SETUP_FIELDS['mcp-3d-printer-server'].kinds[1], slicer);
  assert.equal(unicode.SLICER_PATH, '/Users/José/Applications/BambuStudio.app/Contents/MacOS/BambuStudio');
  for (const bad of ["/Users/x/it's/slicer", '/Users/x/a\nPRINTER_HOST=evil']) assert.equal(PrinterFormSchema.safeParse({...form, slicerPath: bad}).success, false, bad);
  // The slicer the person picks from the MCP's list is written with its app, so the two agree.
  const chosen = envFor(PrinterFormSchema.parse({...form, slicer: 'orcaslicer', slicerPath: '/opt/orca/bin/orca-slicer'}), SETUP_FIELDS['mcp-3d-printer-server'].kinds[1], slicer);
  assert.deepEqual([chosen.SLICER_TYPE, chosen.SLICER_PATH], ['orcaslicer', '/opt/orca/bin/orca-slicer']);

  // Remove: only Counterpart's printers, between prints; its folder goes only if Counterpart made it.
  await assert.rejects(setup.remove('current'), /Only printers added in Counterpart/);
  busy.add(octo.id);
  await assert.rejects(setup.remove(octo.id), /printing/);
  busy.delete(octo.id);
  assert.deepEqual(await setup.remove(octo.id), {removed: true});
  await assert.rejects(stat(folder), /ENOENT/);
  assert.ok(!catalog.destinations.some(item => item.id === octo.id));
  await setup.remove(viaClone.id);
  assert.ok((await stat(join(clone, '.env'))).isFile(), 'a folder found on the Mac stays');
  assert.equal(catalog.destinations.find(item => item.id === 'current').mcps, undefined);
});

test('a found install missing the model its MCP needs: Counterpart fills only BAMBU_MODEL (SSDP, else the serial), appends it, records it, and Complete Settings fixes one already added', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const {stat, chmod} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'printer-fill-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  await put('.env', 'PRINTER_HOST=192.0.2.50\nPRINTER_TYPE=octoprint\n');
  // David's ~/mcp-3D-printer-server: everything for his P1S but the model (comments and order must survive).
  const clone = join(home, 'mcp-3D-printer-server');
  const original = '# my printer\nPRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_TOKEN=55550000\nSLICER_TYPE=orcaslicer-bambulab # FULU';
  await put('mcp-3D-printer-server/.env', original);
  await chmod(join(clone, '.env'), 0o640);
  await put('mcp-3D-printer-server/dist/index.js', '');
  await put('mcp-3D-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.17'}));
  // Another clone for a printer whose serial names no model, and with no access code either.
  const other = join(home, 'src/mcp-3d-printer-server');
  await put('src/mcp-3d-printer-server/.env', 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.2\nBAMBU_SERIAL=ZZZ00A000000001\n');
  await put('src/mcp-3d-printer-server/dist/index.js', '');
  await put('src/mcp-3d-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.17'}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const env = {...hostEnvironment(data), home};
  const profilesPath = join(env.appPrinters, 'profiles.json'), setupCachePath = join(env.appPrinters, 'mcp-setup.json');
  const current = {backend: 'mcp-3d-printer-server', process: {command: '/usr/bin/ssh', args: ['printer-tunnel'], cwd: home}};
  const catalog = await loadPrinterCatalog(current, {homeDirectory: home, sourcePaths: [], profilesPath, setupCachePath});
  let announced = [];
  const restarted = [];
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, reload: () => catalog.reload(), profilesPath,
    node: '/usr/local/bin/node', busy: async () => false, restart: async id => { restarted.push(id); }, setupCachePath,
    client: withSetupMcp(undefined, {announced: () => announced}),
    folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.2.17', hasEnv: true}, {dir: other, package: 'mcp-3d-printer-server', version: '1.2.17', hasEnv: true}]});

  // Offered with what Counterpart will add: the model from the serial (01P → P1S), and nothing else.
  let found = (await setup.discover()).found;
  const p1s = found.find(item => item.folder === clone);
  assert.deepEqual([p1s.name, p1s.model, p1s.missing, p1s.fill], ['Bambu Lab P1S', 'p1s', ['BAMBU_MODEL'], {BAMBU_MODEL: 'p1s'}]);
  const unknown = found.find(item => item.folder === other);
  assert.deepEqual([unknown.missing, unknown.fill, unknown.model], [['BAMBU_MODEL', 'BAMBU_TOKEN'], {}, undefined], 'a secret is never filled; an unknown serial needs the dropdown');
  // The printer's own announcement (DevModel) outranks the serial.
  announced = [{kind: 'bambu', source: 'ssdp', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1p', name: 'Workshop'}];
  assert.deepEqual((await setup.discover()).found.find(item => item.folder === clone).fill, {BAMBU_MODEL: 'p1p'});
  announced = [];
  assert.deepEqual((await setup.discover()).found.find(item => item.source === 'ssdp'), undefined);
  const {options} = await setup.discover();
  assert.equal(options.serialModels['01P'], 'p1s', 'the sheet fills a typed serial\'s model from the same table');

  // Add appends exactly that one variable: every other line, its order and the file's mode stay.
  const added = await setup.add({folder: clone});
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), `${original}\nBAMBU_MODEL='p1s'\n`);
  assert.equal((await stat(join(clone, '.env'))).mode & 0o777, 0o640);
  const saved = JSON.parse(await readFile(profilesPath, 'utf8')).profiles.find(item => item.id === added.id);
  assert.equal(saved.model, 'p1s');
  assert.equal(catalog.resolve(added.id).selection.model, 'p1s', 'Counterpart passes bambu_model to that MCP');
  assert.equal(catalog.destinations.find(item => item.id === added.id).incomplete, undefined);
  // A model Counterpart can't tell must be chosen; the choice is checked against that MCP's own list.
  await assert.rejects(setup.add({folder: other}), /Choose the printer’s model/);
  await assert.rejects(setup.add({folder: other, model: 'x2d'}), /doesn’t know that model/);
  assert.equal(await readFile(join(other, '.env'), 'utf8'), 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.2\nBAMBU_SERIAL=ZZZ00A000000001\n', 'nothing written when refused');

  // A printer added before this fix (no model in its .env or its profile): Settings says so, and Complete Settings fills it.
  await writeFile(join(clone, '.env'), original);
  await writeFile(profilesPath, JSON.stringify({version: 1, choices: {}, profiles: [{...saved, model: undefined}]}));
  await catalog.reload();
  assert.deepEqual(catalog.destinations.find(item => item.id === added.id).incomplete, {missing: ['BAMBU_MODEL'], fill: {BAMBU_MODEL: 'p1s'}});
  assert.equal(catalog.resolve(added.id).selection?.model, undefined);
  assert.deepEqual(await setup.completeSettings(added.id), {destinationId: added.id, model: 'p1s'});
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), `${original}\nBAMBU_MODEL='p1s'\n`);
  assert.deepEqual(restarted, [added.id], 'its MCP restarts to read the file again');
  assert.equal(catalog.resolve(added.id).selection.model, 'p1s');
  assert.equal(catalog.destinations.find(item => item.id === added.id).incomplete, undefined);
  // Nothing left to fill: the file isn't touched again.
  await setup.completeSettings(added.id);
  assert.equal((await readFile(join(clone, '.env'), 'utf8')).match(/BAMBU_MODEL/g).length, 1);
  await assert.rejects(setup.completeSettings('current'), /Only printers added in Counterpart/);
});

test('a printer\'s services rebuilt after Complete Settings keep its pooled session and confirmation relay, and carry the new model', async t => {
  const {createPrintHandoffServices} = await import('../dist/print-handoff-http.js');
  const {PrinterSessionPool} = await import('@scan-to-make/printer-handoff');
  const dir = await mkdtemp(join(tmpdir(), 'printer-services-'));
  const pool = new PrinterSessionPool();
  t.after(async () => { await pool.close(); await rm(dir, {recursive: true, force: true}); });
  const config = {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/node', args: ['/x/dist/index.js'], cwd: '/x'}, selection: {printerType: 'bambu'}};
  const before = createPrintHandoffServices(config, dir, {pool, destinationId: 'counterpart-1'});
  const after = createPrintHandoffServices({...config, selection: {printerType: 'bambu', model: 'p1s'}}, dir, {pool, destinationId: 'counterpart-1', relay: before.relay});
  assert.equal(after.relay, before.relay, 'confirmations from the session still reach these services');
  assert.equal(after.runner.session, before.runner.session, 'the same long-lived MCP session');
  assert.equal(after.selection.model, 'p1s');
  assert.equal(before.selection.model, undefined);
});

test('review fix (#295): an MCP known only through an npx profile is not "installed": Download gets a copy Check and Add can run', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-setup-npx-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const env = {...hostEnvironment(join(home, 'Library/Application Support/Scan to Make')), home};
  const npx = {backend: 'mcp-3d-printer-server', process: {command: '/opt/homebrew/bin/npx', args: ['-y', 'mcp-3d-printer-server']}};
  const downloads = [];
  const setup = new PrinterSetup({env, configs: () => [{id: 'claude-desktop:printer', config: npx}], profilesPath: join(home, 'profiles.json'),
    node: '/usr/local/bin/node', folders: async () => [],
    download: async pkg => { downloads.push(pkg); return {mcpId: 'mcp-0000000000000000', state: 'started'}; }});
  const view = (await setup.mcps()).packages.find(item => item.package === 'mcp-3d-printer-server');
  assert.equal(view.installed, false, 'npx fetches it only when that client starts it');
  assert.ok(view.installs.some(install => install.kind === 'npx'), 'the npx profile is still listed');
  assert.deepEqual(await setup.installMcp('mcp-3d-printer-server'), {update: {mcpId: 'mcp-0000000000000000', state: 'started'}});
  assert.deepEqual(downloads, ['mcp-3d-printer-server']);
  await assert.rejects(setup.check({backend: 'mcp-3d-printer-server', printerType: 'octoprint', host: 'octopi.local', port: '80', secret: 'k'}), /Download mcp-3D-printer-server first/);
});

test('an mcp-3D-printer-server Bambu printer with no route gets the authenticated route another MCP uses for the same serial: its route and session directory, verbatim, only when that MCP reads them', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const {stat, chmod} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'printer-route-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  // The Mac's own bambu-printer-mcp, run over ssh into ~/bambu-printer-mcp (resolveMcpInstall's via.cwd), printing through FULU.
  const bambuDir = join(home, 'bambu-printer-mcp');
  const routeLines = ['BAMBU_DEFAULT_CONNECTION_MODE=bambu_network', 'BAMBU_DEFAULT_CONNECTION_TYPE="lan"',
    "BAMBU_NETWORK_BRIDGE_COMMAND='ssh -i ~/.ssh/fulu fulu-vm /opt/bridge --printer 01P00A123456789'", "BAMBU_NETWORK_CONFIG_DIR='/sessions/source-bambu'"];
  const bambuEnv = (serial, lines = routeLines) => ['PRINTER_HOST=192.0.2.1', `BAMBU_SERIAL=${serial}`, 'BAMBU_TOKEN=55550000', 'BAMBU_MODEL=p1s',
    'BAMBU_DEV_ID=dev-secret-1', ...lines, 'CLOUD_TOKEN=cloud-secret-2', ''].join('\n');
  await put('bambu-printer-mcp/.env', bambuEnv('01P00A123456789'));
  // The clone of mcp-3D-printer-server for the same P1S: no route of its own.
  const clone = join(home, 'mcp-3D-printer-server');
  const original = 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_TOKEN=55550000\nBAMBU_MODEL=p1s\n';
  await put('mcp-3D-printer-server/.env', original);
  await chmod(join(clone, '.env'), 0o640);
  const reads = 'const mode = process.env.BAMBU_DEFAULT_CONNECTION_MODE;\n';
  await put('mcp-3D-printer-server/dist/index.js', reads);
  await put('mcp-3D-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.3.0'}));
  const env = {...hostEnvironment(join(home, 'Library/Application Support/Scan to Make')), home};
  const profilesPath = join(env.appPrinters, 'profiles.json');
  const current = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/ssh', args: ['127.0.0.1', `cd '${bambuDir}' && exec node dist/index.js`]}};
  const setupCachePath = await writeSetupFieldsCache(join(env.appPrinters, 'mcp-setup.json'));
  const catalog = await loadPrinterCatalog(current, {homeDirectory: home, sourcePaths: [], profilesPath, setupCachePath});
  const restarted = [];
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, reload: () => catalog.reload(), profilesPath,
    node: '/usr/local/bin/node', busy: async () => false, restart: async id => { restarted.push(id); }, client: withSetupMcp(), setupCachePath,
    folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.3.0', hasEnv: true}]});
  const offered = async () => (await setup.discover()).found.find(item => item.folder === clone);
  const values = {BAMBU_DEFAULT_CONNECTION_MODE: 'bambu_network', BAMBU_DEFAULT_CONNECTION_TYPE: 'lan', BAMBU_NETWORK_CONFIG_DIR: '/sessions/source-bambu',
    BAMBU_NETWORK_BRIDGE_COMMAND: 'ssh -i ~/.ssh/fulu fulu-vm /opt/bridge --printer 01P00A123456789'};

  // Nothing is offered for another printer's route, a route without a bridge, or an MCP copy that doesn't read it.
  await put('bambu-printer-mcp/.env', bambuEnv('03900A000000001'));
  assert.equal((await offered()).fill, undefined, 'a different serial');
  await put('bambu-printer-mcp/.env', bambuEnv('01P00A123456789', [routeLines[0], routeLines[1]]));
  assert.equal((await offered()).fill, undefined, 'no bridge command');
  await put('bambu-printer-mcp/.env', bambuEnv('01P00A123456789'));
  await put('mcp-3D-printer-server/dist/index.js', 'console.log("an older release");\n');
  assert.equal((await offered()).fill, undefined, 'its dist doesn\'t read BAMBU_DEFAULT_CONNECTION_MODE');
  await put('mcp-3D-printer-server/dist/index.js', reads);

  // The same serial: only the route and session-directory keys, nothing else from that file.
  const candidate = await offered();
  assert.deepEqual([candidate.missing, candidate.fill], [[], values]);
  assert.ok(!JSON.stringify(candidate).match(/dev-secret-1|cloud-secret-2|55550000/), 'no other key, and never a token');

  // Add appends those lines as they are written there (quoting included); every other line and the mode stay.
  const added = await setup.add({folder: clone});
  const routed = `${original}${routeLines.join('\n')}\n`;
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), routed);
  assert.equal((await stat(join(clone, '.env'))).mode & 0o777, 0o640);
  assert.equal(catalog.destinations.find(item => item.id === added.id).incomplete, undefined);
  // A route of its own is never replaced.
  assert.equal((await setup.completeSettings(added.id)).destinationId, added.id);
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), routed);

  // A printer added before this: Settings offers it with nothing strictly missing, and Complete Settings appends it.
  await writeFile(join(clone, '.env'), original);
  restarted.length = 0;
  await catalog.reload();
  assert.deepEqual(catalog.destinations.find(item => item.id === added.id).incomplete, {missing: [], fill: values});
  await setup.completeSettings(added.id);
  assert.equal(await readFile(join(clone, '.env'), 'utf8'), routed);
  assert.deepEqual(restarted, [added.id]);
  assert.equal(catalog.destinations.find(item => item.id === added.id).incomplete, undefined);
});

test('the same printer through another MCP keeps its nozzle and bed: a profile that does not set them takes the Mac app\'s own (the P1S refused through mcp-3D-printer-server, 2026-11-03)', async t => {
  const f = await fixture(t);
  const current = {...f.current, selection: {model: 'p1s', nozzleType: 'hardened_steel', nozzleDiameterMm: 0.4, bedType: 'textured_plate'}};
  const folder = join(f.home, 'mcp-3D-printer-server');
  await f.put('mcp-3D-printer-server/.env', 'PRINTER_HOST=192.0.2.1\nPRINTER_TYPE=bambu\nBAMBU_SERIAL=PRIVATE-SERIAL-ONE\nBAMBU_MODEL=p1s\n');
  const profilesPath = await f.put('printers/profiles.json', {version: 1, profiles: [{id: 'counterpart-0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11', name: 'P1S via mcp-3D', backend: 'mcp-3d-printer-server',
    process: {command: '/usr/local/bin/node', args: [join(folder, 'dist/index.js')], cwd: folder}, owned: false, model: 'p1s'}],
    choices: {'serial:PRIVATE-SERIAL-ONE': 'mcp-3d-printer-server'}});
  const generic = '/usr/local/bin/mcp-3d-printer-server';
  const claude = await f.put('.claude.json', {mcpServers: {
    // The same P1S in a client config, and a different printer: only the P1S's profiles take the P1S's hardware.
    'P1S via generic': {command: generic, env: {PRINTER_HOST: '192.0.2.1', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'private-serial-one'}},
    'A1 via generic': {command: generic, env: {PRINTER_HOST: '192.0.2.50', PRINTER_TYPE: 'bambu', BAMBU_SERIAL: 'serial-50', BAMBU_MODEL: 'a1'}},
  }});
  const catalog = await loadPrinterCatalog(current, {...f.options([claude]), profilesPath});
  // The person chose mcp-3D for the P1S: that profile is the destination prints go to.
  assert.equal(catalog.defaultDestinationId, 'counterpart-0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11');
  assert.deepEqual(catalog.resolve('counterpart-0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11').selection, {model: 'p1s', printerType: 'bambu', nozzleType: 'hardened_steel', nozzleDiameterMm: 0.4, bedType: 'textured_plate'});
  const entry = name => catalog.entries().find(item => item.config.process.command === generic && item.config.process.env?.BAMBU_SERIAL === name);
  assert.equal(catalog.resolve(entry('private-serial-one').id).selection.nozzleType, 'hardened_steel');
  const a1 = catalog.resolve(entry('serial-50').id).selection;
  assert.equal(a1.nozzleType, undefined);
  assert.equal(a1.bedType, undefined);
  // The Mac app's own config is unchanged, and a profile's own value is never replaced.
  assert.deepEqual(catalog.resolve('current').selection, current.selection);
});

test('Complete Settings repairs a copied FULU route with the source MCP session folder and preserves an explicit target folder', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const f = await fixture(t);
  const source = join(f.home, 'bambu-printer-mcp');
  const target = join(f.home, 'mcp-3D-printer-server');
  const route = "BAMBU_DEFAULT_CONNECTION_MODE=bambu_network\nBAMBU_DEFAULT_CONNECTION_TYPE=cloud\nBAMBU_NETWORK_BRIDGE_COMMAND='/test/shared-fulu-launcher'\n";
  const common = 'PRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=PRIVATE-SERIAL-ONE\nBAMBU_MODEL=p1s\n';
  await f.put('bambu-printer-mcp/.env', common + route);
  await f.put('mcp-3D-printer-server/.env', 'PRINTER_TYPE=bambu\n' + common + route);
  await f.put('mcp-3D-printer-server/package.json', {name: 'mcp-3d-printer-server', version: '1.3.0'});
  await f.put('mcp-3D-printer-server/dist/index.js', 'const route = process.env.BAMBU_DEFAULT_CONNECTION_MODE;');
  const id = 'counterpart-0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a11';
  const profilesPath = await f.put('printers/profiles.json', {version: 1, profiles: [{id, name: 'Generic', backend: 'mcp-3d-printer-server',
    process: {command: process.execPath, args: [join(target, 'dist/index.js')], cwd: target}, owned: false}], choices: {'serial:PRIVATE-SERIAL-ONE': 'mcp-3d-printer-server'}});
  const current = {backend: 'bambu-printer-mcp', process: {command: process.execPath, args: ['/test/source-mcp.js'], cwd: source}};
  const setupCachePath = await writeSetupFieldsCache(join(f.home, 'printers/mcp-setup.json'));
  const catalog = await loadPrinterCatalog(current, {homeDirectory: f.home, sourcePaths: [], profilesPath, setupCachePath});
  const calls = [];
  const setup = new PrinterSetup({env: {...hostEnvironment(join(f.home, 'app')), home: f.home}, configs: () => catalog.entries(), catalog: () => catalog,
    profilesPath, setupCachePath, reload: () => catalog.reload(), restart: async () => {}, client: withSetupMcp(config => {
      assert.equal(config.process.cwd, source, 'inspect the existing source MCP, never the generic target');
      return {connect: async () => ({tools: [{name: 'bambu_network_bridge_status'}]}),
        callTool: async name => { calls.push(name); return {content: [{type: 'text', text: JSON.stringify({configDir: '/sessions/source default'})}]}; },
        close: async () => {}};
    })});
  assert.ok(catalog.destinations.find(item => item.id === id).incomplete, 'an already copied route missing its session folder must offer completion');
  const before = await readFile(join(target, '.env'), 'utf8');
  await setup.completeSettings(id);
  const repaired = await readFile(join(target, '.env'), 'utf8');
  assert.equal(repaired, before + 'BAMBU_NETWORK_CONFIG_DIR="/sessions/source default"\n');
  assert.deepEqual(calls, ['bambu_network_bridge_status']);
  await writeFile(join(target, '.env'), before + "BAMBU_NETWORK_CONFIG_DIR='/sessions/explicit-target'\n");
  await setup.completeSettings(id);
  assert.equal(await readFile(join(target, '.env'), 'utf8'), before + "BAMBU_NETWORK_CONFIG_DIR='/sessions/explicit-target'\n");
  assert.deepEqual(calls, ['bambu_network_bridge_status'], 'an explicit target session folder never needs probing or replacement');
  await writeFile(join(target, '.env'), 'PRINTER_TYPE=bambu\n' + common + "BAMBU_NETWORK_CONFIG_DIR='/sessions/explicit-target'\n");
  await setup.completeSettings(id);
  const fresh = await readFile(join(target, '.env'), 'utf8');
  assert.match(fresh, /BAMBU_DEFAULT_CONNECTION_MODE=bambu_network/);
  assert.match(fresh, /BAMBU_NETWORK_CONFIG_DIR='\/sessions\/explicit-target'/);
  assert.equal((fresh.match(/BAMBU_NETWORK_CONFIG_DIR=/g) ?? []).length, 1, 'new setup keeps the explicit target directory too');
  assert.deepEqual(calls, ['bambu_network_bridge_status']);
});

test('review fix (#295): a printer that only borrows a found checkout\'s code doesn\'t hide that checkout\'s own printer', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'setup-borrow-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  const clone = join(home, 'mcp-3D-printer-server');
  await put('mcp-3D-printer-server/.env', 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.5\nBAMBU_SERIAL=01P00A000000005\nBAMBU_TOKEN=55550000\nBAMBU_MODEL=p1s\n');
  await put('mcp-3D-printer-server/dist/index.js', '');
  await put('mcp-3D-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.27'}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const env = {...hostEnvironment(data), home};
  const profilesPath = join(env.appPrinters, 'profiles.json');
  const entry = join(clone, 'dist/index.js');
  // An OctoPrint added through the form: it runs the clone's code, with its settings in its own profile folder.
  const ownFolder = join(env.appPrinters, 'profiles', 'octo');
  await put('Library/Application Support/Scan to Make/printers/profiles/octo/.env', 'PRINTER_TYPE=octoprint\nPRINTER_HOST=octopi.local\n');
  // And one whose settings are inline, with no folder of its own.
  const configs = [
    {id: 'octo', config: {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/node', args: [entry], cwd: ownFolder}}},
    {id: 'inline', config: {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/node', args: [entry], env: {PRINTER_TYPE: 'klipper', PRINTER_HOST: 'voron.local'}}}},
  ];
  const setup = new PrinterSetup({env, configs: () => configs, profilesPath, node: '/usr/local/bin/node',
    folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.2.27', hasEnv: true}],
    client: withSetupMcp()});
  const found = (await setup.discover()).found.filter(item => item.source === 'folder');
  assert.deepEqual(found.map(item => [item.folder, item.host]), [[clone, '192.0.2.5']], 'the clone\'s own P1S is still offered');
  const added = await setup.add({folder: clone});
  assert.ok(added.id);
  // Once a printer reads its settings from the clone, the clone is that printer.
  configs.push({id: 'clone', config: {backend: 'mcp-3d-printer-server', process: {command: '/usr/local/bin/node', args: [entry], cwd: clone}}});
  assert.equal((await setup.discover()).found.filter(item => item.source === 'folder').length, 0);
  await assert.rejects(setup.add({folder: clone}), /one of your printers already/);
});


test('public aliases include every canonical duplicate, including two configurations of one MCP', async t => {
  const f = await fixture(t);
  const source = await f.put('aliases.json', {mcpServers: {
    first: {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {PRINTER_HOST: '192.0.2.1'}},
    second: {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {PRINTER_HOST: '192.0.2.1', MCP_TRANSPORT: 'stdio'}},
    separate: {command: 'node', args: ['/opt/bambu-printer-mcp/dist/index.js'], env: {PRINTER_HOST: '192.0.2.88'}},
  }});
  const catalog = await loadPrinterCatalog(f.current, f.options([source]));
  const aliases = catalog.entries().map(entry => entry.id).filter(id => id !== 'current' && catalog.canonical(id) === 'current');
  assert.equal(aliases.length, 2);
  assert.deepEqual(catalog.destinations.find(d => d.id === 'current').aliases, aliases);
  assert.equal(catalog.destinations.find(d => d.address === '192.0.2.88').aliases, undefined);
});

test('a printer\'s missing settings show as soon as its MCP\'s fields are read, without a restart (Cursor review on #346)', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-fields-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  const clone = join(home, 'mcp-3D-printer-server');
  await put('mcp-3D-printer-server/.env', 'PRINTER_TYPE=bambu\nPRINTER_HOST=192.0.2.1\nBAMBU_SERIAL=01P00A123456789\nBAMBU_TOKEN=55550000\n');
  await put('mcp-3D-printer-server/dist/index.js', '');
  await put('mcp-3D-printer-server/package.json', JSON.stringify({name: 'mcp-3d-printer-server', version: '1.2.37'}));
  const env = {...hostEnvironment(join(home, 'Library/Application Support/Scan to Make')), home};
  const profilesPath = join(env.appPrinters, 'profiles.json'), setupCachePath = join(env.appPrinters, 'mcp-setup.json');
  const id = 'counterpart-0b6f0f43-7c35-4b8a-9a3c-8f0b4c4b2a12';
  await put('Library/Application Support/Scan to Make/printers/profiles.json', JSON.stringify({version: 1, choices: {}, profiles: [{id, name: 'P1S', backend: 'mcp-3d-printer-server',
    process: {command: '/usr/local/bin/node', args: [join(clone, 'dist/index.js')], cwd: clone}, owned: false}]}));
  const current = {backend: 'mcp-3d-printer-server', process: {command: '/usr/bin/ssh', args: ['printer-tunnel'], cwd: home}};
  const catalog = await loadPrinterCatalog(current, {homeDirectory: home, sourcePaths: [], profilesPath, setupCachePath});
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, reload: () => catalog.reload(), profilesPath, setupCachePath,
    node: '/usr/local/bin/node', client: withSetupMcp(), folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.2.37', hasEnv: true}]});
  assert.equal(catalog.destinations.find(item => item.id === id).incomplete, undefined, 'no MCP fields read yet');
  await setup.discover();
  assert.deepEqual(catalog.destinations.find(item => item.id === id).incomplete, {missing: ['BAMBU_MODEL'], fill: {BAMBU_MODEL: 'p1s'}});
});

test('an MCP updated in place is asked again; one slow MCP never makes Find printers miss its deadline (Codex review on #346)', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const {utimes} = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'printer-probes-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  for (const [dir, pkg] of [['bambu', 'bambu-printer-mcp'], ['generic', 'mcp-3d-printer-server']]) {
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/package.json`, JSON.stringify({name: pkg, version: '1.0.0'}));
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/dist/index.js`, '');
  }
  const env = {...hostEnvironment(data), home};
  const catalog = await loadPrinterCatalog({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', args: []}}, {homeDirectory: home, sourcePaths: [], profilesPath: join(env.appPrinters, 'profiles.json')});
  let bambuHasTools = false, slowGeneric = false;
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    discoverBudgetMs: 6_000, folders: async () => [],
    client: config => {
      if (config.backend === 'mcp-3d-printer-server' && slowGeneric) return {connect: () => new Promise(() => {}), callTool: async () => ({}), close: async () => undefined};
      if (config.backend === 'bambu-printer-mcp' && !bambuHasTools) return withSetupMcp(undefined, {tools: []})(config);
      return withSetupMcp(undefined, {announced: () => [{kind: 'bambu', source: 'ssdp', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', name: 'P1S'}]})(config);
    }});
  // An older bambu-printer-mcp: it asks for its update.
  let {options} = await setup.discover();
  assert.deepEqual(options.updates.map(item => item.package), ['bambu-printer-mcp']);
  // The Update replaces the files at the same path: asked again at once, not after ten minutes.
  bambuHasTools = true;
  const entry = join(env.appPrinters, 'bambu/lib/node_modules/bambu-printer-mcp/dist/index.js');
  await utimes(entry, new Date(), new Date(Date.now() + 5_000));
  ({options} = await setup.discover());
  assert.deepEqual(options.updates, [], 'the updated MCP is asked again');
  assert.ok(options.models['bambu-printer-mcp']?.length);
  // mcp-3D-printer-server stops answering: Find printers still answers in its budget, with what bambu-printer-mcp found.
  slowGeneric = true;
  await utimes(join(env.appPrinters, 'generic/lib/node_modules/mcp-3d-printer-server/dist/index.js'), new Date(), new Date(Date.now() + 10_000));
  const started = Date.now();
  const found = await setup.discover();
  assert.ok(Date.now() - started < 7_000, `answered in ${Date.now() - started} ms, inside its budget`);
  assert.deepEqual(found.found.map(item => [item.source, item.backend]), [['ssdp', 'bambu-printer-mcp']]);
  // Settings answers from the fields already read; it never waits for an MCP.
  const settingsStarted = Date.now();
  await setup.mcps();
  assert.ok(Date.now() - settingsStarted < 1_000);
});

test('an MCP that was only slow is asked again, not reported as needing an update; a stalled first MCP leaves the second its time (Codex review on #346)', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-retry-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  for (const [dir, pkg] of [['bambu', 'bambu-printer-mcp'], ['generic', 'mcp-3d-printer-server']]) {
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/package.json`, JSON.stringify({name: pkg, version: '1.0.0'}));
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/dist/index.js`, '');
  }
  const env = {...hostEnvironment(data), home};
  const catalog = await loadPrinterCatalog({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', args: []}}, {homeDirectory: home, sourcePaths: [], profilesPath: join(env.appPrinters, 'profiles.json')});
  let bambuStalls = true, bambuStallsOnlyListening = false;
  const healthy = withSetupMcp(undefined, {announced: pkg => pkg === 'mcp-3d-printer-server'
    ? [{kind: 'octoprint', source: 'bonjour', name: 'OctoPi', host: 'octopi.local', port: 80}] : []});
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    discoverBudgetMs: 8_000, retryAfterMs: 0, folders: async () => [],
    client: config => {
      if (config.backend !== 'bambu-printer-mcp') return healthy(config);
      if (bambuStalls) return {connect: () => new Promise(() => {}), callTool: async () => ({}), close: async () => undefined};
      const fine = healthy(config);
      // Answers its setup fields, then never finishes listening for printers.
      return bambuStallsOnlyListening ? {...fine, callTool: (name, args) => name === 'counterpart_discover_printers' ? new Promise(() => {}) : fine.callTool(name, args)} : fine;
    }});
  // bambu-printer-mcp didn't start in time: that's not an answer, so it isn't told to update and is asked again.
  let {options} = await setup.discover();
  assert.deepEqual(options.updates.map(item => item.message), ['bambu-printer-mcp didn’t answer in time. Find Printers again in a moment.'], 'a slow start is not "needs an update"');
  bambuStalls = false;
  ({options} = await setup.discover());
  assert.ok(options.models['bambu-printer-mcp']?.length, 'asked again once it answers');
  // It answers its fields but stalls while listening: mcp-3D-printer-server still gets its share and finds the OctoPi.
  bambuStallsOnlyListening = true;
  const found = await setup.discover();
  assert.deepEqual(found.found.map(item => [item.source, item.backend, item.name]), [['bonjour', 'mcp-3d-printer-server', 'OctoPi']]);
});

test('an odd time budget still lets every MCP listen: shares are whole milliseconds (Codex review on #346)', async t => {
  const {PrinterSetup} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-share-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  for (const [dir, pkg] of [['bambu', 'bambu-printer-mcp'], ['generic', 'mcp-3d-printer-server']]) {
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/package.json`, JSON.stringify({name: pkg, version: '1.0.0'}));
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/dist/index.js`, '');
  }
  const env = {...hostEnvironment(data), home};
  const catalog = await loadPrinterCatalog({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', args: []}}, {homeDirectory: home, sourcePaths: [], profilesPath: join(env.appPrinters, 'profiles.json')});
  const signals = [];
  const fake = withSetupMcp(undefined, {announced: pkg => pkg === 'bambu-printer-mcp'
    ? [{kind: 'bambu', source: 'ssdp', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', name: 'P1S'}]
    : [{kind: 'octoprint', source: 'bonjour', name: 'OctoPi', host: 'octopi.local', port: 80}]});
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    discoverBudgetMs: 7_777, folders: async () => [],
    // As the real client does, the signal is made before connecting: a fractional delay would throw right here.
    client: config => { const client = fake(config); return {...client, connect: signal => { signals.push(signal); return client.connect(signal); }}; }});
  for (let i = 0; i < 3; i++) {
    const found = await setup.discover();
    assert.deepEqual(found.found.map(item => item.backend).sort(), ['bambu-printer-mcp', 'mcp-3d-printer-server']);
  }
  assert.ok(signals.length >= 6);
});

test('an mcp-3D-printer-server folder whose .env sets no PRINTER_TYPE is the kind that MCP says it runs then (Codex review on #346)', async () => {
  const {kindFor} = await import('../dist/printing/mcp-setup.js');
  const setup = SETUP_FIELDS['mcp-3d-printer-server'];
  assert.equal(kindFor(setup, {PRINTER_HOST: 'octopi.local', API_KEY: 'k'})?.kind, 'octoprint', 'the MCP declares its own fallback');
  assert.equal(kindFor(setup, {PRINTER_TYPE: 'klipper', PRINTER_HOST: 'voron.local'})?.kind, 'klipper');
  assert.equal(kindFor(setup, {PRINTER_TYPE: 'makerbot', PRINTER_HOST: 'x'}), undefined, 'a type the MCP doesn\'t drive is never guessed');
  const older = {...setup, kinds: setup.kinds.map(({default: _default, ...kind}) => kind)};
  assert.equal(kindFor(older, {PRINTER_HOST: 'octopi.local'}), undefined, 'an MCP that declares no default gets no guess from the app');
  assert.equal(kindFor(SETUP_FIELDS['bambu-printer-mcp'], {PRINTER_HOST: '192.0.2.1'})?.kind, 'bambu');
});

test('Check reads only the chosen MCP\'s fields and answers inside one budget, even when the printer stalls (Codex review on #346)', async t => {
  const {PrinterSetup, PrinterFormSchema} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-check-budget-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const data = join(home, 'Library/Application Support/Scan to Make');
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  for (const [dir, pkg] of [['bambu', 'bambu-printer-mcp'], ['generic', 'mcp-3d-printer-server']]) {
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/package.json`, JSON.stringify({name: pkg, version: '1.0.0'}));
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/dist/index.js`, '');
  }
  const env = {...hostEnvironment(data), home};
  const catalog = await loadPrinterCatalog({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', args: []}}, {homeDirectory: home, sourcePaths: [], profilesPath: join(env.appPrinters, 'profiles.json')});
  const started = [];
  let statusStalls = false;
  const stalled = {connect: () => new Promise(() => {}), callTool: () => new Promise(() => {}), close: async () => undefined};
  const fields = withSetupMcp(config => ({connect: async () => ({server: {name: 'x', version: '1'}, tools: [{name: 'get_printer_status'}, {name: 'camera_snapshot'}]}),
    callTool: name => statusStalls && name === 'get_printer_status' ? new Promise(() => {})
      : Promise.resolve({content: [{type: 'text', text: JSON.stringify({connected: true, status: 'idle', model: 'Bambu Lab P1S'})}]}), close: async () => undefined}));
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, profilesPath: join(env.appPrinters, 'profiles.json'), node: '/usr/local/bin/node',
    checkBudgetMs: 3_000, folders: async () => [],
    client: config => { started.push(config.backend); return config.backend === 'mcp-3d-printer-server' ? stalled : fields(config); }});
  const p1s = PrinterFormSchema.parse({backend: 'bambu-printer-mcp', printerType: 'bambu', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', secret: '12345678'});
  // No fields read yet, and mcp-3D-printer-server never answers: Check doesn't start it or wait for it.
  const first = await setup.check(p1s);
  assert.equal(first.reached, true);
  assert.equal(first.model, 'p1s', 'the model from the chosen MCP\'s own choices');
  assert.ok(!started.includes('mcp-3d-printer-server'), 'the other MCP is never started for this Check');
  // The printer stops answering: Check still returns inside its budget, as unreached.
  statusStalls = true;
  const t0 = Date.now();
  assert.deepEqual(await setup.check(p1s), {reached: false, camera: 'not-supported'});
  assert.ok(Date.now() - t0 < 3_500, `answered in ${Date.now() - t0} ms, inside its budget`);
});

test('a configured folder is found while the MCPs listen; Add names its printer without starting the other MCP (Codex review on #346)', async t => {
  const {PrinterSetup, PrinterFormSchema} = await import('../dist/printing/setup.js');
  const {hostEnvironment} = await import('../dist/printing/mcp-install.js');
  const home = await mkdtemp(join(tmpdir(), 'printer-folder-budget-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const put = async (file, text) => { await mkdir(join(home, file, '..'), {recursive: true}); await writeFile(join(home, file), text); };
  const data = join(home, 'Library/Application Support/Scan to Make');
  for (const [dir, pkg] of [['bambu', 'bambu-printer-mcp'], ['generic', 'mcp-3d-printer-server']]) {
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/package.json`, JSON.stringify({name: pkg, version: '1.0.0'}));
    await put(`Library/Application Support/Scan to Make/printers/${dir}/lib/node_modules/${pkg}/dist/index.js`, '');
  }
  // Someone's own mcp-3D-printer-server checkout, set up for an OctoPrint, whose fields haven't been read yet.
  const clone = join(home, 'mcp-3D-printer-server');
  await put('mcp-3D-printer-server/.env', 'PRINTER_TYPE=octoprint\nPRINTER_HOST=octopi.local\nPRINTER_PORT=80\nAPI_KEY=k\n');
  await put('mcp-3D-printer-server/dist/index.js', '');
  const env = {...hostEnvironment(data), home};
  const profilesPath = join(env.appPrinters, 'profiles.json');
  const catalog = await loadPrinterCatalog({backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true', args: []}}, {homeDirectory: home, sourcePaths: [], profilesPath});
  const started = [];
  let genericStalls = false;
  const fields = withSetupMcp(undefined);
  const setup = new PrinterSetup({env, configs: () => catalog.entries(), catalog: () => catalog, reload: () => catalog.reload(), profilesPath, node: '/usr/local/bin/node',
    discoverBudgetMs: 6_000, folders: async () => [{dir: clone, package: 'mcp-3d-printer-server', version: '1.2.50', hasEnv: true}],
    client: config => {
      const fromClone = config.process.args[0] === join(clone, 'dist', 'index.js');
      started.push(fromClone ? 'clone' : config.backend);
      if (config.backend === 'mcp-3d-printer-server' && !fromClone && genericStalls) return {connect: () => new Promise(() => {}), callTool: () => new Promise(() => {}), close: async () => undefined};
      const fine = fields(config);
      // bambu-printer-mcp answers its fields, then never finishes listening for printers.
      return config.backend === 'bambu-printer-mcp' ? {...fine, callTool: (name, args) => name === 'counterpart_discover_printers' ? new Promise(() => {}) : fine.callTool(name, args)} : fine;
    }});
  const t0 = Date.now();
  const discovery = await setup.discover();
  assert.ok(Date.now() - t0 < 7_000, `answered in ${Date.now() - t0} ms`);
  assert.deepEqual(discovery.found.filter(item => item.source === 'folder').map(item => [item.folder, item.printerType, item.host]), [[clone, 'octoprint', 'octopi.local']],
    'the configured checkout is listed although network discovery used up its time');
  // Add a P1S on bambu-printer-mcp with no name: mcp-3D-printer-server now stalls, and Add never waits for it.
  genericStalls = true;
  started.length = 0;
  const t1 = Date.now();
  const added = await setup.add(PrinterFormSchema.parse({backend: 'bambu-printer-mcp', printerType: 'bambu', host: '192.0.2.1', serial: '01P00A123456789', model: 'p1s', secret: '12345678'}));
  assert.ok(Date.now() - t1 < 2_000, `added in ${Date.now() - t1} ms`);
  assert.ok(added.id);
  assert.ok(!started.includes('mcp-3d-printer-server'), 'naming the printer never starts the other MCP');
});
