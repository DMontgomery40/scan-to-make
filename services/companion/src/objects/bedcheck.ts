import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {isolatedClaudeEnv} from '../touchup/invocation.js';

export interface PlateVerdict {clear: boolean; item?: string}
const SCHEMA = {type: 'object', additionalProperties: false, required: ['clear'],
  properties: {clear: {type: 'boolean'}, item: {type: 'string', description: "What is on the plate, in a few words starting with a or an"}}};

/**
 * Asks the user's own Claude whether anything is on the printer's build plate in a camera photo.
 * Printer parts, the plate's own texture, reflections, glue and lighting never count.
 */
export async function judgePlate(photoBase64: string, claudePath: string, opts: {timeoutMs?: number} = {}): Promise<PlateVerdict> {
  const dir = await mkdtemp(join(tmpdir(), 'stm-plate-'));
  try {
    const photo = join(dir, 'plate.jpg');
    await writeFile(photo, Buffer.from(photoBase64, 'base64'));
    const prompt = `Look at the photo at ${photo}. It shows the build plate of a 3D printer just before a print. Is anything lying on the plate's printing surface that would get in the way of the print? Printer parts, the plate's own texture and markings, reflections, glue and lighting don't count. Set clear to true if nothing is on it; otherwise set clear to false and say what is there in a few words, starting with "a" or "an" (for example "a printed part").`;
    const {stdout} = await promisify(execFile)(claudePath, ['-p', '--model', 'claude-sonnet-5-5', '--tools', 'Read', '--allowedTools', 'Read',
      '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
      '--json-schema', JSON.stringify(SCHEMA), '--output-format', 'json', prompt],
      {cwd: dir, env: isolatedClaudeEnv(process.env), timeout: opts.timeoutMs ?? 90000, maxBuffer: 4 * 1024 * 1024});
    const verdict = (JSON.parse(stdout) as {structured_output?: PlateVerdict}).structured_output;
    if (!verdict || typeof verdict.clear !== 'boolean') throw new Error('The bed check gave no answer');
    return verdict;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}
