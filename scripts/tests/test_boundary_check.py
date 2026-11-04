"""PRD §8.0 boundary check: which files it sends, how it decides, and that it fails closed. No network."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import boundary_check as b  # noqa: E402


class BoundaryCheckTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.work = Path(self.folder.name)
        self.env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
        self.git('init', '-q', '-b', 'main'); self.write('README.md', 'x\n'); self.commit('base')
        self.cwd = os.getcwd(); os.chdir(self.work)

    def tearDown(self):
        os.chdir(self.cwd); self.folder.cleanup()

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.work, env=self.env, check=True, capture_output=True)

    def write(self, path, text):
        (self.work / path).parent.mkdir(parents=True, exist_ok=True); (self.work / path).write_text(text)

    def commit(self, message):
        self.git('add', '-A'); self.git('commit', '-q', '-m', message)

    def run_check(self, answer):
        asked, lines = [], []
        def post(body):
            asked.append(body)
            return answer(body) if callable(answer) else answer
        return b.check('main', 'HEAD', post=post, out=lines.append), asked, lines

    def test_only_added_app_code_is_sent_never_tests_docs_or_fixtures(self):
        self.git('checkout', '-q', '-b', 'feature')
        self.write('services/companion/src/printing/new.ts', "export const LAYER = {draft: 0.28};\n")
        self.write('services/companion/tests/new.test.mjs', "assert.equal(1, 1);\n")
        self.write('docs/x.md', 'prose\n'); self.write('apps/mobile/ios/ScanToMake/App/Fixtures.swift', 'let x = 1\n')
        self.commit('feature')
        code, asked, _ = self.run_check(0.1)
        self.assertEqual(code, 0)
        self.assertEqual([q['state']['file'] for q in asked], ['services/companion/src/printing/new.ts'])
        self.assertIn('draft: 0.28', asked[0]['state']['added_code'])
        self.assertEqual(asked[0]['questions']['backend_knowledge']['type'], 'noul')
        self.assertEqual(set(asked[0]['questions']['backend_knowledge']['criteria']), {'true', 'false'})

    def test_a_flagged_chunk_fails_and_names_the_file(self):
        self.git('checkout', '-q', '-b', 'feature'); self.write('services/printer-handoff/src/x.ts', "if (backend === 'bambu-printer-mcp') {}\n"); self.commit('f')
        code, _, lines = self.run_check(0.93)
        self.assertEqual(code, 1)
        self.assertIn('services/printer-handoff/src/x.ts (p=0.93)', lines[0])

    def test_no_app_code_means_no_question(self):
        self.git('checkout', '-q', '-b', 'feature'); self.write('docs/y.md', 'prose\n'); self.commit('f')
        code, asked, _ = self.run_check(0.99)
        self.assertEqual((code, asked), (0, []))

    def test_an_unreachable_or_unpaid_checker_fails_closed_with_its_reason(self):
        self.git('checkout', '-q', '-b', 'feature')
        for i in range(3): self.write(f'apps/linux/src/f{i}.ts', f'export const v{i} = {i};\n')
        self.commit('f')
        def unpaid(_body):
            raise urllib.error.HTTPError('u', 402, 'Payment Required', {}, io.BytesIO(json.dumps(
                {'detail': {'error_type': 'billing_error', 'message': 'Your organization has no available TypeSafe API credits.'}}).encode()))
        code, asked, lines = self.run_check(unpaid)
        self.assertEqual(code, 1)
        self.assertEqual(len(asked), 1, 'a billing refusal is the same for every chunk: ask once')
        self.assertIn('NOT CHECKED', lines[0]); self.assertIn('HTTP 402', lines[0]); self.assertIn('no available TypeSafe API credits', lines[0])

    def test_large_additions_are_split_into_bounded_chunks(self):
        self.git('checkout', '-q', '-b', 'feature')
        self.write('services/companion/src/big.ts', ''.join(f'export const v{i} = "{"x" * 80}";\n' for i in range(200))); self.commit('f')
        _, asked, _ = self.run_check(0.0)
        self.assertGreater(len(asked), 1)
        self.assertTrue(all(len(q['state']['added_code']) <= b.CHUNK_CHARS for q in asked))


if __name__ == '__main__':
    unittest.main()
