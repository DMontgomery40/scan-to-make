import {existsSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {parseEnv} from 'node:util';

/** Only the signed helper supplies this state directory. Read the independently installed
 * worker paths without importing companion credentials or changing the saved AI destination. */
export function installedModelWorkerTools(state: string): NodeJS.ProcessEnv {
  if (!isAbsolute(state)) throw new Error('Model worker state must be absolute');
  const migration = join(state, 'app-migration.json'), configuration = join(state, 'companion.env');
  const legacy = existsSync(migration) ? JSON.parse(readFileSync(migration, 'utf8')).workerEnvironment ?? {} : {};
  const saved = existsSync(configuration) ? parseEnv(readFileSync(configuration, 'utf8')) : {};
  const paths = {...legacy, ...saved}, env: NodeJS.ProcessEnv = {};
  for (const key of ['SCAN_TO_MAKE_CAPTURE_PYTHON', 'SCAN_TO_MAKE_SCAN_BLENDER', 'SCAN_TO_MAKE_AI_JUDGE_TOOL']) {
    const value = paths[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Independent worker paths must be absolute');
    env[key] = value;
  }
  // Legacy installations predate the explicit judge setting; retain their own adjacent tool.
  if (!env.SCAN_TO_MAKE_AI_JUDGE_TOOL && typeof paths.SCAN_TO_MAKE_SCAN_REPAIR_TOOL === 'string' && isAbsolute(paths.SCAN_TO_MAKE_SCAN_REPAIR_TOOL)) {
    const judge = resolve(dirname(paths.SCAN_TO_MAKE_SCAN_REPAIR_TOOL), '../ai-tweak-judge');
    if (existsSync(judge)) env.SCAN_TO_MAKE_AI_JUDGE_TOOL = judge;
  }
  return env;
}
