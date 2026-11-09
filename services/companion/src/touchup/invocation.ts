import {writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {PrinterMcpProcess, PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
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
    parts: {type: 'array', maxItems: 64, description: 'Only for a request in more than one colour: the parts of out/touched.3mf in filament order (the first prints on filament 1), each with the colour the person asked for as #RRGGBB, so Counterpart can put it on the nearest loaded spool',
      items: {type: 'object', additionalProperties: false, required: ['colour'], properties: {
        name: {type: 'string', maxLength: 128, description: 'The part’s name in the 3MF, like "body" or "letters"'},
        colour: {type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'The colour this part should print in, as #RRGGBB'},
        material: {type: 'string', maxLength: 64, description: 'The material, only when the request names one for this part (for example PLA or PETG)'},
      }}},
    ask: {type: 'object', additionalProperties: false, required: ['question'], description: 'When status is needs_closeup: the one question, and where to look',
      properties: {
        question: {type: 'string', maxLength: 200, description: 'One plain question, like "Can you take a close-up of the clip on the left side?"'},
        photo: {type: 'string', description: 'The file name of one supplied photo or one of your renders in out/ that shows the region'},
        region: {type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], description: 'The region on that photo, as fractions of its width and height from the top-left',
          properties: {x: {type: 'number', minimum: 0, maximum: 1}, y: {type: 'number', minimum: 0, maximum: 1}, width: {type: 'number', minimum: 0, maximum: 1}, height: {type: 'number', minimum: 0, maximum: 1}}},
      }},
    supports: {type: 'object', additionalProperties: false, required: ['enabled'], description: 'Whether the slicer generates supports when this model prints. Counterpart sends it to the slicer as it is: supports off is sent too',
      properties: {
        enabled: {type: 'boolean'},
        type: {enum: ['tree(auto)', 'normal(auto)'], description: 'When enabled: the slicer’s automatic tree or normal supports'},
      }},
  },
} as const;

/** The design engine for a pass (PRD §8.9): Blender always for copies; Fusion for new designs when it's connected. */
export type DesignEngine = 'blender' | 'fusion';

const FUSION_RULES = `- Design it in Autodesk Fusion through the printer MCP's fusion_mcp_* tools: fusion_mcp_call reaches Fusion's own tools (create_sketch, extrude, revolve, fillet, shell, boolean_operation, create_parameter, set_parameter, get_parameters, check_interference, …). A separate document is already prepared for this pass. Its identity is fixed by the tools: work with the provided design and component, without opening or switching documents.
- Make every functional dimension a named user parameter, so a later change is one set_parameter.
- When the design is finished, call fusion_mcp_export with output_dir set to the output folder and name "touched": it writes touched.stl, touched.f3d and touched.parameters.json. Use body_name when the design has more than one body; for several colours, export each colour's body under its own name and combine them as the multi-colour rule below says.
- If you can, save clear PNG views of the design to the output folder, named so the clearest overall view sorts first.`;

