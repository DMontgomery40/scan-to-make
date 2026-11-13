import {copyFile, mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {toolResultJson, type PrinterMcpClient} from '@scan-to-make/printer-handoff';
import type {TouchupPass} from './inputs.js';

/**
 * Counterpart's side of the printer MCP's code design engine (`cad/1`, PRD §8.9). The MCP owns the engine, its
 * Python, how a script looks and how it is checked; Counterpart only asks whether it is there and ready, gives a
 * pass somewhere to keep its runs, and keeps the script and parameters as the project's design source.
 */

/** A code design, as a project keeps it: the script and its parameters, plus the input snapshots it reads. */
export interface CodeDesign {script: string; parameters: string; inputs?: string; step?: string;
  /** The selected run's receipt (cad/1 `cad-result.json`): its validation, kept with the design so it is never rebuilt to know it. */
  result?: string}
/** A Fusion design, as a project keeps it. */
export interface FusionDesign {f3d: string; parameters?: string}
export type DesignSource = FusionDesign | CodeDesign;
export const isCodeDesign = (design: DesignSource | undefined): design is CodeDesign => !!design && 'script' in design;

/** The folder in a pass where every cad_run leaves its own run folder (the worker's `output_dir`). */
export const passCadDir = (pass: Pick<TouchupPass, 'dir'>) => join(pass.dir, 'cad');
/** Where a change to a code design gets its copy of the saved design. */
export const passDesignDir = (pass: Pick<TouchupPass, 'dir'>) => join(pass.dir, 'design');

export type CodeEngineState = 'ready' | 'not-set-up' | 'absent';

/**
 * How long Counterpart waits for `cad_status`, wherever it reads it: a pass choosing its engine and the Settings row.
 * After an MCP update that changed the engine, the first `cad_status` re-runs the engine's confined round trip itself
 * (bambu-printer-mcp 1.1.90, mcp-3D-printer-server 1.2.72: 14–22 s measured, waiting at most 25 s for a busy engine),
 * and a caller that gives up cancels it. At 15 s the pass gave up first and fell back to Blender, saying the engine
 * "isn't set up" (#609).
 */
export const CAD_STATUS_TIMEOUT_MS = 30_000;
type Client = Pick<PrinterMcpClient, 'hasTool' | 'callTool'>;

/**
 * Whether the printer MCP's code engine can run this pass, from its own structured answers only: it lists the
 * `cad/1` tools, and `cad_status` says `ready` (never its wording, package or version).
 */
export async function codeEngineState(client: Client, signal?: AbortSignal): Promise<CodeEngineState> {
  if (!client.hasTool('cad_status') || !client.hasTool('cad_run')) return 'absent';
  try {
    const reply = await client.callTool('cad_status', {}, {...(signal ? {signal} : {}), timeoutMs: CAD_STATUS_TIMEOUT_MS});
    if (reply.isError) return 'not-set-up';
    return toolResultJson<{ready?: unknown}>(reply).ready === true ? 'ready' : 'not-set-up';
  } catch (error) {
    if (signal?.aborted) throw error;
    return 'not-set-up';
  }
}

/** The pass's note when the code engine is in the printer MCP but not set up. */
export function codeEngineNotSetUp(engine: 'blender' | 'fusion'): string {
  return `This pass used ${engine === 'fusion' ? 'Fusion' : 'Blender'} because the code design engine isn't set up. Set it up in Settings for faster designs and cleanups.`;
}

/** The pass's note when the capture couldn't be converted into a mesh the code engine reads. */
export function codeEngineUnreadableScan(engine: 'blender' | 'fusion'): string {
  return `The code design engine couldn't read this scan, so this pass used ${engine === 'fusion' ? 'Fusion' : 'Blender'}.`;
}

async function isFile(path: string): Promise<boolean> { return stat(path).then(info => info.isFile(), () => false); }

/**
 * Copies a code design into `toDir` as `touched.*`, with its input snapshots in `toDir/inputs`, and rewrites the
 * inputs list (alias → file, as the MCP writes it beside the script) to point at the copies. The source is never
 * written to. Returns the copy.
 */
export async function copyDesign(from: CodeDesign, toDir: string): Promise<CodeDesign> {
  await mkdir(toDir, {recursive: true});
  // The saved files keep the extensions the MCP gave them; only their stem is Counterpart's.
  const script = join(toDir, `touched${extname(from.script)}`), parameters = join(toDir, 'touched.parameters.json');
  await copyFile(from.script, script);
  await copyFile(from.parameters, parameters);
  const copy: CodeDesign = {script, parameters};
  if (from.step && await isFile(from.step)) { copy.step = join(toDir, `touched${extname(from.step)}`); await copyFile(from.step, copy.step); }
  if (from.result && await isFile(from.result)) { copy.result = join(toDir, 'touched.result.json'); await copyFile(from.result, copy.result); }
  if (from.inputs && await isFile(from.inputs)) {
    const listed = JSON.parse(await readFile(from.inputs, 'utf8')) as Record<string, unknown>;
    const manifest: Record<string, string> = {};
    await mkdir(join(toDir, 'inputs'), {recursive: true});
    for (const [alias, path] of Object.entries(listed)) {
      if (typeof path !== 'string') continue;
      // A snapshot's own file name is kept: a mesh's material and texture files find each other by name.
      const source = await isFile(path) ? path : join(dirname(from.inputs), 'inputs', basename(path));
      const target = join(toDir, 'inputs', basename(path));
      if (resolve(source) !== resolve(target)) await copyFile(source, target);
      manifest[alias] = target;
    }
    copy.inputs = join(toDir, 'touched.inputs.json');
    await writeFile(copy.inputs, JSON.stringify(manifest, null, 2));
  }
  return copy;
}

/** A valid STL: every triangle complete and finite. Shared with the runner's own check. */
type StlCheck = (path: string) => Promise<boolean>;

/**
 * One run's receipt, as the MCP writes it to `cad-result.json` in each immediate `cad-*` run folder (cad/1): protected
 * from the script, it records whether the run completed, whether the worker selected it (`final`), when, and the full
 * validation and artifact paths, so it is read from disk once the worker ends, without building again.
 */
interface CadReceipt {
  status?: unknown; final?: unknown; completed_at?: unknown; valid?: unknown;
  stl?: unknown; step?: unknown; script?: unknown; parameters?: unknown; input_manifest?: unknown; renders?: unknown;
  /** Engine round 4 (#608), optional: why `final: true` was not recorded, each as the step that fixes it. */
  final_refused?: unknown;
  /** Engine round 4, optional: what the part is for, compiled into requirements (`pass`, `fail`, `not_modelled`). */
  purpose?: unknown;
}
interface CadRun {dir: string; receipt: CadReceipt; manifest: string; stl: string; script: string; parameters: string; completedAt: string}

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
/** A receipt's own artifact path, only when it is inside its run folder. */
const inside = (dir: string, value: unknown) => {
  const path = text(value);
  return path && (resolve(path) === resolve(dir) || resolve(path).startsWith(resolve(dir) + '/')) ? path : undefined;
};

/**
 * The runs that completed with valid geometry, a complete STL and their own script and parameters, oldest first:
 * every immediate `cad-*` folder of the pass's design folder whose `cad-result.json` says so. `final` is the worker's
 * selection among them (round 4: recorded only when the engine found the design ready).
 */
async function validRuns(cadDir: string, validStl: StlCheck): Promise<CadRun[]> {
  let folders: string[];
  try { folders = (await readdir(cadDir, {withFileTypes: true})).filter(entry => entry.isDirectory() && entry.name.startsWith('cad-')).map(entry => entry.name); }
  catch { return []; }
  const runs: CadRun[] = [];
  for (const folder of folders) {
    const dir = join(cadDir, folder), manifest = join(dir, 'cad-result.json');
    let receipt: CadReceipt;
    try { receipt = JSON.parse(await readFile(manifest, 'utf8')) as CadReceipt; } catch { continue; }
    // Final is the worker's selection, not proof: the run must also have completed, passed its checks and kept its STL.
    if (receipt.status !== 'completed' || receipt.valid !== true) continue;
    const stl = inside(dir, receipt.stl);
    if (!stl || !await validStl(stl)) continue;
    // The model and its design source come together: a run without its own script and parameters can't be selected.
    const script = inside(dir, receipt.script), parameters = inside(dir, receipt.parameters);
    if (!script || !parameters || !await isFile(script) || !await isFile(parameters)) continue;
    runs.push({dir, receipt, manifest, stl, script, parameters, completedAt: text(receipt.completed_at) ?? ''});
  }
  return runs.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.dir.localeCompare(b.dir));
}

