import lane_isolation  # noqa: F401  (first: no test may reach the real build lane)
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'branch_check.py'


class BranchCheckTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); root = Path(self.folder.name)
        self.origin = root / 'origin.git'; self.work = root / 'work'
        env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
        self.env = env
        subprocess.run(['git', 'init', '-q', '--bare', '-b', 'main', str(self.origin)], check=True)
        subprocess.run(['git', 'clone', '-q', str(self.origin), str(self.work)], check=True, stderr=subprocess.DEVNULL)
        self.write('a.txt', 'one\ntwo\nthree\n'); self.write('b.txt', 'b\n'); self.commit('base'); self.git('push', '-q', 'origin', 'HEAD:main')

    def tearDown(self):
        self.folder.cleanup()

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.work, env=self.env, check=True, capture_output=True, text=True).stdout

    def write(self, name, text):
        (self.work / name).write_text(text)

    def commit(self, message):
        self.git('add', '-A'); self.git('commit', '-q', '-m', message)

    def branch(self, name, edits, base='origin/main'):
        self.git('fetch', '-q', 'origin'); self.git('checkout', '-q', '-B', name, base)
        for file, text in edits.items(): self.write(file, text)
        self.commit(name); self.git('push', '-q', '-f', 'origin', 'HEAD:' + name)

    def check(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=self.work, env=self.env, capture_output=True, text=True)
        return done.returncode, done.stdout

    def test_clean_current_branch_is_safe(self):
        self.branch('feature', {'b.txt': 'b changed\n'})
        code, out = self.check('--merge', 'feature')
        self.assertEqual(code, 0, out); self.assertIn('SAFE to merge feature', out)

    def test_branch_behind_main_must_rebase(self):
        self.branch('feature', {'b.txt': 'b changed\n'})
        self.branch('main', {'c.txt': 'new on main\n'})  # main moves on
        code, out = self.check('--merge', 'feature')
        self.assertEqual(code, 1); self.assertIn('1 commits behind main', out)

    def test_two_active_branches_that_conflict_need_an_order(self):
        self.branch('left', {'a.txt': 'one\nLEFT\nthree\n'})
        self.branch('right', {'a.txt': 'one\nRIGHT\nthree\n'})
        code, out = self.check('--merge', 'left')
        self.assertEqual(code, 1); self.assertIn('conflicts with right in a.txt', out)

    def test_a_stated_order_lets_the_first_branch_land_and_says_so(self):
        self.branch('left', {'a.txt': 'one\nLEFT\nthree\n'})
        self.branch('right', {'a.txt': 'one\nRIGHT\nthree\n'})
        code, out = self.check('--merge', 'left', '--lands-first', 'right rebases, its owner knows')
        self.assertEqual(code, 0, out)
        self.assertIn('conflicts with right in a.txt: this branch lands first (right rebases, its owner knows); right rebases on it', out)
        # The order excuses nothing else: a branch behind main still has to rebase.
        self.git('checkout', '-q', '-B', 'main', 'origin/main'); self.write('z.txt', 'z\n'); self.commit('main moves')
        self.git('push', '-q', 'origin', 'HEAD:main')
        code, out = self.check('--merge', 'left', '--lands-first', 'right rebases, its owner knows')
        self.assertEqual(code, 1); self.assertIn('behind main', out)

    def test_shared_file_without_conflict_is_only_a_warning(self):
        self.branch('top', {'a.txt': 'ONE\ntwo\nthree\n'})
        self.branch('bottom', {'a.txt': 'one\ntwo\nTHREE\n'})
        code, out = self.check('--merge', 'top')
        self.assertEqual(code, 0, out); self.assertIn('warning: shares a.txt with bottom', out)

    def test_stacked_branches_land_in_order_not_as_a_conflict(self):
        self.branch('base-work', {'a.txt': 'one\nBASE\nthree\n'})
        self.branch('stacked', {'a.txt': 'one\nSTACKED\nthree\n'}, base='base-work')
        code, out = self.check('--merge', 'base-work')
        self.assertEqual(code, 0, out); self.assertIn('stacked is stacked on this branch: it lands after it', out)
        code, out = self.check('--merge', 'stacked')
        self.assertEqual(code, 1); self.assertIn('stacked on base-work: merge base-work first', out)
        self.assertNotIn('conflicts with', out)

    def test_a_train_carries_finished_branches_instead_of_waiting_behind_them(self):
        self.branch('one', {'a.txt': 'one\nONE\nthree\n'})
        self.branch('two', {'b.txt': 'b from two\n'})
        self.git('fetch', '-q', 'origin'); self.git('checkout', '-q', '-B', 'train/2026-11-09', 'origin/main')
        self.git('merge', '-q', '--no-ff', '-m', 'one', 'origin/one'); self.git('merge', '-q', '--no-ff', '-m', 'two', 'origin/two')
        self.git('push', '-q', '-f', 'origin', 'HEAD:train/2026-11-09')
        code, out = self.check('--merge', 'train/2026-11-09')
        self.assertEqual(code, 0, out); self.assertIn('carries one, two: they land with this train', out)
        self.assertNotIn('stacked on', out)
        # Any other branch that contains unmerged work is still stacked, not a train.
        self.branch('not-a-train', {'c.txt': 'c\n'}, base='origin/one')
        code, out = self.check('--merge', 'not-a-train')
        self.assertEqual(code, 1); self.assertIn('stacked on one: merge one first', out)

    def test_squash_merged_branch_is_not_live(self):
        self.branch('done', {'b.txt': 'b changed\n'})
        self.git('checkout', '-q', '-B', 'main', 'origin/main'); self.write('b.txt', 'b changed\n'); self.commit('squash of done')
        self.git('push', '-q', 'origin', 'HEAD:main')
        code, out = self.check()
        self.assertEqual(code, 0); self.assertNotIn('done ', out)
        self.assertEqual(self.check('--merge', 'done')[0], 1)


if __name__ == '__main__':
    unittest.main()
