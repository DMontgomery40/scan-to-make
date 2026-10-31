# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted geometry implementations; only bounded parameters reach these functions."""
import math
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def symmetry(bm, axis, direction, iterations):
    index = 'XYZ'.index(axis)
    for _ in range(iterations):
        mirror = bm.copy()
        try:
            scale = [1,1,1]
            scale[index] = -1
            bmesh.ops.scale(mirror,verts=list(mirror.verts),vec=scale)
            bmesh.ops.reverse_faces(mirror,faces=list(mirror.faces))
            tree = BVHTree.FromBMesh(mirror)
            moved = []
            for vertex in bm.verts:
                nearest = tree.find_nearest(vertex.co)[0]
                if nearest is None:
                    raise ValueError('mirror surface missing')
                moved.append((vertex.co+nearest)/2)
            for vertex,point in zip(bm.verts,moved):
                vertex.co = point
        finally:
            mirror.free()
    bmesh.ops.symmetrize(bm,input=list(bm.verts)+list(bm.edges)+list(bm.faces),
                        direction=('-' if direction=='NEGATIVE' else '')+axis,dist=1e-5)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))


def hull(bm):
    output = bmesh.new()
    for vertex in bm.verts:
        output.verts.new(vertex.co)
    result = bmesh.ops.convex_hull(output,input=list(output.verts),use_existing_faces=False)
    remove = [g for g in set(result['geom_interior']+result['geom_unused']) if isinstance(g,bmesh.types.BMVert)]
    bmesh.ops.delete(output,geom=remove,context='VERTS')
    bmesh.ops.recalc_face_normals(output,faces=list(output.faces))
    return output


def smooth(bm, iterations, factor):
    if len(bm.verts)*iterations > 3000000:
        raise ValueError('smooth work cap exceeded')
    before = abs(bm.calc_volume(signed=True))
    if before <= 1e-8 or any(not edge.is_manifold for edge in bm.edges):
        raise ValueError('volume-preserving smooth requires a closed volume')
    for _ in range(iterations):
        bmesh.ops.smooth_vert(bm,verts=list(bm.verts),factor=factor,use_axis_x=True,use_axis_y=True,use_axis_z=True)
    after = abs(bm.calc_volume(signed=True))
    if after <= 1e-8:
        raise ValueError('smoothing collapsed volume')
    centre = sum((v.co for v in bm.verts),Vector())/len(bm.verts)
    factor = (before/after)**(1/3)
    for vertex in bm.verts:
        vertex.co = centre+(vertex.co-centre)*factor


def feature_frame(features, args):
    if max(args[k] for k in ('origin_feature','x_feature','plane_feature'))>=len(features):
        raise ValueError('feature ID not present in current evidence')
    origin = Vector(features[args['origin_feature']]['centreMm'])
    if args.get('mode','centres')=='principal_axes':
        xf,pf=features[args['x_feature']],features[args['plane_feature']]
        xs,ps=xf['principalRmsMm'],pf['principalRmsMm']
        if xs[0]<.01 or ps[1]<.01 or xs[0]<1.5*xs[1] or ps[1]<.1*ps[0] or ps[2]>.3*ps[1]:
            raise ValueError('feature axes require an elongated cluster and a non-collinear planar cluster')
        x=Vector(xf['principalAxes'][0]);y=Vector(pf['principalAxes'][2])
        if abs(x.dot(y))>.25:
            raise ValueError('feature long axis and plane normal disagree')
    else:
        x = Vector(features[args['x_feature']]['centreMm'])-origin
        y = Vector(features[args['plane_feature']]['centreMm'])-origin
    if x.length < .01 or x.cross(y).length < .01:
        raise ValueError('feature datums are coincident/collinear')
    x.normalize()
    z = x.cross(y).normalized()
    y = z.cross(x).normalized()
    return Matrix((x,y,z)),origin


