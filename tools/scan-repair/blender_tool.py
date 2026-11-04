# SPDX-License-Identifier: GPL-3.0-or-later
"""Blender-side geometry core. All coordinates and dimensional parameters are mm."""
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import sys

import bpy
import bmesh
import numpy as np
import mathutils
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def write_json(path, data):
    Path(path).write_text(json.dumps(data, sort_keys=True, indent=2, allow_nan=False)+"\n")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path, scale):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    suffix = Path(path).suffix.lower()
    if suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=path, forward_axis="Y", up_axis="Z")
    elif suffix == ".stl":
        bpy.ops.wm.stl_import(filepath=path, forward_axis="Y", up_axis="Z")
    else:
        raise ValueError("only OBJ and STL inputs are supported")
    meshes = sorted((o for o in bpy.context.scene.objects if o.type=="MESH"), key=lambda o:o.name)
    if not meshes:
        raise ValueError("input has no mesh")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    for v in obj.data.vertices:
        v.co *= scale
        if not all(math.isfinite(x) for x in v.co):
            raise ValueError("nonfinite geometry")
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if not bm.faces or any(f.calc_area() <= 1e-14 for f in bm.faces):
        raise ValueError("empty or degenerate input faces")
    bm.normal_update()
    return obj,bm


def components(bm):
    remaining = set(bm.verts)
    groups = []
    for seed in bm.verts:
        if seed not in remaining:
            continue
        remaining.remove(seed)
        group, stack = {seed}, [seed]
        while stack:
            v = stack.pop()
            for edge in v.link_edges:
                other = edge.other_vert(v)
                if other in remaining:
                    remaining.remove(other)
                    group.add(other)
                    stack.append(other)
        groups.append(group)
    return groups


def axes(bm):
    coords = np.array([tuple(v.co) for v in bm.verts])
    centre = coords.mean(axis=0)
    eigenvalues, basis = np.linalg.eigh(np.cov(coords.T, bias=True))
    basis = basis[:,np.argsort(-eigenvalues)]
    for i in range(3):
        if basis[np.argmax(np.abs(basis[:,i])),i] < 0:
            basis[:,i] *= -1
    if np.linalg.det(basis)<0:
        basis[:,2] *= -1
    return coords, centre, basis


def box_frame(coords, centre, pca):
    """Bounded minimum-volume box search; hull preserves every support plane."""
    hull = bmesh.new()
    try:
        for co in coords:
            hull.verts.new(co)
        result = bmesh.ops.convex_hull(hull, input=list(hull.verts), use_existing_faces=False)
        points = np.array([tuple(v.co) for v in result["geom"]
                           if isinstance(v, bmesh.types.BMVert)]) - centre
    finally:
        hull.free()
    # Planar inputs can have zero volume; area then span break objective ties.
    def score(frame):
        ext = np.ptp(points @ frame, axis=0)
        return (float(np.prod(ext)), float(ext[0]*ext[1]+ext[1]*ext[2]+ext[0]*ext[2]),
                float(ext.sum()))

    def turn(axis, degrees):
        angle = math.radians(degrees)
        c, s = math.cos(angle), math.sin(angle)
        r = np.eye(3)
        i, j = (axis+1)%3, (axis+2)%3
        r[i,i] = r[j,j] = c
        r[i,j], r[j,i] = -s, s
        return r

    candidates = [(score(pca), pca), (score(np.eye(3)), np.eye(3))]
    # Coarse Euler sweep explores rotations away from the PCA basin.
    for x in range(0, 180, 30):
        for y in range(-90, 91, 30):
            for z in range(0, 180, 30):
                frame = pca @ turn(0,x) @ turn(1,y) @ turn(2,z)
                candidates.append((score(frame), frame))
    candidates.sort(key=lambda item: item[0])
    seeds = []
    for candidate in candidates:
        # Signed axis permutations are the same box; spend refinement on distinct seeds.
        if all(not np.all(np.max(np.abs(candidate[1].T @ other[1]),axis=0) > .999)
               for other in seeds):
            seeds.append(candidate)
        if len(seeds) == 4:
            break
    refined = []
    for value, frame in seeds:
        for step in (10, 2, .5, .1, .02, .005):
            for _ in range(40):
                trials = [(value, frame)]
                for axis in range(3):
                    for sign in (-1, 1):
                        rotated = frame @ turn(axis, step*sign)
                        trials.append((score(rotated), rotated))
                best_value, best_frame = min(trials, key=lambda item: item[0])
                if best_value >= value:
                    break
                value, frame = best_value, best_frame
        refined.append((value, frame))
    _, frame = min(refined, key=lambda item: item[0])
    # Stable output convention: long to short; deterministic signs; right handed.
    ext = np.ptp(points @ frame, axis=0)
    frame = frame[:,np.argsort(-ext, kind="stable")]
    for i in range(3):
        if frame[np.argmax(np.abs(frame[:,i])),i] < 0:
            frame[:,i] *= -1
    if np.linalg.det(frame) < 0:
        frame[:,2] *= -1
    return {"boxExtentsMm":np.ptp((coords-centre) @ frame,axis=0).tolist(),
            "boxRotation":frame.T.tolist(), "boxInputCentreMm":centre.tolist(),
            "boxMethod":"convex hull; PCA seed; 30deg rotation sweep; four seeds refined to 0.005deg"}


def stats(bm):
    coords, centre, basis = axes(bm)
    principal = (coords-centre) @ basis
    boundary = sum(e.is_boundary for e in bm.edges)
    nonmanifold = sum(not e.is_manifold for e in bm.edges)
    inconsistent = sum(e.is_manifold and not e.is_contiguous for e in bm.edges)
    closed = bool(bm.faces) and nonmanifold==0 and inconsistent==0
    # Object Capture closes unseen sides with a few huge faces whose sparse vertices skew PCA.
    areas = np.array([f.calc_area() for f in bm.faces])
    coarse = areas > 10*np.median(areas)
    return {"vertices":len(bm.verts),"faces":len(bm.faces),"edges":len(bm.edges),
            "components":len(components(bm)),"boundaryEdges":boundary,
            "nonManifoldEdges":nonmanifold,"inconsistentWindingEdges":inconsistent,
            "watertight":closed,"bboxMm":{"min":coords.min(axis=0).tolist(),
            "max":coords.max(axis=0).tolist(),"extents":np.ptp(coords,axis=0).tolist()},
            "principalExtentsMm":np.ptp(principal,axis=0).tolist(),
            "volumeMm3":abs(bm.calc_volume(signed=True)) if closed else None,
            "surfaceAreaMm2":sum(f.calc_area() for f in bm.faces),
            "coarseFillFaces":int(coarse.sum()),"coarseFillAreaMm2":float(areas[coarse].sum()),
            **box_frame(coords, centre, basis)}


def normals(bm):
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.normal_update()


