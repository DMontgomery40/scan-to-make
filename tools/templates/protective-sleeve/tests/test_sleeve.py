# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent/'_fitted-core'))
import fit_testing  # noqa: E402

spec = importlib.util.spec_from_file_location('sleeve',ROOT/'sleeve.py')
sleeve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sleeve)
BLENDER = fit_testing.blender_or_none(sleeve)


@unittest.skipUnless(BLENDER,'Blender absent; set BLENDER to Blender 5.0.1')
class SleeveTests(fit_testing.FittedTemplateCase):
    CLI = ROOT/'sleeve.py'
    STL = 'sleeve.stl'
    BLENDER = BLENDER

    def check(self, name, *args, suffix=''):
        out,m = self.generate(name,*args,suffix=suffix)
        fit,p = m['fit'],m['parameters']
        result = self.inspect(name,out,m,fit['sleeveTopZMm'])
        self.assertAlmostEqual(result['minimumFloorAlongRaysMm'],p['floor_mm'],places=3)
        self.assertAlmostEqual(fit['sleeveTopZMm'],p['coverage']*m['inputExtentsMm'][2],places=6)
        box = fit['boundingBoxMm']['extents']
        self.assertAlmostEqual(box[2],fit['sleeveTopZMm']+p['clearance_mm']+p['floor_mm'],places=4)
        for axis in range(2):
            # Conformal wall: at least wall, at most wall + one cell, on each side.
            self.assertGreaterEqual(box[axis],fit['pocketOpeningMm'][axis]+2*p['wall_mm']-1e-4)
            self.assertLessEqual(box[axis],fit['pocketOpeningMm'][axis]+2*(p['wall_mm']+p['grid_mm'])+1e-4)
        return out,m

    def test_airpods_spec_fit_and_repeatability(self):
        _,a = self.check('airpods-spec')
        self.assert_airpods_fit(a)
        self.assertEqual(a['parameters']['clearance_mm'],.5)
        _,b = self.generate('airpods-spec',suffix='-repeat')
        self.assertEqual(a,b)

    def test_airpods_configurable_clearance_full_cover(self):
        _,m = self.check('airpods-spec','--clearance-mm','1.2','--wall-mm','2.4','--coverage','1',suffix='-loose')
        self.assert_airpods_fit(m)
        self.assertAlmostEqual(m['fit']['objectExposedAboveSleeveMm'],0,places=6)

    def test_cylinder_alternate_up(self):
        _,m = self.check('cylinder','--up','X',suffix='-x')
        self.assertEqual(m['parameters']['up'],'X')

    def test_wide_shoulder_clears(self):
        _,m = self.check('overhang','--coverage','1',suffix='-shoulder')
        for opening in m['fit']['pocketOpeningMm']:
            self.assertGreaterEqual(opening,32+2*.5-1e-6)

    def test_shoulder_just_above_rim_keeps_clearance(self):
        self.assert_shoulder_above_rim_clears('--coverage')

    def test_invalid_parameters(self):
        for args in (['--clearance-mm','nan'],['--clearance-mm','0'],['--wall-mm','0.5'],['--coverage','0'],
                     ['--coverage','1.01'],['--floor-mm','11'],['--grid-mm','1','--wall-mm','1.5'],['--up','W']):
            self.assert_rejected(*args)


if __name__=='__main__':
    unittest.main()
