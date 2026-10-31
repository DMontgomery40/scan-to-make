# SPDX-License-Identifier: GPL-3.0-or-later
"""UV-aware exact union, executed only in a fresh Blender through Bambu MCP.

All coordinates are millimetres in the chosen result's frame. No smoothing,
voxelization, scaling, orientation, or bridging of disconnected parts.
"""
import importlib.util
import json
import math
from pathlib import Path
import shutil

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def intersections(bm, with_regions=False):
    tri=bm.copy()
    try:
        bmesh.ops.triangulate(tri,faces=list(tri.faces))
        tri.faces.ensure_lookup_table()
        tree=BVHTree.FromBMesh(tri,epsilon=0.0)
        pairs=tree.overlap(tree)
        hits=[(a,b) for a,b in pairs if a<b and not set(tri.faces[a].verts).intersection(tri.faces[b].verts)]
        region=tri.faces.layers.int.get('stm_printable_region')
        within={tri.faces[a][region] for a,b in hits if region and tri.faces[a][region]==tri.faces[b][region]}
        return (len(hits),within) if with_regions else len(hits)
    finally:
        tri.free()


def face_volume(face, origin):
    v=[p.co-origin for p in face.verts]
    return sum(v[0].dot(v[i].cross(v[i+1]))/6 for i in range(1,len(v)-1))


# A nearest face normal is not an inside test at concave/acute creases. Count
# oriented crossings in three non-axis directions. Two agreeing rays avoid
# a grazing edge deciding containment; capped/degenerate rays cast no vote.
RAYS=tuple(Vector(v).normalized() for v in ((1,.371,.529),(.217,1,.613),(.433,.193,1)))

def contains(tree, point):
    nearest=tree.find_nearest(point)
    if nearest[3] is None or nearest[3]<=1e-5:return False
    epsilon=max(1e-4,max(abs(v) for v in point)*2e-7)
    votes=[]
    for direction in RAYS:
        start=point.copy();winding=0;valid=False
        for _ in range(256):
            location,normal,_,distance=tree.ray_cast(start,direction)
            if location is None:valid=True;break
            dot=normal.dot(direction)
            if abs(dot)<1e-7:break
            winding+=1 if dot>0 else -1
            # Advance by a normal-distance epsilon, not a ray-distance
            # epsilon: grazing rays otherwise hit the same float32 face again.
            start=location+direction*(epsilon/max(abs(dot),1e-3))
        if valid:votes.append(winding>0)
    return votes.count(True)>=2


