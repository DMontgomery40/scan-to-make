# SPDX-License-Identifier: GPL-3.0-or-later
"""Render a scan or an AI attempt from fixed cameras for the visual pick (KAN-184).

blender -b --factory-startup -P render.py -- --mesh M.obj --cams cams.json --out DIR [--make-cams] [--ring] [--resolution 1600]

The cameras are computed once from the captured (raw) scan with --make-cams and reused for every
candidate, so views line up pixel for pixel. Shading is always flat and derived from the geometry:
an attempt's own smooth normals would make melted and intact stitches look alike. Each view is
written twice: textured, and plain grey (geometry detail shows best there).
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

VIEWS = {
    'front': (0, -1, 0), 'back': (0, 1, 0), 'left': (-1, 0, 0), 'right': (1, 0, 0),
    'top': (0, 0, 1), 'bottom': (0, 0, -1), 'iso_front_left': (-1, -1, 0.8), 'iso_back_right': (1, 1, 0.8),
}


def ring_views():
    """Eight extra cameras at 35 degrees elevation, between the side views, for matching close-ups."""
    out = {}
    for i in range(8):
        azimuth = math.radians(22.5 + 45 * i)
        out[f'ring_{i:02d}'] = (math.cos(azimuth), math.sin(azimuth), math.tan(math.radians(35)))
    return out


def arguments():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    options = {'make_cams': False, 'ring': False, 'resolution': 1600}
    i = 0
    while i < len(argv):
        key = argv[i]
        if key in ('--make-cams', '--ring'):
            options[key[2:].replace('-', '_')] = True
            i += 1
        elif key in ('--mesh', '--cams', '--out', '--resolution'):
            options[key[2:]] = argv[i + 1]
            i += 2
        else:
            raise SystemExit('unknown argument ' + key)
    for key in ('mesh', 'cams', 'out'):
        if key not in options:
            raise SystemExit('--mesh, --cams and --out are required')
    options['resolution'] = int(options['resolution'])
    if not 64 <= options['resolution'] <= 4096:
        raise SystemExit('resolution must be 64-4096')
    return options


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(path)[1].lower()
    if ext != '.obj':
        raise SystemExit('only OBJ bundles are rendered')
    bpy.ops.wm.obj_import(filepath=path)
    objects = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objects:
        raise SystemExit('no mesh in ' + path)
    for o in objects:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        if o.data.has_custom_normals:
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
        o.data.shade_flat()
    return objects


def main():
    options = arguments()
    objects = load(options['mesh'])
    points = [o.matrix_world @ v.co for o in objects for v in o.data.vertices]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    # Any textured part turns texture mode on; untextured parts (a repair patch, a separate eye) then show
    # their material colour instead of hiding the whole scan's texture.
    textured = any(
        len(o.data.uv_layers) > 0 and any(
            n.type == 'TEX_IMAGE' and n.image
            for s in o.material_slots if s.material and s.material.node_tree for n in s.material.node_tree.nodes)
        for o in objects)
    if options['make_cams']:
        centre, radius = (low + high) / 2, (high - low).length
        views = dict(VIEWS)
        if options['ring']:
            views.update(ring_views())
        directions = {name: Vector(d).normalized() for name, d in views.items()}
        # One frame for every view, wide enough for the box's largest projection plus a margin, so a long
        # object is never clipped and every candidate lines up pixel for pixel.
        corners = [Vector((x, y, z)) - centre for x in (low.x, high.x) for y in (low.y, high.y) for z in (low.z, high.z)]
        extent = 0.0
        for direction in directions.values():
            rotation = (-direction).to_track_quat('-Z', 'Y')
            right, up = rotation @ Vector((1, 0, 0)), rotation @ Vector((0, 1, 0))
            for axis in (right, up):
                values = [corner.dot(axis) for corner in corners]
                extent = max(extent, max(values) - min(values))
        cams = {'center': list(centre), 'orthoScale': extent * 1.08, 'distance': radius * 3,
                'views': {name: list(d) for name, d in directions.items()}}
        with open(options['cams'], 'w') as stream:
            json.dump(cams, stream, indent=1)
    with open(options['cams']) as stream:
        cams = json.load(stream)
    os.makedirs(options['out'], exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x = scene.render.resolution_y = options['resolution']
    scene.display.render_aa = '16'
    shading = scene.display.shading
    shading.light = 'STUDIO'
    shading.show_specular_highlight = False
    shading.show_cavity = False
    scene.world = bpy.data.worlds.new('neutral')
    scene.world.color = (0.82, 0.82, 0.82)
    scene.view_settings.view_transform = 'Standard'
    camera_data = bpy.data.cameras.new('camera')
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = cams['orthoScale']
    camera_data.clip_start, camera_data.clip_end = 0.0001, 1000
    camera = bpy.data.objects.new('camera', camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    centre = Vector(cams['center'])
    written = []
    for mode in ('textured', 'grey'):
        if mode == 'textured' and textured:
            shading.color_type = 'TEXTURE'
        else:
            shading.color_type = 'SINGLE'
            shading.single_color = (0.62, 0.62, 0.62) if mode == 'grey' else (0.7, 0.62, 0.5)
        for name, direction in cams['views'].items():
            direction = Vector(direction)
            camera.location = centre + direction * cams['distance']
            camera.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = os.path.join(options['out'], f'{mode}_{name}.png')
            bpy.ops.render.render(write_still=True)
            written.append(f'{mode}_{name}.png')
    report = {'mesh': os.path.basename(options['mesh']), 'images': written, 'textured': textured,
              'orthoScale': cams['orthoScale'],
              'objects': len(objects), 'vertices': len(points),
              'bboxMin': list(low), 'bboxMax': list(high)}
    with open(os.path.join(options['out'], 'render.json'), 'w') as stream:
        json.dump(report, stream, indent=1)


main()
