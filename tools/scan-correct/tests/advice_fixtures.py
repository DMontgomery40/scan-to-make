# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic dense surfaces, one coarse fill, one lump or one small pocket."""
from pathlib import Path
import subprocess
import sys
from fixtures import textured_box


def make_advice_fixture(directory, blender, kind):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    path=textured_box(directory)
    script=directory/'make.py'
    script.write_text("""import bpy,bmesh,sys,math
kind,path=sys.argv[-2:]
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=2)
obj=bpy.context.object;obj.scale=(10,6,4)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bm=bmesh.new();bm.from_mesh(obj.data)
bmesh.ops.subdivide_edges(bm,edges=list(bm.edges),cuts=12,use_grid_fill=True)
bm.normal_update()
if kind in ('filled','filled_competition'):
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.normal.z>.9],context='FACES')
    bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=0)
if kind=='filled_competition':
    bm.normal_update()
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.normal.x<-.9 and abs(f.calc_center_median().y)<3 and abs(f.calc_center_median().z)<2],context='FACES')
    bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=0)
if kind=='lump':
    for v in bm.verts:
        if v.co.x>9.99:
            v.co.x+=1.3*math.exp(-(v.co.y*v.co.y+v.co.z*v.co.z)/2)
bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
bm.to_mesh(obj.data);bm.free()
if kind=='feature':
    bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=.7,depth=2.2,location=(0,5.6,0),rotation=(math.pi/2,0,0))
    cutter=bpy.context.object;bpy.context.view_layer.objects.active=obj
    modifier=obj.modifiers.new('synthetic-pocket','BOOLEAN');modifier.object=cutter;modifier.solver='EXACT'
    bpy.ops.object.modifier_apply(modifier=modifier.name);bpy.data.objects.remove(cutter,do_unlink=True)
bm=bmesh.new();bm.from_mesh(obj.data);bm.normal_update()
uv=bm.loops.layers.uv.verify()
for f in bm.faces:
    point=(.25,.25) if kind in ('filled','filled_competition') and f.normal.z>.9 and f.calc_area()>10 else (.75,.75)
    for loop in f.loops:loop[uv].uv=point
bm.to_mesh(obj.data);bm.free()
bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
bpy.ops.wm.obj_export(filepath=path,forward_axis='Y',up_axis='Z',export_selected_objects=True,export_materials=False)
""")
    result=subprocess.run([sys.executable,'-I',str(Path(__file__).resolve().parents[1]/'sandbox.py'),blender,
                           '--background','--factory-startup','--python-exit-code','1','--python',str(script),
                           '--',kind,str(path)],capture_output=True,text=True)
    if result.returncode:raise AssertionError(result.stdout+result.stderr)
    path.write_text('mtllib fixture.mtl\nusemtl colour\n'+path.read_text())
    return path
