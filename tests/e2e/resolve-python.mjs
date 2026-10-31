/** Resolve CAPTURE_TEST_PYTHON for e2e (sandbox.py execv needs an absolute interpreter). */
import { execFileSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const RESOLVE_HINT =
  'Set CAPTURE_TEST_PYTHON to an absolute path, or install python3 on PATH. ' +
  'tools/scan-correct/sandbox.py uses os.execv and cannot resolve bare interpreter names.';

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveCaptureTestPython({ env = process.env } = {}) {
  const explicit = env.CAPTURE_TEST_PYTHON?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(`CAPTURE_TEST_PYTHON must be an absolute path, got: ${explicit}`);
    }
    try {
      accessSync(explicit);
    } catch {
      throw new Error(`CAPTURE_TEST_PYTHON is not executable or missing: ${explicit}`);
    }
    return explicit;
  }

  for (const shellCmd of ['command -v python3', 'which python3']) {
    try {
      const candidate = execFileSync('bash', ['-lc', shellCmd], {
        encoding: 'utf8',
        env,
      }).trim();
      if (candidate && isAbsolute(candidate)) {
        accessSync(candidate);
        return candidate;
      }
    } catch {
      /* try next resolver */
    }
  }

  throw new Error(`Could not resolve a Python interpreter for e2e tests. ${RESOLVE_HINT}`);
}

export const python = resolveCaptureTestPython();
