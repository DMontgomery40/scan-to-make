# SPDX-License-Identifier: GPL-3.0-or-later
"""Closed tool vocabulary shared by runner and trusted Blender worker."""
import math


def number(lo, hi, integer=False):
    return {'type':'integer' if integer else 'number','minimum':lo,'maximum':hi}


def vector(lo=-10000,hi=10000):
    return {'type':'array','items':number(lo,hi),'minItems':3,'maxItems':3}


def enum(*values):
    return {'type':'string','enum':list(values)}


AXIS = enum('X','Y','Z')
SPECS = {
    'measure': ('Measure topology, volume and oriented box; does not prove accuracy.', {}),
    'render': ('Render ten neutral views in the stored input frame.', {'resolution':number(16,1024,True)}),
    'sample_texture': ('Sample retained textured source by surface area, returns evidence and cache.',
                       {'count':number(100,20000,True),'seed':number(0,1000000,True)}),
    'find_features': ('Cluster dark or locally darker samples by distance; contrast is optional. Inspect measured clusters before interpreting them.',
                      {'threshold':number(0,1),'link_mm':number(.1,10),'min_samples':number(3,1000,True)}),
    'feature_frame': ('Frame from measured clusters: default centres mode uses origin, X direction and XY point. principal_axes mode uses the X cluster long axis and plane cluster normal as Y.',
                      {'origin_feature':number(0,127,True),'x_feature':number(0,127,True),
                       'plane_feature':number(0,127,True)}),
    'classify_regions': ('Heuristic filled-face mask on retained source using texture saturation, not capture truth.',
                         {'saturation_min':number(0,1)}),
    'symmetrize': ('Average both sides against mirrored surfaces, then copy one side for exact symmetry.',
                   {'axis':AXIS,'direction':enum('NEGATIVE','POSITIVE'),'iterations':number(1,4,True)}),
    'rigid_frame': ('Apply an explicitly measured proper rotation and translation to geometry and source evidence.',
                    {'rotation':{'type':'array','items':number(-1,1),'minItems':9,'maxItems':9},
                     'translation_mm':vector()}),
    'mirror': ('Copy one side across the origin without averaging captured and missing sides.',
               {'axis':AXIS,'direction':enum('NEGATIVE','POSITIVE')}),
    'laplacian_smooth': ('Blender normalized volume-preserving Laplacian modifier; distinct from uniform smoothing.',
                         {'iterations':number(1,30,True),'lambda_factor':number(.01,1)}),
    'subdivide': ('Bounded Catmull-Clark subdivision under the output face cap.',{'levels':number(1,2,True)}),
    'convex_hull': ('Convex product prior: removes concavities and feature detail. Unavailable for textured captures because it discards UVs.', {}),
    'remesh': ('Voxel remesh under grid and polygon caps; destroys detail. Unavailable for textured captures because it discards UVs.', {'voxel_mm':number(.05,10)}),
    'smooth': ('Uniform Laplacian smoothing followed by measured volume restoration.',
               {'iterations':number(1,30,True),'factor':number(.01,.5)}),
    'scale_to_reference': ('Fit long-to-short box extents to declared reference; match is by construction.',
                           {'target_mm':vector(.1,2000)}),
    'cut_feature': ('Legacy cyclic tangent axes X->Y, Y->Z, Z->X. Prefer cut_oriented_feature for measured slot/pocket direction. Same ray/volume/topology guards.',
                    {'kind':enum('slot','pocket','hole','groove'),'axis':AXIS,
                     'side':{'type':'integer','enum':[-1,1]},'centre_mm':vector(),
                     'length_mm':number(.1,100),'width_mm':number(.1,100),'depth_mm':number(.05,50)}),
    'deviation': ('Two-sided sampled BVH deviation split by retained source captured/filled mask.',
                  {'count':number(100,20000,True),'seed':number(0,1000000,True)}),
}
SPECS['cut_oriented_feature']=('Cut with an explicit transverse length axis; same volume/topology guards.',
                               {**SPECS['cut_feature'][1],'length_axis':AXIS})
