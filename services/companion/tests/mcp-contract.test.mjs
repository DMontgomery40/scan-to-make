// PRD §8.0: the app is stapled onto the printer MCPs. Every MCP name app code writes or reads is listed in
// docs/protocols/mcp-contract.md; adding one (or dropping one) forces an edit there, where its boundary is decided.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {surface, documented} from './mcp-contract-surface.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const doc = 'docs/protocols/mcp-contract.md';
const sections = documented(readFileSync(join(repo, doc), 'utf8'));
const {names, fields} = surface(repo);
const FIELDS = 'counterpart/1 result fields';

test('every MCP tool, argument and metadata name in app code is in the contract doc, and nothing more', () => {
  const listed = new Set([...sections].filter(([title]) => title !== FIELDS).flatMap(([, set]) => [...set]));
  const missing = [...names.keys()].filter(name => !listed.has(name)).sort();
  assert.deepEqual(missing.map(name => `${name} (${[...names.get(name)].join(', ')})`), [],
    `App code uses MCP names that ${doc} doesn't list. Should this live in the MCPs instead (PRD §8.0)? If not, list it.`);
  assert.deepEqual([...listed].filter(name => !names.has(name)).sort(), [], `${doc} lists names app code no longer uses: remove them.`);
});

test('every counterpart/1 result field the app validates is in the contract doc, and nothing more', () => {
  const listed = sections.get(FIELDS) ?? new Set();
  assert.deepEqual([...fields].filter(name => !listed.has(name)).sort(), [], `counterpart.ts reads result fields ${doc} doesn't list.`);
  assert.deepEqual([...listed].filter(name => !fields.has(name)).sort(), [], `${doc} lists result fields counterpart.ts no longer reads.`);
});

test('no tool, argument or metadata name is listed twice (result fields may share names with arguments)', () => {
  const all = [...sections].filter(([title]) => title !== FIELDS).flatMap(([, set]) => [...set]);
  assert.deepEqual(all.filter((name, i) => all.indexOf(name) !== i), []);
});
