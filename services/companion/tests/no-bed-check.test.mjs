import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// PRD §5.6: there is no bed check in Counterpart, its companion or the printer MCPs; Bambu's own bed levelling finds a full plate.
const ROOTS = ['services/companion/src', 'services/printer-handoff/src', 'packages/contracts/src', 'packages/contracts/fixtures'];
const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(path)); else if (/\.(ts|mjs|js|json)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('nothing checks the bed: no bedcheck, judgePlate, answerPlate or plate.blocked anywhere in the source', async () => {
  const found = [];
  for (const root of ROOTS) for (const file of await files(join(repo, root)))
    for (const [index, line] of (await readFile(file, 'utf8')).split('\n').entries())
      if (/bedcheck|judgePlate|answerPlate|plate\.blocked/i.test(line)) found.push(`${file.slice(repo.length)}:${index + 1}`);
  assert.deepEqual(found, []);
});
