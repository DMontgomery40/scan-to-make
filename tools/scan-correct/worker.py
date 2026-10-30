# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted Blender entrypoint. No operation evaluates model-supplied code or paths."""
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT.parent/'scan-repair'))
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
import blender_tool as core
import evidence
import geometry
from schema import validate


def bm_from(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    return bm


def checked(bm, cap):
    if len(bm.faces)>cap or len(bm.verts)>cap*3 or not bm.faces:
        raise ValueError('polygon/vertex cap exceeded or empty geometry')
    if any(not all(math.isfinite(x) for x in v.co) for v in bm.verts):
        raise ValueError('nonfinite geometry')
    return core.stats(bm)


def transform_evidence(source, directory, rotation, origin):
    for vertex in source.data.vertices:
        vertex.co = rotation @ (vertex.co-origin)
    source.data.update()
    for filename,field in (('features.json','centreMm'),('samples.json','pointMm')):
        path = directory/filename
        if path.exists():
            items = json.loads(path.read_text())
            for item in items:
                item[field] = list(rotation @ (Vector(item[field])-origin))
                if filename=='features.json' and 'extentsMm' in item:
                    item['extentsMm'] = (np.abs(np.array(rotation)) @ np.array(item['extentsMm'])).tolist()
                    item['extentMethod'] = 'conservative rotated prior cluster bounding box'
            core.write_json(path,items)


def execute(config):
    directory = Path(config['directory'])
    operation,args = config['operation'],config['args']
    cap = config['max_faces']
    data = {}
    if operation=='initialize':
        obj,bm = core.load(args['mesh'],args['scale'])
        obj.name = 'current'
        checked(bm,cap)
        bm.to_mesh(obj.data)
        source = obj.copy()
        source.data = obj.data.copy()
        source.name = 'source'
        bpy.context.collection.objects.link(source)
        source.hide_render = True
        source.hide_set(True)
        if args['texture']:
            image = bpy.data.images.load(args['texture'])
            source['texture_override'] = image.name
        for image in bpy.data.images:
            if image.source=='FILE' and image.has_data:
                image.pack()
        data['units'] = 'mm'
    else:
        if operation not in ('export',):
            validate(operation,args)
        bpy.ops.wm.open_mainfile(filepath=str(directory/'state.blend'),load_ui=False,use_scripts=False)
        obj,source = bpy.data.objects['current'],bpy.data.objects['source']
        bpy.context.view_layer.objects.active = obj
        obj.hide_set(False)
        bm = bm_from(obj)
    try:
        before = checked(bm,cap)
        if operation=='symmetrize':
            geometry.symmetry(bm,args['axis'],args['direction'],args['iterations'])
        elif operation=='convex_hull':
            new = geometry.hull(bm)
            bm.free()
            bm = new
        elif operation=='smooth':
            geometry.smooth(bm,args['iterations'],args['factor'])
        elif operation=='remesh':
            extent = before['bboxMm']['extents']
            cells = [math.ceil(size/args['voxel_mm'])+3 for size in extent]
            if max(cells)>256 or math.prod(cells)>8000000:
                raise ValueError('remesh grid cap exceeded')
            bm = core.apply_modifier(obj,bm,'REMESH',mode='VOXEL',voxel_size=args['voxel_mm'],
                                     use_smooth_shade=False)
        elif operation=='scale_to_reference':
            rotation = Matrix(before['boxRotation'])
            centre = Vector(before['boxInputCentreMm'])
            factors = [target/size for target,size in zip(args['target_mm'],before['boxExtentsMm'])]
            if any(not .5<=factor<=2 for factor in factors):
                raise ValueError('reference scaling limited to [0.5,2] per axis')
            for vertex in bm.verts:
                point = rotation @ (vertex.co-centre)
                vertex.co = Vector([point[i]*factors[i] for i in range(3)])
            # Align retained evidence rigidly, but leave reference shrink in the deviation.
            transform_evidence(source,directory,rotation,centre)
            data = {'scaleFactors':factors,'matchByConstruction':True,
                    'rotation':list(map(list,rotation)),'originMm':list(centre)}
        elif operation=='cut_feature':
            new,data = geometry.cut(obj,bm,args,core)
            bm.free()
            bm = new
        elif operation=='sample_texture':
            sampled = evidence.samples(source,args['count'],args['seed'],texture=True)
            core.write_json(directory/'samples.json',sampled)
            data = {'samples':len(sampled),'preview':sampled[:128],
                    'evidenceFrame':'retained source; nearest texel; Blender RGB',
                    'artifact':'samples.json'}
        elif operation=='find_features':
            sampled = json.loads((directory/'samples.json').read_text())
            features = evidence.clusters(sampled,args['threshold'],args['link_mm'],args['min_samples'])
            core.write_json(directory/'features.json',features)
            data = {'features':features,'semanticLabelsInferred':False}
        elif operation=='feature_frame':
            features = json.loads((directory/'features.json').read_text())
            rotation,origin = geometry.feature_frame(features,args)
            for vertex in bm.verts:
                vertex.co = rotation @ (vertex.co-origin)
            transform_evidence(source,directory,rotation,origin)
            data = {'rotation':list(map(list,rotation)),'originMm':list(origin)}
        elif operation=='classify_regions':
            data = evidence.classify(source,args['saturation_min'])
        elif operation=='deviation':
            data = evidence.deviation(source,obj,args['count'],args['seed'])
        elif operation=='render':
            source.hide_render = True
            obj.hide_render = False
            out = directory/('views-%04d'%config['sequence'])
            data = core.render(obj,bm,{'out':str(out),'resolution':args['resolution'],'keep_orientation':True})
            data['artifacts'] = {str(p.relative_to(directory)):core.sha(p) for p in sorted(out.glob('*.png'))}
        elif operation=='export':
            out = directory/'export'
            out.mkdir(exist_ok=True)
            core.export(bm,out)
            data = {'artifacts':{str(p.relative_to(directory)):core.sha(p) for p in sorted(out.iterdir())}}
        after = checked(bm,cap)
        if operation=='scale_to_reference' and any(abs(a-b)>.05 for a,b in zip(after['boxExtentsMm'],args['target_mm'])):
            raise ValueError('reference box comparison failed after scaling')
        bm.to_mesh(obj.data)
        obj.data.update()
        bpy.ops.wm.save_as_mainfile(filepath=str(directory/'pending.blend'),check_existing=False)
        volume_delta = None if before['volumeMm3'] is None or after['volumeMm3'] is None else after['volumeMm3']-before['volumeMm3']
        return {'ok':True,'runtime':{'blenderVersion':bpy.app.version_string},'operation':operation,'before':before,'after':after,'effect':{
                'volumeDeltaMm3':volume_delta,'facesDelta':after['faces']-before['faces'],
                'verticesDelta':after['vertices']-before['vertices']},'data':data,
                'previewOnly':True,'provesPhysicalAccuracy':False}
    finally:
        bm.free()


def main():
    config = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
    directory = Path(config['directory'])
    pending = directory/'pending.blend'
    pending.unlink(missing_ok=True)
    try:
        result = execute(config)
    except Exception as exc:
        pending.unlink(missing_ok=True)
        result = {'ok':False,'error':str(exc)}
    core.write_json(directory/'result.json',result)


if __name__=='__main__':
    main()
