import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

GUARD = Path(__file__).resolve().parents[1] / 'test-with-temp-guard.mjs'
NODE = shutil.which('node')

CLEAN = """
import test from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('removes its temp folder', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-clean-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
});
"""

LEAKING = """
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('leaves its temp folder behind', async () => {
  await mkdtemp(join(tmpdir(), 'guard-leak-'));
});
"""

FAILING = """
import test from 'node:test';
import assert from 'node:assert/strict';
test('fails without leaking', () => { assert.equal(1, 2); });
"""


@unittest.skipUnless(NODE, 'node is not installed')
class TempGuardTests(unittest.TestCase):
    def run_guard(self, source):
        with tempfile.TemporaryDirectory() as directory:
            case = Path(directory) / 'case.test.mjs'
            case.write_text(source)
            return subprocess.run([NODE, str(GUARD), str(case)],
                                  text=True, capture_output=True, timeout=120)

    def test_clean_suite_passes(self):
        result = self.run_guard(CLEAN)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_leaking_suite_fails_and_names_the_leftover(self):
        result = self.run_guard(LEAKING)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('guard-leak-', result.stderr)

    def test_failing_suite_keeps_its_failure(self):
        result = self.run_guard(FAILING)
        self.assertNotEqual(result.returncode, 0, result.stdout)


if __name__ == '__main__':
    unittest.main()