def run(config):
    spec=importlib.util.spec_from_file_location('printable_repair_core',config['repairCore'])
    core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
    source=Path(config['input']);out=Path(config['output'])
    # This worker owns a fresh process. Remove factory Material and other
    # datablocks before import so declared MTL names cannot acquire .001 suffixes.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obj,bm=core.load(str(source),1.0)
    loose=[v for v in bm.verts if not v.link_faces]
    discarded_loose=len(loose)
    if loose:bmesh.ops.delete(bm,geom=loose,context='VERTS')
    loose_edges=[e for e in bm.edges if not e.link_faces]
    if loose_edges:bmesh.ops.delete(bm,geom=loose_edges,context='EDGES')
    if len(bm.faces)>200000 or len(bm.verts)>600000:
        raise ValueError('make-printable input exceeds geometry budget')
    before=core.stats(bm)
    original=bm.copy()
    groups=core.components(bm)
    origin=Vector([(a+b)/2 for a,b in zip(before['bboxMm']['min'],before['bboxMm']['max'])])
    # Open boundaries have no signed enclosed volume; their tetrahedron sum
    # changes with translation and cannot identify an inward cavity shell.
    original_signed=[sum(face_volume(f,origin) for f in bm.faces if f.verts[0] in g)
        if all(e.is_manifold for v in g for e in v.link_edges) else None for g in groups]
    core.normals(bm)
    winding_changed=any(a.normal.dot(b.normal)<.999 for a,b in zip(original.faces,bm.faces))
    region=bm.faces.layers.int.new('stm_printable_region')
    inferred=bm.faces.layers.int.get(core.INFERRED) or bm.faces.layers.int.new(core.INFERRED)
    material_names=[m.name if m else 'unbound' for m in obj.data.materials]
    if len(groups)>128:raise ValueError('too many disconnected shells for bounded exact union')
    regions=[]
    for i,group in enumerate(groups):
        faces=[f for f in bm.faces if f.verts[0] in group]
        for f in faces:
            f[region]=i+1
            if f.material_index < len(material_names) and material_names[f.material_index]=='unbound':
                f[inferred]=1
        closed=all(e.is_manifold for v in group for e in v.link_edges)
        regions.append({'region':i+1,'inputClosed':closed,'inputFaces':len(faces),
            'materials':sorted({material_names[f.material_index] for f in faces if f.material_index<len(material_names)}),
            'inputVolumeMm3':abs(sum(face_volume(f,origin) for f in faces)) if closed else None,
            'inputBoundaryContributionMm3':sum(face_volume(f,origin) for f in faces)})
    original_intersections,self_crossing_regions=intersections(bm,with_regions=True)
    boundary=[e for e in bm.edges if e.is_boundary]
    patches=bmesh.ops.holes_fill(bm,edges=boundary,sides=0)['faces'] if boundary else []
    patch_set=set(patches)
    for face in patches:
        face[inferred]=1
        face[region]=next((f[region] for e in face.edges for f in e.link_faces if f not in patch_set),0)
    filled_area=sum(f.calc_area() for f in patches)
    core.normals(bm)
    # Classify against the CLOSED pre-union shells, including fixed-rim fills.
    # Otherwise the overlap inside a newly closed shell looks like lost exterior.
    solids=[]
    for i,group in enumerate(groups):
        faces=[f for f in bm.faces if f[region]==i+1]
        vertices=list(group);index={v:k for k,v in enumerate(vertices)}
        tree=BVHTree.FromPolygons([v.co for v in vertices],[[index[v] for v in f.verts] for f in faces])
        closed=bool(faces) and all(e.is_manifold for f in faces for e in f.edges)
        self_crossing=i+1 in self_crossing_regions
        bounds=([min(v.co[k] for v in vertices) for k in range(3)],[max(v.co[k] for v in vertices) for k in range(3)])
        solids.append((tree,closed,self_crossing,bounds))
    samples=[]
    for face in bm.faces:
        if face[inferred]:continue
        for point in [v.co.copy() for v in face.verts]+[e.verts[0].co.lerp(e.verts[1].co,.5) for e in face.edges]+[face.calc_center_median()]:
            inside=False
            for i,(tree,closed,self_crossing,(low,high)) in enumerate(solids):
                if not closed or any(point[k]<low[k] or point[k]>high[k] for k in range(3)):continue
                if i+1==face[region]:
                    # For self-overlapping connected shells, an internal wall
                    # has solid on BOTH sides. A real exterior does not.
                    if not self_crossing:continue
                    inside=contains(tree,point+face.normal*.0001) and contains(tree,point-face.normal*.0001)
                else:inside=contains(tree,point)
                if inside:break
            if not inside:samples.append(point)
    changed=bool(patches) or len(groups)>1 or original_intersections>0 or winding_changed or bool(discarded_loose or loose_edges)
    core.normals(bm)
    bm.to_mesh(obj.data)
    if changed:
        # Blender's exact self-union retains loop UVs and face provenance. The
        # operation is sent through bambu-printer-mcp's advanced Blender route.
        bpy.context.view_layer.objects.active=obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        try:
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.mesh.intersect_boolean(operation='UNION',use_self=True,solver='EXACT')
        finally:
            bpy.ops.object.mode_set(mode='OBJECT')
        bm.free();bm=bmesh.new();bm.from_mesh(obj.data);bm.normal_update()
    if not bm.faces or len(bm.faces)>400000:
        raise ValueError('make-printable output exceeds geometry budget or is empty')
    after=core.stats(bm);crossings=intersections(bm)
    target=BVHTree.FromBMesh(bm)
    deviation=max((target.find_nearest(p)[3] for p in samples),default=0.0)
    bounds=max(abs(a-b) for key in ('min','max') for a,b in zip(before['bboxMm'][key],after['bboxMm'][key]))
    layer=bm.faces.layers.int.get('stm_printable_region')
    for r in regions:
        contribution=sum(face_volume(f,origin) for f in bm.faces if layer and f[layer]==r['region'])
        r['outputBoundaryContributionMm3']=contribution
        r['boundaryContributionChangeMm3']=contribution-r['inputBoundaryContributionMm3']
    problems=['inward-shell-requires-review'] if len(groups)>1 and any(v is not None and v<0 for v in original_signed) else []
    if after['components']!=1:problems.append('disconnected-shells')
    if not after['watertight']:problems.append('non-manifold-result')
    if any(not v.is_manifold for v in bm.verts):problems.append('non-manifold-vertices')
    if after['volumeMm3'] is None or after['volumeMm3']<=1e-9:problems.append('no-enclosed-volume')
    if crossings:problems.append('self-intersections')
    if deviation>.05:problems.append('captured-surface-changed')
    if bounds>.05:problems.append('bounds-changed')
    if original.loops.layers.uv.active and not bm.loops.layers.uv.active:problems.append('texture-coordinates-lost')
    # Diagnostic only: an inward ray from every face centre estimates local
    # thickness. It is not a guaranteed global minimum or a nozzle-specific gate.
    thickness=[]
    for face in bm.faces:
        centre=face.calc_center_median()
        hit=target.ray_cast(centre-face.normal*.0001,-face.normal)
        if hit[0] is not None and hit[3]>.001 and hit[1].dot(-face.normal)>.1:
            thickness.append({'thicknessMm':hit[3]+.0001,'pointMm':list(centre),'oppositeMm':list(hit[0])})
    thickness.sort(key=lambda item:item['thicknessMm'])
    minimum=thickness[0]['thicknessMm'] if thickness else None
    result={'schema':'scan-to-make.printable/0.1','status':'blocked' if problems else 'ready',
        'before':before,'after':after,'problems':problems,'selfIntersections':crossings,
        'inputSelfIntersections':original_intersections,'discardedLooseVertices':discarded_loose,'exteriorDeviationMm':deviation,
        'exteriorSamples':len(samples),'boundsChangeMm':bounds,'filledAreaMm2':filled_area,
        'minimumSampledThicknessMm':minimum,'warnings':['thin-region'] if minimum is not None and minimum<.5 else [],
        'thinSamples':thickness[:8],'thicknessMethod':'inward face-centre rays; diagnostic samples, not a guaranteed global minimum or nozzle-specific test',
        'regions':regions,'regionVolumeMethod':'signed boundary tetrahedron contribution about the fixed input box centre; changes sum to net volume, not independent closed regional volumes',
        'inputObjCopied':not changed,'scale':1,'rotation':[[1,0,0],[0,1,0],[0,0,1]],'translationMm':[0,0,0]}
    if not problems:
        libraries=[]
        for line in source.read_text().splitlines():
            fields=line.split('#',1)[0].split()
            if fields and fields[0]=='mtllib' and fields[1] not in libraries:libraries.append(fields[1])
        core.export(bm,out,uv=True,libraries=libraries,materials=material_names)
        (out/'repaired.obj').rename(out/'corrected.obj');(out/'repaired.stl').rename(out/'corrected.stl')
        if not changed:shutil.copyfile(source,out/'corrected.obj')
        else:
            # Retain authored smooth/flat face shading across the boolean. The
            # shared geometry exporter writes UVs but no smoothing directives.
            path=out/'corrected.obj';temporary=out/'shading.obj'
            faces=iter(bm.faces);previous=None
            with path.open() as src,temporary.open('w') as dst:
                for line in src:
                    if line.startswith('f '):
                        smooth=next(faces).smooth
                        if smooth!=previous:dst.write('s 1\n' if smooth else 's off\n');previous=smooth
                    dst.write(line)
            temporary.replace(path)
    core.write_json(out/'printable.json',result)
    bm.free();original.free()
    return result
