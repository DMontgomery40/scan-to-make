# SPDX-License-Identifier: GPL-3.0-or-later
"""Correction must carry captured texture through the exported result bundle."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fixtures import textured_box
from host import Worker, digest


def corners(path):
    vertices, uvs, result = [], [], set()
    material = None
    for line in path.read_text().splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == 'v':
            vertices.append(tuple(round(float(x), 6) for x in fields[1:4]))
        elif fields[0] == 'vt':
            uvs.append(tuple(round(float(x), 6) for x in fields[1:3]))
        elif fields[0] == 'usemtl':
            material = ' '.join(fields[1:])
        elif fields[0] == 'f':
            for field in fields[1:]:
                indices = field.split('/')
                if len(indices) > 1 and indices[1]:
                    result.add((vertices[int(indices[0])-1], uvs[int(indices[1])-1], material))
    return result


@unittest.skipUnless(os.environ.get('BLENDER'), 'set BLENDER=Blender 5.0.1')
class TextureExportTests(unittest.TestCase):
    def test_zero_edit_job_keeps_exact_obj_and_complete_hash_bound_material_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = textured_box(root)
            script = root/'no-edits.json'
            script.write_text(json.dumps([{'name': 'measure', 'arguments': {}}]))
            output = root/'result'
            run = subprocess.run([sys.executable, str(ROOT/'correct.py'), 'run', str(source),
                '--units', 'mm', '--out', str(output), '--adapter', 'scripted', '--script', str(script),
                '--max-seconds', '120'], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
            self.assertEqual((output/'corrected.obj').read_bytes(), source.read_bytes())
            report = json.loads((output/'report.json').read_text())
            for name in ('fixture.mtl', 'colour.png'):
                self.assertEqual((output/name).read_bytes(), (root/name).read_bytes())
                self.assertEqual(report['outputs'][name], digest(output/name))
            self.assertTrue(corners(output/'corrected.obj'))
            reopened = Worker(root/'reopened', seconds=60)
            reopened.stage(output/'corrected.obj', 'mm')
            sampled = reopened.apply('sample_texture', {'count': 100, 'seed': 4})
            self.assertTrue(any(max(p['rgb'])-min(p['rgb']) > .1 for p in sampled['data']['preview']))

    def test_unedited_non_mm_input_still_exports_millimetres(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worker = Worker(root/'job', seconds=120)
            initial = worker.stage(textured_box(root), 'cm')
            exported = worker.export()
            self.assertFalse(exported['data']['inputObjCopied'])
            reopened = Worker(root/'reopened', seconds=120)
            result = reopened.stage(worker.directory/'export/repaired.obj', 'mm')
            for before, after in zip(initial['after']['boxExtentsMm'], result['after']['boxExtentsMm']):
                self.assertAlmostEqual(before, after, delta=.001)

    def test_uv_destroying_edit_cannot_publish_a_grey_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            worker = Worker(root/'job', seconds=120)
            worker.stage(textured_box(root), 'mm')
            checkpoint = digest(worker.directory/'state.blend')
            for operation, arguments in [('remesh', {'voxel_mm': 1}), ('convex_hull', {})]:
                with self.assertRaisesRegex(ValueError, 'discard captured UVs'):
                    worker.apply(operation, arguments)
                self.assertEqual(digest(worker.directory/'state.blend'), checkpoint)
            worker.apply('measure', {})
            self.assertTrue(worker.export()['data']['inputObjCopied'])

    def test_material_assets_cannot_collide_with_job_outputs(self):
        reserved = ['work/texture.png', 'stills/texture.png', 'repaired.obj',
                    'REPAIRED.STL', 'corrected.obj', 'corrected.stl',
                    'report.json', 'tool-calls.jsonl']
        for name in reserved:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = textured_box(root)
                target = root/name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((root/'colour.png').read_bytes())
                (root/'fixture.mtl').write_text('newmtl colour\nmap_Kd '+name+'\n')
                with self.assertRaisesRegex(ValueError, 'reserved output'):
                    Worker(root/'job', seconds=60).stage(source, 'mm')

    def test_edited_multi_library_obj_reopens_with_separate_declarations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = textured_box(root)
            source.write_text('mtllib second.mtl\n'+source.read_text())
            (root/'second.mtl').write_text('newmtl another\nKd .5 .5 .5\n')
            worker = Worker(root/'job', seconds=120)
            worker.stage(source, 'mm')
            worker.apply('rigid_frame', {'rotation': [1,0,0,0,1,0,0,0,1], 'translation_mm': [0,0,1]})
            worker.export()
            output = worker.directory/'export/repaired.obj'
            self.assertEqual(set(line for line in output.read_text().splitlines() if line.startswith('mtllib ')),
                             {'mtllib fixture.mtl', 'mtllib second.mtl'})
            reopened = Worker(root/'reopened', seconds=60)
            reopened.stage(output, 'mm')
            sampled = reopened.apply('sample_texture', {'count': 100, 'seed': 4})
            self.assertTrue(any(max(p['rgb'])-min(p['rgb']) > .1 for p in sampled['data']['preview']))

    def test_cut_keeps_captured_corner_uvs_and_exported_texture_can_reopen(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = textured_box(root)
            expected = corners(source)
            worker = Worker(root/'job', seconds=120)
            worker.stage(source, 'mm')
            cut = worker.apply('cut_feature', {'kind': 'pocket', 'axis': 'Z', 'side': 1,
                'centre_mm': [0, 0, 0], 'length_mm': 2, 'width_mm': 2, 'depth_mm': .5})
            self.assertGreater(cut['data']['removedVolumeMm3'], 0)
            worker.export()
            output = worker.directory/'export'
            self.assertTrue(expected.issubset(corners(output/'repaired.obj')))
            # The pocket walls/floor are newly inferred, with no observed texture.
            vertices, material, inferred = [], None, 0
            for line in (output/'repaired.obj').read_text().splitlines():
                fields = line.split()
                if not fields:continue
                if fields[0] == 'v':vertices.append(tuple(map(float, fields[1:4])))
                elif fields[0] == 'usemtl':material = fields[1]
                elif fields[0] == 'f':
                    points = [vertices[int(f.split('/')[0])-1] for f in fields[1:]]
                    if any(abs(point[2]-3.5) < 1e-5 for point in points):
                        inferred += 1
                        self.assertEqual(material, 'unbound')
            self.assertGreater(inferred, 0)
            for name in ('fixture.mtl', 'colour.png'):
                self.assertEqual((output/name).read_bytes(), (root/name).read_bytes())
            reopened = Worker(root/'reopened', seconds=60)
            reopened.stage(output/'repaired.obj', 'mm')
            sampled = reopened.apply('sample_texture', {'count': 100, 'seed': 4})
            self.assertTrue(any(max(p['rgb'])-min(p['rgb']) > .1 for p in sampled['data']['preview']))


if __name__ == '__main__':
    unittest.main()
