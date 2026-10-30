# SPDX-License-Identifier: GPL-3.0-or-later
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent/'_fitted-core'))
import fit_testing  # noqa: E402

spec = importlib.util.spec_from_file_location('mount',ROOT/'mount.py')
mount = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mount)
BLENDER = fit_testing.blender_or_none(mount)


@unittest.skipUnless(BLENDER,'Blender absent; set BLENDER to Blender 5.0.1')
class WallMountTests(fit_testing.FittedTemplateCase):
    CLI = ROOT/'mount.py'
    STL = 'mount.stl'
    BLENDER = BLENDER

    def check(self, name, *args, suffix=''):
        out,m = self.generate(name,*args,suffix=suffix)
        fit,p = m['fit'],m['parameters']
        box = fit['boundingBoxMm']
        front = box['max'][1]+20
        holes = fit['screwHoles']
        radius = holes['requestedDiameterMm']/2
        probes = []
        for x,z in holes['centresXZMm']:
            # Straight through the centre and just inside the requested rim.
            for dx,dz in ((0,0),(.97*radius,0),(0,-.97*radius),(-.69*radius,.69*radius)):
                probes.append({'origin':[x+dx,front,z+dz],'direction':[0,-1,0]})
        probes.append({'origin':[0.0123,front,holes['centresXZMm'][0][1]],'direction':[0,-1,0]})
        result = self.inspect(name,out,m,fit['cupTopZMm'],probes)
        self.assertEqual(result['probesMm'][:-1],[None]*(len(probes)-1))
        plate_front = box['min'][1]+fit['plateThicknessMm']
        self.assertAlmostEqual(result['probesMm'][-1],front-plate_front,places=3)
        self.assertAlmostEqual(result['minimumFloorAlongRaysMm'],p['floor_mm'],places=3)
        self.assertGreaterEqual(fit['plateThicknessMm'],p['plate_mm']-1e-9)
        self.assertAlmostEqual(fit['plateBackYMm'],box['min'][1],places=4)
        self.assertAlmostEqual(box['max'][2],fit['plateTopZMm'],places=4)
        self.assertAlmostEqual(box['min'][2],-p['clearance_mm']-p['floor_mm'],places=4)
        for span in holes['openingSpansXZMm']:
            self.assertGreaterEqual(min(span),2*radius)
        return out,m

    def test_airpods_spec_fit_and_repeatability(self):
        _,a = self.check('airpods-spec')
        self.assert_airpods_fit(a)
        _,b = self.generate('airpods-spec',suffix='-repeat')
        self.assertEqual(a,b)

    def test_airpods_upright_pocket(self):
        _,m = self.check('airpods-spec','--up','Y','--clearance-mm','.8','--screw-spacing-mm','20',suffix='-upright')
        self.assertAlmostEqual(m['inputExtentsMm'][2],45.2,places=4)
        self.assertAlmostEqual(m['fit']['sampledMinimumClearanceMm'],.8,places=3)

    def test_cylinder_narrow_object_widens_plate(self):
        _,m = self.check('cylinder','--screw-spacing-mm','60',suffix='-wide')
        self.assertGreaterEqual(m['fit']['boundingBoxMm']['extents'][0],60+4.5+2*2-1e-4)

    def test_wide_shoulder_clears_plate(self):
        self.check('overhang','--hold-depth','.3',suffix='-shoulder')

    def test_shoulder_just_above_rim_keeps_clearance(self):
        self.assert_shoulder_above_rim_clears('--hold-depth')

    def test_invalid_parameters(self):
        for args in (['--clearance-mm','inf'],['--hold-depth','0'],['--plate-mm','1'],['--screw-hole-mm','9'],
                     ['--plate-extension-mm','8'],['--screw-spacing-mm','8'],['--wall-mm','0.7']):
            self.assert_rejected(*args)


if __name__=='__main__':
    unittest.main()