const SYSTEM_RULES_TEMPLATE = `You are making a useful 3D object for a person. Understand what they want it to do, the things it must fit, and how they will assemble and use it. Deliver a complete model that answers that request.
- ENGINE_RULES
- Read every numbered photo overview first, then open the individual photos to inspect details and resolve different orientations. Read every supplied reference photo and the user's request before modeling. Identify the functional interfaces: what holds what, contact surfaces, clearances, access, and how the part attaches without obstructing the real objects.
- For a new design, construct the complete functional geometry ENGINE_NAME. Procedural modeling, profiles, booleans, curves, modifiers and multiple iterations are available. A collection of rough primitives is a starting sketch, not a finished mount, clip, bracket or enclosure.
- For a captured object, fix defects supported by the photos with targeted edits: raise features that are missing or too faint, and flatten or smooth surfaces the photos show are flat or smooth. Keep real surface detail the photos confirm, including texture, stitches and edges. Use Blender's existing sculpt and modifier tools for that cleanup.
- Use measured or published dimensions when available. Distinguish measurements from estimates. Make reasonable choices for noncritical details; ask for a close-up or measurement when a missing interface dimension prevents a useful fit.
- For a part that must fit a scanned or photographed object, settle fit-critical dimensions before modelling them. When the request asks for a lookup, identify the exact product and variant, open the manufacturer's own published dimensions with WebSearch/WebFetch, then stop with needs_closeup to confirm them before building geometry that depends on them: the ask question names the product, its size in mm and the maker's source, and says the reply can confirm it, correct it in words, or send a caliper photo. If the exact product or size cannot be established, ask for the specific caliper measurements or a photo with calipers instead. Measured dimensions in the request are authoritative; if the scan disagrees by more than the stated tolerance (or 2 mm / 2% when none is stated), ask before designing the interface.
- Plan how it will be printed as part of the design, following the printer MCP's manufacturing guidance when it is given below, for captured objects and new designs alike. For a captured object, that plan works with the captured shape: change it where printing it well calls for that, and keep the real surface detail the photos confirm.
- Export the model in the orientation the object is used in. The print step sends it to the slicer as it is, with your answer's supports, off included. Set supports for every model you export: enabled, with a type, when the part needs them to print well; not enabled when it prints cleanly without them. How the slicer orients the model and generates supports, and how to check that choice with a checkpoint slice, is the printer MCP's to say: follow its slicing guidance below.
- Scans from the phone are in metres. A current-model STL supplied for revision is already in millimetres. Build new designs in millimetres and export every STL in millimetres, the unit printers use.
- After each fix, export the whole model as an STL to the checkpoints folder (01.stl, 02.stl, …).
- Render and inspect the candidate from all six sides against the request and reference photos. For a captured object, compare the rear and underside explicitly with the supplied photos, accounting for the object being turned over between photographs. A smooth, closed scan surface can still be a reconstruction defect. Before calling any region unseen, check all supplied views and identify which views support that conclusion; do not infer missing photographic coverage from missing mesh detail. Revise visible discrepancies, or ask for the specific missing evidence when it is actually absent. Check the attachment interfaces, assembly path and dimensions; revise defects you can see. Successful export alone does not establish that the design works.
- A request in more than one colour or material, except a copy of a designer's 3MF (the next rule): model each colour as its own body or object, export each one as an STL, and combine them with the printer MCP's counterpart_make_3mf into out/touched.3mf, one part per colour in the order the request names them (part 1 on filament 1, and so on). Build the parts lying the way the object should print: a 3MF keeps its placement exactly as made (Counterpart never re-orients a 3MF), so the orientation you model is the orientation that prints, supports included. Report every part under "parts" in your answer, in that same order, with its name and the colour the person asked for as #RRGGBB (and its material when they named one): the 3MF itself carries no colours, so this list is how Counterpart knows which spool each part belongs on. Still export the whole model to out/touched.stl. Counterpart prints the 3MF and puts each part on a spool; never tell the person how to slice, which filament slot to use or which layer height to pick.
- A copy of a designer's 3MF (the files list names a designer's 3MF project): that project is the thing being copied, and it prints with the designer's own parts, plate placement, painted colours and print settings. Change only what the person asked for, inside that project: edit its object models in place (for example re-paint or add faces with the same colour attributes the designer used, or change one object's mesh) and write the whole project, every other file unchanged, to out/touched.3mf. Never rebuild it from the merged mesh or with counterpart_make_3mf, never turn painted markings into separate parts, and never move, turn or rescale what the designer laid out. Export the merged mesh to out/touched.stl as well, for the renders. Check it against the designer's own file: everything the designer's file prints must still print. Counterpart refuses a copy whose print settings differ from the designer's file.
- When the person asks you to copy, change or print an existing model and you can't get its file (a login, a missing download), set status to failed and say which file to add. Never design a substitute for a model the person named.
- Export the final model to out/touched.stl and clear PNG renders to out/, named so the clearest overall view sorts first (for example 1_overview.png). Explain what the part does and any remaining fit assumptions in the final summary.
- If you can't see a part well enough to fix it, set status to needs_closeup and say what to photograph.
- If something breaks and you can't finish (for example Blender stops responding), set status to failed and say what happened.`;


/** Only what Claude Code needs to find the user's own login. Never printer tokens or provider keys. */
const ENV_ALLOWLIST = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL', 'CLAUDE_CONFIG_DIR'] as const;

