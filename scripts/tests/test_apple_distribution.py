"""Reject release artifacts that would strand external testers on development services."""
import copy
import importlib.util
import pathlib
import os
import plistlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'verify_apple_distribution.py'
spec = importlib.util.spec_from_file_location('distribution', SCRIPT) if SCRIPT.exists() else None
distribution = importlib.util.module_from_spec(spec) if spec else None
if distribution:
    spec.loader.exec_module(distribution)


class AppleDistributionTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(distribution, 'The distribution artifact validator is missing')
        self.info = {'CFBundleIdentifier': 'com.scantomake', 'CFBundleVersion': '42',
                     'CFBundleShortVersionString': '2.0'}
        self.entitlements = {
            'com.apple.developer.team-identifier': 'X7F5F9LR24',
            'com.apple.developer.icloud-container-identifiers': ['iCloud.com.scantomake.counterpart'],
            'com.apple.developer.icloud-services': ['CloudKit'],
            'com.apple.developer.icloud-container-environment': 'Production',
            'aps-environment': 'production',
        }

    def validate(self, platform='ios', info=None, entitlements=None):
        return distribution.validate_metadata(
            info or self.info, self.entitlements if entitlements is None else entitlements,
            platform=platform, expected_build='42')

    def test_distribution_phone_with_production_services_is_accepted(self):
        self.assertEqual(self.validate(), [])

    def test_development_push_or_cloudkit_is_rejected(self):
        for key, value in [('aps-environment', 'development'),
                           ('com.apple.developer.icloud-container-environment', 'Development')]:
            with self.subTest(key=key):
                changed = {**self.entitlements, key: value}
                self.assertTrue(any(key in issue for issue in self.validate(entitlements=changed)))

    def test_empty_cloudkit_entitlements_are_rejected(self):
        issues = self.validate(entitlements={})
        self.assertTrue(any('icloud-container-identifiers' in issue for issue in issues))
        self.assertTrue(any('icloud-services' in issue for issue in issues))

    def test_debug_entitlement_is_rejected_on_both_platforms(self):
        for key in ['get-task-allow', 'com.apple.security.get-task-allow']:
            with self.subTest(key=key):
                self.assertTrue(any(key in issue for issue in self.validate(
                    entitlements={**self.entitlements, key: True})))

    def test_mac_requires_mac_push_entitlement_and_bundle_identity(self):
        info = {**self.info, 'CFBundleIdentifier': 'com.scantomake.mac'}
        entitlements = copy.deepcopy(self.entitlements)
        del entitlements['aps-environment']
        entitlements['com.apple.developer.aps-environment'] = 'production'
        self.assertEqual(self.validate('mac', info, entitlements), [])
        entitlements['com.apple.developer.aps-environment'] = 'development'
        self.assertTrue(self.validate('mac', info, entitlements))

    def test_wrong_identity_or_build_is_rejected(self):
        self.assertTrue(self.validate(info={**self.info, 'CFBundleIdentifier': 'com.other.app'}))
        self.assertTrue(self.validate(info={**self.info, 'CFBundleVersion': '41'}))
        self.assertTrue(self.validate(entitlements={**self.entitlements,
            'com.apple.developer.team-identifier': 'WRONGTEAM1'}))


class TestFlightPreparationTests(unittest.TestCase):
    SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'apps/mobile/scripts/prepare-testflight.sh'

    def test_export_options_allow_external_testing_and_pin_production(self):
        # Xcode is the external, signing/account-changing boundary. Stop there, then
        # inspect the actual generated export options rather than shell source text.
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            binary = root / 'xcodebuild'
            binary.write_text('#!/bin/sh\nexit 77\n')
            binary.chmod(0o755)
            output = root / 'release'
            result = subprocess.run(['bash', str(self.SCRIPT)], capture_output=True, text=True,
                env={**os.environ, 'BUILD_NUMBER': '42', 'RELEASE_DIR': str(output),
                     'PATH': str(root) + os.pathsep + os.environ['PATH']})
            self.assertEqual(result.returncode, 77, result.stderr)
            options = plistlib.loads((output / 'ExportOptions.plist').read_bytes())
            self.assertEqual(options['destination'], 'export')
            self.assertEqual(options['method'], 'app-store-connect')
            self.assertIs(options['testFlightInternalTestingOnly'], False)
            self.assertIs(options['manageAppVersionAndBuildNumber'], False)
            self.assertEqual(options['iCloudContainerEnvironment'], 'Production')

    def test_existing_archive_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / 'Counterpart.xcarchive'
            archive.write_text('preserved')
            result = subprocess.run(['bash', str(self.SCRIPT)], capture_output=True, text=True,
                env={**os.environ, 'BUILD_NUMBER': '42', 'RELEASE_DIR': directory})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(archive.read_text(), 'preserved')
            self.assertFalse((pathlib.Path(directory) / 'ExportOptions.plist').exists())


if __name__ == '__main__':
    unittest.main()
