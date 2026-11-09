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
from mac_distribution import EARCUT, MANIFEST, NOTICES, RECONSTRUCTION_HELPER, inventory_mac, render_notices, verify_payload

REPO = Path(__file__).resolve().parents[3]


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
        self.manifest['firstPartyExecutables'] = [json.loads(json.dumps(RECONSTRUCTION_HELPER))]
        if 'tools/mac-reconstruct' not in self.manifest['sourcePaths']:
            self.manifest['sourcePaths'].append('tools/mac-reconstruct')
        helper = self.root / 'tools/mac-reconstruct'
        helper.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[1] / 'LICENSE', helper / 'LICENSE')
        # The adapted earcut code: its retained licence, the notice file and the source carrying the notice (the real ones).
        for path in [EARCUT['licencePath'], EARCUT['noticePath'], *EARCUT['files']]:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / path, self.root / path)
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
        self.assertEqual(len(report['inventory']['macDistribution']), 7)
        earcut = next(i for i in report['inventory']['macDistribution'] if i['name'].startswith('earcut'))
        self.assertEqual((earcut['licence'], earcut['status']), ('ISC', 'allowed'))

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
        for name in [Path(p).name for p in self.manifest['sourcePaths'] if p.startswith('tools/')] + ['scan-repair']:
            (payload / 'source/tools' / name).mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'tool folders'):
            verify_payload(self.root, payload)
        (payload / 'source/tools/scan-repair').rmdir()
        (payload / 'python').mkdir()
        (payload / 'node/lib/node_modules').mkdir(parents=True)
        self.add_helper(payload)
        with self.assertRaisesRegex(ValueError, 'package-manager'):
            verify_payload(self.root, payload)

    def test_unlisted_python_wheel_is_rejected(self):
        payload = self.root / 'Payload'
        for name in [Path(p).name for p in self.manifest['sourcePaths'] if p.startswith('tools/')]:
            (payload / 'source/tools' / name).mkdir(parents=True)
        (payload / 'node').mkdir()
        self.add_helper(payload)
        dist = payload / 'python/lib/python3.12/site-packages/pillow_heif-1.8.1.dist-info'
        dist.mkdir(parents=True)
        (dist / 'METADATA').write_text('Name: pillow-heif\nVersion: 1.8.1\n')
        with self.assertRaisesRegex(ValueError, 'Unapproved bundled Python'):
            verify_payload(self.root, payload)

    def add_helper(self, payload):
        (payload / 'BUILD-ID').write_text('mac-' + 'a' * 64 + '\n')
        (payload / 'bin').mkdir(parents=True)
        executable = payload / 'bin/mac-reconstruct'
        executable.write_bytes(b'\xcf\xfa\xed\xfe' + bytes(64))
        executable.chmod(0o755)
        source = payload / 'source/tools/mac-reconstruct'
        source.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.root / 'tools/mac-reconstruct/LICENSE', source / 'LICENSE')
        for path in [EARCUT['licencePath'], EARCUT['noticePath'], *EARCUT['files']]:
            (payload / 'source' / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(self.root / path, payload / 'source' / path)

    def complete_payload(self):
        payload = self.root / 'Payload'
        for path in self.manifest['sourcePaths']:
            if path.startswith('tools/'):
                (payload / 'source' / path).mkdir(parents=True)
        (payload / 'node').mkdir()
        site = payload / 'python/lib/python3.12/site-packages'
        site.mkdir(parents=True)
        for component in self.manifest['components']:
            if 'pythonPackage' in component:
                for path in component['pythonPaths']:
                    (site / path).mkdir()
                    if path.endswith('.dist-info'):
                        (site / path / 'METADATA').write_text('Name: ' + component['pythonPackage'] + '\nVersion: ' + component['version'] + '\n')
                        shutil.copyfile(self.mac / 'Licenses/Test.txt', site / path / 'LICENSE')
            if component.get('runtimeNoticePath'):
                # The fixture notice replaces each retained upstream notice.
                component['runtimeNotice'] = 'Licenses/Test.txt'
                notice = payload / component['runtimeNoticePath']
                notice.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.mac / 'Licenses/Test.txt', notice)
        self.write_manifest()
        self.add_helper(payload)
        return payload

    def test_declared_reconstruction_binary_and_source_licence_pass_payload_audit(self):
        verify_payload(self.root, self.complete_payload())

    def test_helper_directory_rejects_extra_executable_symlink_or_missing_binary(self):
        payload = self.complete_payload()
        executable = payload / 'bin/mac-reconstruct'
        for variant in ['extra', 'symlink', 'missing', 'script', 'not-executable']:
            with self.subTest(variant=variant):
                if variant == 'extra':
                    (payload / 'bin/unapproved').write_bytes(b'not allowed')
                elif variant == 'script':
                    executable.write_text('#!/bin/sh\nexit 0\n')
                elif variant == 'not-executable':
                    executable.chmod(0o644)
                else:
                    executable.unlink()
                    if variant == 'symlink':
                        executable.symlink_to('/usr/bin/true')
                with self.assertRaisesRegex(ValueError, 'executable'):
                    verify_payload(self.root, payload)
                if variant == 'extra':
                    (payload / 'bin/unapproved').unlink()
                else:
                    if executable.is_symlink(): executable.unlink()
                    executable.write_bytes(b'\xcf\xfa\xed\xfe' + bytes(64))
                    executable.chmod(0o755)

    def test_manifest_cannot_expand_the_first_party_executable_allowlist(self):
        self.manifest['firstPartyExecutables'].append(dict(self.manifest['firstPartyExecutables'][0], name='other', path='bin/other'))
        self.write_manifest()
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_reconstruction_source_licence_must_be_retained_and_unchanged(self):
        payload = self.complete_payload()
        (payload / 'source/tools/mac-reconstruct/LICENSE').write_text('different terms')
        with self.assertRaisesRegex(ValueError, 'licence'):
            verify_payload(self.root, payload)
        (self.root / 'tools/mac-reconstruct/LICENSE').unlink()
        self.assertTrue(inventory_mac(self.root, [])[1])

    def test_adapted_earcut_code_is_named_with_its_licence_in_the_helpers_notices(self):
        text = (self.root / NOTICES).read_text()
        section = text[text.index('## Bundled first-party executable: mac-reconstruct'):text.index('## Companion npm production dependencies')]
        self.assertIn('no third-party Swift package is bundled with this helper', section)
        self.assertIn('### Adapted third-party code in mac-reconstruct: earcut', section)
        self.assertIn('Licence: ISC. Source: https://github.com/mapbox/earcut', section)
        self.assertIn('Copyright (c) 2026, Mapbox', section)
        self.assertIn('provided that the above copyright notice\nand this permission notice appear in all copies.', section)

    def test_manifest_cannot_drop_or_change_the_adapted_code_declaration(self):
        for change in ['drop', 'licence', 'checksum']:
            with self.subTest(change=change):
                helper = self.manifest['firstPartyExecutables'][0]
                original = json.loads(json.dumps(helper))
                if change == 'drop':
                    helper.pop('adaptedCode')
                elif change == 'licence':
                    helper['adaptedCode'][0]['licence'] = 'MIT'
                else:
                    helper['adaptedCode'][0]['sha256'] = '0' * 64
                self.write_manifest()
                self.assertTrue(inventory_mac(self.root, [])[1])
                self.manifest['firstPartyExecutables'][0] = original
                self.write_manifest()

    def test_adapted_code_licence_must_stay_in_the_source_notice_file_and_retained_text(self):
        for path, replacement in [(EARCUT['files'][0], '// adapted, notice removed\n'),
                                  (EARCUT['noticePath'], '# Third-party code\n\nearcut, ISC.\n'),
                                  (EARCUT['licencePath'], 'ISC License\n\nCopyright (c) 2026, Someone else\n')]:
            with self.subTest(path=path):
                original = (self.root / path).read_bytes()
                (self.root / path).write_text(replacement)
                self.assertTrue(inventory_mac(self.root, [])[1])
                (self.root / path).write_bytes(original)
        self.assertFalse(inventory_mac(self.root, [])[1])

    def test_payload_must_carry_the_adapted_code_notice(self):
        payload = self.complete_payload()
        (payload / 'source' / EARCUT['noticePath']).unlink()
        with self.assertRaises((ValueError, OSError)):
            verify_payload(self.root, payload)


if __name__ == '__main__':
    unittest.main()