export interface McpServerEntry {command: string; args: string[]; env?: Record<string, string>}
export interface TouchupInvocation {
  worker?: import('./runner.js').ProjectWorker;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  mcpConfigPath: string;
  /** Runner-only redaction inputs; never forwarded to the worker or adapter environment. */
  redactionEnv?: NodeJS.ProcessEnv;
  mcpConfig: {mcpServers: Record<string, McpServerEntry>};
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

function prompt(pass: TouchupPass, instructions?: string, note?: string, summary?: string, currentModel = false, designerCopy = false): string {
  const opening = note !== undefined
    ? [...(currentModel ? [`This is the current model. ${summary ?? ''}`.trimEnd()]
      : designerCopy ? [`This continues a copy of a designer's 3MF. ${summary ?? ''}`.trimEnd()]
      : ['Continue this project using the original inputs and the additional request below. No completed model is available yet.']),
       ...(instructions?.trim() ? [`Original request: ${instructions.trim()}`] : []),
       `Change requested: ${note}`,
       ...(currentModel ? ['The current model is an STL already in millimetres: import and export it at scale 1.'] : [])].join('\n\n')
    : instructions?.trim() || TOUCHUP_INSTRUCTION;
  const files = [
    ...(designerCopy ? [`- Designer's 3MF project to edit: ${pass.scanPaths[0]}${pass.scanPaths.length > 1 ? ' (it already has the earlier changes)' : ''}`,
      ...(pass.scanPaths.length > 1 ? [`- The designer's original 3MF, to compare against: ${pass.scanPaths.at(-1)}`] : [])]
    : pass.scanPaths.length ? [`- Scan: ${pass.scanPaths.join(', ')}${!currentModel && pass.scanPaths.some(path => /\.(stl|3mf)$/i.test(path))
      ? ' (a model file the person added on their Mac, usually in millimetres: check its size with get_stl_info before editing)' : ''}`] : []),
    ...(pass.photoOverviewPaths ?? []).map(path => `- Photo overview (read first): ${path}`),
    ...pass.photoPaths.map((path, index) => `- Photo ${index + 1}: ${path}`),
    `- Checkpoints folder: ${pass.checkpointsDir}`,
    `- Output folder: ${pass.outDir}`,
  ];
  return `${opening}\n\nFiles:\n${files.join('\n')}`;
}

/** The lean, isolated `claude -p` call for one touch-up pass. Writes the pass's MCP config file. */
export const BLENDER_RULES = "- Reach Blender only through the printer MCP's blender_mcp_* tools. Start in the empty scene you are given, and work only with objects in the current scene (bpy.context.scene.objects).";
/**
 * The printer MCP's own guidance for a pass: how to design for its printers (`fdm_design`) and how its slicer
 * orients, supports and checks a slice (`fdm_slicing`). The app holds no slicer knowledge (PRD §8.0 item 10).
 */
export interface DesignGuidance {design?: string; slicing?: string}

/** The system rules for an engine. */
export function systemRules(engine: DesignEngine = 'blender', guidance: DesignGuidance = {}): string {
  return SYSTEM_RULES_TEMPLATE.replace('- ENGINE_RULES', engine === 'fusion' ? FUSION_RULES : BLENDER_RULES)
    .replace('ENGINE_NAME', engine === 'fusion' ? 'in Fusion through the printer MCP (only its fusion_mcp_* tools)' : 'using Blender through MCP')
    + (guidance.design?.trim() ? `\n\nManufacturing guidance from the printer MCP (its fdm_design prompt):\n${guidance.design.trim()}` : '')
    + (guidance.slicing?.trim() ? `\n\nHow the printer MCP slices (its fdm_slicing prompt):\n${guidance.slicing.trim()}` : '');
}
/** The Blender rules, as every copy and every Blender design pass gets them. */
export const TOUCHUP_SYSTEM_RULES = systemRules('blender');

export function buildTouchupInvocation(input: {pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; instructions?: string; note?: string; summary?: string; currentModel?: boolean; designerCopy?: boolean; sourceEnv?: NodeJS.ProcessEnv;
  engine?: DesignEngine; documentId?: string; handoff?: PrinterHandoffConfig; design?: {f3d: string; parameters?: string}; guidance?: DesignGuidance}): TouchupInvocation {
  const {pass} = input;
  let printer = printerServer(input.printer);
  if (input.engine === 'fusion') {
    if (!input.documentId?.trim() || !input.handoff) throw new Error('A Fusion pass requires a document binding');
    const binding = join(pass.dir, 'fusion-binding.json');
    writeFileSync(binding, JSON.stringify({handoff: input.handoff, documentId: input.documentId}), {mode: 0o600});
    printer = {command: process.execPath, args: [fileURLToPath(new URL('./fusion-worker-cli.js', import.meta.url)), binding]};
    if (process.env.SCAN_TO_MAKE_PRINTER_NODE) printer.env = {SCAN_TO_MAKE_PRINTER_NODE: process.env.SCAN_TO_MAKE_PRINTER_NODE};
  }
  const mcpConfig = {mcpServers: {printer}};
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
    '--append-system-prompt', systemRules(input.engine, input.guidance),
    '--json-schema', JSON.stringify(TOUCHUP_RESULT_SCHEMA),
    '--output-format', 'stream-json',
    '--verbose',
    prompt(pass, input.instructions, input.note, input.summary, input.currentModel, input.designerCopy) + (input.engine === 'fusion' && input.design
      ? `\n\nThe current design is a parametric Fusion design: ${input.design.f3d}${input.design.parameters ? ` (its parameters: ${input.design.parameters})` : ''}. A separate copy is already imported into this pass's bound document. Change its parameters rather than opening the archive again or editing the mesh.` : ''),
  ];
  return {command: input.claudePath, args, env: isolatedClaudeEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig, redactionEnv: {...input.printer.env}};
}
