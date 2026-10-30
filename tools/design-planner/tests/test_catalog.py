# SPDX-License-Identifier: MIT
import json
from pathlib import Path
import tempfile
import unittest

from helpers import FIXTURES, Catalog

import measurements
from catalog import check_value


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = Catalog()

    def param(self, template_id, name):
        return next(p for p in self.catalog.template(template_id)['parameters'] if p['name'] == name)

    def test_every_catalog_default_is_valid(self):
        for template_id,entry in self.catalog.templates.items():
            defaults = {p['name']:p['default'] for p in entry['parameters']}
            with self.subTest(template_id):
                self.assertEqual(self.catalog.check_params(template_id,defaults,complete=True),[])

    def test_inclusive_and_exclusive_bounds(self):
        spacing = self.param('wall-mount','screw_spacing_mm')
        self.assertEqual(check_value(spacing,200.0),[])
        self.assertEqual(check_value(spacing,4),[])
        self.assertIn('maximum is 200.0',check_value(spacing,200.01)[0])
        self.assertIn('minimum is 4.0',check_value(spacing,3.99)[0])
        seat = self.param('scan-cradle','seat_depth')
        self.assertIn('must be greater than 0',check_value(seat,0)[0])
        self.assertIn('must be less than 1',check_value(seat,1)[0])
        self.assertEqual(check_value(seat,.99),[])
        margin = self.param('scan-cradle','margin_mm')
        self.assertEqual(check_value(margin,-5.0),[])

    def test_types(self):
        clearance = self.param('wall-mount','clearance_mm')
        for value in (True,'0.5',None,float('nan'),float('inf'),[0.5]):
            self.assertIn('must be a finite number',check_value(clearance,value)[0],value)
        dividers = self.param('drawer-organizer','dividersAcross')
        self.assertIn('must be an integer',check_value(dividers,2.0)[0])
        self.assertIn('must be an integer',check_value(dividers,False)[0])
        self.assertIn('maximum is 8',check_value(dividers,9)[0])
        self.assertIn('minimum is 0',check_value(dividers,-1)[0])

    def test_enums_allow_null_only_when_default_is_null(self):
        self.assertEqual(check_value(self.param('scan-cradle','notch_side'),None),[])
        self.assertEqual(check_value(self.param('scan-cradle','notch_side'),'-Y'),[])
        self.assertTrue(check_value(self.param('scan-cradle','notch_side'),'Z'))
        self.assertTrue(check_value(self.param('scan-cradle','up'),None))
        self.assertTrue(check_value(self.param('scan-cradle','up'),'x'))

    def test_intervals(self):
        width = self.param('drawer-organizer','drawerInnerWidth')
        self.assertEqual(check_value(width,{'nominalMm':300,'lowerMm':299,'upperMm':301}),[])
        self.assertIn('lowerMm <= nominalMm <= upperMm',
                      check_value(width,{'nominalMm':300,'lowerMm':301,'upperMm':302})[0])
        self.assertIn('lowerMm = 0 is out of bounds: must be greater than 0',
                      check_value(width,{'nominalMm':1,'lowerMm':0,'upperMm':2})[0])
        self.assertIn('exactly nominalMm',check_value(width,{'nominalMm':300})[0])
        self.assertIn('finite numbers',check_value(width,{'nominalMm':'300','lowerMm':299,'upperMm':301})[0])
        clearance = self.param('drawer-organizer','peripheralClearance')
        self.assertEqual(check_value(clearance,{'nominalMm':0,'lowerMm':0,'upperMm':0}),[])

    def test_measured_parameters_come_from_non_design_example_dimensions(self):
        self.assertEqual(self.catalog.measured_parameters('drawer-organizer'),
                         ['drawerInnerWidth','drawerInnerDepth','drawerInnerHeight'])
        self.assertEqual(self.catalog.measured_parameters('cup-holder-adapter'),
                         ['holderInnerBottomDiameter','holderInnerTopDiameter','insertionDepth','cupOuterDiameter'])
        self.assertEqual(self.catalog.measured_parameters('wall-mount'),[])

    def test_unknown_template_and_parameters(self):
        with self.assertRaisesRegex(ValueError,'unknown template'):
            self.catalog.check_params('phone-stand',{})
        self.assertEqual(self.catalog.check_params('wall-mount',{'lanyard_hole_mm':3}),
                         ['params.lanyard_hole_mm is not a parameter of wall-mount'])

    def test_rejects_unknown_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'catalog.json'
            path.write_text(json.dumps({'schemaVersion':2,'units':'mm','templates':[]}))
            with self.assertRaisesRegex(ValueError,'unsupported template catalog'):
                Catalog(path)


class MeasurementTests(unittest.TestCase):
    def test_reads_each_pipeline_output(self):
        repair = measurements.load(FIXTURES/'phone-repair-report.json')
        self.assertEqual(repair['source'],'scan-repair report (after)')
        self.assertEqual(repair['boxExtentsMm'],[150.1,72.0,8.3])
        self.assertTrue(repair['watertight'])
        correct = measurements.load(FIXTURES/'case-correct-report.json')
        self.assertEqual(correct['source'],'scan-correct report (final)')
        self.assertEqual(correct['bboxExtentsMm'],[60.6,45.2,21.7])
        measure = measurements.load(FIXTURES/'mug-measure.json')
        self.assertEqual(measure['source'],'scan-repair measure')
        self.assertEqual(measure['volumeMm3'],210400.0)

    def test_rejects_untrustworthy_measurements(self):
        bad = [
            {'status':'failed','final':{'boxExtentsMm':[1,1,1]}},
            {'outputUnits':'cm','after':{'boxExtentsMm':[3,2,1]}},
            {'boxExtentsMm':[1,2,3]},
            {'boxExtentsMm':[3,2,-1]},
            {'boxExtentsMm':[3,2,float('nan')]},
            {'bboxMm':{'extents':[3,2]}},
            {'boxExtentsMm':[3,2,1],'watertight':'yes'},
            {'surfaceAreaMm2':10},
            [1,2,3],
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for index,data in enumerate(bad):
                path = Path(tmp)/f'{index}.json'
                path.write_text(json.dumps(data))
                with self.subTest(data),self.assertRaises(ValueError):
                    measurements.load(path)


if __name__ == '__main__':
    unittest.main()
