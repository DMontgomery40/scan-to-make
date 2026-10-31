#!/usr/bin/env node
/**
 * Milestone tool: touch up one scan through the user's printer MCP and write report.json.
 *   node dist/touchup-cli.js --object <id> [--scan <file>…] [--photos <dir>] [--instructions <text>]
 *     --handoff-config <printer-handoff.json> [--note <text> --summary <text>] [--root <dir>]
 */
import {execFileSync} from 'node:child_process';
import {readdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {extname, join} from 'node:path';
import {parseArgs} from 'node:util';
import {readPrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import {runTouchup} from './touchup/touchup.js';

const PHOTO_TYPES = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png']);

async function main(): Promise<void> {
  const {values} = parseArgs({options: {
    object: {type: 'string'}, scan: {type: 'string', multiple: true}, photos: {type: 'string'},
    'handoff-config': {type: 'string'}, instructions: {type: 'string'}, note: {type: 'string'}, summary: {type: 'string'},
    root: {type: 'string', default: join(homedir(), 'scan-to-make-work', 'touchups')},
  }});
  if (!values.object || !values['handoff-config'] || (!values.scan?.length && !values.photos && !values.instructions)) {
    throw new Error('Usage: touchup-cli --object <id> [--scan <file>…] [--photos <dir>] [--instructions <text>] --handoff-config <path> [--note <text> --summary <text>] [--root <dir>]');
  }
  const photos = values.photos ? (await readdir(values.photos)).filter(name => PHOTO_TYPES.has(extname(name).toLowerCase())).sort().map(name => join(values.photos!, name)) : [];
  const handoff = await readPrinterHandoffConfig(values['handoff-config']);
  const claudePath = process.env.SCAN_TO_MAKE_CLAUDE_PATH || execFileSync('/usr/bin/which', ['claude']).toString().trim();
  const startedAt = new Date().toISOString();
  let lastLine = '';
  const result = await runTouchup({
    root: values.root!, objectId: values.object, scan: values.scan ?? [], photos, handoff, claudePath,
    ...(values.instructions !== undefined ? {instructions: values.instructions} : {}),
    ...(values.note !== undefined ? {note: values.note} : {}), ...(values.summary !== undefined ? {summary: values.summary} : {}),
    onProgress: progress => {
      const line = `${progress.seconds}s · ${progress.toolCalls} tool calls${progress.lastText ? ' · ' + progress.lastText.slice(0, 160) : ''}`;
      if (line !== lastLine) { lastLine = line; console.log(line); }
    },
  });
  const report = {...result, printerBackend: handoff.backend, startedAt, photos: photos.length};
  await writeFile(join(result.passDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({status: result.status, reason: result.reason, model: result.model, seconds: result.stats.seconds,
    toolCalls: result.stats.toolCalls, costUsd: result.stats.costUsd, report: join(result.passDir, 'report.json')}, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
