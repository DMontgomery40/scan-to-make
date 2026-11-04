"""Writes the caliper's print files.

    python -m caliper.build OUT_DIR [--docs-url URL]

* caliper-2colour.3mf: body colour = filament slot 1, marking colour = slot 2. On an AMS
  this prints with 2 filament changes.
* caliper-1colour.3mf: every part on slot 1. Print it as is for one colour, or slice it and
  add pauses at `pause_at_z` (caliper.json) to swap filament by hand without an AMS.
* caliper.stl: both parts as laid out, one colour, for any printer and slicer.
* caliper-body.stl, caliper-marking.stl: the two colours separately, for other multi-material slicers.
* caliper.json: how to read it, fiducial positions, QR contents, colour bands, plate layout.

Everything is laid out for a 180 x 180 mm bed (and fits larger ones). The slider prints face down.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from manifold3d import Manifold

from .design import BODY, MARKING, Design, Params, build, print_slider
from .threemf import Object, Part, Project, project_bytes, stl_bytes

BED_CENTRE = (128.0, 128.0)  # the slicer re-arranges onto the actual bed
EXTRUDER = {BODY: 1, MARKING: 2}


def _part(name: str, solid: Manifold, extruder: int) -> Part:
    mesh = solid.to_mesh()
    return Part(name, np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3], np.asarray(mesh.tri_verts, dtype=np.int64), extruder)


def plate(design: Design) -> dict:
    """Card and face-down slider positions: the slider's strip sits in the empty band under the card's top member."""
    p = design.params
    # After turning the slider over about y, its strip runs from x=0 to x=-strip_left and its head is at x<0.
    slider_dx = -(-p.strip_left) - 14.0  # strip ends 2 mm short of the card's outside jaw (x >= -12)
    slider_dy = -33.0
    card_bb = Manifold.batch_boolean([v.solid for v in design.card], __import__('manifold3d').OpType.Add).bounding_box()
    sl = Manifold.batch_boolean([print_slider(v.solid, p.body) for v in design.slider], __import__('manifold3d').OpType.Add)
    sl_bb = sl.translate([slider_dx, slider_dy, 0]).bounding_box()
    x0, y0 = min(card_bb[0], sl_bb[0]), min(card_bb[1], sl_bb[1])
    x1, y1 = max(card_bb[3], sl_bb[3]), max(card_bb[4], sl_bb[4])
    shift = (BED_CENTRE[0] - (x0 + x1) / 2, BED_CENTRE[1] - (y0 + y1) / 2)
    return {'card': [shift[0], shift[1]], 'slider': [shift[0] + slider_dx, shift[1] + slider_dy],
            'footprint_mm': [round(x1 - x0, 1), round(y1 - y0, 1)]}


def objects(design: Design, extruders: dict[str, int]) -> list[Object]:
    """One object holding the card and the face-down slider, so arranging keeps the slider nested beside the card."""
    layout = plate(design)
    p = design.params
    dx, dy = layout['slider'][0] - layout['card'][0], layout['slider'][1] - layout['card'][1]
    parts = [_part(v.name, v.solid, extruders[v.role]) for v in design.card]
    parts += [_part(v.name, print_slider(v.solid, p.body).translate([dx, dy, 0]), extruders[v.role]) for v in design.slider]
    return [Object('Counterpart caliper', parts, tuple(layout['card']))]


def write(out: Path, params: Params = Params()) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    design = build(params)
    from .preview import render
    render(out / 'preview.png', params=params)
    thumbnail = (out / 'preview.png').read_bytes()
    layout = plate(design)
    description = ('Counterpart caliper: 0-100 mm, 0.2 mm vernier. One scale reads both the OUTSIDE and the INSIDE jaws. '
                   'Print as laid out; the slider prints face down. Slide the slider into the slot from the jaw end.')
    files = {}

    def save(name: str, data: bytes):
        (out / name).write_bytes(data)
        files[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

    save('caliper-2colour.3mf', project_bytes(Project(objects(design, EXTRUDER), title='Counterpart caliper (2 colours)', description=description), thumbnail=thumbnail))
    save('caliper-1colour.3mf', project_bytes(Project(objects(design, {BODY: 1, MARKING: 1}), title='Counterpart caliper', description=description), thumbnail=thumbnail))
    dx, dy = layout['slider'][0] - layout['card'][0], layout['slider'][1] - layout['card'][1]
    card_parts = [_part(v.name, v.solid, 1) for v in design.card]
    slider_parts = [_part(v.name, print_slider(v.solid, params.body).translate([dx, dy, 0]), 1) for v in design.slider]
    save('caliper.stl', stl_bytes(card_parts + slider_parts))
    for role in (BODY, MARKING):
        save(f'caliper-{role}.stl', stl_bytes([part for part, v in zip(card_parts + slider_parts, design.card + design.slider) if v.role == role]))
    meta = dict(design.meta)
    closed = Manifold.batch_boolean([v.solid for v in design.card + design.slider], __import__('manifold3d').OpType.Add).bounding_box()
    meta['assembled_size_mm'] = [round(closed[3] - closed[0], 1), round(closed[4] - closed[1], 1), round(closed[5] - closed[2], 1)]
    meta['plate'] = {**layout, 'bed_centre': list(BED_CENTRE),
                     'note': 'Positions are plate coordinates of each object origin; the slider is turned face down.'}
    meta['filament_slots'] = {'1': BODY, '2': MARKING}
    meta['files'] = files
    (out / 'caliper.json').write_text(json.dumps(meta, indent=2) + '\n')
    return meta


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('out', type=Path)
    parser.add_argument('--docs-url', default=Params().docs_url)
    args = parser.parse_args(argv)
    meta = write(args.out, Params(docs_url=args.docs_url))
    print(json.dumps({'out': str(args.out), 'plate': meta['plate'], 'files': sorted(meta['files'])}, indent=2))


if __name__ == '__main__':
    main()
