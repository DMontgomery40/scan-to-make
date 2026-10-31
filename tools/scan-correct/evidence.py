# SPDX-License-Identifier: GPL-3.0-or-later
"""Texture evidence and sampled distances on a retained source mesh."""
from collections import defaultdict
from itertools import product
import math

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def clipped_triangles(mesh, triangles, region):
    """Clip in barycentric coordinates so both surface density and UVs survive."""
    points=np.array([[mesh.vertices[v].co[:] for v in tri.vertices] for tri in triangles])
    low,high=np.array(region[0]),np.array(region[1])
    candidates=np.flatnonzero(((points.max(1)>=low)&(points.min(1)<=high)).all(1))
    indices,weights,areas=[],[],[]
    for index in candidates:
        triangle=points[index];polygon=list(np.eye(3))
        for axis,bound,sign in [(i,low[i],1) for i in range(3)]+[(i,high[i],-1) for i in range(3)]:
            clipped=[]
            for a,b in zip(polygon,polygon[1:]+polygon[:1]):
                da,db=sign*((a@triangle)[axis]-bound),sign*((b@triangle)[axis]-bound)
                if da>=0:clipped.append(a)
                if (da>=0)!=(db>=0):clipped.append(a+(b-a)*da/(da-db))
            polygon=clipped
            if not polygon:break
        for j in range(1,len(polygon)-1):
            bary=np.array([polygon[0],polygon[j],polygon[j+1]])
            p=bary@triangle;area=np.linalg.norm(np.cross(p[1]-p[0],p[2]-p[0]))/2
            if area>1e-12:
                indices.append(int(index));weights.append(bary);areas.append(area)
            if len(indices)>1000000:raise ValueError('regional triangulation cap exceeded')
    if not areas:raise ValueError('region contains no surface area')
    return np.array(indices),np.array(weights),np.array(areas)


def samples(obj, count, seed, texture=False, region=None):
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
    if region is not None:
        indices,clipped,areas=clipped_triangles(mesh,triangles,region)
        selected=rng.choice(len(indices),size=count,p=areas/areas.sum())
        weights=np.einsum('ni,nij->nj',weights,clipped[selected])
        selected=indices[selected]
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


def describe(points, indices):
    centre=points.mean(0)
    _,singular,axes=np.linalg.svd(points-centre,full_matrices=False)
    for axis in axes:
        if axis[np.argmax(np.abs(axis))]<0:axis*=-1
    return {'centreMm':centre.tolist(),'extentsMm':np.ptp(points,axis=0).tolist(),
            'samples':len(points),'sampleIndices':sorted(indices),
            'principalAxes':axes.tolist(),'principalSpansMm':np.ptp((points-centre)@axes.T,axis=0).tolist(),
            'principalRmsMm':(singular/np.sqrt(len(points))).tolist(),
            'extentMethod':'exact sampled bounds; not sub-pixel or physical accuracy'}


def local_contrast(data, radius):
    """Bounded approximate neighbourhood median: at most 64 candidates per point."""
    points=np.array([s['pointMm'] for s in data]);values=np.array([s['rgb'] for s in data])@np.array([.2126,.7152,.0722])
    grid=defaultdict(list)
    for i,p in enumerate(points):grid[tuple(np.floor(p/radius).astype(int))].append(i)
    medians=np.empty(len(points))
    cache={}
    for i,p in enumerate(points):
        cell=tuple(np.floor(p/radius).astype(int))
        if cell not in cache:
            near=[j for offset in product((-1,0,1),repeat=3) for j in grid.get(tuple(a+b for a,b in zip(cell,offset)),[])]
            cache[cell]=np.array(near)[np.linspace(0,len(near)-1,min(64,len(near)),dtype=int)]
        near=cache[cell];near=near[np.linalg.norm(points[near]-p,axis=1)<=radius]
        medians[i]=np.median(values[near]) if len(near)>=3 else values[i]
    return medians-values


def fit_plane(data, features, ids, tolerance, fraction):
    if max(ids)>=len(features) or len(set(ids))!=len(ids):raise ValueError('invalid feature IDs')
    if len(features)>=128:raise ValueError('feature count cap exceeded')
    indices=sorted({i for fid in ids for i in features[fid]['sampleIndices']})
    points=np.array([data[i]['pointMm'] for i in indices])
    if len(points)<3:raise ValueError('plane needs at least three observations')
    rng=np.random.default_rng(0);best=np.zeros(len(points),dtype=bool)
    for _ in range(512):
        a,b,c=points[rng.choice(len(points),3,replace=False)]
        normal=np.cross(b-a,c-a);length=np.linalg.norm(normal)
        if length<1e-8:continue
        mask=np.abs((points-a)@(normal/length))<=tolerance
        if mask.sum()>best.sum():best=mask
    if best.sum()<3:raise ValueError('plane observations are collinear')
    for _ in range(3):
        centre=points[best].mean(0);normal=np.linalg.svd(points[best]-centre,full_matrices=False)[2][2]
        mask=np.abs((points-centre)@normal)<=tolerance
        if mask.sum()<3:raise ValueError('plane refinement lost support')
        best=mask
    if best.mean()<fraction:raise ValueError('plane inlier fraction below requested minimum')
    item=describe(points[best],[indices[i] for i in np.flatnonzero(best)])
    rms=item['principalRmsMm']
    if rms[1]<.1*rms[0] or rms[1]<tolerance*2:raise ValueError('plane observations too nearly collinear')
    return dict(item,id=len(features),kind='fitted-plane',sourceFeatureIds=ids,
                inlierFraction=float(best.mean()),toleranceMm=tolerance,method='512 seeded plane hypotheses, least-squares refinement')


def clusters(data, threshold, link, minimum, contrast_min=0, contrast_radius_mm=1.5):
    contrast=local_contrast(data,contrast_radius_mm) if contrast_min else np.zeros(len(data))
    selected=[i for i,s in enumerate(data) if sum(a*b for a,b in zip(s['rgb'],(.2126,.7152,.0722)))<threshold or
              (contrast_min>0 and contrast[i]>=contrast_min)]
    chosen = [data[i] for i in selected]
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
            groups.append(describe(subset,[selected[i] for i in group]))
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
