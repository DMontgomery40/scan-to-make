// Static checks for the docs site (site/public). Run: node site/check.mjs
import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'public');
const failures = [];
const fail = message => failures.push(message);
const pages = readdirSync(root).filter(name => name.endsWith('.html'));
const ids = Object.fromEntries(pages.map(page => [page, new Set([...readFileSync(join(root, page), 'utf8').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]))]));

// Links the iPhone app opens (CounterpartKit Seams.swift, SettingsView.swift) must keep working.
for (const [page, id] of [['help.html', 'scan'], ['help.html', 'setup'], ['help.html', 'privacy']]) {
  if (!ids[page]?.has(id)) fail(`the app links to ${page}#${id}, which is missing`);
}

for (const page of pages) {
  const html = readFileSync(join(root, page), 'utf8');
  if (!/<html lang="en">/.test(html)) fail(`${page}: no lang`);
  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${page}: no title`);
  if (!/<meta name="description" content="[^"]+">/.test(html)) fail(`${page}: no description`);
  if (page !== '404.html' && (html.match(/<h1[\s>]/g) ?? []).length !== 1) fail(`${page}: needs exactly one h1`);
  if (/Scan to Make/.test(html)) fail(`${page}: still says Scan to Make`);
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (/^(https?:|mailto:)/.test(href)) {
      if (!/^https:\/\/(fonts\.(googleapis|gstatic)\.com|dmontgomery40\.github\.io\/(bambu-printer-mcp|mcp-3D-printer-server)\/|makerworld\.com\/en\/models\/1531561)/.test(href)) fail(`${page}: outside link not on the public list: ${href}`);
      continue;
    }
    const [file, hash] = href.replace(/^\//, '').split('#');
    const target = file === '' || file === './' ? (file === '' ? page : 'index.html') : file;
    if (!existsSync(join(root, target))) { fail(`${page}: missing file ${href}`); continue; }
    if (hash && !ids[target]?.has(hash)) fail(`${page}: missing anchor ${href}`);
  }
  for (const [tag] of html.matchAll(/<img\b[^>]*>/g)) {
    const src = tag.match(/src="([^"]*)"/)?.[1];
    if (src && !existsSync(join(root, src.replace(/^\//, '')))) fail(`${page}: missing image ${src}`);
    if (!/\salt="/.test(tag)) fail(`${page}: image without alt: ${src}`);
    if (src && !/width="\d+" height="\d+"/.test(tag)) fail(`${page}: image without width and height: ${src}`);
  }
  for (const [, controls] of html.matchAll(/aria-controls="([^"]+)"/g)) if (!ids[page].has(controls)) fail(`${page}: tab controls missing ${controls}`);
}

// Every text colour pair meets WCAG AA (4.5:1) in both palettes.
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const palette = block => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]));
const light = palette(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = {...light, ...palette(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf('* { box-sizing')))};
const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const [name, colours] of [['light', light], ['dark', dark]]) {
  for (const text of ['ink', 'ink-soft', 'orange-ink']) for (const ground of ['bed', 'sheet']) {
    const value = ratio(colours[text], colours[ground]);
    if (value < 4.5) fail(`${name}: ${text} on ${ground} is ${value.toFixed(2)}:1`);
  }
  const button = ratio('#ffffff', colours['button']);
  if (button < 4.5) fail(`${name}: white on the orange button is ${button.toFixed(2)}:1`);
}

if (failures.length) { console.error(failures.map(line => `✗ ${line}`).join('\n')); process.exit(1); }
console.log(`site: ${pages.length} pages pass`);
