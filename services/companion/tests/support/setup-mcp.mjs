// A printer MCP's setup tools for tests of Add printer…: counterpart_setup_fields answers with what the MCPs really
// return (captured from bambu-printer-mcp 1.1.82 and mcp-3d-printer-server 1.2.63, with no printer configured; each
// kind says whether Check shows its `camera`), and counterpart_discover_printers with the printers a test says are
// announcing themselves. OLDER_SETUP_FIELDS are bambu-printer-mcp 1.1.63's and mcp-3d-printer-server 1.2.50's, from
// before `camera`.
import {readFileSync} from 'node:fs';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
export const SETUP_FIELDS = {
  'bambu-printer-mcp': fixture('setup-fields-bambu-printer-mcp-1.1.82.json'),
  'mcp-3d-printer-server': fixture('setup-fields-mcp-3d-printer-server-1.2.63.json'),
};
export const OLDER_SETUP_FIELDS = {
  'bambu-printer-mcp': fixture('setup-fields-bambu-printer-mcp-1.1.63.json'),
  'mcp-3d-printer-server': fixture('setup-fields-mcp-3d-printer-server-1.2.50.json'),
};
const text = value => ({content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value});

/**
 * A client factory: Add printer…'s probe (an MCP started with no printer settings, in `<appPrinters>/profiles`)
 * gets the setup tools; every other start (Check, a printer's own session) goes to `base`.
 */
export function withSetupMcp(base, {announced = () => [], tools = ['counterpart_setup_fields', 'counterpart_discover_printers'], calls = [], fields = SETUP_FIELDS} = {}) {
  return config => {
    const probe = !config.process.env && /[/\\]profiles$/.test(config.process.cwd ?? '');
    if (!probe) return base ? base(config) : {connect: async () => ({server: {name: 'x', version: '1'}, tools: []}), callTool: async () => text({}), close: async () => undefined};
    return {
      connect: async () => ({server: {name: config.backend, version: '1'}, tools: tools.map(name => ({name}))}),
      callTool: async (name, args) => {
        calls.push([config.backend, name, args]);
        if (name === 'counterpart_setup_fields') return text(fields[config.backend]);
        if (name === 'counterpart_discover_printers') return text({contract: 'counterpart/1', network: 'complete', printers: announced(config.backend)});
        throw new Error(`unexpected ${name}`);
      },
      close: async () => undefined,
    };
  };
}

/** `<appPrinters>/mcp-setup.json` as Add printer… leaves it, for a printer list loaded before any probe. */
export async function writeSetupFieldsCache(path, packages = Object.keys(SETUP_FIELDS)) {
  const {writeSetupCache} = await import('../../dist/printing/mcp-setup.js');
  await writeSetupCache(path, new Map(packages.map(pkg => [pkg, SETUP_FIELDS[pkg]])));
  return path;
}