def apply_modifier(obj,bm,kind, **params):
    bm.to_mesh(obj.data)
    modifier = obj.modifiers.new(kind,kind)
    for k,v in params.items():
        setattr(modifier,k,v)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bm.free()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    normals(bm)
    return bm


def umbrella(bm):
    """Per-vertex offset along the normal from the inverse-length weighted one-ring average (mm)."""
    bm.verts.index_update()
    co = np.array([tuple(v.co) for v in bm.verts]).reshape(-1,3)
    pairs = np.array([[v.index for v in e.verts] for e in bm.edges],dtype=np.int64).reshape(-1,2)
    i, j = np.concatenate([pairs[:,0],pairs[:,1]]), np.concatenate([pairs[:,1],pairs[:,0]])
    weight = 1/np.maximum(np.linalg.norm(co[j]-co[i],axis=1),1e-9)
    mean = np.stack([np.bincount(i,weight*co[j,k],len(co)) for k in range(3)],axis=1)
    mean /= np.maximum(np.bincount(i,weight,len(co)),1e-300)[:,None]
    normal = np.array([tuple(v.normal) for v in bm.verts]).reshape(-1,3)
    return ((co-mean)*normal).sum(axis=1), mean


OUTLIER_RATIO = 8
OUTLIER_FLOOR = .25


def drop_outliers(bm, movable, enabled=True):
    """Pull isolated single-vertex outliers on captured surface back to their one-ring average.

    A vertex is an outlier only when its offset is OUTLIER_RATIO times the median offset of the
    ring beyond its neighbours, at least OUTLIER_FLOOR of the median edge length, and three times
    its tallest neighbour's. Repeated relief (stitches, knurling, text) raises that outer ring, so
    it stays. Vertices on open boundaries or non-manifold edges are never pulled. Disabled, it
    reports the same fields with nothing removed."""
    offset, mean = umbrella(bm)
    size = abs(offset)
    floor = OUTLIER_FLOOR*float(np.median([e.calc_length() for e in bm.edges]))
    moved = []
    for v in bm.verts if enabled else ():
        k = v.index
        if movable[k] or size[k] < floor or not v.is_manifold or any(not e.is_manifold for e in v.link_edges):
            continue
        ring = {e.other_vert(v) for e in v.link_edges}
        if size[k] < 3*max(size[u.index] for u in ring):
            continue
        outer = {e.other_vert(u) for u in ring for e in u.link_edges}-ring-{v}
        if outer and size[k] > OUTLIER_RATIO*float(np.median([size[u.index] for u in outer])):
            moved.append((v,float(size[k])))
    spots = [[float(c) for c in v.co] for v,_ in moved]
    touched = np.zeros(len(size),dtype=bool)
    for v,_ in moved:
        touched[[v.index]+[e.other_vert(v).index for e in v.link_edges]] = True
    for v,_ in moved:
        v.co = Vector(mean[v.index])
    normals(bm)
    return {"ratio":OUTLIER_RATIO,"floorMm":floor,"removed":len(moved),
            "maxOffsetMm":max((m for _,m in moved),default=0.0),
            "inputPositionsMm":spots}, touched


def filled_vertices(bm):
    """Only inferred interior vertices are movable; the captured rim stays fixed."""
    bm.verts.index_update()
    marks = [l for l in (bm.faces.layers.int.get(INFERRED),bm.faces.layers.int.get(FILLED)) if l is not None]
    return np.array([bool(v.link_faces) and all(any(f[l]>0 for l in marks) for f in v.link_faces)
                     for v in bm.verts],dtype=bool)


def denoise(bm,a,region):
    # Taubin lambda|mu cycles: the negative mu pass undoes the shrinkage of each lambda pass.
    bm.verts.index_update()
    co = np.array([tuple(v.co) for v in bm.verts]).reshape(-1,3)
    original = co.copy()
    sharp = math.radians(a["sharp_angle_deg"])
    pairs = np.array([[v.index for v in e.verts] for e in bm.edges],dtype=np.int64).reshape(-1,2)
    locked = np.zeros(len(co),dtype=bool)
    locked[np.array([v.index for e in bm.edges if not e.is_manifold or e.calc_face_angle(0)>sharp
                     for v in e.verts],dtype=np.int64)] = True
    i, j = np.concatenate([pairs[:,0],pairs[:,1]]), np.concatenate([pairs[:,1],pairs[:,0]])
    free = ~locked & (np.bincount(i,minlength=len(co)) > 0) & region
    for _ in range(a["denoise_iterations"]):
        moved = co.copy()
        for step in (a["denoise_factor"],a["denoise_mu"]):
            # Inverse edge-length weights keep uneven scan tessellation from dragging vertices.
            weight = 1/np.maximum(np.linalg.norm(moved[j]-moved[i],axis=1),1e-9)
            total = np.bincount(i,weight,len(co))
            mean = np.stack([np.bincount(i,weight*moved[j,k],len(co)) for k in range(3)],axis=1)
            moved[free] += step*(mean/np.maximum(total,1e-300)[:,None]-moved)[free]
        # Clamp whole cycles: clipping only the lambda half would let mu inflate the vertex.
        delta = moved-original
        length = np.linalg.norm(delta,axis=1)
        co = original+delta*np.minimum(1,a["denoise_max_mm"]/np.maximum(length,1e-300))[:,None]
    for v in bm.verts:
        if free[v.index]:
            v.co = Vector(co[v.index])
    normals(bm)


INFERRED = "stm_inferred"
FILLED = "stm_hole_filled"


def coarse_regions(bm, crease, limit, layer):
    """Edge-connected untouched faces larger than limit, split at creases."""
    coarse = {f for f in bm.faces if not f[layer] and f.calc_area() > limit}
    regions, seen = [], set()
    for seed in bm.faces:
        if seed not in coarse or seed in seen:
            continue
        region, stack = [], [seed]
        seen.add(seed)
        while stack:
            face = stack.pop()
            region.append(face)
            for e in face.edges:
                if len(e.link_faces) == 2 and e.calc_face_angle(0) <= crease:
                    for other in e.link_faces:
                        if other in coarse and other not in seen:
                            seen.add(other)
                            stack.append(other)
        regions.append(region)
    return regions


def rim_loop(region):
    """Ordered rim vertices of a disk-shaped region, or None for any other topology."""
    inside = set(region)
    edges = list(dict.fromkeys(e for f in region for e in f.edges))
    rim = [e for e in edges if sum(g in inside for g in e.link_faces) == 1]
    verts = list(dict.fromkeys(v for f in region for v in f.verts))
    links = {}
    for e in rim:
        for v in e.verts:
            links.setdefault(v,[]).append(e)
    # Manifold, Euler characteristic 1 and simple rim vertices: a disk with one rim loop.
    if (not rim or any(len(e.link_faces) > 2 for e in edges) or len(verts)-len(edges)+len(region) != 1
            or any(len(x) != 2 for x in links.values())):
        return None
    loop, edge = [rim[0].verts[0]], rim[0]
    while True:
        v = edge.other_vert(loop[-1])
        if v == loop[0]:
            break
        loop.append(v)
        edge = links[v][0] if links[v][1] == edge else links[v][1]
    return loop if len(loop) == len(rim) else None


