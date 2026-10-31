# SPDX-License-Identifier: GPL-3.0-or-later
"""Fine synthetic texture features must survive bounded regional localization."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from host import Worker
from schema import validate
from fixtures import textured_box


@unittest.skipUnless(os.environ.get('BLENDER'),'set BLENDER=Blender 5.0.1')
class LocalizationTests(unittest.TestCase):
    def test_regional_sampling_recovers_small_holes_and_low_contrast_seam(self):
        from PIL import Image,ImageDraw
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);mesh=textured_box(base)
            # Same top UV face: 20 x 12 mm, three tiny holes plus a faint seam.
            image=Image.new('RGB',(1000,600),(245,245,245));draw=ImageDraw.Draw(image)
            for x in (650,750,850):draw.ellipse((x-10,290,x+10,310),fill=(20,20,20))
            draw.rectangle((0,145,999,155),fill=(205,205,205))
            image.save(base/'colour.png')
            w=Worker(base/'work',seconds=120);w.stage(mesh,'mm')
            w.apply('sample_texture_region',{'count':10000,'seed':2,'min_mm':[2,-1,3.99],'max_mm':[8,1,4.01]})
            samples=json.loads((base/'work/samples.json').read_text())
            self.assertEqual(len(samples),10000)
            self.assertTrue(all(2<=s['pointMm'][0]<=8 and -1<=s['pointMm'][1]<=1 and abs(s['pointMm'][2]-4)<1e-5 for s in samples))
            r=w.apply('find_features',{'threshold':.1,'link_mm':.18,'min_samples':20})
            holes=sorted(r['data']['features'],key=lambda f:f['centreMm'][0])
            self.assertEqual(len(holes),3)
            for f,x in zip(holes,(3,5,7)):
                self.assertAlmostEqual(f['centreMm'][0],x,delta=.06)
                self.assertAlmostEqual(f['extentsMm'][0],.4,delta=.06)
            w.apply('sample_texture_region',{'count':6000,'seed':2,'min_mm':[-10,2,3.99],'max_mm':[10,4,4.01]})
            r=w.apply('find_features',{'threshold':.1,'link_mm':.4,'min_samples':30,
                                     'contrast_min':.08,'contrast_radius_mm':.7})
            seam=r['data']['features'][0]
            self.assertGreater(seam['extentsMm'][0],19)
            self.assertAlmostEqual(seam['centreMm'][1],3,delta=.08)
            self.assertGreater(seam['principalSpansMm'][0],19)
            self.assertEqual(len(seam['principalAxes']),3)
            self.assertTrue(json.loads((base/'work/features.json').read_text())[0]['sampleIndices'])
            self.assertEqual(r['effect']['volumeDeltaMm3'],0)

    def test_features_transform_exactly_and_resampling_invalidates_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);w=Worker(base/'work',seconds=120);w.stage(textured_box(base),'mm')
            w.apply('sample_texture',{'count':1000,'seed':0})
            r=w.apply('find_features',{'threshold':.1,'link_mm':.7,'min_samples':3})
            w.apply('feature_frame',{'origin_feature':0,'x_feature':1,'plane_feature':2})
            features=json.loads((base/'work/features.json').read_text())
            samples=json.loads((base/'work/samples.json').read_text())
            for f in features:
                points=[samples[i]['pointMm'] for i in f['sampleIndices']]
                for axis in range(3):
                    span=max(p[axis] for p in points)-min(p[axis] for p in points)
                    self.assertAlmostEqual(f['extentsMm'][axis],span,delta=1e-5)
            w.apply('sample_texture',{'count':1000,'seed':1})
            self.assertFalse((base/'work/features.json').exists())
            with self.assertRaises(ValueError):w.apply('feature_frame',{'origin_feature':0,'x_feature':1,'plane_feature':2})

    def test_plane_fit_axes_frame_neutral_render_and_append_cap(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);w=Worker(base/'work',seconds=120);w.stage(textured_box(base),'mm')
            # Disconnected strips on x/z walls plus an elongated port, all synthetic.
            port=[[x,y,4] for x in (-2,-1,0,1,2) for y in (-.2,0,.2)]
            seam=[[-10,0,z] for z in (-4,-2,0,2,4)]+[[10,0,z] for z in (-4,-2,0,2,4)]
            outliers=[[0,3,0],[1,3,1]]
            points=port+seam+outliers
            (base/'work/samples.json').write_text(json.dumps([{'pointMm':p,'rgb':[0,0,0],'face':0} for p in points]))
            features=[{'id':0,'centreMm':[0,0,4],'sampleIndices':list(range(len(port))),
                       'principalAxes':[[1,0,0],[0,1,0],[0,0,1]],'principalRmsMm':[1.4,.2,0]},
                      {'id':1,'centreMm':[0,0,0],'sampleIndices':list(range(len(port),len(points)))}]
            (base/'work/features.json').write_text(json.dumps(features))
            plane=w.apply('fit_feature_plane',{'feature_ids':[1],'tolerance_mm':.05,'min_inlier_fraction':.7})['data']['feature']
            self.assertEqual(plane['samples'],len(seam))
            self.assertAlmostEqual(abs(plane['principalAxes'][2][1]),1,delta=1e-6)
            framed=w.apply('feature_frame',{'origin_feature':0,'x_feature':0,'plane_feature':2,'mode':'principal_axes'})
            self.assertEqual(framed['effect']['volumeDeltaMm3'],0)
            with self.assertRaisesRegex(ValueError,'inlier'):
                w.apply('fit_feature_plane',{'feature_ids':[1],'tolerance_mm':.05,'min_inlier_fraction':1})
            rendered=w.apply('render_features',{'feature_ids':[0,2],'view_direction':[0,0,1],'resolution':256})
            self.assertFalse(rendered['data']['containsTexture'])
            path=base/'work'/next(iter(rendered['data']['artifacts']))
            with Image.open(path) as image:
                self.assertEqual(image.size,(256,256))
                self.assertTrue(any(r>g*1.4 and r>b*2 for r,g,b in image.convert('RGB').getdata()))
            # Rendering never destroys retained source UV/material data.
            w.apply('sample_texture',{'count':100,'seed':1})
            w.apply('sample_texture_region',{'count':100,'seed':1,'min_mm':[-10,-6,-.01],'max_mm':[10,6,.01],'retain_samples':'append'})
            self.assertEqual(len(json.loads((base/'work/samples.json').read_text())),200)
            with self.assertRaisesRegex(ValueError,'cap'):
                w.apply('sample_texture',{'count':20000,'seed':1,'retain_samples':'append'})
            with self.assertRaisesRegex(ValueError,'no surface'):
                w.apply('sample_texture_region',{'count':100,'seed':1,'min_mm':[100,100,100],'max_mm':[101,101,101]})


class BoundsTests(unittest.TestCase):
    def test_invalid_region_is_rejected_before_worker(self):
        with self.assertRaisesRegex(ValueError,'region'):
            validate('sample_texture_region',{'count':100,'seed':0,'min_mm':[1,0,0],'max_mm':[0,1,1]})