SPECS['sample_texture_region']=('Area-sample only the retained surface inside a measured box, preserving UVs. Replaces prior samples/features.',
    {**SPECS['sample_texture'][1],'min_mm':vector(),'max_mm':vector()})
SPECS['render_features']=('Render selected measured sample clusters on neutral retained geometry; no texture or semantic labels.',
    {'feature_ids':{'type':'array','items':number(0,127,True),'minItems':1,'maxItems':8},
     'view_direction':vector(-1,1),'resolution':number(64,512,True)})
SPECS['fit_feature_plane']=('Fit a robust plane through selected disconnected texture clusters; creates a measured feature ID for framing.',
    {'feature_ids':{'type':'array','items':number(0,127,True),'minItems':1,'maxItems':8},
     'tolerance_mm':number(.01,2),'min_inlier_fraction':number(.3,1)})
OPTIONAL = {
    'sample_texture': {'retain_samples':enum('replace','append')},
    'sample_texture_region': {'retain_samples':enum('replace','append')},
    'find_features': {'contrast_min':number(0,1),'contrast_radius_mm':number(.1,5)},
    'feature_frame': {'mode':enum('centres','principal_axes')},
}
TOOLS = [{'name':name,'description':description,'input_schema':{'type':'object','properties':{**props,'evidence_still_ids':{'type':'array','items':enum('still-1','still-2','still-3','still-4'),'minItems':0,'maxItems':4}},
          'required':list(props),'additionalProperties':False}} for name,(description,props) in SPECS.items()]
for tool in TOOLS:
    tool['input_schema']['properties'].update(OPTIONAL.get(tool['name'],{}))


def check_value(value, spec):
    kind = spec['type']
    if kind in ('number','integer'):
        valid = type(value) in ((int,) if kind=='integer' else (int,float))
        valid = valid and math.isfinite(value) and spec.get('minimum',-math.inf) <= value <= spec.get('maximum',math.inf)
    elif kind == 'string':
        valid = isinstance(value,str)
    elif kind == 'array':
        valid = isinstance(value,list) and spec['minItems'] <= len(value) <= spec['maxItems']
        if valid:
            for item in value:
                check_value(item,spec['items'])
    else:
        valid = False
    if not valid or ('enum' in spec and value not in spec['enum']):
        raise ValueError('parameter outside tool schema')


def validate(name, args):
    if name not in SPECS or not isinstance(args,dict):
        raise ValueError('unknown tool or non-object arguments')
    props = SPECS[name][1]
    optional=OPTIONAL.get(name,{})
    if not set(props)<=set(args) or set(args)-set(props)-set(optional):
        raise ValueError('missing or unexpected tool parameters')
    for key,value in args.items():
        check_value(value,{**props,**optional}[key])
    if name=='sample_texture_region' and any(a>=b for a,b in zip(args['min_mm'],args['max_mm'])):
        raise ValueError('region min_mm must be below max_mm on every axis')
    if name=='render_features' and (sum(v*v for v in args['view_direction'])<1e-8 or len(set(args['feature_ids']))!=len(args['feature_ids'])):
        raise ValueError('render needs a nonzero direction and unique feature IDs')
    if name == 'scale_to_reference' and args['target_mm'] != sorted(args['target_mm'],reverse=True):
        raise ValueError('target_mm must be long to short')
    if name=='cut_oriented_feature' and args['length_axis']==args['axis']:
        raise ValueError('feature length axis must be transverse to its cutting axis')
    if name=='rigid_frame':
        r=[args['rotation'][i:i+3] for i in (0,3,6)]
        if any(abs(sum(a*b for a,b in zip(r[i],r[j]))-(1 if i==j else 0))>1e-4 for i in range(3) for j in range(3)):
            raise ValueError('rotation must be orthonormal')
        det=r[0][0]*(r[1][1]*r[2][2]-r[1][2]*r[2][1])-r[0][1]*(r[1][0]*r[2][2]-r[1][2]*r[2][0])+r[0][2]*(r[1][0]*r[2][1]-r[1][1]*r[2][0])
        if abs(det-1)>1e-4:
            raise ValueError('rotation must be proper, without reflection')
    return args
