# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent/'_fitted-core'))
import fit_testing  # noqa: E402

spec = importlib.util.spec_from_file_location('clip',ROOT/'clip.py')
clip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clip)
BLENDER = fit_testing.blender_or_none(clip)


@unittest.skipUnless(BLENDER,'Blender absent; set BLENDER to Blender 5.0.1')
class EdgeClipTests(fit_testing.FittedTemplateCase):
    CLI = ROOT/'clip.py'
    STL = 'clip.stl'
    BLENDER = BLENDER

    def check(self, name, *args, suffix=''):
        out,m = self.generate(name,*args,suffix=suffix)
        fit,p = m['fit'],m['parameters']
        slot = p['edge_thickness_mm']+p['edge_clearance_mm']
        self.assertAlmostEqual(fit['slotHeightMm'],slot,places=9)
        low,high = fit['slotZMm']
        y = (fit['slotOpenAtYMm']+fit['spineInnerYMm'])/2
        mid = (low+high)/2
        probes = [{'origin':[.0123,y,mid],'direction':[0,0,1]},
                  {'origin':[.0123,y,mid],'direction':[0,0,-1]},
                  {'origin':[.0123,y,mid],'direction':[0,1,0]},
                  {'origin':[.0123,y,mid],'direction':[0,-1,0]}]
        result = self.inspect(name,out,m,fit['cupTopZMm'],probes)
        up,down,spine,opening = result['probesMm']
        # Independently measured slot height and depth, and an open back.
        self.assertAlmostEqual(up+down,slot,places=3)
        self.assertGreaterEqual(fit['spineInnerYMm']-fit['slotOpenAtYMm'],p['grip_depth_mm']-1e-9)
        self.assertAlmostEqual(spine,fit['spineInnerYMm']-y,places=3)
        self.assertIsNone(opening)
        self.assertAlmostEqual(result['minimumFloorAlongRaysMm'],p['jaw_mm'],places=3)
        box = fit['boundingBoxMm']['extents']
        self.assertAlmostEqual(box[2],fit['cupTopZMm']+p['clearance_mm']+2*p['jaw_mm']+slot,places=4)
        return out,m

    def test_airpods_spec_fit_and_repeatability(self):
        _,a = self.check('airpods-spec')
        self.assert_airpods_fit(a)
        _,b = self.generate('airpods-spec',suffix='-repeat')
        self.assertEqual(a,b)

    def test_airpods_thick_shelf_long_grip(self):
        _,m = self.check('airpods-spec','--edge-thickness-mm','25','--edge-clearance-mm','.8',
                         '--grip-depth-mm','60','--clearance-mm','.3',suffix='-shelf')
        self.assert_airpods_fit(m)
        self.assertAlmostEqual(m['fit']['slotHeightMm'],25.8,places=9)
        # Grip longer than the cup: the jaws extend past the pocket toward -Y.
        self.assertLess(m['fit']['slotOpenAtYMm'],m['fit']['boundingBoxMm']['max'][1]-m['fit']['pocketOpeningMm'][1])

    def test_cylinder_alternate_up_thin_edge(self):
        self.check('cylinder','--up=-Y','--edge-thickness-mm','4','--edge-clearance-mm','0',suffix='-thin')

    def test_shoulder_just_above_rim_keeps_clearance(self):
        self.assert_shoulder_above_rim_clears('--hold-depth')

    def test_invalid_parameters(self):
        for args in (['--edge-thickness-mm','0.5'],['--edge-thickness-mm','61'],['--edge-clearance-mm','-0.1'],
                     ['--grip-depth-mm','4'],['--jaw-mm','1'],['--clearance-mm','nan'],['--hold-depth','1.5']):
            self.assert_rejected(*args)


if __name__=='__main__':
    unittest.main()
