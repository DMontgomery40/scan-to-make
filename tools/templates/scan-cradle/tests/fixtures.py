# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic meshes only; run with Blender --python fixtures.py -- OUT."""
from pathlib import Path
import sys
import bpy
import bmesh


def fixtures(out):
    out.mkdir(parents=True,exist_ok=True)
    for name in ('airpods-spec','cylinder','overhang'):
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        if name=='airpods-spec':
            bpy.ops.mesh.primitive_cube_add(size=1)
            obj=bpy.context.object
            obj.dimensions=(60.6,45.2,21.7)
            bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
            mod=obj.modifiers.new('rounded','BEVEL')
            mod.width=5
            mod.segments=10
            bpy.ops.object.modifier_apply(modifier=mod.name)
        elif name=='cylinder':
            bpy.ops.mesh.primitive_cylinder_add(vertices=96,radius=15,depth=30)
            obj=bpy.context.object
        else:
            # Wide foot, narrow waist and wider shoulder: a normal boolean
            # negative traps this shape; the upward sweep must erase the lip.
            n=64
            import math
            verts=[(r*math.cos(2*math.pi*i/n),r*math.sin(2*math.pi*i/n),z)
                   for z,r in ((0,15),(4,15),(8,10),(14,13),(25,13)) for i in range(n)]
            faces=[tuple(reversed(range(n))),tuple(range(4*n,5*n))]
            faces += [(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(4) for i in range(n)]
            mesh=bpy.data.meshes.new(name)
            mesh.from_pydata(verts,[],faces)
            obj=bpy.data.objects.new(name,mesh)
            bpy.context.collection.objects.link(obj)
        bm=bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.triangulate(bm,faces=list(bm.faces))
        bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        bm.verts.index_update()
        low=min(v.co.z for v in bm.verts)
        with (out/(name+'.obj')).open('w') as f:
            for v in bm.verts:
                f.write('v %.9g %.9g %.9g\n' % (v.co.x,v.co.y,v.co.z-low))
            for face in bm.faces:
                f.write('f '+' '.join(str(v.index+1) for v in face.verts)+'\n')
        bm.free()


if __name__=='__main__':
    fixtures(Path(sys.argv[sys.argv.index('--')+1]))
