# SPDX-License-Identifier: GPL-3.0-or-later
"""Trusted Blender entrypoint. No operation evaluates model-supplied code or paths."""
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile

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

# New operations conservatively count as edits unless they are known observations.
OBSERVATIONS = {'initialize','export','measure','render','advise','sample_texture',
                'sample_texture_region','find_features','fit_feature_plane',
                'render_features','classify_regions','deviation'}


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
    samples=None
    for filename,field in (('samples.json','pointMm'),('features.json','centreMm')):
        path = directory/filename
        if path.exists():
            items = json.loads(path.read_text())
            for item in items:
                item[field] = list(rotation @ (Vector(item[field])-origin))
                if filename=='features.json':
                    if 'sampleIndices' in item:
                        if samples is None:samples=json.loads((directory/'samples.json').read_text())
                        points=np.array([samples[i]['pointMm'] for i in item['sampleIndices']])
                        item.update(evidence.describe(points,item['sampleIndices']))
                    else:
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
        obj['geometry_edited'] = False
        # Blender primitives may carry unused UVs without any material. Only
        # a textured input requires them for the captured appearance.
        material = json.loads((directory/'materials.json').read_text())
        obj['source_has_texture'] = bm.loops.layers.uv.active is not None and bool(material['libraries'] or args['texture'])
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
        if operation not in ('export','advise'):
            validate(operation,args)
        bpy.ops.wm.open_mainfile(filepath=str(directory/'state.blend'),load_ui=False,use_scripts=False)
        obj,source = bpy.data.objects['current'],bpy.data.objects['source']
        bpy.context.view_layer.objects.active = obj
        obj.hide_set(False)
        bm = bm_from(obj)
    try:
        before = checked(bm,cap)
        if obj.get('source_has_texture') and operation in ('remesh','convex_hull'):
            raise ValueError('operation would discard captured UVs; choose a texture-preserving edit')
        if operation not in OBSERVATIONS:
            obj['geometry_edited'] = True
        if operation=='rigid_frame':
            rotation=Matrix([args['rotation'][i:i+3] for i in (0,3,6)])
            translation=Vector(args['translation_mm'])
            for vertex in bm.verts:
                vertex.co=rotation@vertex.co+translation
            transform_evidence(source,directory,rotation,-(rotation.transposed()@translation))
            data={'rotation':args['rotation'],'translationMm':args['translation_mm'],'datumProvenance':'caller-supplied measured frame'}
        elif operation=='mirror':
            bmesh.ops.symmetrize(bm,input=list(bm.verts)+list(bm.edges)+list(bm.faces),
                                direction=('-' if args['direction']=='NEGATIVE' else '')+args['axis'],dist=1e-4)
            bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
        elif operation=='laplacian_smooth':
            if not before['watertight'] or len(bm.verts)*args['iterations']>8000000:
                raise ValueError('modifier smoothing requires closed geometry within work cap')
            bm=core.apply_modifier(obj,bm,'LAPLACIANSMOOTH',iterations=args['iterations'],
                                   lambda_factor=args['lambda_factor'],lambda_border=0,
                                   use_volume_preserve=True,use_normalized=True,use_x=True,use_y=True,use_z=True)
        elif operation=='subdivide':
            if len(bm.faces)*4**args['levels']>cap:
                raise ValueError('subdivision predicted face cap exceeded')
            bm=core.apply_modifier(obj,bm,'SUBSURF',levels=args['levels'],render_levels=args['levels'],subdivision_type='CATMULL_CLARK')
        elif operation=='symmetrize':
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
        elif operation in ('cut_feature','cut_oriented_feature'):
            new,data = geometry.cut(obj,bm,args,core)
            bm.free()
            bm = new
        elif operation in ('sample_texture','sample_texture_region'):
            region=(args['min_mm'],args['max_mm']) if operation=='sample_texture_region' else None
            prior=[]
            if args.get('retain_samples')=='append':
                prior=json.loads((directory/'samples.json').read_text())
                if len(prior)+args['count']>20000:raise ValueError('combined texture sample cap exceeded')
            sampled = evidence.samples(source,args['count'],args['seed'],texture=True,region=region)
            sampled=prior+sampled
            core.write_json(directory/'samples.json',sampled)
            (directory/'features.json').unlink(missing_ok=True)
            data = {'samples':len(sampled),'preview':sampled[:128],
                    'evidenceFrame':'retained source; nearest texel; Blender RGB',
                    'artifact':'samples.json','regionBoundsMm':region}
        elif operation=='find_features':
            sampled = json.loads((directory/'samples.json').read_text())
            features = evidence.clusters(sampled,args['threshold'],args['link_mm'],args['min_samples'],
                                         args.get('contrast_min',0),args.get('contrast_radius_mm',1.5))
            core.write_json(directory/'features.json',features)
            data = {'features':[{k:v for k,v in f.items() if k!='sampleIndices'} for f in features],'semanticLabelsInferred':False,
                    'contrastMethod':'approximate spatial median, at most 64 neighbours per sample' if args.get('contrast_min',0) else 'disabled'}
        elif operation=='fit_feature_plane':
            features=json.loads((directory/'features.json').read_text())
            sampled=json.loads((directory/'samples.json').read_text())
            fitted=evidence.fit_plane(sampled,features,args['feature_ids'],args['tolerance_mm'],args['min_inlier_fraction'])
            core.write_json(directory/'features.json',features+[fitted])
            data={'feature':{k:v for k,v in fitted.items() if k!='sampleIndices'},'semanticLabelsInferred':False}
        elif operation=='feature_frame':
            features = json.loads((directory/'features.json').read_text())
            rotation,origin = geometry.feature_frame(features,args)
            for vertex in bm.verts:
                vertex.co = rotation @ (vertex.co-origin)
            transform_evidence(source,directory,rotation,origin)
            data = {'rotation':list(map(list,rotation)),'originMm':list(origin)}
        elif operation=='render_features':
            import closeups
            features=json.loads((directory/'features.json').read_text())
            sampled=json.loads((directory/'samples.json').read_text())
            if max(args['feature_ids'])>=len(features):raise ValueError('feature ID not present in current evidence')
            indices=sorted({i for fid in args['feature_ids'] for i in features[fid]['sampleIndices']})
            points=np.array([sampled[i]['pointMm'] for i in indices])
            # At most 2048 tiny markers; they show observations, not invented cuts.
            displayed=points[np.linspace(0,len(points)-1,min(2048,len(points)),dtype=int)]
            edges=[[list(p-np.eye(3)[axis]*.035),list(p+np.eye(3)[axis]*.035)] for p in displayed for axis in range(3)]
            direction=Vector(args['view_direction']).normalized()
            overall=float(np.ptp(np.array([v.co[:] for v in source.data.vertices]),axis=0).max())
            marker_radius=max(.025,.65*max(float(np.linalg.norm(np.ptp(points,axis=0)))*1.25,overall*.65)/args['resolution'])
            target={'targetMm':points.mean(0).tolist(),'viewDirection':list(direction),'distanceMm':max(100,float(np.ptp(points,axis=0).max())*4),
                    'regionBoundsMm':{'min':points.min(0).tolist(),'max':points.max(0).tolist()},
                    '_faces':[],'_openingEdges':edges,'_markerRadiusMm':marker_radius}
            display=source.copy();display.data=source.data.copy();bpy.context.collection.objects.link(display)
            display.hide_set(False);display.hide_render=False;source.hide_render=True;obj.hide_render=True
            display_bm=bm_from(display)
            path=directory/('feature-view-%04d.png'%config['sequence'])
            try:closeups.render_target(display,display_bm,target,path,args['resolution'],core)
            finally:
                display_bm.free();mesh=display.data;bpy.data.objects.remove(display,do_unlink=True);bpy.data.meshes.remove(mesh)
                obj.hide_render=False
            data={'featureIds':args['feature_ids'],'containsTexture':False,'evidenceFrame':'retained source',
                  'displayedSamples':len(displayed),'markerRadiusMm':marker_radius,'artifacts':{path.name:core.sha(path)}}
        elif operation=='classify_regions':
            data = evidence.classify(source,args['saturation_min'])
        elif operation=='deviation':
            data = evidence.deviation(source,obj,args['count'],args['seed'])
        elif operation=='advise':
            import closeups
            source.hide_render=True
            data=closeups.analyse(obj,source,bm,before,args['reference_mm'],args['max_targets'],args['axis_labels'])
            for target in data['targets']:
                relative='renders/target-%02d.png'%target['rank']
                path=directory/relative
                closeups.render_target(obj,bm,target,path,args['resolution'],core)
                target['render']={'path':relative,'sha256':core.sha(path),'containsTexture':False}
        elif operation=='render':
            source.hide_render = True
            obj.hide_render = False
            out = directory/('views-%04d'%config['sequence'])
            data = core.render(obj,bm,{'out':str(out),'resolution':args['resolution'],'keep_orientation':True})
            data['artifacts'] = {str(p.relative_to(directory)):core.sha(p) for p in sorted(out.glob('*.png'))}
        elif operation=='export':
            out = directory/'export'
            out.mkdir(exist_ok=True)
            material = json.loads((directory/'materials.json').read_text())
            uv = bm.loops.layers.uv.active is not None
            edited = bool(obj.get('geometry_edited',True))
            if edited and obj.get('source_has_texture') and not uv:
                raise ValueError('edit discarded captured UVs; textured result cannot be exported')
            declared = material['names']
            names = [None if m is None else m.name.rpartition('.')[0]
                     if m.name not in declared and m.name.rpartition('.')[0] in declared else m.name
                     for m in obj.data.materials]
            core.export(bm,out,uv=uv,materials=names)
            source = directory/'input'/material['mesh']
            copied = not edited and material['scale']==1 and source.suffix.lower()=='.obj'
            if copied:
                # A measured/observed-only run must not rewrite the repaired capture.
                shutil.copyfile(source,out/'repaired.obj')
            elif material['libraries']:
                # Keep one library per declaration, matching staging and Blender's
                # importer; a joined filename is not a portable multi-MTL OBJ.
                with tempfile.TemporaryFile(dir=out) as spool:
                    with (out/'repaired.obj').open('rb') as geometry_file:
                        spool.write(geometry_file.readline())  # units header
                        for library in material['libraries']:
                            spool.write(('mtllib '+library+'\n').encode('utf-8'))
                        shutil.copyfileobj(geometry_file,spool)
                    spool.seek(0)
                    with (out/'repaired.obj').open('wb') as geometry_file:
                        shutil.copyfileobj(spool,geometry_file)
            for name in material['files']:
                target = out/name
                target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(directory/'input'/name,target)
            data = {'uvRetained':uv,'geometryEdited':edited,'inputObjCopied':copied,
                    'materialFiles':material['files'],
                    'artifacts':{str(p.relative_to(directory)):core.sha(p)
                                 for p in sorted(out.rglob('*')) if p.is_file()}}
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
