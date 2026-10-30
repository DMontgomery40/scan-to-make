# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise the merged converter, not a second implementation of its format."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from host import Worker


@unittest.skipUnless(os.environ.get('BLENDER') and importlib.util.find_spec('pxr') and importlib.util.find_spec('PIL'),
                     'converter bridge needs BLENDER and existing converter requirements')
class ConverterBridgeTests(unittest.TestCase):
    def test_merged_converter_assets_feed_texture_sampling(self):
        converter=ROOT.parent/'capture-mesh-convert'
        sys.path.insert(0,str(converter))
        spec=importlib.util.spec_from_file_location('capture_texture_fixtures',converter/'tests'/'test_textures.py')
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        fixture=module.TextureTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        package,_,_=fixture.fixture(wraps={'wrapS':'repeat','wrapT':'repeat'})
        obj=fixture.output/'capture.obj'
        report=module.convert(package,obj)
        self.assertTrue(report['metricQualified'])
        with tempfile.TemporaryDirectory() as tmp:
            worker=Worker(tmp,seconds=30)
            worker.stage(obj,'mm')
            result=worker.apply('sample_texture',{'count':1000,'seed':0})
            self.assertEqual(result['data']['samples'],1000)
            self.assertTrue(any(max(sample['rgb'])>.5 for sample in result['data']['preview']))