def simple_polygon(poly):
    """True when no two non-adjacent edges of the closed 2D polygon cross or touch."""
    a, b, n = poly, np.roll(poly,-1,axis=0), len(poly)
    eps = 1e-12*float(np.ptp(poly,axis=0).max())**2
    def side(p, q, r):
        value = (q[...,0]-p[...,0])*(r[...,1]-p[...,1])-(q[...,1]-p[...,1])*(r[...,0]-p[...,0])
        return np.where(np.abs(value) <= eps,0,np.sign(value))
    def within(p, q, r):
        return ((np.minimum(p[...,0],q[...,0]) <= r[...,0]) & (r[...,0] <= np.maximum(p[...,0],q[...,0])) &
                (np.minimum(p[...,1],q[...,1]) <= r[...,1]) & (r[...,1] <= np.maximum(p[...,1],q[...,1])))
    for i in range(n):
        j = np.array([k for k in range(n) if k not in (i,(i-1)%n,(i+1)%n)],dtype=np.int64)
        if not len(j):
            continue
        ai, bi = np.broadcast_to(a[i],(len(j),2)), np.broadcast_to(b[i],(len(j),2))
        d1, d2 = side(a[j],b[j],ai), side(a[j],b[j],bi)
        d3, d4 = side(ai,bi,a[j]), side(ai,bi,b[j])
        touch = ((d1*d2 < 0) & (d3*d4 < 0)) | ((d1 == 0) & within(a[j],b[j],ai)) | (
            (d2 == 0) & within(a[j],b[j],bi)) | ((d3 == 0) & within(ai,bi,a[j])) | ((d4 == 0) & within(ai,bi,b[j]))
        if np.any(touch):
            return False
    return True


def inside(points, poly):
    """Even-odd point-in-polygon test, vectorised over points."""
    a, b = poly, np.roll(poly,-1,axis=0)
    span = np.where(b[None,:,1] == a[None,:,1],1e-300,b[None,:,1]-a[None,:,1])
    crossing = ((a[None,:,1] > points[:,None,1]) != (b[None,:,1] > points[:,None,1])) & (
        points[:,None,0] < a[None,:,0]+(points[:,None,1]-a[None,:,1])*(b[None,:,0]-a[None,:,0])/span)
    return crossing.sum(axis=1)%2 == 1


