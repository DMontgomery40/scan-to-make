import {writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {PrinterMcpProcess, PrinterHandoffConfig} from '@scan-to-make/printer-handoff';
import type {TouchupPass} from './inputs.js';
import {isCodeDesign, passCadDir, type DesignSource} from './code-engine.js';

/**
 * The request for a scan sent for cleanup with no words from the person (PRD §5.3: that runs only when they asked
 * for changes without saying which).
 */
export const TOUCHUP_INSTRUCTION = 'Clean up this scan so it prints as the real object in the photos looks: recognise what it is, repair what the scan got wrong, and keep its size.';

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
    title: {type: 'string', maxLength: 40, description: 'A short name for the thing, two to four words and at most 40 characters, like "Mic mount" or "Crochet potato"'},
    changes: {type: 'array', maxItems: 12, description: 'What changed, one short line each, for the person to check',
      items: {type: 'object', additionalProperties: false, required: ['tag', 'text'], properties: {
        tag: {enum: ['added', 'changed', 'assumed', 'estimated'], description: 'added: new geometry; changed: altered geometry; assumed: a choice made without evidence; estimated: a size not measured or published'},
        text: {type: 'string', maxLength: 200, description: 'One short line, at most 200 characters'},
        toleranceMm: {type: 'number', minimum: 0, description: 'For estimated sizes: plus or minus this many millimetres'},
      }}},
    parts: {type: 'array', maxItems: 64, description: 'Only for a request in more than one colour: the parts of out/touched.3mf in filament order (the first prints on filament 1), each with the colour the person asked for as #RRGGBB, so Counterpart can put it on the nearest loaded spool',
      items: {type: 'object', additionalProperties: false, required: ['colour'], properties: {
        name: {type: 'string', maxLength: 128, description: 'The part’s name in the 3MF, at most 128 characters, like "body" or "letters"'},
        colour: {type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'The colour this part should print in, as #RRGGBB'},
        material: {type: 'string', maxLength: 64, description: 'The material, at most 64 characters, only when the request names one for this part (for example PLA or PETG)'},
      }}},
    ask: {type: 'object', additionalProperties: false, required: ['question'], description: 'When status is needs_closeup: the one question, and where to look',
      properties: {
        question: {type: 'string', maxLength: 200, description: 'One plain question of at most 200 characters, like "Can you take a close-up of the clip on the left side?"'},
        photo: {type: 'string', description: 'The file name of one supplied photo or one of your renders in out/ that shows the region'},
        region: {type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], description: 'The region on that photo, as fractions of its width and height from the top-left',
          properties: {x: {type: 'number', minimum: 0, maximum: 1}, y: {type: 'number', minimum: 0, maximum: 1}, width: {type: 'number', minimum: 0, maximum: 1}, height: {type: 'number', minimum: 0, maximum: 1}}},
        sizes: {type: 'array', minItems: 1, maxItems: 6, description: 'Only when the question asks the person to confirm or correct sizes: each size you need, so they can check a number instead of writing a sentence. Name each one so a person holding the object and a caliper knows exactly where to measure ("width at the widest point", "height to the cap tip"); an object that is not a plain box needs more than three',
          items: {type: 'object', additionalProperties: false, required: ['label', 'mm', 'from'], properties: {
            label: {type: 'string', maxLength: 120, description: 'What to measure, in plain words, at most 120 characters'},
            mm: {type: 'number', exclusiveMinimum: 0, maximum: 10000, description: 'Your number for it, in millimetres'},
            from: {enum: ['published', 'scan', 'estimate'], description: 'Where your number came from. published: the maker published it for the product you name in product, at reference; scan: you read it off the scan; estimate: your own guess, neither published nor read off the scan. The person sees which, and a number they confirm untouched stays exactly as certain as this source: it is never a measurement'},
            product: {type: 'string', maxLength: 120, description: 'Required when from is published: the exact product and variant the published number is for, as the person has it, at most 120 characters. When they said it is in a case or has something attached, that is the case or the attachment (its maker and model), never the bare product: a bare product\'s published size is not its size in a case'},
            reference: {type: 'string', maxLength: 300, description: 'Required when from is published: where the maker published it, as a link to the page you read or the name of the maker\'s document, at most 300 characters'},
          }}},
      }},
    seats: {type: 'array', minItems: 1, maxItems: 32, description: 'For a part made to fit the scanned object: where that object sits in the finished part, one entry per place it goes (three for a holder of three), as your rules under "Where the scanned object sits" define them',
      items: {type: 'object', additionalProperties: false, required: ['rotationDeg', 'translationMm'], properties: {
        name: {type: 'string', maxLength: 40, description: 'A short name for this place, at most 40 characters, like "left", "middle" or "right"; only when there is more than one'},
        rotationDeg: {type: 'array', minItems: 3, maxItems: 3, items: {type: 'number'}, description: 'Turn the scan about the fixed X, then Y, then Z axes through the origin, in degrees: cad_check_fit\'s rotation_deg'},
        translationMm: {type: 'array', minItems: 3, maxItems: 3, items: {type: 'number'}, description: 'Then move it, in millimetres: cad_check_fit\'s translation_mm'},
        check: {type: 'object', additionalProperties: false, description: 'What cad_check_fit returned for this seat, when you ran it',
          properties: {minimumGapMm: {type: 'number', minimum: 0}, interferenceMm3: {type: 'number', minimum: 0}, clear: {type: 'boolean'}}},
      }}},
    supports: {type: 'object', additionalProperties: false, required: ['enabled'], description: 'Whether the slicer generates supports when this model prints. Counterpart sends it to the slicer as it is: supports off is sent too',
      properties: {
        enabled: {type: 'boolean'},
        type: {enum: ['tree(auto)', 'normal(auto)'], description: 'When enabled: the slicer’s automatic tree or normal supports'},
      }},
  },
} as const;

