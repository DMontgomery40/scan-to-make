"""Pictures of the sliced caliper, assembled at any reading, drawn from its G-code.

The card's front is seen from above. The slider's face prints on the bed, so it is seen from
below and turned to its use position. The card's back (QR codes) is seen from below.
"""
from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from manifold3d import Manifold, OpType
from PIL import Image

from .design import Design, build, print_slider, Params
from .render import Segments, draw, inside, parse

TABLE = (196, 199, 204, 255)  # a light grey surface behind the caliper


@dataclass
class Sliced:
    segments: Segments
    origin: tuple[float, float]  # plate position of the card's origin
    slider_offset: tuple[float, float]  # the face-down slider's offset from the card origin, as laid out
    is_slider: np.ndarray
    design: Design


def load(sliced_3mf: str | Path, meta_json: str | Path, params: Params = Params()) -> Sliced:
    with zipfile.ZipFile(sliced_3mf) as archive:
        gcode = archive.read('Metadata/plate_1.gcode').decode()
    meta = json.loads(Path(meta_json).read_text())
    layout = meta['plate']
    offset = (layout['slider'][0] - layout['card'][0], layout['slider'][1] - layout['card'][1])
    design = build(params)
    seg = parse(gcode)
    origin = _gcode_origin(seg, design, offset)
    outline = Manifold.batch_boolean([print_slider(v.solid, params.body) for v in design.slider], OpType.Add).project()
    polygons = [np.asarray(p) for p in outline.offset(0.6).translate([offset[0] + origin[0], offset[1] + origin[1]]).to_polygons()]
    mx, my = (seg.x0 + seg.x1) / 2, (seg.y0 + seg.y1) / 2
    is_slider = inside(mx, my, polygons) & ~seg.tower
    return Sliced(seg, origin, offset, is_slider, design)


def _gcode_origin(seg: Segments, design: Design, slider_offset: tuple[float, float]) -> tuple[float, float]:
    """Where the card's origin landed on the plate, read from the G-code itself.

    The slicer arranges the caliper (and may shift it from the project file's positions), so this
    matches the centre of a full-footprint layer above the brim to the centre of the designed footprint.
    """
    p = design.params
    z = round(p.band + 3 * p.layer, 3)  # a body layer below the split, where card and slider are both full outline
    m = (seg.z == z) & ~seg.tower
    if not m.any():
        raise ValueError(f'no layer at z={z}')
    xs, ys = np.concatenate([seg.x0[m], seg.x1[m]]), np.concatenate([seg.y0[m], seg.y1[m]])
    card = Manifold.batch_boolean([v.solid for v in design.card], OpType.Add).bounding_box()
    slider = Manifold.batch_boolean([print_slider(v.solid, p.body) for v in design.slider], OpType.Add).translate(
        [slider_offset[0], slider_offset[1], 0]).bounding_box()
    x0, y0, x1, y1 = min(card[0], slider[0]), min(card[1], slider[1]), max(card[3], slider[3]), max(card[4], slider[4])
    return float((xs.min() + xs.max()) / 2 - (x0 + x1) / 2), float((ys.min() + ys.max()) / 2 - (y0 + y1) / 2)


def _frame(xlim, ylim, k):
    w, h = int((xlim[1] - xlim[0]) * k), int((ylim[1] - ylim[0]) * k)
    return w, h


def assembled(s: Sliced, reading_mm: float, px_per_mm: float = 12.0, xlim=(-152.0, 116.0), ylim=(-37.0, 74.0),
              colours: list[str] | None = None) -> Image.Image:
    """The front of the caliper with the jaws `reading_mm` apart, as printed."""
    k = px_per_mm
    size = _frame(xlim, ylim, k)
    ox, oy = s.origin
    dx, dy = s.slider_offset
    card_xy = lambda x, y: (((x - ox) - xlim[0]) * k, (ylim[1] - (y - oy)) * k)
    # slider: plate -> face-down local -> use position (turned back over about y) -> moved by the reading
    slider_xy = lambda x, y: (((-(x - ox - dx)) + reading_mm - xlim[0]) * k, (ylim[1] - (y - oy - dy)) * k)
    card_sel = ~s.is_slider & ~s.segments.tower
    image = Image.new('RGBA', size, TABLE)
    image.alpha_composite(draw(s.segments, card_sel, transform=card_xy, size=size, px_per_mm=k, colours=colours))
    image.alpha_composite(draw(s.segments, s.is_slider, transform=slider_xy, size=size, px_per_mm=k, from_below=True, colours=colours))
    # The keeper bar crosses in front of the strip.
    keeper = card_sel & (s.segments.z > s.design.params.body + s.design.params.layer + 0.01)
    image.alpha_composite(draw(s.segments, keeper, transform=card_xy, size=size, px_per_mm=k, colours=colours))
    return image.convert('RGB')


def card_back(s: Sliced, px_per_mm: float = 20.0, max_z: float | None = None, colours: list[str] | None = None) -> Image.Image:
    """The card's back as seen from behind (the first layers on top)."""
    k = px_per_mm
    xlim, ylim = (-150.0, 5.0), (-36.0, 73.0)
    size = _frame(xlim, ylim, k)
    ox, oy = s.origin
    # Seen from behind, the card's x runs the other way.
    back_xy = lambda x, y: ((xlim[1] - (x - ox)) * k, (ylim[1] - (y - oy)) * k)
    sel = ~s.is_slider & ~s.segments.tower
    if max_z is not None:
        sel &= s.segments.z <= max_z + 1e-6
    image = Image.new('RGBA', size, TABLE)
    image.alpha_composite(draw(s.segments, sel, transform=back_xy, size=size, px_per_mm=k, from_below=True, colours=colours))
    return image.convert('RGB')
