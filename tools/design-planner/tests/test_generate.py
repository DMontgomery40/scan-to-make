# SPDX-License-Identifier: MIT
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

from helpers import Catalog, ready_plan

import planner
from generate import cli_command, generate


class GenerateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = Catalog()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='design-planner-test-'))
        self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp))
        self.mesh = self.tmp/'repaired.obj'
        self.mesh.write_text('# units: mm\nv 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n')
        blender = self.tmp/'blender'
        blender.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+
                           shlex.quote(str(Path(__file__).with_name('fake_blender.py')))+' "$@"\n')
        blender.chmod(0o755)
        self.blender = str(blender)

    def fake_blender_env(self):
        return patch.dict(os.environ,{'BLENDER':self.blender,'ANTHROPIC_API_KEY':'synthetic-placeholder-key'})

    def test_drawer_tray_runs_the_real_template(self):
        plan = ready_plan(self.catalog,'drawer-organizer',{
            'drawerInnerWidth':{'nominalMm':300,'lowerMm':299.5,'upperMm':300.5},
            'drawerInnerDepth':{'nominalMm':400,'lowerMm':399.5,'upperMm':400.5},
            'drawerInnerHeight':{'nominalMm':60,'lowerMm':59.5,'upperMm':60.5},
            'dividersAcross':2,'dividersAlong':0})
        receipt = generate(plan,self.catalog,self.tmp/'tray')
        self.assertEqual(receipt['status'],'generated')
        self.assertEqual(receipt['manifest']['status'],'preview-geometry-not-print-authorized')
        self.assertIn('drawer-tray.stl',receipt['outputs'])
        self.assertEqual(receipt['manifest']['artifact']['sha256'],receipt['outputs']['drawer-tray.stl'])
        self.assertEqual(receipt['command'][:2],['tools/templates/drawer-organizer/drawer.py','generate'])
        spec = json.loads((self.tmp/'tray'/'fitspec.json').read_text())
        self.assertEqual(spec['template'],'drawer-tray')
        self.assertEqual(spec['dimensions']['drawerInnerWidth']['source'],'manual')
        self.assertEqual(spec['dimensions']['wallThickness']['source'],'design')
        self.assertEqual(spec['parameters'],{'dividersAcross':2,'dividersAlong':0})
        saved = json.loads((self.tmp/'tray'/'design-plan.json').read_text())
        self.assertEqual(saved['templateId'],'drawer-organizer')

    def test_cup_holder_adapter_runs_the_real_template(self):
        plan = ready_plan(self.catalog,'cup-holder-adapter',{
            'holderInnerBottomDiameter':{'nominalMm':70,'lowerMm':69.8,'upperMm':70.2},
            'holderInnerTopDiameter':{'nominalMm':75,'lowerMm':74.8,'upperMm':75.2},
            'insertionDepth':{'nominalMm':50,'lowerMm':49.8,'upperMm':50.2},
            'cupOuterDiameter':{'nominalMm':86,'lowerMm':85.8,'upperMm':86.2}},
            scan_name='mug-measure.json')
        receipt = generate(plan,self.catalog,self.tmp/'adapter')
        self.assertEqual(receipt['manifest']['status'],'preview-geometry-not-print-authorized')
        self.assertIn('cup-holder-adapter.stl',receipt['outputs'])

    def test_template_refusal_is_reported(self):
        plan = ready_plan(self.catalog,'drawer-organizer',{
            'drawerInnerWidth':{'nominalMm':30,'lowerMm':30,'upperMm':30},
            'drawerInnerDepth':{'nominalMm':30,'lowerMm':30,'upperMm':30},
            'drawerInnerHeight':{'nominalMm':20,'lowerMm':20,'upperMm':20},
            'dividersAcross':8})
        with self.assertRaisesRegex(ValueError,r'drawer-organizer failed \(exit'):
            generate(plan,self.catalog,self.tmp/'tiny')

    def test_wall_mount_flags_reach_the_template_cli(self):
        plan = ready_plan(self.catalog,'wall-mount',{'screw_spacing_mm':120.0,'up':'-X','hold_depth':.5},
                          scan_name='case-correct-report.json')
        with self.fake_blender_env():
            receipt = generate(plan,self.catalog,self.tmp/'mount',mesh=self.mesh)
        manifest = receipt['manifest']
        self.assertTrue(manifest['fakeBlender'])
        self.assertEqual(manifest['tool'],'wall-mount')
        self.assertEqual(manifest['config']['screw_spacing_mm'],120.0)
        self.assertEqual(manifest['config']['up'],'-X')
        self.assertEqual(manifest['config']['hold_depth'],.5)
        self.assertEqual(manifest['config']['clearance_mm'],.5)
        self.assertEqual(manifest['secretEnvironment'],[])
        self.assertIn('fake.stl',receipt['outputs'])
        self.assertIn('--screw-spacing-mm=120.0',receipt['command'])

    def test_scan_cradle_omits_null_options_and_passes_negative_numbers(self):
        plan = ready_plan(self.catalog,'scan-cradle',{'notch_position_mm':-5.0})
        command = cli_command(self.catalog.template('scan-cradle'),plan['params'],self.mesh,self.tmp/'x')
        self.assertFalse(any(part.startswith('--notch-side') for part in command))
        self.assertIn('--notch-position-mm=-5.0',command)
        self.assertNotIn('--render',command)
        notched = ready_plan(self.catalog,'scan-cradle',{'notch_side':'+Y','notch_position_mm':-5.0})
        with self.fake_blender_env():
            receipt = generate(notched,self.catalog,self.tmp/'cradle',mesh=self.mesh)
        self.assertEqual(receipt['manifest']['config']['notch_side'],'+Y')
        self.assertEqual(receipt['manifest']['config']['notch_position_mm'],-5.0)
        self.assertFalse(receipt['manifest']['config']['render'])

    def test_refusals_before_any_template_runs(self):
        ran = []
        def runner(*args,**kwargs):
            ran.append(args)
        mount = ready_plan(self.catalog,'wall-mount',{})
        pending = copy.deepcopy(mount)
        pending['status'] = 'needs-input'
        tampered = copy.deepcopy(mount)
        tampered['params']['wall_mm'] = 0.5
        busy = self.tmp/'busy'
        busy.mkdir()
        (busy/'old.stl').write_text('stale')
        drawer = ready_plan(self.catalog,'drawer-organizer',{
            'drawerInnerWidth':{'nominalMm':300,'lowerMm':300,'upperMm':300},
            'drawerInnerDepth':{'nominalMm':400,'lowerMm':400,'upperMm':400},
            'drawerInnerHeight':{'nominalMm':60,'lowerMm':60,'upperMm':60}})
        for plan,kwargs,fragment in (
                (pending,{'mesh':self.mesh},'only ready plans'),
                (tampered,{'mesh':self.mesh},'params.wall_mm = 0.5 is out of bounds: minimum is 0.8'),
                (mount,{},'needs the repaired mesh'),
                (mount,{'mesh':self.tmp/'missing.stl'},'existing OBJ/STL'),
                (mount,{'mesh':self.mesh,'seconds':0},'time budget'),
                (drawer,{'mesh':self.mesh},'not a mesh')):
            with self.subTest(fragment),self.assertRaisesRegex(ValueError,fragment):
                generate(plan,self.catalog,self.tmp/'out',runner=runner,**kwargs)
        with self.assertRaisesRegex(ValueError,'new or empty'):
            generate(mount,self.catalog,busy,mesh=self.mesh,runner=runner)
        with self.assertRaisesRegex(ValueError,'new or empty'):
            generate(mount,self.catalog,self.tmp,mesh=self.mesh,runner=runner)
        self.assertEqual(ran,[])

    def test_cli_generate(self):
        plan = ready_plan(self.catalog,'edge-clip',{'edge_thickness_mm':25.0})
        path = self.tmp/'plan.json'
        path.write_text(json.dumps(plan))
        stdout = io.StringIO()
        with self.fake_blender_env(),contextlib.redirect_stdout(stdout):
            code = planner.main(['generate',str(path),'--out',str(self.tmp/'clip'),'--mesh',str(self.mesh)])
        self.assertEqual(code,0)
        receipt = json.loads(stdout.getvalue())
        self.assertEqual(receipt['manifest']['tool'],'edge-clip')
        self.assertEqual(receipt['manifest']['config']['edge_thickness_mm'],25.0)


if __name__ == '__main__':
    unittest.main()