/**
 * The design engine for a pass (PRD §8.9): the printer MCP's code engine whenever it is there and set up; otherwise
 * Blender for copies, and Fusion for new designs when it's connected.
 */
export type DesignEngine = 'blender' | 'fusion' | 'code';

/**
 * The first line of every pass's rules says which engine it runs on (#609: a Blender pass hunted across ~20 cad_run
 * calls for a folder the code engine would write to). The other engines' tools aren't offered either (`--disallowedTools`).
 */
const ON_ENGINE = {
  blender: "- This pass runs on Blender. The printer MCP's code design engine isn't part of this pass.",
  fusion: "- This pass runs on Fusion. The printer MCP's code design engine isn't part of this pass.",
  code: "- This pass runs on the printer MCP's code design engine.",
} as const;

const FUSION_RULES = `${ON_ENGINE.fusion}
- Design it in Autodesk Fusion through the printer MCP's fusion_mcp_* tools: fusion_mcp_call reaches Fusion's own tools (create_sketch, extrude, revolve, fillet, shell, boolean_operation, create_parameter, set_parameter, get_parameters, check_interference, …). A separate document is already prepared for this pass. Its identity is fixed by the tools: work with the provided design and component, without opening or switching documents.
- Make every functional dimension a named user parameter, so a later change is one set_parameter.
- When the design is finished, call fusion_mcp_export with output_dir set to the output folder and name "touched": it writes touched.stl, touched.f3d and touched.parameters.json. Use body_name when the design has more than one body; for several colours, export each colour's body under its own name and combine them as the colour section below says.
- If you can, save clear PNG views of the design to the output folder, named so the clearest overall view sorts first.`;

/**
 * The code engine's lines (PRD §8.9). How a script looks, which libraries it has and how a scan is prepared are the
 * printer MCP's (its cad_design prompt, added below); these lines are only where Counterpart keeps each run.
 */
const CODE_RULES = `${ON_ENGINE.code}
- Build it with the printer MCP's code design engine (its cad_* tools), following its cad_design prompt below. Give every cad_run the design folder from the files list as its output_dir.
- After each fix, mark the run of the whole model you select as the result so far final: Counterpart files each final run as a checkpoint, the latest one's model, views, script and parameters become this pass's result (Counterpart copies them to the output folder), and a later change starts from that script and those parameters. Never mark final a run that measures or prepares the scan, or makes one colour's part: it never becomes the model.`;

/** How the core's checkpoint and final-export lines read for each engine. The code engine's runs are filed by Counterpart. */
const EXPORT_RULES = {
  app: `- After each fix, export the whole model as an STL to the checkpoints folder (01.stl, 02.stl, …).
- Render and inspect the candidate from all six sides against the request and reference photos. Revise visible discrepancies, or ask for the specific missing evidence when it is actually absent. Check the dimensions; revise defects you can see. Successful export alone does not establish that the result works.
- Export the final model to out/touched.stl and clear PNG renders to out/, named so the clearest overall view sorts first (for example 1_overview.png).`,
  code: `- Inspect all six views of each run against the request and reference photos. Revise visible discrepancies, or ask for the specific missing evidence when it is actually absent. Check the dimensions; revise defects you can see. Successful export alone does not establish that the result works.`,
};

/**
 * The worker's rules, composed per pass (PRD §8.9): a shared core, then only the sections that pass needs.
 * Every pass gets the core; the rest depend on the pass's kind, its inputs and whether the person wrote anything.
 */
