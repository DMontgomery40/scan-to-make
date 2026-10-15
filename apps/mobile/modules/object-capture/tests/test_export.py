import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('export_capture', Path(__file__).parents[1] / 'export_capture.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.capture = self.root / 'capture'
        self.capture.mkdir()
        (self.capture/'Images').mkdir()
        (self.capture/'Models').mkdir()
        (self.capture/'evaluation.json').write_text(json.dumps({'formatVersion':'0.1','scaleMethod':'native-unrescaled'}))
        (self.capture/'Images/fixture.heic').write_bytes(b'fixture image bytes, not real capture')
        (self.capture/'Models/model-mobile.usdz').write_bytes(b'fixture model bytes, not real reconstruction')
        self.output = self.root/'export.zip'
    def test_exact_bytes_and_no_accuracy_promotion(self):
        module.export_capture(self.capture,self.output)
        with zipfile.ZipFile(self.output) as z:
            self.assertEqual(z.read('Models/model-mobile.usdz'),(self.capture/'Models/model-mobile.usdz').read_bytes())
            report=json.loads(z.read('inventory.json'))
            self.assertFalse(report['physicalFitVerified'])
            self.assertFalse(report['depthMetadataVerified'])
            self.assertEqual(len(report['files']),3)
    def test_no_overwrite(self):
        self.output.write_bytes(b'earlier evidence')
        with self.assertRaises(FileExistsError): module.export_capture(self.capture,self.output)
        self.assertEqual(self.output.read_bytes(),b'earlier evidence')
    def test_reject_external_symlink(self):
        (self.capture/'Images/leak').symlink_to('/etc/hosts')
        with self.assertRaises(ValueError): module.export_capture(self.capture,self.output)
        self.assertFalse(self.output.exists())
    def test_reject_future_format(self):
        (self.capture/'evaluation.json').write_text('{"formatVersion":"9"}')
        with self.assertRaises(ValueError): module.export_capture(self.capture,self.output)
    def test_no_recursive_output(self):
        with self.assertRaises(ValueError): module.export_capture(self.capture,self.capture/'output.zip')

if __name__=='__main__': unittest.main()
