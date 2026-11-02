import pathlib
import plistlib
import subprocess
import sys
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'camera_safe_tests.py'


class CameraSafeTests(unittest.TestCase):
    def configure(self, value):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'Phone.xctestrun'
            original = plistlib.dumps(value)
            path.write_bytes(original)
            result = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)
            return result, plistlib.loads(path.read_bytes()), path.read_bytes() == original

    def test_legacy_targets_disable_recording_without_losing_launch_settings(self):
        value = {'Unit': {'TestBundlePath': 'Unit.xctest', 'EnvironmentVariables': {'KEEP': 'yes'}},
                 'UI': {'TestBundlePath': 'UI.xctest', 'IsUITestBundle': True, 'PreferredScreenCaptureFormat': 'video'}}
        result, configured, _ = self.configure(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('2 test targets; 1 UI target', result.stdout)
        for target in configured.values():
            self.assertEqual(target['PreferredScreenCaptureFormat'], 'screenshots')
        self.assertEqual(configured['Unit']['EnvironmentVariables'], {'KEEP': 'yes'})

    def test_version_two_configurations_are_all_configured(self):
        value = {'TestConfigurations': [{'TestTargets': [{'TestBundlePath': 'A.xctest', 'IsUITestBundle': True}]},
                                        {'TestTargets': [{'TestBundlePath': 'B.xctest', 'IsUITestBundle': True}]}],
                 '__xctestrun_metadata__': {'FormatVersion': 2}}
        result, configured, _ = self.configure(value)
        self.assertEqual(result.returncode, 0, result.stderr)
        for configuration in configured['TestConfigurations']:
            self.assertEqual(configuration['TestTargets'][0]['PreferredScreenCaptureFormat'], 'screenshots')

    def test_unknown_or_wrong_bundle_is_rejected_without_modifying_file(self):
        for value in ({'unexpected': []}, {'Unit': {'TestBundlePath': 'Unit.xctest'}},
                      {'UI': {'IsUITestBundle': True}}):
            with self.subTest(value=value):
                result, _, unchanged = self.configure(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('REFUSED', result.stderr)
                self.assertTrue(unchanged)


if __name__ == '__main__':
    unittest.main()
