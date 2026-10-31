# SPDX-License-Identifier: GPL-3.0-or-later
"""Deterministic measured close-up candidates and texture-free highlighted views."""
from collections import defaultdict
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
import evidence

SIDES=('pos_x','neg_x','pos_y','neg_y','pos_z','neg_z')
LABELS=dict(zip(SIDES,('Right side (+X)','Left side (-X)','Far side (+Y)','Near side (-Y)',
                       'Upper side (+Z)','Underside (-Z)')))
REASONS={'inferred_fill':'not captured; reconstructed (inferred)',
         'surface_lumpy':'surface lumpy (local roughness/curvature anomaly)',
         'fine_feature':'fine feature likely (small concave geometry)',
         'dark_texture':'fine feature likely (dark texture cluster)',
         'size_check':'scan envelope differs from reference; include a ruler'}


def analyse(obj,source,bm,stats,reference,limit,labels):
    bm.verts.ensure_lookup_table();bm.verts.index_update()
    bm.faces.ensure_lookup_table();bm.faces.index_update();bm.normal_update()
    coords=np.array([tuple(v.co) for v in bm.verts])
    lower,upper=coords.min(0),coords.max(0)
    centre=(lower+upper)/2;extent=upper-lower
    longest=float(extent.max())
    if not longest>0:
        raise ValueError('advice requires nonzero geometry')
    areas=np.array([f.calc_area() for f in bm.faces])
    median=float(np.median(areas[areas>0]))
    centres=np.array([tuple(f.calc_center_median()) for f in bm.faces])
    groups={}
    warnings=[]
    def side(point):
        relative=(np.array(point)-centre)/np.maximum(extent/2,1e-6)
        axis=int(np.argmax(np.abs(relative)))
        return SIDES[axis*2+(1 if relative[axis]<0 else 0)]
    def add(code,faces,score,details):
        faces=sorted(set(int(i) for i in faces))
        if not faces:return
        point=np.average(centres[faces],axis=0,weights=areas[faces])
        direction=side(point)
        key=(code,direction)
        if key not in groups:
            groups[key]={'code':code,'side':direction,'faces':set(),'score':score,'details':details}
        groups[key]['faces'].update(faces)
        if score>groups[key]['score']:
            groups[key]['details']=details
        groups[key]['score']=max(groups[key]['score'],score)

    textured=False
    mask=None
    try:
        classification=evidence.classify(source,.12)
        mask=source.data.attributes.get('filled')
        textured=True
    except ValueError:
        classification=None
        warnings.append('Texture evidence unavailable; geometry heuristics only.')
    coarse=defaultdict(list)
    for fi,f in enumerate(bm.faces):
        if areas[fi]>median*20 and max(abs(x) for x in f.normal)>.75:
            coarse[side(centres[fi])].append(fi)
    for direction,faces in coarse.items():
        supported=sum(areas[i] for i in faces if mask is not None and i<len(mask.data) and mask.data[i].value==1)
        fraction=float(supported/areas[faces].sum())
        total_side=sum(areas[i] for i in range(len(areas)) if side(centres[i])==direction)
        coverage=float(areas[faces].sum()/max(total_side,1e-12))
        affected=float(areas[faces].sum()/areas.sum())
        score=min(99,round(70+10*fraction+12*coverage+8*math.sqrt(affected)))
        add('inferred_fill',faces,score,
            {'coarseAreaMm2':round(float(areas[faces].sum()),6),'coarseCoverageFraction':round(coverage,6),'textureFilledFraction':round(fraction,6),
             'method':'large near-axis faces versus median tessellation; saturation supports but does not prove fill'})
    # Fit each connected opening, rather than aiming at its incident walls.
    boundary=[e for e in bm.edges if e.is_boundary]
    incident=defaultdict(list)
    for index,edge in enumerate(boundary):
        for v in edge.verts:incident[v.index].append(index)
    remaining=set(range(len(boundary)))
    for seed in range(len(boundary)):
        if seed not in remaining:continue
        remaining.remove(seed);stack=[seed];component=[]
        while stack:
            edge=boundary[stack.pop()];component.append(edge)
            for v in edge.verts:
                for other in incident[v.index]:
                    if other in remaining:remaining.remove(other);stack.append(other)
        vertices=sorted({v.index for e in component for v in e.verts})
        points=coords[vertices];target=points.mean(0)
        _,singular,basis=np.linalg.svd(points-target,full_matrices=False)
        if len(singular)<2 or singular[1]<1e-8:continue
        normal=basis[-1]
        # A virtual closing face winds opposite the adjacent boundary face.
        # Use that orientation when available, with the mesh envelope as fallback.
        closing=np.zeros(3)
        for edge in component:
            loop=next(loop for loop in edge.link_faces[0].loops if loop.edge==edge)
            closing+=np.cross(np.array(loop.link_loop_next.vert.co)-target,
                              np.array(loop.vert.co)-target)
        outward=closing if abs(float(normal@closing))>1e-8 else target-centre
        if float(normal@outward)<0:normal=-normal
        axis=int(np.argmax(np.abs(normal)))
        direction=SIDES[axis*2+(1 if normal[axis]<0 else 0)]
        faces={f.index for e in component for f in e.link_faces}
        groups[('boundary',seed)]={'code':'inferred_fill','side':direction,'faces':faces,'score':98,
            'details':{'method':'open boundary centroid and fitted outward plane; missing coverage inferred'},
            'points':points,'target':target,'direction':normal,
            'openingEdges':[[list(e.verts[0].co),list(e.verts[1].co)] for e in component]}

    # Local normal curvature and normal-projected neighbour residual, without fitting a product model.
    residual=np.zeros(len(bm.verts));curvature=np.zeros(len(bm.verts));neighbours=[];eligible=[]
    work=0
    for i,vertex in enumerate(bm.verts):
        adjacent=[e.other_vert(vertex) for e in vertex.link_edges]
        neighbours.append([v.index for v in adjacent])
        work+=len(adjacent)
        if work>3000000:raise ValueError('advice adjacency work cap exceeded')
        if not adjacent or vertex.is_boundary or any(e.is_manifold and abs(e.calc_face_angle_signed())>math.pi/4 for e in vertex.link_edges):
            continue
        points=np.array([tuple(v.co) for v in adjacent]);normal=np.array(vertex.normal)
        residual[i]=abs(float((coords[i]-points.mean(0))@normal))
        lengths=np.linalg.norm(points-coords[i],axis=1)
        angles=[math.acos(max(-1,min(1,vertex.normal.dot(v.normal)))) for v in adjacent]
        curvature[i]=float(np.mean(angles)/max(float(lengths.mean()),1e-6))
        eligible.append(i)
    for i in eligible:
        local=float(np.median(curvature[neighbours[i]]))
        if residual[i]>max(.1,longest*.002) and abs(curvature[i]-local)>max(.015,local*.15):
            add('surface_lumpy',[f.index for f in bm.verts[i].link_faces],
                min(84,round(72+residual[i]/longest*100)),
                {'normalResidualMm':round(float(residual[i]),6),'curvaturePerMm':round(float(curvature[i]),6),
                 'method':'local normal curvature variation; smooth intentional details may also trigger'})

    # Small connected concave edges distinguish blind pockets/holes from convex outside corners.
    candidates=[e for e in bm.edges if e.is_manifold and e.calc_length()<longest*.2 and e.calc_face_angle_signed()<-.3]
    incident=defaultdict(list)
    for index,e in enumerate(candidates):
        for v in e.verts:incident[v.index].append(index)
    remaining=set(range(len(candidates)))
    for seed in range(len(candidates)):
        if seed not in remaining:continue
        remaining.remove(seed);stack=[seed];component=[]
        while stack:
            index=stack.pop();component.append(candidates[index])
            for v in candidates[index].verts:
                for other in incident[v.index]:
                    if other in remaining:remaining.remove(other);stack.append(other)
        points=np.array([tuple(v.co) for e in component for v in e.verts])
        if len(component)>=3 and np.ptp(points,axis=0).max()<longest*.35:
            add('fine_feature',[f.index for e in component for f in e.link_faces],68,
                {'concaveEdges':len(component),'method':'small connected sharp concavity; possible port, hole or seam'})
    if textured:
        try:
            sampled=evidence.samples(source,2000,0,texture=True)
            found=evidence.clusters(sampled,.32,max(.4,longest*.015),4)
            tree=BVHTree.FromBMesh(bm)
            for cluster in found:
                if max(cluster['extentsMm'])>longest*.25:continue
                hit=tree.find_nearest(Vector(cluster['centreMm']))
                if hit[0] is None:continue
                fi=hit[2]
                if (mask is not None and fi<len(mask.data) and mask.data[fi].value==1) or areas[fi]>median*20:continue
                add('dark_texture',[fi],62,{'samples':cluster['samples'],'method':'dark texture cluster; may be marking, shadow or fine feature'})
        except ValueError:
            warnings.append('Texture clustering reached its work cap; no texture-cluster targets emitted.')
    comparison=None
    if reference is not None:
        errors=[a-b for a,b in zip(stats['boxExtentsMm'],reference)]
        comparison={'referenceMm':reference,'boxExtentsMm':stats['boxExtentsMm'],'errorMm':errors}
        if any(abs(e)>max(.3,r*.01) for e,r in zip(errors,reference)):
            axis=int(np.argmin(extent))
            faces=[f.index for f in bm.faces if f.normal[axis]>.75]
            if not faces:
                best=max(f.normal[axis] for f in bm.faces)
                faces=[f.index for f in bm.faces if f.normal[axis]>=best-1e-6]
            add('size_check',faces,40,{'method':'oriented-box discrepancy; reference dimensions are declarations'})
    ranked=sorted(groups.values(),key=lambda g:(-g['score'],SIDES.index(g['side']),g['code']))
    # One view per side; preserve the strongest reason and its measured region.
    selected=[];seen=set()
    for group in ranked:
        if group['side'] in seen:continue
        seen.add(group['side']);faces=sorted(group.pop('faces'))
        points=group.get('points')
        if points is None:points=np.array([tuple(v.co) for i in faces for v in bm.faces[i].verts])
        target=group.get('target')
        if target is None:target=np.average(centres[faces],axis=0,weights=areas[faces])
        axis=SIDES.index(group['side'])//2;direction=[0,0,0]
        direction[axis]=-1 if group['side'].startswith('neg') else 1
        direction=group.get('direction',direction)
        direction=[round(float(x),6) for x in direction]
        distance=max(50,float(np.linalg.norm(extent))*1.5,float(np.linalg.norm(np.ptp(points,axis=0)))*4)
        selected.append({'rank':len(selected)+1,'label':labels.get(group['side'],LABELS[group['side']]),
                         'labelSource':'caller' if group['side'] in labels else 'input-axis-default',
                         'side':group['side'],'reasonCode':group['code'],'reason':REASONS[group['code']],
                         'viewDirection':direction,'targetMm':[round(float(x),6) for x in target],
                         'distanceMm':round(distance,6),'expectedBenefitScore':group['score'],
                         'regionBoundsMm':{'min':points.min(0).round(6).tolist(),'max':points.max(0).round(6).tolist()},
                         'evidence':{**group['details'],'faces':len(faces),'heuristic':True},'_faces':faces,
                         '_openingEdges':group.get('openingEdges',[])})
        if len(selected)>=limit:break
    return {'schemaVersion':1,'coordinateFrame':'input axes; target-to-camera view direction; mm',
            'targets':selected,'specComparison':comparison,'regionClassification':classification,
            'warnings':warnings,'limitations':['Heuristic priorities, not proof of capture history or product anatomy.',
                'Distance is a geometry-based starting point, not a calibrated phone focus distance.',
                'Smooth intentional curvature, markings and shadows can resemble defects.'],
            'previewOnly':True,'provesPhysicalAccuracy':False}


