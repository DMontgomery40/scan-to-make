#!/usr/bin/env node
/** Generate a small metric-qualified USDZ in a temp or target directory (pxr). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './repo-root.mjs';

const python = process.env.CAPTURE_TEST_PYTHON ?? 'python3';
const makeFixtures = join(
  repoRoot,
  'tools/capture-mesh-convert/make_fixtures.py'
);

export function generateSyntheticUsdz(name = 'two_layer') {
  const outDir = mkdtempSync(join(tmpdir(), 'e2e-usdz-'));
  execFileSync(python, [makeFixtures, outDir], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const path = join(outDir, `${name}.usdz`);
  return { path, outDir, name };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path } = generateSyntheticUsdz(process.argv[2] ?? 'two_layer');
  process.stdout.write(`${path}\n`);
}