const CORE_RULES = (engine: string, exports: string = EXPORT_RULES.app, stuck = 'for example Blender stops responding') => `You are making a useful 3D object for a person. Understand what they want it to do, the things it must fit, and how they will assemble and use it. Deliver a complete model that answers that request.
${engine}
- Read every numbered photo overview first, then open the individual photos to inspect details and resolve different orientations. Read every supplied reference photo and the user's request before modeling.
- Use measured or published dimensions when available. Distinguish measurements from estimates. Make reasonable choices for noncritical details; ask for a close-up or measurement when a missing interface dimension prevents a useful fit.
- Plan how it will be printed as part of the design, following the printer MCP's manufacturing guidance when it is given below, for captured objects and new designs alike.
- Export the model in the orientation the object is used in. The print step sends it to the slicer as it is, with your answer's supports, off included. Set supports for every model you export: enabled, with a type, when the part needs them to print well; not enabled when it prints cleanly without them. How the slicer orients the model and generates supports, and how to check that choice with a checkpoint slice, is the printer MCP's to say: follow its slicing guidance below.
- Scans from the phone are in metres. A current-model STL supplied for revision is already in millimetres. Build new designs in millimetres and export every STL in millimetres, the unit printers use.
${exports}
- If you can't see a part well enough to fix it, set status to needs_closeup and say what to photograph.
- If something breaks and you can't finish (${stuck}), set status to failed and say what happened.`;

/** The headings of the optional sections, as the worker reads them. Tests and the PR use them to say which a pass got. */
export const RULE_SECTIONS = {
  newDesign: 'A new design:',
  captured: 'Cleaning up a captured object:',
  fitSizes: 'Sizes the part must fit:',
  colours: 'A request in more than one colour or material:',
  designerCopy: "A copy of a designer's 3MF:",
  namedModel: 'A model the person names:',
  seats: 'Where the scanned object sits:',
} as const;

const NEW_DESIGN_RULES = (engineName: string) => `${RULE_SECTIONS.newDesign}
- Identify the functional interfaces: what holds what, contact surfaces, clearances, access, and how the part attaches without obstructing the real objects.
- Construct the complete functional geometry ${engineName}. Procedural modeling, profiles, booleans, curves, modifiers and multiple iterations are available. A collection of rough primitives is a starting sketch, not a finished mount, clip, bracket or enclosure.
- When you inspect it, check the attachment interfaces and the assembly path as well.
- In the final summary, explain what the part does and any remaining fit assumptions.`;

const CAPTURED_RULES = (tools: string) => `${RULE_SECTIONS.captured}
- First say what the object is and name its parts from the photos, for example: a bottle with a body, a shoulder, a cap with ribs and a printed label; or a sign with separate letters standing on a base. Plan every fix from that.
- Fix defects supported by the photos with targeted edits: raise features that are missing or too faint, and flatten or smooth surfaces the photos show are flat or smooth, choosing that region by the scan's colour (a white card, a label). Keep real surface detail the photos confirm, including texture, stitches and edges.${tools}
- Manufactured features are regular in the real object, so scan wobble on them is a defect. Where the photos show one, rebuild it regular: flat faces flat, straight edges straight, cylinders round, mirrored halves mirrored, and repeated features (ribs, teeth, threads, the letters of one typeface) equal and evenly spaced, with their count taken from the photos. A feature the scan lost or smeared, like a cap's ribs, is rebuilt from the photos.
- Printed graphics, labels and colour changes are ink, not shape. Keep that surface smooth unless the photos show real relief: a raised label is a scan defect, not surface detail the photos confirm.
- Organic and handmade surfaces (fabric, crochet, carving, clay) stay as scanned.
- Surface detail comes from the scan itself: its shape and, for a capture, its normal map (the scan file named *_normal_N.png), at the height the scan measured. Where the photos show fabric, knit or crochet in relief that the scan didn't capture, raise that material's stitch or weave pattern from the colour texture at a modest height, on that material only, and list it in changes as assumed. Never raise printed graphics, labels or other colour changes.
- A small feature the photos show standing proud that the scan lost or smeared (a bead eye, a button, a stitched line) goes where the scan's colour shows it, as a clean shape sized from the scan and the photos and listed as assumed: a round one as a bead, a line as a cord that follows its own curve.
- Sizes still come from the scan or from measurements. Regularising a feature never rescales the object.
- List each regularisation in your answer's changes, one line per feature (for example "Cap: 24 ribs made even"), tagged assumed, or estimated with toleranceMm when it sets a size, so the person sees what was inferred. If the photos can't settle what a feature is, set status to needs_closeup and ask for a close-up of it instead of guessing.
- Plan the print with the captured shape: change it where printing it well calls for that, and keep the real surface detail the photos confirm.
- When you inspect it, compare the rear and underside explicitly with the supplied photos, accounting for the object being turned over between photographs. A smooth, closed scan surface can still be a reconstruction defect. Before calling any region unseen, check all supplied views and identify which views support that conclusion; do not infer missing photographic coverage from missing mesh detail.`;

