# SPDX-License-Identifier: GPL-3.0-or-later
"""Measure how far an AI attempt moved the captured scan (KAN-184's geometry veto).

blender -b --factory-startup -P measure.py -- --reference raw.obj --candidate attempt.obj --out m.json [--mm-per-unit 1000]

Reports, in mm:
- for each captured vertex, its distance to the attempt's surface (mean, p50, p95, max and the share
  moved more than 0.1 mm);
- the reverse distances;
- both bounding boxes;
- closed-mesh and shell counts.

The veto itself is decided by the caller. These numbers can reject an attempt (a smoothed or
squashed scan moves almost every captured point) but never choose one.
"""
import json
import os
import sys

import bmesh
import bpy
from mathutils.bvhtree import BVHTree


def arguments():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    options = {'mm_per_unit': 1000.0}
    for key, value in zip(argv[::2], argv[1::2]):
        if key not in ('--reference', '--candidate', '--out', '--mm-per-unit'):
            raise SystemExit('unknown argument ' + key)
        options[key[2:].replace('-', '_')] = value
    if not all(k in options for k in ('reference', 'candidate', 'out')):
        raise SystemExit('--reference, --candidate and --out are required')
    options['mm_per_unit'] = float(options['mm_per_unit'])
    return options


def load(path):
    before = set(bpy.data.objects)
    if os.path.splitext(path)[1].lower() != '.obj':
        raise SystemExit('only OBJ is measured')
    bpy.ops.wm.obj_import(filepath=path)
    mesh = bmesh.new()
    for obj in [o for o in bpy.data.objects if o not in before and o.type == 'MESH']:
        part = bmesh.new()
        part.from_mesh(obj.data)
        part.transform(obj.matrix_world)
        data = bpy.data.meshes.new('part')
        part.to_mesh(data)
        mesh.from_mesh(data)
        part.free()
    return mesh


def stats(mesh, scale):
    welded = mesh.copy()
    bmesh.ops.remove_doubles(welded, verts=welded.verts, dist=1e-7)
    boundary = sum(1 for e in welded.edges if len(e.link_faces) == 1)
    nonmanifold = sum(1 for e in welded.edges if len(e.link_faces) > 2)
    welded.verts.ensure_lookup_table()
    seen, shells = set(), 0
    for vertex in welded.verts:
        if vertex.index in seen:
            continue
        shells += 1
        stack = [vertex]
        seen.add(vertex.index)
        while stack:
            current = stack.pop()
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other.index not in seen:
                    seen.add(other.index)
                    stack.append(other)
    coords = [v.co for v in welded.verts]
    low = [min(c[i] for c in coords) * scale for i in range(3)]
    high = [max(c[i] for c in coords) * scale for i in range(3)]
    result = {'vertices': len(welded.verts), 'faces': len(welded.faces), 'boundaryEdges': boundary,
              'nonManifoldEdges': nonmanifold, 'closed': boundary == 0 and nonmanifold == 0, 'shells': shells,
              'bboxMinMm': [round(x, 3) for x in low], 'bboxMaxMm': [round(x, 3) for x in high],
              'bboxMm': [round(high[i] - low[i], 3) for i in range(3)]}
    welded.free()
    return result


def distances(source, target, scale):
    tree = BVHTree.FromBMesh(target)
    values = []
    for vertex in source.verts:
        hit = tree.find_nearest(vertex.co)
        values.append((hit[3] if hit[0] is not None else float('inf')) * scale)
    values.sort()
    n = len(values)
    return {'meanMm': round(sum(values) / n, 5), 'p50Mm': round(values[n // 2], 5), 'p95Mm': round(values[int(n * 0.95)], 5),
            'maxMm': round(values[-1], 4), 'shareOver0_1Mm': round(sum(1 for v in values if v > 0.1) / n, 4)}


def main():
    options = arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    reference, candidate = load(options['reference']), load(options['candidate'])
    scale = options['mm_per_unit']
    report = {'reference': stats(reference, scale), 'candidate': stats(candidate, scale),
              'capturedToCandidate': distances(reference, candidate, scale),
              'candidateToCaptured': distances(candidate, reference, scale), 'mmPerUnit': scale}
    with open(options['out'], 'w') as stream:
        json.dump(report, stream, indent=1)


main()
