# SPDX-License-Identifier: GPL-3.0-or-later
"""Blender-side core for fitted templates: frame, silhouette pocket, rectilinear
voxel solids and fit evidence. All coordinates and lengths are mm."""
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

# Ray origins are nudged off grid lines so rays never graze shared mesh edges.
LATERAL_JITTER = Vector((1.1e-3, 0.7e-3, 0))
VERTICAL_JITTER = Vector((0, 0, 1.3e-3))


def request():
    return json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())


def to_frame(co, up, shift):
    """Same deterministic right-handed Z-up frame as scan-cradle."""
    idx = {'X':0,'Y':1,'Z':2}[up[-1]]
    sign = -1 if up.startswith('-') else 1
    x = tuple(co)
    return Vector((x[(idx+1)%3],sign*x[(idx+2)%3],sign*x[idx]))-Vector(shift)


def load(a):
    """Load the repaired mm mesh: chosen axis up, XY bounds centred, bottom at Z=0."""
    _,bm = repair.load(a['input'],1)
    for v in bm.verts:
        v.co = to_frame(v.co,a['up'],(0,0,0))
    coords = np.array([tuple(v.co) for v in bm.verts])
    shift = [(coords[:,0].min()+coords[:,0].max())/2,(coords[:,1].min()+coords[:,1].max())/2,coords[:,2].min()]
    for v in bm.verts:
        v.co -= Vector(shift)
    repair.normals(bm)
    if not repair.stats(bm)['watertight']:
        raise ValueError('input must be repaired and watertight')
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    coords = np.array([tuple(v.co) for v in bm.verts])
    ext = coords.max(axis=0)-coords.min(axis=0)
    if min(ext) <= 1e-5:
        raise ValueError('input must have nonzero extent on every axis')
    return bm,ext,[float(s) for s in shift]


def fill_diagonals(mask):
    """Grow a 2D cell mask until no two cells touch only at a corner, which
    would make the extruded solid non-manifold. Growth only adds cells."""
    while True:
        a,b,c,d = mask[:-1,:-1],mask[1:,1:],mask[1:,:-1],mask[:-1,1:]
        bad = (a&b&~c&~d)|(c&d&~a&~b)
        if not bad.any():
            return mask
        for i,j in np.argwhere(bad):
            mask[i:i+2,j:j+2] = True


def silhouette(bm, g, c, zmax, pad):
    """Cells of an integer XY grid (cell i spans [i*g,(i+1)*g]) whose square,
    grown by clearance c in L-infinity, meets the XY projection of any
    triangle that starts below zmax. Uncovered cells are therefore more than
    c from the projection in every direction. Returns (i0, j0, mask)."""
    tris = [np.array([tuple(v.co) for v in f.verts]) for f in bm.faces]
    tris = [t[:,:2] for t in tris if t[:,2].min() < zmax]
    pts = np.concatenate(tris)
    i0 = int(math.floor((pts[:,0].min()-c)/g))-1-pad
    j0 = int(math.floor((pts[:,1].min()-c)/g))-1-pad
    i1 = int(math.floor((pts[:,0].max()+c)/g))+2+pad
    j1 = int(math.floor((pts[:,1].max()+c)/g))+2+pad
    if (i1-i0) > 1024 or (j1-j0) > 1024 or (i1-i0)*(j1-j0) > 400000:
        raise ValueError('grid exceeds 1024 per axis / 400000 cells; increase grid-mm')
    mask = np.zeros((i1-i0,j1-j0),bool)
    h = g/2+c
    for p in tris:
        lo,hi = p.min(axis=0),p.max(axis=0)
        ia,ib = int(math.floor((lo[0]-c)/g))-1,int(math.floor((hi[0]+c)/g))+1
        ja,jb = int(math.floor((lo[1]-c)/g))-1,int(math.floor((hi[1]+c)/g))+1
        cx,cy = np.meshgrid((np.arange(ia,ib+1)+.5)*g,(np.arange(ja,jb+1)+.5)*g,indexing='ij')
        hit = (cx+h >= lo[0])&(cx-h <= hi[0])&(cy+h >= lo[1])&(cy-h <= hi[1])
        # Separating-axis test against each projected triangle edge normal.
        for k in range(3):
            e = p[(k+1)%3]-p[k]
            n = np.array((-e[1],e[0]))
            if not np.any(n):
                continue
            proj = p@n
            centre = cx*n[0]+cy*n[1]
            r = h*(abs(n[0])+abs(n[1]))
            hit &= (centre+r >= proj.min())&(centre-r <= proj.max())
        mask[ia-i0:ib+1-i0,ja-j0:jb+1-j0] |= hit
    return i0,j0,fill_diagonals(mask)


def cell_gap(di, dj):
    """Distance, in cells, between two grid squares offset by (di, dj)."""
    return np.hypot(np.maximum(np.abs(di)-1,0),np.maximum(np.abs(dj)-1,0))


def dilate(mask, g, w):
    """Every cell whose square lies within w of a masked square. Cells left
    out are strictly farther than w from the mask. Caller pads the array."""
    r = int(math.ceil(w/g))+1
    out = mask.copy()
    for di in range(-r,r+1):
        for dj in range(-r,r+1):
            if g*cell_gap(di,dj) <= w+1e-9:
                out |= np.roll(np.roll(mask,di,axis=0),dj,axis=1)
    return fill_diagonals(out)


