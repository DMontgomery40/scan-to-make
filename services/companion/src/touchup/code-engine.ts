import {copyFile, mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {toolResultJson, type PrinterMcpClient} from '@scan-to-make/printer-handoff';
import type {TouchupPass} from './inputs.js';

/**
 * Counterpart's side of the printer MCP's code design engine (`cad/1`, PRD §8.9). The MCP owns the engine, its
 * Python, how a script looks and how it is checked; Counterpart only asks whether it is there and ready, gives a
 * pass somewhere to keep its runs, and keeps the script and parameters as the project's design source.
 */

/** A code design, as a project keeps it: the script and its parameters, plus the input snapshots it reads. */
export interface CodeDesign {script: string; parameters: string; inputs?: string; step?: string}
/** A Fusion design, as a project keeps it. */
export interface FusionDesign {f3d: string; parameters?: string}
export type DesignSource = FusionDesign | CodeDesign;
export const isCodeDesign = (design: DesignSource | undefined): design is CodeDesign => !!design && 'script' in design;

/** The folder in a pass where every cad_run leaves its own run folder (the worker's `output_dir`). */
export const passCadDir = (pass: Pick<TouchupPass, 'dir'>) => join(pass.dir, 'cad');
/** Where a change to a code design gets its copy of the saved design. */
export const passDesignDir = (pass: Pick<TouchupPass, 'dir'>) => join(pass.dir, 'design');

export type CodeEngineState = 'ready' | 'not-set-up' | 'absent';
type Client = Pick<PrinterMcpClient, 'hasTool' | 'callTool'>;

/**
 * Whether the printer MCP's code engine can run this pass, from its own structured answers only: it lists the
 * `cad/1` tools, and `cad_status` says `ready` (never its wording, package or version).
 */
export async function codeEngineState(client: Client, signal?: AbortSignal): Promise<CodeEngineState> {
  if (!client.hasTool('cad_status') || !client.hasTool('cad_run')) return 'absent';
  try {
    const reply = await client.callTool('cad_status', {}, {...(signal ? {signal} : {}), timeoutMs: 15_000});
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
  const script = join(toDir, 'touched.py'), parameters = join(toDir, 'touched.parameters.json');
  await copyFile(from.script, script);
  await copyFile(from.parameters, parameters);
  const copy: CodeDesign = {script, parameters};
  if (from.step && await isFile(from.step)) { copy.step = join(toDir, 'touched.step'); await copyFile(from.step, copy.step); }
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

interface CadRun {dir: string; name: string; at: number; stl?: string}

/** Every cad_run folder under the pass's design folder that holds a script, oldest first. */
async function cadRuns(cadDir: string, validStl: StlCheck): Promise<CadRun[]> {
  let folders: string[];
  try { folders = (await readdir(cadDir, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
  const runs: CadRun[] = [];
  for (const folder of folders) {
    const dir = join(cadDir, folder);
    // The MCP saves <name>.py and <name>.parameters.json before running, and its STL after.
    const scripts = (await readdir(dir)).filter(name => name.endsWith('.py'));
    if (scripts.length !== 1) continue;
    const name = scripts[0]!.slice(0, -3);
    if (!await isFile(join(dir, `${name}.parameters.json`))) continue;
    const at = (await stat(join(dir, scripts[0]!))).mtimeMs;
    const stl = join(dir, `${name}.stl`);
    runs.push({dir, name, at, ...(await validStl(stl) ? {stl} : {})});
  }
  return runs.sort((a, b) => a.at - b.at || a.dir.localeCompare(b.dir));
}

async function pngs(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
    if (entry.name === 'inputs') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await pngs(path));
    else if (entry.name.toLowerCase().endsWith('.png')) found.push(path);
  }
  return found;
}

/**
 * Files a code pass's runs the way every pass's results are kept: each run with a model becomes a checkpoint
 * (`out/checkpoints/001.stl`, …), the last run named "touched" (or, if the pass stopped before one, the last run
 * with a model) becomes `out/touched.stl` and its views the pass's renders, and its script and parameters are
 * the pass's design source. Runs on any ending, a limit or a crash included. Nothing the worker made is changed.
 */
export async function collectCodeRuns(pass: Pick<TouchupPass, 'dir' | 'outDir' | 'checkpointsDir'>, validStl: StlCheck): Promise<{design?: CodeDesign}> {
  const runs = await cadRuns(passCadDir(pass), validStl);
  const built = runs.filter(run => run.stl);
  await mkdir(pass.checkpointsDir, {recursive: true});
  for (const [index, run] of built.entries()) await copyFile(run.stl!, join(pass.checkpointsDir, `${String(index + 1).padStart(3, '0')}.stl`));
  const final = built.filter(run => run.name === 'touched').at(-1);
  if (final) {
    await copyFile(final.stl!, join(pass.outDir, 'touched.stl'));
    // The overall sheet first, then the single views: the rules ask for the clearest overall view to sort first.
    const views = (await pngs(final.dir)).sort((a, b) => Number(basename(b) === 'contact.png') - Number(basename(a) === 'contact.png') || basename(a).localeCompare(basename(b)));
    for (const [index, view] of views.entries()) await copyFile(view, join(pass.outDir, `${index + 1}-${basename(view)}`));
  }
  const source = final ?? built.at(-1);
  if (!source) return {};
  const at = (suffix: string) => join(source.dir, `${source.name}${suffix}`);
  return {design: {script: at('.py'), parameters: at('.parameters.json'),
    ...(await isFile(at('.inputs.json')) ? {inputs: at('.inputs.json')} : {}), ...(await isFile(at('.step')) ? {step: at('.step')} : {})}};
}
