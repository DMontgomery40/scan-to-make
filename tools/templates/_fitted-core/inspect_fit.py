# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent checks on a serialized fitted-template STL, not the manifest.

Run with Blender --python inspect_fit.py -- REQUEST.json. The request names the
source mesh, output STL, frame, wall top and optional probe rays. Prints one
line 'INSPECT {json}' with ray-measured clearance, walls, floor and lift-out."""
import importlib.util
import json
from pathlib import Path
import sys

from mathutils import Vector
from mathutils.bvhtree import BVHTree

spec = importlib.util.spec_from_file_location('fit_core',Path(__file__).with_name('fit_core.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
r = core.repair

cfg = json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text())
_,source = r.load(cfg['source'],1)
for v in source.verts:
    v.co = core.to_frame(v.co,cfg['up'],[-t for t in cfg['translation']])
_,part = r.load(cfg['stl'],1)
tree = BVHTree.FromBMesh(part)
points = core.samples(source)


def segment(origin, direction):
    """Entry distance and material thickness along one ray, or None."""
    hit = tree.ray_cast(origin,direction)[0]
    if hit is None:
        return None
    exit_hit = tree.ray_cast(hit+direction*1e-4,direction)[0]
    if exit_hit is None:
        raise AssertionError('ray entered material but never left: open mesh')
    return (hit-origin).length,(exit_hit-hit).length


walls,floors,entries,missing = [],[],[],0
for p in points:
    below = segment(p+core.LATERAL_JITTER,Vector((0,0,-1)))
    if below is None:
        missing += 1
    else:
        entries.append(below[0])
        floors.append(below[1])
    if p.z < cfg['wallTop']-.05:
        for d in ((1,0,0),(-1,0,0),(0,1,0),(0,-1,0)):
            side = segment(p+core.VERTICAL_JITTER,Vector(d))
            if side is None:
                missing += 1
            else:
                entries.append(side[0])
                walls.append(side[1])
coords = [v.co for v in part.verts]
low = [min(c[i] for c in coords) for i in range(3)]
high = [max(c[i] for c in coords) for i in range(3)]
probes = []
for probe in cfg.get('probes',[]):
    hit = tree.ray_cast(Vector(probe['origin']),Vector(probe['direction']).normalized())[0]
    probes.append(None if hit is None else (hit-Vector(probe['origin'])).length)
result = {'watertight':r.stats(part)['watertight'],
          'minimumClearanceMm':min(tree.find_nearest(p)[3] for p in points),
          'minimumRayEntryMm':min(entries),'raysWithoutWall':missing,
          'liftOutRaysBlocked':sum(tree.ray_cast(p+core.LATERAL_JITTER,Vector((0,0,1)))[0] is not None for p in points),
          'minimumSideWallAlongRaysMm':min(walls),'minimumFloorAlongRaysMm':min(floors),
          'boundingBoxMm':{'min':low,'max':high,'extents':[h-l for h,l in zip(high,low)]},
          'probesMm':probes,'samples':len(points)}
print('INSPECT '+json.dumps(result,sort_keys=True))
