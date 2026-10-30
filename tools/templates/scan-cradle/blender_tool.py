# SPDX-License-Identifier: GPL-3.0-or-later
"""Conservative voxel-column cube offset and upward sweep, using bundled tools."""
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

spec = importlib.util.spec_from_file_location('repair_core', Path(__file__).resolve().parents[2]/'scan-repair'/'blender_tool.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def clip(poly, axis, bound, sign):
    """Clip a 3D triangle to an XY half-plane, preserving linear Z."""
    out = []
    for a,b in zip(poly,poly[1:]+poly[:1]):
        da,db = sign*(a[axis]-bound),sign*(b[axis]-bound)
        if da >= 0:
            out.append(a)
        if (da >= 0) != (db >= 0):
            out.append(a+(b-a)*(da/(da-db)))
    return out


def generate(a):
    obj,bm = repair.load(a['input'],1)
    # Deterministic right-handed frame; no PCA or inferred semantic upright.
    up = a['up']
    idx = {'X':0,'Y':1,'Z':2}[up[-1]]
    sign = -1 if up.startswith('-') else 1
    for v in bm.verts:
        x = tuple(v.co)
        v.co = (x[(idx+1)%3],sign*x[(idx+2)%3],sign*x[idx])
    coords = np.array([tuple(v.co) for v in bm.verts])
    shift = np.array([(coords[:,0].min()+coords[:,0].max())/2,
                      (coords[:,1].min()+coords[:,1].max())/2,coords[:,2].min()])
    for v in bm.verts:
        v.co -= Vector(shift)
    repair.normals(bm)
    if not repair.stats(bm)['watertight']:
        raise ValueError('input must be repaired and watertight')
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    coords = np.array([tuple(v.co) for v in bm.verts])
    lo,hi = coords.min(axis=0),coords.max(axis=0)
    ext = hi-lo
    if min(ext) <= 1e-5:
        raise ValueError('input must have nonzero extent on every axis')
    c,w,g = a['clearance_mm'],a['wall_mm'],a['grid_mm']
    seat = ext[2]*a['seat_depth']
    # A cube offset contains the Euclidean clearance sphere. One extra grid
    # step covers interpolation between grid vertices, conservatively.
    radius = c+g
    outer = ext[:2]/2+c+a['margin_mm']
    nx,ny = [int(math.ceil(2*v/g)) for v in outer]
    if max(nx,ny)>512 or nx*ny>200000:
        raise ValueError('grid exceeds 512 per axis / 200000 cells; increase grid-mm')
    xs,ys = np.linspace(-outer[0],outer[0],nx+1),np.linspace(-outer[1],outer[1],ny+1)
    floor = np.full((nx+1,ny+1),seat)
    for face in bm.faces:
        tri = [np.array(v.co,dtype=float) for v in face.verts]
        low,high = np.min(tri,axis=0),np.max(tri,axis=0)
        if low[2]-c >= seat:
            continue
        ix = range(max(0,int(np.searchsorted(xs,low[0]-radius))),min(nx+1,int(np.searchsorted(xs,high[0]+radius,side='right'))))
        iy = range(max(0,int(np.searchsorted(ys,low[1]-radius))),min(ny+1,int(np.searchsorted(ys,high[1]+radius,side='right'))))
        for i in ix:
            for j in iy:
                poly = tri
                for axis,bound,s in ((0,xs[i]-radius,1),(0,xs[i]+radius,-1),(1,ys[j]-radius,1),(1,ys[j]+radius,-1)):
                    poly = clip(poly,axis,bound,s)
                    if not poly:
                        break
                if poly:
                    floor[i,j] = min(floor[i,j],min(v[2] for v in poly)-c)
    bottom = -c-w
    side = a['notch_side']
    if side:
        along = ys if side[-1]=='X' else xs
        pos,width = a['notch_position_mm'],a['notch_width_mm']
        if abs(pos)+width/2 > max(abs(along))-w-2*g:
            raise ValueError('notch would remove corner walls')
        mask = abs(along-pos)<=width/2+g
        if side=='+X': floor[xs>=0,:] = np.where(mask[None,:],-c,floor[xs>=0,:])
        if side=='-X': floor[xs<=0,:] = np.where(mask[None,:],-c,floor[xs<=0,:])
        if side=='+Y': floor[:,ys>=0] = np.where(mask[:,None],-c,floor[:,ys>=0])
        if side=='-Y': floor[:,ys<=0] = np.where(mask[:,None],-c,floor[:,ys<=0])
    verts = [(float(x),float(y),float(floor[i,j])) for i,x in enumerate(xs) for j,y in enumerate(ys)]
    index = lambda i,j: i*(ny+1)+j
    faces = []
    for i in range(nx):
        for j in range(ny):
            a0,b,d,e = index(i,j),index(i+1,j),index(i+1,j+1),index(i,j+1)
            faces.extend([(a0,b,d),(a0,d,e)])
    ring = ([index(i,0) for i in range(nx)]+[index(nx,j) for j in range(ny)]+
            [index(i,ny) for i in range(nx,0,-1)]+[index(0,j) for j in range(ny,0,-1)])
    base = len(verts)
    verts.extend([(verts[k][0],verts[k][1],bottom) for k in ring])
    for k,t in enumerate(ring):
        n = (k+1)%len(ring)
        faces.append((t,base+k,base+n,ring[n]))
    faces.append(tuple(reversed(range(base,len(verts)))))
    mesh = bpy.data.meshes.new('cradle')
    mesh.from_pydata(verts,[],faces)
    cradle = bmesh.new()
    cradle.from_mesh(mesh)
    bmesh.ops.triangulate(cradle,faces=list(cradle.faces))
    repair.normals(cradle)
    stats = repair.stats(cradle)
    if not stats['watertight']:
        raise ValueError('cradle topology failure')
    tree = BVHTree.FromBMesh(cradle)
    # Independent mesh-distance evidence, including deterministic interior samples.
    samples = [v.co.copy() for v in bm.verts]
    samples += [sum((v.co for v in f.verts),Vector())/3 for f in bm.faces]
    distances = [tree.find_nearest(p)[3] for p in samples]
    # All interior surfaces are a single-valued heightfield; measure thickness
    # to the exterior bottom and four side planes (opening excluded).
    thickness = []
    for i in range(1,nx):
        for j in range(1,ny):
            if floor[i,j]<seat-1e-8:
                ds = [floor[i,j]-bottom]
                for axis,coord in ((0,xs[i]),(1,ys[j])):
                    for s in (-1,1):
                        if side != ('+' if s==1 else '-')+'XY'[axis]:
                            ds.append(outer[axis]-s*coord)
                thickness.append(min(ds))
    out = Path(a['out'])
    with (out/'cradle.stl').open('wb') as f:
        f.write(b'scan-cradle preview; units mm'.ljust(80,b'\0'))
        f.write(struct.pack('<I',len(cradle.faces)))
        for face in cradle.faces:
            f.write(struct.pack('<12fH',*face.normal,*(c0 for v in face.verts for c0 in v.co),0))
    pocket = np.argwhere(floor<seat-1e-8)
    pocket_ext = [float(xs[min(nx,pocket[:,0].max()+1)]-xs[max(0,pocket[:,0].min()-1)]),float(ys[min(ny,pocket[:,1].max()+1)]-ys[max(0,pocket[:,1].min()-1)])]
    result = {'schemaVersion':1,'previewOnly':True,'provesPhysicalAccuracy':False,
              'blenderVersion':bpy.app.version_string,'units':'mm',
              'parameters':{k:v for k,v in a.items() if k not in ('input','out')},
              'inputSha256':repair.sha(a['input']),'outputSha256':{'cradle.stl':repair.sha(out/'cradle.stl')},
              'inputExtentsMm':ext.tolist(),'frame':{'up':up,'translationAfterAxisMapMm':(-shift).tolist()},
              'watertight':True,'sampledMinimumClearanceMm':min(distances),'clearanceSamples':len(samples),
              'sampledMinimumWallThicknessMm':min(thickness),'wallSamples':len(thickness),
              'footprintMm':(2*outer).tolist(),'heightMm':seat-bottom,'seatLineMm':seat,
              'pocketOpeningBoundsMm':pocket_ext,'liftOut':{'guaranteedByConstruction':True,'method':'single-valued lower envelope swept to +Z'},
              'method':'conservative voxel-column L-infinity offset; clipped triangles; upward sweep; triangulated heightfield',
              'limitations':['Cube offset and grid padding enlarge pocket beyond requested clearance.',
                             'Sampled mesh distances do not establish physical fit or manufacturing tolerance.',
                             'Notch is an intentional side opening, excluded from side-wall minimum.',
                             'Render helper uses PCA; render frame may differ from output Z-up frame.']}
    if min(distances)<.9*c or min(thickness)<w-1e-4:
        raise ValueError('sampled clearance or wall acceptance failed')
    repair.write_json(out/'manifest.json',result)


if __name__=='__main__':
    generate(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text()))