def lattice(poly, target):
    """Triangular lattice at the target spacing inside the polygon, half a spacing from its rim."""
    lo, hi = poly.min(axis=0), poly.max(axis=0)
    rows = np.arange(lo[1],hi[1]+target,target*math.sqrt(3)/2)
    grid = np.array([(x+(k%2)*target/2,y) for k,y in enumerate(rows)
                     for x in np.arange(lo[0],hi[0]+target,target)]).reshape(-1,2)
    a, b = poly, np.roll(poly,-1,axis=0)
    d = b-a
    keep = []
    for chunk in np.array_split(grid,max(1,len(grid)*len(poly)//2000000)):
        t = np.clip(((chunk[:,None,:]-a[None])*d[None]).sum(2)/np.maximum((d*d).sum(1),1e-300)[None],0,1)
        gap = np.linalg.norm(chunk[:,None,:]-(a[None]+t[...,None]*d[None]),axis=2).min(axis=1)
        keep.append(chunk[inside(chunk,poly) & (gap > target/2)])
    return np.concatenate(keep)


def rebuild(bm, region, layer, target, ident, projection=None):
    """Replace a disk region with a constrained-Delaunay lattice patch on its best-fit plane.

    Rim vertices and edges belong to captured faces and are reused unchanged. Returns a
    reason when the region is skipped."""
    loop = rim_loop(region)
    if loop is None:
        return "not a disk"
    # Delete only the region's own faces, interior edges and interior vertices: rim
    # vertices on an open boundary belong to no other face but must survive.
    owned, rim = set(region), set(loop)
    edges = [e for e in dict.fromkeys(e for f in region for e in f.edges)
             if sum(g in owned for g in e.link_faces) == 2]
    verts = [v for v in dict.fromkeys(v for f in region for v in f.verts) if v not in rim]
    if any(g not in owned for v in verts for g in v.link_faces) or any(
            not e.link_faces for v in verts for e in v.link_edges):
        return "interior vertex touches captured geometry"
    normal = np.array(projection) if projection is not None else np.sum([np.array(f.normal)*f.calc_area() for f in region],axis=0)
    if not np.linalg.norm(normal):
        return "no dominant normal"
    # Float64 projection keeps collinear rim points exactly collinear (no rim slivers).
    normal /= np.linalg.norm(normal)
    axis = np.eye(3)[np.argmin(np.abs(normal))]
    u = axis-axis.dot(normal)*normal
    u /= np.linalg.norm(u)
    w = np.cross(normal,u)
    rim = np.array([tuple(v.co) for v in loop],dtype=np.float64)
    centre = rim.mean(axis=0)
    poly = (rim-centre) @ np.array([u,w]).T
    if not simple_polygon(poly):
        return "rim does not project to a simple polygon"
    plane = np.concatenate([poly,lattice(poly,target)])
    # Rim edges are constraints, so every hull triangle lies wholly inside or outside the rim.
    _, _, triangles, origin, _, _ = mathutils.geometry.delaunay_2d_cdt(
        [Vector(p) for p in plane],[(i,(i+1)%len(loop)) for i in range(len(loop))],[],0,target*1e-6,True)
    if sorted(o[0] for o in origin if len(o) == 1) != list(range(len(plane))):
        return "constrained triangulation changed the rim"
    ids = [[origin[k][0] for k in tri] for tri in triangles]
    ids = [t for t,keep in zip(ids,inside(np.array([plane[t].mean(axis=0) for t in ids]).reshape(-1,2),poly)) if keep]
    uses = {}
    for tri in ids:
        for k in range(3):
            key = (min(tri[k],tri[k-1]),max(tri[k],tri[k-1]))
            uses[key] = uses.get(key,0)+1
    rim_keys = {(min(i,(i+1)%len(loop)),max(i,(i+1)%len(loop))) for i in range(len(loop))}
    flat = [abs(np.cross(plane[b]-plane[a],plane[c]-plane[a])) <= 1e-12*target*target for a,b,c in ids]
    if any(flat) or any(uses.get(k) != 1 for k in rim_keys) or any(
            n != 2 for k,n in uses.items() if k not in rim_keys):
        return "constrained triangulation is not a manifold disk"
    bmesh.ops.delete(bm,geom=region,context="FACES_ONLY")
    bmesh.ops.delete(bm,geom=edges,context="EDGES_FACES")
    bmesh.ops.delete(bm,geom=[v for v in verts if v.is_valid],context="VERTS")
    made = [loop[o] if o < len(loop) else bm.verts.new(Vector(centre+u*plane[o][0]+w*plane[o][1]))
            for o in range(len(plane))]
    for tri in ids:
        bm.faces.new([made[k] for k in tri])[layer] = ident
    return None


def patch_edges(patch, layer):
    """Edges inside one patch. Rims, including creases between patches, stay fixed."""
    return [e for e in dict.fromkeys(e for f in patch for e in f.edges)
            if len(e.link_faces) == 2 and e.link_faces[0][layer] > 0 and
            e.link_faces[0][layer] == e.link_faces[1][layer]]


def fair(bm, layer, crease):
    """Fair patch vertices with rim and captured neighbours fixed.

    Minimises the inverse-length weighted umbrella over patch vertices (harmonic). With a
    crease angle, rim rows join (bi-Laplacian): the patch continues the captured curvature
    across two fixed rings, except at rim creases above the angle."""
    patch = [f for f in bm.faces if f[layer] > 0]
    edges = list(dict.fromkeys(e for f in patch for e in f.edges))
    inner = set(patch_edges(patch,layer))
    rim = [e for e in edges if e not in inner]
    rim_verts = list(dict.fromkeys(v for e in rim for v in e.verts))
    released = set(rim_verts) if crease is None else {
        v for e in rim if len(e.link_faces) != 2 or e.calc_face_angle(0) > crease for v in e.verts}
    fixed = set(rim_verts)
    unknown = [v for v in dict.fromkeys(v for f in patch for v in f.verts) if v not in fixed]
    if not unknown:
        return 0, 0.0
    column = {v:i for i,v in enumerate(unknown)}
    rows = unknown+[v for v in rim_verts if v not in released]
    row, col, val, known = [], [], [], np.zeros((len(rows),3))
    for r,v in enumerate(rows):
        others = [e.other_vert(v) for e in v.link_edges]
        weight = np.array([1/max((u.co-v.co).length,1e-9) for u in others])
        for u,w in [(v,-1.0),*zip(others,weight/weight.sum())]:
            if u in column:
                row.append(r); col.append(column[u]); val.append(w)
            else:
                known[r] += w*np.array(u.co)
    row, col, val = np.array(row), np.array(col), np.array(val)
    def forward(x):
        return np.stack([np.bincount(row,val*x[col,k],len(rows)) for k in range(3)],axis=1)
    def back(y):
        return np.stack([np.bincount(col,val*y[row,k],len(unknown)) for k in range(3)],axis=1)
    # Jacobi-preconditioned conjugate gradients on A^T A x = -A^T c, per coordinate.
    inverse = 1/np.maximum(np.bincount(col,val*val,len(unknown)),1e-300)[:,None]
    x = np.array([tuple(v.co) for v in unknown])
    b = -back(known)
    residual = b-back(forward(x))
    z = inverse*residual
    direction, rz, steps = z.copy(), (residual*z).sum(0), 0
    while steps < 20000 and np.any(np.linalg.norm(residual,axis=0) > 1e-13*np.maximum(np.linalg.norm(b,axis=0),1e-300)):
        product = back(forward(direction))
        alpha = rz/np.maximum((direction*product).sum(0),1e-300)
        x += alpha*direction
        residual -= alpha*product
        z = inverse*residual
        new = (residual*z).sum(0)
        direction = z+(new/np.maximum(rz,1e-300))*direction
        rz, steps = new, steps+1
    for v,p in zip(unknown,x):
        v.co = Vector(p)
    residual = float(np.max(np.linalg.norm(residual,axis=0)/np.maximum(np.linalg.norm(b,axis=0),1e-300)))
    return steps, residual


def refill_coarse(bm, a):
    crease = math.radians(a["fill_crease_deg"])
    # Adding a layer invalidates element references, so it precedes region collection.
    layer = bm.faces.layers.int.get(INFERRED) or bm.faces.layers.int.new(INFERRED)
    areas = [f.calc_area() for f in bm.faces]
    # One threshold for the whole pass; area-matched equilateral triangles for the patch.
    limit = 10*float(np.median(areas))
    target = math.sqrt(4*float(np.median(areas))/math.sqrt(3))
    faces = {f for r in coarse_regions(bm,crease,limit,layer) for f in r}
    # Captured vertices touch a face outside every coarse region; none may move.
    captured = [(v,v.co.copy()) for v in bm.verts if any(g not in faces for g in v.link_faces)]
    regions, removed, removed_area, skipped, surface = 0, 0, 0.0, [], []
    # Each patch gets its own id, so crease edges between neighbouring patches stay rim.
    # Regions are collected again after every swap because rebuilding edits the mesh.
    while True:
        pending = coarse_regions(bm,crease,limit,layer)
        if not pending:
            break
        region, regions = pending[0], regions+1
        area = sum(f.calc_area() for f in region)
        coarse = [[tuple(v.co) for v in f.verts] for f in region]
        reason = rebuild(bm,region,layer,target,regions)
        if reason:
            for f in region:
                f[layer] = -1
            skipped.append({"faces":len(region),"areaMm2":area,"reason":reason})
        else:
            removed, removed_area = removed+len(coarse), removed_area+area
            surface += coarse
    for f in bm.faces:
        if f[layer] < 0:
            f[layer] = 0
    # New faces need normals before fair() measures rim creases.
    normals(bm)
    steps, residual = fair(bm,layer,crease if a["fill_fairing"] == "biharmonic" else None) if removed else (0, 0.0)
    normals(bm)
    patch = [f for f in bm.faces if f[layer] > 0]
    # How far the faired surface departs from the coarse fill it replaced.
    tree = BVHTree.FromPolygons([p for f in surface for p in f],
                                [list(range(i,i+len(f))) for i,f in
                                 zip(np.cumsum([0]+[len(f) for f in surface[:-1]]).tolist(),surface)]) if surface else None
    offset = max((tree.find_nearest(v.co)[3] for v in dict.fromkeys(v for f in patch for v in f.verts)),default=0.0) if tree else 0.0
    return {"name":"refillCoarse","rule":"faces > 10x median area; edge-connected; split at creases",
            "creaseDeg":a["fill_crease_deg"],"fairing":a["fill_fairing"],"regions":regions,"refilled":regions-len(skipped),
            "skipped":skipped,"removedFaces":removed,"removedAreaMm2":removed_area,
            "inferredFaces":len(patch),"inferredAreaMm2":sum(f.calc_area() for f in patch),"targetEdgeMm":target,
            "method":"constrained-Delaunay lattice on the region plane; inverse-length weighted least-squares "
                     "fairing, rim fixed (biharmonic: captured ring fixed, crease rim rows released)",
            "solverIterations":steps,"solverRelativeResidual":residual,"solverConverged":residual <= 1e-13,
            "patchMaxOffsetMm":offset,
            "capturedMaxMoveMm":max(((v.co-co).length for v,co in captured),default=0.0)}


def deviation(original, repaired, count):
    # Area-stratified triangle samples with a fixed low-discrepancy barycentric sequence.
    tri = original.copy()
    bmesh.ops.triangulate(tri,faces=list(tri.faces))
    tree = BVHTree.FromBMesh(repaired)
    faces = list(tri.faces)
    areas = np.array([f.calc_area() for f in faces])
    cumulative = np.cumsum(areas)
    distances = []
    for i in range(count):
        f = faces[int(np.searchsorted(cumulative,(i+.5)/count*cumulative[-1]))]
        u = math.sqrt(((i+.5)*.6180339887498949)%1)
        v = ((i+.5)*.7548776662466927)%1
        p = f.verts[0].co*(1-u)+f.verts[1].co*(u*(1-v))+f.verts[2].co*(u*v)
        hit = tree.find_nearest(p)
        distances.append(hit[3])
    # Include vertices so tiny deleted floaters cannot evade the sample set.
    distances += [tree.find_nearest(v.co)[3] for v in original.verts]
    tri.free()
    return {"direction":"original-to-repaired-before-orientation","surfaceSamples":count,
            "vertexSamples":len(original.verts),"meanMm":float(np.mean(distances)),
            "p95Mm":float(np.percentile(distances,95)),"maxMm":max(distances)}


ORIENT_METHODS = {
    "box":"minimum-volume oriented box (boxRotation); long to short; ground Z=0; XY bbox centred",
    "pca":"vertex-PCA descending eigenvalues; deterministic signs; ground Z=0; XY bbox centred",
    "keep":"input frame; no rotation or translation"}


def orient(bm, frame):
    if frame == "keep":
        return {"frame":"keep","method":ORIENT_METHODS["keep"],"rotation":np.eye(3).tolist(),
                "inputCentreMm":[0.0,0.0,0.0],"translationMm":[0.0,0.0,0.0]}
    coords, centre, basis = axes(bm)
    if frame == "box":
        box = box_frame(coords, centre, basis)
        rotation, centre = Matrix(box["boxRotation"]), np.array(box["boxInputCentreMm"])
    else:
        rotation = Matrix(basis.T.tolist())
    for v in bm.verts:
        v.co = rotation @ (v.co-Vector(centre))
    coords = np.array([tuple(v.co) for v in bm.verts])
    shift = Vector((-(coords[:,0].min()+coords[:,0].max())/2,
                    -(coords[:,1].min()+coords[:,1].max())/2,-coords[:,2].min()))
    for v in bm.verts:
        v.co += shift
    return {"frame":frame,"method":ORIENT_METHODS[frame],"rotation":list(map(list,rotation)),
            "inputCentreMm":centre.tolist(),"translationMm":list(shift)}


def colour_sampler(obj, uv):
    """Cache base-colour pixels once; unsupported mappings supply no evidence."""
    materials = []
    for mat in obj.data.materials:
        node = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat and mat.node_tree else None
        base = node.inputs.get("Base Color") if node else None
        if base and base.is_linked:
            source = base.links[0].from_node
            if source.type != "TEX_IMAGE" or not source.image or source.inputs["Vector"].is_linked:
                materials.append(None); continue
            image = source.image; w,h = image.size
            if not w or not h or image.channels < 3:
                materials.append(None); continue
            pixels = np.array(image.pixels[:], dtype=np.float32).reshape(h,w,image.channels)[:,:,:3]
            # Blender exposes byte-image pixels in their declared colour space. Kd is linear.
            if image.colorspace_settings.name == "sRGB":
                pixels = np.where(pixels <= .04045, pixels/12.92, ((pixels+.055)/1.055)**2.4)
            elif image.colorspace_settings.name not in ("Linear Rec.709", "Linear", "Non-Color"):
                materials.append(None); continue
            materials.append((pixels, source.extension))
        else:
            materials.append(np.array(base.default_value[:3] if base else mat.diffuse_color[:3]) if mat else None)
    def sample(face):
        if face.material_index >= len(materials): return None
        data = materials[face.material_index]
        if not isinstance(data,tuple): return data
        pixels, extension = data; h,w,_ = pixels.shape
        point = sum((loop[uv].uv for loop in face.loops), Vector((0,0)))/len(face.loops)
        if not all(math.isfinite(v) for v in point): return None
        if extension == "REPEAT": point = Vector((point.x%1, point.y%1))
        elif extension == "CLIP":
            if any(v<0 or v>1 for v in point): return None
        elif extension != "EXTEND": return None
        x,y = min(w-1,max(0,int(point.x*w))), min(h-1,max(0,int(point.y*h)))
        return pixels[y,x]
    return sample

def trim_table_skirt(obj, bm, a):
    """Remove only a dark, thin, creased disk in the low support skirt.

    The cut is a replacement disk on the existing rim: all other faces and all
    rim vertices survive. Ambiguous regions stay, with the failed checks reported.
    """
    report={"name":"trimTableSkirt","removedFaces":0,"regions":[],"capturedMaxMoveMm":0.0,
            "rule":"low 30% (max 15 mm); inward thickness <= 10% height (max 5 mm); disk; area <= 2%; paired opposite faces; plane RMS <= 1.5 mm and total plane thickness <= local limit; >= 1/3 rim edges creased >=45deg; <=70% adjacent object brightness"}
    uv=bm.loops.layers.uv.active
    if not a.get("up_axis") or uv is None or a.get("table_skirt","auto")=="keep":
        report["skipped"]="requires authored up axis and texture, or explicitly kept";return report
    sample=colour_sampler(obj,uv)
    axis="XYZ".index(a["up_axis"]);low=min(v.co[axis] for v in bm.verts);height=max(v.co[axis] for v in bm.verts)-low
    if height<10:report["skipped"]="object too thin to distinguish from a table sheet";return report
    band=min(15,height*.3);thickness_limit=min(5,height*.1)
    mark=bm.faces.layers.int.get(INFERRED) or bm.faces.layers.int.new(INFERRED)
    bm.faces.ensure_lookup_table();bm.faces.index_update()
    tree=BVHTree.FromBMesh(bm);candidate=set();pairs={};total=sum(f.calc_area() for f in bm.faces)
    target=math.sqrt(4*float(np.median([f.calc_area() for f in bm.faces]))/math.sqrt(3))
    for f in bm.faces:
        if max(v.co[axis] for v in f.verts)>low+band:continue
        point=f.calc_center_median();hit,normal,index,_=tree.ray_cast(point-f.normal*.001,-f.normal)
        if hit is not None and (hit-point).length<=thickness_limit and normal.dot(f.normal)<-.25:
            other=bm.faces[index]
            if max(v.co[axis] for v in other.verts)>low+band:continue
            candidate.update((f,other));pairs.setdefault(f,set()).add(other);pairs.setdefault(other,set()).add(f)
    seen=set();regions=[]
    for f in bm.faces:
        if f not in candidate or f in seen:continue
        stack=[f];seen.add(f);region=[]
        while stack:
            g=stack.pop();region.append(g)
            neighbours={other for e in g.edges for other in e.link_faces}|pairs.get(g,set())
            for other in neighbours:
                if other in candidate and other not in seen:seen.add(other);stack.append(other)
        # Include the thin sheet's side walls when all of their vertices already belong
        # to its two observed sides. No outward ring growth into captured body faces.
        verts={v for f in region for v in f.verts}
        region=[f for f in bm.faces if all(v in verts for v in f.verts)]
        regions.append(region)
    for number,region in enumerate(regions,1):
        if len(region)<4 or any(not f.is_valid or f[mark] for f in region):continue
        owned=set(region);area=sum(f.calc_area() for f in region);loop=rim_loop(region)
        points=np.array([tuple(v.co) for v in dict.fromkeys(v for f in region for v in f.verts)])
        eigen,basis=np.linalg.eigh(np.cov(points.T));distance=(points-points.mean(axis=0))@basis[:,0]
        rms=float(np.sqrt(np.mean(distance**2)))
        boundary={e for f in region for e in f.edges if sum(g in owned for g in e.link_faces)==1}
        creased=sum(e.calc_face_angle(0)>=math.radians(45) for e in boundary)/max(1,len(boundary))
        visited=set(region);front=set(region)
        for _ in range(8):
            front={g for f in front for e in f.edges for g in e.link_faces}-visited;visited.update(front)
        donors=[f for f in visited-owned if f.normal[axis]>-.2 and f.calc_center_median()[axis]>low+4 and f not in candidate]
        bright=lambda faces:[float(np.mean(c)) for f in faces if (c:=sample(f)) is not None and np.isfinite(c).all()]
        dark,light=bright(region),bright(donors)
        ratio=float(np.median(dark)/np.median(light)) if dark and light and np.median(light)>0 else None
        reasons=[]
        if loop is None:reasons.append("not a separable disk")
        if area>total*.02:reasons.append("too much object surface")
        if rms>1.5 or float(np.ptp(distance))>thickness_limit:reasons.append("not a thin planar sheet")
        if creased<1/3:reasons.append("no clear attachment crease")
        if ratio is None or ratio>.7:reasons.append("not distinct from object colour")
        item={"faces":len(region),"areaMm2":area,"planeRmsMm":rms,"creasedBoundaryFraction":creased,
              "brightnessRatio":ratio,"boundsMm":[points.min(axis=0).tolist(),points.max(axis=0).tolist()],"reasons":reasons}
        report["regions"].append(item)
        if reasons:continue
        kept={v:v.co.copy() for v in bm.verts if any(f not in owned for f in v.link_faces)}
        # Reuse the existing bounded, disk-preserving repair primitive, not a clipping plane.
        reason=rebuild(bm,region,mark,target,100000+number)
        if reason == "rim does not project to a simple polygon":
            rim_points=np.array([tuple(v.co) for v in loop]);_,rim_basis=np.linalg.eigh(np.cov(rim_points.T))
            reason=rebuild(bm,region,mark,target,100000+number,projection=rim_basis[:,0])
            item["projection"]="best-fit rim plane"
        if reason:item["reasons"].append(reason);continue
        report["removedFaces"]+=len(region)
        report["capturedMaxMoveMm"]=max(report["capturedMaxMoveMm"],max(((v.co-co).length for v,co in kept.items()),default=0))
        normals(bm)
    return report


def fill_materials(obj, bm, a, declared):
    """Uniform inferred colour, sampled only from adjacent non-inferred object faces.

    Never sample a downward-facing face or the low table band. Missing trustworthy
    donors use neutral grey and are reported, rather than projecting table texture.
    This changes no captured face, position, UV or material assignment.
    """
    marks = [l for l in (bm.faces.layers.int.get(INFERRED), bm.faces.layers.int.get(FILLED)) if l is not None]
    guessed = {f for f in bm.faces if any(f[l] > 0 for l in marks)}
    uv = bm.loops.layers.uv.active
    if not guessed or uv is None:
        return {}, [], {"name":"fillMaterial", "faces":0, "donorFaces":0, "patches":[]}
    sample = colour_sampler(obj,uv)
    axis = "XYZ".index(a["up_axis"]) if a.get("up_axis") else None
    floor = min(v.co[axis] for v in bm.verts) if axis is not None else None
    band = max(2.0,min(10.0,(max(v.co[axis] for v in bm.verts)-floor)*.2)) if axis is not None else 2.0
    colours, assignments, patches, seen = [], {}, [], set()
    for seed in bm.faces:
        if seed not in guessed or seed in seen: continue
        patch, queue = [], [seed]; seen.add(seed)
        while queue:
            f=queue.pop();patch.append(f)
            for e in f.edges:
                for other in e.link_faces:
                    if other in guessed and other not in seen:seen.add(other);queue.append(other)
        frontier=set(patch);visited=set(patch);donors={}
        # Walk nearby face rings, never crossing into another inferred patch.
        for _ in range(24):
            frontier={g for f in frontier for e in f.edges for g in e.link_faces if g not in visited and g not in guessed}
            visited.update(frontier)
            for f in frontier:
                if axis is None or f.normal[axis] < -.2 or min(v.co[axis] for v in f.verts) <= floor+band:continue
                c=sample(f)
                if c is not None and np.isfinite(c).all():donors[f]=c
        samples=np.array(list(donors.values()))
        if len(samples):
            light=samples @ np.array([.2126,.7152,.0722])
            # Robust to dark stitch crevices/shadows; do not stretch a detailed texture.
            rgb=np.median(samples[light >= np.quantile(light,.5)],axis=0).clip(0,1)
        else:rgb=np.array([.5,.5,.5])
        name="stm_inferred_fill";suffix=0
        while name in declared or any(n==name for n,c in colours):suffix+=1;name=f"stm_inferred_fill_{suffix}"
        colours.append((name,rgb.tolist()))
        for f in patch:assignments[f]=name
        patches.append({"faces":len(patch),"donorFaces":len(donors),"colourLinearRgb":rgb.tolist(),
                        "fallback":None if donors else "no trustworthy adjacent object colour", "material":name})
    return assignments,colours,{"name":"fillMaterial","faces":len(assignments),"donorFaces":sum(p["donorFaces"] for p in patches),
                               "upAxis":a.get("up_axis"),"excludedTableBandMm":band,"patches":patches}


def export(bm,out,uv=False,libraries=(),materials=(),fill_names=None):
    """Write mm OBJ/STL; with uv, one vt per face corner keeps authored seams."""
    bm.verts.index_update()
    layer = bm.loops.layers.uv.active if uv else None
    inferred = bm.faces.layers.int.get(INFERRED)
    holes = bm.faces.layers.int.get(FILLED)
    ranges = []
    with (out/"repaired.obj").open("w") as f:
        f.write("# units: mm\n")
        if libraries:
            f.write("mtllib "+" ".join(libraries)+"\n")
        for v in bm.verts:
            f.write("v "+" ".join(format(c,".9g") for c in v.co)+"\n")
        if layer:
            for face in bm.faces:
                for loop in face.loops:
                    f.write("vt "+" ".join(format(c,".9g") for c in loop[layer].uv)+"\n")
        current, corner = None, 1
        for number,face in enumerate(bm.faces,1):
            guess = (inferred is not None and face[inferred] > 0) or (holes is not None and face[holes] > 0)
            if guess:
                # 1-based OBJ face ranges of inferred (re-filled) surface.
                if ranges and ranges[-1][1] == number-1:
                    ranges[-1][1] = number
                else:
                    ranges.append([number,number])
            name = materials[face.material_index] if face.material_index < len(materials) else None
            # Inferred faces carry no captured texture, even before any captured face.
            if guess and materials:
                name = (fill_names or {}).get(face,"unbound")
            # A face without a material after an assigned run needs an explicit reset,
            # as capture-mesh-convert writes; otherwise it inherits the previous texture.
            name = name or (current and "unbound")
            if name and name != current:
                f.write("usemtl "+name+"\n")
                current = name
            if layer:
                f.write("f "+" ".join("%d/%d" % (v.index+1,corner+i) for i,v in enumerate(face.verts))+"\n")
                corner += len(face.verts)
            else:
                f.write("f "+" ".join(str(v.index+1) for v in face.verts)+"\n")
    tri = bm.copy()
    bmesh.ops.triangulate(tri,faces=list(tri.faces))
    tri.normal_update()
    with (out/"repaired.stl").open("wb") as f:
        f.write(b"scan-repair preview; units mm".ljust(80,b"\0"))
        f.write(struct.pack("<I",len(tri.faces)))
        for face in tri.faces:
            f.write(struct.pack("<12fH",*face.normal,*(c for v in face.verts for c in v.co),0))
    tri.free()
    return ranges


def repair(obj,bm,a):
    before = stats(bm)
    original = bm.copy()
    ops = []
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=a["weld_mm"])
    ops.append({"name":"weld","distanceMm":a["weld_mm"]})
    removed = 0
    bm.verts.index_update()
    groups = components(bm)
    scores = []
    for group in groups:
        faces = [f for f in bm.faces if f.verts[0] in group]
        if a["component_metric"]=="volume":
            # Signed tetrahedron sum; reject volume ranking of open components.
            if any(not e.is_manifold for v in group for e in v.link_edges):
                raise ValueError("volume floater metric requires closed components; use area")
            keep = {v.index for v in group}
            part = bm.copy()
            bmesh.ops.delete(part,geom=[v for v in part.verts if v.index not in keep],context="VERTS")
            normals(part)
            score = abs(part.calc_volume(signed=True))
            part.free()
        else:
            score = sum(f.calc_area() for f in faces)
        scores.append(score)
    largest = max(scores)
    for group,score in zip(groups,scores):
        if score < largest*a["component_fraction"]:
            bmesh.ops.delete(bm,geom=list(group),context="VERTS")
            removed += 1
    ops.append({"name":"dropComponents","metric":a["component_metric"],"fractionOfLargest":a["component_fraction"],"removed":removed})
    normals(bm)  # Thickness rays need consistent outward winding before classification.
    ops.append(trim_table_skirt(obj,bm,a))
    # The layer precedes the fill: adding a layer invalidates element references.
    holes = bm.faces.layers.int.get(FILLED) or bm.faces.layers.int.new(FILLED)
    filled = bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=a["hole_max_edges"])
    for f in filled["faces"]:
        f[holes] = 1
    normals(bm)
    ops.append({"name":"fillHoles","maxEdges":a["hole_max_edges"],"facesAdded":len(filled["faces"])})
    if a["coarse_fill"] == "refill":
        ops.append(refill_coarse(bm,a))
    else:
        ops.append({"name":"refillCoarse","applied":False})
    fallback = a["force_voxel"] or not stats(bm)["watertight"]
    if fallback:
        extent = max(stats(bm)["bboxMm"]["extents"])
        if extent/a["voxel_size_mm"] > 512:
            raise ValueError("voxel grid exceeds 512 cells per longest axis; increase voxel size")
        bm.to_mesh(obj.data)
        obj.data.remesh_voxel_size = a["voxel_size_mm"]
        obj.data.remesh_voxel_adaptivity = 0
        bpy.ops.object.voxel_remesh()
        bm.free()
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        normals(bm)
    ops.append({"name":"voxelRemesh","applied":fallback,"forced":a["force_voxel"],"voxelSizeMm":a["voxel_size_mm"],"adaptivity":0})
    # Captured surface is measurement: by default only inferred interior vertices move.
    # A voxel remesh has already rebuilt every face, so then the whole surface is smoothed.
    captured = ~filled_vertices(bm)
    region = np.ones(len(captured),dtype=bool) if a["denoise_scope"] == "all" or fallback else ~captured
    relief, _ = umbrella(bm)
    start = np.array([tuple(v.co) for v in bm.verts]).reshape(-1,3)
    outliers, touched = drop_outliers(bm,region,enabled=a["denoise_iterations"] > 0)
    denoise(bm,a,region)
    after, _ = umbrella(bm)
    moved = np.linalg.norm(np.array([tuple(v.co) for v in bm.verts]).reshape(-1,3)-start,axis=1)
    # Relief is compared on captured vertices away from removed outliers, whose spikes would dominate it.
    kept = captured & ~touched
    rms = lambda x: float(np.sqrt(np.mean(x[kept]**2))) if kept.any() else 0.0
    ops.append({"name":"denoise","method":"Taubin lambda|mu cycles; inverse edge-length weights",
                "scope":"all" if region.all() else "filled","rebuiltByVoxelRemesh":fallback,
                "iterations":a["denoise_iterations"],"factor":a["denoise_factor"],"mu":a["denoise_mu"],
                "maxDisplacementMm":a["denoise_max_mm"],"sharpAngleDeg":a["sharp_angle_deg"],
                "movableVertices":int(region.sum()),"outliers":outliers,
                # Detail kept on captured surface: one-ring relief RMS before and after this step.
                "capturedRelief":{"vertices":int(kept.sum()),"rmsBeforeMm":rms(relief),"rmsAfterMm":rms(after),
                                  "ratio":rms(after)/rms(relief) if rms(relief) else 1.0,
                                  "maxMoveMm":float(moved[kept].max()) if kept.any() else 0.0}})
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    ops.append({"name":"triangulate","quadMethod":"BEAUTY","ngonMethod":"BEAUTY"})
    target = a["target_faces"]
    ratio = min(1,target/len(bm.faces)) if target else 1
    if ratio < 1:
        bm = apply_modifier(obj,bm,"DECIMATE",ratio=ratio,use_collapse_triangulate=True)
    ops.append({"name":"decimate","targetFaces":target,"ratio":ratio})
    normals(bm)
    ops.append({"name":"recalculateNormals","method":"consistent face winding"})
    if not stats(bm)["watertight"]:
        raise ValueError("repair could not produce topologically watertight geometry; no successful report")
    dev = deviation(original,bm,a["deviation_samples"])
    original.free()
    material = a.get("material") or {}
    fill_names, fill_colours, fill_report = fill_materials(obj,bm,a,material.get("names",[]))
    transform = orient(bm,a["orient"])
    ops.append({"name":"orient",**transform})
    # Remeshing and decimation rebuild the surface, so source UVs no longer describe it.
    material = a.get("material") or {}
    uv_note = ("input has no UVs" if bm.loops.layers.uv.active is None else
               "voxel remesh replaced the surface" if fallback else "decimation changed the surface" if ratio < 1 else None)
    files = [] if uv_note else material.get("files",[])
    declared = material.get("names",[])
    # Blender may suffix an imported material name (.001) when it already exists.
    # Undeclared names (such as the converter's `unbound`) keep their own name.
    names = [None if m is None else m.name.rpartition(".")[0]
             if m.name not in declared and m.name.rpartition(".")[0] in declared else m.name
             for m in obj.data.materials] if files else []
    out = Path(a["out"])
    out.mkdir(parents=True,exist_ok=True)
    if not files:
        fill_names,fill_colours = {},[]
        fill_report={"name":"fillMaterial","faces":0,"donorFaces":0,"patches":[],"skipped":uv_note or "no retained material library"}
    ops.append(fill_report)
    ranges = export(bm,out,fill_names=fill_names,uv=uv_note is None,libraries=material.get("libraries",[]) if files else [],materials=names)
    for name in files:
        shutil.copyfile(Path(material["stage"])/name,out/name)
    if fill_colours:
        with (out/material["libraries"][0]).open("a") as stream:
            for name,rgb in fill_colours:
                stream.write("\nnewmtl "+name+"\nKd "+" ".join(format(c,".9g") for c in rgb)+"\n")
    ops.append({"name":"export","uvRetained":uv_note is None,"uvNote":uv_note,
                "uvCorners":sum(len(f.loops) for f in bm.faces) if uv_note is None else 0,"materialFiles":files,
                "materialNote":"UVs not retained" if uv_note else material.get("note"),
                "inferredFaceRanges":ranges,
                "inferredNote":"voxel remesh rebuilt the surface; Blender carried the inferred marking over, approximately"
                if fallback and any(o.get("inferredFaces") for o in ops) else None})
    return {"schemaVersion":1,"blenderVersion":bpy.app.version_string,"provesPhysicalAccuracy":False,
            "previewOnly":True,"inputSha256":sha(a.get("import_path",a["input"])),"inputScaleMm":a["scale_mm"],
            "outputUnits":"mm","outputSha256":{n:sha(out/n) for n in ("repaired.obj","repaired.stl",*files)},
            "before":before,"after":stats(bm),"operations":ops,"deviation":dev,
            "limitations":["Topological watertightness does not detect self intersections or certify a valid solid.",
                           "Box and PCA frames are ambiguous for symmetric objects; neither infers semantic upright or print-bed placement.",
                           "One-sided sampled deviation can miss added geometry and unsampled defects.",
                           "Re-filled coarse regions (inferredFaceRanges) are inferred surface, not measured."]}