/**
 * #427, in a fixed order for every engine (Nov 10: a code fit pass measured the scan 29.8 deep and 150 tall against
 * calipers of 28 and 145, judged it unimportant, designed without asking, and chose 1.5 mm a side so the cavity
 * swallowed the scan). Measurements define the interface; a disagreement stops the pass with the ask before any
 * fit-critical geometry; the fit is then chosen per interface from what it has to do (Nov 10: 0.5 mm a side was right for a
 * drop-in bottle holder and would ruin a mic clamp), never one number for all; a fit check is information.
 */
const FIT_SIZE_RULES = (scanCheck: string) => `${RULE_SECTIONS.fitSizes}
Settle the sizes the part must fit in this order, before modelling anything that depends on them:
1. The interface sizes come from measurements: the dimensions the person measured (in the request or on a size card), or the maker's published dimensions with their source. A number the person only accepted without changing it (an estimate or a scan reading) is not a measurement: treat it as that estimate. When the request asks for a lookup, identify the exact product and variant, open the manufacturer's own published dimensions with WebSearch/WebFetch, then stop with needs_closeup to confirm them before building geometry that depends on them: the ask question names the product, its size in mm and the maker's source, and says the reply can confirm it, correct it in words, or send a caliper photo. If the exact product or size cannot be established, ask for the specific caliper measurements or a photo with calipers instead. Whenever you stop to have sizes confirmed or measured, also list each one in ask.sizes with your own number for it, so the person can check or correct a number.
2. When there is a scan, compare each measured or published size with it, measuring the scan in the object's own upright frame. If any of them differs by more than the stated tolerance (2 mm or 2% when none is stated), stop with needs_closeup before modelling any fit-critical geometry, however little you judge the difference to matter for this part. The question names both sets of numbers, each measurement and what the scan reads, in mm, and asks which to use. Don't ask again when the person has already answered it: their answer is in the request or the change.
3. Size each place the part meets a real object from the measured or published sizes, with a fit chosen by what that interface has to do. Say its function in plain words: the object rests in, or drops in and lifts out; slides; locates without rattle; grips so it does not slip or turn; clamps closed with a screw; snaps over; or presses in to stay. Infer it first from the object and how the part mounts (a holder open at the top is a drop-in; a mount on a pole must not turn). Keep three things apart: the object's size, with how it was measured (calipers, a published dimension, a scan, a photo estimate) and how sure it is; the correction for how that feature prints; and the fit, which comes only from the function. Choose the fit from the function, the feature's size and shape, how sure the size is and how it prints: a plain clearance where loose is the point; where it must grip, or the size is less sure than the function tolerates, a mechanism that takes up the difference (crush ribs, a split with a pinch screw, a flexure, a snap), or ask for the one caliper measurement that settles it. For example, a wall holder that bottles drop into takes a clearance all round, while a pole clamp sized from a photo takes a split and a screw so it grips across the range that estimate allows. Never reuse one number for every interface, and never choose a fit to make room for the scan. When you can't tell what an interface has to do and the answer would change the design, stop with needs_closeup and ask about behaviour the person can answer (should it stay in upside down, lift out with one hand, ever turn?). In your summary, give each interface its function, the fit chosen (clearance or interference per side, or the mechanism and the range of sizes it holds) and why.${scanCheck}`;

const COLOUR_RULES = (whole: string) => `${RULE_SECTIONS.colours}
- Model each colour as its own body or object, export each one as an STL, and combine them with the printer MCP's counterpart_make_3mf into out/touched.3mf, one part per colour in the order the request names them (part 1 on filament 1, and so on). Build the parts lying the way the object should print: a 3MF keeps its placement exactly as made (Counterpart never re-orients a 3MF), so the orientation you model is the orientation that prints, supports included. Report every part under "parts" in your answer, in that same order, with its name and the colour the person asked for as #RRGGBB (and its material when they named one): the 3MF itself carries no colours, so this list is how Counterpart knows which spool each part belongs on. ${whole} Counterpart prints the 3MF and puts each part on a spool; never tell the person how to slice, which filament slot to use or which layer height to pick.`;

