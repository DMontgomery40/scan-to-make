# SPDX-License-Identifier: MIT
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit import run_audit
from inventory import detect_app_gpl_tool_imports
from mac_distribution import MANIFEST, NOTICES, inventory_mac, render_notices, verify_payload


class MacDistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.mac = self.root / 'apps/mac'
        (self.mac / 'Licenses').mkdir(parents=True)
        notice = self.mac / 'Licenses/Test.txt'
        notice.write_text('Copyright test fixture. MIT licence.\n')
        self.manifest = json.loads((Path(__file__).resolve().parents[3] / MANIFEST).read_text())
        for component in self.manifest['components']:
            component['notices'] = [dict(path='Licenses/Test.txt', sha256=hashlib.sha256(notice.read_bytes()).hexdigest(), sourceUrl='https://example.com/LICENSE')]
        lock = self.mac / 'ScanToMake.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({'pins': [dict(identity='sparkle', state=dict(version='2.9.3', revision='d46d456107feacc80711b21847b82b07bd9fb46e'))]}))
        self.policy = self.root / 'tools/licence-audit/policy.json'
        self.policy.parent.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'policy.json', self.policy)
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'LICENSE', self.policy.parent / 'LICENSE')
        self.write_manifest()

    def write_manifest(self):
        (self.root / MANIFEST).write_text(json.dumps(self.manifest))
        (self.root / NOTICES).write_text(render_notices(self.root, self.manifest, []))

    def test_complete_declared_distribution_passes(self):
        report = run_audit(self.root, self.policy, python_paths=[])
        self.assertTrue(report['ok'], report['violations'])
        self.assertEqual(len(report['inventory']['macDistribution']), 5)

    def test_missing_notice_or_changed_licence_text_fails(self):
        (self.mac / 'Licenses/Test.txt').write_text('changed licence')
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_missing_source_checksum_component_or_stale_notices_fails(self):
        for field in ['sourceUrl', 'sha256']:
            with self.subTest(field=field):
                original = self.manifest['components'][0].pop(field)
                (self.root / MANIFEST).write_text(json.dumps(self.manifest))
                self.assertTrue(inventory_mac(self.root, [])[1])
                self.manifest['components'][0][field] = original
        self.manifest['components'].pop()
        self.write_manifest()
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_stale_notices_are_rejected(self):
        (self.root / NOTICES).write_text('outdated')
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_copyleft_runtime_is_rejected_even_with_notices(self):
        self.manifest['components'][0]['licence'] = 'GPL-3.0-only'
        self.write_manifest()
        report = run_audit(self.root, self.policy, python_paths=[])
        self.assertIn('copyleft-in-app', {v['code'] for v in report['violations']})

    def test_copyleft_embedded_library_is_rejected(self):
        self.manifest['components'][0]['licence'] += ' AND LGPL-3.0-only'
        self.write_manifest()
        report = run_audit(self.root, self.policy, python_paths=[])
        self.assertIn('copyleft-in-app', {v['code'] for v in report['violations']})

    def test_required_binary_acknowledgements_are_in_notices(self):
        text = (self.root / NOTICES).read_text()
        self.assertIn('based in part on the work of the Independent JPEG Group', text)
        self.assertIn('based in part on the work of the FreeType Team', text)

    def test_app_reference_to_external_gpl_worker_is_still_rejected(self):
        path = self.mac / 'Resources/agent.mjs'
        path.parent.mkdir()
        path.write_text("import worker from '../../../tools/scan-repair/repair.py';")
        self.assertTrue(detect_app_gpl_tool_imports(self.root, [dict(name='tools/scan-repair', licence='GPL-3.0-or-later')]))

    def test_extra_swift_dependency_is_rejected(self):
        lock = next(self.mac.rglob('Package.resolved'))
        data = json.loads(lock.read_text())
        data['pins'].append(dict(identity='unexpected'))
        lock.write_text(json.dumps(data))
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_stale_worker_and_package_manager_payloads_are_rejected(self):
        payload = self.root / 'Payload'
        for name in ['capture-fit-eval', 'capture-pipeline', 'capture-mesh-convert', 'scan-repair']:
            (payload / 'source/tools' / name).mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'tool folders'):
            verify_payload(self.root, payload)
        (payload / 'source/tools/scan-repair').rmdir()
        (payload / 'python').mkdir()
        (payload / 'node/lib/node_modules').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'package-manager'):
            verify_payload(self.root, payload)

    def test_unlisted_python_wheel_is_rejected(self):
        payload = self.root / 'Payload'
        for name in ['capture-fit-eval', 'capture-pipeline', 'capture-mesh-convert']:
            (payload / 'source/tools' / name).mkdir(parents=True)
        (payload / 'node').mkdir()
        dist = payload / 'python/lib/python3.12/site-packages/pillow_heif-1.8.1.dist-info'
        dist.mkdir(parents=True)
        (dist / 'METADATA').write_text('Name: pillow-heif\nVersion: 1.8.1\n')
        with self.assertRaisesRegex(ValueError, 'Unapproved bundled Python'):
            verify_payload(self.root, payload)


if __name__ == '__main__':
    unittest.main()