def render_target(obj,bm,target,path,resolution,core):
    bm.to_mesh(obj.data)
    obj.data.materials.clear()
    for name,colour in [('neutral',(.55,.55,.55,1)),('highlight',(1,.24,.025,1))]:
        material=bpy.data.materials.new(name);material.diffuse_color=colour;material.use_nodes=False
        obj.data.materials.append(material)
    faces=set(target.pop('_faces'))
    opening=target.pop('_openingEdges')
    for face in obj.data.polygons:face.material_index=1 if not opening and face.index in faces else 0
    scene=bpy.context.scene;scene.render.engine='BLENDER_WORKBENCH'
    scene.display.shading.light='STUDIO';scene.display.shading.color_type='MATERIAL'
    scene.display.shading.show_shadows=False;scene.display.shading.show_cavity=False
    scene.display.shading.show_specular_highlight=False
    scene.display.shading.background_type='WORLD';scene.world.color=(.08,.08,.08)
    scene.render.resolution_x=scene.render.resolution_y=resolution;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
    scene.render.film_transparent=False
    camera_data=bpy.data.cameras.new('advice');camera=bpy.data.objects.new('advice',camera_data)
    scene.collection.objects.link(camera);scene.camera=camera
    point=Vector(target['targetMm']);direction=Vector(target['viewDirection'])
    camera.location=point+direction*target['distanceMm'];camera.rotation_euler=(point-camera.location).to_track_quat('-Z','Y').to_euler()
    bounds=target['regionBoundsMm'];region=(Vector(bounds['max'])-Vector(bounds['min'])).length
    overall=max(max(v.co[i] for v in bm.verts)-min(v.co[i] for v in bm.verts) for i in range(3))
    rim=None
    if opening:
        curve=bpy.data.curves.new('opening-rim','CURVE');curve.dimensions='3D'
        curve.bevel_depth=target.pop('_markerRadiusMm',max(overall*.004,.001));curve.bevel_resolution=0
        curve.materials.append(obj.data.materials[1])
        for ends in opening:
            spline=curve.splines.new('POLY');spline.points.add(1)
            for point,co in zip(spline.points,ends):point.co=(*co,1)
        rim=bpy.data.objects.new('opening-rim',curve);scene.collection.objects.link(rim)
    camera_data.type='ORTHO';camera_data.ortho_scale=max(region*1.25,overall*.65,.1)
    camera_data.clip_start=.001;camera_data.clip_end=target['distanceMm']+overall*4
    path=Path(path);path.parent.mkdir(exist_ok=True,parents=True)
    scene.render.filepath=str(path);bpy.ops.render.render(write_still=True);core.strip_png_metadata(path)
    bpy.data.objects.remove(camera,do_unlink=True)
    if rim is not None:
        bpy.data.objects.remove(rim,do_unlink=True)
        bpy.data.curves.remove(curve)