const DESIGNER_COPY_RULES = `${RULE_SECTIONS.designerCopy}
- The files list names a designer's 3MF project: that project is the thing being copied, and it prints with the designer's own parts, plate placement, painted colours and print settings. Change only what the person asked for, inside that project: edit its object models in place (for example re-paint or add faces with the same colour attributes the designer used, or change one object's mesh) and write the whole project, every other file unchanged, to out/touched.3mf. Never rebuild it from the merged mesh or with counterpart_make_3mf, never turn painted markings into separate parts, and never move, turn or rescale what the designer laid out. Export the merged mesh to out/touched.stl as well, for the renders. Check it against the designer's own file: everything the designer's file prints must still print. Counterpart refuses a copy whose print settings differ from the designer's file.`;

const NAMED_MODEL_RULES = `${RULE_SECTIONS.namedModel}
- When the person asks you to copy, change or print an existing model and you can't get its file (a login, a missing download), set status to failed and say which file to add. Never design a substitute for a model the person named.`;

/**
 * Where the scanned object sits (docs/protocols/seats.md): the pass that built the pocket, hook or cradle says where
 * the object goes, so every client can show the part with the object in place. One number set for that and the fit check.
 */
const SEAT_RULES = (code: boolean) => `${RULE_SECTIONS.seats}
- In your answer, give "seats": one entry for each place the scanned object goes in or on the finished part (three for a holder of three), each a rigid placement of the scan in the part's frame. Name each one ("left", "middle", "right") when there is more than one.
- The part's frame is the model as you export it${code ? ' (the run you mark final)' : ' (out/touched.stl)'}: millimetres, Z up, in the orientation it is used in.
- The scan's frame is the scan file in the files list in its own coordinates, scaled to millimetres and turned so its up axis is +Z by one quarter turn about X (when +Y is up, (x, y, z) becomes (x, -z, y)): not moved, not centred and not dropped to the floor.${code ? ' That is what load_scan(name, source_units="m", up_axis="y", ground=False) returns: load the reference for cad_check_fit that way, so the transform you check is the seat you report, and give that check\'s numbers under the seat\'s "check".' : ''}
- A seat turns the scan about the fixed X, then Y, then Z axes through the origin (rotationDeg), then moves it (translationMm): the rotation_deg and translation_mm that cad_check_fit takes.
- Put the object where a person would put it: resting in its pocket, cradle or hook the way it is used, not floating above it and not sunk into the part beyond the scan's own roughness. Measured sizes still decide the part; a seat only says where the object goes.
- Give the seats in every answer with a model, including a change: where the change moved a pocket, move its seat with it.`;

/** A pass that only says where the object sits in an existing part: no geometry, no export. */
const LOCATE_RULES = (code: boolean) => `You are working out where a scanned object sits in a part that is already finished, for a person who wants to see the two together.
- The part is finished and stays exactly as it is. Don't edit, rebuild, repair or export it, and write no STL or 3MF${code ? ': never mark a cad_run final' : ''}. Use the tools only to look at and measure the part and the scan${code ? ' (a cad_run that only loads and measures them, and cad_check_fit)' : ''}.
- Read the person's original request and the part's summary first: they say what the part holds and how.
- Answer with status done, a one-sentence summary of where the object goes (for example "One bottle in each of the three pockets, standing upright on the pocket floor"), and seats. If you can't tell where it goes, set status to failed and say why in one sentence.

${SEAT_RULES(code)}`;

/** A code fit with a scan may check itself against it; the scan never wins over measured or published sizes (#427); an accepted estimate is not a measurement (#622). */
const CODE_FIT_CHECK = `
4. When there is a scan, check the finished part against it with cad_check_fit as the printer MCP's cad_design prompt describes, and report the interference and gap, with what you changed in the reference, in your changes.`;

/** The code engine's one line for a locate pass: its tools, and that nothing it runs becomes the model. */
const CODE_LOCATE_CORE = `${ON_ENGINE.code}\n` + "- Reach the part and the scan only through the printer MCP's code design engine (its cad_* tools). Give every cad_run the design folder from the files list as its output_dir.";

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
  /** The pass's engine: a code pass's runs are filed by the runner after the worker ends. */
  engine?: DesignEngine;
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

/** What the capture's own conversion report says about the converted scan: its unit, in metres, and which axis is up. */
export interface ScanFrame {unitMetres: number; upAxis: string}

function frameWords(frame: ScanFrame): string {
  const unit = frame.unitMetres === 1 ? '1 metre' : frame.unitMetres === 0.001 ? '1 millimetre' : `${frame.unitMetres} metres`;
  return `the capture converted without changes: 1 unit is ${unit} and +${frame.upAxis.toUpperCase()} is up`;
}

