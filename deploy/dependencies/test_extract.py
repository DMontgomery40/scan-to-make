import io
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

SCRIPT = pathlib.Path(__file__).with_name('extract.py')

class ExtractionTests(unittest.TestCase):
    def test_zip_retains_notices_and_executable_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with zipfile.ZipFile(root/'input.zip', 'w') as z:
                z.writestr('LICENSE', 'retained license')
                info = zipfile.ZipInfo('bin/server'); info.external_attr = 0o100755 << 16
                z.writestr(info, 'a worker')
            result = subprocess.run([sys.executable, SCRIPT, 'zip', root/'input.zip', root/'out'], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root/'out/LICENSE').read_text(), 'retained license')
            self.assertEqual((root/'out/bin/server').stat().st_mode & 0o777, 0o700)

    def test_zip_cannot_escape_destination_or_create_links(self):
        for name, mode, content in [('../outside', 0o100600, 'bad'), ('/outside', 0o100600, 'bad'), ('link', 0o120777, '../outside')]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                with zipfile.ZipFile(root/'input.zip', 'w') as z:
                    info = zipfile.ZipInfo(name); info.external_attr = mode << 16; z.writestr(info, content)
                result = subprocess.run([sys.executable, SCRIPT, 'zip', root/'input.zip', root/'out'], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root/'outside').exists())

    def test_npm_archive_strips_only_package_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with tarfile.open(root/'input.tgz', 'w:gz') as t:
                info = tarfile.TarInfo('package/dist/index.js'); info.size = 6
                t.addfile(info, io.BytesIO(b'worker'))
            result = subprocess.run([sys.executable, SCRIPT, 'tgz', root/'input.tgz', root/'out'], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root/'out/dist/index.js').read_bytes(), b'worker')

    def test_npm_hardlinks_cannot_bypass_path_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with tarfile.open(root/'input.tgz', 'w:gz') as t:
                info = tarfile.TarInfo('package/link'); info.type = tarfile.LNKTYPE; info.linkname = '/etc/passwd'; t.addfile(info)
            result = subprocess.run([sys.executable, SCRIPT, 'tgz', root/'input.tgz', root/'out'], capture_output=True)
            self.assertNotEqual(result.returncode, 0)

if __name__ == '__main__':
    unittest.main()
