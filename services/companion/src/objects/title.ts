import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {isolatedClaudeEnv} from '../touchup/invocation.js';

const SCHEMA = {type: 'object', additionalProperties: false, required: ['title'],
  properties: {title: {type: 'string', maxLength: 40, description: 'Two to four words naming the thing, like "Mic mount"'}}};

/**
 * A short title for a request ("Mic mount"), from the user's own Claude login
 * with the same model as the plate judge. Best effort: undefined on any failure.
 */
export async function generateTitle(request: string, claudePath: string, opts: {timeoutMs?: number; photo?: string} = {}): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'stm-title-'));
  try {
    // PRD §5.4: from whatever there is: the request, or the first photo when there is no request.
    const about = request.trim() ? `Request:\n\n${request.slice(0, 2000)}` : `Look at the photo ${opts.photo} and name the object in it.`;
    const prompt = `Name the thing this is for in two to four plain words, title case only on the first word (for example "Mic mount" or "Shelf bracket"). ${about}`;
    const {stdout} = await promisify(execFile)(claudePath, ['-p', '--model', 'claude-sonnet-5-5', '--tools', opts.photo && !request.trim() ? 'Read' : '',
      ...(opts.photo && !request.trim() ? ['--allowedTools', 'Read'] : []), '--strict-mcp-config', '--disable-slash-commands',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--json-schema', JSON.stringify(SCHEMA), '--output-format', 'json', prompt],
      {cwd: dir, env: isolatedClaudeEnv(process.env), timeout: opts.timeoutMs ?? 45_000, maxBuffer: 1024 * 1024});
    const title = (JSON.parse(stdout) as {structured_output?: {title?: unknown}}).structured_output?.title;
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 40) : undefined;
  } catch { return undefined; }
  finally { await rm(dir, {recursive: true, force: true}).catch(() => undefined); }
}