function prompt(pass: TouchupPass, instructions?: string, note?: string, summary?: string, currentModel = false, designerCopy = false, code?: {frame?: ScanFrame}): string {
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
    : pass.scanPaths.length ? [`- Scan: ${pass.scanPaths.join(', ')}${code?.frame ? ` (${frameWords(code.frame)})`
      : currentModel && code ? ' (the current model: millimetres, Z up)'
      : !currentModel && pass.scanPaths.some(path => /\.(stl|3mf)$/i.test(path))
      ? code ? ' (a model file the person added on their Mac, usually in millimetres: check its size before editing)'
        : ' (a model file the person added on their Mac, usually in millimetres: check its size with get_stl_info before editing)' : ''}`] : []),
    ...(pass.photoOverviewPaths ?? []).map(path => `- Photo overview (read first): ${path}`),
    ...pass.photoPaths.map((path, index) => `- Photo ${index + 1}: ${path}`),
    ...(code ? [`- Design folder (output_dir for every cad_run): ${passCadDir(pass)}`] : [`- Checkpoints folder: ${pass.checkpointsDir}`]),
    `- Output folder: ${pass.outDir}`,
  ];
  return `${opening}\n\nFiles:\n${files.join('\n')}`;
}

/** A locate pass's request: the finished part, the scan, and what the person asked the part to do. */
function locatePrompt(pass: TouchupPass, instructions?: string, summary?: string, frame?: ScanFrame, code = false): string {
  const [part, ...scans] = pass.scanPaths;
  return [`Work out where the scanned object sits in this finished part, and give its seats. Change nothing.`,
    ...(instructions?.trim() ? [`What the person asked the part to do: ${instructions.trim()}`] : []),
    ...(summary?.trim() ? [`What the pass that made it said: ${summary.trim()}`] : []),
    `Files:\n${[`- The finished part (millimetres, Z up, as it is used): ${part}`,
      ...scans.map(scan => `- Scan: ${scan}${frame ? ` (${frameWords(frame)})` : ''}`),
      ...pass.photoPaths.map((path, index) => `- Photo ${index + 1}: ${path}`),
      ...(code ? [`- Design folder (output_dir for every cad_run): ${passCadDir(pass)}`] : []),
      `- Output folder: ${pass.outDir}`].join('\n')}`].join('\n\n');
}

/**
 * The tools a pass on each engine doesn't get: the other engines'. Nov 11 (#609): a Blender pass ran cad_setup twice and
 * about twenty cad_run calls hunting for a folder the code engine would write to; a Blender pass with Fusion's tools
 * could open an unbound Fusion document without the Fusion lock. Claude Code's own rule syntax (a trailing * is a
 * prefix; checked against 2.1.322), carried in the request's --disallowedTools to every worker.
 */
export const OTHER_ENGINES_TOOLS: Record<DesignEngine, readonly string[]> = {
  blender: ['mcp__printer__cad_*', 'mcp__printer__fusion_mcp_*'],
  fusion: ['mcp__printer__cad_*', 'mcp__printer__blender_mcp_*'],
  code: ['mcp__printer__blender_mcp_*', 'mcp__printer__fusion_mcp_*'],
};

/** Whether a worker request's --disallowedTools takes `server`'s tool `tool` away, as Claude Code reads the flag. */
export function toolBlocked(args: readonly string[], server: string, tool: string): boolean {
  const flag = args.indexOf('--disallowedTools');
  if (flag < 0) return false;
  const name = `mcp__${server}__${tool}`;
  return (args[flag + 1] ?? '').split(/[\s,]+/).filter(Boolean).some(rule => rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : name === rule);
}

export const BLENDER_RULES = `${ON_ENGINE.blender}\n` + "- Reach Blender only through the printer MCP's blender_mcp_* tools. Start in the empty scene you are given, and work only with objects in the current scene (bpy.context.scene.objects).";
/**
 * The printer MCP's own guidance for a pass: how to design for its printers (`fdm_design`) and how its slicer
 * orients, supports and checks a slice (`fdm_slicing`). The app holds no slicer knowledge (PRD §8.0 item 10).
 */
export interface DesignGuidance {design?: string; slicing?: string; cad?: string}

/** What decides a pass's rules: the inputs `buildTouchupInvocation` already has. */
export interface PassRules {
  /** "copy" cleans up or copies a captured or supplied object; "fit" designs something new (PRD §8.9). */
  kind: 'copy' | 'fit';
  engine?: DesignEngine;
  /** The person wrote something: the project's request or a change they asked for. */
  request?: boolean;
  /** The pass edits a designer's 3MF project in place. */
  designerCopy?: boolean;
  /** The pass has the scanned object to fit (a fit with a scan): it says where the object sits. */
  scan?: boolean;
  /** Only says where the scanned object sits in the finished part (docs/protocols/seats.md). */
  locate?: boolean;
}

