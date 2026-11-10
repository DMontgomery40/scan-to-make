"""No test process may see the real build lane as its lane (see lane_isolation.py)."""
import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
LANE = HERE.parent / 'lane.py'


def lane_module():
    spec = importlib.util.spec_from_file_location('stm_lane_isolation_probe', LANE)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class LaneIsolationTests(unittest.TestCase):
    def assert_isolated(self, paths, who):
        real = lane_isolation.real_lane_paths()
        for path in paths:
            self.assertNotIn(Path(path), real, who + ' would use the real build lane: ' + str(path))
            self.assertTrue(Path(path).is_relative_to(lane_isolation.FOLDER), who + ': ' + str(path))

    def test_this_test_process_uses_a_temporary_lane(self):
        slots, state = lane_module().paths()
        self.assert_isolated([*slots, state], 'the test process')

    def test_a_subprocess_started_from_this_environment_uses_the_temporary_lane(self):
        # What a script run by a test (prepare-testflight.sh, install-iphone.sh, ci_local.py) would see.
        # The child only resolves the paths; it takes and probes no lock, so a failure here never touches the real lane.
        child = ('import importlib.util, json, sys\n'
                 'spec = importlib.util.spec_from_file_location("lane", sys.argv[1]); lane = importlib.util.module_from_spec(spec)\n'
                 'spec.loader.exec_module(lane); slots, state = lane.paths(); print(json.dumps([*map(str, slots), str(state)]))')
        done = subprocess.run([sys.executable, '-c', child, str(LANE)], env=dict(os.environ), capture_output=True, text=True, check=True)
        self.assert_isolated(json.loads(done.stdout), 'a child process')

    def test_every_test_module_imports_lane_isolation_before_anything_else(self):
        for path in sorted(HERE.glob('test_*.py')):
            with self.subTest(path.name):
                body = [node for node in ast.parse(path.read_text()).body
                        if not (isinstance(node, ast.Expr) and isinstance(getattr(node, 'value', None), ast.Constant))]
                first = body[0]
                self.assertTrue(isinstance(first, ast.Import) and [a.name for a in first.names] == ['lane_isolation'],
                                path.name + ' must start with `import lane_isolation`')


if __name__ == '__main__':
    unittest.main()
