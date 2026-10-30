# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic fixtures generated only in disposable test directories."""
import binascii
from pathlib import Path
import struct
import sys
import subprocess
import zlib


def textured_box(directory):
    directory = Path(directory)
    cube = [(-10,-6,-4),(10,-6,-4),(10,6,-4),(-10,6,-4),
            (-10,-6,4),(10,-6,4),(10,6,4),(-10,6,4)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    path = directory/'fixture.obj'
    path.write_text('mtllib fixture.mtl\n'+''.join('v %s %s %s\n'%v for v in cube)+
                    'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvt .25 .25\nusemtl colour\n'+
                    ''.join('f '+' '.join('%d/%d'%(vi+1,5 if fi==0 else i+1) for i,vi in enumerate(face))+'\n' for fi,face in enumerate(faces)))
    (directory/'fixture.mtl').write_text('newmtl colour\nKd 1 1 1\nmap_Kd -clamp off colour.png\n')
    def chunk(name,data):
        return struct.pack('>I',len(data))+name+data+struct.pack('>I',binascii.crc32(name+data)&0xffffffff)
    # Black and neutral-white evidence, plus a saturated synthetic fill-colour patch.
    pixels = b'\x00'+bytes((0,0,0,255,255,255))+b'\x00'+bytes((255,30,0,255,255,255))
    (directory/'colour.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,2,0,0,0))+
                                       chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b''))
    return path


def rounded_lumpy(directory, blender, missing_back=False):
    directory = Path(directory)
    script = directory/'make_fixture.py'
    output = directory/'lumpy.obj'
    script.write_text("""import bpy, math, sys
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=2)
obj=bpy.context.object
obj.scale=(30.3,22.6,10.85) if '--missing-back' in sys.argv else (31,23,11)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bevel=obj.modifiers.new('round','BEVEL')
bevel.width=4
bevel.segments=5
bpy.ops.object.modifier_apply(modifier=bevel.name)
for v in obj.data.vertices:
    v.co += v.normal * (.35*math.sin(v.co.x*.8)*math.cos(v.co.y*.7))
if '--missing-back' in sys.argv:
    import bmesh
    bm=bmesh.new(); bm.from_mesh(obj.data); bm.normal_update()
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.normal.z>.6],context='FACES')
    bm.to_mesh(obj.data);bm.free()
bpy.ops.wm.obj_export(filepath=sys.argv[-1],export_selected_objects=True,
                     forward_axis='Y',up_axis='Z',export_materials=False)
""")
    result = subprocess.run([sys.executable,'-I',str(Path(__file__).resolve().parents[1]/'sandbox.py'),blender,'--background','--factory-startup','--python-exit-code','1',
                             '--python',str(script),'--',*(['--missing-back'] if missing_back else []),str(output)],capture_output=True,text=True)
    if result.returncode:
        raise AssertionError(result.stdout+result.stderr)
    return output