/**
 * Files a code pass's runs the way every pass's results are kept, from the runs the worker marked final (cad/1's
 * `cad-result.json`): each becomes a checkpoint (`out/checkpoints/001.stl`, …), the latest becomes `out/touched.stl`
 * with its views as the pass's renders, and its script, parameters and receipt are the pass's design source. Runs
 * not marked final (measuring the scan, one colour's part) never become the model, so a pass that measures and then
 * asks, or stops before selecting a run, leaves the project's model alone. The one exception is `draft` (#788): a pass
 * the worker answered as done, with no final run, keeps its last valid run as a draft with the MCP's reasons. Reads only what is on disk, on any worker
 * ending; a companion stopped mid-pass doesn't collect that attempt, and the resumed attempt starts from its run folders.
 * Nothing the worker made is changed.
 */
export async function collectCodeRuns(pass: Pick<TouchupPass, 'dir' | 'outDir' | 'checkpointsDir'>, validStl: StlCheck,
  opts: {draft?: boolean} = {}): Promise<{design?: CodeDesign; draft?: CodeDraft}> {
  const valid = await validRuns(passCadDir(pass), validStl);
  const selected = valid.filter(run => run.receipt.final === true);
  // #788: with no final run, a pass the worker answered as done keeps its last valid run as a draft, never nothing.
  const draft = !selected.length && opts.draft ? valid.at(-1) : undefined;
  const runs = draft ? [draft] : selected;
  const model = runs.at(-1);
  if (!model) return {};
  const inputs = text(model.receipt.input_manifest), step = inside(model.dir, model.receipt.step);
  const design: CodeDesign = {script: model.script, parameters: model.parameters, result: model.manifest,
    ...(inputs && await isFile(inputs) ? {inputs} : {}), ...(step && await isFile(step) ? {step} : {})};
  // The overall sheet first, then the single views: the rules ask for the clearest overall view to sort first.
  // A view the receipt names but that isn't there is left out; it never costs the model or its design.
  const renders = model.receipt.renders && typeof model.receipt.renders === 'object' ? model.receipt.renders as Record<string, unknown> : {};
  const views: {view: string; file: string}[] = [];
  for (const [view, path] of Object.entries(renders)) { const file = inside(model.dir, path); if (file && await isFile(file)) views.push({view, file}); }
  views.sort((a, b) => Number(b.view === 'contact') - Number(a.view === 'contact') || a.view.localeCompare(b.view));
  const touched = join(pass.outDir, 'touched.stl');
  try {
    await mkdir(pass.checkpointsDir, {recursive: true});
    for (const [index, run] of runs.entries()) await copyFile(run.stl, join(pass.checkpointsDir, `${String(index + 1).padStart(3, '0')}.stl`));
    for (const [index, {view, file}] of views.entries()) await copyFile(file, join(pass.outDir, `${index + 1}-${view}${extname(file) || '.png'}`));
    await copyFile(model.stl, touched);
  } catch (error) {
    // Nothing half-kept: without its design source the model is not offered either.
    await rm(touched, {force: true}).catch(() => undefined);
    throw error;
  }
  if (!draft) return {design};
  const reasons = draftReasons(draft.receipt);
  return {design, draft: reasons.length ? {reasons} : {}};
}

