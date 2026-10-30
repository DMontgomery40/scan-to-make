# SPDX-License-Identifier: GPL-3.0-or-later
"""Security boundaries must hold before any Blender invocation or asset copy."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from host import Worker
from fixtures import textured_box


class StagingSecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name)
        self.source=self.base/'source'
        self.source.mkdir()
        self.mesh=textured_box(self.source)
        self.outside=self.base/'private.png'
        self.outside.write_bytes((self.source/'colour.png').read_bytes())

    def reject(self, target, texture):
        self.mesh.write_text(self.mesh.read_text().replace('mtllib fixture.mtl','mtllib '+target))
        (self.source/target).write_text('newmtl colour\nmap_Kd '+texture+'\n')
        with patch('host.repair.find_blender',return_value='/unused/blender'),patch.object(Worker,'_run') as run:
            worker=Worker(self.base/'job')
            with self.assertRaises(ValueError):
                worker.stage(self.mesh,'mm')
            run.assert_not_called()
        self.assertFalse(any(p.is_file() for p in (self.base/'job').rglob('*')),
                         'rejected graph must stage no files')

    def test_non_mtl_absolute_texture_rejected_before_blender(self):
        self.reject('material.txt',str(self.outside))

    def test_parent_texture_escape_rejected_before_blender(self):
        self.reject('material.mtl','../private.png')

    def test_symlink_texture_escape_rejected_before_blender(self):
        (self.source/'escape.png').symlink_to(self.outside)
        self.reject('material.mtl','escape.png')

    def test_non_mtl_parent_texture_rejected_before_blender(self):
        self.reject('material.txt','../private.png')

    def test_non_mtl_symlink_texture_rejected_before_blender(self):
        (self.source/'escape.png').symlink_to(self.outside)
        self.reject('material.txt','escape.png')

    def test_explicit_override_is_snapshotted_under_staged_input(self):
        with patch('host.repair.find_blender',return_value='/unused/blender'),patch.object(Worker,'_run') as run:
            worker=Worker(self.base/'job')
            worker.stage(self.mesh,'mm',texture=self.outside)
            args=run.call_args.args[1]
        override=Path(args['texture'])
        self.assertTrue(override.is_relative_to(self.base/'job'/'input'))
        self.assertEqual(override.read_bytes(),self.outside.read_bytes())
        self.assertFalse(override.is_symlink())

    def test_absolute_texture_in_mtl_rejected_before_blender(self):
        self.reject('material.mtl',str(self.outside))

    def test_non_mtl_sibling_texture_rejected_before_blender(self):
        self.reject('material.txt','colour.png')


if __name__=='__main__':
    unittest.main()
