# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cradle',ROOT/'cradle.py')
c=importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
try:
    BLENDER=c.find_blender()
except ValueError:
    BLENDER=None


@unittest.skipUnless(BLENDER,'Blender absent; set BLENDER to Blender 5.0.1')
class CradleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        cls.dir=Path(cls.tmp.name)
        cls.blender(ROOT/'tests'/'fixtures.py',cls.dir/'fixtures')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @staticmethod
    def blender(script,*args):
        run=subprocess.run([BLENDER,'--background','--factory-startup','--python-exit-code','1','--python',str(script),'--',*map(str,args)],capture_output=True,text=True)
        if run.returncode:
            raise AssertionError(run.stdout+run.stderr)
        return run.stdout

    def generate(self,name,*args,suffix=''):
        out=self.dir/(name+suffix)
        run=subprocess.run([sys.executable,str(ROOT/'cradle.py'),str(self.dir/'fixtures'/(name+'.obj')),'--out',str(out),*args],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        manifest=json.loads(run.stdout)
        self.assertTrue(manifest['previewOnly'])
        self.assertTrue(manifest['watertight'])
        self.assertGreaterEqual(manifest['sampledMinimumClearanceMm'],.27)
        self.assertGreaterEqual(manifest['sampledMinimumWallThicknessMm'],1.999)
        self.assertEqual(manifest['outputSha256']['cradle.stl'],hashlib.sha256((out/'cradle.stl').read_bytes()).hexdigest())
        return out,manifest

    def verify(self,name):
        out,manifest=self.generate(name)
        print(self.blender(ROOT/'tests'/'inspect_mesh.py',self.dir/'fixtures'/(name+'.obj'),out/'cradle.stl'))
        return out,manifest

    def test_airpods_spec_and_repeatability(self):
        out,a=self.verify('airpods-spec')
        _,b=self.generate('airpods-spec',suffix='-repeat')
        self.assertEqual(a,b)
        for actual,expected in zip(a['inputExtentsMm'],(60.6,45.2,21.7)):
            self.assertAlmostEqual(actual,expected,places=4)

    def test_cylinder(self):
        self.verify('cylinder')

    def test_overhang_lifts_out(self):
        self.verify('overhang')

    def test_notch_and_axis(self):
        _,m=self.generate('cylinder','--notch-side','+X','--notch-width-mm','5','--up','Y',suffix='-notch')
        self.assertEqual(m['parameters']['notch_side'],'+X')
        self.assertEqual(m['parameters']['up'],'Y')

    def test_render_hashes(self):
        out,m=self.generate('airpods-spec','--render',suffix='-renders')
        self.assertEqual(len(m['outputSha256']),11)
        for name,digest in m['outputSha256'].items():
            self.assertEqual(hashlib.sha256((out/name).read_bytes()).hexdigest(),digest)
        self.assertEqual(len(list((out/'renders').glob('*.png'))),10)

    def test_invalid_parameters(self):
        for args in (['--clearance-mm','nan'],['--wall-mm','-1'],['--seat-depth','1'],['--margin-mm','1'],['--grid-mm','.001']):
            run=subprocess.run([sys.executable,str(ROOT/'cradle.py'),str(self.dir/'fixtures'/'cylinder.obj'),'--out',str(self.dir/'invalid'),*args],capture_output=True,text=True)
            self.assertEqual(run.returncode,2,run.stdout+run.stderr)


if __name__=='__main__':
    unittest.main()
