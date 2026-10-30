import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('validate_catalog',ROOT/'validate_catalog.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = v.load()

    def entry(self, catalog, template_id):
        return next(e for e in catalog['templates'] if e['id'] == template_id)

    def test_catalog_matches_template_folders_and_code(self):
        self.assertEqual(v.validate(self.catalog),[])
        self.assertEqual(sorted(e['id'] for e in self.catalog['templates']),
                         ['cup-holder-adapter','drawer-organizer','edge-clip','protective-sleeve',
                          'scan-cradle','wall-mount'])

    def test_catalogued_bounds_are_enforced(self):
        for entry in self.catalog['templates']:
            with self.subTest(template=entry['id']):
                self.assertEqual(v.bound_violations(entry),[])

    def test_drift_is_detected(self):
        cases = {
            'missing template': lambda c: c['templates'].pop(),
            'wrong default': lambda c: self.entry(c,'scan-cradle')['parameters'][0].update(default=0.4),
            'wrong bound': lambda c: self.entry(c,'protective-sleeve')['parameters'][0].update(max=6.0),
            'invented parameter': lambda c: self.entry(c,'wall-mount')['parameters'].append(
                {'name':'hook_mm','flag':'--hook-mm','type':'number','units':'mm','default':1.0,
                 'min':None,'max':None,'description':'x'}),
            'dropped parameter': lambda c: self.entry(c,'edge-clip')['parameters'].pop(),
            'fixture drift': lambda c: self.entry(c,'drawer-organizer')['parameters'][-1].update(default=3),
            'missing description': lambda c: self.entry(c,'cup-holder-adapter')['parameters'][0].pop('description'),
        }
        for label,mutate in cases.items():
            with self.subTest(label):
                catalog = copy.deepcopy(self.catalog)
                mutate(catalog)
                self.assertNotEqual(v.validate(catalog),[])

    def test_unenforced_bound_is_caught_behaviourally(self):
        for template_id,name,bound in (('edge-clip','edge_thickness_mm',50.0),('scan-cradle','margin_mm',100.0),
                                       ('drawer-organizer','dividersAcross',5),('cup-holder-adapter','wallThickness',3.0)):
            with self.subTest(template=template_id):
                entry = copy.deepcopy(self.entry(self.catalog,template_id))
                next(p for p in entry['parameters'] if p['name'] == name)['max'] = bound
                self.assertTrue(v.bound_violations(entry))


if __name__ == '__main__':
    unittest.main()
