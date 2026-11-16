"""#856: the Linux packages' Python is pinned in apps/mac/distribution.json's linux side and audited."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
MANIFEST = REPO / 'apps/mac/distribution.json'
HOST = REPO / 'tools/linux-host'
spec = importlib.util.spec_from_file_location('prepare_python', HOST / 'prepare-python.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class BundledPythonTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads(MANIFEST.read_text())

    def test_x86_64_pins_the_macs_releases_as_linux_builds(self):
        _, python, packages = prepare.linux_side(self.manifest, 'x86_64')
        self.assertEqual(python['version'], '3.12.16+20261026')
        self.assertIn('x86_64-unknown-linux-gnu-install_only', python['downloadUrl'])
        self.assertEqual({p['pythonPackage']: p['version'] for p in packages}, {'pillow': '13.0.0', 'usd-core': '26.8'})
        for component in [python, *packages]:
            self.assertRegex(component['sha256'], r'^[0-9a-f]{64}$')
            self.assertTrue(component['downloadUrl'].startswith('https://'))
            self.assertNotIn('macos', component['downloadUrl'])
            self.assertNotIn('apple-darwin', component['downloadUrl'])

    def test_an_architecture_without_a_usd_core_wheel_stops_with_the_reason(self):
        with self.assertRaises(SystemExit) as stopped:
            prepare.linux_side(self.manifest, 'aarch64')
        self.assertIn('usd-core', str(stopped.exception))

    def test_every_shipped_notice_is_retained_with_its_pinned_hash(self):
        linux = self.manifest['linux']
        components = {c['name']: c for c in self.manifest['components']}
        names = [linux['python']['component'], *(p['component'] for p in linux['pythonPackages'])]
        for name in names:
            for notice in components[name]['notices']:
                if notice['path'] in linux['python']['omittedNotices']:
                    continue
                path = REPO / 'apps/mac' / notice['path']
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), notice['sha256'], notice['path'])

    def test_what_the_companion_never_uses_is_removed(self):
        removed = self.manifest['linux']['python']['removed']['paths']
        for pattern in ['bin/pip*', 'lib/python3.12/ensurepip', 'lib/python3.12/lib-dynload/_dbm.*',
                        'lib/python3.12/lib-dynload/_tkinter.*', 'lib/python3.12/site-packages/pip']:
            self.assertIn(pattern, removed)

    def test_the_audit_refuses_an_unapproved_site_package(self):
        with tempfile.TemporaryDirectory() as folder:
            site = Path(folder) / 'lib/python3.12/site-packages'
            (site / 'requests').mkdir(parents=True)
            done = subprocess.run([sys.executable, HOST / 'check-python.py', MANIFEST, folder], capture_output=True, text=True)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('Unapproved bundled Python files: requests', done.stderr)


if __name__ == '__main__':
    unittest.main()