def boundary(mask):
    p = np.pad(mask,1)
    inner = p[:-2,1:-1]&p[2:,1:-1]&p[1:-1,:-2]&p[1:-1,2:]
    return mask&~inner


def min_gap(a, b, g):
    """Exact minimum distance between two disjoint unions of grid squares."""
    ia,ib = np.argwhere(boundary(a)),np.argwhere(boundary(b))
    best = math.inf
    for k in range(0,len(ia),512):
        d = ia[k:k+512,None,:]-ib[None,:,:]
        best = min(best,float(cell_gap(d[...,0],d[...,1]).min()))
    return g*best


def rect_mask(shape, i0, i1, j0, j1):
    m = np.zeros(shape,bool)
    m[i0:i1,j0:j1] = True
    return m


def bbox_cells(mask):
    idx = np.argwhere(mask)
    return int(idx[:,0].min()),int(idx[:,0].max())+1,int(idx[:,1].min()),int(idx[:,1].max())+1


def solid(occ, xs, ys, zs, name):
    """Closed, outward-wound surface of a cell-occupancy array on a rectilinear
    grid. Only faces between solid and empty cells are emitted; vertices are
    shared by grid index, so the result is manifold unless cells touch only
    along an edge, which the caller's masks exclude and stats() re-checks."""
    padded = np.pad(occ,1).astype(np.int8)
    quads = []
    for axis in range(3):
        u,v = (axis+1)%3,(axis+2)%3
        diff = np.diff(padded,axis=axis)
        keep = [slice(1,-1)]*3
        keep[axis] = slice(None)
        diff = diff[tuple(keep)]
        for sign in (-1,1):
            idx = np.argwhere(diff == sign)
            if not len(idx):
                continue
            corners = []
            for du,dv in ((0,0),(1,0),(1,1),(0,1)):
                c = idx.copy()
                c[:,u] += du
                c[:,v] += dv
                corners.append(c)
            if sign == 1:
                corners.reverse()
            quads.append(np.stack(corners,axis=1))
    quads = np.concatenate(quads)
    keys,inverse = np.unique(quads.reshape(-1,3),axis=0,return_inverse=True)
    verts = np.stack([xs[keys[:,0]],ys[keys[:,1]],zs[keys[:,2]]],axis=1)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts.tolist(),[],inverse.reshape(-1,4).tolist())
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    repair.normals(bm)
    if not repair.stats(bm)['watertight']:
        raise ValueError(name+' topology failure')
    return bm


def grid_lines(start, count, g):
    return np.arange(start,start+count+1)*g


def write_stl(path, bm, label):
    with Path(path).open('wb') as f:
        f.write((label+' preview; units mm').encode().ljust(80,b'\0'))
        f.write(struct.pack('<I',len(bm.faces)))
        for face in bm.faces:
            f.write(struct.pack('<12fH',*face.normal,*(c for v in face.verts for c in v.co),0))


def samples(bm):
    return [v.co.copy() for v in bm.verts]+[sum((v.co for v in f.verts),Vector())/3 for f in bm.faces]


def finish(a, template, stl_name, source, ext, shift, part, fit, method, limitations):
    """Write STL and manifest with mesh-measured fit evidence; enforce acceptance."""
    out = Path(a['out'])
    write_stl(out/stl_name,part,template)
    tree = BVHTree.FromBMesh(part)
    points = samples(source)
    distances = [tree.find_nearest(p)[3] for p in points]
    blocked = sum(tree.ray_cast(p+LATERAL_JITTER,Vector((0,0,1)))[0] is not None for p in points)
    coords = np.array([tuple(v.co) for v in part.verts])
    lo,hi = coords.min(axis=0),coords.max(axis=0)
    stats = repair.stats(part)
    fit = dict(fit)
    fit.update({'designClearanceMm':a['clearance_mm'],'sampledMinimumClearanceMm':min(distances),
                'clearanceSamples':len(points),'liftOutRaysBlocked':blocked,
                'boundingBoxMm':{'min':lo.tolist(),'max':hi.tolist(),'extents':(hi-lo).tolist()}})
    result = {'schemaVersion':1,'template':template,'previewOnly':True,'provesPhysicalAccuracy':False,
              'blenderVersion':bpy.app.version_string,'units':'mm',
              'parameters':{k:v for k,v in a.items() if k not in ('input','out')},
              'inputSha256':repair.sha(a['input']),'outputSha256':{stl_name:repair.sha(out/stl_name)},
              'inputExtentsMm':[float(e) for e in ext],'frame':{'up':a['up'],'translationAfterAxisMapMm':[-s for s in shift]},
              'watertight':stats['watertight'],'mesh':{'vertices':stats['vertices'],'faces':stats['faces']},
              'fit':fit,'method':method,'limitations':limitations}
    if min(distances) < a['clearance_mm']-1e-4 or blocked:
        raise ValueError('sampled clearance or lift-out acceptance failed')
    if fit['minimumSideWallMm'] < a['wall_mm']-1e-6:
        raise ValueError('wall acceptance failed')
    repair.write_json(out/'manifest.json',result)
