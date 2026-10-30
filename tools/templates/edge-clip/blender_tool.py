# SPDX-License-Identifier: GPL-3.0-or-later
"""Edge clip: open-top silhouette cup whose floor is the upper jaw of a C-clamp
that slides onto a desk or shelf edge from the front (+Y)."""
import importlib.util
import math
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location('fit_core',Path(__file__).resolve().parents[1]/'_fitted-core'/'fit_core.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def cells(mm, g):
    return int(math.ceil(mm/g-1e-9))


def generate(a):
    source,ext,shift = core.load(a)
    c,w,jaw,g = a['clearance_mm'],a['wall_mm'],a['jaw_mm'],a['grid_mm']
    slot = a['edge_thickness_mm']+a['edge_clearance_mm']
    top = a['hold_depth']*float(ext[2])
    m,s,q = cells(w,g),cells(jaw,g),cells(a['grip_depth_mm'],g)
    i0,j0,pocket = core.silhouette(source,g,c,top,m+s+q+3)
    shape = pocket.shape
    pi0,pi1,pj0,pj1 = core.bbox_cells(pocket)
    xa,xb,front = pi0-m,pi1+m,pj1+m
    back = front-s-q
    cup = core.rect_mask(shape,xa,xb,pj0-m,front)
    upper = core.rect_mask(shape,xa,xb,min(back,pj0-m),front)
    spine = core.rect_mask(shape,xa,xb,front-s,front)
    lower = core.rect_mask(shape,xa,xb,back,front)
    upper_bottom = -c-jaw
    zs = np.array([upper_bottom-slot-jaw,upper_bottom-slot,upper_bottom,-c,top])
    occ = np.stack([lower,spine,upper,cup&~pocket],axis=2)
    xs,ys = core.grid_lines(i0,shape[0],g),core.grid_lines(j0,shape[1],g)
    part = core.solid(occ,xs,ys,zs,'edge-clip')
    fit = {'minimumSideWallMm':core.min_gap(pocket,~cup,g),'floorThicknessMm':jaw,
           'pocketOpeningMm':[(pi1-pi0)*g,(pj1-pj0)*g],'pocketDepthMm':top+c,'cupTopZMm':top,
           'slotHeightMm':slot,'slotZMm':[float(zs[1]),float(zs[2])],'slotOpenAtYMm':float(ys[back]),
           'spineInnerYMm':float(ys[front-s]),'gripDepthMm':q*g,'spineThicknessMm':s*g,
           'jawThicknessMm':jaw,'clipWidthMm':(xb-xa)*g}
    core.finish(a,'edge-clip','clip.stl',source,ext,shift,part,fit,
                'XY silhouette of triangles below the cup top, grown by clearance in L-infinity on exact cell squares; '
                'rectangular cup whose floor is the upper jaw of a C-clamp; slot open toward -Y, spine at +Y',
                ['The edge enters the slot from -Y; the cup sits above the desk or shelf surface.',
                 'Slot height is edge thickness plus edge clearance; there is no sprung grip or friction pad.',
                 'Grip depth, spine and walls are rounded up to the grid; jaw and slot heights are exact.',
                 'Prismatic pocket follows the widest silhouette; it is loose around narrower sections.',
                 'No load rating: sampled geometry does not establish strength, clamping force or physical fit.'])


if __name__=='__main__':
    generate(core.request())
