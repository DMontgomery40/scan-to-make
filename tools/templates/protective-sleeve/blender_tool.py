# SPDX-License-Identifier: GPL-3.0-or-later
"""Open-top conformal sleeve: silhouette pocket, Euclidean wall offset, solid floor."""
import importlib.util
import math
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location('fit_core',Path(__file__).resolve().parents[1]/'_fitted-core'/'fit_core.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def generate(a):
    source,ext,shift = core.load(a)
    c,w,f,g = a['clearance_mm'],a['wall_mm'],a['floor_mm'],a['grid_mm']
    top = a['coverage']*float(ext[2])
    i0,j0,pocket = core.silhouette(source,g,c,top,int(math.ceil(w/g))+3)
    outer = core.dilate(pocket,g,w)
    occ = np.stack([outer,outer&~pocket],axis=2)
    nx,ny = pocket.shape
    part = core.solid(occ,core.grid_lines(i0,nx,g),core.grid_lines(j0,ny,g),np.array([-c-f,-c,top]),'sleeve')
    pi0,pi1,pj0,pj1 = core.bbox_cells(pocket)
    fit = {'minimumSideWallMm':core.min_gap(pocket,~outer,g),'floorThicknessMm':f,
           'pocketOpeningMm':[(pi1-pi0)*g,(pj1-pj0)*g],'pocketDepthMm':top+c,
           'sleeveTopZMm':top,'objectExposedAboveSleeveMm':float(ext[2])-top}
    core.finish(a,'protective-sleeve','sleeve.stl',source,ext,shift,part,fit,
                'XY silhouette of triangles below the sleeve top, grown by clearance in L-infinity on exact cell squares; '
                'Euclidean cell-square wall offset; extruded open-top prism on a solid floor',
                ['Prismatic pocket follows the widest silhouette below the sleeve top; it is loose around narrower sections.',
                 'Grid quantisation makes walls and clearance at least, not exactly, the requested values.',
                 'Sampled mesh distances do not establish physical fit, flexibility or manufacturing tolerance.',
                 'No retaining lip: the object lifts straight out along +Z.'])


if __name__=='__main__':
    generate(core.request())
