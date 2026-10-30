# SPDX-License-Identifier: GPL-3.0-or-later
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from host import Worker
from fixtures import rounded_lumpy, textured_box


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class ReplayTests(unittest.TestCase):
    def test_measured_frame_copy_and_modifier_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            worker=Worker(base/'job',seconds=120)
            worker.stage(textured_box(base),'mm')
            result=worker.apply('rigid_frame',{'rotation':[1,0,0,0,1,0,0,0,1],'translation_mm':[2,3,4]})
            self.assertAlmostEqual(result['after']['bboxMm']['min'][0],-8)
            worker.apply('rigid_frame',{'rotation':[1,0,0,0,1,0,0,0,1],'translation_mm':[-2,-3,-4]})
            worker.apply('mirror',{'axis':'Z','direction':'NEGATIVE'})
            worker.apply('remesh',{'voxel_mm':1})
            worker.apply('laplacian_smooth',{'iterations':3,'lambda_factor':1})
            result=worker.apply('subdivide',{'levels':1})
            self.assertTrue(result['after']['watertight'])
            with self.assertRaises(ValueError):
                worker.apply('rigid_frame',{'rotation':[2,0,0,0,1,0,0,0,1],'translation_mm':[0,0,0]})

    def test_slot_long_axis_is_explicit_on_side_face(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);worker=Worker(base/'job',seconds=60)
            worker.stage(textured_box(base),'mm')
            worker.apply('cut_oriented_feature',{'kind':'slot','axis':'Y','side':1,'length_axis':'X',
                        'centre_mm':[0,0,0],'length_mm':6,'width_mm':2,'depth_mm':1})
            worker.export()
            vertices=[list(map(float,line.split()[1:])) for line in (base/'job/export/repaired.obj').read_text().splitlines()
                      if line.startswith('v ')]
            floor=[v for v in vertices if abs(v[1]-5)<1e-4]
            self.assertAlmostEqual(max(v[0] for v in floor)-min(v[0] for v in floor),6,delta=.01)
            self.assertAlmostEqual(max(v[2] for v in floor)-min(v[2] for v in floor),2,delta=.01)

    def test_open_lumpy_box_replay_converges(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            mesh=rounded_lumpy(base,os.environ['BLENDER'],missing_back=True)
            sequence=[{'name':'mirror','arguments':{'axis':'Z','direction':'NEGATIVE'}},
                      {'name':'symmetrize','arguments':{'axis':'X','direction':'POSITIVE','iterations':2}},
                      {'name':'convex_hull','arguments':{}}, {'name':'remesh','arguments':{'voxel_mm':1}},
                      {'name':'laplacian_smooth','arguments':{'iterations':5,'lambda_factor':1}},
                      {'name':'subdivide','arguments':{'levels':1}},
                      {'name':'scale_to_reference','arguments':{'target_mm':[60.6,45.2,21.7]}}]
            script=base/'sequence.json';script.write_text(json.dumps(sequence))
            run=subprocess.run([sys.executable,str(ROOT/'correct.py'),'run',str(mesh),'--units','mm',
                                '--out',str(base/'result'),'--adapter','scripted','--script',str(script),
                                '--reference-mm','60.6','45.2','21.7'],capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            report=json.loads((base/'result/report.json').read_text())
            serialized=subprocess.run([sys.executable,'-I',str(ROOT/'sandbox.py'),sys.executable,
                                       str(ROOT.parent/'scan-repair/repair.py'),'measure',
                                       str(base/'result/corrected.stl'),'--units','mm'],capture_output=True,text=True)
            self.assertEqual(serialized.returncode,0,serialized.stdout+serialized.stderr)
            for actual,target in zip(json.loads(serialized.stdout)['boxExtentsMm'],[60.6,45.2,21.7]):
                self.assertAlmostEqual(actual,target,delta=.3)
            self.assertEqual(report['toolFailures'],[])
            self.assertFalse(report['initial']['watertight'])
            self.assertTrue(report['final']['watertight'])
            for actual,target in zip(report['final']['boxExtentsMm'],[60.6,45.2,21.7]):
                self.assertAlmostEqual(actual,target,delta=.3)

            repeat=subprocess.run([sys.executable,str(ROOT/'correct.py'),'run',str(mesh),'--units','mm',
                                   '--out',str(base/'repeat'),'--adapter','scripted','--script',str(script),
                                   '--reference-mm','60.6','45.2','21.7'],capture_output=True,text=True)
            self.assertEqual(repeat.returncode,0,repeat.stdout+repeat.stderr)
            self.assertEqual(report['outputs'],json.loads((base/'repeat/report.json').read_text())['outputs'])
