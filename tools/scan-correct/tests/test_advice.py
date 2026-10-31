# SPDX-License-Identifier: GPL-3.0-or-later
import json
import hashlib
import binascii
import struct
import zlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
from advice_fixtures import make_advice_fixture


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class AdviceTests(unittest.TestCase):
    def advise(self,mesh,out):
        result=subprocess.run([sys.executable,str(ROOT/'correct.py'),'advise',str(mesh),'--units','mm',
                               '--out',str(out),'--max-targets','3','--resolution','64',
                               '--reference-mm','20','12','8'],capture_output=True,text=True,
                              env={k:v for k,v in os.environ.items() if not k.endswith('API_KEY')})
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        return json.loads(result.stdout)['closeupAdvice']

    def test_defective_regions_rank_first(self):
        for kind,axis,reason in [('filled','pos_z','inferred_fill'),('lump','pos_x','surface_lumpy'),
                                 ('feature','pos_y','fine_feature')]:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as tmp:
                base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],kind)
                advice=self.advise(mesh,base/'out')
                self.assertGreater(len(advice['targets']),0)
                top=advice['targets'][0]
                self.assertEqual(top['side'],axis)
                self.assertEqual(top['reasonCode'],reason)
                self.assertFalse(top['render']['containsTexture'])
                self.assertTrue((base/'out'/top['render']['path']).read_bytes().startswith(b'\x89PNG'))
                self.assertGreater(top['distanceMm'],0)
                self.assertTrue(0<=top['expectedBenefitScore']<=100)

    def test_open_top_targets_opening_instead_of_incident_walls(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'open_top')
            advice=self.advise(mesh,base/'out')
            top=advice['targets'][0]
            self.assertEqual(top['side'],'pos_z')
            self.assertEqual(top['reasonCode'],'inferred_fill')
            for actual,expected in zip(top['targetMm'],[0,0,4]):
                self.assertAlmostEqual(actual,expected,places=4)
            for actual,expected in zip(top['viewDirection'],[0,0,1]):
                self.assertAlmostEqual(actual,expected,places=4)
            self.assertEqual(top['regionBoundsMm'],{'min':[-10,-6,4],'max':[10,6,4]})
            self.assertEqual(len(advice['targets']),1)

    def test_rotated_reference_mismatch_keeps_size_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'rotated_mismatch')
            advice=self.advise(mesh,base/'out')
            self.assertGreater(max(abs(e) for e in advice['specComparison']['errorMm']),1)
            checks=[t for t in advice['targets'] if t['reasonCode']=='size_check']
            self.assertEqual(len(checks),1)
            self.assertGreater(checks[0]['evidence']['faces'],0)

    def test_large_reconstructed_side_outranks_small_coarse_patch_without_texture(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'filled_competition')
            mesh.write_text('\n'.join(line for line in mesh.read_text().splitlines()
                                      if not line.startswith(('mtllib','usemtl')))+'\n')
            advice=self.advise(mesh,base/'out')
            self.assertEqual(advice['targets'][0]['side'],'pos_z')
            self.assertEqual(advice['targets'][0]['reasonCode'],'inferred_fill')

    def test_highlight_render_is_independent_of_texture_pixels(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'filled')
            first=self.advise(mesh,base/'red')
            def chunk(name,data):
                return struct.pack('>I',len(data))+name+data+struct.pack('>I',binascii.crc32(name+data)&0xffffffff)
            pixels=b'\x00'+bytes((0,0,0,255,255,255))+b'\x00'+bytes((0,30,255,255,255,255))
            (mesh.parent/'colour.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))+
                                                  chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b''))
            second=self.advise(mesh,base/'blue')
            self.assertNotEqual(first['inputs'],second['inputs'])
            self.assertEqual(first['targets'][0]['render']['sha256'],second['targets'][0]['render']['sha256'])

    def test_bounds_and_unknown_semantic_labels_are_rejected_before_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'filled')
            labels=base/'labels.json';labels.write_text('{"guessed_hinge":"Back"}')
            for extra in (['--max-targets','7'],['--resolution','2048'],['--axis-labels',str(labels)]):
                result=subprocess.run([sys.executable,str(ROOT/'correct.py'),'advise',str(mesh),'--units','mm',
                                       '--out',str(base/'out'),*extra],capture_output=True,text=True)
                self.assertEqual(result.returncode,2)
                self.assertFalse((base/'out/work').exists())

    def test_clean_mesh_repeatability_and_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=make_advice_fixture(base/'input',os.environ['BLENDER'],'filled')
            first=self.advise(mesh,base/'one');second=self.advise(mesh,base/'two')
            self.assertEqual(first,second)
            self.assertEqual((base/'one/advice.json').read_bytes(),(base/'two/advice.json').read_bytes())
            for target in first['targets']:
                self.assertEqual(hashlib.sha256((base/'one'/target['render']['path']).read_bytes()).hexdigest(),target['render']['sha256'])
            self.assertEqual(json.loads((base/'one/advice.json').read_text())['closeupAdvice'],first)
            schema=json.loads((ROOT/'closeup-advice.schema.json').read_text())
            self.assertEqual(schema['properties']['closeupAdvice']['properties']['schemaVersion']['const'],1)
            clean=make_advice_fixture(base/'clean',os.environ['BLENDER'],'clean')
            self.assertEqual(self.advise(clean,base/'no-defect')['targets'],[])
