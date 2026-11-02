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
    summary: {type: 'string', description: 'What you changed, in one or two plain sentences the person will read: no file names, tool or Blender details. When status is failed: what went wrong, in one sentence.'},
    title: {type: 'string', maxLength: 40, description: 'A short name for the thing, two to four words, like "Mic mount" or "Crochet potato"'},
    changes: {type: 'array', maxItems: 12, description: 'What changed, one short line each, for the person to check',
      items: {type: 'object', additionalProperties: false, required: ['tag', 'text'], properties: {
        tag: {enum: ['added', 'changed', 'assumed', 'estimated'], description: 'added: new geometry; changed: altered geometry; assumed: a choice made without evidence; estimated: a size not measured or published'},
        text: {type: 'string', maxLength: 200},
        toleranceMm: {type: 'number', minimum: 0, description: 'For estimated sizes: plus or minus this many millimetres'},
      }}},
    ask: {type: 'object', additionalProperties: false, required: ['question'], description: 'When status is needs_closeup: the one question, and where to look',
      properties: {
        question: {type: 'string', maxLength: 200, description: 'One plain question, like "Can you take a close-up of the clip on the left side?"'},
        photo: {type: 'string', description: 'The file name of one supplied photo or one of your renders in out/ that shows the region'},
        region: {type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], description: 'The region on that photo, as fractions of its width and height from the top-left',
          properties: {x: {type: 'number', minimum: 0, maximum: 1}, y: {type: 'number', minimum: 0, maximum: 1}, width: {type: 'number', minimum: 0, maximum: 1}, height: {type: 'number', minimum: 0, maximum: 1}}},
      }},
  },
} as const;

/** The design engine for a pass (PRD §8.9): Blender always for copies; Fusion for new designs when it's connected. */
export type DesignEngine = 'blender' | 'fusion';

const FUSION_RULES = `- Design it in Autodesk Fusion through the printer MCP's fusion_mcp_* tools: fusion_mcp_call reaches Fusion's own tools (create_sketch, extrude, revolve, fillet, shell, boolean_operation, create_parameter, set_parameter, get_parameters, check_interference, …). A new parametric design is open.
- Make every functional dimension a named user parameter, so a later change is one set_parameter.
- When the design is finished, call fusion_mcp_export with output_dir set to the output folder and name "touched": it writes touched.stl, touched.f3d and touched.parameters.json. Use body_name when the design has more than one body.
- If you can, save clear PNG views of the design to the output folder, named so the clearest overall view sorts first.`;

const SYSTEM_RULES_TEMPLATE = `You are making a useful 3D object for a person. Understand what they want it to do, the things it must fit, and how they will assemble and use it. Deliver a complete model that answers that request.
- ENGINE_RULES
- Read every supplied reference photo and the user's request before modeling. Identify the functional interfaces: what holds what, contact surfaces, clearances, access, and how the part attaches without obstructing the real objects.
- For a new design, construct the complete functional geometry ENGINE_NAME. Procedural modeling, profiles, booleans, curves, modifiers and multiple iterations are available. A collection of rough primitives is a starting sketch, not a finished mount, clip, bracket or enclosure.
- For a captured object, fix defects supported by the photos with targeted edits: raise features that are missing or too faint, and flatten or smooth surfaces the photos show are flat or smooth. Keep real surface detail the photos confirm, including texture, stitches and edges. Use Blender's existing sculpt and modifier tools for that cleanup.
- Use measured or published dimensions when available. Distinguish measurements from estimates. Make reasonable choices for noncritical details; ask for a close-up or measurement when a missing interface dimension prevents a useful fit.
- Don't do print preparation: no flat bases, re-orientation or supports.
- Scans from the phone are in metres. A current-model STL supplied for revision is already in millimetres. Build new designs in millimetres and export every STL in millimetres, the unit printers use.
- After each fix, export the whole model as an STL to the checkpoints folder (01.stl, 02.stl, …).
- Render and inspect the candidate from useful angles against the request and reference photos. Check the attachment interfaces, assembly path and dimensions; revise defects you can see. Successful export alone does not establish that the design works.
- Export the final model to out/touched.stl and clear PNG renders to out/, named so the clearest overall view sorts first (for example 1_overview.png). Explain what the part does and any remaining fit assumptions in the final summary.
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

/** The env for any Claude Code call the companion makes: the user's login, none of their personal setup, no secrets. */
export function isolatedClaudeEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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

function prompt(pass: TouchupPass, instructions?: string, note?: string, summary?: string, currentModel = false): string {
  const opening = note !== undefined
    ? [...(currentModel ? [`This is the current model. ${summary ?? ''}`.trimEnd()] : ['Continue this project using the original inputs and the additional request below. No completed model is available yet.']),
       ...(instructions?.trim() ? [`Original request: ${instructions.trim()}`] : []),
       `Change requested: ${note}`,
       ...(currentModel ? ['The current model is an STL already in millimetres: import and export it at scale 1.'] : [])].join('\n\n')
    : instructions?.trim() || TOUCHUP_INSTRUCTION;
  const files = [
    ...(pass.scanPaths.length ? [`- Scan: ${pass.scanPaths.join(', ')}${!currentModel && pass.scanPaths.some(path => /\.(stl|3mf)$/i.test(path))
      ? ' (a model file the person added on their Mac, usually in millimetres: check its size with get_stl_info before editing)' : ''}`] : []),
    ...(pass.photoPaths.length ? [`- Photos: ${join(pass.photosDir, 'photo-01.jpg')} … photo-${String(pass.photoPaths.length).padStart(2, '0')}.jpg`] : []),
    `- Checkpoints folder: ${pass.checkpointsDir}`,
    `- Output folder: ${pass.outDir}`,
  ];
  return `${opening}\n\nFiles:\n${files.join('\n')}`;
}

/** The lean, isolated `claude -p` call for one touch-up pass. Writes the pass's MCP config file. */
export const BLENDER_RULES = "- Reach Blender only through the printer MCP's blender_mcp_* tools. Start in the empty scene you are given, and work only with objects in the current scene (bpy.context.scene.objects).";
/** The system rules for an engine. */
export function systemRules(engine: DesignEngine = 'blender'): string {
  return SYSTEM_RULES_TEMPLATE.replace('- ENGINE_RULES', engine === 'fusion' ? FUSION_RULES : BLENDER_RULES)
    .replace('ENGINE_NAME', engine === 'fusion' ? 'in Fusion through the printer MCP (only its fusion_mcp_* tools)' : 'using Blender through MCP');
}
/** The Blender rules, as every copy and every Blender design pass gets them. */
export const TOUCHUP_SYSTEM_RULES = systemRules('blender');

export function buildTouchupInvocation(input: {pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; instructions?: string; note?: string; summary?: string; currentModel?: boolean; sourceEnv?: NodeJS.ProcessEnv;
  engine?: DesignEngine; design?: {f3d: string; parameters?: string}}): TouchupInvocation {
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
    '--append-system-prompt', systemRules(input.engine),
    '--json-schema', JSON.stringify(TOUCHUP_RESULT_SCHEMA),
    '--output-format', 'stream-json',
    '--verbose',
    prompt(pass, input.instructions, input.note, input.summary, input.currentModel) + (input.engine === 'fusion' && input.design
      ? `\n\nThe current design is a parametric Fusion design: ${input.design.f3d}${input.design.parameters ? ` (its parameters: ${input.design.parameters})` : ''}. Open it in Fusion and change its parameters rather than the mesh.` : ''),
  ];
  return {command: input.claudePath, args, env: isolatedClaudeEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig};
}