/**
 * A draft: the model of a pass that ended with no run the engine let the worker make final (#788). `reasons` are the
 * MCP's own words, as it wrote them; an MCP from before engine round 4 gives none.
 */
export interface CodeDraft {reasons?: string[]}
export const DRAFT_REASONS_MAX = 12, DRAFT_REASON_CHARS = 300;

/**
 * Why a run is a draft, in the MCP's words and never reworded or interpreted: its `final_refused` (round 4: each the
 * step that fixes it) when it has one, else what each purpose requirement that didn't pass says to do (`fix`, or what
 * it `says`). Anything not a string is left out.
 */
export function draftReasons(receipt: Pick<CadReceipt, 'final_refused' | 'purpose'>): string[] {
  const strings = (items: unknown[]) => items.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim());
  const refused = Array.isArray(receipt.final_refused) ? strings(receipt.final_refused) : [];
  const requirements = receipt.purpose && typeof receipt.purpose === 'object' ? (receipt.purpose as {requirements?: unknown}).requirements : undefined;
  const failing = refused.length || !Array.isArray(requirements) ? [] : strings(requirements.map(item => {
    const requirement = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof requirement.status !== 'string' || requirement.status === 'pass') return undefined;
    return typeof requirement.fix === 'string' && requirement.fix.trim() ? requirement.fix : requirement.says;
  }));
  return (refused.length ? refused : failing).slice(0, DRAFT_REASONS_MAX).map(reason => reason.slice(0, DRAFT_REASON_CHARS));
}
