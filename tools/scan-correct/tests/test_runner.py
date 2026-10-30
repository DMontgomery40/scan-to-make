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
from fixtures import rounded_lumpy


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class RunnerTests(unittest.TestCase):
    def test_fake_model_converges_lumpy_rounded_box_and_logs_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            mesh=rounded_lumpy(base,os.environ['BLENDER'])
            script=base/'model.json'
            sequence=[{'name':'symmetrize','arguments':{'axis':'X','direction':'NEGATIVE','iterations':1}},
                      {'name':'convex_hull','arguments':{}},
                      {'name':'remesh','arguments':{'voxel_mm':1}},
                      {'name':'smooth','arguments':{'iterations':3,'factor':.2}},
                      {'name':'scale_to_reference','arguments':{'target_mm':[60.6,45.2,21.7]}},
                      {'name':'measure','arguments':{}}]
            script.write_text(json.dumps(sequence))
            command=[sys.executable,str(ROOT/'correct.py'),'run',str(mesh),'--units','mm',
                     '--out',str(base/'result'),'--adapter','scripted','--script',str(script),
                     '--reference-mm','60.6','45.2','21.7','--max-steps','8','--max-seconds','120']
            run=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            report=json.loads((base/'result'/'report.json').read_text())
            for actual,expected in zip(report['final']['boxExtentsMm'],[60.6,45.2,21.7]):
                self.assertAlmostEqual(actual,expected,delta=.05)
            self.assertGreater(max(abs(a-b) for a,b in zip(report['initial']['boxExtentsMm'],[60.6,45.2,21.7])),.1)
            serialized=subprocess.run([sys.executable,'-I',str(ROOT/'sandbox.py'),sys.executable,
                                       str(ROOT.parent/'scan-repair'/'repair.py'),'measure',
                                       str(base/'result'/'corrected.stl'),'--units','mm'],capture_output=True,text=True)
            self.assertEqual(serialized.returncode,0,serialized.stdout+serialized.stderr)
            for actual,expected in zip(json.loads(serialized.stdout)['boxExtentsMm'],[60.6,45.2,21.7]):
                self.assertAlmostEqual(actual,expected,delta=.05)
            self.assertFalse(report['provesPhysicalAccuracy'])
            self.assertTrue((base/'result'/'corrected.obj').exists())
            self.assertTrue((base/'result'/'corrected.stl').exists())
            log=[json.loads(line) for line in (base/'result'/'tool-calls.jsonl').read_text().splitlines()]
            self.assertEqual(len([entry for entry in log if entry['type']=='tool']),6)
            self.assertTrue(all('effect' in entry['result'] for entry in log if entry['type']=='tool'))
            # A fresh job with insufficient steps must fail with an inspectable partial log.
            command[command.index('--out')+1]=str(base/'limited')
            command[command.index('--max-steps')+1]='1'
            run=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(run.returncode,2)
            self.assertEqual(json.loads((base/'limited'/'report.json').read_text())['status'],'failed')

    def test_wall_budget_retains_failed_report(self):
        from fixtures import textured_box
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            mesh=textured_box(base)
            script=base/'calls.json'
            script.write_text(json.dumps([{'name':'measure','arguments':{}}]*10))
            run=subprocess.run([sys.executable,str(ROOT/'correct.py'),'run',str(mesh),'--units','mm',
                                '--out',str(base/'out'),'--adapter','scripted','--script',str(script),
                                '--max-seconds','1'],capture_output=True,text=True)
            self.assertEqual(run.returncode,2,run.stdout+run.stderr)
            report=json.loads((base/'out'/'report.json').read_text())
            self.assertEqual(report['status'],'failed')
            self.assertLess(report['elapsedSeconds'],5)


if __name__=='__main__':
    unittest.main()
