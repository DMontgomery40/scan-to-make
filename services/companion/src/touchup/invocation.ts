import {writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import type {PrinterMcpProcess} from '@scan-to-make/printer-handoff';
import type {TouchupPass} from './inputs.js';

export const TOUCHUP_INSTRUCTION = 'Look at the pictures of this, and then tweak the scan based on that.';

/**
 * The worker's final answer. With `--json-schema`, Claude Code puts it on the
 * stream-json `result` event as `structured_output` (checked against Claude Code 2.1.316).
 * `--strict-mcp-config` is essential: without it the user's claude.ai connectors
 * (mail, chat, brokerage) load into the worker.
 */
export const TOUCHUP_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'summary'],
  properties: {
    status: {enum: ['done', 'needs_closeup', 'failed']},
    closeup: {type: 'string', description: 'What to photograph, in a few plain words'},
    summary: {type: 'string', description: 'What was changed, one short paragraph. When status is failed: what went wrong, in one sentence.'},
  },
} as const;

export const TOUCHUP_SYSTEM_RULES = `You are making a 3D model the user will print: either touching up their scan so it matches the real object in the photos, or making what their instructions describe so it fits the real things it goes with.
- Reach Blender only through the printer MCP's blender_mcp_* tools. Start in the empty scene you are given.
- Fix what the photos show the scan got wrong, with targeted edits: remove anything that came from the table, raise features that are missing or too faint, and flatten or smooth surfaces the photos show are flat or smooth but the scan made lumpy.
- Keep real surface detail the photos confirm, such as texture, stitches and edges. Don't smooth that away, and leave alone what the photos don't show is wrong.
- Use Blender's own tools (sculpt brushes, modifiers limited to a region, primitives). Don't write your own geometry algorithms.
- Don't do print preparation: no flat bases, re-orientation or supports.
- Scans from the phone are in metres. Export every STL in millimetres, the unit printers use.
- After each fix, export the whole model as an STL to the checkpoints folder (01.stl, 02.stl, …).
- Make one pass, then stop. Export the final model to out/touched.stl and a few PNG renders to out/.
- If you can't see a part well enough to fix it, set status to needs_closeup and say what to photograph.
- If something breaks and you can't finish (for example Blender stops responding), set status to failed and say what happened.`;

/** Only what Claude Code needs to find the user's own login. Never printer tokens or provider keys. */
const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL', 'CLAUDE_CONFIG_DIR'] as const;

export interface McpServerEntry {command: string; args: string[]; env?: Record<string, string>}
export interface TouchupInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  mcpConfigPath: string;
  mcpConfig: {mcpServers: {printer: McpServerEntry}};
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The user's printer MCP exactly as configured. A working directory needs a shell wrapper because MCP configs have no cwd field. */
function printerServer(printer: PrinterMcpProcess): McpServerEntry {
  const args = printer.args ?? [];
  const entry: McpServerEntry = printer.cwd
    ? {command: '/bin/sh', args: ['-c', `cd ${quote(printer.cwd)} && exec ${[printer.command, ...args].map(quote).join(' ')}`]}
    : {command: printer.command, args: [...args]};
  if (printer.env) entry.env = {...printer.env};
  return entry;
}

function workerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) if (source[name]) env[name] = source[name];
  // A launchd agent has no USER; Claude Code needs it to find the signed-in Keychain login.
  const username = userInfo().username;
  env.USER ??= username;
  env.LOGNAME ??= username;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

function prompt(pass: TouchupPass, instructions?: string, note?: string, summary?: string): string {
  const opening = note !== undefined
    ? [`This is the current model. ${summary ?? ''}`.trimEnd(),
       ...(instructions?.trim() ? [`Original request: ${instructions.trim()}`] : []),
       `Change requested: ${note}`,
       'The current model is an STL already in millimetres: import and export it at scale 1.'].join('\n\n')
    : instructions?.trim() || TOUCHUP_INSTRUCTION;
  const files = [
    ...(pass.scanPaths.length ? [`- Scan: ${pass.scanPaths.join(', ')}`] : []),
    ...(pass.photoPaths.length ? [`- Photos: ${join(pass.photosDir, 'photo-01.jpg')} … photo-${String(pass.photoPaths.length).padStart(2, '0')}.jpg`] : []),
    `- Checkpoints folder: ${pass.checkpointsDir}`,
    `- Output folder: ${pass.outDir}`,
  ];
  return `${opening}\n\nFiles:\n${files.join('\n')}`;
}

/** The lean, isolated `claude -p` call for one touch-up pass. Writes the pass's MCP config file. */
export function buildTouchupInvocation(input: {pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; instructions?: string; note?: string; summary?: string; sourceEnv?: NodeJS.ProcessEnv}): TouchupInvocation {
  const {pass} = input;
  const mcpConfig = {mcpServers: {printer: printerServer(input.printer)}};
  const mcpConfigPath = join(pass.dir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {mode: 0o600});
  const args = [
    '-p',
    '--model', 'claude-opus-5-5',
    '--effort', 'high',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--tools', 'Read,WebSearch,WebFetch',
    '--allowedTools', 'Read,WebSearch,WebFetch,mcp__printer',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    '--append-system-prompt', TOUCHUP_SYSTEM_RULES,
    '--json-schema', JSON.stringify(TOUCHUP_RESULT_SCHEMA),
    '--output-format', 'stream-json',
    '--verbose',
    prompt(pass, input.instructions, input.note, input.summary),
  ];
  return {command: input.claudePath, args, env: workerEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig};
}
