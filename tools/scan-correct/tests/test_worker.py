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
from host import Worker, digest
from schema import validate
from fixtures import textured_box


class ValidationTests(unittest.TestCase):
    def test_rejects_raw_code_paths_unknown_fields_and_unbounded_values(self):
        for name,args in [('exec',{'code':'pass'}),('measure',{'path':'/etc/passwd'}),
                          ('remesh',{'voxel_mm':float('nan')}),('render',{'resolution':True}),
                          ('smooth',{'iterations':999,'factor':.5})]:
            with self.subTest(name=name),self.assertRaises(ValueError):
                validate(name,args)


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name)
        self.mesh=textured_box(self.base)
        self.worker=Worker(self.base/'job',seconds=120)
        self.initial=self.worker.stage(self.mesh,'mm')

    def operation(self,name,args):
        result=self.worker.apply(name,args)
        self.assertTrue(result['ok'])
        self.assertIn('boxExtentsMm',result['after'])
        self.assertIn('volumeDeltaMm3',result['effect'])
        self.assertFalse(result['provesPhysicalAccuracy'])
        return result

    def test_staging_rejects_other_material_asset_paths(self):
        (self.base/'fixture.mtl').write_text('newmtl colour\nmap_Bump ../../outside.png\n')
        with self.assertRaisesRegex(ValueError,'material'):
            Worker(self.base/'unsafe-job',seconds=30).stage(self.mesh,'mm')

    def test_geometry_effects_and_reference_box(self):
        # Hull/remesh deliberately replace topology: exercise them on an
        # untextured mesh rather than discarding a captured texture silently.
        plain=self.base/'plain.obj'
        lines=[]
        for line in self.mesh.read_text().splitlines():
            if line.startswith(('mtllib ', 'usemtl ', 'vt ')):continue
            if line.startswith('f '):line='f '+' '.join(p.split('/')[0] for p in line.split()[1:])
            lines.append(line)
        plain.write_text('\n'.join(lines)+'\n')
        self.worker=Worker(self.base/'plain-job',seconds=120)
        self.worker.stage(plain,'mm')
        self.operation('measure',{})
        self.operation('symmetrize',{'axis':'X','direction':'NEGATIVE','iterations':1})
        self.operation('convex_hull',{})
        self.operation('remesh',{'voxel_mm':1})
        result=self.operation('smooth',{'iterations':2,'factor':.2})
        self.assertAlmostEqual(result['before']['volumeMm3'],result['after']['volumeMm3'],delta=.01)
        result=self.operation('scale_to_reference',{'target_mm':[19,11,7]})
        for actual,expected in zip(result['after']['boxExtentsMm'],[19,11,7]):
            self.assertAlmostEqual(actual,expected,delta=.05)
        self.assertTrue(self.worker.export()['data']['artifacts'])

    def test_texture_features_regions_and_deviation(self):
        sampled=self.operation('sample_texture',{'count':1500,'seed':4})
        self.assertEqual(sampled['data']['samples'],1500)
        self.assertTrue(any(max(item['rgb'])-min(item['rgb'])>.1 for item in sampled['data']['preview']))
        features=self.operation('find_features',{'threshold':.1,'link_mm':2,'min_samples':3})
        self.assertGreater(len(features['data']['features']),0)
        classified=self.operation('classify_regions',{'saturation_min':.12})
        self.assertGreater(classified['data']['filledFaces'],0)
        deviation=self.operation('deviation',{'count':300,'seed':0})
        self.assertIn('captured',deviation['data']['directions']['source_to_corrected'])
        self.assertGreater(deviation['data']['directions']['source_to_corrected']['filled']['samples'],0)
        self.assertAlmostEqual(deviation['data']['directions']['source_to_corrected']['captured']['maxMm'],0,delta=1e-4)

    def test_feature_frame_from_measured_cluster_ids(self):
        self.operation('sample_texture',{'count':1000,'seed':0})
        result=self.operation('find_features',{'threshold':.1,'link_mm':.7,'min_samples':3})
        if len(result['data']['features'])<3:
            self.fail('synthetic evidence must contain three clusters')
        self.operation('feature_frame',{'origin_feature':0,'x_feature':1,'plane_feature':2})
        self.assertTrue(self.operation('measure',{})['after']['watertight'])

    def test_cuts_remove_volume_and_noop_fails_without_checkpoint(self):
        for kind in ('pocket','hole','slot','groove'):
            with self.subTest(kind=kind):
                args={'kind':kind,'axis':'Z','side':1,'centre_mm':[0,0,0],
                      'length_mm':2,'width_mm':2,'depth_mm':.5}
                result=self.operation('cut_feature',args)
                self.assertGreater(result['data']['removedVolumeMm3'],0)
        before=digest(self.base/'job'/'state.blend')
        with self.assertRaisesRegex(ValueError,'missed|failed'):
            self.worker.apply('cut_feature',{'kind':'hole','axis':'Z','side':1,'centre_mm':[500,500,0],
                                            'length_mm':2,'width_mm':2,'depth_mm':.5})
        self.assertEqual(digest(self.base/'job'/'state.blend'),before)

    def test_boolean_silent_noop_is_rejected(self):
        # Trusted test harness simulates Blender returning the unchanged operand.
        script=self.base/'noop_boolean.py'
        script.write_text("""import sys
sys.path.insert(0,sys.argv[-2])
import worker
worker.geometry.boolean=lambda *args,**kwargs: None
config={'directory':sys.argv[-1],'max_faces':200000,'sequence':20,'operation':'cut_feature',
        'args':{'kind':'pocket','axis':'Z','side':1,'centre_mm':[0,0,0],
                'length_mm':2,'width_mm':2,'depth_mm':.5}}
try:
    worker.execute(config)
except ValueError as exc:
    assert 'volume/topology' in str(exc),str(exc)
else:
    raise AssertionError('silent no-op boolean accepted')
""")
        before=digest(self.base/'job'/'state.blend')
        run=subprocess.run([sys.executable,'-I',str(ROOT/'sandbox.py'),os.environ['BLENDER'],'--background','--factory-startup','--python-exit-code','1',
                            '--python',str(script),'--',str(ROOT),str(self.base/'job')],capture_output=True,text=True)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        self.assertEqual(digest(self.base/'job'/'state.blend'),before)

    def test_absent_texture_and_unclassified_deviation_fail(self):
        with self.assertRaisesRegex(ValueError,'classify_regions'):
            self.worker.apply('deviation',{'count':100,'seed':0})
        plain=self.base/'plain.obj'
        plain.write_text('\n'.join(line for line in self.mesh.read_text().splitlines()
                                   if not line.startswith(('mtllib','usemtl')))+'\n')
        worker=Worker(self.base/'plain-job',seconds=30)
        worker.stage(plain,'mm')
        with self.assertRaisesRegex(ValueError,'texture'):
            worker.apply('sample_texture',{'count':100,'seed':0})

    def test_render_retains_frame_and_hashes(self):
        result=self.operation('render',{'resolution':32})
        self.assertEqual(result['data']['orientation'],'input')
        self.assertEqual(len(result['data']['artifacts']),10)

    def test_reference_rigid_frame_does_not_inflate_deviation(self):
        shifted=self.base/'shifted.obj'
        lines=[]
        for line in self.mesh.read_text().splitlines():
            parts=line.split()
            if parts and parts[0]=='v':
                line='v '+' '.join(str(float(x)+offset) for x,offset in zip(parts[1:],(100,200,300)))
            lines.append(line)
        shifted.write_text('\n'.join(lines)+'\n')
        worker=Worker(self.base/'shift-job',seconds=30)
        worker.stage(shifted,'mm')
        worker.apply('classify_regions',{'saturation_min':.12})
        worker.apply('scale_to_reference',{'target_mm':[20,12,8]})
        result=worker.apply('deviation',{'count':200,'seed':0})
        self.assertLess(result['data']['directions']['source_to_corrected']['captured']['maxMm'],.001)

    def test_polygon_and_grid_caps_fail_closed(self):
        with self.assertRaises(ValueError):
            self.worker.apply('remesh',{'voxel_mm':.05})
        with self.assertRaises(ValueError):
            Worker(self.base/'small',seconds=30,max_faces=4).stage(self.mesh,'mm')


if __name__=='__main__':
    unittest.main()