def strip_png_metadata(path):
    """Keep image chunks byte-for-byte; remove Blender wall-clock metadata."""
    raw = Path(path).read_bytes()
    clean = bytearray(raw[:8])
    offset = 8
    while offset < len(raw):
        length = struct.unpack_from(">I",raw,offset)[0]
        end = offset+length+12
        if raw[offset+4:offset+8] not in (b"tEXt",b"zTXt",b"iTXt",b"tIME",b"eXIf"):
            clean.extend(raw[offset:end])
        offset = end
    Path(path).write_bytes(clean)


def render(obj,bm,a):
    keep = a.get("keep_orientation", True)
    transform = None if keep else orient(bm,"pca")
    bm.to_mesh(obj.data)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (.65,.65,.65)
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = False
    scene.display.shading.show_specular_highlight = False
    scene.display.shading.background_type = "WORLD"
    scene.world.color = (.12,.12,.12)
    scene.render.resolution_x = scene.render.resolution_y = a["resolution"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    coords = [v.co for v in bm.verts]
    centre = sum(coords,Vector())/len(coords)
    radius = max((v-centre).length for v in coords)
    cam_data = bpy.data.cameras.new("canonical")
    cam = bpy.data.objects.new("canonical",cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = radius*2.4
    cam_data.clip_start = max(radius*.001,.0001)
    cam_data.clip_end = radius*20
    views = {"pos_x":(1,0,0),"neg_x":(-1,0,0),"pos_y":(0,1,0),"neg_y":(0,-1,0),
             "pos_z":(0,0,1),"neg_z":(0,0,-1),"iso_pp":(1,1,1),"iso_np":(-1,1,1),
             "iso_nn":(-1,-1,1),"iso_pn":(1,-1,1)}
    out = Path(a["out"])
    out.mkdir(parents=True,exist_ok=True)
    for name,direction in views.items():
        cam.location = centre+Vector(direction).normalized()*radius*5
        cam.rotation_euler = (centre-cam.location).to_track_quat("-Z","Y").to_euler()
        scene.render.filepath = str(out/(name+".png"))
        bpy.ops.render.render(write_still=True)
        strip_png_metadata(scene.render.filepath)
    return {"views":views,"resolution":a["resolution"],"provesPhysicalAccuracy":False,
            "orientation":"input" if keep else "pca", "transform":transform}


def main():
    a = json.loads(Path(sys.argv[sys.argv.index("--")+1]).read_text())
    obj,bm = load(a.get("import_path",a["input"]),a["scale_mm"])
    if a["command"]=="repair":
        result = repair(obj,bm,a)
        write_json(Path(a["out"])/"report.json",result)
    elif a["command"]=="measure":
        result = stats(bm)
        result["provesPhysicalAccuracy"] = False
    else:
        result = render(obj,bm,a)
    write_json(a["result"],result)


if __name__ == "__main__":
    main()
