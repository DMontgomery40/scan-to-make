# SPDX-License-Identifier: GPL-3.0-or-later
"""Wall pocket: open-top silhouette cup fused to a back plate with two screw holes."""
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
    c,w,f,g = a['clearance_mm'],a['wall_mm'],a['floor_mm'],a['grid_mm']
    radius,spacing = a['screw_hole_mm']/2,a['screw_spacing_mm']
    top = a['hold_depth']*float(ext[2])
    plate_top = top+a['plate_extension_mm']
    m,p = cells(w,g),cells(a['plate_mm'],g)
    half = spacing/2+radius+w
    # Pocket uses every triangle below the plate top, so the plate also clears
    # parts of the object standing above the cup.
    i0,j0,pocket = core.silhouette(source,g,c,plate_top,m+p+cells(half,g)+3)
    shape = pocket.shape
    pi0,pi1,pj0,pj1 = core.bbox_cells(pocket)
    cup = core.rect_mask(shape,pi0-m,pi1+m,pj0-m,pj1+m)
    xa = min(pi0-m,int(math.floor(-half/g))-i0)
    xb = max(pi1+m,int(math.ceil(half/g))-i0)
    plate = core.rect_mask(shape,xa,xb,pj0-m-p,pj0-m)
    zc = top+a['plate_extension_mm']/2
    band = int(math.ceil(radius/g))+1
    zs = np.unique(np.round([-c-f,-c,top,plate_top]+[zc+k*g for k in range(-band,band+1)],9))
    xs,ys = core.grid_lines(i0,shape[0],g),core.grid_lines(j0,shape[1],g)
    # Hole cells: any cell square meeting a requested-diameter disc (XZ plane).
    holes = np.zeros((shape[0],len(zs)-1),bool)
    for centre in (-spacing/2,spacing/2):
        dx = np.maximum.reduce([xs[:-1]-centre,np.zeros(shape[0]),centre-xs[1:]])
        dz = np.maximum.reduce([zs[:-1]-zc,np.zeros(len(zs)-1),zc-zs[1:]])
        holes |= np.hypot(dx[:,None],dz[None,:]) <= radius
    holes = core.fill_diagonals(holes)
    occ = np.zeros(shape+(len(zs)-1,),bool)
    for k in range(len(zs)-1):
        mid = (zs[k]+zs[k+1])/2
        if mid < -c:
            occ[:,:,k] = cup|plate
        elif mid < top:
            occ[:,:,k] = (cup&~pocket)|plate
        else:
            occ[:,:,k] = plate&~holes[:,k][:,None]
    part = core.solid(occ,xs,ys,zs,'wall-mount')
    spans = []
    for sign in (-1,1):
        h = np.argwhere(holes&(sign*(xs[:-1]+g/2) > 0)[:,None])
        spans.append([float(xs[h[:,0].max()+1]-xs[h[:,0].min()]),float(zs[h[:,1].max()+1]-zs[h[:,1].min()])])
    fit = {'minimumSideWallMm':core.min_gap(pocket,~(cup|plate),g),'floorThicknessMm':f,
           'pocketOpeningMm':[(pi1-pi0)*g,(pj1-pj0)*g],'pocketDepthMm':top+c,'cupTopZMm':top,
           'plateThicknessMm':p*g,'plateBackYMm':float(ys[pj0-m-p]),'plateTopZMm':plate_top,
           'backWallTotalMm':(m+p)*g,
           'screwHoles':{'requestedDiameterMm':2*radius,'centresXZMm':[[-spacing/2,zc],[spacing/2,zc]],
                         'openingSpansXZMm':spans,'containsRequestedDisc':True}}
    core.finish(a,'wall-mount','mount.stl',source,ext,shift,part,(occ,xs,ys,zs),fit,
                'XY silhouette of triangles below the plate top, grown by clearance in L-infinity on exact cell squares; '
                'rectangular cup with grid-rounded walls fused to a -Y back plate; screw holes cover the requested discs',
                ['The wall is the plane y = plateBackYMm; the object drops in along +Z from above.',
                 'Prismatic pocket follows the widest silhouette; it is loose around narrower sections.',
                 'Screw holes are stepped cell approximations that contain the requested diameter; no countersink.',
                 'Grid quantisation makes walls, plate and clearance at least, not exactly, the requested values.',
                 'No load rating: sampled geometry does not establish strength, fastener holding or physical fit.'])


if __name__=='__main__':
    generate(core.request())