def cutter_mesh(name, points, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(points,[],faces)
    mesh.update()
    obj = bpy.data.objects.new(name,mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def boolean(obj, cutter, operation='DIFFERENCE'):
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new('bounded-cut','BOOLEAN')
    modifier.operation,modifier.solver,modifier.object = operation,'EXACT',cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def cut(obj, bm, args, core):
    axis = 'XYZ'.index(args['axis'])
    u = 'XYZ'.index(args['length_axis']) if 'length_axis' in args else (axis+1)%3
    v = next(i for i in range(3) if i not in (axis,u))
    transverse_sign = 1 if (u-axis)%3==1 else -1
    side = args['side']
    centre = Vector(args['centre_mm'])
    coords = np.array([tuple(vertex.co) for vertex in bm.verts])
    span = float(np.ptp(coords,axis=0).max())
    tree = BVHTree.FromBMesh(bm)
    # Groove locates a perimeter at the requested plane; other cuts locate an axial surface.
    ray_axis = u if args['kind']=='groove' else axis
    start = centre.copy()
    start[ray_axis] = float(coords[:,ray_axis].max()+span) if side==1 else float(coords[:,ray_axis].min()-span)
    direction = Vector((0,0,0))
    direction[ray_axis] = -side
    hit = tree.ray_cast(start,direction,span*4)[0]
    if hit is None:
        raise ValueError('feature ray missed surface')
    before = core.stats(bm)
    if not before['watertight']:
        raise ValueError('feature cuts require watertight input')
    bm.to_mesh(obj.data)
    tools = []
    try:
        depth,width,length = args['depth_mm'],args['width_mm'],args['length_mm']
        if args['kind']=='groove':
            if len(bm.faces)*3 > 1000000:
                raise ValueError('groove work cap exceeded')
            inset = bm.copy()
            inset.normal_update()
            for vertex in inset.verts:
                vertex.co -= vertex.normal*depth
            inner_mesh = bpy.data.meshes.new('inset')
            inset.to_mesh(inner_mesh)
            inset.free()
            inner = bpy.data.objects.new('inset',inner_mesh)
            bpy.context.collection.objects.link(inner)
            tools.append(inner)
            if any(s <= depth*2 for s in np.ptp(coords,axis=0)):
                raise ValueError('groove depth too large')
            outline = [(-span,-span),(span,-span),(span,span),(-span,span)]
            lower,upper = centre[axis]-width/2,centre[axis]+width/2
        else:
            centre[axis] = hit[axis]
            lower,upper = sorted((hit[axis]+side*.05,hit[axis]-side*depth))
            if args['kind']=='hole':
                if abs(length-width)>1e-8:
                    raise ValueError('hole length_mm must equal diameter width_mm')
                outline = [(width/2*math.cos(2*math.pi*i/32),width/2*math.sin(2*math.pi*i/32)) for i in range(32)]
            elif args['kind']=='slot':
                if length < width:
                    raise ValueError('slot length must be at least width')
                radius,offset = width/2,(length-width)/2
                outline = [(offset+radius*math.cos(-math.pi/2+math.pi*i/16),radius*math.sin(-math.pi/2+math.pi*i/16)) for i in range(17)]
                outline += [(-offset+radius*math.cos(math.pi/2+math.pi*i/16),radius*math.sin(math.pi/2+math.pi*i/16)) for i in range(17)]
            else:
                outline = [(-length/2,-width/2),(length/2,-width/2),(length/2,width/2),(-length/2,width/2)]
        points = []
        for height in (lower,upper):
            for x,y in outline:
                point = centre.copy()
                point[axis],point[u],point[v] = height,centre[u]+x,centre[v]+y*transverse_sign
                points.append(point)
        n = len(outline)
        faces = [list(reversed(range(n))),list(range(n,n*2))]
        faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
        cutter = cutter_mesh('cutter',points,faces)
        tools.append(cutter)
        if args['kind']=='groove':
            boolean(cutter,inner)
        boolean(obj,cutter)
        result = bmesh.new()
        result.from_mesh(obj.data)
        bmesh.ops.remove_doubles(result,verts=list(result.verts),dist=1e-5)
        bmesh.ops.dissolve_degenerate(result,edges=list(result.edges),dist=1e-6)
        bmesh.ops.recalc_face_normals(result,faces=list(result.faces))
        after = core.stats(result)
        removed = before['volumeMm3']-(after['volumeMm3'] or 0)
        if (not after['watertight'] or after['components'] > before['components'] or
            removed <= max(1e-5,before['volumeMm3']*1e-7) or removed > before['volumeMm3']*.5):
            result.free()
            raise ValueError('cut failed measured volume/topology checks; no checkpoint committed')
        return result,{'surfaceMm':list(hit),'removedVolumeMm3':removed,'lengthAxis':'XYZ'[u]}
    finally:
        for tool in tools:
            bpy.data.objects.remove(tool,do_unlink=True)
