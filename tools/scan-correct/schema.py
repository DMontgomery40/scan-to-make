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
    'find_features': ('Cluster dark texture samples by distance; inspect clusters before interpreting them.',
                      {'threshold':number(0,1),'link_mm':number(.1,10),'min_samples':number(3,1000,True)}),
    'feature_frame': ('Frame from three measured feature cluster IDs: origin, X direction and XY plane.',
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
    'convex_hull': ('Convex product prior: removes concavities and feature detail.', {}),
    'remesh': ('Voxel remesh under grid and polygon caps; destroys detail.', {'voxel_mm':number(.05,10)}),
    'smooth': ('Uniform Laplacian smoothing followed by measured volume restoration.',
               {'iterations':number(1,30,True),'factor':number(.01,.5)}),
    'scale_to_reference': ('Fit long-to-short box extents to declared reference; match is by construction.',
                           {'target_mm':vector(.1,2000)}),
    'cut_feature': ('Ray-located blind slot/pocket/hole or perimeter groove; fails if volume/topology checks fail.',
                    {'kind':enum('slot','pocket','hole','groove'),'axis':AXIS,
                     'side':{'type':'integer','enum':[-1,1]},'centre_mm':vector(),
                     'length_mm':number(.1,100),'width_mm':number(.1,100),'depth_mm':number(.05,50)}),
    'deviation': ('Two-sided sampled BVH deviation split by retained source captured/filled mask.',
                  {'count':number(100,20000,True),'seed':number(0,1000000,True)}),
}
SPECS['cut_oriented_feature']=('Cut with an explicit transverse length axis; same volume/topology guards.',
                               {**SPECS['cut_feature'][1],'length_axis':AXIS})
TOOLS = [{'name':name,'description':description,'input_schema':{'type':'object','properties':{**props,'evidence_still_ids':{'type':'array','items':enum('still-1','still-2','still-3','still-4'),'minItems':0,'maxItems':4}},
          'required':list(props),'additionalProperties':False}} for name,(description,props) in SPECS.items()]


def check_value(value, spec):
    kind = spec['type']
    if kind in ('number','integer'):
        valid = type(value) in ((int,) if kind=='integer' else (int,float))
        valid = valid and math.isfinite(value) and spec.get('minimum',-math.inf) <= value <= spec.get('maximum',math.inf)
    elif kind == 'string':
        valid = isinstance(value,str)
    elif kind == 'array':
        valid = isinstance(value,list) and len(value)==spec['minItems']
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
    if set(args) != set(props):
        raise ValueError('missing or unexpected tool parameters')
    for key,value in args.items():
        check_value(value,props[key])
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
