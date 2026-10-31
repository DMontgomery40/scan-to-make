# SPDX-License-Identifier: GPL-3.0-or-later
"""Real Blender acceptance tests for the post-pick, texture-preserving union."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import bpy

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('printable', ROOT/'scan_printable.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def corners(path):
    verts=[];uvs=[];result=set();material=None
    for line in path.read_text().splitlines():
        fields=line.split()
        if not fields:continue
        if fields[0]=='v':verts.append(tuple(round(float(v),6) for v in fields[1:4]))
        elif fields[0]=='vt':uvs.append(tuple(round(float(v),6) for v in fields[1:3]))
        elif fields[0]=='usemtl':material=fields[1]
        elif fields[0]=='f':
            for item in fields[1:]:
                indices=item.split('/')
                if len(indices)>1 and indices[1]:result.add((verts[int(indices[0])-1],uvs[int(indices[1])-1],material))
    return result


class PrintableGeometry(unittest.TestCase):
    def fixture(self, root, centres, open_top=False):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        for centre in centres:
            bpy.ops.mesh.primitive_cube_add(size=10, location=centre)
            obj = bpy.context.object
            material = bpy.data.materials.get('captured') or bpy.data.materials.new('captured')
            obj.data.materials.append(material)
            if open_top:
                import bmesh
                bm=bmesh.new();bm.from_mesh(obj.data)
                bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.normal.z > .5],context='FACES')
                bm.to_mesh(obj.data);bm.free()
        bpy.ops.wm.obj_export(filepath=str(root/'corrected.obj'),forward_axis='Y',up_axis='Z',export_materials=False)
        path=root/'corrected.obj'
        path.write_text('mtllib mesh.mtl\nusemtl captured\n'+path.read_text())
        (root/'mesh.mtl').write_text('newmtl captured\nKd 1 0 0\n')
        return path

    def run_case(self, centres, open_top=False, variant=None):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        root=Path(tmp.name);self.fixture(root,centres,open_top)
        # Production imports into a fresh factory-startup process; discard the
        # fixture author's scene/materials so Blender does not suffix their names.
        bpy.ops.wm.read_factory_settings(use_empty=variant!='material')
        if variant=='material':
            for name in ('corrected.obj','mesh.mtl'):
                path=root/name;path.write_text(path.read_text().replace('captured','Material'))
            path=root/'corrected.obj';path.write_text('mtllib mesh.mtl\n'+path.read_text())
        if variant=='self-overlap':
            path=root/'corrected.obj';lines=[l for l in path.read_text().splitlines() if not l.startswith(('o ','g '))]
            vertices=[tuple(map(float,l.split()[1:4])) for l in lines if l.startswith('v ')]
            target=vertices.index((5,5,5))+1;shared=vertices.index((1,5,5))+1
            for i,line in enumerate(lines):
                if line.startswith('f '):
                    corners=[part.split('/') for part in line.split()[1:]]
                    for corner in corners:
                        if int(corner[0])==shared:corner[0]=str(target)
                    lines[i]='f '+' '.join('/'.join(c) for c in corners)
            path.write_text('\n'.join(lines)+'\n')
        if variant=='loose':
            path=root/'corrected.obj';path.write_text(path.read_text()+'v 4 4 4\n')
        out=root/'out';out.mkdir()
        result=worker.run({'input':str(root/'corrected.obj'),'output':str(out),
            'repairCore':str(ROOT/'blender_tool.py')})
        return root,out,result

    def test_overlapping_textured_shells_union_without_moving_exterior(self):
        root,out,r=self.run_case([(0,0,0),(6,0,0)])
        self.assertEqual(r['status'],'ready',r)
        self.assertEqual(r['before']['components'],2)
        self.assertEqual(r['after']['components'],1)
        self.assertTrue(r['after']['watertight'])
        self.assertEqual(r['selfIntersections'],0)
        self.assertLess(r['exteriorDeviationMm'],.0001)
        self.assertLess(r['boundsChangeMm'],.0001)
        self.assertAlmostEqual(r['after']['volumeMm3'],1600,places=3)
        self.assertIn('vt ',(out/'corrected.obj').read_text())
        self.assertIn('usemtl captured',(out/'corrected.obj').read_text())
        exterior={c for c in corners(root/'corrected.obj') if c[0][0] in (-5,11)}
        self.assertTrue(exterior)
        self.assertTrue(exterior.issubset(corners(out/'corrected.obj')))

    def test_overlapping_open_shells_are_translation_invariant(self):
        for z in (0,55,-55):
            _,_,r=self.run_case([(0,0,z),(6,0,z)],True)
            self.assertEqual(r['status'],'ready',r)
            self.assertAlmostEqual(r['after']['volumeMm3'],1600,places=3)
            self.assertLess(r['exteriorDeviationMm'],.0001)

    def test_default_material_collision_and_repeated_library_keep_binding(self):
        root,out,r=self.run_case([(0,0,0),(6,0,0)],variant='material')
        self.assertEqual(r['status'],'ready',r)
        text=(out/'corrected.obj').read_text()
        self.assertIn('usemtl Material\n',text)
        self.assertNotIn('Material.001',text)
        self.assertEqual([l for l in text.splitlines() if l.startswith('mtllib')],['mtllib mesh.mtl'])

    def test_loose_vertices_do_not_create_empty_solid_components(self):
        _,_,r=self.run_case([(0,0,0),(6,0,0)],variant='loose')
        self.assertEqual(r['status'],'ready',r)

    def test_connected_self_overlap_discards_only_internal_walls(self):
        _,_,r=self.run_case([(0,0,0),(6,0,0)],variant='self-overlap')
        self.assertEqual(r['before']['components'],1)
        self.assertGreater(r['inputSelfIntersections'],0)
        self.assertEqual(r['status'],'ready',r)
        self.assertEqual(r['after']['components'],1)
        self.assertTrue(r['after']['watertight'])
        self.assertLess(r['exteriorDeviationMm'],.0001)

    def test_containment_handles_concave_and_acute_edges(self):
        from mathutils import Vector
        from mathutils.bvhtree import BVHTree
        for polygon,inside,outside in [
            ([(-3,-3),(3,-3),(3,-2),(-2,-2),(-2,3),(-3,3)],(-2.5,0,0),(0,0,0)),
            ([(0,0),(10,0),(.1,.1)],(.1,.02,0),(5,.06,0))]:
            n=len(polygon);vertices=[(x,y,z) for z in (-1,1) for x,y in polygon]
            faces=[list(reversed(range(n))),list(range(n,2*n))]+[[i,(i+1)%n,(i+1)%n+n,i+n] for i in range(n)]
            tree=BVHTree.FromPolygons(vertices,faces)
            self.assertTrue(worker.contains(tree,Vector(inside)))
            self.assertFalse(worker.contains(tree,Vector(outside)))

    def test_closed_single_shell_is_byte_identical(self):
        root,out,r=self.run_case([(123,45,6)])
        self.assertEqual(r['status'],'ready',r)
        self.assertEqual((out/'corrected.obj').read_bytes(),(root/'corrected.obj').read_bytes())
        self.assertAlmostEqual(r['after']['volumeMm3'],1000,places=3)

    def test_disjoint_shells_are_reported_without_invented_bridges(self):
        root,out,r=self.run_case([(0,0,0),(20,0,0)])
        self.assertEqual(r['status'],'blocked')
        self.assertIn('disconnected-shells',r['problems'])
        self.assertFalse((out/'corrected.stl').exists())

    def test_shells_touching_only_at_a_vertex_do_not_claim_manifold(self):
        root,out,r=self.run_case([(0,0,0),(10,10,10)])
        self.assertEqual(r['status'],'blocked',r)
        self.assertFalse((out/'corrected.stl').exists())

    def test_opening_fills_are_untextured_and_rim_does_not_move(self):
        root,out,r=self.run_case([(0,0,0)],True)
        self.assertEqual(r['status'],'ready',r)
        self.assertTrue(r['after']['watertight'])
        self.assertAlmostEqual(r['filledAreaMm2'],100,places=4)
        self.assertIn('usemtl unbound',(out/'corrected.obj').read_text())
        self.assertLess(r['exteriorDeviationMm'],.0001)


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PrintableGeometry))
    sys.exit(0 if result.wasSuccessful() else 1)
