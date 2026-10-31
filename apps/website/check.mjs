#!/usr/bin/env node
// Static checks for the preview site. No dependencies: run `node apps/website/check.mjs`.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check(/<html lang="en">/.test(html), 'html needs lang="en"');
check(/<title>[^<]{10,}<\/title>/.test(html), 'needs a descriptive <title>');
check(/<meta\s+name="description"/.test(html), 'needs a meta description');
check((html.match(/<h1\b/g) ?? []).length === 1, 'needs exactly one <h1>');
check(/<main id="main">/.test(html) && /href="#main"/.test(html), 'needs a skip link to <main>');

// Outside links only to pages that are public today. The app's own repo and
// store page aren't public yet.
const publicLinks = new Set([
  'https://github.com/DMontgomery40/bambu-printer-mcp',
  'https://github.com/DMontgomery40/mcp-3D-printer-server',
]);

for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
  if (href.startsWith('#')) {
    check(html.includes(`id="${href.slice(1)}"`), `anchor ${href} has no target`);
  } else if (href.startsWith('data:')) {
    continue;
  } else if (/^[a-z]+:/i.test(href) || href.startsWith('//')) {
    check(publicLinks.has(href), `external link not on the public list: ${href}`);
  } else {
    check(existsSync(join(root, href)), `missing local file ${href}`);
  }
}

for (const [svg] of html.matchAll(/<svg\b[^>]*>/g)) {
  const hidden = /aria-hidden="true"/.test(svg);
  const labelled = /role="img"/.test(svg) && /aria-labelledby="/.test(svg);
  check(hidden || labelled, `svg must be labelled or hidden: ${svg}`);
}

const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// No price on the page until the App Store products and price are set up (KAN-127).
const pricing = text.match(
  /[$€£]\s?\d|\b\d+(?:\.\d+)?\s?(?:USD|EUR|GBP)\b|per month|\/mo\b|free trial|one-time/i,
);
check(!pricing, `pricing text found: "${pricing?.[0]}"`);

// The copy covers the current scope and nothing from the old fit/template product.
for (const term of ['LiDAR', 'iPhone Duo', 'iPad', 'iOS 27', 'bambu-printer-mcp', 'mcp-3D-printer-server']) {
  check(text.includes(term), `copy must mention ${term}`);
}
const stale = text.match(/cup holder|drawer tray|template/i);
check(!stale, `old-scope copy found: "${stale?.[0]}"`);

// WCAG AA contrast for text pairs in both palettes.
function palette(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]),
  );
}
const light = palette(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const dark = { ...light, ...palette(css.slice(darkStart, css.indexOf('}', css.indexOf(':root {', darkStart)))) };
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const pairs = [
  ['ink', 'background'], ['muted', 'background'], ['muted', 'surface'],
  ['accent', 'background'], ['accent', 'surface'], ['background', 'ink'],
  ['sage-ink', 'sage'], ['ink', 'surface'],
];
const report = [];
for (const [name, colors] of [['light', light], ['dark', dark]]) {
  for (const [fg, bg] of pairs) {
    const value = ratio(colors[fg], colors[bg]);
    report.push(`${name} ${fg} on ${bg}: ${value.toFixed(2)}`);
    check(value >= 4.5, `${name} ${fg} on ${bg} is ${value.toFixed(2)}, below 4.5`);
  }
}

if (failures.length) {
  console.error(`FAIL (${failures.length})\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS: structure, anchors, links, svg labels, no pricing, scope copy\n${report.join('\n')}`);
