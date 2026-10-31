#!/usr/bin/env node
/** Deterministic synthetic HEIC still (pillow-heif), never real scan photos. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { python } from './resolve-python.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * @param {{ width?: number; height?: number; rgb?: [number, number, number] }} [options]
 */
export function generateSyntheticHeic(options = {}) {
  const width = options.width ?? 128;
  const height = options.height ?? 64;
  const rgb = options.rgb ?? [32, 180, 64];
  const [r, g, b] = rgb;
  const outDir = mkdtempSync(join(tmpdir(), 'e2e-heic-'));
  const path = join(outDir, 'closeup.heic');
  const script = `
import pillow_heif
from PIL import Image
from pathlib import Path
img = Image.new('RGB', (${width}, ${height}), (${r}, ${g}, ${b}))
pillow_heif.from_pillow(img).save(Path(${JSON.stringify(path)}), quality=90)
`;
  execFileSync(
    python,
    ['-c', script],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
  );
  const bytes = readFileSync(path);
  return { path, outDir, bytes, sha256: sha(bytes), width, height, rgb };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { path, sha256 } = generateSyntheticHeic();
  process.stdout.write(`${path}\t${sha256}\n`);
}
