# SPDX-License-Identifier: GPL-3.0-or-later
"""unittest harness shared by fitted-template tests: synthetic fixtures, real
Blender runs and the independent STL inspector."""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CORE = Path(__file__).resolve().parent
AIRPODS_PRO_2_CASE_MM = (60.6,45.2,21.7)


def blender_or_none(module):
    try:
        return module.find_blender()
    except ValueError:
        return None


class FittedTemplateCase(unittest.TestCase):
    """Subclasses set CLI (path), STL (output name) and BLENDER."""
    CLI = None
    STL = None
    BLENDER = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.blender(CORE/'synthetic_fixtures.py',cls.dir/'fixtures')

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    @classmethod
    def blender(cls, script, *args):
        run = subprocess.run([cls.BLENDER,'--background','--factory-startup','--python-exit-code','1',
                              '--python',str(script),'--',*map(str,args)],capture_output=True,text=True)
        if run.returncode:
            raise AssertionError(run.stdout+run.stderr)
        return run.stdout

    def run_cli(self, name, *args, out=None):
        return subprocess.run([sys.executable,str(self.CLI),str(self.dir/'fixtures'/(name+'.obj')),
                               '--out',str(out or self.dir/'unused'),*map(str,args)],capture_output=True,text=True)

    def generate(self, name, *args, suffix=''):
        out = self.dir/(name+suffix)
        run = self.run_cli(name,*args,out=out)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        manifest = json.loads(run.stdout)
        self.assertTrue(manifest['previewOnly'])
        self.assertFalse(manifest['provesPhysicalAccuracy'])
        self.assertTrue(manifest['watertight'])
        self.assertEqual(manifest['units'],'mm')
        self.assertEqual(json.loads((out/'manifest.json').read_text()),manifest)
        self.assertEqual(manifest['outputSha256'][self.STL],hashlib.sha256((out/self.STL).read_bytes()).hexdigest())
        fit = manifest['fit']
        c = manifest['parameters']['clearance_mm']
        self.assertGreaterEqual(fit['sampledMinimumClearanceMm'],c-1e-4)
        self.assertGreaterEqual(fit['minimumSideWallMm'],manifest['parameters']['wall_mm']-1e-9)
        self.assertEqual(fit['liftOutRaysBlocked'],0)
        self.assertEqual(fit['cellClearanceViolations'],0)
        return out,manifest

    def inspect(self, name, out, manifest, wall_top, probes=(), check_probes=None):
        request = out/'inspect-request.json'
        request.write_text(json.dumps({'source':str(self.dir/'fixtures'/(name+'.obj')),'stl':str(out/self.STL),
                                       'up':manifest['frame']['up'],
                                       'translation':manifest['frame']['translationAfterAxisMapMm'],
                                       'wallTop':wall_top,'probes':list(probes)}))
        stdout = self.blender(CORE/'inspect_fit.py',request)
        result = json.loads(next(l for l in stdout.splitlines() if l.startswith('INSPECT '))[8:])
        if check_probes:
            check_probes(result['probesMm'])
        params = manifest['parameters']
        self.assertTrue(result['watertight'])
        self.assertEqual(result['raysWithoutWall'],0)
        self.assertEqual(result['liftOutRaysBlocked'],0)
        self.assertGreaterEqual(result['minimumClearanceMm'],params['clearance_mm']-1e-4)
        self.assertGreaterEqual(result['minimumRayEntryMm'],params['clearance_mm']-1e-3)
        self.assertGreaterEqual(result['minimumSideWallAlongRaysMm'],params['wall_mm']-1e-3)
        for axis in range(3):
            self.assertAlmostEqual(result['boundingBoxMm']['extents'][axis],
                                   manifest['fit']['boundingBoxMm']['extents'][axis],places=4)
        return result

    def assert_airpods_fit(self, manifest):
        """Input is the AirPods Pro 2 case envelope; pocket clears it by the
        stated clearance on every side, at most one grid step looser."""
        for actual,expected in zip(manifest['inputExtentsMm'],AIRPODS_PRO_2_CASE_MM):
            self.assertAlmostEqual(actual,expected,places=4)
        fit,params = manifest['fit'],manifest['parameters']
        c,g = params['clearance_mm'],params['grid_mm']
        self.assertAlmostEqual(fit['sampledMinimumClearanceMm'],c,places=3)
        for opening,size in zip(fit['pocketOpeningMm'],AIRPODS_PRO_2_CASE_MM):
            self.assertGreaterEqual(opening,size+2*c-1e-6)
            self.assertLessEqual(opening,size+2*c+2*g+1e-6)
        print('\n'+self.id()+' fit '+json.dumps(fit,sort_keys=True))

    def assert_shoulder_above_rim_clears(self, rim_fraction_flag):
        """Rim 0.1 mm below a broad overhanging shoulder (within clearance).
        Rays straight down from the shoulder underside measure the true gap,
        which source vertex/centroid samples cannot see."""
        shoulder,height,rim = 10.0,14.0,9.9
        out,m = self.generate('stem-shoulder',f'{rim_fraction_flag}={rim/height!r}',suffix='-shoulder-rim')
        c = m['parameters']['clearance_mm']
        probes = [{'origin':[r*math.cos(a),r*math.sin(a),shoulder],'direction':[0,0,-1]}
                  for r in [10.05+.1*k for k in range(200)] for a in (.0123,1.3,2.9,4.4)]

        def check(gaps):
            # None: no material below that point of the shoulder at all.
            gap = min(g for g in gaps if g is not None)
            self.assertGreaterEqual(gap,c-1e-3,f'gap under shoulder {gap:.4f} mm < clearance {c} mm')

        self.inspect('stem-shoulder',out,m,rim,probes,check)
        return m

    def assert_rejected(self, *args):
        run = self.run_cli('cylinder',*args)
        self.assertEqual(run.returncode,2,run.stdout+run.stderr)
