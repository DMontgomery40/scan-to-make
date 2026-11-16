// #858: the colour rules name color= and needs-more-filaments only for an MCP that advertises capabilities.partMeshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {advertisesPartMeshes} from '../dist/index.js';

const config = {backend: 'bambu-printer-mcp', process: {command: '/usr/bin/true'}};
const info = capabilities => ({contract: 'counterpart/1', server: {name: 'bambu-printer-mcp', version: '1.1.97'}, printer: {kind: 'bambu', host: '192.0.2.10'},
  capabilities: {progress: true, layers: true, camera: 'none', filaments: 'ams', pause: true, resume: true, cancel: true, print3mf: true, gcode: false, ...capabilities}});
const client = (answer, {listed = true} = {}) => ({
  hasTool: name => listed && name === 'counterpart_printer_info',
  getTool: () => ({name: 'counterpart_printer_info', inputSchema: {type: 'object', properties: {}}}),
  callTool: async () => { if (answer instanceof Error) throw answer; return {content: [{type: 'text', text: JSON.stringify(answer)}], structuredContent: answer}; },
});

test('an MCP advertising partMeshes takes part colours; any other answer, or none, does not', async () => {
  assert.equal(await advertisesPartMeshes(client(info({partMeshes: true})), config), true);
  assert.equal(await advertisesPartMeshes(client(info({})), config), false, 'an older MCP leaves it out');
  assert.equal(await advertisesPartMeshes(client(info({partMeshes: false})), config), false);
  assert.equal(await advertisesPartMeshes(client(info({partMeshes: 'yes'})), config), false, 'a garbled flag is not a yes');
  assert.equal(await advertisesPartMeshes(client(info({partMeshes: true}), {listed: false}), config), false, 'no counterpart_printer_info');
  assert.equal(await advertisesPartMeshes(client(new Error('printer offline')), config), false, 'no answer keeps today\'s rules');
});
