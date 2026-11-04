"""Exercise the independent source install and its actual Node environment contract."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install-workers.py')
spec = importlib.util.spec_from_file_location('workers', SCRIPT) if SCRIPT.exists() else None
workers = importlib.util.module_from_spec(spec) if spec else None
if workers:
    spec.loader.exec_module(workers)


class WorkerInstallationTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(workers, 'Independent cleanup worker installer is missing')

    def test_source_install_uses_committed_bytes_and_keeps_licenses(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            repo.mkdir()
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            for folder in workers.SOURCE_PATHS:
                path = repo / folder
                path.mkdir(parents=True)
                (path / 'LICENSE').write_text('original source license\n')
                (path / 'example.py').write_text('committed bytes\n')
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Worker Test',
                            '-c', 'user.email=worker@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            revision = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            (repo / 'tools/scan-repair/example.py').write_text('dirty bytes\n')
            (repo / 'tools/scan-repair/private.env').write_text('must never be copied\n')
            destination = root / 'workers'
            destination.mkdir()
            workers.extract_source(repo, revision, destination)
            self.assertEqual((destination / 'tools/scan-repair/example.py').read_text(), 'committed bytes\n')
            self.assertEqual((destination / 'tools/scan-correct/LICENSE').read_text(), 'original source license\n')
            self.assertFalse((destination / 'tools/scan-repair/private.env').exists())
            self.assertTrue((destination / 'source.tar').is_file())

    def test_attachment_preserves_credentials_and_node_reads_paths_with_quotes(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required to exercise the companion env-file contract')
        with tempfile.TemporaryDirectory(prefix="worker's $ paths ") as directory:
            env_file = Path(directory) / 'companion.env'
            original = b'# retained\nBAMBU_TOKEN="synthetic $ literal"\nSCAN_TO_MAKE_CAPTURE_PYTHON=/old/python\n'
            env_file.write_bytes(original)
            paths = {
                'SCAN_TO_MAKE_CAPTURE_PYTHON': str(Path(directory) / '.venv/bin/python3'),
                'SCAN_TO_MAKE_SCAN_REPAIR_TOOL': str(Path(directory) / 'repair.py'),
            }
            workers.attach_environment(env_file, paths)
            self.assertTrue(env_file.read_bytes().startswith(original))
            self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
            script = 'process.loadEnvFile(process.argv[1]); console.log(JSON.stringify({python:process.env.SCAN_TO_MAKE_CAPTURE_PYTHON,token:process.env.BAMBU_TOKEN}))'
            env = {k: v for k, v in os.environ.items() if k not in paths and k != 'BAMBU_TOKEN'}
            result = subprocess.run([node, '-e', script, str(env_file)], capture_output=True, text=True, check=True, env=env)
            values = json.loads(result.stdout)
            self.assertEqual(values['python'], str(Path(directory) / '.venv/bin/python3'))
            self.assertEqual(values['token'], 'synthetic $ literal')

    def test_incomplete_multiline_env_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / 'companion.env'
            original = b'PRIVATE_KEY="unfinished\n'
            env_file.write_bytes(original)
            with self.assertRaisesRegex(ValueError, 'quote'):
                workers.attach_environment(env_file, {'SCAN_TO_MAKE_CAPTURE_PYTHON': '/python'})
            self.assertEqual(env_file.read_bytes(), original)

    def test_symlinked_environment_and_app_bundle_destination_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'real.env'
            target.write_text('preserved\n')
            link = root / 'companion.env'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                workers.attach_environment(link, {'SCAN_TO_MAKE_CAPTURE_PYTHON': '/python'})
            self.assertEqual(target.read_text(), 'preserved\n')
            with self.assertRaisesRegex(ValueError, 'app bundle'):
                workers.validate_destination(root / 'Counterpart.app/Contents/Workers')


if __name__ == '__main__':
    unittest.main()