/** The sections a pass gets on top of the core, in the order the worker reads them. */
export function ruleSections(pass: PassRules): (keyof typeof RULE_SECTIONS)[] {
  const sections: (keyof typeof RULE_SECTIONS)[] = [];
  if (pass.kind === 'fit') sections.push('newDesign');
  if (pass.kind === 'copy' && !pass.designerCopy) sections.push('captured');
  if (pass.kind === 'fit') sections.push('fitSizes');
  // No input says a request is in several colours; any words from the person may ask for them. A designer's 3MF keeps its own.
  if (pass.request && !pass.designerCopy) sections.push('colours');
  if (pass.designerCopy) sections.push('designerCopy');
  if (pass.request) sections.push('namedModel');
  if (pass.kind === 'fit' && pass.scan) sections.push('seats');
  return sections;
}

/** The system rules for one pass: the core, the sections it needs, then the printer MCP's own guidance. */
export function systemRules(pass: PassRules, guidance: DesignGuidance = {}): string {
  const engine = pass.engine ?? 'blender', code = engine === 'code';
  const engineName = engine === 'fusion' ? 'in Fusion through the printer MCP (only its fusion_mcp_* tools)' : code ? "with the printer MCP's code design engine" : 'using Blender through MCP';
  const text: Record<keyof typeof RULE_SECTIONS, () => string> = {
    newDesign: () => NEW_DESIGN_RULES(engineName), captured: () => CAPTURED_RULES(code ? '' : " Use Blender's existing sculpt, modelling and modifier tools for that cleanup."),
    fitSizes: () => FIT_SIZE_RULES(code ? CODE_FIT_CHECK : ''),
    colours: () => COLOUR_RULES(code ? 'The run you mark final is still the whole model.' : 'Still export the whole model to out/touched.stl.'), designerCopy: () => DESIGNER_COPY_RULES, namedModel: () => NAMED_MODEL_RULES,
    seats: () => SEAT_RULES(code),
  };
  if (pass.locate) return [code ? CODE_LOCATE_CORE : BLENDER_RULES, LOCATE_RULES(code)].join('\n\n')
    + (code && guidance.cad?.trim() ? `\n\nThe printer MCP's code design engine (its cad_design prompt):\n${guidance.cad.trim()}` : '');
  const core = code ? CORE_RULES(CODE_RULES, EXPORT_RULES.code, 'for example cad_run keeps failing') : CORE_RULES(engine === 'fusion' ? FUSION_RULES : BLENDER_RULES);
  return [core, ...ruleSections(pass).map(section => text[section]())].join('\n\n')
    + (code && guidance.cad?.trim() ? `\n\nThe printer MCP's code design engine (its cad_design prompt):\n${guidance.cad.trim()}` : '')
    + (guidance.design?.trim() ? `\n\nManufacturing guidance from the printer MCP (its fdm_design prompt):\n${guidance.design.trim()}` : '')
    + (guidance.slicing?.trim() ? `\n\nHow the printer MCP slices (its fdm_slicing prompt):\n${guidance.slicing.trim()}` : '');
}

/** The rules a pass gets, from the same inputs as its prompt. */
function passRules(input: {pass: TouchupPass; kind?: 'copy' | 'fit'; engine?: DesignEngine; instructions?: string; note?: string; designerCopy?: boolean; currentModel?: boolean; seats?: unknown[]; locate?: boolean}): PassRules {
  return {kind: input.kind ?? (input.designerCopy || input.pass.scanPaths.length ? 'copy' : 'fit'), ...(input.engine ? {engine: input.engine} : {}),
    request: Boolean(input.instructions?.trim() || input.note?.trim()), ...(input.designerCopy ? {designerCopy: true} : {}),
    // A first fit pass has the scan itself; a change has the current model and the seats it restates.
    ...((input.pass.scanPaths.length > 0 && !input.currentModel) || input.seats?.length ? {scan: true} : {}),
    ...(input.locate ? {locate: true} : {})};
}

