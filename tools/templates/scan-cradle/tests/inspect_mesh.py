# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent checks on serialized STL, rather than trusting the manifest."""
import importlib.util
from pathlib import Path
import sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

root=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('repair',root/'scan-repair'/'blender_tool.py')
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
source,output=sys.argv[sys.argv.index('--')+1:]
_,obj=r.load(source,1)
points=[v.co.copy() for v in obj.verts]+[sum((v.co for v in f.verts),Vector())/len(f.verts) for f in obj.faces]
_,cradle=r.load(output,1)
assert r.stats(cradle)['watertight']
tree=BVHTree.FromBMesh(cradle)
assert min(tree.find_nearest(p)[3] for p in points)>=.27
# Every interior top face must face up; a roof/overhang would face down.
for f in cradle.faces:
    if f.normal.z<-.001:
        assert max(v.co.z for v in f.verts)<-2.29, 'downward pocket roof'
# A vertical ray through every source sample must reach the floor BELOW the
# seated sample. This remains true throughout any positive Z translation.
for p in points:
    hit=tree.ray_cast(p+Vector((0,0,200)),Vector((0,0,-1)))[0]
    assert hit is not None and hit.z<=p.z-.27, (tuple(p),hit)
# Measure cavity-floor samples against exterior bottom and side planes.
coords=[v.co for v in cradle.verts]
low=[min(v[i] for v in coords) for i in range(3)]
high=[max(v[i] for v in coords) for i in range(3)]
seat=high[2]
for v in coords:
    if low[2]+1e-4<v.z<seat-1e-4:
        assert min(v.z-low[2],v.x-low[0],high[0]-v.x,v.y-low[1],high[1]-v.y)>=1.999
print('Independent STL: watertight; clearance >= 0.27 mm; walls >= 1.999 mm; upward lift rays clear')
