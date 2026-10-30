# SPDX-License-Identifier: GPL-3.0-or-later
"""Texture evidence and sampled distances on a retained source mesh."""
from collections import defaultdict
from itertools import product
import math

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def samples(obj, count, seed, texture=False):
    mesh = obj.data
    mesh.calc_loop_triangles()
    triangles = list(mesh.loop_triangles)
    areas = np.array([tri.area for tri in triangles])
    if not len(areas) or areas.sum() <= 0:
        raise ValueError('source has no surface area')
    rng = np.random.default_rng(seed)
    selected = rng.choice(len(triangles),size=count,p=areas/areas.sum())
    bary = rng.random((count,2))
    root = np.sqrt(bary[:,0])
    weights = np.column_stack((1-root,root*(1-bary[:,1]),root*bary[:,1]))
    output = []
    images = {}
    uv_layer = mesh.uv_layers.active
    if texture and uv_layer is None:
        raise ValueError('texture sampling requires source UVs')
    override = obj.get('texture_override')
    for index,wi in zip(selected,weights):
        tri = triangles[int(index)]
        xyz = sum((mesh.vertices[vi].co*float(w) for vi,w in zip(tri.vertices,wi)),Vector())
        item = {'pointMm':list(xyz),'face':tri.polygon_index}
        if texture:
            if override:
                image,extension = bpy.data.images[override],'REPEAT'
            else:
                mat = mesh.materials[tri.material_index] if tri.material_index < len(mesh.materials) else None
                nodes = [n for n in mat.node_tree.nodes if n.type=='TEX_IMAGE' and n.image] if mat and mat.use_nodes else []
                if len(nodes) != 1:
                    raise ValueError('source face needs one base-colour texture image')
                image,extension = nodes[0].image,nodes[0].extension
            if image.name not in images:
                width,height = image.size
                if not width or not height or width*height > 16777216:
                    raise ValueError('texture missing or exceeds 16M pixels')
                images[image.name] = np.array(image.pixels[:]).reshape(height,width,4)
            pixels = images[image.name]
            uv = sum((uv_layer.data[li].uv*float(w) for li,w in zip(tri.loops,wi)),Vector((0,0)))
            uv = np.mod(uv,1) if extension=='REPEAT' else np.clip(uv,0,1)
            x,y = min(int(uv[0]*pixels.shape[1]),pixels.shape[1]-1),min(int(uv[1]*pixels.shape[0]),pixels.shape[0]-1)
            item['rgb'] = pixels[y,x,:3].tolist()
        output.append(item)
    return output


def clusters(data, threshold, link, minimum):
    chosen = [s for s in data if sum(a*b for a,b in zip(s['rgb'],(.2126,.7152,.0722))) < threshold]
    grid = defaultdict(list)
    points = np.array([s['pointMm'] for s in chosen])
    for i,p in enumerate(points):
        grid[tuple(np.floor(p/link).astype(int))].append(i)
    remaining = set(range(len(points)))
    groups = []
    work = 0
    for seed in range(len(points)):
        if seed not in remaining:
            continue
        remaining.remove(seed)
        stack,group = [seed],[seed]
        while stack:
            i = stack.pop()
            cell = np.floor(points[i]/link).astype(int)
            for offset in product((-1,0,1),repeat=3):
                for j in grid.get(tuple(cell+offset),[]):
                    work += 1
                    if work > 2000000:
                        raise ValueError('feature clustering work cap exceeded; reduce samples/link')
                    if j in remaining and np.linalg.norm(points[i]-points[j]) <= link:
                        remaining.remove(j)
                        stack.append(j)
                        group.append(j)
        if len(group) >= minimum:
            subset = points[group]
            groups.append({'centreMm':subset.mean(axis=0).tolist(),'extentsMm':np.ptp(subset,axis=0).tolist(),
                           'samples':len(group)})
    groups.sort(key=lambda item:(-item['samples'],item['centreMm']))
    return [dict(item,id=i) for i,item in enumerate(groups[:128])]


def classify(source, saturation):
    # Stable area samples vote on source faces; unseen faces are explicitly unknown/captured.
    data = samples(source,20000,0,texture=True)
    votes = defaultdict(list)
    for item in data:
        colour = item['rgb']
        sat = (max(colour)-min(colour))/max(max(colour),1e-10)
        votes[item['face']].append(sat >= saturation)
    attr = source.data.attributes.get('filled') or source.data.attributes.new('filled','INT','FACE')
    for fi,value in enumerate(attr.data):
        observations = votes.get(fi,[])
        value.value = int(sum(observations) > len(observations)/2) if observations else -1
    return {'filledFaces':sum(v.value==1 for v in attr.data),'totalFaces':len(attr.data),
            'unobservedFaces':len(source.data.polygons)-len(votes),
            'method':'sampled saturation majority; heuristic, unobserved faces unclassified',
            'provesCaptureCoverage':False}


def deviation(source, current, count, seed):
    mask = source.data.attributes.get('filled')
    if mask is None:
        raise ValueError('classify_regions is required before region-split deviation')
    def tree(obj):
        return BVHTree.FromPolygons([v.co for v in obj.data.vertices],
                                   [list(p.vertices) for p in obj.data.polygons],all_triangles=False)
    original_tree,corrected_tree = tree(source),tree(current)
    result = {}
    for direction,obj,target in (('source_to_corrected',source,corrected_tree),
                                 ('corrected_to_source',current,original_tree)):
        distances = {'captured':[],'filled':[],'unknown':[]}
        for item in samples(obj,count,seed):
            point = Vector(item['pointMm'])
            nearest = target.find_nearest(point)
            if nearest[0] is None:
                raise ValueError('deviation target empty')
            face = item['face'] if obj==source else original_tree.find_nearest(point)[2]
            region = {1:'filled',0:'captured',-1:'unknown'}[mask.data[face].value]
            distances[region].append(nearest[3])
        result[direction] = {region:{'samples':len(values),'meanMm':float(np.mean(values)) if values else None,
                                    'p95Mm':float(np.percentile(values,95)) if values else None,
                                    'maxMm':max(values) if values else None}
                             for region,values in distances.items()}
    return {'directions':result,'method':'two-sided area samples, not Hausdorff/physical accuracy'}