/** The lean, isolated `claude -p` call for one touch-up pass. Writes the pass's MCP config file. */
export function buildTouchupInvocation(input: {resumeSessionId?: string; pass: TouchupPass; printer: PrinterMcpProcess; claudePath: string; instructions?: string; note?: string; summary?: string; currentModel?: boolean; designerCopy?: boolean; sourceEnv?: NodeJS.ProcessEnv;
  engine?: DesignEngine; documentId?: string; handoff?: PrinterHandoffConfig; design?: DesignSource; guidance?: DesignGuidance;
  /** A code pass's converted capture: its unit and up axis, from the conversion report. */
  scanFrame?: ScanFrame;
  /** The pass's kind (PRD §8.9). Without it, a pass with a scan is a copy and one without is a new design, as passKind decides. */
  kind?: 'copy' | 'fit';
  /** The current model's seats, for a change to restate (docs/protocols/seats.md). */
  seats?: unknown[];
  /** Only locate the scanned object in the finished part: `pass.scanPaths` is [the part's STL, the scan]. */
  locate?: boolean}): TouchupInvocation {
  const {pass} = input;
  let printer = printerServer(input.printer);
  if (input.engine === 'fusion') {
    if (!input.documentId?.trim() || !input.handoff) throw new Error('A Fusion pass requires a document binding');
    const binding = join(pass.dir, 'fusion-binding.json');
    writeFileSync(binding, JSON.stringify({handoff: input.handoff, documentId: input.documentId}), {mode: 0o600});
    printer = {command: process.execPath, args: [fileURLToPath(new URL('./fusion-worker-cli.js', import.meta.url)), binding]};
    if (process.env.SCAN_TO_MAKE_PRINTER_NODE) printer.env = {SCAN_TO_MAKE_PRINTER_NODE: process.env.SCAN_TO_MAKE_PRINTER_NODE};
  }
  if (input.engine === 'code') {
    // The engine writes runs, and reads scripts and inputs, only under its configured roots: add this project's
    // passes (every attempt, so a resumed one reaches its predecessor), keeping any roots the person set.
    const roots = [...(printer.env?.CAD_OUTPUT_DIRS ?? '').split(delimiter).filter(Boolean), dirname(pass.dir)];
    printer = {...printer, env: {...printer.env, CAD_OUTPUT_DIRS: [...new Set(roots)].join(delimiter)}};
  }
  const mcpConfig = {mcpServers: {printer}};
  const mcpConfigPath = join(pass.dir, 'mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {mode: 0o600});
  const args = [
    '-p',
    ...(input.resumeSessionId ? ['--resume', input.resumeSessionId] : []),
    // The design worker writes CAD. David, Nov 11 2026: "ALL CAD SPECIFIC TYPE WORK MUST BE DONE BY FABLE HIGH NOT OPUS".
    '--model', 'claude-fable-5-2',
    '--effort', 'high',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--tools', 'Read,WebSearch,WebFetch',
    '--allowedTools', 'Read,WebSearch,WebFetch,mcp__printer',
    // Only this pass's engine's tools. Every worker reads this flag: Claude Code itself, Codex and API workers through toolBlocked.
    '--disallowedTools', OTHER_ENGINES_TOOLS[input.engine ?? 'blender'].join(','),
    '--disable-slash-commands',
    '--setting-sources', '',
    '--settings', '{"disableAllHooks":true}',
    '--append-system-prompt', systemRules(passRules(input), input.guidance),
    '--json-schema', JSON.stringify(TOUCHUP_RESULT_SCHEMA),
    '--output-format', 'stream-json',
    '--verbose',
    (input.locate ? locatePrompt(pass, input.instructions, input.summary, input.engine === 'code' ? input.scanFrame : undefined, input.engine === 'code')
      : prompt(pass, input.instructions, input.note, input.summary, input.currentModel, input.designerCopy, input.engine === 'code' ? {...(input.scanFrame ? {frame: input.scanFrame} : {})} : undefined)
      + (input.seats?.length ? `\n\nWhere the scanned object sits in the current model (its seats, as the pass that made it said): ${JSON.stringify(input.seats)}. Give the seats again for the changed model: the same where the object still sits the same, moved where you moved its pocket.` : ''))
      + (input.locate ? '' : input.engine === 'fusion' && input.design && !isCodeDesign(input.design)
      ? `\n\nThe current design is a parametric Fusion design: ${input.design.f3d}${input.design.parameters ? ` (its parameters: ${input.design.parameters})` : ''}. A separate copy is already imported into this pass's bound document. Change its parameters rather than opening the archive again or editing the mesh.`
      : input.engine === 'code' && isCodeDesign(input.design)
      ? `\n\nThe current design is a code design: ${input.design.script} (its parameters: ${input.design.parameters}). Start from it, as the printer MCP's cad_design prompt says for an edit, rather than rebuilding it or editing the mesh.` : ''),
  ];
  return {command: input.claudePath, args, env: isolatedClaudeEnv(input.sourceEnv ?? process.env), cwd: pass.dir, mcpConfigPath, mcpConfig, redactionEnv: {...input.printer.env}, ...(input.engine ? {engine: input.engine} : {})};
}
